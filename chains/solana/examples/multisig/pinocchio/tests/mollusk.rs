// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! Mollusk instruction-level tests for the ika multisig example.
//!
//! Tests create_multisig, create_transaction, approve, and reject in isolation.

use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;

const PROGRAM_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../../../target/deploy/ika_example_multisig"
);

/// System program ID (11111111111111111111111111111111).
const SYSTEM_PROGRAM_ID: Pubkey = Pubkey::new_from_array([0u8; 32]);

/// NativeLoader ID.
const NATIVE_LOADER_ID: Pubkey = Pubkey::new_from_array([
    0x05, 0x87, 0x84, 0xbf, 0x14, 0x8b, 0xa4, 0x28, 0x2f, 0xb0, 0x12, 0x57, 0x48, 0x88, 0xa9,
    0xf1, 0x53, 0xa0, 0x7d, 0xad, 0xf7, 0x65, 0xc0, 0x45, 0x5c, 0x9a, 0x97, 0x03, 0x80, 0x00,
    0x00, 0x00,
]);

// -- Discriminators --
const MULTISIG_DISCRIMINATOR: u8 = 1;
const TRANSACTION_DISCRIMINATOR: u8 = 2;
const APPROVAL_RECORD_DISCRIMINATOR: u8 = 3;

// -- Status values --
const STATUS_ACTIVE: u8 = 0;
const STATUS_APPROVED: u8 = 1;
const STATUS_REJECTED: u8 = 2;

// -- Account sizes --
const MULTISIG_LEN: usize = 395;
const TRANSACTION_LEN: usize = 432;
const APPROVAL_RECORD_LEN: usize = 68;

// -- Multisig offsets --
const MS_CREATE_KEY: usize = 2;
const MS_THRESHOLD: usize = 34;
const MS_MEMBER_COUNT: usize = 36;
const MS_TX_INDEX: usize = 38;
const MS_DWALLET: usize = 42;
const MS_BUMP: usize = 74;
const MS_MEMBERS: usize = 75;

// -- Transaction offsets --
const TX_MULTISIG: usize = 2;
const TX_INDEX: usize = 34;
const TX_PROPOSER: usize = 38;
const TX_MESSAGE_HASH: usize = 70;
const TX_USER_PUBKEY: usize = 102;
const TX_SIGNATURE_SCHEME: usize = 134;
const TX_APPROVAL_COUNT: usize = 135;
const TX_REJECTION_COUNT: usize = 137;
const TX_STATUS: usize = 139;
const TX_MSG_APPROVAL_BUMP: usize = 140;
const TX_PARTIAL_USER_SIG: usize = 141;
const TX_BUMP: usize = 173;
const TX_MESSAGE_DATA_LEN: usize = 174;
const TX_MESSAGE_DATA: usize = 176;

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

/// Build Multisig account data.
fn build_multisig_data(
    create_key: &[u8; 32],
    dwallet: &Pubkey,
    threshold: u16,
    members: &[Pubkey],
    tx_index: u32,
    bump: u8,
) -> Vec<u8> {
    let mut data = vec![0u8; MULTISIG_LEN];
    data[0] = MULTISIG_DISCRIMINATOR;
    data[1] = 1;
    data[MS_CREATE_KEY..MS_CREATE_KEY + 32].copy_from_slice(create_key);
    data[MS_THRESHOLD..MS_THRESHOLD + 2].copy_from_slice(&threshold.to_le_bytes());
    data[MS_MEMBER_COUNT..MS_MEMBER_COUNT + 2]
        .copy_from_slice(&(members.len() as u16).to_le_bytes());
    data[MS_TX_INDEX..MS_TX_INDEX + 4].copy_from_slice(&tx_index.to_le_bytes());
    data[MS_DWALLET..MS_DWALLET + 32].copy_from_slice(dwallet.as_ref());
    data[MS_BUMP] = bump;
    for (i, m) in members.iter().enumerate() {
        let offset = MS_MEMBERS + (i * 32);
        data[offset..offset + 32].copy_from_slice(m.as_ref());
    }
    data
}

