// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! Mollusk instruction-level tests for the native voting example.
//!
//! Tests create_council, create_proposal and cast_vote in isolation — in
//! particular the bindings that keep one council's members from approving
//! messages for another council's dWallet: council-per-dWallet creation gated
//! on the dWallet owner, member-only proposing/voting, and the dWallet
//! passed at quorum having to be the proposal's dWallet.

use mollusk_svm::Mollusk;
use mollusk_svm::result::{InstructionResult, ProgramResult};
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_program_error::ProgramError;
use solana_pubkey::Pubkey;

const PROGRAM_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../target/deploy/ika_example_voting_native"
);

/// System program ID (11111111111111111111111111111111).
const SYSTEM_PROGRAM_ID: Pubkey = Pubkey::new_from_array([0u8; 32]);

/// NativeLoader ID (`NativeLoader1111111111111111111111111111111`).
const NATIVE_LOADER_ID: Pubkey = Pubkey::new_from_array([
    0x05, 0x87, 0x84, 0xbf, 0x14, 0x8b, 0xa4, 0x28, 0x2f, 0xb0, 0x12, 0x57, 0x48, 0x88, 0xa9, 0xf1,
    0x53, 0xa0, 0x7d, 0xad, 0xf7, 0x65, 0xc0, 0x45, 0x5c, 0x9a, 0x97, 0x03, 0x80, 0x00, 0x00, 0x00,
]);

// ── Account discriminators ──
const PROPOSAL_DISCRIMINATOR: u8 = 1;
const VOTE_RECORD_DISCRIMINATOR: u8 = 2;
const COUNCIL_DISCRIMINATOR: u8 = 3;
/// `DWallet` discriminator in the dWallet program.
// The merged program ranges account discriminators by subsystem; the
// dWallet record is 97, not 2.
const DWALLET_ACCOUNT_DISCRIMINATOR: u8 = 97;

// ── Status values ──
const STATUS_OPEN: u8 = 0;
const STATUS_APPROVED: u8 = 1;

// ── Program error codes (`VotingError`) ──
const ERR_DWALLET_MISMATCH: u32 = 0;
const ERR_NOT_A_MEMBER: u32 = 1;
const ERR_NOT_DWALLET_OWNER: u32 = 2;
const ERR_INVALID_COUNCIL: u32 = 3;
const ERR_INVALID_DWALLET_ACCOUNT: u32 = 4;
const ERR_INVALID_QUORUM: u32 = 5;
const ERR_DUPLICATE_MEMBER: u32 = 6;
const ERR_PROPOSAL_CLOSED: u32 = 7;

// ── Account sizes ──
const COUNCIL_LEN: usize = 361;
const PROPOSAL_LEN: usize = 196;
const VOTE_RECORD_LEN: usize = 69;

// ── Council offsets ──
const CN_DWALLET: usize = 2;
const CN_QUORUM: usize = 34;
const CN_MEMBER_COUNT: usize = 38;
const CN_BUMP: usize = 40;
const CN_MEMBERS: usize = 41;

// ── Proposal offsets ──
const PROP_PROPOSAL_ID: usize = 2;
const PROP_DWALLET: usize = 34;
const PROP_MESSAGE_HASH: usize = 66;
const PROP_SIGNATURE_SCHEME: usize = 130; // 2 bytes (u16 LE)
const PROP_CREATOR: usize = 132;
const PROP_YES_VOTES: usize = 164;
const PROP_NO_VOTES: usize = 168;
const PROP_QUORUM: usize = 172;
const PROP_STATUS: usize = 176;
const PROP_SIGNATURE_VOUCHER_BUMP: usize = 177;
const PROP_BUMP: usize = 178;

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
        lamports: (data.len() as u64)
            .saturating_add(128)
            .saturating_mul(6960)
            .max(1),
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

/// A stand-in for the dWallet program: only its executability and address
/// (as the dWallet account owner) matter to the voting program's checks.
fn executable_program_account() -> Account {
    Account {
        lamports: 1,
        data: vec![],
        owner: NATIVE_LOADER_ID,
        executable: true,
        rent_epoch: 0,
    }
}

/// A `DWallet` account owned by `dwallet_program` with the given owner
/// (discriminator + version header, then `owner` at offset 2).
fn dwallet_account(dwallet_program: &Pubkey, owner: &Pubkey) -> Account {
    let mut data = vec![0u8; 185];
    data[0] = DWALLET_ACCOUNT_DISCRIMINATOR;
    data[1] = 1;
    data[2..34].copy_from_slice(owner.as_ref());
    program_account(dwallet_program, data)
}

