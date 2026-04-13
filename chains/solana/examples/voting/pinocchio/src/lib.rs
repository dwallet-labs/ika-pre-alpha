// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! Example: Voting-controlled dWallet signing.
//!
//! A Pinocchio program demonstrating program-controlled dWallets via the CPI
//! authority pattern. Proposals are created referencing a dWallet whose authority
//! has been transferred to this program's CPI authority PDA. When enough "yes"
//! votes are cast (reaching quorum), the program automatically CPI-calls
//! `approve_message` on the dWallet program to authorize signing.
//!
//! # Instructions
//!
//! - `0` — **CreateProposal**: create a Proposal PDA with a target dWallet, message, and quorum.
//! - `1` — **CastVote**: record a vote; when quorum is reached, CPI-approves signing.
//!
//! # Account Layouts
//!
//! **Proposal** PDA (`["proposal", proposal_id]`):
//!   discriminator(1) + proposal_id(32) + dwallet(32) + message_digest(32) +
//!   user_pubkey(32) + signature_scheme(2) + creator(32) + yes_votes(4) +
//!   no_votes(4) + quorum(4) + status(1) + message_approval_bump(1) +
//!   bump(1) + _reserved(16) = 194 bytes
//!
//! **VoteRecord** PDA (`["vote", proposal_id, voter]`):
//!   discriminator(1) + voter(32) + proposal_id(32) + vote(1) + bump(1) = 67 bytes

#![no_std]

extern crate alloc;