/// Build Transaction account data.
fn build_transaction_data(
    multisig: &Pubkey,
    tx_index: u32,
    proposer: &Pubkey,
    message_hash: &[u8; 32],
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
    data[TX_SIGNATURE_SCHEME] = 0;
    data[TX_APPROVAL_COUNT..TX_APPROVAL_COUNT + 2]
        .copy_from_slice(&approval_count.to_le_bytes());
    data[TX_REJECTION_COUNT..TX_REJECTION_COUNT + 2]
        .copy_from_slice(&rejection_count.to_le_bytes());
    data[TX_STATUS] = status;
    data[TX_MSG_APPROVAL_BUMP] = 0;
    // partial_user_sig left zero
    data[TX_BUMP] = bump;
    data[TX_MESSAGE_DATA_LEN..TX_MESSAGE_DATA_LEN + 2].copy_from_slice(&0u16.to_le_bytes());
    data
}

/// Build a CreateMultisig instruction (disc=0).
fn build_create_multisig_ix(
    program_id: &Pubkey,
    multisig_pda: &Pubkey,
    creator: &Pubkey,
    payer: &Pubkey,
    create_key: [u8; 32],
    dwallet: &Pubkey,
    threshold: u16,
    members: &[Pubkey],
    bump: u8,
) -> Instruction {
    let member_count = members.len() as u16;
    let mut ix_data = Vec::with_capacity(1 + 69 + members.len() * 32);
    ix_data.push(0); // discriminator = CreateMultisig
    ix_data.extend_from_slice(&create_key);
    ix_data.extend_from_slice(dwallet.as_ref());
    ix_data.extend_from_slice(&threshold.to_le_bytes());
    ix_data.extend_from_slice(&member_count.to_le_bytes());
    ix_data.push(bump);
    for m in members {
        ix_data.extend_from_slice(m.as_ref());
    }

    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*multisig_pda, false),
            AccountMeta::new_readonly(*creator, true),
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
    signature_scheme: u8,
    message_approval_bump: u8,
    partial_user_sig: [u8; 32],
    tx_bump: u8,
    message_data: &[u8],
) -> Instruction {
    let message_data_len = message_data.len() as u16;
    let mut ix_data = Vec::with_capacity(1 + 101 + message_data.len());
    ix_data.push(1); // discriminator = CreateTransaction
    ix_data.extend_from_slice(&message_hash);
    ix_data.extend_from_slice(&user_pubkey);
    ix_data.push(signature_scheme);
    ix_data.push(message_approval_bump);
    ix_data.extend_from_slice(&partial_user_sig);
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

/// Build an Approve instruction (disc=2, non-quorum path).
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

fn read_u16(data: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(data[offset..offset + 2].try_into().unwrap())
}

fn read_u32(data: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(data[offset..offset + 4].try_into().unwrap())
}

fn read_pubkey(data: &[u8], offset: usize) -> Pubkey {
    Pubkey::new_from_array(data[offset..offset + 32].try_into().unwrap())
}

// ===================================================================
// create_multisig tests
// ===================================================================

#[test]
fn test_create_multisig_success() {
    let (mollusk, program_id) = setup();

    let creator = Pubkey::new_unique();
    let payer = Pubkey::new_unique();
    let dwallet_key = Pubkey::new_unique();
    let create_key = [0x01u8; 32];

    let member1 = Pubkey::new_unique();
    let member2 = Pubkey::new_unique();
    let member3 = Pubkey::new_unique();
    let members = vec![member1, member2, member3];

    let (multisig_pda, multisig_bump) =
        Pubkey::find_program_address(&[b"multisig", &create_key], &program_id);

    let ix = build_create_multisig_ix(
        &program_id,
        &multisig_pda,
        &creator,
        &payer,
        create_key,
        &dwallet_key,
        2, // threshold
        &members,
        multisig_bump,
    );

    let result = mollusk.process_instruction(
        &ix,
        &[
            (multisig_pda, empty_account()),
            (creator, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );

    assert!(
        result.program_result.is_ok(),
        "create_multisig should succeed: {:?}",
        result.program_result
    );

    let ms_data = &result.resulting_accounts[0].1.data;
    assert_eq!(ms_data.len(), MULTISIG_LEN);
    assert_eq!(ms_data[0], MULTISIG_DISCRIMINATOR);
    assert_eq!(ms_data[1], 1); // version
    assert_eq!(read_u16(ms_data, MS_THRESHOLD), 2);
    assert_eq!(read_u16(ms_data, MS_MEMBER_COUNT), 3);
    assert_eq!(read_u32(ms_data, MS_TX_INDEX), 0);
    assert_eq!(read_pubkey(ms_data, MS_DWALLET), dwallet_key);
    assert_eq!(read_pubkey(ms_data, MS_MEMBERS), member1);
    assert_eq!(read_pubkey(ms_data, MS_MEMBERS + 32), member2);
    assert_eq!(read_pubkey(ms_data, MS_MEMBERS + 64), member3);
}

#[test]
fn test_create_multisig_zero_threshold_fails() {
    let (mollusk, program_id) = setup();

    let creator = Pubkey::new_unique();
    let payer = Pubkey::new_unique();
    let create_key = [0x02u8; 32];
    let member = Pubkey::new_unique();

    let (multisig_pda, multisig_bump) =
        Pubkey::find_program_address(&[b"multisig", &create_key], &program_id);

    let ix = build_create_multisig_ix(
        &program_id,
        &multisig_pda,
        &creator,
        &payer,
        create_key,
        &Pubkey::new_unique(),
        0, // threshold = 0 (invalid)
        &[member],
        multisig_bump,
    );

    let result = mollusk.process_instruction(
        &ix,
        &[
            (multisig_pda, empty_account()),
            (creator, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );

    assert!(
        result.program_result.is_err(),
        "threshold=0 should fail"
    );
}

#[test]
fn test_create_multisig_threshold_exceeds_members_fails() {
    let (mollusk, program_id) = setup();

    let creator = Pubkey::new_unique();
    let payer = Pubkey::new_unique();
    let create_key = [0x03u8; 32];
    let member = Pubkey::new_unique();

    let (multisig_pda, multisig_bump) =
        Pubkey::find_program_address(&[b"multisig", &create_key], &program_id);

    let ix = build_create_multisig_ix(
        &program_id,
        &multisig_pda,
        &creator,
        &payer,
        create_key,
        &Pubkey::new_unique(),
        5, // threshold > member_count
        &[member],
        multisig_bump,
    );

    let result = mollusk.process_instruction(
        &ix,
        &[
            (multisig_pda, empty_account()),
            (creator, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );

    assert!(
        result.program_result.is_err(),
        "threshold > member_count should fail"
    );
}

// ===================================================================
// create_transaction tests
// ===================================================================

#[test]
fn test_create_transaction_success() {
    let (mollusk, program_id) = setup();

    let proposer = Pubkey::new_unique();
    let payer = Pubkey::new_unique();
    let dwallet_key = Pubkey::new_unique();
    let create_key = [0x10u8; 32];
    let message_hash = [0x42u8; 32];
    let user_pubkey = [0xAAu8; 32];
    let message_data = b"Transfer 100 USDC";

    let members = vec![proposer, Pubkey::new_unique(), Pubkey::new_unique()];

    let (multisig_pda, multisig_bump) =
        Pubkey::find_program_address(&[b"multisig", &create_key], &program_id);

    let multisig_data = build_multisig_data(
        &create_key,
        &dwallet_key,
        2,
        &members,
        0, // tx_index = 0
        multisig_bump,
    );

    let tx_index: u32 = 0;
    let (tx_pda, tx_bump) = Pubkey::find_program_address(
        &[b"transaction", multisig_pda.as_ref(), &tx_index.to_le_bytes()],
        &program_id,
    );

    let ix = build_create_transaction_ix(
        &program_id,
        &multisig_pda,
        &tx_pda,
        &proposer,
        &payer,
        message_hash,
        user_pubkey,
        0,         // signature_scheme
        0,         // message_approval_bump
        [0u8; 32], // no partial_user_sig
        tx_bump,
        message_data,
    );

    let result = mollusk.process_instruction(
        &ix,
        &[
            (multisig_pda, program_account(&program_id, multisig_data)),
            (tx_pda, empty_account()),
            (proposer, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );

    assert!(
        result.program_result.is_ok(),
        "create_transaction should succeed: {:?}",
        result.program_result
    );

    // Verify transaction data.
    let tx_data = &result.resulting_accounts[1].1.data;
    assert_eq!(tx_data.len(), TRANSACTION_LEN);
    assert_eq!(tx_data[0], TRANSACTION_DISCRIMINATOR);
    assert_eq!(read_pubkey(tx_data, TX_MULTISIG), multisig_pda);
    assert_eq!(read_u32(tx_data, TX_INDEX), 0);
    assert_eq!(read_pubkey(tx_data, TX_PROPOSER), proposer);
    assert_eq!(&tx_data[TX_MESSAGE_HASH..TX_MESSAGE_HASH + 32], &message_hash);
    assert_eq!(tx_data[TX_STATUS], STATUS_ACTIVE);
    assert_eq!(read_u16(tx_data, TX_APPROVAL_COUNT), 0);
    assert_eq!(read_u16(tx_data, TX_REJECTION_COUNT), 0);

    // Verify message data stored on-chain.
    let stored_len = read_u16(tx_data, TX_MESSAGE_DATA_LEN) as usize;
    assert_eq!(stored_len, message_data.len());
    assert_eq!(
        &tx_data[TX_MESSAGE_DATA..TX_MESSAGE_DATA + stored_len],
        message_data
    );

    // Verify multisig tx_index incremented.
    let ms_data = &result.resulting_accounts[0].1.data;
    assert_eq!(read_u32(ms_data, MS_TX_INDEX), 1);
}

#[test]
fn test_create_transaction_non_member_fails() {
    let (mollusk, program_id) = setup();

    let non_member = Pubkey::new_unique();
    let payer = Pubkey::new_unique();
    let create_key = [0x11u8; 32];

    let members = vec![Pubkey::new_unique(), Pubkey::new_unique()];

    let (multisig_pda, multisig_bump) =
        Pubkey::find_program_address(&[b"multisig", &create_key], &program_id);

    let multisig_data = build_multisig_data(
        &create_key,
        &Pubkey::new_unique(),
        2,
        &members,
        0,
        multisig_bump,
    );

    let tx_index: u32 = 0;
    let (tx_pda, tx_bump) = Pubkey::find_program_address(
        &[b"transaction", multisig_pda.as_ref(), &tx_index.to_le_bytes()],
        &program_id,
    );

    let ix = build_create_transaction_ix(
        &program_id,
        &multisig_pda,
        &tx_pda,
        &non_member,
        &payer,
        [0u8; 32],
        [0u8; 32],
        0,
        0,
        [0u8; 32],
        tx_bump,
        b"",
    );

    let result = mollusk.process_instruction(
        &ix,
        &[
            (multisig_pda, program_account(&program_id, multisig_data)),
            (tx_pda, empty_account()),
            (non_member, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );

    assert!(
        result.program_result.is_err(),
        "non-member should not create transaction"
    );
}

// ===================================================================
// approve tests
// ===================================================================

#[test]
fn test_approve_success() {
    let (mollusk, program_id) = setup();

    let member1 = Pubkey::new_unique();
    let member2 = Pubkey::new_unique();
    let member3 = Pubkey::new_unique();
    let payer = Pubkey::new_unique();
    let create_key = [0x20u8; 32];

    let members = vec![member1, member2, member3];

    let (multisig_pda, multisig_bump) =
        Pubkey::find_program_address(&[b"multisig", &create_key], &program_id);

    let multisig_data = build_multisig_data(
        &create_key,
        &Pubkey::new_unique(),
        3, // threshold = 3 (high, no quorum this test)
        &members,
        1,
        multisig_bump,
    );

    let tx_index: u32 = 0;
    let (tx_pda, tx_bump) = Pubkey::find_program_address(
        &[b"transaction", multisig_pda.as_ref(), &tx_index.to_le_bytes()],
        &program_id,
    );

    let tx_data = build_transaction_data(
        &multisig_pda,
        tx_index,
        &member1,
        &[0x42u8; 32],
        0, // no approvals yet
        0,
        STATUS_ACTIVE,
        tx_bump,
    );

    let (ar_pda, ar_bump) = Pubkey::find_program_address(
        &[b"approval", tx_pda.as_ref(), member1.as_ref()],
        &program_id,
    );

    let ix = build_approve_ix(
        &program_id,
        &multisig_pda,
        &tx_pda,
        &ar_pda,
        &member1,
        &payer,
        tx_index,
        ar_bump,
    );

    let result = mollusk.process_instruction(
        &ix,
        &[
            (multisig_pda, program_account(&program_id, multisig_data)),
            (tx_pda, program_account(&program_id, tx_data)),
            (ar_pda, empty_account()),
            (member1, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );

    assert!(
        result.program_result.is_ok(),
        "approve should succeed: {:?}",
        result.program_result
    );

    // Check ApprovalRecord.
    let ar_data = &result.resulting_accounts[2].1.data;
    assert_eq!(ar_data.len(), APPROVAL_RECORD_LEN);
    assert_eq!(ar_data[0], APPROVAL_RECORD_DISCRIMINATOR);
    assert_eq!(read_pubkey(ar_data, AR_MEMBER), member1);
    assert_eq!(ar_data[AR_APPROVED], 1);

    // Check approval count incremented.
    let tx_result = &result.resulting_accounts[1].1.data;
    assert_eq!(read_u16(tx_result, TX_APPROVAL_COUNT), 1);
    assert_eq!(tx_result[TX_STATUS], STATUS_ACTIVE); // threshold not reached
}

#[test]
fn test_approve_double_vote_fails() {
    let (mollusk, program_id) = setup();

    let member1 = Pubkey::new_unique();
    let payer = Pubkey::new_unique();
    let create_key = [0x21u8; 32];
    let members = vec![member1, Pubkey::new_unique()];

    let (multisig_pda, multisig_bump) =
        Pubkey::find_program_address(&[b"multisig", &create_key], &program_id);

    let multisig_data = build_multisig_data(
        &create_key,
        &Pubkey::new_unique(),
        2,
        &members,
        1,
        multisig_bump,
    );

    let tx_index: u32 = 0;
    let (tx_pda, tx_bump) = Pubkey::find_program_address(
        &[b"transaction", multisig_pda.as_ref(), &tx_index.to_le_bytes()],
        &program_id,
    );

    let tx_data = build_transaction_data(
        &multisig_pda,
        tx_index,
        &member1,
        &[0x42u8; 32],
        1, // already has 1 approval
        0,
        STATUS_ACTIVE,
        tx_bump,
    );

    let (ar_pda, ar_bump) = Pubkey::find_program_address(
        &[b"approval", tx_pda.as_ref(), member1.as_ref()],
        &program_id,
    );

    // Pre-populate approval record (already voted).
    let mut existing_ar = vec![0u8; APPROVAL_RECORD_LEN];
    existing_ar[0] = APPROVAL_RECORD_DISCRIMINATOR;
    existing_ar[1] = 1;
    existing_ar[AR_MEMBER..AR_MEMBER + 32].copy_from_slice(member1.as_ref());
    existing_ar[AR_APPROVED] = 1;
    existing_ar[AR_BUMP] = ar_bump;

    let ix = build_approve_ix(
        &program_id,
        &multisig_pda,
        &tx_pda,
        &ar_pda,
        &member1,
        &payer,
        tx_index,
        ar_bump,
    );

    let result = mollusk.process_instruction(
        &ix,
        &[
            (multisig_pda, program_account(&program_id, multisig_data)),
            (tx_pda, program_account(&program_id, tx_data)),
            (ar_pda, program_account(&program_id, existing_ar)),
            (member1, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );

    assert!(
        result.program_result.is_err(),
        "double approval should fail (ApprovalRecord already exists)"
    );
}

#[test]
fn test_approve_non_member_fails() {
    let (mollusk, program_id) = setup();

    let non_member = Pubkey::new_unique();
    let payer = Pubkey::new_unique();
    let create_key = [0x22u8; 32];
    let members = vec![Pubkey::new_unique(), Pubkey::new_unique()];

    let (multisig_pda, multisig_bump) =
        Pubkey::find_program_address(&[b"multisig", &create_key], &program_id);

    let multisig_data = build_multisig_data(
        &create_key,
        &Pubkey::new_unique(),
        2,
        &members,
        1,
        multisig_bump,
    );

    let tx_index: u32 = 0;
    let (tx_pda, tx_bump) = Pubkey::find_program_address(
        &[b"transaction", multisig_pda.as_ref(), &tx_index.to_le_bytes()],
        &program_id,
    );

    let tx_data = build_transaction_data(
        &multisig_pda,
        tx_index,
        &members[0],
        &[0x42u8; 32],
        0,
        0,
        STATUS_ACTIVE,
        tx_bump,
    );

    let (ar_pda, ar_bump) = Pubkey::find_program_address(
        &[b"approval", tx_pda.as_ref(), non_member.as_ref()],
        &program_id,
    );

    let ix = build_approve_ix(
        &program_id,
        &multisig_pda,
        &tx_pda,
        &ar_pda,
        &non_member,
        &payer,
        tx_index,
        ar_bump,
    );

    let result = mollusk.process_instruction(
        &ix,
        &[
            (multisig_pda, program_account(&program_id, multisig_data)),
            (tx_pda, program_account(&program_id, tx_data)),
            (ar_pda, empty_account()),
            (non_member, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );

    assert!(
        result.program_result.is_err(),
        "non-member should not be able to approve"
    );
}

// ===================================================================
// reject tests
// ===================================================================

#[test]
fn test_reject_success() {
    let (mollusk, program_id) = setup();

    let member1 = Pubkey::new_unique();
    let member2 = Pubkey::new_unique();
    let member3 = Pubkey::new_unique();
    let payer = Pubkey::new_unique();
    let create_key = [0x30u8; 32];

    let members = vec![member1, member2, member3];

    let (multisig_pda, multisig_bump) =
        Pubkey::find_program_address(&[b"multisig", &create_key], &program_id);

    let multisig_data = build_multisig_data(
        &create_key,
        &Pubkey::new_unique(),
        2, // threshold=2, so rejection_threshold = 3-2+1 = 2
        &members,
        1,
        multisig_bump,
    );

    let tx_index: u32 = 0;
    let (tx_pda, tx_bump) = Pubkey::find_program_address(
        &[b"transaction", multisig_pda.as_ref(), &tx_index.to_le_bytes()],
        &program_id,
    );

    let tx_data = build_transaction_data(
        &multisig_pda,
        tx_index,
        &member1,
        &[0x42u8; 32],
        0,
        0,
        STATUS_ACTIVE,
        tx_bump,
    );

    let (ar_pda, ar_bump) = Pubkey::find_program_address(
        &[b"approval", tx_pda.as_ref(), member2.as_ref()],
        &program_id,
    );

    let ix = build_reject_ix(
        &program_id,
        &multisig_pda,
        &tx_pda,
        &ar_pda,
        &member2,
        &payer,
        tx_index,
        ar_bump,
    );

    let result = mollusk.process_instruction(
        &ix,
        &[
            (multisig_pda, program_account(&program_id, multisig_data)),
            (tx_pda, program_account(&program_id, tx_data)),
            (ar_pda, empty_account()),
            (member2, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );

    assert!(
        result.program_result.is_ok(),
        "reject should succeed: {:?}",
        result.program_result
    );

    // Check rejection count.
    let tx_result = &result.resulting_accounts[1].1.data;
    assert_eq!(read_u16(tx_result, TX_REJECTION_COUNT), 1);
    assert_eq!(tx_result[TX_STATUS], STATUS_ACTIVE); // not enough to reject yet

    // Check ApprovalRecord marked as rejection.
    let ar_data = &result.resulting_accounts[2].1.data;
    assert_eq!(ar_data[AR_APPROVED], 0); // rejected
}

#[test]
fn test_reject_threshold_marks_rejected() {
    let (mollusk, program_id) = setup();

    let member1 = Pubkey::new_unique();
    let member2 = Pubkey::new_unique();
    let member3 = Pubkey::new_unique();
    let payer = Pubkey::new_unique();
    let create_key = [0x31u8; 32];

    let members = vec![member1, member2, member3];

    let (multisig_pda, multisig_bump) =
        Pubkey::find_program_address(&[b"multisig", &create_key], &program_id);

    // threshold=2, rejection_threshold = 3-2+1 = 2
    let multisig_data = build_multisig_data(
        &create_key,
        &Pubkey::new_unique(),
        2,
        &members,
        1,
        multisig_bump,
    );

    let tx_index: u32 = 0;
    let (tx_pda, tx_bump) = Pubkey::find_program_address(
        &[b"transaction", multisig_pda.as_ref(), &tx_index.to_le_bytes()],
        &program_id,
    );

    // Already has 1 rejection, this will be the 2nd.
    let tx_data = build_transaction_data(
        &multisig_pda,
        tx_index,
        &member1,
        &[0x42u8; 32],
        0,
        1, // 1 existing rejection
        STATUS_ACTIVE,
        tx_bump,
    );

    let (ar_pda, ar_bump) = Pubkey::find_program_address(
        &[b"approval", tx_pda.as_ref(), member3.as_ref()],
        &program_id,
    );

    let ix = build_reject_ix(
        &program_id,
        &multisig_pda,
        &tx_pda,
        &ar_pda,
        &member3,
        &payer,
        tx_index,
        ar_bump,
    );

    let result = mollusk.process_instruction(
        &ix,
        &[
            (multisig_pda, program_account(&program_id, multisig_data)),
            (tx_pda, program_account(&program_id, tx_data)),
            (ar_pda, empty_account()),
            (member3, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );

    assert!(
        result.program_result.is_ok(),
        "second reject should succeed: {:?}",
        result.program_result
    );

    let tx_result = &result.resulting_accounts[1].1.data;
    assert_eq!(read_u16(tx_result, TX_REJECTION_COUNT), 2);
    assert_eq!(tx_result[TX_STATUS], STATUS_REJECTED);
}

#[test]
fn test_vote_on_closed_transaction_fails() {
    let (mollusk, program_id) = setup();

    let member1 = Pubkey::new_unique();
    let payer = Pubkey::new_unique();
    let create_key = [0x32u8; 32];
    let members = vec![member1, Pubkey::new_unique()];

    let (multisig_pda, multisig_bump) =
        Pubkey::find_program_address(&[b"multisig", &create_key], &program_id);

    let multisig_data = build_multisig_data(
        &create_key,
        &Pubkey::new_unique(),
        2,
        &members,
        1,
        multisig_bump,
    );

    let tx_index: u32 = 0;
    let (tx_pda, tx_bump) = Pubkey::find_program_address(
        &[b"transaction", multisig_pda.as_ref(), &tx_index.to_le_bytes()],
        &program_id,
    );

    // Transaction already approved.
    let tx_data = build_transaction_data(
        &multisig_pda,
        tx_index,
        &member1,
        &[0x42u8; 32],
        2,
        0,
        STATUS_APPROVED,
        tx_bump,
    );

    let (ar_pda, ar_bump) = Pubkey::find_program_address(
        &[b"approval", tx_pda.as_ref(), member1.as_ref()],
        &program_id,
    );

    let ix = build_approve_ix(
        &program_id,
        &multisig_pda,
        &tx_pda,
        &ar_pda,
        &member1,
        &payer,
        tx_index,
        ar_bump,
    );

    let result = mollusk.process_instruction(
        &ix,
        &[
            (multisig_pda, program_account(&program_id, multisig_data)),
            (tx_pda, program_account(&program_id, tx_data)),
            (ar_pda, empty_account()),
            (member1, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );

    assert!(
        result.program_result.is_err(),
        "voting on approved transaction should fail"
    );
}
