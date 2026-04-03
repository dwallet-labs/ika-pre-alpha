// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! Mollusk instruction-level tests for the native voting example.
//!
//! Tests create_proposal and cast_vote in isolation (same logic as the pinocchio
//! variant but exercising the `ika-example-voting-native` SBF binary).

use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;

const PROGRAM_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../../../target/deploy/ika_example_voting_native"
);

/// System program ID (11111111111111111111111111111111).
const SYSTEM_PROGRAM_ID: Pubkey = Pubkey::new_from_array([0u8; 32]);

/// NativeLoader ID (`NativeLoader1111111111111111111111111111111`).
const NATIVE_LOADER_ID: Pubkey = Pubkey::new_from_array([
    0x05, 0x87, 0x84, 0xbf, 0x14, 0x8b, 0xa4, 0x28, 0x2f, 0xb0, 0x12, 0x57, 0x48, 0x88, 0xa9,
    0xf1, 0x53, 0xa0, 0x7d, 0xad, 0xf7, 0x65, 0xc0, 0x45, 0x5c, 0x9a, 0x97, 0x03, 0x80, 0x00,
    0x00, 0x00,
]);

// ── Account discriminators ──
const PROPOSAL_DISCRIMINATOR: u8 = 1;
const VOTE_RECORD_DISCRIMINATOR: u8 = 2;

// ── Status values ──
const STATUS_OPEN: u8 = 0;
const STATUS_APPROVED: u8 = 1;

// ── Account sizes ──
const PROPOSAL_LEN: usize = 195;
const VOTE_RECORD_LEN: usize = 69;

// ── Proposal offsets ──
const PROP_PROPOSAL_ID: usize = 2;
const PROP_DWALLET: usize = 34;
const PROP_MESSAGE_HASH: usize = 66;
const _PROP_USER_PUBKEY: usize = 98;
const PROP_SIGNATURE_SCHEME: usize = 130;
const PROP_CREATOR: usize = 131;
const PROP_YES_VOTES: usize = 163;
const PROP_NO_VOTES: usize = 167;
const PROP_QUORUM: usize = 171;
const PROP_STATUS: usize = 175;
const PROP_MSG_APPROVAL_BUMP: usize = 176;
const PROP_BUMP: usize = 177;

// ── VoteRecord offsets ──
const VR_VOTER: usize = 2;
const VR_PROPOSAL_ID: usize = 34;
const VR_VOTE: usize = 66;
const VR_BUMP: usize = 67;

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

/// Build serialized Proposal account data.
fn build_proposal_data(
    proposal_id: &[u8; 32],
    dwallet: &Pubkey,
    message_hash: &[u8; 32],
    authority: &Pubkey,
    yes_votes: u32,
    no_votes: u32,
    quorum: u32,
    status: u8,
    bump: u8,
) -> Vec<u8> {
    let mut data = vec![0u8; PROPOSAL_LEN];
    data[0] = PROPOSAL_DISCRIMINATOR;
    data[1] = 1; // version
    data[PROP_PROPOSAL_ID..PROP_PROPOSAL_ID + 32].copy_from_slice(proposal_id);
    data[PROP_DWALLET..PROP_DWALLET + 32].copy_from_slice(dwallet.as_ref());
    data[PROP_MESSAGE_HASH..PROP_MESSAGE_HASH + 32].copy_from_slice(message_hash);
    // user_pubkey left as zeroes (not needed for these tests)
    data[PROP_SIGNATURE_SCHEME] = 0;
    data[PROP_CREATOR..PROP_CREATOR + 32].copy_from_slice(authority.as_ref());
    data[PROP_YES_VOTES..PROP_YES_VOTES + 4].copy_from_slice(&yes_votes.to_le_bytes());
    data[PROP_NO_VOTES..PROP_NO_VOTES + 4].copy_from_slice(&no_votes.to_le_bytes());
    data[PROP_QUORUM..PROP_QUORUM + 4].copy_from_slice(&quorum.to_le_bytes());
    data[PROP_STATUS] = status;
    data[PROP_MSG_APPROVAL_BUMP] = 0;
    data[PROP_BUMP] = bump;
    data
}

/// Build serialized VoteRecord account data.
fn build_vote_record_data(
    voter: &Pubkey,
    proposal_id: &[u8; 32],
    vote: u8,
    bump: u8,
) -> Vec<u8> {
    let mut data = vec![0u8; VOTE_RECORD_LEN];
    data[0] = VOTE_RECORD_DISCRIMINATOR;
    data[1] = 1; // version
    data[VR_VOTER..VR_VOTER + 32].copy_from_slice(voter.as_ref());
    data[VR_PROPOSAL_ID..VR_PROPOSAL_ID + 32].copy_from_slice(proposal_id);
    data[VR_VOTE] = vote;
    data[VR_BUMP] = bump;
    data
}

