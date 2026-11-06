// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! Mollusk instruction-level tests for the Anchor voting example.
//!
//! Anchor programs use a different serialization format:
//! - Instruction data: 8-byte discriminator (sha256("global:<fn_name>")[..8]) + borsh args
//! - Account data: 8-byte discriminator (sha256("account:<Name>")[..8]) + borsh fields
//!
//! Tests create_council, create_proposal and cast_vote in isolation (non-CPI
//! paths), including the council bindings: council creation gated on the
//! dWallet owner, member-only proposing/voting, and the dWallet passed at
//! quorum having to be the proposal's dWallet.

use mollusk_svm::Mollusk;
use mollusk_svm::result::{InstructionResult, ProgramResult};
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_program_error::ProgramError;
use solana_pubkey::Pubkey;

const PROGRAM_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../target/deploy/ika_example_voting_anchor"
);

/// System program ID (11111111111111111111111111111111).
const SYSTEM_PROGRAM_ID: Pubkey = Pubkey::new_from_array([0u8; 32]);

/// NativeLoader ID (`NativeLoader1111111111111111111111111111111`).
const NATIVE_LOADER_ID: Pubkey = Pubkey::new_from_array([
    0x05, 0x87, 0x84, 0xbf, 0x14, 0x8b, 0xa4, 0x28, 0x2f, 0xb0, 0x12, 0x57, 0x48, 0x88, 0xa9, 0xf1,
    0x53, 0xa0, 0x7d, 0xad, 0xf7, 0x65, 0xc0, 0x45, 0x5c, 0x9a, 0x97, 0x03, 0x80, 0x00, 0x00, 0x00,
]);

// ── Anchor discriminators (sha256("global:<fn_name>")[..8]) ──
const CREATE_COUNCIL_DISC: [u8; 8] = [139, 168, 163, 13, 74, 173, 186, 168];
const CREATE_PROPOSAL_DISC: [u8; 8] = [132, 116, 68, 174, 216, 160, 198, 22];
const CAST_VOTE_DISC: [u8; 8] = [20, 212, 15, 189, 69, 180, 69, 151];

// ── Anchor account discriminators (sha256("account:<Name>")[..8]) ──
const COUNCIL_DISC: [u8; 8] = [28, 184, 149, 185, 217, 59, 252, 96];
const PROPOSAL_DISC: [u8; 8] = [26, 94, 189, 187, 116, 136, 53, 33];
const VOTE_RECORD_DISC: [u8; 8] = [112, 9, 123, 165, 234, 9, 157, 167];

/// `DWallet` discriminator in the dWallet program.
// The merged program ranges account discriminators by subsystem; the
// dWallet record is 97, not 2.
const DWALLET_ACCOUNT_DISCRIMINATOR: u8 = 97;

// ── Anchor error codes (`VotingError`, 6000 + index) ──
const ERR_INVALID_QUORUM: u32 = 6001;
const ERR_NOT_A_MEMBER: u32 = 6003;
const ERR_DWALLET_MISMATCH: u32 = 6004;
const ERR_NOT_DWALLET_OWNER: u32 = 6005;
const ERR_INVALID_DWALLET_ACCOUNT: u32 = 6006;
const ERR_DUPLICATE_MEMBER: u32 = 6007;
/// Anchor's built-in `ConstraintSeeds` (a council at the wrong PDA).
const ERR_CONSTRAINT_SEEDS: u32 = 2006;

// ── Account sizes (Anchor: 8-byte discriminator + InitSpace) ──
// Council: 8 + (32+4+1+(4+32*10)) = 8 + 361 = 369
// Proposal: 8 + (32+32+32+32+2+32+4+4+4+1+1) = 8 + 176 = 184
// VoteRecord: 8 + (32+32+1) = 8 + 65 = 73
const COUNCIL_LEN: usize = 369;
const PROPOSAL_LEN: usize = 184;
const VOTE_RECORD_LEN: usize = 73;

// ── Offsets into Council (after 8-byte Anchor discriminator) ──
const CN_DWALLET: usize = 8;
const CN_QUORUM: usize = 40;
const CN_BUMP: usize = 44;
const CN_MEMBERS_LEN: usize = 45; // u32 borsh vec length
const CN_MEMBERS: usize = 49;

