// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! LiteSVM end-to-end tests for the Anchor multisig example.
//!
//! Runs against the real dWallet program: create multisig -> transfer the
//! dWallet to the CPI authority -> propose -> approve to threshold ->
//! `issue_signature_voucher` (or `issue_future_signature_voucher`) CPIs — plus the attacks the
//! bindings exist to stop: an outsider taking over a governed dWallet's
//! multisig, and one multisig's approval being executed against another
//! multisig's dWallet.
//!
//! Uses Anchor instruction serialization (8-byte discriminator + borsh args).

use ika_dwallet_litesvm_test::*;
use solana_keypair::Keypair;

/// Path to the compiled SBF binary for the Anchor multisig example.
const MULTISIG_PROGRAM_BINARY: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../target/deploy/ika_example_multisig_anchor.so"
);

// -- Anchor instruction discriminators (sha256("global:<fn>")[..8]) --
const CREATE_MULTISIG_DISC: [u8; 8] = [148, 146, 240, 10, 226, 215, 167, 174];
const CREATE_TRANSACTION_DISC: [u8; 8] = [227, 193, 53, 239, 55, 126, 112, 105];
const APPROVE_DISC: [u8; 8] = [69, 74, 217, 36, 115, 117, 97, 76];

// -- Anchor account discriminators (sha256("account:<Name>")[..8]) --
const MULTISIG_DISC: [u8; 8] = [224, 116, 121, 186, 68, 161, 79, 236];

// -- Account layouts (8-byte discriminator + borsh fields) --
// Multisig: 8 + dwallet(32) + threshold(2) + member_count(2) + tx_index(4) + bump(1) + members(320) = 369
const MULTISIG_LEN: usize = 369;
const MS_DWALLET: usize = 8;
// MultisigTransaction: 8 + multisig(32) + tx_index(4) + proposer(32) + message_hash(32) +
//   user_pubkey(32) + scheme(2) + approval_count(2) + rejection_count(2) + status(1) + ...
const TX_APPROVAL_COUNT: usize = 142;
const TX_STATUS: usize = 146;
const STATUS_ACTIVE: u8 = 0;
const STATUS_APPROVED: u8 = 1;

// -- Anchor error codes (`MultisigError`, 6000 + index) --
const ERR_NOT_A_MEMBER: u32 = 6003;
const ERR_DWALLET_MISMATCH: u32 = 6008;
const ERR_NOT_DWALLET_OWNER: u32 = 6009;

// ===================================================================
// Instruction builders
// ===================================================================

/// Anchor programs must be deployed at their `declare_id!` address.
fn deploy_multisig(ctx: &mut DWalletTestContext) -> Pubkey {
    let program_id: Pubkey = "7wj8oHHfEM8wxQ9RYZz4rwp4HArDT3RLMiMtzPfabNzD"
        .parse()
        .unwrap();
    ctx.deploy_program_at(&program_id, MULTISIG_PROGRAM_BINARY);
    program_id
}

fn build_create_multisig_ix(
    program_id: &Pubkey,
    multisig: &Pubkey,
    dwallet: &Pubkey,
    dwallet_program: &Pubkey,
    owner: &Pubkey,
    payer: &Pubkey,
    threshold: u16,
    members: &[Pubkey],
) -> Instruction {
    // borsh: disc(8) + threshold(2) + members vec (u32 len + 32*n)
    let mut ix_data = Vec::with_capacity(14);
    ix_data.extend_from_slice(&CREATE_MULTISIG_DISC);
    ix_data.extend_from_slice(&threshold.to_le_bytes());
    ix_data.extend_from_slice(&(members.len() as u32).to_le_bytes());
    for member in members {
        ix_data.extend_from_slice(member.as_ref());
    }
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*multisig, false),
            AccountMeta::new_readonly(*dwallet, false),
            AccountMeta::new_readonly(*dwallet_program, false),
            AccountMeta::new_readonly(*owner, true),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        ],
        data: ix_data,
    }
}

