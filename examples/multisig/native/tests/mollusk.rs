// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! Mollusk instruction-level tests for the native multisig example.
//!
//! Tests create_multisig, create_transaction, approve and reject in
//! isolation — in particular the bindings that keep a multisig instance from
//! reaching any dWallet but its own: multisig-per-dWallet creation gated on the
//! dWallet owner, member-only proposing/voting, and the dWallet account
//! passed at threshold having to be the multisig's.

use mollusk_svm::Mollusk;
use mollusk_svm::result::{InstructionResult, ProgramResult};
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_program_error::ProgramError;
use solana_pubkey::Pubkey;

const PROGRAM_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../target/deploy/ika_example_multisig_native"
);

/// System program ID (11111111111111111111111111111111).
const SYSTEM_PROGRAM_ID: Pubkey = Pubkey::new_from_array([0u8; 32]);

/// NativeLoader ID (`NativeLoader1111111111111111111111111111111`).
const NATIVE_LOADER_ID: Pubkey = Pubkey::new_from_array([
    0x05, 0x87, 0x84, 0xbf, 0x14, 0x8b, 0xa4, 0x28, 0x2f, 0xb0, 0x12, 0x57, 0x48, 0x88, 0xa9, 0xf1,
    0x53, 0xa0, 0x7d, 0xad, 0xf7, 0x65, 0xc0, 0x45, 0x5c, 0x9a, 0x97, 0x03, 0x80, 0x00, 0x00, 0x00,
]);

// -- Discriminators --
const MULTISIG_DISCRIMINATOR: u8 = 1;
const TRANSACTION_DISCRIMINATOR: u8 = 2;
const APPROVAL_RECORD_DISCRIMINATOR: u8 = 3;
/// `DWallet` discriminator in the dWallet program.
// The merged program ranges account discriminators by subsystem; the
// dWallet record is 97, not 2.
const DWALLET_ACCOUNT_DISCRIMINATOR: u8 = 97;

// -- Status values --
const STATUS_ACTIVE: u8 = 0;
const STATUS_APPROVED: u8 = 1;
const STATUS_REJECTED: u8 = 2;

// -- Program error codes (`MultisigError`) --
const ERR_NOT_A_MEMBER: u32 = 0;
const ERR_DWALLET_MISMATCH: u32 = 1;
const ERR_NOT_DWALLET_OWNER: u32 = 3;
const ERR_INVALID_DWALLET_ACCOUNT: u32 = 4;
const ERR_INVALID_THRESHOLD: u32 = 5;
const ERR_DUPLICATE_MEMBER: u32 = 6;
const ERR_TRANSACTION_NOT_ACTIVE: u32 = 7;
const ERR_TRANSACTION_MISMATCH: u32 = 8;
const ERR_INVALID_MULTISIG: u32 = 9;

// -- Account sizes --
const MULTISIG_LEN: usize = 363;
const TRANSACTION_LEN: usize = 402;
const APPROVAL_RECORD_LEN: usize = 68;

// -- Multisig offsets --
const MS_DWALLET: usize = 2;
const MS_THRESHOLD: usize = 34;
const MS_MEMBER_COUNT: usize = 36;
const MS_TX_INDEX: usize = 38;
const MS_BUMP: usize = 42;
const MS_MEMBERS: usize = 43;

// -- Transaction offsets --
const TX_MULTISIG: usize = 2;
const TX_INDEX: usize = 34;
const TX_PROPOSER: usize = 38;
const TX_MESSAGE_HASH: usize = 70;
const TX_USER_PUBKEY: usize = 102;
const TX_SIGNATURE_SCHEME: usize = 134; // 2 bytes (u16 LE)
const TX_APPROVAL_COUNT: usize = 136;
const TX_REJECTION_COUNT: usize = 138;
const TX_STATUS: usize = 140;
const TX_SIGNATURE_VOUCHER_BUMP: usize = 141;
const TX_FUTURE_SIGN: usize = 142;
const TX_BUMP: usize = 143;
const TX_MESSAGE_DATA_LEN: usize = 144;
const TX_MESSAGE_DATA: usize = 146;

// -- ApprovalRecord offsets --
const AR_MEMBER: usize = 2;
const AR_TRANSACTION: usize = 34;
const AR_APPROVED: usize = 66;
const AR_BUMP: usize = 67;

// ===================================================================
// Helpers
// ===================================================================

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
/// (as the dWallet account owner) matter to the multisig program's checks.
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

/// Build Multisig account data.
fn build_multisig_data(
    dwallet: &Pubkey,
    threshold: u16,
    members: &[Pubkey],
    tx_index: u32,
    bump: u8,
) -> Vec<u8> {
    let mut data = vec![0u8; MULTISIG_LEN];
    data[0] = MULTISIG_DISCRIMINATOR;
    data[1] = 1;
    data[MS_DWALLET..MS_DWALLET + 32].copy_from_slice(dwallet.as_ref());
    data[MS_THRESHOLD..MS_THRESHOLD + 2].copy_from_slice(&threshold.to_le_bytes());
    data[MS_MEMBER_COUNT..MS_MEMBER_COUNT + 2]
        .copy_from_slice(&(members.len() as u16).to_le_bytes());
    data[MS_TX_INDEX..MS_TX_INDEX + 4].copy_from_slice(&tx_index.to_le_bytes());
    data[MS_BUMP] = bump;
    for (i, m) in members.iter().enumerate() {
        let offset = MS_MEMBERS.saturating_add(i.saturating_mul(32));
        data[offset..offset.saturating_add(32)].copy_from_slice(m.as_ref());
    }
    data
}