// ── Offsets into Proposal (after 8-byte Anchor discriminator) ──
const PROP_PROPOSAL_ID: usize = 8;
const PROP_DWALLET: usize = 40;
const PROP_MESSAGE_HASH: usize = 72;
const PROP_SIGNATURE_SCHEME: usize = 136; // 2 bytes (u16 LE)
const PROP_CREATOR: usize = 138;
const PROP_YES_VOTES: usize = 170;
const PROP_NO_VOTES: usize = 174;
const PROP_QUORUM: usize = 178;
const PROP_STATUS: usize = 182;
const PROP_SIGNATURE_VOUCHER_BUMP: usize = 183;

// ── Offsets into VoteRecord (after 8-byte Anchor discriminator) ──
const VR_VOTER: usize = 8;
const VR_PROPOSAL_ID: usize = 40;
const VR_VOTE: usize = 72;

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

/// Anchor program ID from `declare_id!("LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY")`.
const ANCHOR_PROGRAM_ID: Pubkey = Pubkey::new_from_array([0x05u8; 32]);

fn setup() -> (Mollusk, Pubkey) {
    let program_id = ANCHOR_PROGRAM_ID;
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

/// Build serialized Anchor Council account data (borsh: fixed fields then a
/// length-prefixed members vec, padded to the max size).
fn build_council_data(dwallet: &Pubkey, quorum: u32, members: &[Pubkey], bump: u8) -> Vec<u8> {
    let mut data = vec![0u8; COUNCIL_LEN];
    data[0..8].copy_from_slice(&COUNCIL_DISC);
    data[CN_DWALLET..CN_DWALLET + 32].copy_from_slice(dwallet.as_ref());
    data[CN_QUORUM..CN_QUORUM + 4].copy_from_slice(&quorum.to_le_bytes());
    data[CN_BUMP] = bump;
    data[CN_MEMBERS_LEN..CN_MEMBERS_LEN + 4].copy_from_slice(&(members.len() as u32).to_le_bytes());
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
    status: u8, // 0=Open, 1=Approved, 2=Rejected
) -> Account {
    let mut data = vec![0u8; PROPOSAL_LEN];
    data[0..8].copy_from_slice(&PROPOSAL_DISC);
    data[PROP_PROPOSAL_ID..PROP_PROPOSAL_ID + 32].copy_from_slice(proposal_id);
    data[PROP_DWALLET..PROP_DWALLET + 32].copy_from_slice(dwallet.as_ref());
    data[PROP_MESSAGE_HASH..PROP_MESSAGE_HASH + 32].copy_from_slice(message_hash);
    data[PROP_SIGNATURE_SCHEME..PROP_SIGNATURE_SCHEME + 2].copy_from_slice(&0u16.to_le_bytes());
    data[PROP_CREATOR..PROP_CREATOR + 32].copy_from_slice(creator.as_ref());
    data[PROP_YES_VOTES..PROP_YES_VOTES + 4].copy_from_slice(&yes_votes.to_le_bytes());
    data[PROP_NO_VOTES..PROP_NO_VOTES + 4].copy_from_slice(&no_votes.to_le_bytes());
    data[PROP_QUORUM..PROP_QUORUM + 4].copy_from_slice(&quorum.to_le_bytes());
    data[PROP_STATUS] = status;
    data[PROP_SIGNATURE_VOUCHER_BUMP] = canonical_voucher_bump(program_id, proposal_id);
    program_account(program_id, data)
}

/// Build a CreateCouncil instruction (Anchor serialization).
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
    // borsh: disc(8) + quorum(4) + members vec (u32 len + 32*n)
    let mut ix_data = Vec::with_capacity(16);
    ix_data.extend_from_slice(&CREATE_COUNCIL_DISC);
    ix_data.extend_from_slice(&quorum.to_le_bytes());
    ix_data.extend_from_slice(&(members.len() as u32).to_le_bytes());
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

/// Build a CreateProposal instruction (Anchor serialization).
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
) -> Instruction {
    // borsh: disc(8) + proposal_id(32) + message_hash(32) + user_pubkey(32) +
    // signature_scheme(2) + signature_voucher_bump(1)
    let mut ix_data = Vec::with_capacity(107);
    ix_data.extend_from_slice(&CREATE_PROPOSAL_DISC);
    ix_data.extend_from_slice(&proposal_id);
    ix_data.extend_from_slice(&message_hash);
    ix_data.extend_from_slice(&user_pubkey);
    ix_data.extend_from_slice(&signature_scheme.to_le_bytes());
    ix_data.push(signature_voucher_bump);

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

/// CPI accounts (always present for Anchor) appended to a CastVote instruction.
struct CpiAccounts {
    coordinator: Pubkey,
    signature_voucher: Pubkey,
    dwallet: Pubkey,
    program: Pubkey,
    cpi_authority: Pubkey,
    dwallet_program: Pubkey,
}

/// Build a CastVote instruction (Anchor serialization).
///
/// Accounts: [proposal(w), vote_record(w), council(r), voter(s), payer(ws), system_program(r),
///            coordinator(r), signature_voucher(w), dwallet(r), program(r),
///            cpi_authority(r), dwallet_program(r)]
fn build_cast_vote_ix(
    program_id: &Pubkey,
    proposal: &Pubkey,
    vote_record: &Pubkey,
    council: &Pubkey,
    voter: &Pubkey,
    payer: &Pubkey,
    proposal_id: [u8; 32],
    vote: bool,
    cpi_authority_bump: u8,
    cpi: &CpiAccounts,
) -> Instruction {
    // borsh: disc(8) + proposal_id(32) + vote(1) + cpi_authority_bump(1)
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
            AccountMeta::new_readonly(*council, false),
            AccountMeta::new_readonly(*voter, true),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
            AccountMeta::new_readonly(cpi.coordinator, false),
            AccountMeta::new(cpi.signature_voucher, false),
            AccountMeta::new_readonly(cpi.dwallet, false),
            AccountMeta::new_readonly(cpi.program, false),
            AccountMeta::new_readonly(cpi.cpi_authority, false),
            AccountMeta::new_readonly(cpi.dwallet_program, false),
        ],
        data: ix_data,
    }
}

