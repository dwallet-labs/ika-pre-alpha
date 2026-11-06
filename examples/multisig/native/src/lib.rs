// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! Example: Multisig-controlled dWallet signing with future sign (native
//! `solana-program` version).
//!
//! A native Solana program demonstrating m-of-n multisig control over dWallets
//! via the CPI authority pattern. Transactions are proposed with message data
//! stored directly on-chain so other signers can inspect them. When enough
//! members approve (reaching threshold), the program CPI-calls
//! `issue_signature_voucher` or `issue_future_signature_voucher` on the dWallet
//! program. The voucher sits at this program's PDA
//! `["signature_voucher", transaction]`, and the program signs for it.
//!
//! This is the native equivalent of the Pinocchio `ika-example-multisig`
//! program; see that crate's docs for why the multisig is bound to its dWallet
//! (one CPI authority PDA per program means a multisig instance must not be
//! able to reach any dWallet other than its own).
//!
//! # Instructions
//!
//! - `0` -- **CreateMultisig**: the dWallet owner fixes members and threshold for a dWallet.
//! - `1` -- **CreateTransaction**: a member proposes a transaction referencing a dWallet message.
//! - `2` -- **Approve**: approve a transaction; when threshold reached, CPI-signs.
//! - `3` -- **Reject**: reject a transaction; when threshold rejections, mark rejected.
//!
//! # Account Layouts
//!
//! **Multisig** PDA (`["multisig", dwallet]`):
//!   disc(1) + version(1) + dwallet(32) + threshold(2) + member_count(2) +
//!   tx_index(4) + bump(1) + members(32*10) = 363 bytes
//!
//! **Transaction** PDA (`["transaction", multisig, tx_index_bytes]`):
//!   disc(1) + version(1) + multisig(32) + tx_index(4) + proposer(32) +
//!   message_hash(32) + user_pubkey(32) + signature_scheme(2) +
//!   approval_count(2) + rejection_count(2) + status(1) +
//!   signature_voucher_bump(1) + future_sign(1) + bump(1) +
//!   message_data_len(2) + message_data(256) = 402 bytes
//!
//! **ApprovalRecord** PDA (`["approval", transaction, member]`):
//!   disc(1) + version(1) + member(32) + transaction(32) + approved(1) +
//!   bump(1) = 68 bytes

use solana_program::{
    account_info::AccountInfo, entrypoint, program::invoke_signed, program_error::ProgramError,
    pubkey::Pubkey, rent::Rent, system_instruction, sysvar::Sysvar,
};

use ika_dwallet_native::{DWalletContext, ID as IKA_PROGRAM_ID};

entrypoint!(process_instruction);

// Placeholder program ID -- replace with actual keypair before deployment.
pub const ID: Pubkey = Pubkey::new_from_array([6u8; 32]);

/// Maximum number of members in a multisig.
pub const MAX_MEMBERS: usize = 10;

// -- Discriminators --
const MULTISIG_DISCRIMINATOR: u8 = 1;
const TRANSACTION_DISCRIMINATOR: u8 = 2;
const APPROVAL_RECORD_DISCRIMINATOR: u8 = 3;

/// Discriminator of a `DWallet` account in the dWallet program.
// The merged program ranges account discriminators by subsystem; the
// dWallet record is 97, not 2.
const DWALLET_ACCOUNT_DISCRIMINATOR: u8 = 97;
/// Offset of the `owner` field inside a `DWallet` account (after the
/// 2-byte discriminator + version header).
const DWALLET_OWNER_OFFSET: usize = 2;

// -- Status values --
const STATUS_ACTIVE: u8 = 0;
const STATUS_APPROVED: u8 = 1;
const STATUS_REJECTED: u8 = 2;

// -- Account sizes --
const MULTISIG_LEN: usize = 2 + 32 + 2 + 2 + 4 + 1 + (32 * MAX_MEMBERS); // 363
const TRANSACTION_LEN: usize = 2 + 32 + 4 + 32 + 32 + 32 + 2 + 2 + 2 + 1 + 1 + 1 + 1 + 2 + 256; // 402
const APPROVAL_RECORD_LEN: usize = 2 + 32 + 32 + 1 + 1; // 68

