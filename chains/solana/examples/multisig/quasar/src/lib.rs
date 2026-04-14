// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! Example: Multisig-controlled dWallet signing with future sign (Quasar version).
//!
//! A Quasar program demonstrating m-of-n multisig control over dWallets via
//! the CPI authority pattern. Transactions are proposed with message data stored
//! directly on-chain so other signers can inspect them. When enough members
//! approve (reaching threshold), the program CPI-calls `approve_message` and
//! `transfer_future_sign` on the dWallet program.
//!
//! This is the Quasar equivalent of the Pinocchio `ika-example-multisig` program.

#![no_std]

use ika_dwallet_quasar::DWalletContext;
use quasar_lang::prelude::*;
use solana_address::Address;

// Placeholder program ID -- replace with actual keypair before deployment.
declare_id!("YMN9Qj5jPNp7j14VPcML1B6xGgcPWVZUGLFU3Mnyfaf");

const MAX_MEMBERS: usize = 10;
const MAX_MESSAGE_DATA: usize = 256;

#[program]
mod multisig_quasar {
    use super::*;

    /// Create a multisig PDA with members list, threshold, and associated dWallet.
    ///
    /// Members are passed as a flat `[u8; 320]` (10 x 32-byte addresses).
    #[instruction(discriminator = 0)]
    pub fn create_multisig(
        ctx: Ctx<CreateMultisig>,
        dwallet: [u8; 32],
        threshold: u16,
        member_count: u16,
        members_flat: [u8; 320],
    ) -> Result<(), ProgramError> {
        ctx.accounts
            .create(dwallet, threshold, member_count, members_flat)
    }

    /// Propose a new transaction for the multisig to approve.
    #[instruction(discriminator = 1)]
    pub fn create_transaction(
        ctx: Ctx<CreateTransaction>,
        message_hash: [u8; 32],
        user_pubkey: [u8; 32],
        signature_scheme: u16,
        message_approval_bump: u8,
        partial_user_sig: Address,
        message_data_len: u16,
        message_data: [u8; MAX_MESSAGE_DATA],
    ) -> Result<(), ProgramError> {
        ctx.accounts.create(
            message_hash,
            user_pubkey,
            signature_scheme,
            message_approval_bump,
            partial_user_sig,
            message_data_len,
            message_data,
        )
    }

    /// Approve a transaction. When threshold is reached, CPI-calls approve_message
    /// and optionally transfer_future_sign.
    #[instruction(discriminator = 2)]
    pub fn approve(ctx: Ctx<Approve>, cpi_authority_bump: u8) -> Result<(), ProgramError> {
        ctx.accounts.approve(cpi_authority_bump)
    }

    /// Reject a transaction. When enough rejections accumulate, marks as rejected.
    #[instruction(discriminator = 3)]
    pub fn reject(ctx: Ctx<Reject>) -> Result<(), ProgramError> {
        ctx.accounts.reject()
    }
}

fn is_member_quasar(ms: &MultisigAccount, key: &Address) -> bool {
    let count: u16 = ms.member_count.into();
    for i in 0..count as usize {
        if ms.members[i] == *key {
            return true;
        }
    }
    false
}

// ── State ──

#[account(discriminator = 1, set_inner)]
#[seeds(b"multisig", create_key: Address)]
pub struct MultisigAccount {
    pub create_key: Address,
    pub threshold: u16,
    pub member_count: u16,
    pub tx_index: u32,
    pub dwallet: Address,
    pub members: [Address; MAX_MEMBERS],
}

#[account(discriminator = 2, set_inner)]
#[seeds(b"transaction", multisig: Address, tx_index_key: Address)]
pub struct MultisigTransaction {
    pub multisig: Address,
    pub tx_index: u32,
    pub proposer: Address,
    pub message_hash: [u8; 32],
    pub user_pubkey: [u8; 32],
    pub signature_scheme: u16,
    pub approval_count: u16,
    pub rejection_count: u16,
    pub status: u8,
    pub message_approval_bump: u8,
    pub partial_user_sig: Address,
    pub message_data_len: u16,
    pub message_data: [u8; MAX_MESSAGE_DATA],
}

#[account(discriminator = 3, set_inner)]
#[seeds(b"approval", transaction: Address, member: Address)]
pub struct ApprovalRecord {
    pub member: Address,
    pub transaction: Address,
    pub approved: u8,
}

// ── Errors ──

