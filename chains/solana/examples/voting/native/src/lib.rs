// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! Example: Voting-controlled dWallet signing (native `solana-program` version).
//!
//! A native Solana program demonstrating program-controlled dWallets via the CPI
//! authority pattern. Proposals are created referencing a dWallet whose authority
//! has been transferred to this program's CPI authority PDA. When enough "yes"
//! votes are cast (reaching quorum), the program automatically CPI-calls
//! `approve_message` on the dWallet program to authorize signing.
//!
//! This is the native (`solana-program`) equivalent of the Pinocchio
//! `ika-example-voting-pinocchio` program.
//!
//! # Instructions
//!
//! - `0` -- **CreateProposal**: create a Proposal PDA with a target dWallet, message, and quorum.
//! - `1` -- **CastVote**: record a vote; when quorum is reached, CPI-approves signing.
//!
//! # Account Layouts
//!
//! **Proposal** PDA (`["proposal", proposal_id]`):
//!   discriminator(1) + version(1) + proposal_id(32) + dwallet(32) + message_hash(32) +
//!   user_pubkey(32) + signature_scheme(1) + creator(32) + yes_votes(4) +
//!   no_votes(4) + quorum(4) + status(1) + message_approval_bump(1) +
//!   bump(1) + _reserved(16) = 195 bytes
//!
//! **VoteRecord** PDA (`["vote", proposal_id, voter]`):
//!   discriminator(1) + version(1) + voter(32) + proposal_id(32) + vote(1) + bump(1) = 69 bytes (inc. header)

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
    program::invoke_signed,
};

use ika_dwallet_native::DWalletContext;

entrypoint!(process_instruction);

// Placeholder program ID -- replace with actual keypair before deployment.
pub const ID: Pubkey = Pubkey::new_from_array([5u8; 32]);

// ── Discriminators ──
const PROPOSAL_DISCRIMINATOR: u8 = 1;
const VOTE_RECORD_DISCRIMINATOR: u8 = 2;

// ── Status values ──
const STATUS_OPEN: u8 = 0;
const STATUS_APPROVED: u8 = 1;

// ── Account sizes ──
const PROPOSAL_DATA_LEN: usize = 193;
const VOTE_RECORD_DATA_LEN: usize = 67;

const PROPOSAL_LEN: usize = 2 + PROPOSAL_DATA_LEN; // 195
const VOTE_RECORD_LEN: usize = 2 + VOTE_RECORD_DATA_LEN; // 69

// ── Offsets into Proposal data (after 2-byte header) ──
const PROP_PROPOSAL_ID: usize = 2;
const PROP_DWALLET: usize = 34;
const PROP_MESSAGE_HASH: usize = 66;
const PROP_USER_PUBKEY: usize = 98;
const PROP_SIGNATURE_SCHEME: usize = 130;
const PROP_CREATOR: usize = 131;
const PROP_YES_VOTES: usize = 163;
const PROP_NO_VOTES: usize = 167;
const PROP_QUORUM: usize = 171;
const PROP_STATUS: usize = 175;
const PROP_MSG_APPROVAL_BUMP: usize = 176;
const PROP_BUMP: usize = 177;

