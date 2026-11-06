// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! Example: Voting-controlled dWallet signing.
//!
//! A Pinocchio program demonstrating program-controlled dWallets via the CPI
//! authority pattern. A dWallet is placed under the control of a **council** —
//! a fixed member list with a quorum — and its ownership is transferred to this
//! program's CPI authority PDA. Council members create proposals referencing the
//! council's dWallet; when enough "yes" votes are cast (reaching the council's
//! quorum), the program CPI-calls `issue_signature_voucher` on the dWallet
//! program to authorize signing. The voucher sits at this program's PDA
//! `["signature_voucher", proposal_id]`, and the program signs for it.
//!
//! # Why a council exists (read this before copying the pattern)
//!
//! The dWallet program authenticates a program caller by ONE PDA per program:
//! `["__ika_cpi_authority"]`. Every dWallet whose owner is that PDA is
//! controlled by this program as a whole, not by a particular proposal or
//! member set. So the program itself must decide, for every dWallet it
//! controls, *who* may approve — otherwise anyone could create their own
//! proposal (with their own quorum) targeting a dWallet somebody else handed
//! to the program, and approve any message with any signer key. Two rules
//! close that:
//!
//! 1. Exactly one `Council` per dWallet, at the PDA `["council", dwallet]`,
//!    created by the dWallet's *current* owner (verified against the
//!    dWallet account) BEFORE ownership is transferred to the CPI PDA. Its
//!    members and quorum are fixed at creation.
//! 2. Every proposal and vote is bound to that council: the proposal stores
//!    the council's dWallet, only council members may propose or vote, the
//!    quorum comes from the council, and at execution the dWallet account
//!    passed for the CPI must be the one the proposal was created for.
//!
//! # Instructions
//!
//! - `0` — **CreateProposal**: a council member creates a Proposal PDA for the council's dWallet.
//! - `1` — **CastVote**: a council member votes; when quorum is reached, CPI-issues a signature voucher.
//! - `2` — **CreateCouncil**: the dWallet owner fixes the member list and quorum for a dWallet.
//!
//! # Account Layouts
//!
//! **Council** PDA (`["council", dwallet]`):
//!   discriminator(1) + version(1) + dwallet(32) + quorum(4) + member_count(2) +
//!   bump(1) + members(32*10) = 361 bytes
//!
//! **Proposal** PDA (`["proposal", proposal_id]`):
//!   discriminator(1) + version(1) + proposal_id(32) + dwallet(32) + message_digest(32) +
//!   user_pubkey(32) + signature_scheme(2) + creator(32) + yes_votes(4) +
//!   no_votes(4) + quorum(4) + status(1) + signature_voucher_bump(1) +
//!   bump(1) + _reserved(16) = 196 bytes
//!
//! **VoteRecord** PDA (`["vote", proposal_id, voter]`):
//!   discriminator(1) + version(1) + voter(32) + proposal_id(32) + vote(1) + bump(1) = 69 bytes

#![no_std]

extern crate alloc;

use pinocchio::{
    AccountView, Address, ProgramResult,
    cpi::{Seed, Signer},
    entrypoint,
    error::ProgramError,
};
use pinocchio_system::instructions::CreateAccount;

use ika_dwallet_pinocchio::{DWalletContext, ID as IKA_PROGRAM_ID};

entrypoint!(process_instruction);
pinocchio::nostd_panic_handler!();

// Placeholder program ID — replace with actual keypair before deployment.
pub const ID: Address = Address::new_from_array([5u8; 32]);

/// Maximum number of council members.
pub const MAX_MEMBERS: usize = 10;

// ── Discriminators ──
const PROPOSAL_DISCRIMINATOR: u8 = 1;
const VOTE_RECORD_DISCRIMINATOR: u8 = 2;
const COUNCIL_DISCRIMINATOR: u8 = 3;

/// Discriminator of a `DWallet` account in the dWallet program.
// The merged program ranges account discriminators by subsystem; the
// dWallet record is 97, not 2.
const DWALLET_ACCOUNT_DISCRIMINATOR: u8 = 97;
/// Offset of the `owner` field inside a `DWallet` account (after the
/// 2-byte discriminator + version header).
const DWALLET_OWNER_OFFSET: usize = 2;

// ── Status values ──
const STATUS_OPEN: u8 = 0;
const STATUS_APPROVED: u8 = 1;

