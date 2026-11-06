// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! LiteSVM end-to-end tests for the multisig example.
//!
//! Runs against the real dWallet program: create multisig -> transfer the
//! dWallet to the CPI authority -> propose -> approve to threshold ->
//! `issue_signature_voucher` (or `issue_future_signature_voucher`) CPIs — plus the attacks the
//! bindings exist to stop: an outsider taking over a governed dWallet's
//! multisig, and one multisig's approval being executed against another
//! multisig's dWallet.

use ika_dwallet_litesvm_test::*;
use solana_keypair::Keypair;

/// Path to the compiled SBF binary for the multisig example.
const MULTISIG_PROGRAM_BINARY: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../target/deploy/ika_example_multisig.so"
);

// -- Multisig program constants (must match lib.rs) --
const MULTISIG_LEN: usize = 363;
const MS_DWALLET: usize = 2;
const TX_APPROVAL_COUNT: usize = 136;
const TX_REJECTION_COUNT: usize = 138;
const TX_STATUS: usize = 140;
const STATUS_ACTIVE: u8 = 0;
const STATUS_APPROVED: u8 = 1;

// -- Program error codes (`MultisigError`) --
const ERR_NOT_A_MEMBER: u32 = 0;
const ERR_DWALLET_MISMATCH: u32 = 1;
const ERR_NOT_DWALLET_OWNER: u32 = 3;
const ERR_INVALID_BUMP: u32 = 12;

// ===================================================================
// Instruction builders
// ===================================================================

/// CreateMultisig (disc=0): `[threshold(2), member_count(2), members]`.
///
/// Accounts: [multisig(w), dwallet(r), dwallet_program(r), owner(s), payer(ws), system_program(r)]
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
    let mut ix_data = Vec::with_capacity(5);
    ix_data.push(0);
    ix_data.extend_from_slice(&threshold.to_le_bytes());
    ix_data.extend_from_slice(&(members.len() as u16).to_le_bytes());
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

/// CreateTransaction (disc=1).
///
/// Accounts: [multisig(w), transaction(w), proposer(s), payer(ws), system_program(r)]
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
    tx_bump: u8,
) -> Instruction {
    let mut ix_data = Vec::with_capacity(72);
    ix_data.push(1);
    ix_data.extend_from_slice(&message_hash);
    ix_data.extend_from_slice(&user_pubkey);
    ix_data.extend_from_slice(&0u16.to_le_bytes()); // signature_scheme
    ix_data.push(signature_voucher_bump);
    ix_data.push(u8::from(future_sign));
    ix_data.push(tx_bump);
    ix_data.extend_from_slice(&0u16.to_le_bytes()); // message_data_len
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

/// Approve (disc=2): `[tx_index(4), approval_record_bump(1), cpi_authority_bump(1)]`.
///
/// Accounts: [multisig(r), transaction(w), approval_record(w), member(s), payer(ws), system_program(r)]
/// + optional CPI accounts appended by `with_cpi_accounts`.
fn build_approve_ix(
    program_id: &Pubkey,
    multisig: &Pubkey,
    transaction: &Pubkey,
    approval_record: &Pubkey,
    member: &Pubkey,
    payer: &Pubkey,
    tx_index: u32,
    approval_record_bump: u8,
    cpi_authority_bump: u8,
) -> Instruction {
    let mut ix_data = Vec::with_capacity(7);
    ix_data.push(2);
    ix_data.extend_from_slice(&tx_index.to_le_bytes());
    ix_data.push(approval_record_bump);
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
    multisig_program: Pubkey,
    cpi_authority: Pubkey,
    dwallet_program: Pubkey,
}

fn with_cpi_accounts(mut ix: Instruction, cpi: &CpiAccounts) -> Instruction {
    ix.accounts.extend([
        AccountMeta::new_readonly(cpi.coordinator, false),
        AccountMeta::new(cpi.signature_voucher, false),
        AccountMeta::new_readonly(cpi.dwallet, false),
        AccountMeta::new_readonly(cpi.multisig_program, false),
        AccountMeta::new_readonly(cpi.cpi_authority, false),
        AccountMeta::new_readonly(cpi.dwallet_program, false),
    ]);
    ix
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

fn transaction_pda(program_id: &Pubkey, multisig: &Pubkey, tx_index: u32) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"transaction", multisig.as_ref(), &tx_index.to_le_bytes()],
        program_id,
    )
}

