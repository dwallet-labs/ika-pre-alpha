// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! Example: Multisig-controlled dWallet signing with future sign.
//!
//! A Pinocchio program demonstrating m-of-n multisig control over dWallets via
//! the CPI authority pattern. Transactions are proposed with message data stored
//! directly on-chain so other signers can inspect them. When enough members
//! approve (reaching threshold), the program CPI-calls `approve_message` and
//! `transfer_future_sign` on the dWallet program.
//!
//! # Instructions
//!
//! - `0` -- **CreateMultisig**: create a Multisig PDA with members and threshold.
//! - `1` -- **CreateTransaction**: propose a transaction referencing a dWallet message.
//! - `2` -- **Approve**: approve a transaction; when threshold reached, CPI-signs.
//! - `3` -- **Reject**: reject a transaction; when threshold rejections, mark rejected.
//!
//! # Account Layouts
//!
//! **Multisig** PDA (`["multisig", create_key]`):
//!   disc(1) + version(1) + create_key(32) + threshold(2) + member_count(2) +
//!   tx_index(4) + dwallet(32) + bump(1) + members(32*10) = 395 bytes
//!
//! **Transaction** PDA (`["transaction", multisig, tx_index_bytes]`):
//!   disc(1) + version(1) + multisig(32) + tx_index(4) + proposer(32) +
//!   message_hash(32) + user_pubkey(32) + signature_scheme(2) +
//!   approval_count(2) + rejection_count(2) + status(1) +
//!   message_approval_bump(1) + partial_user_sig(32) + bump(1) +
//!   message_data_len(2) + message_data(256) = 433 bytes
//!
//! **ApprovalRecord** PDA (`["approval", transaction, member]`):
//!   disc(1) + version(1) + member(32) + transaction(32) + approved(1) +
//!   bump(1) = 68 bytes

#![no_std]

extern crate alloc;