// ── Account total sizes (including 2-byte header: discriminator + version) ──
const COUNCIL_LEN: usize = 2 + 32 + 4 + 2 + 1 + 32 * MAX_MEMBERS; // 361
const PROPOSAL_LEN: usize = 2 + 194; // 196
const VOTE_RECORD_LEN: usize = 2 + 67; // 69

// ── Offsets into Council data (after 2-byte header) ──
const CN_DWALLET: usize = 2;
const CN_QUORUM: usize = 34;
const CN_MEMBER_COUNT: usize = 38;
const CN_BUMP: usize = 40;
const CN_MEMBERS: usize = 41;

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
const PROP_SIGNATURE_VOUCHER_BUMP: usize = 177;
const PROP_BUMP: usize = 178;

// ── Offsets into VoteRecord data (after 2-byte header) ──
const VR_VOTER: usize = 2;
const VR_PROPOSAL_ID: usize = 34;
const VR_VOTE: usize = 66;
const VR_BUMP: usize = 67;

/// Program-specific errors (surfaced as `ProgramError::Custom(code)`).
#[repr(u32)]
pub enum VotingError {
    /// The dWallet account passed does not match the one the council/proposal is bound to.
    DWalletMismatch = 0,
    /// The signer is not a member of the council.
    NotAMember = 1,
    /// The signer is not the dWallet's current owner.
    NotDWalletOwner = 2,
    /// The council account is not the council PDA for the proposal's dWallet.
    InvalidCouncil = 3,
    /// The dWallet account is not a `DWallet` owned by the dWallet program.
    InvalidDWalletAccount = 4,
    /// Quorum must be at least 1 and at most the member count.
    InvalidQuorum = 5,
    /// The member list contains a duplicate.
    DuplicateMember = 6,
    /// The proposal is not open for voting.
    ProposalClosed = 7,
    /// The proposal id does not match the proposal account.
    ProposalMismatch = 8,
    /// The signature voucher bump is not the canonical bump of this
    /// program's `["signature_voucher", proposal_id]` PDA.
    InvalidVoucherBump = 9,
    /// The signature voucher account is not this program's
    /// `["signature_voucher", proposal_id]` PDA.
    VoucherMismatch = 10,
    /// A PDA bump is not the canonical bump of its seeds.
    InvalidBump = 11,
}

impl From<VotingError> for ProgramError {
    fn from(error: VotingError) -> Self {
        ProgramError::Custom(error as u32)
    }
}

/// Calculates minimum rent-exempt balance (same formula as ika programs).
#[inline(always)]
fn minimum_balance(data_len: usize) -> u64 {
    (data_len as u64).saturating_add(128).saturating_mul(6960)
}

/// Read a `[u8; 32]` field at `offset`.
fn read_key(data: &[u8], offset: usize) -> Result<[u8; 32], ProgramError> {
    data.get(offset..)
        .and_then(|tail| tail.first_chunk::<32>())
        .copied()
        .ok_or(ProgramError::InvalidAccountData)
}

fn read_u16(data: &[u8], offset: usize) -> Result<u16, ProgramError> {
    data.get(offset..)
        .and_then(|tail| tail.first_chunk::<2>())
        .map(|bytes| u16::from_le_bytes(*bytes))
        .ok_or(ProgramError::InvalidAccountData)
}

fn read_u32(data: &[u8], offset: usize) -> Result<u32, ProgramError> {
    data.get(offset..)
        .and_then(|tail| tail.first_chunk::<4>())
        .map(|bytes| u32::from_le_bytes(*bytes))
        .ok_or(ProgramError::InvalidAccountData)
}

/// Refuse `bump` unless it is the canonical bump of the PDA at `seeds`.
///
/// A record that exists once per key (a proposal, a vote, a transaction, an
/// approval) is guarded by its address: creating it a second time fails
/// because the account already exists. That holds only at ONE address. A
/// client-chosen bump other than the canonical one derives a second valid
/// address for the same seeds, where the record does not exist yet, and a
/// member could vote twice. So the program derives the canonical bump itself
/// and takes no other.
fn require_canonical_bump(
    seeds: &[&[u8]],
    bump: u8,
    program_id: &Address,
) -> Result<(), ProgramError> {
    let (_, canonical) = Address::find_program_address(seeds, program_id);
    if bump != canonical {
        return Err(VotingError::InvalidBump.into());
    }
    Ok(())
}