/// Build a CreateProposal instruction (disc=0).
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
    proposal_bump: u8,
) -> Instruction {
    let mut ix_data = Vec::with_capacity(1 + 103);
    ix_data.push(0); // discriminator = CreateProposal
    ix_data.extend_from_slice(&proposal_id);
    ix_data.extend_from_slice(&message_hash);
    ix_data.extend_from_slice(&user_pubkey);
    ix_data.push(signature_scheme);
    ix_data.extend_from_slice(&quorum.to_le_bytes());
    ix_data.push(message_approval_bump);
    ix_data.push(proposal_bump);

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

/// Build a CastVote instruction (disc=1).
fn build_cast_vote_ix(
    program_id: &Pubkey,
    proposal: &Pubkey,
    vote_record: &Pubkey,
    voter: &Pubkey,
    payer: &Pubkey,
    proposal_id: [u8; 32],
    vote: u8,
    vote_record_bump: u8,
) -> Instruction {
    let mut ix_data = Vec::with_capacity(1 + 35);
    ix_data.push(1); // discriminator = CastVote
    ix_data.extend_from_slice(&proposal_id);
    ix_data.push(vote);
    ix_data.push(vote_record_bump);
    ix_data.push(0); // cpi_authority_bump (unused when quorum not reached)

    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*proposal, false),
            AccountMeta::new(*vote_record, false),
            AccountMeta::new_readonly(*voter, true),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        ],
        data: ix_data,
    }
}

/// Read a u32 from account data at offset (little-endian).
fn read_u32(data: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(data[offset..offset + 4].try_into().unwrap())
}

/// Read a pubkey (32 bytes) from account data at offset.
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

    let (proposal_pda, proposal_bump) =
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
        proposal_bump,
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
    assert_eq!(prop_data[0], PROPOSAL_DISCRIMINATOR, "discriminator");
    assert_eq!(prop_data[1], 1, "version");
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
        "authority/creator"
    );
    assert_eq!(read_u32(prop_data, PROP_QUORUM), 3, "quorum");
    assert_eq!(prop_data[PROP_STATUS], STATUS_OPEN, "status = Open");
    assert_eq!(read_u32(prop_data, PROP_YES_VOTES), 0, "yes_votes = 0");
    assert_eq!(read_u32(prop_data, PROP_NO_VOTES), 0, "no_votes = 0");
    assert_eq!(prop_data[PROP_BUMP], proposal_bump, "bump");
}