/// Derive the multisig PDA and build its account for `dwallet`.
fn multisig_for(
    program_id: &Pubkey,
    dwallet: &Pubkey,
    threshold: u16,
    members: &[Pubkey],
    tx_index: u32,
) -> (Pubkey, Account) {
    let (multisig_pda, bump) =
        Pubkey::find_program_address(&[b"multisig", dwallet.as_ref()], program_id);
    let data = build_multisig_data(dwallet, threshold, members, tx_index, bump);
    (multisig_pda, program_account(program_id, data))
}

/// Build Transaction account data.
fn build_transaction_data(
    multisig: &Pubkey,
    tx_index: u32,
    proposer: &Pubkey,
    message_hash: &[u8; 32],
    future_sign: bool,
    approval_count: u16,
    rejection_count: u16,
    status: u8,
    bump: u8,
) -> Vec<u8> {
    let mut data = vec![0u8; TRANSACTION_LEN];
    data[0] = TRANSACTION_DISCRIMINATOR;
    data[1] = 1;
    data[TX_MULTISIG..TX_MULTISIG + 32].copy_from_slice(multisig.as_ref());
    data[TX_INDEX..TX_INDEX + 4].copy_from_slice(&tx_index.to_le_bytes());
    data[TX_PROPOSER..TX_PROPOSER + 32].copy_from_slice(proposer.as_ref());
    data[TX_MESSAGE_HASH..TX_MESSAGE_HASH + 32].copy_from_slice(message_hash);
    // user_pubkey left zero
    data[TX_SIGNATURE_SCHEME..TX_SIGNATURE_SCHEME + 2].copy_from_slice(&0u16.to_le_bytes());
    data[TX_APPROVAL_COUNT..TX_APPROVAL_COUNT + 2].copy_from_slice(&approval_count.to_le_bytes());
    data[TX_REJECTION_COUNT..TX_REJECTION_COUNT + 2]
        .copy_from_slice(&rejection_count.to_le_bytes());
    data[TX_STATUS] = status;
    data[TX_SIGNATURE_VOUCHER_BUMP] = 0;
    data[TX_FUTURE_SIGN] = u8::from(future_sign);
    data[TX_BUMP] = bump;
    data[TX_MESSAGE_DATA_LEN..TX_MESSAGE_DATA_LEN + 2].copy_from_slice(&0u16.to_le_bytes());
    data
}

/// Derive the transaction PDA and build its account.
fn transaction_for(
    program_id: &Pubkey,
    multisig: &Pubkey,
    tx_index: u32,
    proposer: &Pubkey,
    future_sign: bool,
    approval_count: u16,
    rejection_count: u16,
    status: u8,
) -> (Pubkey, Account) {
    let (tx_pda, tx_bump) = Pubkey::find_program_address(
        &[b"transaction", multisig.as_ref(), &tx_index.to_le_bytes()],
        program_id,
    );
    let data = build_transaction_data(
        multisig,
        tx_index,
        proposer,
        &[0x42u8; 32],
        future_sign,
        approval_count,
        rejection_count,
        status,
        tx_bump,
    );
    (tx_pda, program_account(program_id, data))
}

/// Build a CreateMultisig instruction (disc=0).
///
/// Data: threshold(2) + member_count(2) + members(32 * n)
///
/// Accounts: [multisig(w), dwallet(r), dwallet_program(r), owner(s), payer(ws), system_program(r)]
fn build_create_multisig_ix(
    program_id: &Pubkey,
    multisig_pda: &Pubkey,
    dwallet: &Pubkey,
    dwallet_program: &Pubkey,
    owner: &Pubkey,
    payer: &Pubkey,
    threshold: u16,
    members: &[Pubkey],
) -> Instruction {
    let mut ix_data = Vec::with_capacity(1);
    ix_data.push(0); // discriminator = CreateMultisig
    ix_data.extend_from_slice(&threshold.to_le_bytes());
    ix_data.extend_from_slice(&(members.len() as u16).to_le_bytes());
    for m in members {
        ix_data.extend_from_slice(m.as_ref());
    }

    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*multisig_pda, false),
            AccountMeta::new_readonly(*dwallet, false),
            AccountMeta::new_readonly(*dwallet_program, false),
            AccountMeta::new_readonly(*owner, true),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        ],
        data: ix_data,
    }
}