/// Return the `owner` of a `DWallet` account after checking that the
/// account really is a `DWallet` owned by the (executable) dWallet program.
fn dwallet_owner(
    dwallet: &AccountView,
    dwallet_program: &AccountView,
) -> Result<[u8; 32], ProgramError> {
    // The dWallet program must be ika's own, the address this program was
    // built for: a dWallet account of any other program is anyone's word.
    if dwallet_program.address() != &IKA_PROGRAM_ID
        || !dwallet_program.executable()
        || !dwallet.owned_by(&IKA_PROGRAM_ID)
    {
        return Err(VotingError::InvalidDWalletAccount.into());
    }
    let data = dwallet.try_borrow()?;
    if data.first() != Some(&DWALLET_ACCOUNT_DISCRIMINATOR) {
        return Err(VotingError::InvalidDWalletAccount.into());
    }
    read_key(&data, DWALLET_OWNER_OFFSET).map_err(|_| VotingError::InvalidDWalletAccount.into())
}

/// Check that `council` is THE council PDA for `dwallet` (program-owned,
/// council-typed, bound to `dwallet`, at the canonical `["council", dwallet]`
/// address recorded by its stored bump) and that `member` is one of its
/// members. Returns the council's quorum.
fn verify_council_member(
    program_id: &Address,
    council: &AccountView,
    dwallet: &[u8; 32],
    member: &[u8; 32],
) -> Result<u32, ProgramError> {
    if !council.owned_by(program_id) {
        return Err(VotingError::InvalidCouncil.into());
    }
    let data = council.try_borrow()?;
    if data.len() < COUNCIL_LEN || data[0] != COUNCIL_DISCRIMINATOR {
        return Err(VotingError::InvalidCouncil.into());
    }
    if data[CN_DWALLET..CN_DWALLET + 32] != *dwallet {
        return Err(VotingError::InvalidCouncil.into());
    }
    let bump = [data[CN_BUMP]];
    let expected =
        Address::create_program_address(&[b"council", dwallet.as_ref(), &bump], program_id)
            .map_err(|_| VotingError::InvalidCouncil)?;
    if council.address() != &expected {
        return Err(VotingError::InvalidCouncil.into());
    }
    let member_count = read_u16(&data, CN_MEMBER_COUNT)? as usize;
    let is_member = data[CN_MEMBERS..]
        .chunks(32)
        .take(member_count)
        .any(|candidate| candidate == member);
    if !is_member {
        return Err(VotingError::NotAMember.into());
    }
    read_u32(&data, CN_QUORUM)
}