fn read_u32(data: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(data[offset..offset.saturating_add(4)].try_into().unwrap())
}

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

/// A ready-made council of three members around a dWallet.
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
    let dwallet_program = Pubkey::new_from_array(ika_dwallet_anchor::ID.to_bytes());
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

/// Dummy CPI accounts for votes that do not reach quorum (never invoked). The
/// voucher slot holds the proposal's voucher PDA, which the program checks on
/// every vote.
fn dummy_cpi(
    program_id: &Pubkey,
    proposal_id: &[u8; 32],
    dwallet: Pubkey,
) -> (CpiAccounts, Vec<(Pubkey, Account)>) {
    let cpi = CpiAccounts {
        coordinator: Pubkey::new_unique(),
        signature_voucher: Pubkey::find_program_address(
            &[b"signature_voucher", proposal_id],
            program_id,
        )
        .0,
        dwallet,
        program: Pubkey::new_unique(),
        cpi_authority: Pubkey::new_unique(),
        dwallet_program: Pubkey::new_unique(),
    };
    let accounts = vec![
        (cpi.coordinator, empty_account()),
        (cpi.signature_voucher, empty_account()),
        (cpi.dwallet, funded_account()),
        (cpi.program, funded_account()),
        (cpi.cpi_authority, empty_account()),
        (cpi.dwallet_program, empty_account()),
    ];
    (cpi, accounts)
}