fn build_create_transaction_ix(
    program_id: &Pubkey,
    multisig: &Pubkey,
    transaction: &Pubkey,
    proposer: &Pubkey,
    payer: &Pubkey,
    message_hash: [u8; 32],
    user_pubkey: [u8; 32],
    signature_voucher_bump: u8,
    future_sign: bool,
) -> Instruction {
    // borsh: disc(8) + message_hash(32) + user_pubkey(32) + signature_scheme(2) +
    // signature_voucher_bump(1) + future_sign(1) + message_data vec (u32 len = 0)
    let mut ix_data = Vec::with_capacity(80);
    ix_data.extend_from_slice(&CREATE_TRANSACTION_DISC);
    ix_data.extend_from_slice(&message_hash);
    ix_data.extend_from_slice(&user_pubkey);
    ix_data.extend_from_slice(&0u16.to_le_bytes());
    ix_data.push(signature_voucher_bump);
    ix_data.push(u8::from(future_sign));
    ix_data.extend_from_slice(&0u32.to_le_bytes());
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*multisig, false),
            AccountMeta::new(*transaction, false),
            AccountMeta::new_readonly(*proposer, true),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        ],
        data: ix_data,
    }
}

/// CPI accounts of an Approve instruction (always present for Anchor).
struct CpiAccounts {
    coordinator: Pubkey,
    signature_voucher: Pubkey,
    dwallet: Pubkey,
    program: Pubkey,
    cpi_authority: Pubkey,
    dwallet_program: Pubkey,
}

fn build_approve_ix(
    program_id: &Pubkey,
    multisig: &Pubkey,
    transaction: &Pubkey,
    approval_record: &Pubkey,
    member: &Pubkey,
    payer: &Pubkey,
    cpi_authority_bump: u8,
    cpi: &CpiAccounts,
) -> Instruction {
    let mut ix_data = Vec::with_capacity(9);
    ix_data.extend_from_slice(&APPROVE_DISC);
    ix_data.push(cpi_authority_bump);
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new_readonly(*multisig, false),
            AccountMeta::new(*transaction, false),
            AccountMeta::new(*approval_record, false),
            AccountMeta::new_readonly(*member, true),
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

// ===================================================================
// Helpers
// ===================================================================

/// The voucher the multisig program issues for a transaction: its own PDA
/// `["signature_voucher", transaction]`, which it signs for.
fn signature_voucher_pda(program_id: &Pubkey, transaction: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"signature_voucher", transaction.as_ref()], program_id)
}

fn multisig_pda(program_id: &Pubkey, dwallet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"multisig", dwallet.as_ref()], program_id).0
}

fn transaction_pda(program_id: &Pubkey, multisig: &Pubkey, tx_index: u32) -> Pubkey {
    Pubkey::find_program_address(
        &[b"transaction", multisig.as_ref(), &tx_index.to_le_bytes()],
        program_id,
    )
    .0
}

fn approval_record_pda(program_id: &Pubkey, transaction: &Pubkey, member: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[b"approval", transaction.as_ref(), member.as_ref()],
        program_id,
    )
    .0
}

struct Governed {
    dwallet: Pubkey,
    multisig: Pubkey,
    members: Vec<Keypair>,
}

fn setup_governed(
    ctx: &mut DWalletTestContext,
    program_id: &Pubkey,
    dwallet_pk: [u8; 32],
    threshold: u16,
    member_count: usize,
) -> Governed {
    let (cpi_authority, _) = ctx.cpi_authority_for(program_id);
    let owner_keypair = ctx.new_funded_keypair();
    let owner_pubkey = keypair_pubkey(&owner_keypair);
    let dwallet = ctx.create_dwallet(&owner_pubkey, CURVE_CURVE25519, 32, &dwallet_pk);

    let members: Vec<Keypair> = (0..member_count)
        .map(|_| ctx.new_funded_keypair())
        .collect();
    let member_pubkeys: Vec<Pubkey> = members.iter().map(keypair_pubkey).collect();
    let multisig = multisig_pda(program_id, &dwallet);
    let payer_ref = ctx.clone_payer();
    let ix = build_create_multisig_ix(
        program_id,
        &multisig,
        &dwallet,
        &ctx.dwallet_program_id,
        &owner_pubkey,
        &keypair_pubkey(&payer_ref),
        threshold,
        &member_pubkeys,
    );
    ctx.send_tx(&[&payer_ref, &owner_keypair], &[ix]);
    ctx.transfer_dwallet(&dwallet, &owner_keypair, &cpi_authority);

    Governed {
        dwallet,
        multisig,
        members,
    }
}