use pinocchio::{
    cpi::Signer,
    entrypoint,
    error::ProgramError,
    AccountView, Address, ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

use ika_dwallet_pinocchio::DWalletContext;

entrypoint!(process_instruction);
pinocchio::nostd_panic_handler!();

// Placeholder program ID -- replace with actual keypair before deployment.
pub const ID: Address = Address::new_from_array([6u8; 32]);

// Maximum number of members in a multisig.
const MAX_MEMBERS: usize = 10;

// -- Discriminators --
const MULTISIG_DISCRIMINATOR: u8 = 1;
const TRANSACTION_DISCRIMINATOR: u8 = 2;
const APPROVAL_RECORD_DISCRIMINATOR: u8 = 3;

// -- Status values --
const STATUS_ACTIVE: u8 = 0;
const STATUS_APPROVED: u8 = 1;
const STATUS_REJECTED: u8 = 2;

// -- Account sizes --
const MULTISIG_LEN: usize = 2 + 32 + 2 + 2 + 4 + 32 + 1 + (32 * MAX_MEMBERS); // 395
const TRANSACTION_LEN: usize = 2 + 32 + 4 + 32 + 32 + 32 + 2 + 2 + 2 + 1 + 1 + 32 + 1 + 2 + 256; // 433
const APPROVAL_RECORD_LEN: usize = 2 + 32 + 32 + 1 + 1; // 68

// -- Multisig offsets (after 2-byte header) --
const MS_CREATE_KEY: usize = 2;
const MS_THRESHOLD: usize = 34;
const MS_MEMBER_COUNT: usize = 36;
const MS_TX_INDEX: usize = 38;
const MS_DWALLET: usize = 42;
const MS_BUMP: usize = 74;
const MS_MEMBERS: usize = 75;

// -- Transaction offsets (after 2-byte header) --
const TX_MULTISIG: usize = 2;
const TX_INDEX: usize = 34;
const TX_PROPOSER: usize = 38;
const TX_MESSAGE_HASH: usize = 70;
const TX_USER_PUBKEY: usize = 102;
const TX_SIGNATURE_SCHEME: usize = 134; // 2 bytes (u16 LE)
const TX_APPROVAL_COUNT: usize = 136;
const TX_REJECTION_COUNT: usize = 138;
const TX_STATUS: usize = 140;
const TX_MSG_APPROVAL_BUMP: usize = 141;
const TX_PARTIAL_USER_SIG: usize = 142;
const TX_BUMP: usize = 174;
const TX_MESSAGE_DATA_LEN: usize = 175;
const TX_MESSAGE_DATA: usize = 177;

// -- ApprovalRecord offsets (after 2-byte header) --
const AR_MEMBER: usize = 2;
const AR_TRANSACTION: usize = 34;
const AR_APPROVED: usize = 66;
const AR_BUMP: usize = 67;

/// Calculates minimum rent-exempt balance (same formula as ika programs).
#[inline(always)]
fn minimum_balance(data_len: usize) -> u64 {
    (data_len as u64 + 128) * 6960
}

/// Check if a pubkey is a member of the multisig.
fn is_member(ms_data: &[u8], member: &[u8; 32]) -> bool {
    let count = u16::from_le_bytes(
        ms_data[MS_MEMBER_COUNT..MS_MEMBER_COUNT + 2]
            .try_into()
            .unwrap_or([0, 0]),
    ) as usize;
    for i in 0..count {
        let offset = MS_MEMBERS + (i * 32);
        if &ms_data[offset..offset + 32] == member.as_ref() {
            return true;
        }
    }
    false
}

pub fn process_instruction(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    let (discriminator, rest) = data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;

    match *discriminator {
        0 => create_multisig(program_id, accounts, rest),
        1 => create_transaction(program_id, accounts, rest),
        2 => approve(program_id, accounts, rest),
        3 => reject(program_id, accounts, rest),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// Create a multisig PDA.
///
/// # Instruction Data
///
/// `[create_key(32), dwallet(32), threshold(2), member_count(2), bump(1),
///   members(32*member_count)]`
///
/// # Accounts
///
/// 0. `[writable]`          Multisig PDA (seeds: `["multisig", create_key]`)
/// 1. `[signer]`            Creator
/// 2. `[writable, signer]`  Payer
/// 3. `[readonly]`          System program
fn create_multisig(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    if data.len() < 69 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let [multisig_account, creator, payer, _system_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !creator.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !payer.is_signer() || !payer.is_writable() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let create_key: [u8; 32] = data[0..32]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let dwallet: [u8; 32] = data[32..64]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let threshold = u16::from_le_bytes(
        data[64..66]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    let member_count = u16::from_le_bytes(
        data[66..68]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    let bump = data[68];

    // Validate inputs.
    if threshold == 0 || member_count == 0 {
        return Err(ProgramError::InvalidInstructionData);
    }
    if threshold > member_count {
        return Err(ProgramError::InvalidInstructionData);
    }
    if member_count as usize > MAX_MEMBERS {
        return Err(ProgramError::InvalidInstructionData);
    }

    let members_data_len = (member_count as usize) * 32;
    if data.len() < 69 + members_data_len {
        return Err(ProgramError::InvalidInstructionData);
    }

    // Create Multisig PDA.
    let bump_byte = [bump];
    let signer_seeds = [
        pinocchio::cpi::Seed::from(b"multisig" as &[u8]),
        pinocchio::cpi::Seed::from(create_key.as_ref()),
        pinocchio::cpi::Seed::from(bump_byte.as_ref()),
    ];
    let signer = Signer::from(&signer_seeds);

    CreateAccount {
        from: payer,
        to: multisig_account,
        lamports: minimum_balance(MULTISIG_LEN),
        space: MULTISIG_LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[signer])?;

    // Write Multisig fields.
    let ms_data = unsafe { multisig_account.borrow_unchecked_mut() };
    ms_data[0] = MULTISIG_DISCRIMINATOR;
    ms_data[1] = 1; // version

    ms_data[MS_CREATE_KEY..MS_CREATE_KEY + 32].copy_from_slice(&create_key);
    ms_data[MS_THRESHOLD..MS_THRESHOLD + 2].copy_from_slice(&threshold.to_le_bytes());
    ms_data[MS_MEMBER_COUNT..MS_MEMBER_COUNT + 2].copy_from_slice(&member_count.to_le_bytes());
    ms_data[MS_TX_INDEX..MS_TX_INDEX + 4].copy_from_slice(&0u32.to_le_bytes());
    ms_data[MS_DWALLET..MS_DWALLET + 32].copy_from_slice(&dwallet);
    ms_data[MS_BUMP] = bump;

    // Write members.
    for i in 0..member_count as usize {
        let src_offset = 69 + (i * 32);
        let dst_offset = MS_MEMBERS + (i * 32);
        ms_data[dst_offset..dst_offset + 32].copy_from_slice(&data[src_offset..src_offset + 32]);
    }

    Ok(())
}

/// Create a transaction proposal.
///
/// # Instruction Data
///
/// `[message_hash(32), user_pubkey(32), signature_scheme(2),
///   message_approval_bump(1), partial_user_sig(32), tx_bump(1),
///   message_data_len(2), message_data(var)]`
///
/// # Accounts
///
/// 0. `[writable]`          Multisig PDA
/// 1. `[writable]`          Transaction PDA (seeds: `["transaction", multisig, tx_index_bytes]`)
/// 2. `[signer]`            Proposer (must be a member)
/// 3. `[writable, signer]`  Payer
/// 4. `[readonly]`          System program
fn create_transaction(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    if data.len() < 102 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let [multisig_account, tx_account, proposer, payer, _system_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !proposer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !payer.is_signer() || !payer.is_writable() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Verify multisig.
    let ms_data = unsafe { multisig_account.borrow_unchecked() };
    if ms_data.len() < MULTISIG_LEN || ms_data[0] != MULTISIG_DISCRIMINATOR {
        return Err(ProgramError::InvalidAccountData);
    }

    // Verify proposer is a member.
    if !is_member(ms_data, proposer.address().as_array()) {
        return Err(ProgramError::InvalidArgument);
    }

    // Parse instruction data.
    let message_hash: [u8; 32] = data[0..32]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let user_pubkey: [u8; 32] = data[32..64]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let signature_scheme = u16::from_le_bytes(
        data[64..66]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    let message_approval_bump = data[66];
    let partial_user_sig: [u8; 32] = data[67..99]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let tx_bump = data[99];
    let message_data_len = u16::from_le_bytes(
        data[100..102]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );

    if message_data_len > 256 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let total_data_len = 102 + message_data_len as usize;
    if data.len() < total_data_len {
        return Err(ProgramError::InvalidInstructionData);
    }

    // Read and increment tx_index.
    let tx_index = u32::from_le_bytes(
        ms_data[MS_TX_INDEX..MS_TX_INDEX + 4]
            .try_into()
            .map_err(|_| ProgramError::InvalidAccountData)?,
    );

    // Create Transaction PDA.
    let tx_index_bytes = tx_index.to_le_bytes();
    let bump_byte = [tx_bump];
    let signer_seeds = [
        pinocchio::cpi::Seed::from(b"transaction" as &[u8]),
        pinocchio::cpi::Seed::from(multisig_account.address().as_array().as_ref()),
        pinocchio::cpi::Seed::from(tx_index_bytes.as_ref()),
        pinocchio::cpi::Seed::from(bump_byte.as_ref()),
    ];
    let signer = Signer::from(&signer_seeds);

    CreateAccount {
        from: payer,
        to: tx_account,
        lamports: minimum_balance(TRANSACTION_LEN),
        space: TRANSACTION_LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[signer])?;

    // Write Transaction fields.
    let tx_data = unsafe { tx_account.borrow_unchecked_mut() };
    tx_data[0] = TRANSACTION_DISCRIMINATOR;
    tx_data[1] = 1; // version

    tx_data[TX_MULTISIG..TX_MULTISIG + 32]
        .copy_from_slice(multisig_account.address().as_array());
    tx_data[TX_INDEX..TX_INDEX + 4].copy_from_slice(&tx_index_bytes);
    tx_data[TX_PROPOSER..TX_PROPOSER + 32].copy_from_slice(proposer.address().as_array());
    tx_data[TX_MESSAGE_HASH..TX_MESSAGE_HASH + 32].copy_from_slice(&message_hash);
    tx_data[TX_USER_PUBKEY..TX_USER_PUBKEY + 32].copy_from_slice(&user_pubkey);
    tx_data[TX_SIGNATURE_SCHEME..TX_SIGNATURE_SCHEME + 2]
        .copy_from_slice(&signature_scheme.to_le_bytes());
    tx_data[TX_APPROVAL_COUNT..TX_APPROVAL_COUNT + 2].copy_from_slice(&0u16.to_le_bytes());
    tx_data[TX_REJECTION_COUNT..TX_REJECTION_COUNT + 2].copy_from_slice(&0u16.to_le_bytes());
    tx_data[TX_STATUS] = STATUS_ACTIVE;
    tx_data[TX_MSG_APPROVAL_BUMP] = message_approval_bump;
    tx_data[TX_PARTIAL_USER_SIG..TX_PARTIAL_USER_SIG + 32].copy_from_slice(&partial_user_sig);
    tx_data[TX_BUMP] = tx_bump;
    tx_data[TX_MESSAGE_DATA_LEN..TX_MESSAGE_DATA_LEN + 2]
        .copy_from_slice(&message_data_len.to_le_bytes());

    // Copy message data (up to 256 bytes).
    if message_data_len > 0 {
        let msg_src = &data[102..102 + message_data_len as usize];
        tx_data[TX_MESSAGE_DATA..TX_MESSAGE_DATA + message_data_len as usize]
            .copy_from_slice(msg_src);
    }

    // Increment tx_index on multisig.
    let ms_data_mut = unsafe { multisig_account.borrow_unchecked_mut() };
    let new_index = tx_index
        .checked_add(1)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    ms_data_mut[MS_TX_INDEX..MS_TX_INDEX + 4].copy_from_slice(&new_index.to_le_bytes());

    Ok(())
}

/// Approve a transaction.
///
/// When threshold approvals are reached, CPI-calls `approve_message` on the
/// dWallet program and optionally `transfer_future_sign` for the partial
/// user signature.
///
/// # Instruction Data
///
/// `[tx_index(4), approval_record_bump(1), cpi_authority_bump(1)]` = 6 bytes
///
/// # Accounts
///
/// 0.  `[readonly]`          Multisig PDA
/// 1.  `[writable]`          Transaction PDA
/// 2.  `[writable]`          ApprovalRecord PDA (seeds: `["approval", transaction, member]`)
/// 3.  `[signer]`            Member
/// 4.  `[writable, signer]`  Payer
/// 5.  `[readonly]`          System program
///
/// When threshold is reached, additional accounts for CPI:
///
/// 6.  `[readonly]`          DWalletCoordinator PDA (for epoch)
/// 7.  `[writable]`          MessageApproval PDA (to create via CPI)
/// 8.  `[readonly]`          dWallet account
/// 9.  `[readonly]`          This program account (caller_program for CPI)
/// 10. `[readonly]`          CPI authority PDA (signer via invoke_signed)
/// 11. `[readonly]`          dWallet program
///
/// If partial_user_sig is set (not all zeros), additional account:
///
/// 12. `[writable]`          PartialUserSignature account (for transfer_future_sign)
fn approve(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    if data.len() < 6 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let tx_index_bytes: [u8; 4] = data[0..4]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let approval_record_bump = data[4];
    let cpi_authority_bump = data[5];

    if accounts.len() < 6 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let multisig_account = &accounts[0];
    let tx_account = &accounts[1];
    let approval_record_account = &accounts[2];
    let member = &accounts[3];
    let payer = &accounts[4];
    let system_program = &accounts[5];

    if !member.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !payer.is_signer() || !payer.is_writable() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Verify multisig.
    let ms_data = unsafe { multisig_account.borrow_unchecked() };
    if ms_data.len() < MULTISIG_LEN || ms_data[0] != MULTISIG_DISCRIMINATOR {
        return Err(ProgramError::InvalidAccountData);
    }

    // Verify member is part of multisig.
    if !is_member(ms_data, member.address().as_array()) {
        return Err(ProgramError::InvalidArgument);
    }

    // Verify transaction is active.
    {
        let tx_data = unsafe { tx_account.borrow_unchecked() };
        if tx_data.len() < TRANSACTION_LEN || tx_data[0] != TRANSACTION_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        if tx_data[TX_STATUS] != STATUS_ACTIVE {
            return Err(ProgramError::InvalidArgument);
        }
        // Verify transaction belongs to this multisig.
        if &tx_data[TX_MULTISIG..TX_MULTISIG + 32] != multisig_account.address().as_array() {
            return Err(ProgramError::InvalidArgument);
        }
    }

    // Create ApprovalRecord PDA (prevents double voting).
    let ar_bump_byte = [approval_record_bump];
    let member_key = member.address().as_array();
    let tx_key = tx_account.address().as_array();
    let ar_signer_seeds = [
        pinocchio::cpi::Seed::from(b"approval" as &[u8]),
        pinocchio::cpi::Seed::from(tx_key.as_ref()),
        pinocchio::cpi::Seed::from(member_key.as_ref()),
        pinocchio::cpi::Seed::from(ar_bump_byte.as_ref()),
    ];
    let ar_signer = Signer::from(&ar_signer_seeds);

    CreateAccount {
        from: payer,
        to: approval_record_account,
        lamports: minimum_balance(APPROVAL_RECORD_LEN),
        space: APPROVAL_RECORD_LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[ar_signer])?;

    // Write ApprovalRecord fields.
    {
        let ar_data = unsafe { approval_record_account.borrow_unchecked_mut() };
        ar_data[0] = APPROVAL_RECORD_DISCRIMINATOR;
        ar_data[1] = 1; // version
        ar_data[AR_MEMBER..AR_MEMBER + 32].copy_from_slice(member_key);
        ar_data[AR_TRANSACTION..AR_TRANSACTION + 32].copy_from_slice(tx_key);
        ar_data[AR_APPROVED] = 1; // approved
        ar_data[AR_BUMP] = approval_record_bump;
    }

    // Increment approval count.
    let tx_data = unsafe { tx_account.borrow_unchecked_mut() };
    let current_approvals = u16::from_le_bytes(
        tx_data[TX_APPROVAL_COUNT..TX_APPROVAL_COUNT + 2]
            .try_into()
            .map_err(|_| ProgramError::InvalidAccountData)?,
    );
    let new_approvals = current_approvals
        .checked_add(1)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    tx_data[TX_APPROVAL_COUNT..TX_APPROVAL_COUNT + 2]
        .copy_from_slice(&new_approvals.to_le_bytes());

    // Check if threshold reached.
    let threshold = u16::from_le_bytes(
        ms_data[MS_THRESHOLD..MS_THRESHOLD + 2]
            .try_into()
            .map_err(|_| ProgramError::InvalidAccountData)?,
    );

    if new_approvals >= threshold {
        if accounts.len() < 12 {
            return Err(ProgramError::NotEnoughAccountKeys);
        }

        let coordinator = &accounts[6];
        let message_approval = &accounts[7];
        let dwallet = &accounts[8];
        let caller_program = &accounts[9];
        let cpi_authority = &accounts[10];
        let dwallet_program = &accounts[11];

        // Read transaction fields for CPI call.
        let mut message_hash = [0u8; 32];
        message_hash.copy_from_slice(&tx_data[TX_MESSAGE_HASH..TX_MESSAGE_HASH + 32]);
        let mut user_pubkey = [0u8; 32];
        user_pubkey.copy_from_slice(&tx_data[TX_USER_PUBKEY..TX_USER_PUBKEY + 32]);
        let signature_scheme = u16::from_le_bytes(
            tx_data[TX_SIGNATURE_SCHEME..TX_SIGNATURE_SCHEME + 2]
                .try_into()
                .map_err(|_| ProgramError::InvalidAccountData)?,
        );
        let message_approval_bump = tx_data[TX_MSG_APPROVAL_BUMP];
        // No message metadata for multisig — use all zeros.
        let message_metadata_digest = [0u8; 32];

        let ctx = DWalletContext {
            dwallet_program,
            cpi_authority,
            caller_program,
            cpi_authority_bump,
        };

        // CPI: approve_message to create MessageApproval and trigger signing.
        ctx.approve_message(
            coordinator,
            message_approval,
            dwallet,
            payer,
            system_program,
            message_hash,
            message_metadata_digest,
            user_pubkey,
            signature_scheme,
            message_approval_bump,
        )?;

        // CPI: transfer_future_sign if partial_user_sig is set.
        let partial_user_sig_bytes: [u8; 32] = tx_data
            [TX_PARTIAL_USER_SIG..TX_PARTIAL_USER_SIG + 32]
            .try_into()
            .map_err(|_| ProgramError::InvalidAccountData)?;

        if partial_user_sig_bytes != [0u8; 32] {
            if accounts.len() < 13 {
                return Err(ProgramError::NotEnoughAccountKeys);
            }
            let partial_user_sig_account = &accounts[12];

            // Transfer future sign completion authority to the proposer.
            let mut proposer_key = [0u8; 32];
            proposer_key.copy_from_slice(&tx_data[TX_PROPOSER..TX_PROPOSER + 32]);

            ctx.transfer_future_sign(partial_user_sig_account, proposer_key)?;
        }

        // Mark transaction as approved.
        tx_data[TX_STATUS] = STATUS_APPROVED;
    }

    Ok(())
}

/// Reject a transaction.
///
/// When enough rejections are reached (member_count - threshold + 1), the
/// transaction is marked as rejected.
///
/// # Instruction Data
///
/// `[tx_index(4), approval_record_bump(1)]` = 5 bytes
///
/// # Accounts
///
/// 0. `[readonly]`          Multisig PDA
/// 1. `[writable]`          Transaction PDA
/// 2. `[writable]`          ApprovalRecord PDA (seeds: `["approval", transaction, member]`)
/// 3. `[signer]`            Member
/// 4. `[writable, signer]`  Payer
/// 5. `[readonly]`          System program
fn reject(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    if data.len() < 5 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let _tx_index: [u8; 4] = data[0..4]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let approval_record_bump = data[4];

    if accounts.len() < 6 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let multisig_account = &accounts[0];
    let tx_account = &accounts[1];
    let approval_record_account = &accounts[2];
    let member = &accounts[3];
    let payer = &accounts[4];
    let _system_program = &accounts[5];

    if !member.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !payer.is_signer() || !payer.is_writable() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Verify multisig.
    let ms_data = unsafe { multisig_account.borrow_unchecked() };
    if ms_data.len() < MULTISIG_LEN || ms_data[0] != MULTISIG_DISCRIMINATOR {
        return Err(ProgramError::InvalidAccountData);
    }

    // Verify member is part of multisig.
    if !is_member(ms_data, member.address().as_array()) {
        return Err(ProgramError::InvalidArgument);
    }

    // Verify transaction is active.
    {
        let tx_data = unsafe { tx_account.borrow_unchecked() };
        if tx_data.len() < TRANSACTION_LEN || tx_data[0] != TRANSACTION_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        if tx_data[TX_STATUS] != STATUS_ACTIVE {
            return Err(ProgramError::InvalidArgument);
        }
        if &tx_data[TX_MULTISIG..TX_MULTISIG + 32] != multisig_account.address().as_array() {
            return Err(ProgramError::InvalidArgument);
        }
    }

    // Create ApprovalRecord PDA (prevents double voting).
    let ar_bump_byte = [approval_record_bump];
    let member_key = member.address().as_array();
    let tx_key = tx_account.address().as_array();
    let ar_signer_seeds = [
        pinocchio::cpi::Seed::from(b"approval" as &[u8]),
        pinocchio::cpi::Seed::from(tx_key.as_ref()),
        pinocchio::cpi::Seed::from(member_key.as_ref()),
        pinocchio::cpi::Seed::from(ar_bump_byte.as_ref()),
    ];
    let ar_signer = Signer::from(&ar_signer_seeds);

    CreateAccount {
        from: payer,
        to: approval_record_account,
        lamports: minimum_balance(APPROVAL_RECORD_LEN),
        space: APPROVAL_RECORD_LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[ar_signer])?;

    // Write ApprovalRecord fields.
    {
        let ar_data = unsafe { approval_record_account.borrow_unchecked_mut() };
        ar_data[0] = APPROVAL_RECORD_DISCRIMINATOR;
        ar_data[1] = 1; // version
        ar_data[AR_MEMBER..AR_MEMBER + 32].copy_from_slice(member_key);
        ar_data[AR_TRANSACTION..AR_TRANSACTION + 32].copy_from_slice(tx_key);
        ar_data[AR_APPROVED] = 0; // rejected
        ar_data[AR_BUMP] = approval_record_bump;
    }

    // Increment rejection count.
    let tx_data = unsafe { tx_account.borrow_unchecked_mut() };
    let current_rejections = u16::from_le_bytes(
        tx_data[TX_REJECTION_COUNT..TX_REJECTION_COUNT + 2]
            .try_into()
            .map_err(|_| ProgramError::InvalidAccountData)?,
    );
    let new_rejections = current_rejections
        .checked_add(1)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    tx_data[TX_REJECTION_COUNT..TX_REJECTION_COUNT + 2]
        .copy_from_slice(&new_rejections.to_le_bytes());

    // Check if rejection threshold reached: member_count - threshold + 1
    let threshold = u16::from_le_bytes(
        ms_data[MS_THRESHOLD..MS_THRESHOLD + 2]
            .try_into()
            .map_err(|_| ProgramError::InvalidAccountData)?,
    );
    let member_count = u16::from_le_bytes(
        ms_data[MS_MEMBER_COUNT..MS_MEMBER_COUNT + 2]
            .try_into()
            .map_err(|_| ProgramError::InvalidAccountData)?,
    );

    // Rejection threshold: if enough members reject that threshold can never be reached.
    let rejection_threshold = member_count
        .checked_sub(threshold)
        .ok_or(ProgramError::ArithmeticOverflow)?
        .checked_add(1)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    if new_rejections >= rejection_threshold {
        tx_data[TX_STATUS] = STATUS_REJECTED;
    }

    Ok(())
}