fn council_creation_accounts(
    fx: &Fixture,
    council: Pubkey,
    owner: Pubkey,
    payer: Pubkey,
) -> Vec<(Pubkey, Account)> {
    vec![
        (council, empty_account()),
        (fx.dwallet, dwallet_account(&fx.dwallet_program, &fx.owner)),
        (fx.dwallet_program, executable_program_account()),
        (owner, funded_account()),
        (payer, funded_account()),
        (SYSTEM_PROGRAM_ID, system_program_account()),
    ]
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
        &council_creation_accounts(&fx, fx.council_pda, fx.owner, payer),
    );
    assert_success(&result);

    let data = &result.resulting_accounts[0].1.data;
    assert_eq!(data.len(), COUNCIL_LEN);
    assert_eq!(&data[0..8], &COUNCIL_DISC, "anchor discriminator");
    assert_eq!(read_pubkey(data, CN_DWALLET), fx.dwallet);
    assert_eq!(read_u32(data, CN_QUORUM), 2);
    let (_, expected_bump) =
        Pubkey::find_program_address(&[b"council", fx.dwallet.as_ref()], &program_id);
    assert_eq!(data[CN_BUMP], expected_bump);
    assert_eq!(read_u32(data, CN_MEMBERS_LEN), 3);
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
        &council_creation_accounts(&fx, fx.council_pda, stranger, payer),
    );
    assert_custom_error(&result, ERR_NOT_DWALLET_OWNER);
}

#[test]
fn test_create_council_rejects_dwallet_not_owned_by_dwallet_program() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 2);
    let payer = Pubkey::new_unique();
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
    let mut accounts = council_creation_accounts(&fx, fx.council_pda, fx.owner, payer);
    accounts[1] = (fx.dwallet, dwallet_account(&impostor_owner, &fx.owner));
    let result = mollusk.process_instruction(&ix, &accounts);
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
        4,
        &fx.members,
    );
    let result = mollusk.process_instruction(
        &ix,
        &council_creation_accounts(&fx, fx.council_pda, fx.owner, payer),
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
        &council_creation_accounts(&fx, fx.council_pda, fx.owner, payer),
    );
    assert_custom_error(&result, ERR_DUPLICATE_MEMBER);
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
    let (proposal_pda, _) = Pubkey::find_program_address(&[b"proposal", &proposal_id], &program_id);

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
        0,
        canonical_voucher_bump(&program_id, &proposal_id),
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
    assert_eq!(&prop_data[0..8], &PROPOSAL_DISC, "anchor discriminator");
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
    assert_eq!(prop_data[PROP_STATUS], 0, "status = Open");
    assert_eq!(read_u32(prop_data, PROP_YES_VOTES), 0, "yes_votes = 0");
    assert_eq!(read_u32(prop_data, PROP_NO_VOTES), 0, "no_votes = 0");
}

#[test]
fn test_create_proposal_rejects_non_member() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 2);
    let stranger = Pubkey::new_unique();
    let payer = Pubkey::new_unique();
    let proposal_id = [0x02u8; 32];
    let (proposal_pda, _) = Pubkey::find_program_address(&[b"proposal", &proposal_id], &program_id);

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
    // with the victim's dWallet: the council PDA is derived from the dWallet,
    // so Anchor's seeds constraint rejects it.
    let attacker_fx = fixture(&program_id, 1);
    let victim_dwallet = Pubkey::new_unique();
    let payer = Pubkey::new_unique();
    let proposal_id = [0x03u8; 32];
    let (proposal_pda, _) = Pubkey::find_program_address(&[b"proposal", &proposal_id], &program_id);

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
    assert_custom_error(&result, ERR_CONSTRAINT_SEEDS);
}

