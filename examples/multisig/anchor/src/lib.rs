// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! Example: Multisig-controlled dWallet signing with future sign (Anchor version).
//!
//! An Anchor program demonstrating m-of-n multisig control over dWallets via
//! the CPI authority pattern. Transactions are proposed with message data stored
//! directly on-chain so other signers can inspect them. When enough members
//! approve (reaching threshold), the program CPI-calls `issue_signature_voucher`
//! or `issue_future_signature_voucher` on the dWallet program. The voucher sits at this
//! program's PDA `["signature_voucher", transaction]`, and the program signs
//! for it.
//!
//! # Why the multisig is bound to its dWallet (read this before copying)
//!
//! The dWallet program authenticates a program caller by ONE PDA per program:
//! `["__ika_cpi_authority"]`. Every dWallet whose owner is that PDA is
//! controlled by this program as a whole — so a multisig instance must not be
//! able to reach any dWallet other than its own. Two rules close that:
//!
//! 1. Exactly one `Multisig` per dWallet, at the PDA `["multisig", dwallet]`,
//!    created by the dWallet's *current* owner (verified against the
//!    dWallet account) BEFORE ownership is transferred to the CPI PDA.
//! 2. At execution the dWallet account passed for the CPI must be the
//!    multisig's dWallet (`address = multisig.dwallet`).
//!
//! This is the Anchor equivalent of the Pinocchio `ika-example-multisig` program.

use anchor_lang::prelude::*;
use ika_dwallet_anchor::{DWalletContext, ID as IKA_PROGRAM_ID};

// Placeholder program ID -- replace with actual keypair before deployment.
declare_id!("7wj8oHHfEM8wxQ9RYZz4rwp4HArDT3RLMiMtzPfabNzD");

const MAX_MEMBERS: usize = 10;
const MAX_MESSAGE_DATA: usize = 256;

/// Discriminator of a `DWallet` account in the dWallet program.
// The merged program ranges account discriminators by subsystem; the
// dWallet record is 97, not 2.
const DWALLET_ACCOUNT_DISCRIMINATOR: u8 = 97;
/// Offset of the `owner` field inside a `DWallet` account (after the
/// 2-byte discriminator + version header).
const DWALLET_OWNER_OFFSET: usize = 2;

#[program]
pub mod multisig_anchor {
    use super::*;

    /// Create the multisig for a dWallet: members list and threshold. Must be
    /// signed by the dWallet's CURRENT owner, before that ownership is
    /// transferred to this program's CPI authority PDA. One multisig per dWallet.
    pub fn create_multisig(
        ctx: Context<CreateMultisig>,
        threshold: u16,
        members: Vec<Pubkey>,
    ) -> Result<()> {
        require!(threshold > 0, MultisigError::InvalidThreshold);
        require!(!members.is_empty(), MultisigError::NoMembers);
        require!(members.len() <= MAX_MEMBERS, MultisigError::TooManyMembers);
        require!(
            threshold <= members.len() as u16,
            MultisigError::InvalidThreshold
        );
        let has_duplicate = members
            .iter()
            .enumerate()
            .any(|(index, member)| members[index.saturating_add(1)..].contains(member));
        require!(!has_duplicate, MultisigError::DuplicateMember);

        // Only the dWallet's current owner may fix its governance.
        let dwallet_data = ctx.accounts.dwallet.try_borrow_data()?;
        require!(
            dwallet_data.first() == Some(&DWALLET_ACCOUNT_DISCRIMINATOR),
            MultisigError::InvalidDWalletAccount
        );
        let stored_owner = dwallet_data
            .get(DWALLET_OWNER_OFFSET..)
            .and_then(|tail| tail.first_chunk::<32>())
            .ok_or(MultisigError::InvalidDWalletAccount)?;
        require!(
            *stored_owner == ctx.accounts.owner.key().to_bytes(),
            MultisigError::NotDWalletOwner
        );

        let ms = &mut ctx.accounts.multisig;
        ms.dwallet = ctx.accounts.dwallet.key();
        ms.threshold = threshold;
        ms.member_count = members.len() as u16;
        ms.tx_index = 0;
        ms.bump = ctx.bumps.multisig;
        ms.members = [Pubkey::default(); MAX_MEMBERS];
        for (i, m) in members.iter().enumerate() {
            ms.members[i] = *m;
        }
        Ok(())
    }

