// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! Example: Multisig-controlled dWallet signing with future sign (Anchor version).
//!
//! An Anchor program demonstrating m-of-n multisig control over dWallets via
//! the CPI authority pattern. Transactions are proposed with message data stored
//! directly on-chain so other signers can inspect them. When enough members
//! approve (reaching threshold), the program CPI-calls `approve_message` and
//! `transfer_future_sign` on the dWallet program.
//!
//! This is the Anchor equivalent of the Pinocchio `ika-example-multisig` program.

use anchor_lang::prelude::*;
use ika_dwallet_anchor::DWalletContext;

// Placeholder program ID -- replace with actual keypair before deployment.
declare_id!("7wj8oHHfEM8wxQ9RYZz4rwp4HArDT3RLMiMtzPfabNzD");

const MAX_MEMBERS: usize = 10;
const MAX_MESSAGE_DATA: usize = 256;

#[program]
pub mod multisig_anchor {
    use super::*;

    /// Create a multisig PDA with members list, threshold, and associated dWallet.
    pub fn create_multisig(
        ctx: Context<CreateMultisig>,
        create_key: [u8; 32],
        dwallet: Pubkey,
        threshold: u16,
        members: Vec<Pubkey>,
    ) -> Result<()> {
        require!(threshold > 0, MultisigError::InvalidThreshold);
        require!(!members.is_empty(), MultisigError::NoMembers);
        require!(
            members.len() <= MAX_MEMBERS,
            MultisigError::TooManyMembers
        );
        require!(
            threshold <= members.len() as u16,
            MultisigError::InvalidThreshold
        );

        let ms = &mut ctx.accounts.multisig;
        ms.create_key = create_key;
        ms.threshold = threshold;
        ms.member_count = members.len() as u16;
        ms.tx_index = 0;
        ms.dwallet = dwallet;
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
        signature_scheme: u8,
        message_approval_bump: u8,
        partial_user_sig: Pubkey,
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
        tx.message_approval_bump = message_approval_bump;
        tx.partial_user_sig = partial_user_sig;
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

    /// Approve a transaction. When threshold is reached, CPI-calls approve_message
    /// and optionally transfer_future_sign.
    pub fn approve(ctx: Context<Approve>, cpi_authority_bump: u8) -> Result<()> {
        let ms = &ctx.accounts.multisig;
        let member_key = ctx.accounts.member.key();

        // Verify member.
        require!(
            is_member_anchor(ms, &member_key),
            MultisigError::NotAMember
        );

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

            // CPI: approve_message.
            dwallet_ctx.approve_message(
                &ctx.accounts.message_approval.to_account_info(),
                &ctx.accounts.dwallet.to_account_info(),
                &ctx.accounts.payer.to_account_info(),
                &ctx.accounts.system_program.to_account_info(),
                tx.message_hash,
                tx.user_pubkey,
                tx.signature_scheme,
                tx.message_approval_bump,
            )?;

            // CPI: transfer_future_sign if partial_user_sig is set.
            if tx.partial_user_sig != Pubkey::default() {
                dwallet_ctx.transfer_future_sign(
                    &ctx.accounts.partial_user_sig_account.to_account_info(),
                    &tx.proposer,
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
        require!(
            is_member_anchor(ms, &member_key),
            MultisigError::NotAMember
        );

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
    for i in 0..ms.member_count as usize {
        if ms.members[i] == *key {
            return true;
        }
    }
    false
}

// ── Accounts ──

#[derive(Accounts)]
#[instruction(create_key: [u8; 32])]
pub struct CreateMultisig<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Multisig::INIT_SPACE,
        seeds = [b"multisig", create_key.as_ref()],
        bump,
    )]
    pub multisig: Account<'info, Multisig>,

    pub creator: Signer<'info>,

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

    /// CHECK: MessageApproval PDA on the dWallet program.
    #[account(mut)]
    pub message_approval: UncheckedAccount<'info>,

    /// CHECK: dWallet account (owned by the dWallet program).
    pub dwallet: UncheckedAccount<'info>,

    /// CHECK: This program's executable account (for CPI authority verification).
    pub program: UncheckedAccount<'info>,

    /// CHECK: CPI authority PDA (seeds: `[CPI_AUTHORITY_SEED]`, derived from this program).
    pub cpi_authority: UncheckedAccount<'info>,

    /// CHECK: The Ika dWallet program.
    pub dwallet_program: UncheckedAccount<'info>,

    /// CHECK: PartialUserSignature account (for transfer_future_sign, optional).
    #[account(mut)]
    pub partial_user_sig_account: UncheckedAccount<'info>,
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

#[account]
#[derive(InitSpace)]
pub struct Multisig {
    pub create_key: [u8; 32],
    pub threshold: u16,
    pub member_count: u16,
    pub tx_index: u32,
    pub dwallet: Pubkey,
    #[max_len(10)]
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
    pub signature_scheme: u8,
    pub approval_count: u16,
    pub rejection_count: u16,
    pub status: TransactionStatus,
    pub message_approval_bump: u8,
    pub partial_user_sig: Pubkey,
    pub message_data_len: u16,
    #[max_len(256)]
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
}