#[test]
fn test_create_proposal_already_exists() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 2);
    let creator = fx.members[0];
    let payer = Pubkey::new_unique();
    let proposal_id = [0x04u8; 32];
    let (proposal_pda, _) = Pubkey::find_program_address(&[b"proposal", &proposal_id], &program_id);

    let existing = build_proposal_data(
        &program_id,
        &proposal_id,
        &fx.dwallet,
        &[0x00u8; 32],
        &creator,
        0,
        0,
        2,
        0,
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
    );
    let result = mollusk.process_instruction(
        &ix,
        &[
            (proposal_pda, existing),
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

#[test]
fn test_cast_vote_yes_success() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 5);
    let voter = fx.members[1];
    let payer = Pubkey::new_unique();
    let proposal_id = [0x05u8; 32];
    let (proposal_pda, _) = Pubkey::find_program_address(&[b"proposal", &proposal_id], &program_id);
    let proposal_account = build_proposal_data(
        &program_id,
        &proposal_id,
        &fx.dwallet,
        &[0x42u8; 32],
        &fx.members[0],
        0,
        0,
        5, // high quorum
        0, // Open
    );
    let (vote_record_pda, _) =
        Pubkey::find_program_address(&[b"vote", &proposal_id, voter.as_ref()], &program_id);
    let (cpi, cpi_accounts) = dummy_cpi(&program_id, &proposal_id, fx.dwallet);

    let ix = build_cast_vote_ix(
        &program_id,
        &proposal_pda,
        &vote_record_pda,
        &fx.council_pda,
        &voter,
        &payer,
        proposal_id,
        true,
        0,
        &cpi,
    );
    let mut accounts = vec![
        (proposal_pda, proposal_account),
        (vote_record_pda, empty_account()),
        (fx.council_pda, fx.council_account.clone()),
        (voter, funded_account()),
        (payer, funded_account()),
        (SYSTEM_PROGRAM_ID, system_program_account()),
    ];
    accounts.extend(cpi_accounts);
    let result = mollusk.process_instruction(&ix, &accounts);
    assert_success(&result);

    let vr_data = &result.resulting_accounts[1].1.data;
    assert_eq!(vr_data.len(), VOTE_RECORD_LEN);
    assert_eq!(&vr_data[0..8], &VOTE_RECORD_DISC, "vr anchor discriminator");
    assert_eq!(read_pubkey(vr_data, VR_VOTER), voter, "vr voter");
    assert_eq!(&vr_data[VR_PROPOSAL_ID..VR_PROPOSAL_ID + 32], &proposal_id);
    assert_eq!(vr_data[VR_VOTE], 1, "vr vote = yes (true)");

    let prop_data = &result.resulting_accounts[0].1.data;
    assert_eq!(read_u32(prop_data, PROP_YES_VOTES), 1, "yes_votes = 1");
    assert_eq!(read_u32(prop_data, PROP_NO_VOTES), 0, "no_votes = 0");
    assert_eq!(prop_data[PROP_STATUS], 0, "status still Open");
}

#[test]
fn test_cast_vote_rejects_non_member() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 5);
    let stranger = Pubkey::new_unique();
    let payer = Pubkey::new_unique();
    let proposal_id = [0x06u8; 32];
    let (proposal_pda, _) = Pubkey::find_program_address(&[b"proposal", &proposal_id], &program_id);
    let proposal_account = build_proposal_data(
        &program_id,
        &proposal_id,
        &fx.dwallet,
        &[0x42u8; 32],
        &fx.members[0],
        0,
        0,
        5,
        0,
    );
    let (vote_record_pda, _) =
        Pubkey::find_program_address(&[b"vote", &proposal_id, stranger.as_ref()], &program_id);
    let (cpi, cpi_accounts) = dummy_cpi(&program_id, &proposal_id, fx.dwallet);

    let ix = build_cast_vote_ix(
        &program_id,
        &proposal_pda,
        &vote_record_pda,
        &fx.council_pda,
        &stranger,
        &payer,
        proposal_id,
        true,
        0,
        &cpi,
    );
    let mut accounts = vec![
        (proposal_pda, proposal_account),
        (vote_record_pda, empty_account()),
        (fx.council_pda, fx.council_account.clone()),
        (stranger, funded_account()),
        (payer, funded_account()),
        (SYSTEM_PROGRAM_ID, system_program_account()),
    ];
    accounts.extend(cpi_accounts);
    let result = mollusk.process_instruction(&ix, &accounts);
    assert_custom_error(&result, ERR_NOT_A_MEMBER);
}