fn propose(
    ctx: &mut DWalletTestContext,
    program_id: &Pubkey,
    governed: &Governed,
    proposer: &Keypair,
    message_hash: [u8; 32],
    user_pubkey: [u8; 32],
    future_sign: bool,
) -> Pubkey {
    let transaction = transaction_pda(program_id, &governed.multisig, 0);
    let (_, voucher_bump) = signature_voucher_pda(program_id, &transaction);
    let payer_ref = ctx.clone_payer();
    let ix = build_create_transaction_ix(
        program_id,
        &governed.multisig,
        &transaction,
        &keypair_pubkey(proposer),
        &keypair_pubkey(&payer_ref),
        message_hash,
        user_pubkey,
        voucher_bump,
        future_sign,
    );
    ctx.send_tx(&[&payer_ref, proposer], &[ix]);
    transaction
}

fn approve(
    ctx: &mut DWalletTestContext,
    program_id: &Pubkey,
    governed: &Governed,
    transaction: &Pubkey,
    member: &Keypair,
    cpi: &CpiAccounts,
) -> Result<(), String> {
    let (_, cpi_authority_bump) = ctx.cpi_authority_for(program_id);
    let member_pubkey = keypair_pubkey(member);
    let approval_record = approval_record_pda(program_id, transaction, &member_pubkey);
    let payer_ref = ctx.clone_payer();
    let ix = build_approve_ix(
        program_id,
        &governed.multisig,
        transaction,
        &approval_record,
        &member_pubkey,
        &keypair_pubkey(&payer_ref),
        cpi_authority_bump,
        cpi,
    );
    ctx.try_send_tx(&[&payer_ref, member], &[ix])
        .map(|_| ())
        .map_err(|failed| format!("{failed:?}"))
}

fn cpi_for(
    ctx: &DWalletTestContext,
    program_id: &Pubkey,
    governed: &Governed,
    transaction: &Pubkey,
) -> CpiAccounts {
    let (cpi_authority, _) = ctx.cpi_authority_for(program_id);
    let (signature_voucher, _) = signature_voucher_pda(program_id, transaction);
    CpiAccounts {
        coordinator: ctx.coordinator_pda,
        signature_voucher,
        dwallet: governed.dwallet,
        program: *program_id,
        cpi_authority,
        dwallet_program: ctx.dwallet_program_id,
    }
}

fn assert_custom_error(result: Result<(), String>, code: u32) {
    match result {
        Ok(()) => panic!("expected Custom({code}) failure, transaction succeeded"),
        Err(rendered) => assert!(
            rendered.contains(&format!("Custom({code})")),
            "expected Custom({code}), got {rendered}"
        ),
    }
}

fn read_u16(data: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(data[offset..offset.saturating_add(2)].try_into().unwrap())
}

// ===================================================================
// Tests
// ===================================================================

