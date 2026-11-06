// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! CPI context and methods for invoking Ika dWallet instructions from
//! other Pinocchio programs.

extern crate alloc;
use alloc::vec::Vec;

use pinocchio::{
    AccountView, ProgramResult,
    cpi::{Seed, Signer, invoke_signed},
    error::ProgramError,
    instruction::{InstructionAccount, InstructionView},
};

use crate::CPI_AUTHORITY_SEED;

// ── Instruction discriminators (must match InstructionDiscriminators) ──
const IX_TRANSFER_OWNERSHIP: u8 = 129;
const IX_ISSUE_SIGNATURE_VOUCHER: u8 = 156;
const IX_SET_VOUCHER_SIGNING_KEY: u8 = 157;
const IX_REVOKE_SIGNATURE_VOUCHER: u8 = 158;
const IX_TRANSFER_SIGNATURE_VOUCHER: u8 = 159;
const IX_ISSUE_FUTURE_SIGNATURE_VOUCHER: u8 = 161;

/// `IssueSignatureVoucher`'s flag that says the data names an owner.
const ISSUE_VOUCHER_HAS_OWNER: u8 = 1;
/// `IssueSignatureVoucher`'s flag that says the data names a signing key.
const ISSUE_VOUCHER_HAS_SIGNING_KEY: u8 = 2;

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
    /// Refuse a `dwallet_program` that is not the ika program, [`crate::ID`],
    /// with `IncorrectProgramId`, before any call is made.
    ///
    /// Every call below is signed by this program's CPI authority, and a
    /// signer stays a signer in every call the called program makes in turn.
    /// A program that only claims to be ika's could pass that signature on to
    /// the real ika program and act on any dWallet this program holds. So
    /// the address is compared with the one this crate was built for, and
    /// nothing is called anywhere else.
    fn require_ika_program(&self) -> ProgramResult {
        if self.dwallet_program.address() != &crate::ID {
            return Err(ProgramError::IncorrectProgramId);
        }
        Ok(())
    }

    /// Issue a signature voucher via CPI.
    ///
    /// Creates a `SignatureVoucher` at `signature_voucher`, a fresh address
    /// that must sign its own creation. Either the outer transaction carries
    /// its keypair's signature, or the calling program owns it as a PDA and
    /// passes the PDA's seeds, bump included, in `voucher_seeds`.
    /// The dWallet's owner must be set to this program's CPI authority
    /// PDA.
    ///
    /// The voucher authorizes one signature of the message `message_digest`
    /// names. `owner` controls it afterwards; `None` makes the owner the
    /// issuer, this program's CPI authority PDA. `signing_key` is the
    /// Ed25519 key a sign request must come from; `None` leaves it for the
    /// owner to set, and until then no sign runs.
    ///
    /// # Accounts (program mode)
    ///
    /// - `coordinator`: readonly — the DWalletCoordinator PDA (for epoch)
    /// - `signature_voucher`: writable, signer, empty — the voucher to create
    /// - `dwallet`: readonly, program-owned — the dWallet account
    /// - `caller_program`: readonly, executable — the calling program (from context)
    /// - `cpi_authority`: readonly, signer — the CPI authority PDA (from context)
    /// - `payer`: writable, signer — pays for the voucher's rent
    /// - `system_program`: readonly — the system program
    pub fn issue_signature_voucher(
        &self,
        coordinator: &'a AccountView,
        signature_voucher: &'a AccountView,
        dwallet: &'a AccountView,
        payer: &'a AccountView,
        system_program: &'a AccountView,
        message_digest: [u8; 32],
        message_metadata_digest: [u8; 32],
        signature_scheme: u16,
        owner: Option<[u8; 32]>,
        signing_key: Option<[u8; 32]>,
        voucher_seeds: Option<&[Seed]>,
    ) -> ProgramResult {
        self.issue_voucher(
            IX_ISSUE_SIGNATURE_VOUCHER,
            coordinator,
            signature_voucher,
            dwallet,
            payer,
            system_program,
            message_digest,
            message_metadata_digest,
            signature_scheme,
            owner,
            signing_key,
            voucher_seeds,
        )
    }

    /// Issue a future signature voucher via CPI: the right to have the
    /// network sign one message once, in two steps.
    ///
    /// Creates a `FutureSignatureVoucher` at `future_signature_voucher`.
    /// The arguments and the accounts are `issue_signature_voucher`'s; only
    /// the instruction differs. `signing_key` is the key the step-1
    /// request must come from. Step 1 clears it, so the owner sets the
    /// completion's key afterwards with `set_voucher_signing_key`, which,
    /// like `revoke_signature_voucher` and `transfer_signature_voucher`,
    /// acts on a future voucher too.
    pub fn issue_future_signature_voucher(
        &self,
        coordinator: &'a AccountView,
        future_signature_voucher: &'a AccountView,
        dwallet: &'a AccountView,
        payer: &'a AccountView,
        system_program: &'a AccountView,
        message_digest: [u8; 32],
        message_metadata_digest: [u8; 32],
        signature_scheme: u16,
        owner: Option<[u8; 32]>,
        signing_key: Option<[u8; 32]>,
        voucher_seeds: Option<&[Seed]>,
    ) -> ProgramResult {
        self.issue_voucher(
            IX_ISSUE_FUTURE_SIGNATURE_VOUCHER,
            coordinator,
            future_signature_voucher,
            dwallet,
            payer,
            system_program,
            message_digest,
            message_metadata_digest,
            signature_scheme,
            owner,
            signing_key,
            voucher_seeds,
        )
    }

    /// Issue either voucher type: `discriminator` picks the instruction.
    /// The two take the same data and the same accounts.
    fn issue_voucher(
        &self,
        discriminator: u8,
        coordinator: &'a AccountView,
        signature_voucher: &'a AccountView,
        dwallet: &'a AccountView,
        payer: &'a AccountView,
        system_program: &'a AccountView,
        message_digest: [u8; 32],
        message_metadata_digest: [u8; 32],
        signature_scheme: u16,
        owner: Option<[u8; 32]>,
        signing_key: Option<[u8; 32]>,
        voucher_seeds: Option<&[Seed]>,
    ) -> ProgramResult {
        // Build instruction data: [discriminator, message_digest(32),
        //   message_metadata_digest(32), signature_scheme(2), flags(1),
        //   owner(32)?, signing_key(32)?] = 68 to 132 bytes
        let mut ix_data = Vec::with_capacity(132);
        ix_data.push(discriminator);
        ix_data.extend_from_slice(&message_digest);
        ix_data.extend_from_slice(&message_metadata_digest);
        ix_data.extend_from_slice(&signature_scheme.to_le_bytes());
        let owner_flag = if owner.is_some() {
            ISSUE_VOUCHER_HAS_OWNER
        } else {
            0
        };
        let signing_key_flag = if signing_key.is_some() {
            ISSUE_VOUCHER_HAS_SIGNING_KEY
        } else {
            0
        };
        ix_data.push(owner_flag | signing_key_flag);
        if let Some(owner) = owner {
            ix_data.extend_from_slice(&owner);
        }
        if let Some(signing_key) = signing_key {
            ix_data.extend_from_slice(&signing_key);
        }

        let instruction_accounts = [
            InstructionAccount::readonly(coordinator.address()),
            InstructionAccount::writable_signer(signature_voucher.address()),
            InstructionAccount::readonly(dwallet.address()),
            InstructionAccount::readonly(self.caller_program.address()),
            InstructionAccount::readonly_signer(self.cpi_authority.address()),
            InstructionAccount::writable_signer(payer.address()),
            InstructionAccount::readonly(system_program.address()),
        ];

        let bump_byte = [self.cpi_authority_bump];
        let signer_seeds: [Seed; 2] = [Seed::from(CPI_AUTHORITY_SEED), Seed::from(&bump_byte)];
        let cpi_signer = Signer::from(&signer_seeds);

        self.require_ika_program()?;
        let instruction = InstructionView {
            program_id: self.dwallet_program.address(),
            accounts: &instruction_accounts,
            data: &ix_data,
        };

        let account_views = [
            coordinator,
            signature_voucher,
            dwallet,
            self.caller_program,
            self.cpi_authority,
            payer,
            system_program,
            self.dwallet_program,
        ];
        match voucher_seeds {
            Some(voucher_seeds) => invoke_signed(
                &instruction,
                &account_views,
                &[cpi_signer, Signer::from(voucher_seeds)],
            ),
            None => invoke_signed(&instruction, &account_views, &[cpi_signer]),
        }
    }

    /// Set a voucher's signing key via CPI.
    ///
    /// The voucher must be pending, and its owner must be this program's CPI
    /// authority PDA.
    ///
    /// # Accounts (program mode)
    ///
    /// - `signature_voucher`: writable, program-owned — the voucher
    /// - `caller_program`: readonly, executable — the calling program (from context)
    /// - `cpi_authority`: readonly, signer — the CPI authority PDA (from context)
    pub fn set_voucher_signing_key(
        &self,
        signature_voucher: &'a AccountView,
        signing_key: [u8; 32],
    ) -> ProgramResult {
        self.voucher_control(
            IX_SET_VOUCHER_SIGNING_KEY,
            signature_voucher,
            Some(signing_key),
        )
    }

    /// Revoke a voucher via CPI, so no sign request for it is agreed from
    /// then on.
    ///
    /// The voucher must be pending, and its owner must be this program's CPI
    /// authority PDA. Accounts as for `set_voucher_signing_key`.
    pub fn revoke_signature_voucher(&self, signature_voucher: &'a AccountView) -> ProgramResult {
        self.voucher_control(IX_REVOKE_SIGNATURE_VOUCHER, signature_voucher, None)
    }

    /// Transfer a voucher to a new owner via CPI.
    ///
    /// The voucher's owner must be this program's CPI authority PDA.
    /// Accounts as for `set_voucher_signing_key`.
    pub fn transfer_signature_voucher(
        &self,
        signature_voucher: &'a AccountView,
        new_owner: [u8; 32],
    ) -> ProgramResult {
        self.voucher_control(
            IX_TRANSFER_SIGNATURE_VOUCHER,
            signature_voucher,
            Some(new_owner),
        )
    }

    /// The three voucher controls share their accounts: the voucher, then
    /// the calling program and its CPI authority. `key` is the instruction's
    /// 32-byte data, or `None` for the revoke, which takes none.
    fn voucher_control(
        &self,
        discriminator: u8,
        signature_voucher: &'a AccountView,
        key: Option<[u8; 32]>,
    ) -> ProgramResult {
        let mut ix_data = Vec::with_capacity(33);
        ix_data.push(discriminator);
        if let Some(key) = key {
            ix_data.extend_from_slice(&key);
        }

        let instruction_accounts = [
            InstructionAccount::writable(signature_voucher.address()),
            InstructionAccount::readonly(self.caller_program.address()),
            InstructionAccount::readonly_signer(self.cpi_authority.address()),
        ];

        let bump_byte = [self.cpi_authority_bump];
        let signer_seeds: [Seed; 2] = [Seed::from(CPI_AUTHORITY_SEED), Seed::from(&bump_byte)];
        let signer = Signer::from(&signer_seeds);

        self.require_ika_program()?;
        let instruction = InstructionView {
            program_id: self.dwallet_program.address(),
            accounts: &instruction_accounts,
            data: &ix_data,
        };

        invoke_signed(
            &instruction,
            &[
                signature_voucher,
                self.caller_program,
                self.cpi_authority,
                self.dwallet_program,
            ],
            &[signer],
        )
    }

    /// Transfer dWallet ownership via CPI.
    ///
    /// Transfers ownership of a dWallet to a new owner pubkey.
    /// The dWallet's current owner must be this program's CPI authority PDA.
    ///
    /// # Accounts (program mode)
    ///
    /// - `caller_program`: readonly, executable — the calling program (from context)
    /// - `cpi_authority`: readonly, signer — the CPI authority PDA (from context)
    /// - `dwallet`: writable, program-owned — the dWallet account
    pub fn transfer_dwallet(&self, dwallet: &'a AccountView, new_owner: [u8; 32]) -> ProgramResult {
        // Build instruction data: [discriminator, new_owner(32)]
        let mut ix_data = Vec::with_capacity(33);
        ix_data.push(IX_TRANSFER_OWNERSHIP);
        ix_data.extend_from_slice(&new_owner);

        let instruction_accounts = [
            InstructionAccount::readonly(self.caller_program.address()),
            InstructionAccount::readonly_signer(self.cpi_authority.address()),
            InstructionAccount::writable(dwallet.address()),
        ];

        let bump_byte = [self.cpi_authority_bump];
        let signer_seeds: [Seed; 2] = [Seed::from(CPI_AUTHORITY_SEED), Seed::from(&bump_byte)];
        let signer = Signer::from(&signer_seeds);

        self.require_ika_program()?;
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
}