// -- Multisig offsets (after 2-byte header) --
const MS_DWALLET: usize = 2;
const MS_THRESHOLD: usize = 34;
const MS_MEMBER_COUNT: usize = 36;
const MS_TX_INDEX: usize = 38;
const MS_BUMP: usize = 42;
const MS_MEMBERS: usize = 43;

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
const TX_SIGNATURE_VOUCHER_BUMP: usize = 141;
const TX_FUTURE_SIGN: usize = 142;
const TX_BUMP: usize = 143;
const TX_MESSAGE_DATA_LEN: usize = 144;
const TX_MESSAGE_DATA: usize = 146;

// -- ApprovalRecord offsets (after 2-byte header) --
const AR_MEMBER: usize = 2;
const AR_TRANSACTION: usize = 34;
const AR_APPROVED: usize = 66;
const AR_BUMP: usize = 67;

/// Program-specific errors (surfaced as `ProgramError::Custom(code)`).
#[repr(u32)]
pub enum MultisigError {
    /// The signer is not a member of the multisig.
    NotAMember = 0,
    /// The dWallet account passed is not the multisig's dWallet.
    DWalletMismatch = 1,
    // 2 was `PartialUserSigMismatch`, for the retired partial user
    // signature account.
    /// The signer is not the dWallet's current owner.
    NotDWalletOwner = 3,
    /// The dWallet account is not a `DWallet` owned by the dWallet program.
    InvalidDWalletAccount = 4,
    /// Threshold must be > 0 and <= member count.
    InvalidThreshold = 5,
    /// The member list contains a duplicate.
    DuplicateMember = 6,
    /// The transaction is not active.
    TransactionNotActive = 7,
    /// The transaction does not belong to this multisig.
    TransactionMismatch = 8,
    /// The multisig account is not the multisig PDA for its dWallet.
    InvalidMultisig = 9,
    /// The signature voucher bump is not the canonical bump of this
    /// program's `["signature_voucher", transaction]` PDA.
    InvalidVoucherBump = 10,
    /// The signature voucher account is not this program's
    /// `["signature_voucher", transaction]` PDA.
    VoucherMismatch = 11,
    /// A PDA bump is not the canonical bump of its seeds.
    InvalidBump = 12,
}

impl From<MultisigError> for ProgramError {
    fn from(error: MultisigError) -> Self {
        ProgramError::Custom(error as u32)
    }
}

/// Read a `[u8; 32]` field at `offset`.
fn read_key(data: &[u8], offset: usize) -> Result<[u8; 32], ProgramError> {
    data.get(offset..)
        .and_then(|tail| tail.first_chunk::<32>())
        .copied()
        .ok_or(ProgramError::InvalidAccountData)
}

fn read_u16(data: &[u8], offset: usize) -> Result<u16, ProgramError> {
    data.get(offset..)
        .and_then(|tail| tail.first_chunk::<2>())
        .map(|bytes| u16::from_le_bytes(*bytes))
        .ok_or(ProgramError::InvalidAccountData)
}

fn read_u32(data: &[u8], offset: usize) -> Result<u32, ProgramError> {
    data.get(offset..)
        .and_then(|tail| tail.first_chunk::<4>())
        .map(|bytes| u32::from_le_bytes(*bytes))
        .ok_or(ProgramError::InvalidAccountData)
}

/// Check if a pubkey is a member of the multisig.
fn is_member(ms_data: &[u8], member: &[u8; 32]) -> bool {
    let count = read_u16(ms_data, MS_MEMBER_COUNT).unwrap_or(0) as usize;
    ms_data[MS_MEMBERS..]
        .chunks(32)
        .take(count)
        .any(|candidate| candidate == member)
}