    /// Propose a new transaction for the multisig to approve.
    pub fn create_transaction(
        ctx: Context<CreateTransaction>,
        message_hash: [u8; 32],
        user_pubkey: [u8; 32],
        signature_scheme: u16,
        signature_voucher_bump: u8,
        future_sign: bool,
        message_data: Vec<u8>,
    ) -> Result<()> {
        require!(
            message_data.len() <= MAX_MESSAGE_DATA,
            MultisigError::MessageDataTooLarge
        );

        let ms = &ctx.accounts.multisig;
        let proposer_key = ctx.accounts.proposer.key();

        // Verify proposer is a member.
        require!(
            is_member_anchor(ms, &proposer_key),
            MultisigError::NotAMember
        );

        // The voucher's address is this program's PDA for the transaction,
        // and the program signs for it with the stored bump when the
        // threshold is reached. A non-canonical bump would put the voucher at
        // an address clients do not compute, so only the canonical one is
        // accepted.
        let transaction_key = ctx.accounts.transaction.key();
        let (_, canonical_voucher_bump) = Pubkey::find_program_address(
            &[b"signature_voucher", transaction_key.as_ref()],
            ctx.program_id,
        );
        require!(
            signature_voucher_bump == canonical_voucher_bump,
            MultisigError::InvalidVoucherBump
        );

        let tx = &mut ctx.accounts.transaction;
        tx.multisig = ctx.accounts.multisig.key();
        tx.tx_index = ms.tx_index;
        tx.proposer = proposer_key;
        tx.message_hash = message_hash;
        tx.user_pubkey = user_pubkey;
        tx.signature_scheme = signature_scheme;
        tx.approval_count = 0;
        tx.rejection_count = 0;
        tx.status = TransactionStatus::Active;
        tx.signature_voucher_bump = signature_voucher_bump;
        tx.future_sign = future_sign;
        tx.message_data_len = message_data.len() as u16;
        tx.message_data = [0u8; MAX_MESSAGE_DATA];
        tx.message_data[..message_data.len()].copy_from_slice(&message_data);

        // Increment tx_index on multisig.
        let ms = &mut ctx.accounts.multisig;
        ms.tx_index = ms
            .tx_index
            .checked_add(1)
            .ok_or(error!(MultisigError::ArithmeticOverflow))?;

        Ok(())
    }

    /// Approve a transaction. When threshold is reached, CPI-calls
    /// issue_signature_voucher, or issue_future_signature_voucher for a future
    /// sign, with the transaction's `user_pubkey` as the voucher's signing
    /// key. A future signature voucher's owner is the proposer, who sets the
    /// key that completes the future sign after its first step.
    pub fn approve(ctx: Context<Approve>, cpi_authority_bump: u8) -> Result<()> {
        let ms = &ctx.accounts.multisig;
        let member_key = ctx.accounts.member.key();

        // Verify member.
        require!(is_member_anchor(ms, &member_key), MultisigError::NotAMember);

        // Verify transaction is active.
        require!(
            ctx.accounts.transaction.status == TransactionStatus::Active,
            MultisigError::TransactionNotActive
        );

        // Record approval.
        let record = &mut ctx.accounts.approval_record;
        record.member = member_key;
        record.transaction = ctx.accounts.transaction.key();
        record.approved = true;

        // Increment approval count.
        let tx = &mut ctx.accounts.transaction;
        tx.approval_count = tx
            .approval_count
            .checked_add(1)
            .ok_or(error!(MultisigError::ArithmeticOverflow))?;

        // Check threshold.
        if tx.approval_count >= ms.threshold {
            let dwallet_ctx = DWalletContext {
                dwallet_program: ctx.accounts.dwallet_program.to_account_info(),
                cpi_authority: ctx.accounts.cpi_authority.to_account_info(),
                caller_program: ctx.accounts.program.to_account_info(),
                cpi_authority_bump,
            };

            // No message metadata for multisig — use all zeros.
            let message_metadata_digest = [0u8; 32];

            // CPI: issue the voucher, a future signature voucher owned by the
            // proposer for a future sign (the `dwallet` account is
            // constrained to `multisig.dwallet`). The voucher is this
            // program's PDA for the transaction, so the program signs its
            // creation.
            let transaction_key = tx.key();
            let voucher_seeds: &[&[u8]] = &[
                b"signature_voucher",
                transaction_key.as_ref(),
                &[tx.signature_voucher_bump],
            ];
            if tx.future_sign {
                dwallet_ctx.issue_future_signature_voucher(
                    &ctx.accounts.coordinator.to_account_info(),
                    &ctx.accounts.signature_voucher.to_account_info(),
                    &ctx.accounts.dwallet.to_account_info(),
                    &ctx.accounts.payer.to_account_info(),
                    &ctx.accounts.system_program.to_account_info(),
                    tx.message_hash,
                    message_metadata_digest,
                    tx.signature_scheme,
                    Some(tx.proposer.to_bytes()),
                    Some(tx.user_pubkey),
                    Some(voucher_seeds),
                )?;
            } else {
                dwallet_ctx.issue_signature_voucher(
                    &ctx.accounts.coordinator.to_account_info(),
                    &ctx.accounts.signature_voucher.to_account_info(),
                    &ctx.accounts.dwallet.to_account_info(),
                    &ctx.accounts.payer.to_account_info(),
                    &ctx.accounts.system_program.to_account_info(),
                    tx.message_hash,
                    message_metadata_digest,
                    tx.signature_scheme,
                    None,
                    Some(tx.user_pubkey),
                    Some(voucher_seeds),
                )?;
            }

            tx.status = TransactionStatus::Approved;
        }

        Ok(())
    }

