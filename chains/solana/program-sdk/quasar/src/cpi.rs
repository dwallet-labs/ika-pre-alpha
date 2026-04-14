// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! CPI context and methods for invoking Ika dWallet instructions from
//! other Quasar programs.

use quasar_lang::{
    cpi::{CpiAccount, InstructionAccount, InstructionView, Seed, Signer},
    prelude::*,
};

use crate::CPI_AUTHORITY_SEED;

// ── Instruction discriminators (must match IkaDWalletInstructionDiscriminators) ──
const IX_APPROVE_MESSAGE: u8 = 8;
const IX_TRANSFER_OWNERSHIP: u8 = 24;
const IX_TRANSFER_FUTURE_SIGN: u8 = 42;

/// CPI context for invoking Ika dWallet instructions.
///
/// The calling program signs via its CPI authority PDA, which the dWallet
/// program verifies using `verify_signer_or_cpi`.
pub struct DWalletContext<'a> {
    /// The Ika dWallet program account.
    pub dwallet_program: &'a AccountView,
    /// The CPI authority PDA (derived from caller program).
    pub cpi_authority: &'a AccountView,
    /// The calling program account (must be executable).
    pub caller_program: &'a AccountView,
    /// Bump seed for the CPI authority PDA.
    pub cpi_authority_bump: u8,
}

impl<'a> DWalletContext<'a> {
    /// Approve a message for signing via CPI.
    ///
    /// Creates a MessageApproval PDA on behalf of the calling program.
    /// The dWallet's authority must be set to this program's CPI authority PDA.
    ///
    /// # Accounts (program mode)
    ///
    /// - `coordinator`: readonly -- the DWalletCoordinator PDA (for epoch)
    /// - `message_approval`: writable, empty -- the PDA to create
    /// - `dwallet`: readonly, program-owned -- the dWallet account
    /// - `caller_program`: readonly, executable -- the calling program (from context)
    /// - `cpi_authority`: readonly, signer -- the CPI authority PDA (from context)
    /// - `payer`: writable, signer -- pays for PDA rent
    /// - `system_program`: readonly -- the system program
    pub fn approve_message(
        &self,
        coordinator: &'a AccountView,
        message_approval: &'a AccountView,
        dwallet: &'a AccountView,
        payer: &'a AccountView,
        system_program: &'a AccountView,
        message_digest: [u8; 32],
        message_metadata_digest: [u8; 32],
        user_pubkey: [u8; 32],
        signature_scheme: u16,
        bump: u8,
    ) -> Result<(), ProgramError> {
        // Build instruction data: [discriminator, bump, message_digest(32),
        //   message_metadata_digest(32), user_pubkey(32), signature_scheme(2)] = 100 bytes
        let mut ix_data = [0u8; 100];
        ix_data[0] = IX_APPROVE_MESSAGE;
        ix_data[1] = bump;
        ix_data[2..34].copy_from_slice(&message_digest);
        ix_data[34..66].copy_from_slice(&message_metadata_digest);
        ix_data[66..98].copy_from_slice(&user_pubkey);
        ix_data[98..100].copy_from_slice(&signature_scheme.to_le_bytes());

        let ix_accounts = [
            InstructionAccount::new(coordinator.address(), false, false),
            InstructionAccount::new(message_approval.address(), true, false),
            InstructionAccount::new(dwallet.address(), false, false),
            InstructionAccount::new(self.caller_program.address(), false, false),
            InstructionAccount::new(self.cpi_authority.address(), false, true),
            InstructionAccount::new(payer.address(), true, true),
            InstructionAccount::new(system_program.address(), false, false),
        ];

        let cpi_accts = [
            CpiAccount::from(coordinator),
            CpiAccount::from(message_approval),
            CpiAccount::from(dwallet),
            CpiAccount::from(self.caller_program),
            CpiAccount::from(self.cpi_authority),
            CpiAccount::from(payer),
            CpiAccount::from(system_program),
        ];

        let bump_byte = [self.cpi_authority_bump];
        let signer_seeds: [Seed; 2] = [
            Seed::from(CPI_AUTHORITY_SEED),
            Seed::from(&bump_byte as &[u8]),
        ];
        let signers = [Signer::from(&signer_seeds[..])];

        let instruction = InstructionView {
            program_id: self.dwallet_program.address(),
            accounts: &ix_accounts,
            data: &ix_data,
        };

        unsafe {
            solana_instruction_view::cpi::invoke_signed_unchecked(
                &instruction,
                &cpi_accts,
                &signers,
            );
        }
        Ok(())
    }