/// Refuse `bump` unless it is the canonical bump of the PDA at `seeds`.
///
/// A record that exists once per key (a proposal, a vote, a transaction, an
/// approval) is guarded by its address: creating it a second time fails
/// because the account already exists. That holds only at ONE address. A
/// client-chosen bump other than the canonical one derives a second valid
/// address for the same seeds, where the record does not exist yet, and a
/// member could vote twice. So the program derives the canonical bump itself
/// and takes no other.
fn require_canonical_bump(
    seeds: &[&[u8]],
    bump: u8,
    program_id: &Pubkey,
) -> Result<(), ProgramError> {
    let (_, canonical) = Pubkey::find_program_address(seeds, program_id);
    if bump != canonical {
        return Err(MultisigError::InvalidBump.into());
    }
    Ok(())
}

/// Return the `owner` of a `DWallet` account after checking that the
/// account really is a `DWallet` owned by the (executable) dWallet program.
fn dwallet_owner(
    dwallet: &AccountInfo,
    dwallet_program: &AccountInfo,
) -> Result<[u8; 32], ProgramError> {
    // The dWallet program must be ika's own, the address this program was
    // built for: a dWallet account of any other program is anyone's word.
    if dwallet_program.key != &IKA_PROGRAM_ID
        || !dwallet_program.executable
        || dwallet.owner != &IKA_PROGRAM_ID
    {
        return Err(MultisigError::InvalidDWalletAccount.into());
    }
    let data = dwallet.try_borrow_data()?;
    if data.first() != Some(&DWALLET_ACCOUNT_DISCRIMINATOR) {
        return Err(MultisigError::InvalidDWalletAccount.into());
    }
    read_key(&data, DWALLET_OWNER_OFFSET).map_err(|_| MultisigError::InvalidDWalletAccount.into())
}

/// Check that `multisig` is a program-owned, multisig-typed account at the
/// canonical `["multisig", dwallet]` address recorded by its stored bump.
fn verify_multisig(program_id: &Pubkey, multisig: &AccountInfo) -> Result<(), ProgramError> {
    if multisig.owner != program_id {
        return Err(MultisigError::InvalidMultisig.into());
    }
    let data = multisig.try_borrow_data()?;
    if data.len() < MULTISIG_LEN || data[0] != MULTISIG_DISCRIMINATOR {
        return Err(MultisigError::InvalidMultisig.into());
    }
    let dwallet = read_key(&data, MS_DWALLET)?;
    let bump = [data[MS_BUMP]];
    let expected =
        Pubkey::create_program_address(&[b"multisig", dwallet.as_ref(), &bump], program_id)
            .map_err(|_| MultisigError::InvalidMultisig)?;
    if multisig.key != &expected {
        return Err(MultisigError::InvalidMultisig.into());
    }
    Ok(())
}