/// Build a CreateTransaction instruction (disc=1).
fn build_create_transaction_ix(
    program_id: &Pubkey,
    multisig_pda: &Pubkey,
    tx_pda: &Pubkey,
    proposer: &Pubkey,
    payer: &Pubkey,
    message_hash: [u8; 32],
    user_pubkey: [u8; 32],
    signature_scheme: u16,
    signature_voucher_bump: u8,
    future_sign: bool,
    tx_bump: u8,
    message_data: &[u8],
) -> Instruction {
    let message_data_len = message_data.len() as u16;
    let mut ix_data = Vec::with_capacity(72);
    ix_data.push(1); // discriminator = CreateTransaction
    ix_data.extend_from_slice(&message_hash);
    ix_data.extend_from_slice(&user_pubkey);
    ix_data.extend_from_slice(&signature_scheme.to_le_bytes());
    ix_data.push(signature_voucher_bump);
    ix_data.push(u8::from(future_sign));
    ix_data.push(tx_bump);
    ix_data.extend_from_slice(&message_data_len.to_le_bytes());
    ix_data.extend_from_slice(message_data);

    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*multisig_pda, false),
            AccountMeta::new(*tx_pda, false),
            AccountMeta::new_readonly(*proposer, true),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        ],
        data: ix_data,
    }
}

/// The canonical bump of the program's voucher PDA for `transaction`: the
/// only bump `CreateTransaction` accepts.
fn canonical_voucher_bump(program_id: &Pubkey, transaction: &Pubkey) -> u8 {
    Pubkey::find_program_address(&[b"signature_voucher", transaction.as_ref()], program_id).1
}

/// Build an Approve instruction (disc=2, non-threshold path).
fn build_approve_ix(
    program_id: &Pubkey,
    multisig_pda: &Pubkey,
    tx_pda: &Pubkey,
    approval_record_pda: &Pubkey,
    member: &Pubkey,
    payer: &Pubkey,
    tx_index: u32,
    approval_record_bump: u8,
) -> Instruction {
    let mut ix_data = Vec::with_capacity(7);
    ix_data.push(2); // discriminator = Approve
    ix_data.extend_from_slice(&tx_index.to_le_bytes());
    ix_data.push(approval_record_bump);
    ix_data.push(0); // cpi_authority_bump (unused when threshold not reached)

    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new_readonly(*multisig_pda, false),
            AccountMeta::new(*tx_pda, false),
            AccountMeta::new(*approval_record_pda, false),
            AccountMeta::new_readonly(*member, true),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        ],
        data: ix_data,
    }
}

/// Build a Reject instruction (disc=3).
fn build_reject_ix(
    program_id: &Pubkey,
    multisig_pda: &Pubkey,
    tx_pda: &Pubkey,
    approval_record_pda: &Pubkey,
    member: &Pubkey,
    payer: &Pubkey,
    tx_index: u32,
    approval_record_bump: u8,
) -> Instruction {
    let mut ix_data = Vec::with_capacity(6);
    ix_data.push(3); // discriminator = Reject
    ix_data.extend_from_slice(&tx_index.to_le_bytes());
    ix_data.push(approval_record_bump);

    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new_readonly(*multisig_pda, false),
            AccountMeta::new(*tx_pda, false),
            AccountMeta::new(*approval_record_pda, false),
            AccountMeta::new_readonly(*member, true),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        ],
        data: ix_data,
    }
}

/// CPI accounts appended to an Approve instruction for the threshold path
/// (indices 6-11).
struct CpiAccounts {
    coordinator: Pubkey,
    signature_voucher: Pubkey,
    dwallet: Pubkey,
    caller_program: Pubkey,
    cpi_authority: Pubkey,
    dwallet_program: Pubkey,
}

fn with_cpi_accounts(mut ix: Instruction, cpi: &CpiAccounts) -> Instruction {
    ix.accounts.extend([
        AccountMeta::new_readonly(cpi.coordinator, false),
        AccountMeta::new(cpi.signature_voucher, false),
        AccountMeta::new_readonly(cpi.dwallet, false),
        AccountMeta::new_readonly(cpi.caller_program, false),
        AccountMeta::new_readonly(cpi.cpi_authority, false),
        AccountMeta::new_readonly(cpi.dwallet_program, false),
    ]);
    ix
}

fn cpi_fixture_accounts(cpi: &CpiAccounts) -> Vec<(Pubkey, Account)> {
    vec![
        (cpi.coordinator, funded_account()),
        (cpi.signature_voucher, empty_account()),
        (cpi.dwallet, funded_account()),
        (cpi.caller_program, executable_program_account()),
        (cpi.cpi_authority, funded_account()),
        (cpi.dwallet_program, executable_program_account()),
    ]
}

