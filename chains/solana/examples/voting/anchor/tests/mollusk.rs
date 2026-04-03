// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! Mollusk instruction-level tests for the Anchor voting example.
//!
//! Anchor programs use a different serialization format:
//! - Instruction data: 8-byte discriminator (sha256("global:<fn_name>")[..8]) + borsh args
//! - Account data: 8-byte discriminator (sha256("account:<Name>")[..8]) + borsh fields
//!
//! Tests create_proposal and cast_vote in isolation (non-CPI paths only).

use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;

const PROGRAM_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../../../target/deploy/ika_example_voting_anchor"
);

/// System program ID (11111111111111111111111111111111).
const SYSTEM_PROGRAM_ID: Pubkey = Pubkey::new_from_array([0u8; 32]);

/// NativeLoader ID (`NativeLoader1111111111111111111111111111111`).
const NATIVE_LOADER_ID: Pubkey = Pubkey::new_from_array([
    0x05, 0x87, 0x84, 0xbf, 0x14, 0x8b, 0xa4, 0x28, 0x2f, 0xb0, 0x12, 0x57, 0x48, 0x88, 0xa9,
    0xf1, 0x53, 0xa0, 0x7d, 0xad, 0xf7, 0x65, 0xc0, 0x45, 0x5c, 0x9a, 0x97, 0x03, 0x80, 0x00,
    0x00, 0x00,
]);

// ── Anchor discriminators (sha256("global:<fn_name>")[..8]) ──
// create_proposal: sha256("global:create_proposal")
const CREATE_PROPOSAL_DISC: [u8; 8] = [132, 116, 68, 174, 216, 160, 198, 22];
// cast_vote: sha256("global:cast_vote")
const CAST_VOTE_DISC: [u8; 8] = [20, 212, 190, 104, 85, 115, 87, 216];

// ── Anchor account discriminators (sha256("account:<Name>")[..8]) ──
const PROPOSAL_DISC: [u8; 8] = [26, 94, 189, 187, 116, 136, 53, 33];
const VOTE_RECORD_DISC: [u8; 8] = [205, 172, 49, 186, 141, 23, 232, 171];

// ── Account sizes (Anchor: 8-byte discriminator + InitSpace) ──
// Proposal: 8 + (32+32+32+32+1+32+4+4+4+1+1) = 8 + 175 = 183
// VoteRecord: 8 + (32+32+1) = 8 + 65 = 73
const PROPOSAL_LEN: usize = 183;
const VOTE_RECORD_LEN: usize = 73;

// ── Offsets into Proposal (after 8-byte Anchor discriminator) ──
const PROP_PROPOSAL_ID: usize = 8;
const PROP_DWALLET: usize = 40;
const PROP_MESSAGE_HASH: usize = 72;
const _PROP_USER_PUBKEY: usize = 104;
const PROP_SIGNATURE_SCHEME: usize = 136;
const PROP_CREATOR: usize = 137;
const PROP_YES_VOTES: usize = 169;
const PROP_NO_VOTES: usize = 173;
const PROP_QUORUM: usize = 177;
const PROP_STATUS: usize = 181;
const PROP_MSG_APPROVAL_BUMP: usize = 182;

// ── Offsets into VoteRecord (after 8-byte Anchor discriminator) ──
const VR_VOTER: usize = 8;
const VR_PROPOSAL_ID: usize = 40;
const VR_VOTE: usize = 72;

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

fn setup() -> (Mollusk, Pubkey) {
    let program_id = Pubkey::new_unique();
    let mollusk = Mollusk::new(&program_id, PROGRAM_PATH);
    (mollusk, program_id)
}

fn funded_account() -> Account {
    Account {
        lamports: 10_000_000_000,
        data: vec![],
        owner: SYSTEM_PROGRAM_ID,
        executable: false,
        rent_epoch: 0,
    }
}

fn program_account(owner: &Pubkey, data: Vec<u8>) -> Account {
    Account {
        lamports: ((data.len() as u64 + 128) * 6960).max(1),
        data,
        owner: *owner,
        executable: false,
        rent_epoch: 0,
    }
}

fn empty_account() -> Account {
    Account {
        lamports: 0,
        data: vec![],
        owner: SYSTEM_PROGRAM_ID,
        executable: false,
        rent_epoch: 0,
    }
}