/// Build serialized Council account data.
fn build_council_data(dwallet: &Pubkey, quorum: u32, members: &[Pubkey], bump: u8) -> Vec<u8> {
    let mut data = vec![0u8; COUNCIL_LEN];
    data[0] = COUNCIL_DISCRIMINATOR;
    data[1] = 1;
    data[CN_DWALLET..CN_DWALLET + 32].copy_from_slice(dwallet.as_ref());
    data[CN_QUORUM..CN_QUORUM + 4].copy_from_slice(&quorum.to_le_bytes());
    data[CN_MEMBER_COUNT..CN_MEMBER_COUNT + 2]
        .copy_from_slice(&(members.len() as u16).to_le_bytes());
    data[CN_BUMP] = bump;
    for (index, member) in members.iter().enumerate() {
        let offset = CN_MEMBERS.saturating_add(index.saturating_mul(32));
        data[offset..offset.saturating_add(32)].copy_from_slice(member.as_ref());
    }
    data
}

/// Derive the council PDA and build its account for `dwallet`.
fn council_for(
    program_id: &Pubkey,
    dwallet: &Pubkey,
    quorum: u32,
    members: &[Pubkey],
) -> (Pubkey, Account) {
    let (council_pda, bump) =
        Pubkey::find_program_address(&[b"council", dwallet.as_ref()], program_id);
    let data = build_council_data(dwallet, quorum, members, bump);
    (council_pda, program_account(program_id, data))
}

/// Build serialized Proposal account data.
fn build_proposal_data(
    proposal_id: &[u8; 32],
    dwallet: &Pubkey,
    message_hash: &[u8; 32],
    creator: &Pubkey,
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
    data[PROP_SIGNATURE_SCHEME..PROP_SIGNATURE_SCHEME + 2].copy_from_slice(&0u16.to_le_bytes());
    data[PROP_CREATOR..PROP_CREATOR + 32].copy_from_slice(creator.as_ref());
    data[PROP_YES_VOTES..PROP_YES_VOTES + 4].copy_from_slice(&yes_votes.to_le_bytes());
    data[PROP_NO_VOTES..PROP_NO_VOTES + 4].copy_from_slice(&no_votes.to_le_bytes());
    data[PROP_QUORUM..PROP_QUORUM + 4].copy_from_slice(&quorum.to_le_bytes());
    data[PROP_STATUS] = status;
    data[PROP_SIGNATURE_VOUCHER_BUMP] = 0;
    data[PROP_BUMP] = bump;
    data
}

/// Build serialized VoteRecord account data.
fn build_vote_record_data(voter: &Pubkey, proposal_id: &[u8; 32], vote: u8, bump: u8) -> Vec<u8> {
    let mut data = vec![0u8; VOTE_RECORD_LEN];
    data[0] = VOTE_RECORD_DISCRIMINATOR;
    data[1] = 1; // version
    data[VR_VOTER..VR_VOTER + 32].copy_from_slice(voter.as_ref());
    data[VR_PROPOSAL_ID..VR_PROPOSAL_ID + 32].copy_from_slice(proposal_id);
    data[VR_VOTE] = vote;
    data[VR_BUMP] = bump;
    data
}

/// Build a CreateCouncil instruction (disc=2).
///
/// Data layout: quorum(4) + member_count(2) + members(32 * n)
///
/// Accounts: [council(w), dwallet(r), dwallet_program(r), owner(s), payer(ws), system_program(r)]
fn build_create_council_ix(
    program_id: &Pubkey,
    council: &Pubkey,
    dwallet: &Pubkey,
    dwallet_program: &Pubkey,
    owner: &Pubkey,
    payer: &Pubkey,
    quorum: u32,
    members: &[Pubkey],
) -> Instruction {
    let mut ix_data = Vec::with_capacity(1);
    ix_data.push(2); // discriminator = CreateCouncil
    ix_data.extend_from_slice(&quorum.to_le_bytes());
    ix_data.extend_from_slice(&(members.len() as u16).to_le_bytes());
    for member in members {
        ix_data.extend_from_slice(member.as_ref());
    }

    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*council, false),
            AccountMeta::new_readonly(*dwallet, false),
            AccountMeta::new_readonly(*dwallet_program, false),
            AccountMeta::new_readonly(*owner, true),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        ],
        data: ix_data,
    }
}