    /// Transfer dWallet authority via CPI.
    ///
    /// Transfers authority of a dWallet to a new authority pubkey.
    /// The dWallet's current authority must be this program's CPI authority PDA.
    ///
    /// # Accounts (program mode)
    ///
    /// - `caller_program`: readonly, executable -- the calling program (from context)
    /// - `cpi_authority`: readonly, signer -- the CPI authority PDA (from context)
    /// - `dwallet`: writable, program-owned -- the dWallet account
    pub fn transfer_dwallet(
        &self,
        dwallet: &'a AccountView,
        new_authority: [u8; 32],
    ) -> Result<(), ProgramError> {
        let mut ix_data = [0u8; 33];
        ix_data[0] = IX_TRANSFER_OWNERSHIP;
        ix_data[1..33].copy_from_slice(&new_authority);

        let ix_accounts = [
            InstructionAccount::new(self.caller_program.address(), false, false),
            InstructionAccount::new(self.cpi_authority.address(), false, true),
            InstructionAccount::new(dwallet.address(), true, false),
        ];

        let cpi_accts = [
            CpiAccount::from(self.caller_program),
            CpiAccount::from(self.cpi_authority),
            CpiAccount::from(dwallet),
        ];

        let bump_byte = [self.cpi_authority_bump];
        let signer_seeds: [Seed; 2] = [
            Seed::from(CPI_AUTHORITY_SEED),
            Seed::from(&bump_byte as &[u8]),
        ];
        let signers = [Signer::from(&signer_seeds[..])];

        let instruction = InstructionView {
            program_id: self.dwallet_program.address(),
            accounts: &ix_accounts,
            data: &ix_data,
        };

        unsafe {
            solana_instruction_view::cpi::invoke_signed_unchecked(
                &instruction,
                &cpi_accts,
                &signers,
            );
        }
        Ok(())
    }

    /// Transfer future sign completion authority via CPI.
    ///
    /// Transfers the completion authority of a PartialUserSignature to a new pubkey.
    /// The current completion authority must be this program's CPI authority PDA.
    ///
    /// # Accounts (program mode)
    ///
    /// - `partial_user_sig`: writable, program-owned -- the partial signature account
    /// - `caller_program`: readonly, executable -- the calling program (from context)
    /// - `cpi_authority`: readonly, signer -- the CPI authority PDA (from context)
    pub fn transfer_future_sign(
        &self,
        partial_user_sig: &'a AccountView,
        new_completion_authority: [u8; 32],
    ) -> Result<(), ProgramError> {
        let mut ix_data = [0u8; 33];
        ix_data[0] = IX_TRANSFER_FUTURE_SIGN;
        ix_data[1..33].copy_from_slice(&new_completion_authority);

        let ix_accounts = [
            InstructionAccount::new(partial_user_sig.address(), true, false),
            InstructionAccount::new(self.caller_program.address(), false, false),
            InstructionAccount::new(self.cpi_authority.address(), false, true),
        ];

        let cpi_accts = [
            CpiAccount::from(partial_user_sig),
            CpiAccount::from(self.caller_program),
            CpiAccount::from(self.cpi_authority),
        ];

        let bump_byte = [self.cpi_authority_bump];
        let signer_seeds: [Seed; 2] = [
            Seed::from(CPI_AUTHORITY_SEED),
            Seed::from(&bump_byte as &[u8]),
        ];
        let signers = [Signer::from(&signer_seeds[..])];

        let instruction = InstructionView {
            program_id: self.dwallet_program.address(),
            accounts: &ix_accounts,
            data: &ix_data,
        };

        unsafe {
            solana_instruction_view::cpi::invoke_signed_unchecked(
                &instruction,
                &cpi_accts,
                &signers,
            );
        }
        Ok(())
    }
}