fn approval_record_pda(program_id: &Pubkey, transaction: &Pubkey, member: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"approval", transaction.as_ref(), member.as_ref()],
        program_id,
    )
}

/// A dWallet placed under a multisig's control: created with a user owner,
/// multisig created by that owner, then ownership transferred to the CPI PDA.
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

    // Hand the dWallet to the program only AFTER the multisig is fixed.
    ctx.transfer_dwallet(&dwallet, &owner_keypair, &cpi_authority);

    Governed {
        dwallet,
        multisig,
        members,
    }
}

/// Propose a transaction (tx_index 0), carrying the bump of its voucher PDA.
fn propose(
    ctx: &mut DWalletTestContext,
    program_id: &Pubkey,
    governed: &Governed,
    proposer: &Keypair,
    message_hash: [u8; 32],
    user_pubkey: [u8; 32],
    future_sign: bool,
) -> Pubkey {
    let (transaction, tx_bump) = transaction_pda(program_id, &governed.multisig, 0);
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
        tx_bump,
    );
    ctx.send_tx(&[&payer_ref, proposer], &[ix]);
    transaction
}

/// Approve as `member` with the given CPI accounts.
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
    let (approval_record, ar_bump) = approval_record_pda(program_id, transaction, &member_pubkey);
    let payer_ref = ctx.clone_payer();
    let ix = with_cpi_accounts(
        build_approve_ix(
            program_id,
            &governed.multisig,
            transaction,
            &approval_record,
            &member_pubkey,
            &keypair_pubkey(&payer_ref),
            0,
            ar_bump,
            cpi_authority_bump,
        ),
        cpi,
    );
    ctx.try_send_tx(&[&payer_ref, member], &[ix])
        .map(|_| ())
        .map_err(|failed| format!("{failed:?}"))
}

/// The CPI account set for approving `governed`'s `transaction`.
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
        multisig_program: *program_id,
        cpi_authority,
        dwallet_program: ctx.dwallet_program_id,
    }
}

/// Assert that a rendered transaction failure names the given custom error.
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

/// Full lifecycle: multisig 2-of-3 -> propose -> two approvals -> the
/// second reaches threshold and issues the SignatureVoucher.
#[test]
fn test_multisig_full_lifecycle() {
    let mut ctx = DWalletTestContext::new();
    let program_id = ctx.deploy_program(MULTISIG_PROGRAM_BINARY);
    let (cpi_authority, _) = ctx.cpi_authority_for(&program_id);
    let governed = setup_governed(&mut ctx, &program_id, [0xAAu8; 32], 2, 3);

    let ms_data = ctx
        .get_account_data(&governed.multisig)
        .expect("multisig should exist");
    assert_eq!(ms_data.len(), MULTISIG_LEN);
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
    let program_id = ctx.deploy_program(MULTISIG_PROGRAM_BINARY);
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
        &voucher_data[FSV_DWALLET..FSV_DWALLET + 32],
        governed.dwallet.as_ref()
    );
    assert_eq!(
        &voucher_data[FSV_MESSAGE_DIGEST..FSV_MESSAGE_DIGEST + 32],
        &message_hash
    );
    assert_eq!(
        &voucher_data[FSV_OWNER..FSV_OWNER + 32],
        keypair_pubkey(proposer).as_ref(),
        "the proposer owns the future voucher"
    );
    assert_eq!(voucher_data[FSV_HAS_SIGNING_KEY], 1);
    assert_eq!(
        &voucher_data[FSV_SIGNING_KEY..FSV_SIGNING_KEY + 32],
        &user_pubkey
    );
    assert_eq!(voucher_data[FSV_STATUS], FSV_STATUS_OPEN);
}

