// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! Example: Multisig-controlled dWallet signing with future sign (native version).
//!
//! A native Solana program demonstrating m-of-n multisig control over dWallets via
//! the CPI authority pattern. This is the native (`solana-program`) equivalent of
//! the Pinocchio `ika-example-multisig` program.
//!
//! # Instructions
//!
//! - `0` -- **CreateMultisig**: create a Multisig PDA with members and threshold.
//! - `1` -- **CreateTransaction**: propose a transaction referencing a dWallet message.
//! - `2` -- **Approve**: approve a transaction; when threshold reached, CPI-signs.
//! - `3` -- **Reject**: reject a transaction; when threshold rejections, mark rejected.

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

use ika_dwallet_native::DWalletContext;

entrypoint!(process_instruction);

pub const ID: Pubkey = Pubkey::new_from_array([6u8; 32]);

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
const TRANSACTION_LEN: usize = 2 + 32 + 4 + 32 + 32 + 32 + 1 + 2 + 2 + 1 + 1 + 32 + 1 + 2 + 256; // 432
const APPROVAL_RECORD_LEN: usize = 2 + 32 + 32 + 1 + 1; // 68

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

fn is_member(ms_data: &[u8], member: &[u8; 32]) -> bool {
    let count = u16::from_le_bytes(
        ms_data[MS_MEMBER_COUNT..MS_MEMBER_COUNT + 2].try_into().unwrap_or([0, 0]),
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
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> Result<(), ProgramError> {
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

fn create_multisig(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> Result<(), ProgramError> {
    if data.len() < 69 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let accounts_iter = &mut accounts.iter();
    let multisig_account = next_account_info(accounts_iter)?;
    let creator = next_account_info(accounts_iter)?;
    let payer = next_account_info(accounts_iter)?;
    let _system_program = next_account_info(accounts_iter)?;

    if !creator.is_signer || !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let create_key: [u8; 32] = data[0..32].try_into().map_err(|_| ProgramError::InvalidInstructionData)?;
    let dwallet: [u8; 32] = data[32..64].try_into().map_err(|_| ProgramError::InvalidInstructionData)?;
    let threshold = u16::from_le_bytes(data[64..66].try_into().map_err(|_| ProgramError::InvalidInstructionData)?);
    let member_count = u16::from_le_bytes(data[66..68].try_into().map_err(|_| ProgramError::InvalidInstructionData)?);
    let bump = data[68];

    if threshold == 0 || member_count == 0 || threshold > member_count || member_count as usize > MAX_MEMBERS {
        return Err(ProgramError::InvalidInstructionData);
    }

    let members_data_len = (member_count as usize) * 32;
    if data.len() < 69 + members_data_len {
        return Err(ProgramError::InvalidInstructionData);
    }

    let rent = Rent::get()?;
    invoke_signed(
        &system_instruction::create_account(
            payer.key, multisig_account.key,
            rent.minimum_balance(MULTISIG_LEN),
            MULTISIG_LEN as u64, program_id,
        ),
        &[payer.clone(), multisig_account.clone()],
        &[&[b"multisig", create_key.as_ref(), &[bump]]],
    )?;

    let mut ms_data = multisig_account.try_borrow_mut_data()?;
    ms_data[0] = MULTISIG_DISCRIMINATOR;
    ms_data[1] = 1;
    ms_data[MS_CREATE_KEY..MS_CREATE_KEY + 32].copy_from_slice(&create_key);
    ms_data[MS_THRESHOLD..MS_THRESHOLD + 2].copy_from_slice(&threshold.to_le_bytes());
    ms_data[MS_MEMBER_COUNT..MS_MEMBER_COUNT + 2].copy_from_slice(&member_count.to_le_bytes());
    ms_data[MS_TX_INDEX..MS_TX_INDEX + 4].copy_from_slice(&0u32.to_le_bytes());
    ms_data[MS_DWALLET..MS_DWALLET + 32].copy_from_slice(&dwallet);
    ms_data[MS_BUMP] = bump;
    for i in 0..member_count as usize {
        let src = 69 + (i * 32);
        let dst = MS_MEMBERS + (i * 32);
        ms_data[dst..dst + 32].copy_from_slice(&data[src..src + 32]);
    }

    Ok(())
}

fn create_transaction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> Result<(), ProgramError> {
    if data.len() < 101 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let accounts_iter = &mut accounts.iter();
    let multisig_account = next_account_info(accounts_iter)?;
    let tx_account = next_account_info(accounts_iter)?;
    let proposer = next_account_info(accounts_iter)?;
    let payer = next_account_info(accounts_iter)?;
    let _system_program = next_account_info(accounts_iter)?;

    if !proposer.is_signer || !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let ms_data = multisig_account.try_borrow_data()?;
    if ms_data.len() < MULTISIG_LEN || ms_data[0] != MULTISIG_DISCRIMINATOR {
        return Err(ProgramError::InvalidAccountData);
    }
    if !is_member(&ms_data, &proposer.key.to_bytes()) {
        return Err(ProgramError::InvalidArgument);
    }

    let message_hash: [u8; 32] = data[0..32].try_into().map_err(|_| ProgramError::InvalidInstructionData)?;
    let user_pubkey: [u8; 32] = data[32..64].try_into().map_err(|_| ProgramError::InvalidInstructionData)?;
    let signature_scheme = data[64];
    let message_approval_bump = data[65];
    let partial_user_sig: [u8; 32] = data[66..98].try_into().map_err(|_| ProgramError::InvalidInstructionData)?;
    let tx_bump = data[98];
    let message_data_len = u16::from_le_bytes(data[99..101].try_into().map_err(|_| ProgramError::InvalidInstructionData)?);
    if message_data_len > 256 || data.len() < 101 + message_data_len as usize {
        return Err(ProgramError::InvalidInstructionData);
    }

    let tx_index = u32::from_le_bytes(ms_data[MS_TX_INDEX..MS_TX_INDEX + 4].try_into().map_err(|_| ProgramError::InvalidAccountData)?);
    let tx_index_bytes = tx_index.to_le_bytes();
    let ms_key = multisig_account.key.to_bytes();

    drop(ms_data); // release borrow before CPI

    let rent = Rent::get()?;
    invoke_signed(
        &system_instruction::create_account(
            payer.key, tx_account.key,
            rent.minimum_balance(TRANSACTION_LEN),
            TRANSACTION_LEN as u64, program_id,
        ),
        &[payer.clone(), tx_account.clone()],
        &[&[b"transaction", ms_key.as_ref(), tx_index_bytes.as_ref(), &[tx_bump]]],
    )?;

    let mut tx_data = tx_account.try_borrow_mut_data()?;
    tx_data[0] = TRANSACTION_DISCRIMINATOR;
    tx_data[1] = 1;
    tx_data[TX_MULTISIG..TX_MULTISIG + 32].copy_from_slice(&ms_key);
    tx_data[TX_INDEX..TX_INDEX + 4].copy_from_slice(&tx_index_bytes);
    tx_data[TX_PROPOSER..TX_PROPOSER + 32].copy_from_slice(&proposer.key.to_bytes());
    tx_data[TX_MESSAGE_HASH..TX_MESSAGE_HASH + 32].copy_from_slice(&message_hash);
    tx_data[TX_USER_PUBKEY..TX_USER_PUBKEY + 32].copy_from_slice(&user_pubkey);
    tx_data[TX_SIGNATURE_SCHEME] = signature_scheme;
    tx_data[TX_APPROVAL_COUNT..TX_APPROVAL_COUNT + 2].copy_from_slice(&0u16.to_le_bytes());
    tx_data[TX_REJECTION_COUNT..TX_REJECTION_COUNT + 2].copy_from_slice(&0u16.to_le_bytes());
    tx_data[TX_STATUS] = STATUS_ACTIVE;
    tx_data[TX_MSG_APPROVAL_BUMP] = message_approval_bump;
    tx_data[TX_PARTIAL_USER_SIG..TX_PARTIAL_USER_SIG + 32].copy_from_slice(&partial_user_sig);
    tx_data[TX_BUMP] = tx_bump;
    tx_data[TX_MESSAGE_DATA_LEN..TX_MESSAGE_DATA_LEN + 2].copy_from_slice(&message_data_len.to_le_bytes());
    if message_data_len > 0 {
        tx_data[TX_MESSAGE_DATA..TX_MESSAGE_DATA + message_data_len as usize]
            .copy_from_slice(&data[101..101 + message_data_len as usize]);
    }

    drop(tx_data);

    // Increment tx_index.
    let mut ms_data = multisig_account.try_borrow_mut_data()?;
    let new_index = tx_index.checked_add(1).ok_or(ProgramError::ArithmeticOverflow)?;
    ms_data[MS_TX_INDEX..MS_TX_INDEX + 4].copy_from_slice(&new_index.to_le_bytes());

    Ok(())
}

fn approve(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> Result<(), ProgramError> {
    if data.len() < 6 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let _tx_index_bytes: [u8; 4] = data[0..4].try_into().map_err(|_| ProgramError::InvalidInstructionData)?;
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

    if !member.is_signer || !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Verify multisig + member.
    let ms_data = multisig_account.try_borrow_data()?;
    if ms_data.len() < MULTISIG_LEN || ms_data[0] != MULTISIG_DISCRIMINATOR {
        return Err(ProgramError::InvalidAccountData);
    }
    if !is_member(&ms_data, &member.key.to_bytes()) {
        return Err(ProgramError::InvalidArgument);
    }
    let threshold = u16::from_le_bytes(ms_data[MS_THRESHOLD..MS_THRESHOLD + 2].try_into().unwrap());
    drop(ms_data);

    // Verify transaction is active.
    {
        let tx_data = tx_account.try_borrow_data()?;
        if tx_data.len() < TRANSACTION_LEN || tx_data[0] != TRANSACTION_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        if tx_data[TX_STATUS] != STATUS_ACTIVE {
            return Err(ProgramError::InvalidArgument);
        }
        if &tx_data[TX_MULTISIG..TX_MULTISIG + 32] != multisig_account.key.as_ref() {
            return Err(ProgramError::InvalidArgument);
        }
    }

    // Create ApprovalRecord PDA.
    let member_key = member.key.to_bytes();
    let tx_key = tx_account.key.to_bytes();

    let rent = Rent::get()?;
    invoke_signed(
        &system_instruction::create_account(
            payer.key, approval_record_account.key,
            rent.minimum_balance(APPROVAL_RECORD_LEN),
            APPROVAL_RECORD_LEN as u64, program_id,
        ),
        &[payer.clone(), approval_record_account.clone()],
        &[&[b"approval", tx_key.as_ref(), member_key.as_ref(), &[approval_record_bump]]],
    )?;

    {
        let mut ar_data = approval_record_account.try_borrow_mut_data()?;
        ar_data[0] = APPROVAL_RECORD_DISCRIMINATOR;
        ar_data[1] = 1;
        ar_data[AR_MEMBER..AR_MEMBER + 32].copy_from_slice(&member_key);
        ar_data[AR_TRANSACTION..AR_TRANSACTION + 32].copy_from_slice(&tx_key);
        ar_data[AR_APPROVED] = 1;
        ar_data[AR_BUMP] = approval_record_bump;
    }

    // Increment approval count.
    let new_approvals = {
        let mut tx_data = tx_account.try_borrow_mut_data()?;
        let current = u16::from_le_bytes(tx_data[TX_APPROVAL_COUNT..TX_APPROVAL_COUNT + 2].try_into().unwrap());
        let new_count = current.checked_add(1).ok_or(ProgramError::ArithmeticOverflow)?;
        tx_data[TX_APPROVAL_COUNT..TX_APPROVAL_COUNT + 2].copy_from_slice(&new_count.to_le_bytes());
        new_count
    };

    // If threshold reached, CPI approve_message + optional transfer_future_sign.
    if new_approvals >= threshold {
        if accounts.len() < 11 {
            return Err(ProgramError::NotEnoughAccountKeys);
        }

        let message_approval = &accounts[6];
        let dwallet = &accounts[7];
        let caller_program = &accounts[8];
        let cpi_authority = &accounts[9];
        let dwallet_program = &accounts[10];

        let tx_data = tx_account.try_borrow_data()?;
        let mut message_hash = [0u8; 32];
        message_hash.copy_from_slice(&tx_data[TX_MESSAGE_HASH..TX_MESSAGE_HASH + 32]);
        let mut user_pubkey = [0u8; 32];
        user_pubkey.copy_from_slice(&tx_data[TX_USER_PUBKEY..TX_USER_PUBKEY + 32]);
        let signature_scheme = tx_data[TX_SIGNATURE_SCHEME];
        let message_approval_bump = tx_data[TX_MSG_APPROVAL_BUMP];
        let mut partial_user_sig_bytes = [0u8; 32];
        partial_user_sig_bytes.copy_from_slice(&tx_data[TX_PARTIAL_USER_SIG..TX_PARTIAL_USER_SIG + 32]);
        let mut proposer_key = [0u8; 32];
        proposer_key.copy_from_slice(&tx_data[TX_PROPOSER..TX_PROPOSER + 32]);
        drop(tx_data);

        let ctx = DWalletContext {
            dwallet_program,
            cpi_authority,
            caller_program,
            cpi_authority_bump,
        };

        ctx.approve_message(
            message_approval, dwallet, payer, system_program,
            message_hash, user_pubkey, signature_scheme, message_approval_bump,
        )?;

        if partial_user_sig_bytes != [0u8; 32] {
            if accounts.len() < 12 {
                return Err(ProgramError::NotEnoughAccountKeys);
            }
            let partial_user_sig_account = &accounts[11];
            ctx.transfer_future_sign(
                partial_user_sig_account,
                &Pubkey::new_from_array(proposer_key),
            )?;
        }

        // Mark approved.
        let mut tx_data = tx_account.try_borrow_mut_data()?;
        tx_data[TX_STATUS] = STATUS_APPROVED;
    }

    Ok(())
}

fn reject(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> Result<(), ProgramError> {
    if data.len() < 5 {
        return Err(ProgramError::InvalidInstructionData);
    }

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

    if !member.is_signer || !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let ms_data = multisig_account.try_borrow_data()?;
    if ms_data.len() < MULTISIG_LEN || ms_data[0] != MULTISIG_DISCRIMINATOR {
        return Err(ProgramError::InvalidAccountData);
    }
    if !is_member(&ms_data, &member.key.to_bytes()) {
        return Err(ProgramError::InvalidArgument);
    }
    let threshold = u16::from_le_bytes(ms_data[MS_THRESHOLD..MS_THRESHOLD + 2].try_into().unwrap());
    let member_count = u16::from_le_bytes(ms_data[MS_MEMBER_COUNT..MS_MEMBER_COUNT + 2].try_into().unwrap());
    drop(ms_data);

    {
        let tx_data = tx_account.try_borrow_data()?;
        if tx_data.len() < TRANSACTION_LEN || tx_data[0] != TRANSACTION_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        if tx_data[TX_STATUS] != STATUS_ACTIVE {
            return Err(ProgramError::InvalidArgument);
        }
        if &tx_data[TX_MULTISIG..TX_MULTISIG + 32] != multisig_account.key.as_ref() {
            return Err(ProgramError::InvalidArgument);
        }
    }

    let member_key = member.key.to_bytes();
    let tx_key = tx_account.key.to_bytes();

    let rent = Rent::get()?;
    invoke_signed(
        &system_instruction::create_account(
            payer.key, approval_record_account.key,
            rent.minimum_balance(APPROVAL_RECORD_LEN),
            APPROVAL_RECORD_LEN as u64, program_id,
        ),
        &[payer.clone(), approval_record_account.clone()],
        &[&[b"approval", tx_key.as_ref(), member_key.as_ref(), &[approval_record_bump]]],
    )?;

    {
        let mut ar_data = approval_record_account.try_borrow_mut_data()?;
        ar_data[0] = APPROVAL_RECORD_DISCRIMINATOR;
        ar_data[1] = 1;
        ar_data[AR_MEMBER..AR_MEMBER + 32].copy_from_slice(&member_key);
        ar_data[AR_TRANSACTION..AR_TRANSACTION + 32].copy_from_slice(&tx_key);
        ar_data[AR_APPROVED] = 0;
        ar_data[AR_BUMP] = approval_record_bump;
    }

    let mut tx_data = tx_account.try_borrow_mut_data()?;
    let current = u16::from_le_bytes(tx_data[TX_REJECTION_COUNT..TX_REJECTION_COUNT + 2].try_into().unwrap());
    let new_rejections = current.checked_add(1).ok_or(ProgramError::ArithmeticOverflow)?;
    tx_data[TX_REJECTION_COUNT..TX_REJECTION_COUNT + 2].copy_from_slice(&new_rejections.to_le_bytes());

    let rejection_threshold = member_count.checked_sub(threshold)
        .ok_or(ProgramError::ArithmeticOverflow)?
        .checked_add(1)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    if new_rejections >= rejection_threshold {
        tx_data[TX_STATUS] = STATUS_REJECTED;
    }

    Ok(())
}
