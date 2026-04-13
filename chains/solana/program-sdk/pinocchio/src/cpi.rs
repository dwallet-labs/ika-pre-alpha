// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! CPI context and methods for invoking Ika dWallet instructions from
//! other Pinocchio programs.

extern crate alloc;
use alloc::vec::Vec;

use pinocchio::{
    cpi::{invoke_signed, Seed, Signer},
    instruction::{InstructionAccount, InstructionView},
    AccountView, ProgramResult,
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
    /// - `coordinator`: readonly — the DWalletCoordinator PDA (for epoch)
    /// - `message_approval`: writable, empty — the PDA to create
    /// - `dwallet`: readonly, program-owned — the dWallet account
    /// - `caller_program`: readonly, executable — the calling program (from context)
    /// - `cpi_authority`: readonly, signer — the CPI authority PDA (from context)
    /// - `payer`: writable, signer — pays for PDA rent
    /// - `system_program`: readonly — the system program
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
    ) -> ProgramResult {
        // Build instruction data: [discriminator, bump, message_digest(32),
        //   message_metadata_digest(32), user_pubkey(32), signature_scheme(2)] = 100 bytes
        let mut ix_data = Vec::with_capacity(100);
        ix_data.push(IX_APPROVE_MESSAGE);
        ix_data.push(bump);
        ix_data.extend_from_slice(&message_digest);
        ix_data.extend_from_slice(&message_metadata_digest);
        ix_data.extend_from_slice(&user_pubkey);
        ix_data.extend_from_slice(&signature_scheme.to_le_bytes());

        let instruction_accounts = [
            InstructionAccount::readonly(coordinator.address()),
            InstructionAccount::writable(message_approval.address()),
            InstructionAccount::readonly(dwallet.address()),
            InstructionAccount::readonly(self.caller_program.address()),
            InstructionAccount::readonly_signer(self.cpi_authority.address()),
            InstructionAccount::writable_signer(payer.address()),
            InstructionAccount::readonly(system_program.address()),
        ];

        let bump_byte = [self.cpi_authority_bump];
        let signer_seeds: [Seed; 2] = [
            Seed::from(CPI_AUTHORITY_SEED),
            Seed::from(&bump_byte),
        ];
        let signer = Signer::from(&signer_seeds);

        let instruction = InstructionView {
            program_id: self.dwallet_program.address(),
            accounts: &instruction_accounts,
            data: &ix_data,
        };

        invoke_signed(
            &instruction,
            &[
                coordinator,
                message_approval,
                dwallet,
                self.caller_program,
                self.cpi_authority,
                payer,
                system_program,
                self.dwallet_program,
            ],
            &[signer],
        )
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
        dwallet: &'a AccountView,
        new_authority: [u8; 32],
    ) -> ProgramResult {
        // Build instruction data: [discriminator, new_authority(32)]
        let mut ix_data = Vec::with_capacity(33);
        ix_data.push(IX_TRANSFER_OWNERSHIP);
        ix_data.extend_from_slice(&new_authority);

        let instruction_accounts = [
            InstructionAccount::readonly(self.caller_program.address()),
            InstructionAccount::readonly_signer(self.cpi_authority.address()),
            InstructionAccount::writable(dwallet.address()),
        ];

        let bump_byte = [self.cpi_authority_bump];
        let signer_seeds: [Seed; 2] = [
            Seed::from(CPI_AUTHORITY_SEED),
            Seed::from(&bump_byte),
        ];
        let signer = Signer::from(&signer_seeds);

        let instruction = InstructionView {
            program_id: self.dwallet_program.address(),
            accounts: &instruction_accounts,
            data: &ix_data,
        };

        invoke_signed(
            &instruction,
            &[
                self.caller_program,
                self.cpi_authority,
                dwallet,
                self.dwallet_program,
            ],
            &[signer],
        )
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
        partial_user_sig: &'a AccountView,
        new_completion_authority: [u8; 32],
    ) -> ProgramResult {
        // Build instruction data: [discriminator, new_completion_authority(32)]
        let mut ix_data = Vec::with_capacity(33);
        ix_data.push(IX_TRANSFER_FUTURE_SIGN);
        ix_data.extend_from_slice(&new_completion_authority);

        let instruction_accounts = [
            InstructionAccount::writable(partial_user_sig.address()),
            InstructionAccount::readonly(self.caller_program.address()),
            InstructionAccount::readonly_signer(self.cpi_authority.address()),
        ];

        let bump_byte = [self.cpi_authority_bump];
        let signer_seeds: [Seed; 2] = [
            Seed::from(CPI_AUTHORITY_SEED),
            Seed::from(&bump_byte),
        ];
        let signer = Signer::from(&signer_seeds);

        let instruction = InstructionView {
            program_id: self.dwallet_program.address(),
            accounts: &instruction_accounts,
            data: &ix_data,
        };

        invoke_signed(
            &instruction,
            &[
                partial_user_sig,
                self.caller_program,
                self.cpi_authority,
                self.dwallet_program,
            ],
            &[signer],
        )
    }
}