// ── Offsets into VoteRecord data (after 2-byte header) ──
const VR_VOTER: usize = 2;
const VR_PROPOSAL_ID: usize = 34;
const VR_VOTE: usize = 66;
const VR_BUMP: usize = 67;

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> Result<(), ProgramError> {
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
/// `[proposal_id(32), message_hash(32), user_pubkey(32), signature_scheme(1), quorum(4), message_approval_bump(1), bump(1)]` = 103 bytes
///
/// # Accounts
///
/// 0. `[writable]` Proposal PDA (seeds: `["proposal", proposal_id]`)
/// 1. `[readonly]` dWallet account (program-owned by the dWallet program)
/// 2. `[signer]`   Creator (proposal authority)
/// 3. `[writable, signer]` Payer
/// 4. `[readonly]` System program
fn create_proposal(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> Result<(), ProgramError> {
    if data.len() < 103 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let accounts_iter = &mut accounts.iter();
    let proposal_account = next_account_info(accounts_iter)?;
    let dwallet = next_account_info(accounts_iter)?;
    let creator = next_account_info(accounts_iter)?;
    let payer = next_account_info(accounts_iter)?;
    let system_program = next_account_info(accounts_iter)?;

    if !creator.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !payer.is_signer || !payer.is_writable {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Parse instruction data.
    let proposal_id: [u8; 32] = data[0..32]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let message_hash: [u8; 32] = data[32..64]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let user_pubkey: [u8; 32] = data[64..96]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let signature_scheme = data[96];
    let quorum = u32::from_le_bytes(
        data[97..101]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    let message_approval_bump = data[101];
    let bump = data[102];

    // Verify quorum is at least 1.
    if quorum == 0 {
        return Err(ProgramError::InvalidInstructionData);
    }

    // Create Proposal PDA via system program CPI.
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(PROPOSAL_LEN);
    let create_ix = system_instruction::create_account(
        payer.key,
        proposal_account.key,
        lamports,
        PROPOSAL_LEN as u64,
        program_id,
    );

    let signer_seeds: &[&[u8]] = &[b"proposal", proposal_id.as_ref(), &[bump]];
    invoke_signed(
        &create_ix,
        &[payer.clone(), proposal_account.clone(), system_program.clone()],
        &[signer_seeds],
    )?;

    // Write Proposal fields.
    let mut prop_data = proposal_account.try_borrow_mut_data()?;
    prop_data[0] = PROPOSAL_DISCRIMINATOR;
    prop_data[1] = 1; // version

    prop_data[PROP_PROPOSAL_ID..PROP_PROPOSAL_ID + 32].copy_from_slice(&proposal_id);
    prop_data[PROP_DWALLET..PROP_DWALLET + 32].copy_from_slice(dwallet.key.as_ref());
    prop_data[PROP_MESSAGE_HASH..PROP_MESSAGE_HASH + 32].copy_from_slice(&message_hash);
    prop_data[PROP_USER_PUBKEY..PROP_USER_PUBKEY + 32].copy_from_slice(&user_pubkey);
    prop_data[PROP_SIGNATURE_SCHEME] = signature_scheme;
    prop_data[PROP_CREATOR..PROP_CREATOR + 32].copy_from_slice(creator.key.as_ref());
    prop_data[PROP_YES_VOTES..PROP_YES_VOTES + 4].copy_from_slice(&0u32.to_le_bytes());
    prop_data[PROP_NO_VOTES..PROP_NO_VOTES + 4].copy_from_slice(&0u32.to_le_bytes());
    prop_data[PROP_QUORUM..PROP_QUORUM + 4].copy_from_slice(&quorum.to_le_bytes());
    prop_data[PROP_STATUS] = STATUS_OPEN;
    prop_data[PROP_MSG_APPROVAL_BUMP] = message_approval_bump;
    prop_data[PROP_BUMP] = bump;
    // _reserved bytes are already zero from create_account.

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
/// 5. `[writable]`          MessageApproval PDA (to create via CPI)
/// 6. `[readonly]`          dWallet account
/// 7. `[readonly]`          This program account (caller_program for CPI)
/// 8. `[readonly]`          CPI authority PDA (signer via invoke_signed)
/// 9. `[readonly]`          dWallet program
fn cast_vote(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> Result<(), ProgramError> {
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

    if !voter.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !payer.is_signer || !payer.is_writable {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !proposal_account.is_writable {
        return Err(ProgramError::InvalidArgument);
    }

    // Verify proposal is open.
    {
        let prop_data = proposal_account.try_borrow_data()?;
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
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(VOTE_RECORD_LEN);
    let create_ix = system_instruction::create_account(
        payer.key,
        vote_record_account.key,
        lamports,
        VOTE_RECORD_LEN as u64,
        program_id,
    );

    let voter_key = voter.key;
    let vr_signer_seeds: &[&[u8]] = &[
        b"vote",
        proposal_id.as_ref(),
        voter_key.as_ref(),
        &[vote_record_bump],
    ];
    invoke_signed(
        &create_ix,
        &[payer.clone(), vote_record_account.clone(), system_program.clone()],
        &[vr_signer_seeds],
    )?;

    // Write VoteRecord fields.
    {
        let mut vr_data = vote_record_account.try_borrow_mut_data()?;
        vr_data[0] = VOTE_RECORD_DISCRIMINATOR;
        vr_data[1] = 1; // version
        vr_data[VR_VOTER..VR_VOTER + 32].copy_from_slice(voter_key.as_ref());
        vr_data[VR_PROPOSAL_ID..VR_PROPOSAL_ID + 32].copy_from_slice(&proposal_id);
        vr_data[VR_VOTE] = vote;
        vr_data[VR_BUMP] = vote_record_bump;
    }

    // Update proposal vote counts.
    let mut prop_data = proposal_account.try_borrow_mut_data()?;

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
        if accounts.len() < 10 {
            return Err(ProgramError::NotEnoughAccountKeys);
        }

        let message_approval = &accounts[5];
        let dwallet = &accounts[6];
        let caller_program = &accounts[7];
        let cpi_authority = &accounts[8];
        let dwallet_program = &accounts[9];

        // Read proposal fields for the CPI call.
        let mut message_hash = [0u8; 32];
        message_hash.copy_from_slice(&prop_data[PROP_MESSAGE_HASH..PROP_MESSAGE_HASH + 32]);
        let mut user_pubkey = [0u8; 32];
        user_pubkey.copy_from_slice(&prop_data[PROP_USER_PUBKEY..PROP_USER_PUBKEY + 32]);
        let signature_scheme = prop_data[PROP_SIGNATURE_SCHEME];
        let message_approval_bump = prop_data[PROP_MSG_APPROVAL_BUMP];

        // Must drop the mutable borrow before CPI.
        drop(prop_data);

        let ctx = DWalletContext {
            dwallet_program,
            cpi_authority,
            caller_program,
            cpi_authority_bump,
        };

        ctx.approve_message(
            message_approval,
            dwallet,
            payer,
            system_program,
            message_hash,
            user_pubkey,
            signature_scheme,
            message_approval_bump,
        )?;

        // Mark proposal as approved.
        let mut prop_data = proposal_account.try_borrow_mut_data()?;
        prop_data[PROP_STATUS] = STATUS_APPROVED;
    }

    Ok(())
}