#[test]
fn test_multisig_full_lifecycle() {
    let mut ctx = DWalletTestContext::new();
    let program_id = deploy_multisig(&mut ctx);
    let (cpi_authority, _) = ctx.cpi_authority_for(&program_id);
    let governed = setup_governed(&mut ctx, &program_id, [0xAAu8; 32], 2, 3);

    let ms_data = ctx
        .get_account_data(&governed.multisig)
        .expect("multisig should exist");
    assert_eq!(ms_data.len(), MULTISIG_LEN);
    assert_eq!(&ms_data[0..8], &MULTISIG_DISC);
    assert_eq!(
        &ms_data[MS_DWALLET..MS_DWALLET + 32],
        governed.dwallet.as_ref()
    );

    let message_hash = [0xBBu8; 32];
    let user_pubkey = [0xCCu8; 32];
    let transaction = propose(
        &mut ctx,
        &program_id,
        &governed,
        &governed.members[0],
        message_hash,
        user_pubkey,
        false,
    );

    let cpi = cpi_for(&ctx, &program_id, &governed, &transaction);
    approve(
        &mut ctx,
        &program_id,
        &governed,
        &transaction,
        &governed.members[0],
        &cpi,
    )
    .expect("first approval");
    let tx_data = ctx.get_account_data(&transaction).unwrap();
    assert_eq!(read_u16(&tx_data, TX_APPROVAL_COUNT), 1);
    assert_eq!(tx_data[TX_STATUS], STATUS_ACTIVE);
    assert!(
        ctx.get_account_data(&cpi.signature_voucher).is_none(),
        "no voucher before threshold"
    );

    approve(
        &mut ctx,
        &program_id,
        &governed,
        &transaction,
        &governed.members[1],
        &cpi,
    )
    .expect("second approval");
    let tx_data = ctx.get_account_data(&transaction).unwrap();
    assert_eq!(read_u16(&tx_data, TX_APPROVAL_COUNT), 2);
    assert_eq!(tx_data[TX_STATUS], STATUS_APPROVED);

    let voucher_data = ctx
        .get_account_data(&cpi.signature_voucher)
        .expect("the SignatureVoucher should exist");
    assert_eq!(voucher_data.len(), SIGNATURE_VOUCHER_LEN);
    assert_eq!(voucher_data[0], DISC_SIGNATURE_VOUCHER);
    assert_eq!(
        &voucher_data[SV_DWALLET..SV_DWALLET + 32],
        governed.dwallet.as_ref()
    );
    assert_eq!(
        &voucher_data[SV_MESSAGE_DIGEST..SV_MESSAGE_DIGEST + 32],
        &message_hash
    );
    assert_eq!(
        &voucher_data[SV_OWNER..SV_OWNER + 32],
        cpi_authority.as_ref(),
        "the owner is the issuer, the CPI authority PDA"
    );
    assert_eq!(voucher_data[SV_HAS_SIGNING_KEY], 1);
    assert_eq!(
        &voucher_data[SV_SIGNING_KEY..SV_SIGNING_KEY + 32],
        &user_pubkey
    );
    assert_eq!(voucher_data[SV_STATUS], SV_STATUS_PENDING);
}

/// A future-sign transaction issues a FutureSignatureVoucher at the same
/// PDA instead, owned by the proposer, who later sets the key that completes
/// the future sign. Its first signing key is the transaction's `user_pubkey`.
#[test]
fn test_multisig_issues_a_future_signature_voucher_owned_by_the_proposer() {
    let mut ctx = DWalletTestContext::new();
    let program_id = deploy_multisig(&mut ctx);
    let governed = setup_governed(&mut ctx, &program_id, [0xA5u8; 32], 1, 2);

    let message_hash = [0xB5u8; 32];
    let user_pubkey = [0xC5u8; 32];
    let proposer = &governed.members[1];
    let transaction = propose(
        &mut ctx,
        &program_id,
        &governed,
        proposer,
        message_hash,
        user_pubkey,
        true,
    );

    let cpi = cpi_for(&ctx, &program_id, &governed, &transaction);
    approve(
        &mut ctx,
        &program_id,
        &governed,
        &transaction,
        proposer,
        &cpi,
    )
    .expect("threshold approval");

    let voucher_data = ctx
        .get_account_data(&cpi.signature_voucher)
        .expect("the FutureSignatureVoucher should exist");
    assert_eq!(voucher_data.len(), FUTURE_SIGNATURE_VOUCHER_LEN);
    assert_eq!(voucher_data[0], DISC_FUTURE_SIGNATURE_VOUCHER);
    assert_eq!(
        &voucher_data[FSV_OWNER..FSV_OWNER + 32],
        keypair_pubkey(proposer).as_ref(),
        "the proposer owns the future voucher"
    );
    assert_eq!(
        &voucher_data[FSV_SIGNING_KEY..FSV_SIGNING_KEY + 32],
        &user_pubkey
    );
    assert_eq!(voucher_data[FSV_STATUS], FSV_STATUS_OPEN);
}