use pinocchio::{
    cpi::Signer,
    entrypoint,
    error::ProgramError,
    AccountView, Address, ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

use ika_dwallet_pinocchio::DWalletContext;

entrypoint!(process_instruction);
pinocchio::nostd_panic_handler!();

// Placeholder program ID — replace with actual keypair before deployment.
pub const ID: Address = Address::new_from_array([5u8; 32]);

// ── Discriminators ──
const PROPOSAL_DISCRIMINATOR: u8 = 1;
const VOTE_RECORD_DISCRIMINATOR: u8 = 2;

// ── Status values ──
const STATUS_OPEN: u8 = 0;
const STATUS_APPROVED: u8 = 1;

// ── Account sizes (data only, excluding the 2-byte discriminator+version header) ──
const PROPOSAL_DATA_LEN: usize = 194;
const VOTE_RECORD_DATA_LEN: usize = 67;

// ── Account total sizes (including 2-byte header: discriminator + version) ──
const PROPOSAL_LEN: usize = 2 + PROPOSAL_DATA_LEN; // 196
const VOTE_RECORD_LEN: usize = 2 + VOTE_RECORD_DATA_LEN; // 69

// ── Offsets into Proposal data (after 2-byte header) ──
const PROP_PROPOSAL_ID: usize = 2;
const PROP_DWALLET: usize = 34;
const PROP_MESSAGE_DIGEST: usize = 66;
const PROP_USER_PUBKEY: usize = 98;
const PROP_SIGNATURE_SCHEME: usize = 130; // 2 bytes (u16 LE)
const PROP_CREATOR: usize = 132;
const PROP_YES_VOTES: usize = 164;
const PROP_NO_VOTES: usize = 168;
const PROP_QUORUM: usize = 172;
const PROP_STATUS: usize = 176;
const PROP_MSG_APPROVAL_BUMP: usize = 177;
const PROP_BUMP: usize = 178;

// ── Offsets into VoteRecord data (after 2-byte header) ──
const VR_VOTER: usize = 2;
const VR_PROPOSAL_ID: usize = 34;
const VR_VOTE: usize = 66;
const VR_BUMP: usize = 67;

/// Calculates minimum rent-exempt balance (same formula as ika programs).
#[inline(always)]
fn minimum_balance(data_len: usize) -> u64 {
    (data_len as u64 + 128) * 6960
}

pub fn process_instruction(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    let (discriminator, rest) = data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;

    match *discriminator {
        0 => create_proposal(program_id, accounts, rest),
        1 => cast_vote(program_id, accounts, rest),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// Create a proposal PDA.
///
/// # Instruction Data
///
/// `[proposal_id(32), message_digest(32), user_pubkey(32), signature_scheme(2), quorum(4), message_approval_bump(1), bump(1)]` = 104 bytes
///
/// # Accounts
///
/// 0. `[writable]` Proposal PDA (seeds: `["proposal", proposal_id]`)
/// 1. `[readonly]` dWallet account (program-owned by the dWallet program)
/// 2. `[signer]`   Creator (proposal authority)
/// 3. `[writable, signer]` Payer
/// 4. `[readonly]` System program
fn create_proposal(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    if data.len() < 104 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let [proposal_account, _dwallet, creator, payer, _system_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !creator.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !payer.is_signer() || !payer.is_writable() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Parse instruction data.
    let proposal_id: [u8; 32] = data[0..32]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let message_digest: [u8; 32] = data[32..64]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let user_pubkey: [u8; 32] = data[64..96]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let signature_scheme = u16::from_le_bytes(
        data[96..98]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    let quorum = u32::from_le_bytes(
        data[98..102]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    let message_approval_bump = data[102];
    let bump = data[103];

    // Verify quorum is at least 1.
    if quorum == 0 {
        return Err(ProgramError::InvalidInstructionData);
    }

    // Create Proposal PDA.
    let bump_byte = [bump];
    let signer_seeds = [
        pinocchio::cpi::Seed::from(b"proposal" as &[u8]),
        pinocchio::cpi::Seed::from(proposal_id.as_ref()),
        pinocchio::cpi::Seed::from(bump_byte.as_ref()),
    ];
    let signer = Signer::from(&signer_seeds);

    CreateAccount {
        from: payer,
        to: proposal_account,
        lamports: minimum_balance(PROPOSAL_LEN),
        space: PROPOSAL_LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[signer])?;

    // Write Proposal fields.
    let prop_data = unsafe { proposal_account.borrow_unchecked_mut() };
    prop_data[0] = PROPOSAL_DISCRIMINATOR;
    prop_data[1] = 1; // version

    prop_data[PROP_PROPOSAL_ID..PROP_PROPOSAL_ID + 32].copy_from_slice(&proposal_id);
    prop_data[PROP_DWALLET..PROP_DWALLET + 32]
        .copy_from_slice(_dwallet.address().as_array());
    prop_data[PROP_MESSAGE_DIGEST..PROP_MESSAGE_DIGEST + 32].copy_from_slice(&message_digest);
    prop_data[PROP_USER_PUBKEY..PROP_USER_PUBKEY + 32].copy_from_slice(&user_pubkey);
    prop_data[PROP_SIGNATURE_SCHEME..PROP_SIGNATURE_SCHEME + 2]
        .copy_from_slice(&signature_scheme.to_le_bytes());
    prop_data[PROP_CREATOR..PROP_CREATOR + 32]
        .copy_from_slice(creator.address().as_array());
    prop_data[PROP_YES_VOTES..PROP_YES_VOTES + 4].copy_from_slice(&0u32.to_le_bytes());
    prop_data[PROP_NO_VOTES..PROP_NO_VOTES + 4].copy_from_slice(&0u32.to_le_bytes());
    prop_data[PROP_QUORUM..PROP_QUORUM + 4].copy_from_slice(&quorum.to_le_bytes());
    prop_data[PROP_STATUS] = STATUS_OPEN;
    prop_data[PROP_MSG_APPROVAL_BUMP] = message_approval_bump;
    prop_data[PROP_BUMP] = bump;
    // _reserved bytes are already zero from CreateAccount.

    Ok(())
}

/// Cast a vote on a proposal.
///
/// When quorum is reached, the program CPI-calls `approve_message` on the
/// dWallet program to authorize signing the proposal's message.
///
/// # Instruction Data
///
/// `[proposal_id(32), vote(1), vote_record_bump(1), cpi_authority_bump(1)]` = 35 bytes
///
/// # Accounts
///
/// 0. `[writable]`          Proposal PDA
/// 1. `[writable]`          VoteRecord PDA (seeds: `["vote", proposal_id, voter]`)
/// 2. `[signer]`            Voter
/// 3. `[writable, signer]`  Payer
/// 4. `[readonly]`          System program
///
/// When quorum is reached, additional accounts are required for the CPI:
///
/// 5. `[readonly]`          DWalletCoordinator PDA (for epoch)
/// 6. `[writable]`          MessageApproval PDA (to create via CPI)
/// 7. `[readonly]`          dWallet account
/// 8. `[readonly]`          This program account (caller_program for CPI)
/// 9. `[readonly]`          CPI authority PDA (signer via invoke_signed)
/// 10. `[readonly]`         dWallet program
fn cast_vote(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    if data.len() < 35 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let proposal_id: [u8; 32] = data[0..32]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let vote = data[32]; // 1 = yes, 0 = no
    let vote_record_bump = data[33];
    let cpi_authority_bump = data[34];

    if accounts.len() < 5 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let proposal_account = &accounts[0];
    let vote_record_account = &accounts[1];
    let voter = &accounts[2];
    let payer = &accounts[3];
    let system_program = &accounts[4];

    if !voter.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !payer.is_signer() || !payer.is_writable() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !proposal_account.is_writable() {
        return Err(ProgramError::Immutable);
    }

    // Verify proposal is open.
    {
        let prop_data = unsafe { proposal_account.borrow_unchecked() };
        if prop_data.len() < PROPOSAL_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if prop_data[0] != PROPOSAL_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        if prop_data[PROP_STATUS] != STATUS_OPEN {
            return Err(ProgramError::InvalidArgument);
        }
        // Verify proposal_id matches.
        if prop_data[PROP_PROPOSAL_ID..PROP_PROPOSAL_ID + 32] != proposal_id {
            return Err(ProgramError::InvalidArgument);
        }
    }

    // Create VoteRecord PDA (prevents double voting).
    let vr_bump_byte = [vote_record_bump];
    let voter_key = voter.address().as_array();
    let vr_signer_seeds = [
        pinocchio::cpi::Seed::from(b"vote" as &[u8]),
        pinocchio::cpi::Seed::from(proposal_id.as_ref()),
        pinocchio::cpi::Seed::from(voter_key.as_ref()),
        pinocchio::cpi::Seed::from(vr_bump_byte.as_ref()),
    ];
    let vr_signer = Signer::from(&vr_signer_seeds);

    CreateAccount {
        from: payer,
        to: vote_record_account,
        lamports: minimum_balance(VOTE_RECORD_LEN),
        space: VOTE_RECORD_LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[vr_signer])?;

    // Write VoteRecord fields.
    {
        let vr_data = unsafe { vote_record_account.borrow_unchecked_mut() };
        vr_data[0] = VOTE_RECORD_DISCRIMINATOR;
        vr_data[1] = 1; // version
        vr_data[VR_VOTER..VR_VOTER + 32].copy_from_slice(voter_key);
        vr_data[VR_PROPOSAL_ID..VR_PROPOSAL_ID + 32].copy_from_slice(&proposal_id);
        vr_data[VR_VOTE] = vote;
        vr_data[VR_BUMP] = vote_record_bump;
    }

    // Update proposal vote counts.
    let prop_data = unsafe { proposal_account.borrow_unchecked_mut() };

    let yes_votes = if vote == 1 {
        let current = u32::from_le_bytes(
            prop_data[PROP_YES_VOTES..PROP_YES_VOTES + 4]
                .try_into()
                .map_err(|_| ProgramError::InvalidAccountData)?,
        );
        let new_count = current
            .checked_add(1)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        prop_data[PROP_YES_VOTES..PROP_YES_VOTES + 4]
            .copy_from_slice(&new_count.to_le_bytes());
        new_count
    } else {
        let current = u32::from_le_bytes(
            prop_data[PROP_NO_VOTES..PROP_NO_VOTES + 4]
                .try_into()
                .map_err(|_| ProgramError::InvalidAccountData)?,
        );
        let new_count = current
            .checked_add(1)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        prop_data[PROP_NO_VOTES..PROP_NO_VOTES + 4]
            .copy_from_slice(&new_count.to_le_bytes());
        // Return current yes count (unchanged).
        u32::from_le_bytes(
            prop_data[PROP_YES_VOTES..PROP_YES_VOTES + 4]
                .try_into()
                .map_err(|_| ProgramError::InvalidAccountData)?,
        )
    };

    let quorum = u32::from_le_bytes(
        prop_data[PROP_QUORUM..PROP_QUORUM + 4]
            .try_into()
            .map_err(|_| ProgramError::InvalidAccountData)?,
    );

    // If quorum reached, CPI-call approve_message.
    if yes_votes >= quorum {
        if accounts.len() < 11 {
            return Err(ProgramError::NotEnoughAccountKeys);
        }

        let coordinator = &accounts[5];
        let message_approval = &accounts[6];
        let dwallet = &accounts[7];
        let caller_program = &accounts[8];
        let cpi_authority = &accounts[9];
        let dwallet_program = &accounts[10];

        // Read proposal fields for the CPI call.
        let mut message_digest = [0u8; 32];
        message_digest.copy_from_slice(&prop_data[PROP_MESSAGE_DIGEST..PROP_MESSAGE_DIGEST + 32]);
        let mut user_pubkey = [0u8; 32];
        user_pubkey.copy_from_slice(&prop_data[PROP_USER_PUBKEY..PROP_USER_PUBKEY + 32]);
        let signature_scheme = u16::from_le_bytes(
            prop_data[PROP_SIGNATURE_SCHEME..PROP_SIGNATURE_SCHEME + 2]
                .try_into()
                .map_err(|_| ProgramError::InvalidAccountData)?,
        );
        let message_approval_bump = prop_data[PROP_MSG_APPROVAL_BUMP];
        // No message metadata for voting — use all zeros.
        let message_metadata_digest = [0u8; 32];

        let ctx = DWalletContext {
            dwallet_program,
            cpi_authority,
            caller_program,
            cpi_authority_bump,
        };

        ctx.approve_message(
            coordinator,
            message_approval,
            dwallet,
            payer,
            system_program,
            message_digest,
            message_metadata_digest,
            user_pubkey,
            signature_scheme,
            message_approval_bump,
        )?;

        // Mark proposal as approved.
        prop_data[PROP_STATUS] = STATUS_APPROVED;
    }

    Ok(())
}