/// Build a CreateProposal instruction (disc=0).
///
/// Data layout: proposal_id(32) + message_hash(32) + user_pubkey(32) +
///              signature_scheme(2) + signature_voucher_bump(1) + bump(1) = 100
///
/// Accounts: [proposal(w), council(r), dwallet(r), creator(s), payer(ws), system_program(r)]
fn build_create_proposal_ix(
    program_id: &Pubkey,
    proposal: &Pubkey,
    council: &Pubkey,
    dwallet: &Pubkey,
    creator: &Pubkey,
    payer: &Pubkey,
    proposal_id: [u8; 32],
    message_hash: [u8; 32],
    user_pubkey: [u8; 32],
    signature_scheme: u16,
    signature_voucher_bump: u8,
    proposal_bump: u8,
) -> Instruction {
    let mut ix_data = Vec::with_capacity(1 + 100);
    ix_data.push(0); // discriminator = CreateProposal
    ix_data.extend_from_slice(&proposal_id);
    ix_data.extend_from_slice(&message_hash);
    ix_data.extend_from_slice(&user_pubkey);
    ix_data.extend_from_slice(&signature_scheme.to_le_bytes());
    ix_data.push(signature_voucher_bump);
    ix_data.push(proposal_bump);

    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*proposal, false),
            AccountMeta::new_readonly(*council, false),
            AccountMeta::new_readonly(*dwallet, false),
            AccountMeta::new_readonly(*creator, true),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        ],
        data: ix_data,
    }
}

/// The canonical bump of the program's voucher PDA for `proposal_id`: the
/// only bump `CreateProposal` accepts.
fn canonical_voucher_bump(program_id: &Pubkey, proposal_id: &[u8; 32]) -> u8 {
    Pubkey::find_program_address(&[b"signature_voucher", proposal_id], program_id).1
}

/// Build a CastVote instruction (disc=1).
///
/// Data layout: proposal_id(32) + vote(1) + vote_record_bump(1) + cpi_authority_bump(1) = 35
///
/// Accounts (no quorum path): [proposal(w), vote_record(w), council(r), voter(s), payer(ws), system_program(r)]
fn build_cast_vote_ix(
    program_id: &Pubkey,
    proposal: &Pubkey,
    vote_record: &Pubkey,
    council: &Pubkey,
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
            AccountMeta::new_readonly(*council, false),
            AccountMeta::new_readonly(*voter, true),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        ],
        data: ix_data,
    }
}

/// Read a u32 from account data at offset (little-endian).
fn read_u32(data: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(data[offset..offset.saturating_add(4)].try_into().unwrap())
}

/// Read a pubkey (32 bytes) from account data at offset.
fn read_pubkey(data: &[u8], offset: usize) -> Pubkey {
    Pubkey::new_from_array(data[offset..offset.saturating_add(32)].try_into().unwrap())
}

fn assert_custom_error(result: &InstructionResult, code: u32) {
    match &result.program_result {
        ProgramResult::Failure(err) => assert_eq!(
            *err,
            ProgramError::Custom(code),
            "expected Custom({code}), got {err:?}"
        ),
        other => panic!("expected Custom({code}) failure, got {other:?}"),
    }
}

fn assert_success(result: &InstructionResult) {
    assert!(
        matches!(result.program_result, ProgramResult::Success),
        "expected success, got {:?}",
        result.program_result
    );
}

/// A ready-made council of three members (quorum 2) around a dWallet.
struct Fixture {
    dwallet: Pubkey,
    dwallet_program: Pubkey,
    owner: Pubkey,
    members: Vec<Pubkey>,
    council_pda: Pubkey,
    council_account: Account,
}

fn fixture(program_id: &Pubkey, quorum: u32) -> Fixture {
    let dwallet = Pubkey::new_unique();
    // The ika program the example was built for: it refuses any other.
    let dwallet_program = Pubkey::new_from_array(ika_dwallet_native::ID.to_bytes());
    let owner = Pubkey::new_unique();
    let members = vec![
        Pubkey::new_unique(),
        Pubkey::new_unique(),
        Pubkey::new_unique(),
    ];
    let (council_pda, council_account) = council_for(program_id, &dwallet, quorum, &members);
    Fixture {
        dwallet,
        dwallet_program,
        owner,
        members,
        council_pda,
        council_account,
    }
}