#[test]
fn test_outsider_cannot_approve_or_recreate_multisig() {
    let mut ctx = DWalletTestContext::new();
    let program_id = deploy_multisig(&mut ctx);
    let governed = setup_governed(&mut ctx, &program_id, [0xA1u8; 32], 1, 2);
    let message_hash = [0x11u8; 32];
    let transaction = propose(
        &mut ctx,
        &program_id,
        &governed,
        &governed.members[0],
        message_hash,
        [0u8; 32],
        false,
    );

    let outsider = ctx.new_funded_keypair();
    let outsider_pubkey = keypair_pubkey(&outsider);
    let cpi = cpi_for(&ctx, &program_id, &governed, &transaction);
    let result = approve(
        &mut ctx,
        &program_id,
        &governed,
        &transaction,
        &outsider,
        &cpi,
    );
    assert_custom_error(result, ERR_NOT_A_MEMBER);
    assert!(ctx.get_account_data(&cpi.signature_voucher).is_none());

    // For a dWallet whose multisig does not exist yet but whose owner is
    // someone else, the outsider is rejected as not-the-owner.
    let victim_owner = ctx.new_funded_keypair();
    let fresh_dwallet = ctx.create_dwallet(
        &keypair_pubkey(&victim_owner),
        CURVE_CURVE25519,
        32,
        &[0xA2u8; 32],
    );
    let payer_ref = ctx.clone_payer();
    let ix = build_create_multisig_ix(
        &program_id,
        &multisig_pda(&program_id, &fresh_dwallet),
        &fresh_dwallet,
        &ctx.dwallet_program_id,
        &outsider_pubkey,
        &keypair_pubkey(&payer_ref),
        1,
        &[outsider_pubkey],
    );
    let result = ctx
        .try_send_tx(&[&payer_ref, &outsider], &[ix])
        .map(|_| ())
        .map_err(|failed| format!("{failed:?}"));
    assert_custom_error(result, ERR_NOT_DWALLET_OWNER);
}

#[test]
fn test_threshold_cannot_be_redirected_to_another_multisigs_dwallet() {
    let mut ctx = DWalletTestContext::new();
    let program_id = deploy_multisig(&mut ctx);
    let victim = setup_governed(&mut ctx, &program_id, [0xC1u8; 32], 2, 3);
    let attacker = setup_governed(&mut ctx, &program_id, [0xC2u8; 32], 1, 1);

    let message_hash = [0x99u8; 32];
    let transaction = propose(
        &mut ctx,
        &program_id,
        &attacker,
        &attacker.members[0],
        message_hash,
        [0xFFu8; 32],
        false,
    );

    // Absent the binding, the CPI would issue the attacker's voucher on the
    // victim's dWallet.
    let cpi = CpiAccounts {
        dwallet: victim.dwallet,
        ..cpi_for(&ctx, &program_id, &attacker, &transaction)
    };
    let result = approve(
        &mut ctx,
        &program_id,
        &attacker,
        &transaction,
        &attacker.members[0],
        &cpi,
    );
    assert_custom_error(result, ERR_DWALLET_MISMATCH);
    assert!(
        ctx.get_account_data(&cpi.signature_voucher).is_none(),
        "no voucher may be issued on the victim's dWallet"
    );
    let tx_data = ctx.get_account_data(&transaction).unwrap();
    assert_eq!(
        tx_data[TX_STATUS], STATUS_ACTIVE,
        "the failed transaction rolled back"
    );
}