    /// Reject a transaction. When enough rejections accumulate, marks as rejected.
    pub fn reject(ctx: Context<Reject>) -> Result<()> {
        let ms = &ctx.accounts.multisig;
        let member_key = ctx.accounts.member.key();

        // Verify member.
        require!(is_member_anchor(ms, &member_key), MultisigError::NotAMember);

        // Verify transaction is active.
        require!(
            ctx.accounts.transaction.status == TransactionStatus::Active,
            MultisigError::TransactionNotActive
        );

        // Record rejection.
        let record = &mut ctx.accounts.approval_record;
        record.member = member_key;
        record.transaction = ctx.accounts.transaction.key();
        record.approved = false;

        // Increment rejection count.
        let tx = &mut ctx.accounts.transaction;
        tx.rejection_count = tx
            .rejection_count
            .checked_add(1)
            .ok_or(error!(MultisigError::ArithmeticOverflow))?;

        // Check rejection threshold: member_count - threshold + 1.
        let rejection_threshold = ms
            .member_count
            .checked_sub(ms.threshold)
            .ok_or(error!(MultisigError::ArithmeticOverflow))?
            .checked_add(1)
            .ok_or(error!(MultisigError::ArithmeticOverflow))?;

        if tx.rejection_count >= rejection_threshold {
            tx.status = TransactionStatus::Rejected;
        }

        Ok(())
    }
}

fn is_member_anchor(ms: &Multisig, key: &Pubkey) -> bool {
    ms.members
        .iter()
        .take(ms.member_count as usize)
        .any(|member| member == key)
}

// ── Accounts ──