#[test]
fn test_cast_vote_rejects_council_of_another_dwallet() {
    let (mollusk, program_id) = setup();
    let victim_fx = fixture(&program_id, 2);
    let attacker_fx = fixture(&program_id, 1);
    let payer = Pubkey::new_unique();
    let proposal_id = [0x07u8; 32];
    let (proposal_pda, _) = Pubkey::find_program_address(&[b"proposal", &proposal_id], &program_id);
    let proposal_account = build_proposal_data(
        &program_id,
        &proposal_id,
        &victim_fx.dwallet,
        &[0x42u8; 32],
        &victim_fx.members[0],
        0,
        0,
        2,
        0,
    );
    let voter = attacker_fx.members[0];
    let (vote_record_pda, _) =
        Pubkey::find_program_address(&[b"vote", &proposal_id, voter.as_ref()], &program_id);
    let (cpi, cpi_accounts) = dummy_cpi(&program_id, &proposal_id, victim_fx.dwallet);

    let ix = build_cast_vote_ix(
        &program_id,
        &proposal_pda,
        &vote_record_pda,
        &attacker_fx.council_pda,
        &voter,
        &payer,
        proposal_id,
        true,
        0,
        &cpi,
    );
    let mut accounts = vec![
        (proposal_pda, proposal_account),
        (vote_record_pda, empty_account()),
        (attacker_fx.council_pda, attacker_fx.council_account.clone()),
        (voter, funded_account()),
        (payer, funded_account()),
        (SYSTEM_PROGRAM_ID, system_program_account()),
    ];
    accounts.extend(cpi_accounts);
    let result = mollusk.process_instruction(&ix, &accounts);
    assert_custom_error(&result, ERR_CONSTRAINT_SEEDS);
}

#[test]
fn test_cast_vote_rejects_wrong_dwallet() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 5);
    let voter = fx.members[0];
    let payer = Pubkey::new_unique();
    let proposal_id = [0x08u8; 32];
    let (proposal_pda, _) = Pubkey::find_program_address(&[b"proposal", &proposal_id], &program_id);
    let proposal_account = build_proposal_data(
        &program_id,
        &proposal_id,
        &fx.dwallet,
        &[0x42u8; 32],
        &fx.members[0],
        0,
        0,
        5,
        0,
    );
    let (vote_record_pda, _) =
        Pubkey::find_program_address(&[b"vote", &proposal_id, voter.as_ref()], &program_id);
    // The `address = proposal.dwallet` constraint fires on every vote, not
    // only at quorum — a caller-chosen dWallet is rejected up front.
    let (cpi, cpi_accounts) = dummy_cpi(&program_id, &proposal_id, Pubkey::new_unique());

    let ix = build_cast_vote_ix(
        &program_id,
        &proposal_pda,
        &vote_record_pda,
        &fx.council_pda,
        &voter,
        &payer,
        proposal_id,
        true,
        0,
        &cpi,
    );
    let mut accounts = vec![
        (proposal_pda, proposal_account),
        (vote_record_pda, empty_account()),
        (fx.council_pda, fx.council_account.clone()),
        (voter, funded_account()),
        (payer, funded_account()),
        (SYSTEM_PROGRAM_ID, system_program_account()),
    ];
    accounts.extend(cpi_accounts);
    let result = mollusk.process_instruction(&ix, &accounts);
    assert_custom_error(&result, ERR_DWALLET_MISMATCH);
}

#[test]
fn test_cast_vote_closed_proposal_fails() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 3);
    let voter = fx.members[0];
    let payer = Pubkey::new_unique();
    let proposal_id = [0x09u8; 32];
    let (proposal_pda, _) = Pubkey::find_program_address(&[b"proposal", &proposal_id], &program_id);
    let proposal_account = build_proposal_data(
        &program_id,
        &proposal_id,
        &fx.dwallet,
        &[0x42u8; 32],
        &fx.members[0],
        3,
        0,
        3,
        1, // Approved (closed)
    );
    let (vote_record_pda, _) =
        Pubkey::find_program_address(&[b"vote", &proposal_id, voter.as_ref()], &program_id);
    let (cpi, cpi_accounts) = dummy_cpi(&program_id, &proposal_id, fx.dwallet);

    let ix = build_cast_vote_ix(
        &program_id,
        &proposal_pda,
        &vote_record_pda,
        &fx.council_pda,
        &voter,
        &payer,
        proposal_id,
        true,
        0,
        &cpi,
    );
    let mut accounts = vec![
        (proposal_pda, proposal_account),
        (vote_record_pda, empty_account()),
        (fx.council_pda, fx.council_account.clone()),
        (voter, funded_account()),
        (payer, funded_account()),
        (SYSTEM_PROGRAM_ID, system_program_account()),
    ];
    accounts.extend(cpi_accounts);
    let result = mollusk.process_instruction(&ix, &accounts);
    // VotingError::ProposalClosed = 6000
    assert_custom_error(&result, 6000);
}