fn read_u16(data: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(data[offset..offset.saturating_add(2)].try_into().unwrap())
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

/// A ready-made 3-member multisig around a dWallet.
struct Fixture {
    dwallet: Pubkey,
    dwallet_program: Pubkey,
    owner: Pubkey,
    members: Vec<Pubkey>,
    multisig_pda: Pubkey,
    multisig_account: Account,
}

fn fixture(program_id: &Pubkey, threshold: u16, tx_index: u32) -> Fixture {
    let dwallet = Pubkey::new_unique();
    // The ika program the example was built for: it refuses any other.
    let dwallet_program = Pubkey::new_from_array(ika_dwallet_native::ID.to_bytes());
    let owner = Pubkey::new_unique();
    let members = vec![
        Pubkey::new_unique(),
        Pubkey::new_unique(),
        Pubkey::new_unique(),
    ];
    let (multisig_pda, multisig_account) =
        multisig_for(program_id, &dwallet, threshold, &members, tx_index);
    Fixture {
        dwallet,
        dwallet_program,
        owner,
        members,
        multisig_pda,
        multisig_account,
    }
}

fn multisig_creation_accounts(
    fx: &Fixture,
    multisig: Pubkey,
    owner: Pubkey,
    payer: Pubkey,
) -> Vec<(Pubkey, Account)> {
    vec![
        (multisig, empty_account()),
        (fx.dwallet, dwallet_account(&fx.dwallet_program, &fx.owner)),
        (fx.dwallet_program, executable_program_account()),
        (owner, funded_account()),
        (payer, funded_account()),
        (SYSTEM_PROGRAM_ID, system_program_account()),
    ]
}

// ===================================================================
// create_multisig tests
// ===================================================================

#[test]
fn test_create_multisig_success() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 2, 0);
    let payer = Pubkey::new_unique();

    let ix = build_create_multisig_ix(
        &program_id,
        &fx.multisig_pda,
        &fx.dwallet,
        &fx.dwallet_program,
        &fx.owner,
        &payer,
        2,
        &fx.members,
    );
    let result = mollusk.process_instruction(
        &ix,
        &multisig_creation_accounts(&fx, fx.multisig_pda, fx.owner, payer),
    );
    assert_success(&result);

    let ms_data = &result.resulting_accounts[0].1.data;
    assert_eq!(ms_data.len(), MULTISIG_LEN);
    assert_eq!(ms_data[0], MULTISIG_DISCRIMINATOR);
    assert_eq!(ms_data[1], 1); // version
    assert_eq!(read_pubkey(ms_data, MS_DWALLET), fx.dwallet);
    assert_eq!(read_u16(ms_data, MS_THRESHOLD), 2);
    assert_eq!(read_u16(ms_data, MS_MEMBER_COUNT), 3);
    assert_eq!(read_u32(ms_data, MS_TX_INDEX), 0);
    let (_, expected_bump) =
        Pubkey::find_program_address(&[b"multisig", fx.dwallet.as_ref()], &program_id);
    assert_eq!(ms_data[MS_BUMP], expected_bump);
    for (index, member) in fx.members.iter().enumerate() {
        assert_eq!(read_pubkey(ms_data, MS_MEMBERS + index * 32), *member);
    }
}

#[test]
fn test_create_multisig_rejects_non_owner() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 2, 0);
    let payer = Pubkey::new_unique();
    let stranger = Pubkey::new_unique();

    let ix = build_create_multisig_ix(
        &program_id,
        &fx.multisig_pda,
        &fx.dwallet,
        &fx.dwallet_program,
        &stranger,
        &payer,
        2,
        &fx.members,
    );
    let result = mollusk.process_instruction(
        &ix,
        &multisig_creation_accounts(&fx, fx.multisig_pda, stranger, payer),
    );
    assert_custom_error(&result, ERR_NOT_DWALLET_OWNER);
}

#[test]
fn test_create_multisig_rejects_dwallet_not_owned_by_dwallet_program() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 2, 0);
    let payer = Pubkey::new_unique();
    let impostor_owner = Pubkey::new_unique();

    let ix = build_create_multisig_ix(
        &program_id,
        &fx.multisig_pda,
        &fx.dwallet,
        &fx.dwallet_program,
        &fx.owner,
        &payer,
        2,
        &fx.members,
    );
    let mut accounts = multisig_creation_accounts(&fx, fx.multisig_pda, fx.owner, payer);
    accounts[1] = (fx.dwallet, dwallet_account(&impostor_owner, &fx.owner));
    let result = mollusk.process_instruction(&ix, &accounts);
    assert_custom_error(&result, ERR_INVALID_DWALLET_ACCOUNT);
}

#[test]
fn test_create_multisig_zero_threshold_fails() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 2, 0);
    let payer = Pubkey::new_unique();

    let ix = build_create_multisig_ix(
        &program_id,
        &fx.multisig_pda,
        &fx.dwallet,
        &fx.dwallet_program,
        &fx.owner,
        &payer,
        0,
        &fx.members,
    );
    let result = mollusk.process_instruction(
        &ix,
        &multisig_creation_accounts(&fx, fx.multisig_pda, fx.owner, payer),
    );
    assert_custom_error(&result, ERR_INVALID_THRESHOLD);
}

#[test]
fn test_create_multisig_threshold_exceeds_members_fails() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 2, 0);
    let payer = Pubkey::new_unique();

    let ix = build_create_multisig_ix(
        &program_id,
        &fx.multisig_pda,
        &fx.dwallet,
        &fx.dwallet_program,
        &fx.owner,
        &payer,
        4, // > 3 members
        &fx.members,
    );
    let result = mollusk.process_instruction(
        &ix,
        &multisig_creation_accounts(&fx, fx.multisig_pda, fx.owner, payer),
    );
    assert_custom_error(&result, ERR_INVALID_THRESHOLD);
}