#[derive(Accounts)]
pub struct CreateMultisig<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Multisig::INIT_SPACE,
        seeds = [b"multisig", dwallet.key().as_ref()],
        bump,
    )]
    pub multisig: Account<'info, Multisig>,

    /// CHECK: dWallet account; must be owned by the dWallet program, and its
    /// stored owner must be `owner` (checked in the handler).
    #[account(owner = IKA_PROGRAM_ID @ MultisigError::InvalidDWalletAccount)]
    pub dwallet: UncheckedAccount<'info>,

    /// CHECK: The Ika dWallet program (must be executable).
    #[account(executable)]
    pub dwallet_program: UncheckedAccount<'info>,

    /// The dWallet's current owner.
    pub owner: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateTransaction<'info> {
    #[account(mut)]
    pub multisig: Account<'info, Multisig>,

    #[account(
        init,
        payer = payer,
        space = 8 + MultisigTransaction::INIT_SPACE,
        seeds = [b"transaction", multisig.key().as_ref(), multisig.tx_index.to_le_bytes().as_ref()],
        bump,
    )]
    pub transaction: Account<'info, MultisigTransaction>,

    pub proposer: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Approve<'info> {
    pub multisig: Account<'info, Multisig>,

    #[account(
        mut,
        constraint = transaction.multisig == multisig.key() @ MultisigError::TransactionMismatch,
    )]
    pub transaction: Account<'info, MultisigTransaction>,

    #[account(
        init,
        payer = payer,
        space = 8 + ApprovalRecord::INIT_SPACE,
        seeds = [b"approval", transaction.key().as_ref(), member.key().as_ref()],
        bump,
    )]
    pub approval_record: Account<'info, ApprovalRecord>,

    pub member: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,

    // CPI accounts (needed when threshold is reached).
    /// CHECK: DWalletCoordinator PDA on the dWallet program (for epoch).
    pub coordinator: UncheckedAccount<'info>,

    /// CHECK: The SignatureVoucher to create: this program's PDA
    /// `["signature_voucher", transaction]`, checked by the seeds below. A
    /// signer at another address would also be accepted by the dWallet
    /// program, because an outer transaction's signatures carry through the
    /// CPI, so the address itself is what this constraint checks.
    #[account(
        mut,
        seeds = [b"signature_voucher", transaction.key().as_ref()],
        bump = transaction.signature_voucher_bump,
    )]
    pub signature_voucher: UncheckedAccount<'info>,

    /// CHECK: dWallet account — must be the multisig's dWallet, never a
    /// caller-chosen one (the CPI authority PDA is shared by every dWallet
    /// this program controls).
    #[account(address = multisig.dwallet @ MultisigError::DWalletMismatch)]
    pub dwallet: UncheckedAccount<'info>,

    /// CHECK: This program's executable account (for CPI authority verification).
    pub program: UncheckedAccount<'info>,

    /// CHECK: CPI authority PDA (seeds: `[CPI_AUTHORITY_SEED]`, derived from this program).
    pub cpi_authority: UncheckedAccount<'info>,

    /// CHECK: The Ika dWallet program.
    pub dwallet_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Reject<'info> {
    pub multisig: Account<'info, Multisig>,

    #[account(
        mut,
        constraint = transaction.multisig == multisig.key() @ MultisigError::TransactionMismatch,
    )]
    pub transaction: Account<'info, MultisigTransaction>,

    #[account(
        init,
        payer = payer,
        space = 8 + ApprovalRecord::INIT_SPACE,
        seeds = [b"approval", transaction.key().as_ref(), member.key().as_ref()],
        bump,
    )]
    pub approval_record: Account<'info, ApprovalRecord>,

    pub member: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// ── State ──

/// The governance of one dWallet: members and threshold. One per dWallet at
/// `["multisig", dwallet]`.
#[account]
#[derive(InitSpace)]
pub struct Multisig {
    pub dwallet: Pubkey,
    pub threshold: u16,
    pub member_count: u16,
    pub tx_index: u32,
    pub bump: u8,
    pub members: [Pubkey; MAX_MEMBERS],
}

#[account]
#[derive(InitSpace)]
pub struct MultisigTransaction {
    pub multisig: Pubkey,
    pub tx_index: u32,
    pub proposer: Pubkey,
    pub message_hash: [u8; 32],
    pub user_pubkey: [u8; 32],
    pub signature_scheme: u16,
    pub approval_count: u16,
    pub rejection_count: u16,
    pub status: TransactionStatus,
    pub signature_voucher_bump: u8,
    /// Whether approval issues a future signature voucher.
    pub future_sign: bool,
    pub message_data_len: u16,
    pub message_data: [u8; MAX_MESSAGE_DATA],
}

#[account]
#[derive(InitSpace)]
pub struct ApprovalRecord {
    pub member: Pubkey,
    pub transaction: Pubkey,
    pub approved: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum TransactionStatus {
    Active,
    Approved,
    Rejected,
}

// ── Errors ──

#[error_code]
pub enum MultisigError {
    #[msg("Threshold must be > 0 and <= member count")]
    InvalidThreshold,
    #[msg("At least one member is required")]
    NoMembers,
    #[msg("Maximum 10 members allowed")]
    TooManyMembers,
    #[msg("Signer is not a multisig member")]
    NotAMember,
    #[msg("Transaction is not active")]
    TransactionNotActive,
    #[msg("Transaction does not belong to this multisig")]
    TransactionMismatch,
    #[msg("Message data exceeds 256 bytes")]
    MessageDataTooLarge,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("dWallet account is not the multisig's dWallet")]
    DWalletMismatch,
    #[msg("Signer is not the dWallet's current owner")]
    NotDWalletOwner,
    #[msg("Account is not a DWallet owned by the dWallet program")]
    InvalidDWalletAccount,
    #[msg("Member list contains a duplicate")]
    DuplicateMember,
    #[msg("The voucher bump is not the canonical bump of the transaction's voucher PDA")]
    InvalidVoucherBump,
}