#[test]
fn test_create_proposal_already_exists() {
    let (mollusk, program_id) = setup();

    let creator = Pubkey::new_unique();
    let payer = Pubkey::new_unique();
    let dwallet_key = Pubkey::new_unique();
    let proposal_id = [0x02u8; 32];

    let (proposal_pda, proposal_bump) =
        Pubkey::find_program_address(&[b"proposal", &proposal_id], &program_id);

    let existing_data = build_proposal_data(
        &proposal_id,
        &dwallet_key,
        &[0x00u8; 32],
        &creator,
        0,
        0,
        3,
        STATUS_OPEN,
        proposal_bump,
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
        proposal_bump,
    );

    let result = mollusk.process_instruction(
        &ix,
        &[
            (proposal_pda, program_account(&program_id, existing_data)),
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

    let (proposal_pda, proposal_bump) =
        Pubkey::find_program_address(&[b"proposal", &proposal_id], &program_id);

    let proposal_data = build_proposal_data(
        &proposal_id,
        &dwallet_key,
        &[0x42u8; 32],
        &Pubkey::new_unique(),
        0,
        0,
        5,
        STATUS_OPEN,
        proposal_bump,
    );

    let (vote_record_pda, vr_bump) =
        Pubkey::find_program_address(&[b"vote", &proposal_id, voter.as_ref()], &program_id);

    let ix = build_cast_vote_ix(
        &program_id,
        &proposal_pda,
        &vote_record_pda,
        &voter,
        &payer,
        proposal_id,
        1,
        vr_bump,
    );

    let result = mollusk.process_instruction(
        &ix,
        &[
            (proposal_pda, program_account(&program_id, proposal_data)),
            (vote_record_pda, empty_account()),
            (voter, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );

    assert!(
        result.program_result.is_ok(),
        "cast_vote yes should succeed: {:?}",
        result.program_result
    );

    let vr_data = &result.resulting_accounts[1].1.data;
    assert_eq!(vr_data.len(), VOTE_RECORD_LEN);
    assert_eq!(vr_data[0], VOTE_RECORD_DISCRIMINATOR, "vr discriminator");
    assert_eq!(vr_data[1], 1, "vr version");
    assert_eq!(read_pubkey(vr_data, VR_VOTER), voter, "vr voter");
    assert_eq!(
        &vr_data[VR_PROPOSAL_ID..VR_PROPOSAL_ID + 32],
        &proposal_id,
        "vr proposal_id"
    );
    assert_eq!(vr_data[VR_VOTE], 1, "vr vote = yes");
    assert_eq!(vr_data[VR_BUMP], vr_bump, "vr bump");

    let prop_data = &result.resulting_accounts[0].1.data;
    assert_eq!(read_u32(prop_data, PROP_YES_VOTES), 1, "yes_votes = 1");
    assert_eq!(read_u32(prop_data, PROP_NO_VOTES), 0, "no_votes = 0");
    assert_eq!(prop_data[PROP_STATUS], STATUS_OPEN, "status still Open");
}

#[test]
fn test_cast_vote_no_success() {
    let (mollusk, program_id) = setup();

    let voter = Pubkey::new_unique();
    let payer = Pubkey::new_unique();
    let dwallet_key = Pubkey::new_unique();
    let proposal_id = [0x04u8; 32];

    let (proposal_pda, proposal_bump) =
        Pubkey::find_program_address(&[b"proposal", &proposal_id], &program_id);

    let proposal_data = build_proposal_data(
        &proposal_id,
        &dwallet_key,
        &[0x42u8; 32],
        &Pubkey::new_unique(),
        0,
        0,
        5,
        STATUS_OPEN,
        proposal_bump,
    );

    let (vote_record_pda, vr_bump) =
        Pubkey::find_program_address(&[b"vote", &proposal_id, voter.as_ref()], &program_id);

    let ix = build_cast_vote_ix(
        &program_id,
        &proposal_pda,
        &vote_record_pda,
        &voter,
        &payer,
        proposal_id,
        0,
        vr_bump,
    );

    let result = mollusk.process_instruction(
        &ix,
        &[
            (proposal_pda, program_account(&program_id, proposal_data)),
            (vote_record_pda, empty_account()),
            (voter, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );

    assert!(
        result.program_result.is_ok(),
        "cast_vote no should succeed: {:?}",
        result.program_result
    );

    let vr_data = &result.resulting_accounts[1].1.data;
    assert_eq!(vr_data[VR_VOTE], 0, "vr vote = no");

    let prop_data = &result.resulting_accounts[0].1.data;
    assert_eq!(read_u32(prop_data, PROP_YES_VOTES), 0, "yes_votes = 0");
    assert_eq!(read_u32(prop_data, PROP_NO_VOTES), 1, "no_votes = 1");
    assert_eq!(prop_data[PROP_STATUS], STATUS_OPEN, "status still Open");
}

#[test]
fn test_cast_vote_double_vote_fails() {
    let (mollusk, program_id) = setup();

    let voter = Pubkey::new_unique();
    let payer = Pubkey::new_unique();
    let dwallet_key = Pubkey::new_unique();
    let proposal_id = [0x05u8; 32];

    let (proposal_pda, proposal_bump) =
        Pubkey::find_program_address(&[b"proposal", &proposal_id], &program_id);

    let proposal_data = build_proposal_data(
        &proposal_id,
        &dwallet_key,
        &[0x42u8; 32],
        &Pubkey::new_unique(),
        1,
        0,
        5,
        STATUS_OPEN,
        proposal_bump,
    );

    let (vote_record_pda, vr_bump) =
        Pubkey::find_program_address(&[b"vote", &proposal_id, voter.as_ref()], &program_id);

    let existing_vr = build_vote_record_data(&voter, &proposal_id, 1, vr_bump);

    let ix = build_cast_vote_ix(
        &program_id,
        &proposal_pda,
        &vote_record_pda,
        &voter,
        &payer,
        proposal_id,
        1,
        vr_bump,
    );

    let result = mollusk.process_instruction(
        &ix,
        &[
            (proposal_pda, program_account(&program_id, proposal_data)),
            (vote_record_pda, program_account(&program_id, existing_vr)),
            (voter, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );

    assert!(
        result.program_result.is_err(),
        "double vote should fail (VoteRecord PDA already exists)"
    );
}

#[test]
fn test_cast_vote_closed_proposal_fails() {
    let (mollusk, program_id) = setup();

    let voter = Pubkey::new_unique();
    let payer = Pubkey::new_unique();
    let dwallet_key = Pubkey::new_unique();
    let proposal_id = [0x06u8; 32];

    let (proposal_pda, proposal_bump) =
        Pubkey::find_program_address(&[b"proposal", &proposal_id], &program_id);

    let proposal_data = build_proposal_data(
        &proposal_id,
        &dwallet_key,
        &[0x42u8; 32],
        &Pubkey::new_unique(),
        3,
        0,
        3,
        STATUS_APPROVED,
        proposal_bump,
    );

    let (vote_record_pda, vr_bump) =
        Pubkey::find_program_address(&[b"vote", &proposal_id, voter.as_ref()], &program_id);

    let ix = build_cast_vote_ix(
        &program_id,
        &proposal_pda,
        &vote_record_pda,
        &voter,
        &payer,
        proposal_id,
        1,
        vr_bump,
    );

    let result = mollusk.process_instruction(
        &ix,
        &[
            (proposal_pda, program_account(&program_id, proposal_data)),
            (vote_record_pda, empty_account()),
            (voter, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );

    assert!(
        result.program_result.is_err(),
        "cast_vote on closed/approved proposal should fail"
    );
}