fn system_program_account() -> Account {
    Account {
        lamports: 1,
        data: b"system_program".to_vec(),
        owner: NATIVE_LOADER_ID,
        executable: true,
        rent_epoch: 0,
    }
}

/// Build serialized Anchor Proposal account data.
fn build_proposal_data(
    program_id: &Pubkey,
    proposal_id: &[u8; 32],
    dwallet: &Pubkey,
    message_hash: &[u8; 32],
    creator: &Pubkey,
    yes_votes: u32,
    no_votes: u32,
    quorum: u32,
    status: u8,  // 0=Open, 1=Approved, 2=Rejected
    message_approval_bump: u8,
) -> (Vec<u8>, Account) {
    let mut data = vec![0u8; PROPOSAL_LEN];
    data[0..8].copy_from_slice(&PROPOSAL_DISC);
    data[PROP_PROPOSAL_ID..PROP_PROPOSAL_ID + 32].copy_from_slice(proposal_id);
    data[PROP_DWALLET..PROP_DWALLET + 32].copy_from_slice(dwallet.as_ref());
    data[PROP_MESSAGE_HASH..PROP_MESSAGE_HASH + 32].copy_from_slice(message_hash);
    data[PROP_SIGNATURE_SCHEME] = 0;
    data[PROP_CREATOR..PROP_CREATOR + 32].copy_from_slice(creator.as_ref());
    data[PROP_YES_VOTES..PROP_YES_VOTES + 4].copy_from_slice(&yes_votes.to_le_bytes());
    data[PROP_NO_VOTES..PROP_NO_VOTES + 4].copy_from_slice(&no_votes.to_le_bytes());
    data[PROP_QUORUM..PROP_QUORUM + 4].copy_from_slice(&quorum.to_le_bytes());
    data[PROP_STATUS] = status;
    data[PROP_MSG_APPROVAL_BUMP] = message_approval_bump;
    let acct = program_account(program_id, data.clone());
    (data, acct)
}

/// Build a CreateProposal instruction (Anchor serialization).
///
/// Accounts: [proposal(w), dwallet(r), creator(s), payer(ws), system_program(r)]
fn build_create_proposal_ix(
    program_id: &Pubkey,
    proposal: &Pubkey,
    dwallet: &Pubkey,
    creator: &Pubkey,
    payer: &Pubkey,
    proposal_id: [u8; 32],
    message_hash: [u8; 32],
    user_pubkey: [u8; 32],
    signature_scheme: u8,
    quorum: u32,
    message_approval_bump: u8,
) -> Instruction {
    // Anchor borsh serialization: disc(8) + proposal_id(32) + message_hash(32) +
    // user_pubkey(32) + signature_scheme(1) + quorum(4) + message_approval_bump(1)
    let mut ix_data = Vec::with_capacity(110);
    ix_data.extend_from_slice(&CREATE_PROPOSAL_DISC);
    ix_data.extend_from_slice(&proposal_id);
    ix_data.extend_from_slice(&message_hash);
    ix_data.extend_from_slice(&user_pubkey);
    ix_data.push(signature_scheme);
    ix_data.extend_from_slice(&quorum.to_le_bytes());
    ix_data.push(message_approval_bump);

    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*proposal, false),
            AccountMeta::new_readonly(*dwallet, false),
            AccountMeta::new_readonly(*creator, true),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        ],
        data: ix_data,
    }
}

/// Build a CastVote instruction (Anchor serialization) without CPI accounts.
///
/// Accounts: [proposal(w), vote_record(w), voter(s), payer(ws), system_program(r),
///            message_approval(w), dwallet(r), program(r), cpi_authority(r), dwallet_program(r)]
fn build_cast_vote_ix(
    program_id: &Pubkey,
    proposal: &Pubkey,
    vote_record: &Pubkey,
    voter: &Pubkey,
    payer: &Pubkey,
    proposal_id: [u8; 32],
    vote: bool,
    cpi_authority_bump: u8,
    // CPI accounts (must always be present for Anchor):
    message_approval: &Pubkey,
    dwallet: &Pubkey,
    program_account_key: &Pubkey,
    cpi_authority: &Pubkey,
    dwallet_program: &Pubkey,
) -> Instruction {
    // Anchor borsh: disc(8) + proposal_id(32) + vote(1) + cpi_authority_bump(1)
    let mut ix_data = Vec::with_capacity(42);
    ix_data.extend_from_slice(&CAST_VOTE_DISC);
    ix_data.extend_from_slice(&proposal_id);
    ix_data.push(if vote { 1 } else { 0 });
    ix_data.push(cpi_authority_bump);

    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*proposal, false),
            AccountMeta::new(*vote_record, false),
            AccountMeta::new_readonly(*voter, true),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
            AccountMeta::new(*message_approval, false),
            AccountMeta::new_readonly(*dwallet, false),
            AccountMeta::new_readonly(*program_account_key, false),
            AccountMeta::new_readonly(*cpi_authority, false),
            AccountMeta::new_readonly(*dwallet_program, false),
        ],
        data: ix_data,
    }
}