// ═══════════════════════════════════════════════════════════════════════
// create_council tests
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn test_create_council_success() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 2);
    let payer = Pubkey::new_unique();

    let ix = build_create_council_ix(
        &program_id,
        &fx.council_pda,
        &fx.dwallet,
        &fx.dwallet_program,
        &fx.owner,
        &payer,
        2,
        &fx.members,
    );
    let result = mollusk.process_instruction(
        &ix,
        &[
            (fx.council_pda, empty_account()),
            (fx.dwallet, dwallet_account(&fx.dwallet_program, &fx.owner)),
            (fx.dwallet_program, executable_program_account()),
            (fx.owner, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );
    assert_success(&result);

    let data = &result.resulting_accounts[0].1.data;
    assert_eq!(data.len(), COUNCIL_LEN);
    assert_eq!(data[0], COUNCIL_DISCRIMINATOR);
    assert_eq!(read_pubkey(data, CN_DWALLET), fx.dwallet);
    assert_eq!(read_u32(data, CN_QUORUM), 2);
    assert_eq!(
        &data[CN_MEMBER_COUNT..CN_MEMBER_COUNT + 2],
        &3u16.to_le_bytes()
    );
    let (_, expected_bump) =
        Pubkey::find_program_address(&[b"council", fx.dwallet.as_ref()], &program_id);
    assert_eq!(data[CN_BUMP], expected_bump);
    for (index, member) in fx.members.iter().enumerate() {
        assert_eq!(read_pubkey(data, CN_MEMBERS + index * 32), *member);
    }
}

#[test]
fn test_create_council_rejects_non_owner() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 2);
    let payer = Pubkey::new_unique();
    let stranger = Pubkey::new_unique();

    let ix = build_create_council_ix(
        &program_id,
        &fx.council_pda,
        &fx.dwallet,
        &fx.dwallet_program,
        &stranger,
        &payer,
        2,
        &fx.members,
    );
    let result = mollusk.process_instruction(
        &ix,
        &[
            (fx.council_pda, empty_account()),
            (fx.dwallet, dwallet_account(&fx.dwallet_program, &fx.owner)),
            (fx.dwallet_program, executable_program_account()),
            (stranger, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );
    assert_custom_error(&result, ERR_NOT_DWALLET_OWNER);
}

#[test]
fn test_create_council_rejects_dwallet_not_owned_by_dwallet_program() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 2);
    let payer = Pubkey::new_unique();
    // A look-alike account with the right bytes but owned by someone else.
    let impostor_owner = Pubkey::new_unique();

    let ix = build_create_council_ix(
        &program_id,
        &fx.council_pda,
        &fx.dwallet,
        &fx.dwallet_program,
        &fx.owner,
        &payer,
        2,
        &fx.members,
    );
    let result = mollusk.process_instruction(
        &ix,
        &[
            (fx.council_pda, empty_account()),
            (fx.dwallet, dwallet_account(&impostor_owner, &fx.owner)),
            (fx.dwallet_program, executable_program_account()),
            (fx.owner, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );
    assert_custom_error(&result, ERR_INVALID_DWALLET_ACCOUNT);
}

#[test]
fn test_create_council_rejects_quorum_above_member_count() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 2);
    let payer = Pubkey::new_unique();

    let ix = build_create_council_ix(
        &program_id,
        &fx.council_pda,
        &fx.dwallet,
        &fx.dwallet_program,
        &fx.owner,
        &payer,
        4, // > 3 members
        &fx.members,
    );
    let result = mollusk.process_instruction(
        &ix,
        &[
            (fx.council_pda, empty_account()),
            (fx.dwallet, dwallet_account(&fx.dwallet_program, &fx.owner)),
            (fx.dwallet_program, executable_program_account()),
            (fx.owner, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );
    assert_custom_error(&result, ERR_INVALID_QUORUM);
}

#[test]
fn test_create_council_rejects_duplicate_member() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 2);
    let payer = Pubkey::new_unique();
    let members = vec![fx.members[0], fx.members[1], fx.members[0]];

    let ix = build_create_council_ix(
        &program_id,
        &fx.council_pda,
        &fx.dwallet,
        &fx.dwallet_program,
        &fx.owner,
        &payer,
        2,
        &members,
    );
    let result = mollusk.process_instruction(
        &ix,
        &[
            (fx.council_pda, empty_account()),
            (fx.dwallet, dwallet_account(&fx.dwallet_program, &fx.owner)),
            (fx.dwallet_program, executable_program_account()),
            (fx.owner, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );
    assert_custom_error(&result, ERR_DUPLICATE_MEMBER);
}

#[test]
fn test_create_council_rejects_non_canonical_address() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 2);
    let payer = Pubkey::new_unique();
    let wrong_council = Pubkey::new_unique();

    let ix = build_create_council_ix(
        &program_id,
        &wrong_council,
        &fx.dwallet,
        &fx.dwallet_program,
        &fx.owner,
        &payer,
        2,
        &fx.members,
    );
    let result = mollusk.process_instruction(
        &ix,
        &[
            (wrong_council, empty_account()),
            (fx.dwallet, dwallet_account(&fx.dwallet_program, &fx.owner)),
            (fx.dwallet_program, executable_program_account()),
            (fx.owner, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );
    assert_custom_error(&result, ERR_INVALID_COUNCIL);
}

// ═══════════════════════════════════════════════════════════════════════
// create_proposal tests
// ═══════════════════════════════════════════════════════════════════════

#[test]
fn test_create_proposal_success() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 2);

    let creator = fx.members[0];
    let payer = Pubkey::new_unique();
    let proposal_id = [0x01u8; 32];
    let message_hash = [0x42u8; 32];
    let user_pubkey = [0xAAu8; 32];

    let (proposal_pda, proposal_bump) =
        Pubkey::find_program_address(&[b"proposal", &proposal_id], &program_id);

    let ix = build_create_proposal_ix(
        &program_id,
        &proposal_pda,
        &fx.council_pda,
        &fx.dwallet,
        &creator,
        &payer,
        proposal_id,
        message_hash,
        user_pubkey,
        0, // signature_scheme
        canonical_voucher_bump(&program_id, &proposal_id),
        proposal_bump,
    );

    let result = mollusk.process_instruction(
        &ix,
        &[
            (proposal_pda, empty_account()),
            (fx.council_pda, fx.council_account.clone()),
            (fx.dwallet, funded_account()),
            (creator, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );
    assert_success(&result);

    let prop_data = &result.resulting_accounts[0].1.data;
    assert_eq!(prop_data.len(), PROPOSAL_LEN);
    assert_eq!(prop_data[0], PROPOSAL_DISCRIMINATOR, "discriminator");
    assert_eq!(prop_data[1], 1, "version");
    assert_eq!(
        &prop_data[PROP_PROPOSAL_ID..PROP_PROPOSAL_ID + 32],
        &proposal_id
    );
    assert_eq!(read_pubkey(prop_data, PROP_DWALLET), fx.dwallet, "dwallet");
    assert_eq!(
        &prop_data[PROP_MESSAGE_HASH..PROP_MESSAGE_HASH + 32],
        &message_hash
    );
    assert_eq!(read_pubkey(prop_data, PROP_CREATOR), creator, "creator");
    assert_eq!(
        read_u32(prop_data, PROP_QUORUM),
        2,
        "quorum copied from council"
    );
    assert_eq!(prop_data[PROP_STATUS], STATUS_OPEN, "status = Open");
    assert_eq!(read_u32(prop_data, PROP_YES_VOTES), 0, "yes_votes = 0");
    assert_eq!(read_u32(prop_data, PROP_NO_VOTES), 0, "no_votes = 0");
    assert_eq!(prop_data[PROP_BUMP], proposal_bump, "bump");
}

#[test]
fn test_create_proposal_rejects_non_member() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 2);
    let stranger = Pubkey::new_unique();
    let payer = Pubkey::new_unique();
    let proposal_id = [0x02u8; 32];
    let (proposal_pda, proposal_bump) =
        Pubkey::find_program_address(&[b"proposal", &proposal_id], &program_id);

    let ix = build_create_proposal_ix(
        &program_id,
        &proposal_pda,
        &fx.council_pda,
        &fx.dwallet,
        &stranger,
        &payer,
        proposal_id,
        [0x42u8; 32],
        [0u8; 32],
        0,
        canonical_voucher_bump(&program_id, &proposal_id),
        proposal_bump,
    );
    let result = mollusk.process_instruction(
        &ix,
        &[
            (proposal_pda, empty_account()),
            (fx.council_pda, fx.council_account.clone()),
            (fx.dwallet, funded_account()),
            (stranger, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );
    assert_custom_error(&result, ERR_NOT_A_MEMBER);
}

#[test]
fn test_create_proposal_rejects_council_of_another_dwallet() {
    let (mollusk, program_id) = setup();
    // The attacker's own council (they are a member) is presented together
    // with the victim's dWallet: the council must be THE council of that
    // dWallet, so this is rejected.
    let attacker_fx = fixture(&program_id, 1);
    let victim_dwallet = Pubkey::new_unique();
    let payer = Pubkey::new_unique();
    let proposal_id = [0x03u8; 32];
    let (proposal_pda, proposal_bump) =
        Pubkey::find_program_address(&[b"proposal", &proposal_id], &program_id);

    let ix = build_create_proposal_ix(
        &program_id,
        &proposal_pda,
        &attacker_fx.council_pda,
        &victim_dwallet,
        &attacker_fx.members[0],
        &payer,
        proposal_id,
        [0x42u8; 32],
        [0u8; 32],
        0,
        canonical_voucher_bump(&program_id, &proposal_id),
        proposal_bump,
    );
    let result = mollusk.process_instruction(
        &ix,
        &[
            (proposal_pda, empty_account()),
            (attacker_fx.council_pda, attacker_fx.council_account.clone()),
            (victim_dwallet, funded_account()),
            (attacker_fx.members[0], funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );
    assert_custom_error(&result, ERR_INVALID_COUNCIL);
}

#[test]
fn test_create_proposal_rejects_forged_council_account() {
    let (mollusk, program_id) = setup();
    // Council-shaped data bound to the victim dWallet, but not at the
    // council PDA of that dWallet (the program only ever writes councils
    // there, so a program-owned look-alike cannot exist at another address
    // — this test drives the same check with a wrong-address account).
    let victim_dwallet = Pubkey::new_unique();
    let attacker = Pubkey::new_unique();
    let payer = Pubkey::new_unique();
    let forged_council = Pubkey::new_unique();
    let forged_data = build_council_data(&victim_dwallet, 1, &[attacker], 255);
    let proposal_id = [0x04u8; 32];
    let (proposal_pda, proposal_bump) =
        Pubkey::find_program_address(&[b"proposal", &proposal_id], &program_id);

    let ix = build_create_proposal_ix(
        &program_id,
        &proposal_pda,
        &forged_council,
        &victim_dwallet,
        &attacker,
        &payer,
        proposal_id,
        [0x42u8; 32],
        [0u8; 32],
        0,
        canonical_voucher_bump(&program_id, &proposal_id),
        proposal_bump,
    );
    let result = mollusk.process_instruction(
        &ix,
        &[
            (proposal_pda, empty_account()),
            (forged_council, program_account(&program_id, forged_data)),
            (victim_dwallet, funded_account()),
            (attacker, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );
    assert_custom_error(&result, ERR_INVALID_COUNCIL);
}

#[test]
fn test_create_proposal_already_exists() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 2);
    let creator = fx.members[0];
    let payer = Pubkey::new_unique();
    let proposal_id = [0x05u8; 32];

    let (proposal_pda, proposal_bump) =
        Pubkey::find_program_address(&[b"proposal", &proposal_id], &program_id);

    // Pre-populate the proposal account with existing data (already created).
    let existing_data = build_proposal_data(
        &proposal_id,
        &fx.dwallet,
        &[0x00u8; 32],
        &creator,
        0,
        0,
        2,
        STATUS_OPEN,
        proposal_bump,
    );

    let ix = build_create_proposal_ix(
        &program_id,
        &proposal_pda,
        &fx.council_pda,
        &fx.dwallet,
        &creator,
        &payer,
        proposal_id,
        [0x00u8; 32],
        [0x00u8; 32],
        0,
        canonical_voucher_bump(&program_id, &proposal_id),
        proposal_bump,
    );

    let result = mollusk.process_instruction(
        &ix,
        &[
            (proposal_pda, program_account(&program_id, existing_data)),
            (fx.council_pda, fx.council_account.clone()),
            (fx.dwallet, funded_account()),
            (creator, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );

    assert!(
        matches!(result.program_result, ProgramResult::Failure(_)),
        "create_proposal with existing account should fail: {:?}",
        result.program_result
    );
}

// ═══════════════════════════════════════════════════════════════════════
// cast_vote tests
// ═══════════════════════════════════════════════════════════════════════

/// Common cast_vote setup: an open proposal for the fixture's dWallet with the
/// given counters, and a fresh vote-record PDA for `voter`.
fn open_proposal(
    program_id: &Pubkey,
    fx: &Fixture,
    proposal_id: [u8; 32],
    yes_votes: u32,
    quorum: u32,
    status: u8,
) -> (Pubkey, Account) {
    let (proposal_pda, proposal_bump) =
        Pubkey::find_program_address(&[b"proposal", &proposal_id], program_id);
    let data = build_proposal_data(
        &proposal_id,
        &fx.dwallet,
        &[0x42u8; 32],
        &fx.members[0],
        yes_votes,
        0,
        quorum,
        status,
        proposal_bump,
    );
    (proposal_pda, program_account(program_id, data))
}

#[test]
fn test_cast_vote_yes_success() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 5);
    let voter = fx.members[1];
    let payer = Pubkey::new_unique();
    let proposal_id = [0x03u8; 32];
    let (proposal_pda, proposal_account) =
        open_proposal(&program_id, &fx, proposal_id, 0, 5, STATUS_OPEN);
    let (vote_record_pda, vr_bump) =
        Pubkey::find_program_address(&[b"vote", &proposal_id, voter.as_ref()], &program_id);

    let ix = build_cast_vote_ix(
        &program_id,
        &proposal_pda,
        &vote_record_pda,
        &fx.council_pda,
        &voter,
        &payer,
        proposal_id,
        1, // yes
        vr_bump,
    );
    let result = mollusk.process_instruction(
        &ix,
        &[
            (proposal_pda, proposal_account),
            (vote_record_pda, empty_account()),
            (fx.council_pda, fx.council_account.clone()),
            (voter, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );
    assert_success(&result);

    // Check VoteRecord was created correctly.
    let vr_data = &result.resulting_accounts[1].1.data;
    assert_eq!(vr_data.len(), VOTE_RECORD_LEN);
    assert_eq!(vr_data[0], VOTE_RECORD_DISCRIMINATOR, "vr discriminator");
    assert_eq!(vr_data[1], 1, "vr version");
    assert_eq!(read_pubkey(vr_data, VR_VOTER), voter, "vr voter");
    assert_eq!(&vr_data[VR_PROPOSAL_ID..VR_PROPOSAL_ID + 32], &proposal_id);
    assert_eq!(vr_data[VR_VOTE], 1, "vr vote = yes");
    assert_eq!(vr_data[VR_BUMP], vr_bump, "vr bump");

    // Check proposal yes_votes incremented.
    let prop_data = &result.resulting_accounts[0].1.data;
    assert_eq!(read_u32(prop_data, PROP_YES_VOTES), 1, "yes_votes = 1");
    assert_eq!(read_u32(prop_data, PROP_NO_VOTES), 0, "no_votes = 0");
    assert_eq!(prop_data[PROP_STATUS], STATUS_OPEN, "status still Open");
}

#[test]
fn test_cast_vote_no_success() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 5);
    let voter = fx.members[2];
    let payer = Pubkey::new_unique();
    let proposal_id = [0x04u8; 32];
    let (proposal_pda, proposal_account) =
        open_proposal(&program_id, &fx, proposal_id, 0, 5, STATUS_OPEN);
    let (vote_record_pda, vr_bump) =
        Pubkey::find_program_address(&[b"vote", &proposal_id, voter.as_ref()], &program_id);

    let ix = build_cast_vote_ix(
        &program_id,
        &proposal_pda,
        &vote_record_pda,
        &fx.council_pda,
        &voter,
        &payer,
        proposal_id,
        0, // no
        vr_bump,
    );
    let result = mollusk.process_instruction(
        &ix,
        &[
            (proposal_pda, proposal_account),
            (vote_record_pda, empty_account()),
            (fx.council_pda, fx.council_account.clone()),
            (voter, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );
    assert_success(&result);

    let vr_data = &result.resulting_accounts[1].1.data;
    assert_eq!(vr_data[VR_VOTE], 0, "vr vote = no");
    let prop_data = &result.resulting_accounts[0].1.data;
    assert_eq!(read_u32(prop_data, PROP_YES_VOTES), 0, "yes_votes = 0");
    assert_eq!(read_u32(prop_data, PROP_NO_VOTES), 1, "no_votes = 1");
    assert_eq!(prop_data[PROP_STATUS], STATUS_OPEN, "status still Open");
}

#[test]
fn test_cast_vote_rejects_non_member() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 5);
    let stranger = Pubkey::new_unique();
    let payer = Pubkey::new_unique();
    let proposal_id = [0x05u8; 32];
    let (proposal_pda, proposal_account) =
        open_proposal(&program_id, &fx, proposal_id, 0, 5, STATUS_OPEN);
    let (vote_record_pda, vr_bump) =
        Pubkey::find_program_address(&[b"vote", &proposal_id, stranger.as_ref()], &program_id);

    let ix = build_cast_vote_ix(
        &program_id,
        &proposal_pda,
        &vote_record_pda,
        &fx.council_pda,
        &stranger,
        &payer,
        proposal_id,
        1,
        vr_bump,
    );
    let result = mollusk.process_instruction(
        &ix,
        &[
            (proposal_pda, proposal_account),
            (vote_record_pda, empty_account()),
            (fx.council_pda, fx.council_account.clone()),
            (stranger, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );
    assert_custom_error(&result, ERR_NOT_A_MEMBER);
}

#[test]
fn test_cast_vote_rejects_council_of_another_dwallet() {
    let (mollusk, program_id) = setup();
    // Proposal targets the victim's dWallet; the voter presents their own
    // council (of a different dWallet) where they are a member.
    let victim_fx = fixture(&program_id, 2);
    let attacker_fx = fixture(&program_id, 1);
    let payer = Pubkey::new_unique();
    let proposal_id = [0x06u8; 32];
    let (proposal_pda, proposal_account) =
        open_proposal(&program_id, &victim_fx, proposal_id, 0, 2, STATUS_OPEN);
    let voter = attacker_fx.members[0];
    let (vote_record_pda, vr_bump) =
        Pubkey::find_program_address(&[b"vote", &proposal_id, voter.as_ref()], &program_id);

    let ix = build_cast_vote_ix(
        &program_id,
        &proposal_pda,
        &vote_record_pda,
        &attacker_fx.council_pda,
        &voter,
        &payer,
        proposal_id,
        1,
        vr_bump,
    );
    let result = mollusk.process_instruction(
        &ix,
        &[
            (proposal_pda, proposal_account),
            (vote_record_pda, empty_account()),
            (attacker_fx.council_pda, attacker_fx.council_account.clone()),
            (voter, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );
    assert_custom_error(&result, ERR_INVALID_COUNCIL);
}

#[test]
fn test_cast_vote_at_quorum_rejects_wrong_dwallet() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 1);
    let voter = fx.members[0];
    let payer = Pubkey::new_unique();
    let proposal_id = [0x07u8; 32];
    let (proposal_pda, proposal_account) =
        open_proposal(&program_id, &fx, proposal_id, 0, 1, STATUS_OPEN);
    let (vote_record_pda, vr_bump) =
        Pubkey::find_program_address(&[b"vote", &proposal_id, voter.as_ref()], &program_id);

    // Quorum path: pass a different dWallet than the proposal's for the CPI.
    let other_dwallet = Pubkey::new_unique();
    let coordinator = Pubkey::new_unique();
    let signature_voucher = Pubkey::new_unique();
    let caller_program = Pubkey::new_unique();
    let cpi_authority = Pubkey::new_unique();
    let dwallet_program = Pubkey::new_unique();

    let mut ix = build_cast_vote_ix(
        &program_id,
        &proposal_pda,
        &vote_record_pda,
        &fx.council_pda,
        &voter,
        &payer,
        proposal_id,
        1,
        vr_bump,
    );
    ix.accounts.extend([
        AccountMeta::new_readonly(coordinator, false),
        AccountMeta::new(signature_voucher, false),
        AccountMeta::new_readonly(other_dwallet, false),
        AccountMeta::new_readonly(caller_program, false),
        AccountMeta::new_readonly(cpi_authority, false),
        AccountMeta::new_readonly(dwallet_program, false),
    ]);
    let result = mollusk.process_instruction(
        &ix,
        &[
            (proposal_pda, proposal_account),
            (vote_record_pda, empty_account()),
            (fx.council_pda, fx.council_account.clone()),
            (voter, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
            (coordinator, funded_account()),
            (signature_voucher, empty_account()),
            (other_dwallet, funded_account()),
            (caller_program, executable_program_account()),
            (cpi_authority, funded_account()),
            (dwallet_program, executable_program_account()),
        ],
    );
    assert_custom_error(&result, ERR_DWALLET_MISMATCH);
}

#[test]
fn test_cast_vote_double_vote_fails() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 5);
    let voter = fx.members[0];
    let payer = Pubkey::new_unique();
    let proposal_id = [0x08u8; 32];
    let (proposal_pda, proposal_account) =
        open_proposal(&program_id, &fx, proposal_id, 1, 5, STATUS_OPEN);
    let (vote_record_pda, vr_bump) =
        Pubkey::find_program_address(&[b"vote", &proposal_id, voter.as_ref()], &program_id);

    // Pre-populate VoteRecord (voter already voted).
    let existing_vr = build_vote_record_data(&voter, &proposal_id, 1, vr_bump);

    let ix = build_cast_vote_ix(
        &program_id,
        &proposal_pda,
        &vote_record_pda,
        &fx.council_pda,
        &voter,
        &payer,
        proposal_id,
        1,
        vr_bump,
    );
    let result = mollusk.process_instruction(
        &ix,
        &[
            (proposal_pda, proposal_account),
            (vote_record_pda, program_account(&program_id, existing_vr)),
            (fx.council_pda, fx.council_account.clone()),
            (voter, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );
    assert!(
        matches!(result.program_result, ProgramResult::Failure(_)),
        "double vote should fail (VoteRecord PDA already exists): {:?}",
        result.program_result
    );
}

#[test]
fn test_cast_vote_closed_proposal_fails() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 3);
    let voter = fx.members[0];
    let payer = Pubkey::new_unique();
    let proposal_id = [0x09u8; 32];
    let (proposal_pda, proposal_account) =
        open_proposal(&program_id, &fx, proposal_id, 3, 3, STATUS_APPROVED);
    let (vote_record_pda, vr_bump) =
        Pubkey::find_program_address(&[b"vote", &proposal_id, voter.as_ref()], &program_id);

    let ix = build_cast_vote_ix(
        &program_id,
        &proposal_pda,
        &vote_record_pda,
        &fx.council_pda,
        &voter,
        &payer,
        proposal_id,
        1,
        vr_bump,
    );
    let result = mollusk.process_instruction(
        &ix,
        &[
            (proposal_pda, proposal_account),
            (vote_record_pda, empty_account()),
            (fx.council_pda, fx.council_account.clone()),
            (voter, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );
    assert_custom_error(&result, ERR_PROPOSAL_CLOSED);
}