/// Create a program-owned account at a PDA via the system program.
fn create_pda_account<'a>(
    program_id: &Pubkey,
    payer: &AccountInfo<'a>,
    new_account: &AccountInfo<'a>,
    system_program: &AccountInfo<'a>,
    space: usize,
    signer_seeds: &[&[u8]],
) -> Result<(), ProgramError> {
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(space);
    let create_ix = system_instruction::create_account(
        payer.key,
        new_account.key,
        lamports,
        space as u64,
        program_id,
    );
    invoke_signed(
        &create_ix,
        &[payer.clone(), new_account.clone(), system_program.clone()],
        &[signer_seeds],
    )
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

/// Create the multisig for a dWallet.
///
/// Must be called by the dWallet's CURRENT owner, before that ownership is
/// transferred to this program's CPI authority PDA. The multisig PDA is unique
/// per dWallet, so this is the one place the member set and threshold are fixed.
///
/// # Instruction Data
///
/// `[threshold(2), member_count(2), members(32*member_count)]`
///
/// # Accounts
///
/// 0. `[writable]`          Multisig PDA (seeds: `["multisig", dwallet]`, canonical bump)
/// 1. `[readonly]`          dWallet account (owned by the dWallet program)
/// 2. `[readonly]`          dWallet program (executable)
/// 3. `[signer]`            dWallet owner
/// 4. `[writable, signer]`  Payer
/// 5. `[readonly]`          System program
fn create_multisig(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> Result<(), ProgramError> {
    if data.len() < 4 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let [
        multisig_account,
        dwallet,
        dwallet_program,
        owner,
        payer,
        system_program,
        ..,
    ] = accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !owner.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !payer.is_signer || !payer.is_writable {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let threshold = u16::from_le_bytes(
        data[0..2]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    let member_count = u16::from_le_bytes(
        data[2..4]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );

    // Validate inputs.
    if member_count == 0 || member_count as usize > MAX_MEMBERS {
        return Err(ProgramError::InvalidInstructionData);
    }
    if threshold == 0 || threshold > member_count {
        return Err(MultisigError::InvalidThreshold.into());
    }
    let members_len = (member_count as usize)
        .checked_mul(32)
        .ok_or(ProgramError::InvalidInstructionData)?;
    let members = data
        .get(4..)
        .and_then(|tail| tail.get(..members_len))
        .ok_or(ProgramError::InvalidInstructionData)?;
    let has_duplicate = members.chunks(32).enumerate().any(|(index, member)| {
        members
            .chunks(32)
            .skip(index)
            .skip(1)
            .any(|other| other == member)
    });
    if has_duplicate {
        return Err(MultisigError::DuplicateMember.into());
    }

    // Only the dWallet's current owner may fix its governance.
    if dwallet_owner(dwallet, dwallet_program)? != owner.key.to_bytes() {
        return Err(MultisigError::NotDWalletOwner.into());
    }

    // Create Multisig PDA at the canonical bump.
    let (expected, bump) =
        Pubkey::find_program_address(&[b"multisig", dwallet.key.as_ref()], program_id);
    if multisig_account.key != &expected {
        return Err(MultisigError::InvalidMultisig.into());
    }
    let signer_seeds: &[&[u8]] = &[b"multisig", dwallet.key.as_ref(), &[bump]];
    create_pda_account(
        program_id,
        payer,
        multisig_account,
        system_program,
        MULTISIG_LEN,
        signer_seeds,
    )?;

    // Write Multisig fields.
    let mut ms_data = multisig_account.try_borrow_mut_data()?;
    ms_data[0] = MULTISIG_DISCRIMINATOR;
    ms_data[1] = 1; // version

    ms_data[MS_DWALLET..MS_DWALLET + 32].copy_from_slice(dwallet.key.as_ref());
    ms_data[MS_THRESHOLD..MS_THRESHOLD + 2].copy_from_slice(&threshold.to_le_bytes());
    ms_data[MS_MEMBER_COUNT..MS_MEMBER_COUNT + 2].copy_from_slice(&member_count.to_le_bytes());
    ms_data[MS_TX_INDEX..MS_TX_INDEX + 4].copy_from_slice(&0u32.to_le_bytes());
    ms_data[MS_BUMP] = bump;
    ms_data[MS_MEMBERS..][..members_len].copy_from_slice(members);

    Ok(())
}

/// Create a transaction proposal.
///
/// # Instruction Data
///
/// `[message_hash(32), user_pubkey(32), signature_scheme(2),
///   signature_voucher_bump(1), future_sign(1), tx_bump(1),
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
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> Result<(), ProgramError> {
    if data.len() < 71 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let [
        multisig_account,
        tx_account,
        proposer,
        payer,
        system_program,
        ..,
    ] = accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !proposer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !payer.is_signer || !payer.is_writable {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Verify multisig and that the proposer is a member; read the tx index.
    verify_multisig(program_id, multisig_account)?;
    let tx_index = {
        let ms_data = multisig_account.try_borrow_data()?;
        if !is_member(&ms_data, &proposer.key.to_bytes()) {
            return Err(MultisigError::NotAMember.into());
        }
        read_u32(&ms_data, MS_TX_INDEX)?
    };

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
    let signature_voucher_bump = data[66];
    // The voucher's address is this program's PDA for the transaction, and the
    // program signs for it with the stored bump when the threshold is reached. A
    // non-canonical bump would put the voucher at an address clients do not
    // compute, so only the canonical one is accepted.
    let (_, canonical_voucher_bump) =
        Pubkey::find_program_address(&[b"signature_voucher", tx_account.key.as_ref()], program_id);
    if signature_voucher_bump != canonical_voucher_bump {
        return Err(MultisigError::InvalidVoucherBump.into());
    }
    // 1 issues a future signature voucher when the threshold is reached,
    // 0 a signature voucher.
    let future_sign = match data[67] {
        0 => false,
        1 => true,
        _ => return Err(ProgramError::InvalidInstructionData),
    };
    let tx_bump = data[68];
    let message_data_len = u16::from_le_bytes(
        data[69..71]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );

    if message_data_len > 256 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let message_data = data
        .get(71..)
        .and_then(|tail| tail.get(..message_data_len as usize))
        .ok_or(ProgramError::InvalidInstructionData)?;

    // Create Transaction PDA.
    let tx_index_bytes = tx_index.to_le_bytes();
    require_canonical_bump(
        &[
            b"transaction",
            multisig_account.key.as_ref(),
            tx_index_bytes.as_ref(),
        ],
        tx_bump,
        program_id,
    )?;
    let signer_seeds: &[&[u8]] = &[
        b"transaction",
        multisig_account.key.as_ref(),
        tx_index_bytes.as_ref(),
        &[tx_bump],
    ];
    create_pda_account(
        program_id,
        payer,
        tx_account,
        system_program,
        TRANSACTION_LEN,
        signer_seeds,
    )?;

    // Write Transaction fields.
    {
        let mut tx_data = tx_account.try_borrow_mut_data()?;
        tx_data[0] = TRANSACTION_DISCRIMINATOR;
        tx_data[1] = 1; // version

        tx_data[TX_MULTISIG..TX_MULTISIG + 32].copy_from_slice(multisig_account.key.as_ref());
        tx_data[TX_INDEX..TX_INDEX + 4].copy_from_slice(&tx_index_bytes);
        tx_data[TX_PROPOSER..TX_PROPOSER + 32].copy_from_slice(proposer.key.as_ref());
        tx_data[TX_MESSAGE_HASH..TX_MESSAGE_HASH + 32].copy_from_slice(&message_hash);
        tx_data[TX_USER_PUBKEY..TX_USER_PUBKEY + 32].copy_from_slice(&user_pubkey);
        tx_data[TX_SIGNATURE_SCHEME..TX_SIGNATURE_SCHEME + 2]
            .copy_from_slice(&signature_scheme.to_le_bytes());
        tx_data[TX_APPROVAL_COUNT..TX_APPROVAL_COUNT + 2].copy_from_slice(&0u16.to_le_bytes());
        tx_data[TX_REJECTION_COUNT..TX_REJECTION_COUNT + 2].copy_from_slice(&0u16.to_le_bytes());
        tx_data[TX_STATUS] = STATUS_ACTIVE;
        tx_data[TX_SIGNATURE_VOUCHER_BUMP] = signature_voucher_bump;
        tx_data[TX_FUTURE_SIGN] = u8::from(future_sign);
        tx_data[TX_BUMP] = tx_bump;
        tx_data[TX_MESSAGE_DATA_LEN..TX_MESSAGE_DATA_LEN + 2]
            .copy_from_slice(&message_data_len.to_le_bytes());
        tx_data[TX_MESSAGE_DATA..][..message_data.len()].copy_from_slice(message_data);
    }

    // Increment tx_index on multisig.
    let mut ms_data = multisig_account.try_borrow_mut_data()?;
    let new_index = tx_index
        .checked_add(1)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    ms_data[MS_TX_INDEX..MS_TX_INDEX + 4].copy_from_slice(&new_index.to_le_bytes());

    Ok(())
}

/// Common prologue of `approve` and `reject`: signer/writability checks,
/// multisig validity + membership, transaction validity, and the
/// ApprovalRecord creation (which is what prevents double voting).
/// Returns the multisig's `(threshold, member_count)`.
fn record_vote<'a>(
    program_id: &Pubkey,
    multisig_account: &AccountInfo<'a>,
    tx_account: &AccountInfo<'a>,
    approval_record_account: &AccountInfo<'a>,
    member: &AccountInfo<'a>,
    payer: &AccountInfo<'a>,
    system_program: &AccountInfo<'a>,
    approval_record_bump: u8,
    approved: u8,
) -> Result<(u16, u16), ProgramError> {
    if !member.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !payer.is_signer || !payer.is_writable {
        return Err(ProgramError::MissingRequiredSignature);
    }

    verify_multisig(program_id, multisig_account)?;
    let (threshold, member_count) = {
        let ms_data = multisig_account.try_borrow_data()?;
        if !is_member(&ms_data, &member.key.to_bytes()) {
            return Err(MultisigError::NotAMember.into());
        }
        (
            read_u16(&ms_data, MS_THRESHOLD)?,
            read_u16(&ms_data, MS_MEMBER_COUNT)?,
        )
    };

    // Verify transaction is active and belongs to this multisig.
    {
        let tx_data = tx_account.try_borrow_data()?;
        if tx_data.len() < TRANSACTION_LEN || tx_data[0] != TRANSACTION_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        if tx_data[TX_STATUS] != STATUS_ACTIVE {
            return Err(MultisigError::TransactionNotActive.into());
        }
        if tx_data[TX_MULTISIG..TX_MULTISIG + 32] != multisig_account.key.to_bytes() {
            return Err(MultisigError::TransactionMismatch.into());
        }
    }

    // Create ApprovalRecord PDA (prevents double voting).
    require_canonical_bump(
        &[b"approval", tx_account.key.as_ref(), member.key.as_ref()],
        approval_record_bump,
        program_id,
    )?;
    let signer_seeds: &[&[u8]] = &[
        b"approval",
        tx_account.key.as_ref(),
        member.key.as_ref(),
        &[approval_record_bump],
    ];
    create_pda_account(
        program_id,
        payer,
        approval_record_account,
        system_program,
        APPROVAL_RECORD_LEN,
        signer_seeds,
    )?;

    let mut ar_data = approval_record_account.try_borrow_mut_data()?;
    ar_data[0] = APPROVAL_RECORD_DISCRIMINATOR;
    ar_data[1] = 1; // version
    ar_data[AR_MEMBER..AR_MEMBER + 32].copy_from_slice(member.key.as_ref());
    ar_data[AR_TRANSACTION..AR_TRANSACTION + 32].copy_from_slice(tx_account.key.as_ref());
    ar_data[AR_APPROVED] = approved;
    ar_data[AR_BUMP] = approval_record_bump;

    Ok((threshold, member_count))
}

/// Approve a transaction.
///
/// When threshold approvals are reached, CPI-calls `issue_signature_voucher`
/// on the dWallet program, or `issue_future_signature_voucher` for a
/// future sign. The voucher's signing key is the transaction's
/// `user_pubkey`. A signature voucher's owner is this program's CPI
/// authority. A future signature voucher's owner is the proposer, who sets
/// the key that completes the future sign after its first step.
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
/// 7.  `[writable]`          SignatureVoucher, or FutureSignatureVoucher for a future sign: this program's PDA `["signature_voucher", transaction]` (created via CPI)
/// 8.  `[readonly]`          dWallet account (must be the multisig's dWallet)
/// 9.  `[readonly]`          This program account (caller_program for CPI)
/// 10. `[readonly]`          CPI authority PDA (signer via invoke_signed)
/// 11. `[readonly]`          dWallet program
fn approve(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> Result<(), ProgramError> {
    if data.len() < 6 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let approval_record_bump = data[4];
    let cpi_authority_bump = data[5];

    let [
        multisig_account,
        tx_account,
        approval_record_account,
        member,
        payer,
        system_program,
        ..,
    ] = accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    let (threshold, _) = record_vote(
        program_id,
        multisig_account,
        tx_account,
        approval_record_account,
        member,
        payer,
        system_program,
        approval_record_bump,
        1, // approved
    )?;

    // Increment approval count and read what the CPI needs.
    let (
        new_approvals,
        message_hash,
        user_pubkey,
        signature_scheme,
        signature_voucher_bump,
        future_sign,
        proposer_key,
    ) = {
        let mut tx_data = tx_account.try_borrow_mut_data()?;
        let new_approvals = read_u16(&tx_data, TX_APPROVAL_COUNT)?
            .checked_add(1)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        tx_data[TX_APPROVAL_COUNT..TX_APPROVAL_COUNT + 2]
            .copy_from_slice(&new_approvals.to_le_bytes());
        (
            new_approvals,
            read_key(&tx_data, TX_MESSAGE_HASH)?,
            read_key(&tx_data, TX_USER_PUBKEY)?,
            read_u16(&tx_data, TX_SIGNATURE_SCHEME)?,
            tx_data[TX_SIGNATURE_VOUCHER_BUMP],
            tx_data[TX_FUTURE_SIGN] != 0,
            read_key(&tx_data, TX_PROPOSER)?,
        )
    };

    if new_approvals >= threshold {
        let [
            coordinator,
            signature_voucher,
            dwallet,
            caller_program,
            cpi_authority,
            dwallet_program,
            ..,
        ] = &accounts[6..]
        else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };

        // The CPI must target the multisig's dWallet — not whichever dWallet
        // the caller chose to pass.
        let multisig_dwallet = {
            let ms_data = multisig_account.try_borrow_data()?;
            read_key(&ms_data, MS_DWALLET)?
        };
        if dwallet.key.to_bytes() != multisig_dwallet {
            return Err(MultisigError::DWalletMismatch.into());
        }

        // The voucher account must be this program's PDA for the transaction.
        // A signer at another address would also be accepted by the dWallet
        // program, because an outer transaction's signatures carry through
        // the CPI: the voucher would land where no client looks, and the
        // transaction would be spent without a signature anyone can find.
        let expected_voucher = Pubkey::create_program_address(
            &[
                b"signature_voucher",
                tx_account.key.as_ref(),
                &[signature_voucher_bump],
            ],
            program_id,
        )
        .map_err(|_| MultisigError::VoucherMismatch)?;
        if *signature_voucher.key != expected_voucher {
            return Err(MultisigError::VoucherMismatch.into());
        }

        // No message metadata for multisig — use all zeros.
        let message_metadata_digest = [0u8; 32];

        let ctx = DWalletContext {
            dwallet_program,
            cpi_authority,
            caller_program,
            cpi_authority_bump,
        };

        // CPI: issue the voucher that authorizes signing: a future signature
        // voucher, owned by the proposer, for a future sign. The voucher is
        // this program's PDA for the transaction, so the program signs its
        // creation.
        let voucher_seeds: &[&[u8]] = &[
            b"signature_voucher",
            tx_account.key.as_ref(),
            &[signature_voucher_bump],
        ];
        if future_sign {
            ctx.issue_future_signature_voucher(
                coordinator,
                signature_voucher,
                dwallet,
                payer,
                system_program,
                message_hash,
                message_metadata_digest,
                signature_scheme,
                Some(proposer_key),
                Some(user_pubkey),
                Some(voucher_seeds),
            )?;
        } else {
            ctx.issue_signature_voucher(
                coordinator,
                signature_voucher,
                dwallet,
                payer,
                system_program,
                message_hash,
                message_metadata_digest,
                signature_scheme,
                None,
                Some(user_pubkey),
                Some(voucher_seeds),
            )?;
        }

        // Mark transaction as approved.
        let mut tx_data = tx_account.try_borrow_mut_data()?;
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
fn reject(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> Result<(), ProgramError> {
    if data.len() < 5 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let approval_record_bump = data[4];

    let [
        multisig_account,
        tx_account,
        approval_record_account,
        member,
        payer,
        system_program,
        ..,
    ] = accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    let (threshold, member_count) = record_vote(
        program_id,
        multisig_account,
        tx_account,
        approval_record_account,
        member,
        payer,
        system_program,
        approval_record_bump,
        0, // rejected
    )?;

    // Increment rejection count.
    let mut tx_data = tx_account.try_borrow_mut_data()?;
    let new_rejections = read_u16(&tx_data, TX_REJECTION_COUNT)?
        .checked_add(1)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    tx_data[TX_REJECTION_COUNT..TX_REJECTION_COUNT + 2]
        .copy_from_slice(&new_rejections.to_le_bytes());

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