#[test]
fn test_create_multisig_rejects_duplicate_member() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 2, 0);
    let payer = Pubkey::new_unique();
    let members = vec![fx.members[0], fx.members[1], fx.members[0]];

    let ix = build_create_multisig_ix(
        &program_id,
        &fx.multisig_pda,
        &fx.dwallet,
        &fx.dwallet_program,
        &fx.owner,
        &payer,
        2,
        &members,
    );
    let result = mollusk.process_instruction(
        &ix,
        &multisig_creation_accounts(&fx, fx.multisig_pda, fx.owner, payer),
    );
    assert_custom_error(&result, ERR_DUPLICATE_MEMBER);
}

#[test]
fn test_create_multisig_rejects_non_canonical_address() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 2, 0);
    let payer = Pubkey::new_unique();
    let wrong_multisig = Pubkey::new_unique();

    let ix = build_create_multisig_ix(
        &program_id,
        &wrong_multisig,
        &fx.dwallet,
        &fx.dwallet_program,
        &fx.owner,
        &payer,
        2,
        &fx.members,
    );
    let result = mollusk.process_instruction(
        &ix,
        &multisig_creation_accounts(&fx, wrong_multisig, fx.owner, payer),
    );
    assert_custom_error(&result, ERR_INVALID_MULTISIG);
}

// ===================================================================
// create_transaction tests
// ===================================================================