#[error_code]
pub enum MultisigError {
    InvalidThreshold = 6000,
    NoMembers,
    TooManyMembers,
    NotAMember,
    TransactionNotActive,
    MessageDataTooLarge,
    ArithmeticOverflow,
}

// ── Accounts ──

#[derive(Accounts)]
pub struct CreateMultisig {
    /// Create key -- its address is the 32-byte seed.
    pub create_key: UncheckedAccount,

    #[account(init, payer = payer, seeds = MultisigAccount::seeds(create_key), bump)]
    pub multisig: Account<MultisigAccount>,

    pub creator: Signer,

    #[account(mut)]
    pub payer: Signer,

    pub system_program: Program<System>,
}

impl CreateMultisig {
    #[inline(always)]
    pub fn create(
        &mut self,
        dwallet: [u8; 32],
        threshold: u16,
        member_count: u16,
        members_flat: [u8; 320],
    ) -> Result<(), ProgramError> {
        require!(threshold > 0, MultisigError::InvalidThreshold);
        require!(member_count > 0, MultisigError::NoMembers);
        require!(
            (member_count as usize) <= MAX_MEMBERS,
            MultisigError::TooManyMembers
        );
        require!(
            threshold <= member_count,
            MultisigError::InvalidThreshold
        );

        // Decode flat bytes into Address array.
        let mut members = [Address::default(); MAX_MEMBERS];
        for i in 0..member_count as usize {
            let offset = i * 32;
            let mut addr_bytes = [0u8; 32];
            addr_bytes.copy_from_slice(&members_flat[offset..offset + 32]);
            members[i] = Address::new_from_array(addr_bytes);
        }

        self.multisig.set_inner(MultisigAccountInner {
            create_key: *self.create_key.address(),
            threshold,
            member_count,
            tx_index: 0,
            dwallet: Address::new_from_array(dwallet),
            members,
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct CreateTransaction {
    #[account(mut)]
    pub multisig: Account<MultisigAccount>,

    /// tx_index key -- its address encodes the current tx_index for the PDA seed.
    pub tx_index_key: UncheckedAccount,

    #[account(
        init,
        payer = payer,
        seeds = MultisigTransaction::seeds(multisig, tx_index_key),
        bump,
    )]
    pub transaction: Account<MultisigTransaction>,

    pub proposer: Signer,

    #[account(mut)]
    pub payer: Signer,

    pub system_program: Program<System>,
}

impl CreateTransaction {
    #[inline(always)]
    pub fn create(
        &mut self,
        message_hash: [u8; 32],
        user_pubkey: [u8; 32],
        signature_scheme: u16,
        message_approval_bump: u8,
        partial_user_sig: Address,
        message_data_len: u16,
        message_data: [u8; MAX_MESSAGE_DATA],
    ) -> Result<(), ProgramError> {
        require!(
            (message_data_len as usize) <= MAX_MESSAGE_DATA,
            MultisigError::MessageDataTooLarge
        );

        // Verify proposer is a member.
        require!(
            is_member_quasar(&self.multisig, self.proposer.address()),
            MultisigError::NotAMember
        );

        let tx_index: u32 = self.multisig.tx_index.into();

        self.transaction.set_inner(MultisigTransactionInner {
            multisig: *self.multisig.address(),
            tx_index,
            proposer: *self.proposer.address(),
            message_hash,
            user_pubkey,
            signature_scheme,
            approval_count: 0,
            rejection_count: 0,
            status: 0, // Active
            message_approval_bump,
            partial_user_sig,
            message_data_len,
            message_data,
        });

        // Increment tx_index on multisig.
        self.multisig.tx_index = tx_index
            .checked_add(1)
            .ok_or(MultisigError::ArithmeticOverflow)?
            .into();

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Approve {
    pub multisig: Account<MultisigAccount>,

    #[account(mut, has_one = multisig)]
    pub transaction: Account<MultisigTransaction>,

    #[account(
        init,
        payer = payer,
        seeds = ApprovalRecord::seeds(transaction, member),
        bump,
    )]
    pub approval_record: Account<ApprovalRecord>,

    pub member: Signer,

    #[account(mut)]
    pub payer: Signer,

    pub system_program: Program<System>,

    // CPI accounts (needed when threshold is reached).

    /// DWalletCoordinator PDA on the dWallet program (for epoch).
    pub coordinator: UncheckedAccount,

    /// MessageApproval PDA on the dWallet program.
    #[account(mut)]
    pub message_approval: UncheckedAccount,

    /// dWallet account (owned by the dWallet program).
    pub dwallet: UncheckedAccount,

    /// This program's executable account (for CPI authority verification).
    pub caller_program: UncheckedAccount,

    /// CPI authority PDA (seeds: `[CPI_AUTHORITY_SEED]`, derived from this program).
    pub cpi_authority: UncheckedAccount,

    /// The Ika dWallet program.
    pub dwallet_program: UncheckedAccount,

    /// PartialUserSignature account (for transfer_future_sign, optional).
    #[account(mut)]
    pub partial_user_sig_account: UncheckedAccount,
}

impl Approve {
    #[inline(always)]
    pub fn approve(&mut self, cpi_authority_bump: u8) -> Result<(), ProgramError> {
        // Verify member.
        require!(
            is_member_quasar(&self.multisig, self.member.address()),
            MultisigError::NotAMember
        );

        // Verify transaction is active.
        require!(
            self.transaction.status == 0,
            MultisigError::TransactionNotActive
        );

        // Record approval.
        self.approval_record.set_inner(ApprovalRecordInner {
            member: *self.member.address(),
            transaction: *self.transaction.address(),
            approved: 1,
        });

        // Increment approval count.
        let approval_count: u16 = self.transaction.approval_count.into();
        let new_approvals = approval_count
            .checked_add(1)
            .ok_or(MultisigError::ArithmeticOverflow)?;
        self.transaction.approval_count = new_approvals.into();

        // Check threshold.
        let threshold: u16 = self.multisig.threshold.into();
        if new_approvals >= threshold {
            let dwallet_ctx = DWalletContext {
                dwallet_program: self.dwallet_program.to_account_view(),
                cpi_authority: self.cpi_authority.to_account_view(),
                caller_program: self.caller_program.to_account_view(),
                cpi_authority_bump,
            };

            // No message metadata for multisig -- use all zeros.
            let message_metadata_digest = [0u8; 32];

            // CPI: approve_message.
            dwallet_ctx.approve_message(
                self.coordinator.to_account_view(),
                self.message_approval.to_account_view(),
                self.dwallet.to_account_view(),
                self.payer.to_account_view(),
                self.system_program.to_account_view(),
                self.transaction.message_hash,
                message_metadata_digest,
                self.transaction.user_pubkey,
                self.transaction.signature_scheme.into(),
                self.transaction.message_approval_bump,
            )?;

            // CPI: transfer_future_sign if partial_user_sig is set.
            if self.transaction.partial_user_sig != Address::default() {
                dwallet_ctx.transfer_future_sign(
                    self.partial_user_sig_account.to_account_view(),
                    *self.transaction.proposer.as_array(),
                )?;
            }

            self.transaction.status = 1; // Approved
        }

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Reject {
    pub multisig: Account<MultisigAccount>,

    #[account(mut, has_one = multisig)]
    pub transaction: Account<MultisigTransaction>,

    #[account(
        init,
        payer = payer,
        seeds = ApprovalRecord::seeds(transaction, member),
        bump,
    )]
    pub approval_record: Account<ApprovalRecord>,

    pub member: Signer,

    #[account(mut)]
    pub payer: Signer,

    pub system_program: Program<System>,
}

impl Reject {
    #[inline(always)]
    pub fn reject(&mut self) -> Result<(), ProgramError> {
        // Verify member.
        require!(
            is_member_quasar(&self.multisig, self.member.address()),
            MultisigError::NotAMember
        );

        // Verify transaction is active.
        require!(
            self.transaction.status == 0,
            MultisigError::TransactionNotActive
        );

        // Record rejection.
        self.approval_record.set_inner(ApprovalRecordInner {
            member: *self.member.address(),
            transaction: *self.transaction.address(),
            approved: 0,
        });

        // Increment rejection count.
        let rejection_count: u16 = self.transaction.rejection_count.into();
        let new_rejections = rejection_count
            .checked_add(1)
            .ok_or(MultisigError::ArithmeticOverflow)?;
        self.transaction.rejection_count = new_rejections.into();

        // Check rejection threshold: member_count - threshold + 1.
        let threshold: u16 = self.multisig.threshold.into();
        let member_count: u16 = self.multisig.member_count.into();
        let rejection_threshold = member_count
            .checked_sub(threshold)
            .ok_or(MultisigError::ArithmeticOverflow)?
            .checked_add(1)
            .ok_or(MultisigError::ArithmeticOverflow)?;

        if new_rejections >= rejection_threshold {
            self.transaction.status = 2; // Rejected
        }

        Ok(())
    }
}