pub fn process_instruction(
    program_id: &Address,
    accounts: &mut [AccountView],
    data: &[u8],
) -> ProgramResult {
    let (discriminator, rest) = data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;

    match *discriminator {
        0 => create_proposal(program_id, accounts, rest),
        1 => cast_vote(program_id, accounts, rest),
        2 => create_council(program_id, accounts, rest),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// Create the council for a dWallet.
///
/// Must be called by the dWallet's CURRENT owner, before that ownership is
/// transferred to this program's CPI authority PDA. The council PDA is unique
/// per dWallet, so this is the one place the member set and quorum are fixed.
///
/// # Instruction Data
///
/// `[quorum(4), member_count(2), members(32 * member_count)]`
///
/// # Accounts
///
/// 0. `[writable]`         Council PDA (seeds: `["council", dwallet]`, canonical bump)
/// 1. `[readonly]`         dWallet account (owned by the dWallet program)
/// 2. `[readonly]`         dWallet program (executable)
/// 3. `[signer]`           dWallet owner
/// 4. `[writable, signer]` Payer
/// 5. `[readonly]`         System program
fn create_council(
    program_id: &Address,
    accounts: &mut [AccountView],
    data: &[u8],
) -> ProgramResult {
    if data.len() < 6 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let [
        council_account,
        dwallet,
        dwallet_program,
        owner,
        payer,
        _system_program,
        ..,
    ] = accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !owner.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !payer.is_signer() || !payer.is_writable() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let quorum = u32::from_le_bytes(
        data[0..4]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    let member_count = u16::from_le_bytes(
        data[4..6]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    if member_count == 0 || member_count as usize > MAX_MEMBERS {
        return Err(ProgramError::InvalidInstructionData);
    }
    let members_len = (member_count as usize)
        .checked_mul(32)
        .ok_or(ProgramError::InvalidInstructionData)?;
    let members = data
        .get(6..)
        .and_then(|tail| tail.get(..members_len))
        .ok_or(ProgramError::InvalidInstructionData)?;
    if quorum == 0 || quorum > member_count as u32 {
        return Err(VotingError::InvalidQuorum.into());
    }
    let has_duplicate = members.chunks(32).enumerate().any(|(index, member)| {
        members
            .chunks(32)
            .skip(index)
            .skip(1)
            .any(|other| other == member)
    });
    if has_duplicate {
        return Err(VotingError::DuplicateMember.into());
    }

    // Only the dWallet's current owner may fix its governance.
    if dwallet_owner(dwallet, dwallet_program)? != *owner.address().as_array() {
        return Err(VotingError::NotDWalletOwner.into());
    }

    // Create the Council PDA at the canonical bump.
    let dwallet_key = dwallet.address().as_array();
    let (expected, bump) =
        Address::find_program_address(&[b"council", dwallet_key.as_ref()], program_id);
    if council_account.address() != &expected {
        return Err(VotingError::InvalidCouncil.into());
    }
    let bump_byte = [bump];
    let signer_seeds = [
        Seed::from(b"council" as &[u8]),
        Seed::from(dwallet_key.as_ref()),
        Seed::from(bump_byte.as_ref()),
    ];
    let signer = Signer::from(&signer_seeds);

    CreateAccount {
        from: payer,
        to: council_account,
        lamports: minimum_balance(COUNCIL_LEN),
        space: COUNCIL_LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[signer])?;

    let mut council_data = council_account.try_borrow_mut()?;
    council_data[0] = COUNCIL_DISCRIMINATOR;
    council_data[1] = 1; // version
    council_data[CN_DWALLET..CN_DWALLET + 32].copy_from_slice(dwallet_key);
    council_data[CN_QUORUM..CN_QUORUM + 4].copy_from_slice(&quorum.to_le_bytes());
    council_data[CN_MEMBER_COUNT..CN_MEMBER_COUNT + 2].copy_from_slice(&member_count.to_le_bytes());
    council_data[CN_BUMP] = bump;
    council_data[CN_MEMBERS..][..members_len].copy_from_slice(members);

    Ok(())
}

/// Create a proposal PDA for the council's dWallet.
///
/// # Instruction Data
///
/// `[proposal_id(32), message_digest(32), user_pubkey(32), signature_scheme(2), signature_voucher_bump(1), bump(1)]` = 100 bytes
///
/// `signature_voucher_bump` is the bump of this program's PDA
/// `["signature_voucher", proposal_id]`, where the voucher is issued once
/// the proposal passes.
///
/// # Accounts
///
/// 0. `[writable]` Proposal PDA (seeds: `["proposal", proposal_id]`)
/// 1. `[readonly]` Council PDA for the dWallet
/// 2. `[readonly]` dWallet account (the council's dWallet)
/// 3. `[signer]`   Creator (must be a council member)
/// 4. `[writable, signer]` Payer
/// 5. `[readonly]` System program
fn create_proposal(
    program_id: &Address,
    accounts: &mut [AccountView],
    data: &[u8],
) -> ProgramResult {
    if data.len() < 100 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let [
        proposal_account,
        council,
        dwallet,
        creator,
        payer,
        _system_program,
        ..,
    ] = accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !creator.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !payer.is_signer() || !payer.is_writable() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // The proposal inherits its quorum from the council; only members propose.
    let dwallet_key = dwallet.address().as_array();
    let quorum = verify_council_member(
        program_id,
        council,
        dwallet_key,
        creator.address().as_array(),
    )?;

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
    let signature_voucher_bump = data[98];
    // The voucher's address is this program's PDA for the proposal, and the
    // program signs for it with the stored bump when the proposal passes. A
    // non-canonical bump would put the voucher at an address clients do not
    // compute, so only the canonical one is accepted.
    let (_, canonical_voucher_bump) =
        Address::find_program_address(&[b"signature_voucher", proposal_id.as_ref()], program_id);
    if signature_voucher_bump != canonical_voucher_bump {
        return Err(VotingError::InvalidVoucherBump.into());
    }
    let bump = data[99];
    require_canonical_bump(&[b"proposal", proposal_id.as_ref()], bump, program_id)?;

    // Create Proposal PDA.
    let bump_byte = [bump];
    let signer_seeds = [
        Seed::from(b"proposal" as &[u8]),
        Seed::from(proposal_id.as_ref()),
        Seed::from(bump_byte.as_ref()),
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
    let mut prop_data = proposal_account.try_borrow_mut()?;
    prop_data[0] = PROPOSAL_DISCRIMINATOR;
    prop_data[1] = 1; // version

    prop_data[PROP_PROPOSAL_ID..PROP_PROPOSAL_ID + 32].copy_from_slice(&proposal_id);
    prop_data[PROP_DWALLET..PROP_DWALLET + 32].copy_from_slice(dwallet_key);
    prop_data[PROP_MESSAGE_DIGEST..PROP_MESSAGE_DIGEST + 32].copy_from_slice(&message_digest);
    prop_data[PROP_USER_PUBKEY..PROP_USER_PUBKEY + 32].copy_from_slice(&user_pubkey);
    prop_data[PROP_SIGNATURE_SCHEME..PROP_SIGNATURE_SCHEME + 2]
        .copy_from_slice(&signature_scheme.to_le_bytes());
    prop_data[PROP_CREATOR..PROP_CREATOR + 32].copy_from_slice(creator.address().as_array());
    prop_data[PROP_YES_VOTES..PROP_YES_VOTES + 4].copy_from_slice(&0u32.to_le_bytes());
    prop_data[PROP_NO_VOTES..PROP_NO_VOTES + 4].copy_from_slice(&0u32.to_le_bytes());
    prop_data[PROP_QUORUM..PROP_QUORUM + 4].copy_from_slice(&quorum.to_le_bytes());
    prop_data[PROP_STATUS] = STATUS_OPEN;
    prop_data[PROP_SIGNATURE_VOUCHER_BUMP] = signature_voucher_bump;
    prop_data[PROP_BUMP] = bump;
    // _reserved bytes are already zero from CreateAccount.

    Ok(())
}

/// Cast a vote on a proposal.
///
/// When quorum is reached, the program CPI-calls `issue_signature_voucher`
/// on the dWallet program to authorize signing the proposal's message. The
/// voucher's signing key is the proposal's `user_pubkey`, and its owner is
/// this program's CPI authority.
///
/// # Instruction Data
///
/// `[proposal_id(32), vote(1), vote_record_bump(1), cpi_authority_bump(1)]` = 35 bytes
///
/// # Accounts
///
/// 0. `[writable]`          Proposal PDA
/// 1. `[writable]`          VoteRecord PDA (seeds: `["vote", proposal_id, voter]`)
/// 2. `[readonly]`          Council PDA for the proposal's dWallet
/// 3. `[signer]`            Voter (must be a council member)
/// 4. `[writable, signer]`  Payer
/// 5. `[readonly]`          System program
///
/// When quorum is reached, additional accounts are required for the CPI:
///
/// 6. `[readonly]`          DWalletCoordinator PDA (for epoch)
/// 7. `[writable]`          SignatureVoucher: this program's PDA `["signature_voucher", proposal_id]` (created via CPI)
/// 8. `[readonly]`          dWallet account (must be the proposal's dWallet)
/// 9. `[readonly]`          This program account (caller_program for CPI)
/// 10. `[readonly]`         CPI authority PDA (signer via invoke_signed)
/// 11. `[readonly]`         dWallet program
fn cast_vote(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    if data.len() < 35 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let proposal_id: [u8; 32] = data[0..32]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let vote = data[32]; // 1 = yes, 0 = no
    let vote_record_bump = data[33];
    let cpi_authority_bump = data[34];

    let Some((head, tail)) = accounts.split_at_mut_checked(6) else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let [
        proposal_account,
        vote_record_account,
        council,
        voter,
        payer,
        system_program,
    ] = head
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !voter.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !payer.is_signer() || !payer.is_writable() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !proposal_account.is_writable() {
        return Err(ProgramError::Immutable);
    }

    // Verify the proposal is open and belongs to a council this voter sits on.
    let proposal_dwallet = {
        let prop_data = proposal_account.try_borrow()?;
        if prop_data.len() < PROPOSAL_LEN || prop_data[0] != PROPOSAL_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        if prop_data[PROP_STATUS] != STATUS_OPEN {
            return Err(VotingError::ProposalClosed.into());
        }
        if prop_data[PROP_PROPOSAL_ID..PROP_PROPOSAL_ID + 32] != proposal_id {
            return Err(VotingError::ProposalMismatch.into());
        }
        read_key(&prop_data, PROP_DWALLET)?
    };
    verify_council_member(
        program_id,
        council,
        &proposal_dwallet,
        voter.address().as_array(),
    )?;

    // Create VoteRecord PDA (prevents double voting).
    require_canonical_bump(
        &[
            b"vote",
            proposal_id.as_ref(),
            voter.address().as_array().as_ref(),
        ],
        vote_record_bump,
        program_id,
    )?;
    let vr_bump_byte = [vote_record_bump];
    let voter_key = voter.address().as_array();
    let vr_signer_seeds = [
        Seed::from(b"vote" as &[u8]),
        Seed::from(proposal_id.as_ref()),
        Seed::from(voter_key.as_ref()),
        Seed::from(vr_bump_byte.as_ref()),
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
        let mut vr_data = vote_record_account.try_borrow_mut()?;
        vr_data[0] = VOTE_RECORD_DISCRIMINATOR;
        vr_data[1] = 1; // version
        vr_data[VR_VOTER..VR_VOTER + 32].copy_from_slice(voter_key);
        vr_data[VR_PROPOSAL_ID..VR_PROPOSAL_ID + 32].copy_from_slice(&proposal_id);
        vr_data[VR_VOTE] = vote;
        vr_data[VR_BUMP] = vote_record_bump;
    }

    // Update proposal vote counts and read what the CPI needs.
    let (yes_votes, quorum, message_digest, user_pubkey, signature_scheme, signature_voucher_bump) = {
        let mut prop_data = proposal_account.try_borrow_mut()?;
        let counter_offset = if vote == 1 {
            PROP_YES_VOTES
        } else {
            PROP_NO_VOTES
        };
        let new_count = read_u32(&prop_data, counter_offset)?
            .checked_add(1)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        prop_data[counter_offset..][..4].copy_from_slice(&new_count.to_le_bytes());
        (
            read_u32(&prop_data, PROP_YES_VOTES)?,
            read_u32(&prop_data, PROP_QUORUM)?,
            read_key(&prop_data, PROP_MESSAGE_DIGEST)?,
            read_key(&prop_data, PROP_USER_PUBKEY)?,
            read_u16(&prop_data, PROP_SIGNATURE_SCHEME)?,
            prop_data[PROP_SIGNATURE_VOUCHER_BUMP],
        )
    };

    // If quorum reached, CPI-call issue_signature_voucher.
    if yes_votes >= quorum {
        let [
            coordinator,
            signature_voucher,
            dwallet,
            caller_program,
            cpi_authority,
            dwallet_program,
            ..,
        ] = &*tail
        else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        // The CPI must target the dWallet this proposal was created for — not
        // whichever dWallet the caller chose to pass.
        if dwallet.address().as_array() != &proposal_dwallet {
            return Err(VotingError::DWalletMismatch.into());
        }
        // The voucher account must be this program's PDA for the proposal.
        // A signer at another address would also be accepted by the dWallet
        // program, because an outer transaction's signatures carry through
        // the CPI: the voucher would land where no client looks, and the
        // proposal would be spent without a signature anyone can find.
        let expected_voucher = Address::create_program_address(
            &[
                b"signature_voucher",
                proposal_id.as_ref(),
                &[signature_voucher_bump],
            ],
            program_id,
        )
        .map_err(|_| VotingError::VoucherMismatch)?;
        if signature_voucher.address() != &expected_voucher {
            return Err(VotingError::VoucherMismatch.into());
        }

        // No message metadata for voting — use all zeros.
        let message_metadata_digest = [0u8; 32];

        let ctx = DWalletContext {
            dwallet_program,
            cpi_authority,
            caller_program,
            cpi_authority_bump,
        };

        // The voucher is this program's PDA for the proposal, so the program
        // signs its creation.
        let voucher_bump_byte = [signature_voucher_bump];
        let voucher_seeds = [
            Seed::from(b"signature_voucher" as &[u8]),
            Seed::from(proposal_id.as_ref()),
            Seed::from(voucher_bump_byte.as_ref()),
        ];

        ctx.issue_signature_voucher(
            coordinator,
            signature_voucher,
            dwallet,
            payer,
            system_program,
            message_digest,
            message_metadata_digest,
            signature_scheme,
            None,
            Some(user_pubkey),
            Some(&voucher_seeds),
        )?;

        // Mark proposal as approved.
        let mut prop_data = proposal_account.try_borrow_mut()?;
        prop_data[PROP_STATUS] = STATUS_APPROVED;
    }

    Ok(())
}
