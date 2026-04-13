// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! Anchor CPI SDK for the Ika dWallet program.
//!
//! Provides `DWalletContext` for calling dWallet instructions via CPI
//! from other Anchor programs.
//!
//! # Usage
//!
//! ```ignore
//! use ika_dwallet_anchor::{DWalletContext, CPI_AUTHORITY_SEED};
//!
//! let ctx = DWalletContext {
//!     dwallet_program: dwallet_program.to_account_info(),
//!     cpi_authority: cpi_authority.to_account_info(),
//!     caller_program: program.to_account_info(),
//!     cpi_authority_bump: bump,
//! };
//!
//! ctx.approve_message(
//!     &coordinator.to_account_info(),
//!     &message_approval.to_account_info(),
//!     &dwallet.to_account_info(),
//!     &payer.to_account_info(),
//!     &system_program.to_account_info(),
//!     message_digest,
//!     message_metadata_digest,
//!     user_pubkey,
//!     signature_scheme,
//!     bump,
//! )?;
//! ```

use anchor_lang::prelude::*;

/// Seed for deriving the CPI authority PDA from a caller program.
/// A calling program derives: `Pubkey::find_program_address(&[CPI_AUTHORITY_SEED], caller_program_id)`.
pub const CPI_AUTHORITY_SEED: &[u8] = b"__ika_cpi_authority";

// ── Instruction discriminators (must match IkaDWalletInstructionDiscriminators) ──
const IX_APPROVE_MESSAGE: u8 = 8;
const IX_TRANSFER_OWNERSHIP: u8 = 24;
const IX_TRANSFER_FUTURE_SIGN: u8 = 42;

/// CPI context for invoking Ika dWallet instructions from Anchor programs.
///
/// The calling program signs via its CPI authority PDA, which the dWallet
/// program verifies using `verify_signer_or_cpi`.
pub struct DWalletContext<'info> {
    /// The Ika dWallet program account.
    pub dwallet_program: AccountInfo<'info>,
    /// The CPI authority PDA (derived from caller program).
    pub cpi_authority: AccountInfo<'info>,
    /// The calling program account (must be executable).
    pub caller_program: AccountInfo<'info>,
    /// Bump seed for the CPI authority PDA.
    pub cpi_authority_bump: u8,
}

impl<'info> DWalletContext<'info> {
    /// Approve a message for signing via CPI.
    ///
    /// Creates a MessageApproval PDA on behalf of the calling program.
    /// The dWallet's authority must be set to this program's CPI authority PDA.
    ///
    /// # Accounts (program mode)
    ///
    /// - `coordinator`: readonly — the DWalletCoordinator PDA (for epoch)
    /// - `message_approval`: writable, empty — the PDA to create
    /// - `dwallet`: readonly, program-owned — the dWallet account
    /// - `caller_program`: readonly, executable — the calling program (from context)
    /// - `cpi_authority`: readonly, signer — the CPI authority PDA (from context)
    /// - `payer`: writable, signer — pays for PDA rent
    /// - `system_program`: readonly — the system program
    pub fn approve_message(
        &self,
        coordinator: &AccountInfo<'info>,
        message_approval: &AccountInfo<'info>,
        dwallet: &AccountInfo<'info>,
        payer: &AccountInfo<'info>,
        system_program: &AccountInfo<'info>,
        message_digest: [u8; 32],
        message_metadata_digest: [u8; 32],
        user_pubkey: [u8; 32],
        signature_scheme: u16,
        bump: u8,
    ) -> Result<()> {
        // Build instruction data: [discriminator, bump, message_digest(32),
        //   message_metadata_digest(32), user_pubkey(32), signature_scheme(2)] = 100 bytes
        let mut ix_data = Vec::with_capacity(100);
        ix_data.push(IX_APPROVE_MESSAGE);
        ix_data.push(bump);
        ix_data.extend_from_slice(&message_digest);
        ix_data.extend_from_slice(&message_metadata_digest);
        ix_data.extend_from_slice(&user_pubkey);
        ix_data.extend_from_slice(&signature_scheme.to_le_bytes());

        let accounts = vec![
            AccountMeta::new_readonly(coordinator.key(), false),
            AccountMeta::new(message_approval.key(), false),
            AccountMeta::new_readonly(dwallet.key(), false),
            AccountMeta::new_readonly(self.caller_program.key(), false),
            AccountMeta::new_readonly(self.cpi_authority.key(), true),
            AccountMeta::new(payer.key(), true),
            AccountMeta::new_readonly(system_program.key(), false),
        ];

        let ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: self.dwallet_program.key(),
            accounts,
            data: ix_data,
        };