/// An outsider can neither approve nor create the multisig of a dWallet the
/// program already controls (its owner is the CPI PDA).
#[test]
fn test_outsider_cannot_approve_or_recreate_multisig() {
    let mut ctx = DWalletTestContext::new();
    let program_id = ctx.deploy_program(MULTISIG_PROGRAM_BINARY);
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

    // The dWallet's owner is now the CPI PDA: nobody can pass the
    // owner check to create a multisig for it (and the PDA exists).
    let payer_ref = ctx.clone_payer();
    let ix = build_create_multisig_ix(
        &program_id,
        &governed.multisig,
        &governed.dwallet,
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

    // For a dWallet whose multisig does not exist yet but whose owner is
    // someone else, the outsider is likewise rejected.
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

/// The confused-deputy attack: an attacker governs their OWN dWallet through
/// this program (their own 1-of-1 multisig), reaches threshold on their own
/// transaction, but passes the VICTIM's dWallet as the CPI target. The program must refuse — the CPI authority PDA is shared
/// by every dWallet the program controls.
#[test]
fn test_threshold_cannot_be_redirected_to_another_multisigs_dwallet() {
    let mut ctx = DWalletTestContext::new();
    let program_id = ctx.deploy_program(MULTISIG_PROGRAM_BINARY);
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

/// A bump below the canonical one for `seeds` that still derives a valid
/// address, and that address.
fn non_canonical_pda(seeds: &[&[u8]], program_id: &Pubkey) -> (Pubkey, u8) {
    let (_, canonical) = Pubkey::find_program_address(seeds, program_id);
    (0..canonical)
        .rev()
        .find_map(|bump| {
            let bump_bytes = [bump];
            let with_bump: Vec<&[u8]> = seeds.iter().copied().chain([&bump_bytes[..]]).collect();
            Pubkey::create_program_address(&with_bump, program_id)
                .ok()
                .map(|address| (address, bump))
        })
        .expect("some bump below the canonical one derives an address")
}

/// Reject (disc=3): `[tx_index(4), approval_record_bump(1)]`.
fn build_reject_ix(
    program_id: &Pubkey,
    multisig: &Pubkey,
    transaction: &Pubkey,
    approval_record: &Pubkey,
    member: &Pubkey,
    payer: &Pubkey,
    approval_record_bump: u8,
) -> Instruction {
    let mut ix_data = Vec::with_capacity(6);
    ix_data.push(3);
    ix_data.extend_from_slice(&0u32.to_le_bytes());
    ix_data.push(approval_record_bump);
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new_readonly(*multisig, false),
            AccountMeta::new(*transaction, false),
            AccountMeta::new(*approval_record, false),
            AccountMeta::new_readonly(*member, true),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        ],
        data: ix_data,
    }
}

/// An approval record exists once per member and transaction only at its
/// canonical address. A member who approves, then approves again with
/// another bump that derives a second valid address, is refused: otherwise
/// the second record would be created and the approval counted twice, and
/// one member could reach a threshold of two alone.
#[test]
fn test_a_member_cannot_approve_twice_with_a_second_bump() {
    let mut ctx = DWalletTestContext::new();
    let program_id = ctx.deploy_program(MULTISIG_PROGRAM_BINARY);
    let governed = setup_governed(&mut ctx, &program_id, [0xE2u8; 32], 2, 3);
    let member = &governed.members[0];
    let transaction = propose(
        &mut ctx,
        &program_id,
        &governed,
        member,
        [0x42u8; 32],
        [0xCCu8; 32],
        false,
    );
    let cpi = cpi_for(&ctx, &program_id, &governed, &transaction);
    approve(&mut ctx, &program_id, &governed, &transaction, member, &cpi)
        .expect("the first approval is accepted");

    let member_pubkey = keypair_pubkey(member);
    let (second_record, second_bump) = non_canonical_pda(
        &[b"approval", transaction.as_ref(), member_pubkey.as_ref()],
        &program_id,
    );
    let (_, cpi_authority_bump) = ctx.cpi_authority_for(&program_id);
    let payer_ref = ctx.clone_payer();
    let ix = with_cpi_accounts(
        build_approve_ix(
            &program_id,
            &governed.multisig,
            &transaction,
            &second_record,
            &member_pubkey,
            &keypair_pubkey(&payer_ref),
            0,
            second_bump,
            cpi_authority_bump,
        ),
        &cpi,
    );
    let result = ctx
        .try_send_tx(&[&payer_ref, member], &[ix])
        .map(|_| ())
        .map_err(|failed| format!("{failed:?}"));
    assert_custom_error(result, ERR_INVALID_BUMP);
    assert!(
        ctx.get_account_data(&second_record).is_none(),
        "no second approval record is written"
    );
    let tx_data = ctx.get_account_data(&transaction).unwrap();
    assert_eq!(
        read_u16(&tx_data, TX_APPROVAL_COUNT),
        1,
        "the approval counts once"
    );
}

/// The same for a rejection: a second rejection record at another bump's
/// address is refused, so one member cannot reject twice.
#[test]
fn test_a_member_cannot_reject_twice_with_a_second_bump() {
    let mut ctx = DWalletTestContext::new();
    let program_id = ctx.deploy_program(MULTISIG_PROGRAM_BINARY);
    let governed = setup_governed(&mut ctx, &program_id, [0xE3u8; 32], 2, 3);
    let member = &governed.members[0];
    let transaction = propose(
        &mut ctx,
        &program_id,
        &governed,
        member,
        [0x42u8; 32],
        [0xCCu8; 32],
        false,
    );
    let member_pubkey = keypair_pubkey(member);
    let (record, bump) = approval_record_pda(&program_id, &transaction, &member_pubkey);
    let payer_ref = ctx.clone_payer();
    let first = build_reject_ix(
        &program_id,
        &governed.multisig,
        &transaction,
        &record,
        &member_pubkey,
        &keypair_pubkey(&payer_ref),
        bump,
    );
    ctx.send_tx(&[&payer_ref, member], &[first]);

    let (second_record, second_bump) = non_canonical_pda(
        &[b"approval", transaction.as_ref(), member_pubkey.as_ref()],
        &program_id,
    );
    let second = build_reject_ix(
        &program_id,
        &governed.multisig,
        &transaction,
        &second_record,
        &member_pubkey,
        &keypair_pubkey(&payer_ref),
        second_bump,
    );
    let result = ctx
        .try_send_tx(&[&payer_ref, member], &[second])
        .map(|_| ())
        .map_err(|failed| format!("{failed:?}"));
    assert_custom_error(result, ERR_INVALID_BUMP);
    assert!(
        ctx.get_account_data(&second_record).is_none(),
        "no second rejection record is written"
    );
    let tx_data = ctx.get_account_data(&transaction).unwrap();
    assert_eq!(
        read_u16(&tx_data, TX_REJECTION_COUNT),
        1,
        "the rejection counts once"
    );
}

/// A transaction exists only at its canonical address.
#[test]
fn test_create_transaction_refuses_a_non_canonical_transaction_bump() {
    let mut ctx = DWalletTestContext::new();
    let program_id = ctx.deploy_program(MULTISIG_PROGRAM_BINARY);
    let governed = setup_governed(&mut ctx, &program_id, [0xE4u8; 32], 2, 3);
    let proposer = &governed.members[0];
    let (transaction, tx_bump) = non_canonical_pda(
        &[
            b"transaction",
            governed.multisig.as_ref(),
            &0u32.to_le_bytes(),
        ],
        &program_id,
    );
    let (_, voucher_bump) = signature_voucher_pda(&program_id, &transaction);
    let payer_ref = ctx.clone_payer();
    let ix = build_create_transaction_ix(
        &program_id,
        &governed.multisig,
        &transaction,
        &keypair_pubkey(proposer),
        &keypair_pubkey(&payer_ref),
        [0x42u8; 32],
        [0xCCu8; 32],
        voucher_bump,
        false,
        tx_bump,
    );
    let result = ctx
        .try_send_tx(&[&payer_ref, proposer], &[ix])
        .map(|_| ())
        .map_err(|failed| format!("{failed:?}"));
    assert_custom_error(result, ERR_INVALID_BUMP);
    assert!(
        ctx.get_account_data(&transaction).is_none(),
        "no transaction is written at a non-canonical address"
    );
}