#[test]
fn test_create_transaction_success() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 2, 5);
    let proposer = fx.members[0];
    let payer = Pubkey::new_unique();
    let tx_index: u32 = 5;
    let (tx_pda, tx_bump) = Pubkey::find_program_address(
        &[
            b"transaction",
            fx.multisig_pda.as_ref(),
            &tx_index.to_le_bytes(),
        ],
        &program_id,
    );
    let message_hash = [0x42u8; 32];
    let user_pubkey = [0xAAu8; 32];
    let future_sign = true;
    let message_data = b"hello multisig";

    let ix = build_create_transaction_ix(
        &program_id,
        &fx.multisig_pda,
        &tx_pda,
        &proposer,
        &payer,
        message_hash,
        user_pubkey,
        0,
        canonical_voucher_bump(&program_id, &tx_pda),
        future_sign,
        tx_bump,
        message_data,
    );
    let result = mollusk.process_instruction(
        &ix,
        &[
            (fx.multisig_pda, fx.multisig_account.clone()),
            (tx_pda, empty_account()),
            (proposer, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );
    assert_success(&result);

    let ms_data = &result.resulting_accounts[0].1.data;
    assert_eq!(read_u32(ms_data, MS_TX_INDEX), 6, "tx_index incremented");

    let tx_data = &result.resulting_accounts[1].1.data;
    assert_eq!(tx_data.len(), TRANSACTION_LEN);
    assert_eq!(tx_data[0], TRANSACTION_DISCRIMINATOR);
    assert_eq!(read_pubkey(tx_data, TX_MULTISIG), fx.multisig_pda);
    assert_eq!(read_u32(tx_data, TX_INDEX), tx_index);
    assert_eq!(read_pubkey(tx_data, TX_PROPOSER), proposer);
    assert_eq!(
        &tx_data[TX_MESSAGE_HASH..TX_MESSAGE_HASH + 32],
        &message_hash
    );
    assert_eq!(&tx_data[TX_USER_PUBKEY..TX_USER_PUBKEY + 32], &user_pubkey);
    assert_eq!(read_u16(tx_data, TX_APPROVAL_COUNT), 0);
    assert_eq!(read_u16(tx_data, TX_REJECTION_COUNT), 0);
    assert_eq!(tx_data[TX_STATUS], STATUS_ACTIVE);
    assert_eq!(
        tx_data[TX_SIGNATURE_VOUCHER_BUMP],
        canonical_voucher_bump(&program_id, &tx_pda)
    );
    assert_eq!(
        tx_data[TX_FUTURE_SIGN], 1,
        "the transaction is a future sign"
    );
    assert_eq!(tx_data[TX_BUMP], tx_bump);
    assert_eq!(
        read_u16(tx_data, TX_MESSAGE_DATA_LEN),
        message_data.len() as u16
    );
    assert_eq!(
        &tx_data[TX_MESSAGE_DATA..TX_MESSAGE_DATA + message_data.len()],
        message_data
    );
}

#[test]
fn test_create_transaction_rejects_a_future_sign_flag_other_than_0_or_1() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 2, 0);
    let proposer = fx.members[0];
    let payer = Pubkey::new_unique();
    let (tx_pda, tx_bump) = Pubkey::find_program_address(
        &[
            b"transaction",
            fx.multisig_pda.as_ref(),
            &0u32.to_le_bytes(),
        ],
        &program_id,
    );
    let mut ix = build_create_transaction_ix(
        &program_id,
        &fx.multisig_pda,
        &tx_pda,
        &proposer,
        &payer,
        [0x42u8; 32],
        [0u8; 32],
        0,
        canonical_voucher_bump(&program_id, &tx_pda),
        false,
        tx_bump,
        b"",
    );
    // The flag follows the discriminator, the two keys, the scheme and the
    // voucher bump.
    ix.data[1 + 32 + 32 + 2 + 1] = 2;
    let result = mollusk.process_instruction(
        &ix,
        &[
            (fx.multisig_pda, fx.multisig_account.clone()),
            (tx_pda, empty_account()),
            (proposer, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );
    match &result.program_result {
        ProgramResult::Failure(err) => assert_eq!(*err, ProgramError::InvalidInstructionData),
        other => panic!("expected InvalidInstructionData, got {other:?}"),
    }
}

#[test]
fn test_create_transaction_non_member_fails() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 2, 0);
    let stranger = Pubkey::new_unique();
    let payer = Pubkey::new_unique();
    let (tx_pda, tx_bump) = Pubkey::find_program_address(
        &[
            b"transaction",
            fx.multisig_pda.as_ref(),
            &0u32.to_le_bytes(),
        ],
        &program_id,
    );

    let ix = build_create_transaction_ix(
        &program_id,
        &fx.multisig_pda,
        &tx_pda,
        &stranger,
        &payer,
        [0x42u8; 32],
        [0u8; 32],
        0,
        canonical_voucher_bump(&program_id, &tx_pda),
        false,
        tx_bump,
        b"",
    );
    let result = mollusk.process_instruction(
        &ix,
        &[
            (fx.multisig_pda, fx.multisig_account.clone()),
            (tx_pda, empty_account()),
            (stranger, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );
    assert_custom_error(&result, ERR_NOT_A_MEMBER);
}

#[test]
fn test_create_transaction_rejects_forged_multisig_account() {
    let (mollusk, program_id) = setup();
    // Multisig-shaped, program-owned data at an address that is not the
    // multisig PDA of the dWallet it names.
    let fx = fixture(&program_id, 1, 0);
    let forged_multisig = Pubkey::new_unique();
    let forged_data = build_multisig_data(&fx.dwallet, 1, &fx.members, 0, 255);
    let payer = Pubkey::new_unique();
    let (tx_pda, tx_bump) = Pubkey::find_program_address(
        &[
            b"transaction",
            forged_multisig.as_ref(),
            &0u32.to_le_bytes(),
        ],
        &program_id,
    );

    let ix = build_create_transaction_ix(
        &program_id,
        &forged_multisig,
        &tx_pda,
        &fx.members[0],
        &payer,
        [0x42u8; 32],
        [0u8; 32],
        0,
        canonical_voucher_bump(&program_id, &tx_pda),
        false,
        tx_bump,
        b"",
    );
    let result = mollusk.process_instruction(
        &ix,
        &[
            (forged_multisig, program_account(&program_id, forged_data)),
            (tx_pda, empty_account()),
            (fx.members[0], funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );
    assert_custom_error(&result, ERR_INVALID_MULTISIG);
}

// ===================================================================
// approve tests
// ===================================================================

#[test]
fn test_approve_success() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 3, 1);
    let member = fx.members[0];
    let payer = Pubkey::new_unique();
    let (tx_pda, tx_account) = transaction_for(
        &program_id,
        &fx.multisig_pda,
        0,
        &member,
        false,
        0,
        0,
        STATUS_ACTIVE,
    );
    let (ar_pda, ar_bump) = Pubkey::find_program_address(
        &[b"approval", tx_pda.as_ref(), member.as_ref()],
        &program_id,
    );

    let ix = build_approve_ix(
        &program_id,
        &fx.multisig_pda,
        &tx_pda,
        &ar_pda,
        &member,
        &payer,
        0,
        ar_bump,
    );
    let result = mollusk.process_instruction(
        &ix,
        &[
            (fx.multisig_pda, fx.multisig_account.clone()),
            (tx_pda, tx_account),
            (ar_pda, empty_account()),
            (member, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );
    assert_success(&result);

    let ar_data = &result.resulting_accounts[2].1.data;
    assert_eq!(ar_data.len(), APPROVAL_RECORD_LEN);
    assert_eq!(ar_data[0], APPROVAL_RECORD_DISCRIMINATOR);
    assert_eq!(read_pubkey(ar_data, AR_MEMBER), member);
    assert_eq!(read_pubkey(ar_data, AR_TRANSACTION), tx_pda);
    assert_eq!(ar_data[AR_APPROVED], 1);
    assert_eq!(ar_data[AR_BUMP], ar_bump);

    let tx_result = &result.resulting_accounts[1].1.data;
    assert_eq!(read_u16(tx_result, TX_APPROVAL_COUNT), 1);
    assert_eq!(tx_result[TX_STATUS], STATUS_ACTIVE); // threshold not reached
}

#[test]
fn test_approve_double_vote_fails() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 3, 1);
    let member = fx.members[0];
    let payer = Pubkey::new_unique();
    let (tx_pda, tx_account) = transaction_for(
        &program_id,
        &fx.multisig_pda,
        0,
        &member,
        false,
        1,
        0,
        STATUS_ACTIVE,
    );
    let (ar_pda, ar_bump) = Pubkey::find_program_address(
        &[b"approval", tx_pda.as_ref(), member.as_ref()],
        &program_id,
    );
    // Pre-existing ApprovalRecord (member already voted).
    let mut existing = vec![0u8; APPROVAL_RECORD_LEN];
    existing[0] = APPROVAL_RECORD_DISCRIMINATOR;
    existing[1] = 1;
    existing[AR_MEMBER..AR_MEMBER + 32].copy_from_slice(member.as_ref());
    existing[AR_TRANSACTION..AR_TRANSACTION + 32].copy_from_slice(tx_pda.as_ref());
    existing[AR_APPROVED] = 1;
    existing[AR_BUMP] = ar_bump;

    let ix = build_approve_ix(
        &program_id,
        &fx.multisig_pda,
        &tx_pda,
        &ar_pda,
        &member,
        &payer,
        0,
        ar_bump,
    );
    let result = mollusk.process_instruction(
        &ix,
        &[
            (fx.multisig_pda, fx.multisig_account.clone()),
            (tx_pda, tx_account),
            (ar_pda, program_account(&program_id, existing)),
            (member, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );
    assert!(
        matches!(result.program_result, ProgramResult::Failure(_)),
        "double approve should fail (ApprovalRecord PDA already exists): {:?}",
        result.program_result
    );
}

#[test]
fn test_approve_non_member_fails() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 3, 1);
    let stranger = Pubkey::new_unique();
    let payer = Pubkey::new_unique();
    let (tx_pda, tx_account) = transaction_for(
        &program_id,
        &fx.multisig_pda,
        0,
        &fx.members[0],
        false,
        0,
        0,
        STATUS_ACTIVE,
    );
    let (ar_pda, ar_bump) = Pubkey::find_program_address(
        &[b"approval", tx_pda.as_ref(), stranger.as_ref()],
        &program_id,
    );

    let ix = build_approve_ix(
        &program_id,
        &fx.multisig_pda,
        &tx_pda,
        &ar_pda,
        &stranger,
        &payer,
        0,
        ar_bump,
    );
    let result = mollusk.process_instruction(
        &ix,
        &[
            (fx.multisig_pda, fx.multisig_account.clone()),
            (tx_pda, tx_account),
            (ar_pda, empty_account()),
            (stranger, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );
    assert_custom_error(&result, ERR_NOT_A_MEMBER);
}

#[test]
fn test_approve_rejects_transaction_of_another_multisig() {
    let (mollusk, program_id) = setup();
    let victim = fixture(&program_id, 3, 1);
    let attacker = fixture(&program_id, 1, 1);
    let payer = Pubkey::new_unique();
    // Victim's transaction, presented with the attacker's multisig (where the
    // attacker is a member).
    let (tx_pda, tx_account) = transaction_for(
        &program_id,
        &victim.multisig_pda,
        0,
        &victim.members[0],
        false,
        0,
        0,
        STATUS_ACTIVE,
    );
    let member = attacker.members[0];
    let (ar_pda, ar_bump) = Pubkey::find_program_address(
        &[b"approval", tx_pda.as_ref(), member.as_ref()],
        &program_id,
    );

    let ix = build_approve_ix(
        &program_id,
        &attacker.multisig_pda,
        &tx_pda,
        &ar_pda,
        &member,
        &payer,
        0,
        ar_bump,
    );
    let result = mollusk.process_instruction(
        &ix,
        &[
            (attacker.multisig_pda, attacker.multisig_account.clone()),
            (tx_pda, tx_account),
            (ar_pda, empty_account()),
            (member, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );
    assert_custom_error(&result, ERR_TRANSACTION_MISMATCH);
}

#[test]
fn test_approve_at_threshold_rejects_wrong_dwallet() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 1, 1);
    let member = fx.members[0];
    let payer = Pubkey::new_unique();
    let (tx_pda, tx_account) = transaction_for(
        &program_id,
        &fx.multisig_pda,
        0,
        &member,
        false,
        0,
        0,
        STATUS_ACTIVE,
    );
    let (ar_pda, ar_bump) = Pubkey::find_program_address(
        &[b"approval", tx_pda.as_ref(), member.as_ref()],
        &program_id,
    );
    // Threshold path: pass a different dWallet than the multisig's for the CPI.
    let cpi = CpiAccounts {
        coordinator: Pubkey::new_unique(),
        signature_voucher: Pubkey::new_unique(),
        dwallet: Pubkey::new_unique(),
        caller_program: Pubkey::new_unique(),
        cpi_authority: Pubkey::new_unique(),
        dwallet_program: Pubkey::new_unique(),
    };

    let ix = with_cpi_accounts(
        build_approve_ix(
            &program_id,
            &fx.multisig_pda,
            &tx_pda,
            &ar_pda,
            &member,
            &payer,
            0,
            ar_bump,
        ),
        &cpi,
    );
    let mut accounts = vec![
        (fx.multisig_pda, fx.multisig_account.clone()),
        (tx_pda, tx_account),
        (ar_pda, empty_account()),
        (member, funded_account()),
        (payer, funded_account()),
        (SYSTEM_PROGRAM_ID, system_program_account()),
    ];
    accounts.extend(cpi_fixture_accounts(&cpi));
    let result = mollusk.process_instruction(&ix, &accounts);
    assert_custom_error(&result, ERR_DWALLET_MISMATCH);
}

// ===================================================================
// reject tests
// ===================================================================

#[test]
fn test_reject_success() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 2, 1);
    let member = fx.members[1];
    let payer = Pubkey::new_unique();
    let (tx_pda, tx_account) = transaction_for(
        &program_id,
        &fx.multisig_pda,
        0,
        &fx.members[0],
        false,
        0,
        0,
        STATUS_ACTIVE,
    );
    let (ar_pda, ar_bump) = Pubkey::find_program_address(
        &[b"approval", tx_pda.as_ref(), member.as_ref()],
        &program_id,
    );

    let ix = build_reject_ix(
        &program_id,
        &fx.multisig_pda,
        &tx_pda,
        &ar_pda,
        &member,
        &payer,
        0,
        ar_bump,
    );
    let result = mollusk.process_instruction(
        &ix,
        &[
            (fx.multisig_pda, fx.multisig_account.clone()),
            (tx_pda, tx_account),
            (ar_pda, empty_account()),
            (member, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );
    assert_success(&result);

    let ar_data = &result.resulting_accounts[2].1.data;
    assert_eq!(read_pubkey(ar_data, AR_MEMBER), member);
    assert_eq!(ar_data[AR_APPROVED], 0);

    // 3 members, threshold 2 → rejection threshold 2; one rejection keeps it active.
    let tx_result = &result.resulting_accounts[1].1.data;
    assert_eq!(read_u16(tx_result, TX_REJECTION_COUNT), 1);
    assert_eq!(tx_result[TX_STATUS], STATUS_ACTIVE);
}

#[test]
fn test_reject_threshold_marks_rejected() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 2, 1);
    let member = fx.members[2];
    let payer = Pubkey::new_unique();
    // Already one rejection; the second reaches the rejection threshold (3-2+1 = 2).
    let (tx_pda, tx_account) = transaction_for(
        &program_id,
        &fx.multisig_pda,
        0,
        &fx.members[0],
        false,
        0,
        1,
        STATUS_ACTIVE,
    );
    let (ar_pda, ar_bump) = Pubkey::find_program_address(
        &[b"approval", tx_pda.as_ref(), member.as_ref()],
        &program_id,
    );

    let ix = build_reject_ix(
        &program_id,
        &fx.multisig_pda,
        &tx_pda,
        &ar_pda,
        &member,
        &payer,
        0,
        ar_bump,
    );
    let result = mollusk.process_instruction(
        &ix,
        &[
            (fx.multisig_pda, fx.multisig_account.clone()),
            (tx_pda, tx_account),
            (ar_pda, empty_account()),
            (member, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );
    assert_success(&result);

    let tx_result = &result.resulting_accounts[1].1.data;
    assert_eq!(read_u16(tx_result, TX_REJECTION_COUNT), 2);
    assert_eq!(tx_result[TX_STATUS], STATUS_REJECTED);
}

#[test]
fn test_reject_non_member_fails() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 2, 1);
    let stranger = Pubkey::new_unique();
    let payer = Pubkey::new_unique();
    let (tx_pda, tx_account) = transaction_for(
        &program_id,
        &fx.multisig_pda,
        0,
        &fx.members[0],
        false,
        0,
        0,
        STATUS_ACTIVE,
    );
    let (ar_pda, ar_bump) = Pubkey::find_program_address(
        &[b"approval", tx_pda.as_ref(), stranger.as_ref()],
        &program_id,
    );

    let ix = build_reject_ix(
        &program_id,
        &fx.multisig_pda,
        &tx_pda,
        &ar_pda,
        &stranger,
        &payer,
        0,
        ar_bump,
    );
    let result = mollusk.process_instruction(
        &ix,
        &[
            (fx.multisig_pda, fx.multisig_account.clone()),
            (tx_pda, tx_account),
            (ar_pda, empty_account()),
            (stranger, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );
    assert_custom_error(&result, ERR_NOT_A_MEMBER);
}

#[test]
fn test_vote_on_closed_transaction_fails() {
    let (mollusk, program_id) = setup();
    let fx = fixture(&program_id, 2, 1);
    let member = fx.members[1];
    let payer = Pubkey::new_unique();
    let (tx_pda, tx_account) = transaction_for(
        &program_id,
        &fx.multisig_pda,
        0,
        &fx.members[0],
        false,
        2,
        0,
        STATUS_APPROVED,
    );
    let (ar_pda, ar_bump) = Pubkey::find_program_address(
        &[b"approval", tx_pda.as_ref(), member.as_ref()],
        &program_id,
    );

    let ix = build_approve_ix(
        &program_id,
        &fx.multisig_pda,
        &tx_pda,
        &ar_pda,
        &member,
        &payer,
        0,
        ar_bump,
    );
    let result = mollusk.process_instruction(
        &ix,
        &[
            (fx.multisig_pda, fx.multisig_account.clone()),
            (tx_pda, tx_account),
            (ar_pda, empty_account()),
            (member, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );
    assert_custom_error(&result, ERR_TRANSACTION_NOT_ACTIVE);
}