fn read_u32(data: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(data[offset..offset + 4].try_into().unwrap())
}

fn read_pubkey(data: &[u8], offset: usize) -> Pubkey {
    Pubkey::new_from_array(data[offset..offset + 32].try_into().unwrap())
}

// ═══════════════════════════════════════════════════════════════════════
// create_proposal tests
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn test_create_proposal_success() {
    let (mollusk, program_id) = setup();

    let creator = Pubkey::new_unique();
    let payer = Pubkey::new_unique();
    let dwallet_key = Pubkey::new_unique();
    let proposal_id = [0x01u8; 32];
    let message_hash = [0x42u8; 32];
    let user_pubkey = [0xAAu8; 32];

    let (proposal_pda, _proposal_bump) =
        Pubkey::find_program_address(&[b"proposal", &proposal_id], &program_id);

    let ix = build_create_proposal_ix(
        &program_id,
        &proposal_pda,
        &dwallet_key,
        &creator,
        &payer,
        proposal_id,
        message_hash,
        user_pubkey,
        0,
        3,
        0,
    );

    let result = mollusk.process_instruction(
        &ix,
        &[
            (proposal_pda, empty_account()),
            (dwallet_key, funded_account()),
            (creator, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );

    assert!(
        result.program_result.is_ok(),
        "create_proposal should succeed: {:?}",
        result.program_result
    );

    let prop_data = &result.resulting_accounts[0].1.data;
    assert_eq!(prop_data.len(), PROPOSAL_LEN);
    assert_eq!(&prop_data[0..8], &PROPOSAL_DISC, "anchor discriminator");
    assert_eq!(
        &prop_data[PROP_PROPOSAL_ID..PROP_PROPOSAL_ID + 32],
        &proposal_id,
        "proposal_id"
    );
    assert_eq!(
        read_pubkey(prop_data, PROP_DWALLET),
        dwallet_key,
        "dwallet"
    );
    assert_eq!(
        &prop_data[PROP_MESSAGE_HASH..PROP_MESSAGE_HASH + 32],
        &message_hash,
        "message_hash"
    );
    assert_eq!(
        read_pubkey(prop_data, PROP_CREATOR),
        creator,
        "creator"
    );
    assert_eq!(read_u32(prop_data, PROP_QUORUM), 3, "quorum");
    assert_eq!(prop_data[PROP_STATUS], 0, "status = Open");
    assert_eq!(read_u32(prop_data, PROP_YES_VOTES), 0, "yes_votes = 0");
    assert_eq!(read_u32(prop_data, PROP_NO_VOTES), 0, "no_votes = 0");
}

#[test]
fn test_create_proposal_already_exists() {
    let (mollusk, program_id) = setup();

    let creator = Pubkey::new_unique();
    let payer = Pubkey::new_unique();
    let dwallet_key = Pubkey::new_unique();
    let proposal_id = [0x02u8; 32];

    let (proposal_pda, _) =
        Pubkey::find_program_address(&[b"proposal", &proposal_id], &program_id);

    let (_, existing_account) = build_proposal_data(
        &program_id,
        &proposal_id,
        &dwallet_key,
        &[0x00u8; 32],
        &creator,
        0,
        0,
        3,
        0,
        0,
    );

    let ix = build_create_proposal_ix(
        &program_id,
        &proposal_pda,
        &dwallet_key,
        &creator,
        &payer,
        proposal_id,
        [0x00u8; 32],
        [0x00u8; 32],
        0,
        3,
        0,
    );

    let result = mollusk.process_instruction(
        &ix,
        &[
            (proposal_pda, existing_account),
            (dwallet_key, funded_account()),
            (creator, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );

    assert!(
        result.program_result.is_err(),
        "create_proposal with existing account should fail"
    );
}

// ═══════════════════════════════════════════════════════════════════════
// cast_vote tests
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn test_cast_vote_yes_success() {
    let (mollusk, program_id) = setup();

    let voter = Pubkey::new_unique();
    let payer = Pubkey::new_unique();
    let dwallet_key = Pubkey::new_unique();
    let proposal_id = [0x03u8; 32];

    let (proposal_pda, _) =
        Pubkey::find_program_address(&[b"proposal", &proposal_id], &program_id);

    let (_, proposal_account) = build_proposal_data(
        &program_id,
        &proposal_id,
        &dwallet_key,
        &[0x42u8; 32],
        &Pubkey::new_unique(),
        0,
        0,
        5, // high quorum
        0, // Open
        0,
    );

    let (vote_record_pda, _) =
        Pubkey::find_program_address(&[b"vote", &proposal_id, voter.as_ref()], &program_id);

    // Dummy CPI accounts (won't be invoked since quorum not reached).
    let dummy = Pubkey::new_unique();

    let ix = build_cast_vote_ix(
        &program_id,
        &proposal_pda,
        &vote_record_pda,
        &voter,
        &payer,
        proposal_id,
        true,
        0,
        &dummy, // message_approval
        &dwallet_key,
        &program_id, // program
        &dummy,      // cpi_authority
        &dummy,      // dwallet_program
    );

    let result = mollusk.process_instruction(
        &ix,
        &[
            (proposal_pda, proposal_account),
            (vote_record_pda, empty_account()),
            (voter, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
            (dummy, empty_account()),    // message_approval
            (dwallet_key, funded_account()), // dwallet
            (program_id, funded_account()),  // program
            (dummy, empty_account()),    // cpi_authority
            (dummy, empty_account()),    // dwallet_program
        ],
    );

    assert!(
        result.program_result.is_ok(),
        "cast_vote yes should succeed: {:?}",
        result.program_result
    );

    let vr_data = &result.resulting_accounts[1].1.data;
    assert_eq!(vr_data.len(), VOTE_RECORD_LEN);
    assert_eq!(&vr_data[0..8], &VOTE_RECORD_DISC, "vr anchor discriminator");
    assert_eq!(read_pubkey(vr_data, VR_VOTER), voter, "vr voter");
    assert_eq!(
        &vr_data[VR_PROPOSAL_ID..VR_PROPOSAL_ID + 32],
        &proposal_id,
        "vr proposal_id"
    );
    assert_eq!(vr_data[VR_VOTE], 1, "vr vote = yes (true)");

    let prop_data = &result.resulting_accounts[0].1.data;
    assert_eq!(read_u32(prop_data, PROP_YES_VOTES), 1, "yes_votes = 1");
    assert_eq!(read_u32(prop_data, PROP_NO_VOTES), 0, "no_votes = 0");
    assert_eq!(prop_data[PROP_STATUS], 0, "status still Open");
}

#[test]
fn test_cast_vote_closed_proposal_fails() {
    let (mollusk, program_id) = setup();

    let voter = Pubkey::new_unique();
    let payer = Pubkey::new_unique();
    let dwallet_key = Pubkey::new_unique();
    let proposal_id = [0x06u8; 32];

    let (proposal_pda, _) =
        Pubkey::find_program_address(&[b"proposal", &proposal_id], &program_id);

    let (_, proposal_account) = build_proposal_data(
        &program_id,
        &proposal_id,
        &dwallet_key,
        &[0x42u8; 32],
        &Pubkey::new_unique(),
        3,
        0,
        3,
        1, // Approved
        0,
    );

    let (vote_record_pda, _) =
        Pubkey::find_program_address(&[b"vote", &proposal_id, voter.as_ref()], &program_id);

    let dummy = Pubkey::new_unique();

    let ix = build_cast_vote_ix(
        &program_id,
        &proposal_pda,
        &vote_record_pda,
        &voter,
        &payer,
        proposal_id,
        true,
        0,
        &dummy,
        &dwallet_key,
        &program_id,
        &dummy,
        &dummy,
    );

    let result = mollusk.process_instruction(
        &ix,
        &[
            (proposal_pda, proposal_account),
            (vote_record_pda, empty_account()),
            (voter, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
            (dummy, empty_account()),
            (dwallet_key, funded_account()),
            (program_id, funded_account()),
            (dummy, empty_account()),
            (dummy, empty_account()),
        ],
    );

    assert!(
        result.program_result.is_err(),
        "cast_vote on closed/approved proposal should fail"
    );
}