        let account_infos = vec![
            coordinator.clone(),
            message_approval.clone(),
            dwallet.clone(),
            self.caller_program.clone(),
            self.cpi_authority.clone(),
            payer.clone(),
            system_program.clone(),
            self.dwallet_program.clone(),
        ];

        let seeds = &[CPI_AUTHORITY_SEED, &[self.cpi_authority_bump]];
        let signer_seeds = &[&seeds[..]];
        anchor_lang::solana_program::program::invoke_signed(&ix, &account_infos, signer_seeds)?;
        Ok(())
    }

    /// Transfer dWallet authority via CPI.
    ///
    /// Transfers authority of a dWallet to a new authority pubkey.
    /// The dWallet's current authority must be this program's CPI authority PDA.
    ///
    /// # Accounts (program mode)
    ///
    /// - `caller_program`: readonly, executable — the calling program (from context)
    /// - `cpi_authority`: readonly, signer — the CPI authority PDA (from context)
    /// - `dwallet`: writable, program-owned — the dWallet account
    pub fn transfer_dwallet(
        &self,
        dwallet: &AccountInfo<'info>,
        new_authority: &Pubkey,
    ) -> Result<()> {
        let mut ix_data = Vec::with_capacity(33);
        ix_data.push(IX_TRANSFER_OWNERSHIP);
        ix_data.extend_from_slice(new_authority.as_ref());

        let accounts = vec![
            AccountMeta::new_readonly(self.caller_program.key(), false),
            AccountMeta::new_readonly(self.cpi_authority.key(), true),
            AccountMeta::new(dwallet.key(), false),
        ];

        let ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: self.dwallet_program.key(),
            accounts,
            data: ix_data,
        };

        let account_infos = vec![
            self.caller_program.clone(),
            self.cpi_authority.clone(),
            dwallet.clone(),
            self.dwallet_program.clone(),
        ];

        let seeds = &[CPI_AUTHORITY_SEED, &[self.cpi_authority_bump]];
        let signer_seeds = &[&seeds[..]];
        anchor_lang::solana_program::program::invoke_signed(&ix, &account_infos, signer_seeds)?;
        Ok(())
    }

    /// Transfer future sign completion authority via CPI.
    ///
    /// Transfers the completion authority of a PartialUserSignature to a new pubkey.
    /// The current completion authority must be this program's CPI authority PDA.
    ///
    /// # Accounts (program mode)
    ///
    /// - `partial_user_sig`: writable, program-owned — the partial signature account
    /// - `caller_program`: readonly, executable — the calling program (from context)
    /// - `cpi_authority`: readonly, signer — the CPI authority PDA (from context)
    pub fn transfer_future_sign(
        &self,
        partial_user_sig: &AccountInfo<'info>,
        new_authority: &Pubkey,
    ) -> Result<()> {
        let mut ix_data = Vec::with_capacity(33);
        ix_data.push(IX_TRANSFER_FUTURE_SIGN);
        ix_data.extend_from_slice(new_authority.as_ref());

        let accounts = vec![
            AccountMeta::new(partial_user_sig.key(), false),
            AccountMeta::new_readonly(self.caller_program.key(), false),
            AccountMeta::new_readonly(self.cpi_authority.key(), true),
        ];

        let ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: self.dwallet_program.key(),
            accounts,
            data: ix_data,
        };

        let account_infos = vec![
            partial_user_sig.clone(),
            self.caller_program.clone(),
            self.cpi_authority.clone(),
            self.dwallet_program.clone(),
        ];

        let seeds = &[CPI_AUTHORITY_SEED, &[self.cpi_authority_bump]];
        let signer_seeds = &[&seeds[..]];
        anchor_lang::solana_program::program::invoke_signed(&ix, &account_infos, signer_seeds)?;
        Ok(())
    }
}
