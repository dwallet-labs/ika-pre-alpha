// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! Native (`solana-program`) CPI SDK for the Ika dWallet program.
//!
//! Provides [`DWalletContext`] for calling dWallet instructions via CPI
//! from programs built with `solana-program` (the standard Solana runtime crate).
//!
//! # Usage
//!
//! ```ignore
//! use ika_dwallet_native::DWalletContext;
//!
//! let ctx = DWalletContext {
//!     dwallet_program: &dwallet_program_info,
//!     cpi_authority: &cpi_authority_info,
//!     caller_program: &my_program_info,
//!     cpi_authority_bump: bump,
//! };
//!
//! ctx.issue_signature_voucher(
//!     &coordinator_info,
//!     &signature_voucher_info,
//!     &dwallet_info,
//!     &payer_info,
//!     &system_program_info,
//!     message_digest,
//!     message_metadata_digest,
//!     signature_scheme,
//!     None,              // owner: this program's CPI authority
//!     Some(signing_key), // the key a sign request must come from
//!     Some(voucher_seeds),
//! )?;
//! ```

use solana_program::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
};

/// Seed for deriving the CPI authority PDA from a caller program.
/// A calling program derives: `Pubkey::find_program_address(&[CPI_AUTHORITY_SEED], caller_program_id)`.
pub const CPI_AUTHORITY_SEED: &[u8] = b"__ika_cpi_authority";
/// The ika protocol program's address on the network this crate was built
/// for: one network feature picks it (`devnet-pre-alpha` for the Solana
/// devnet pre-alpha, `localnet` for a local validator), and with none it is
/// the local development placeholder the test suites use. It comes from the
/// `ika-protocol-program-id` crate, the one place it is written.
/// `DWalletContext` calls no other program as the dWallet program, and a
/// program that reads a dWallet account checks the account's owner is this.
pub const ID: Pubkey = Pubkey::new_from_array(ika_protocol_program_id::ID);

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

/// CPI context for invoking Ika dWallet instructions from native programs.
///
/// The calling program signs via its CPI authority PDA, which the dWallet
/// program verifies using `verify_signer_or_cpi`.
pub struct DWalletContext<'a, 'info> {
    /// The Ika dWallet program account.
    pub dwallet_program: &'a AccountInfo<'info>,
    /// The CPI authority PDA (derived from caller program).
    pub cpi_authority: &'a AccountInfo<'info>,
    /// The calling program account (must be executable).
    pub caller_program: &'a AccountInfo<'info>,
    /// Bump seed for the CPI authority PDA.
    pub cpi_authority_bump: u8,
}

impl<'a, 'info> DWalletContext<'a, 'info> {
    /// Refuse a `dwallet_program` that is not the ika program, [`crate::ID`],
    /// with `IncorrectProgramId`, before any call is made.
    ///
    /// Every call below is signed by this program's CPI authority, and a
    /// signer stays a signer in every call the called program makes in turn.
    /// A program that only claims to be ika's could pass that signature on to
    /// the real ika program and act on any dWallet this program holds. So
    /// the address is compared with the one this crate was built for, and
    /// nothing is called anywhere else.
    fn require_ika_program(&self) -> Result<(), ProgramError> {
        if self.dwallet_program.key != &ID {
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
    /// - `coordinator`: readonly -- the DWalletCoordinator PDA (for epoch)
    /// - `signature_voucher`: writable, signer, empty -- the voucher to create
    /// - `dwallet`: readonly, program-owned -- the dWallet account
    /// - `caller_program`: readonly, executable -- the calling program (from context)
    /// - `cpi_authority`: readonly, signer -- the CPI authority PDA (from context)
    /// - `payer`: writable, signer -- pays for the voucher's rent
    /// - `system_program`: readonly -- the system program
    pub fn issue_signature_voucher(
        &self,
        coordinator: &AccountInfo<'info>,
        signature_voucher: &AccountInfo<'info>,
        dwallet: &AccountInfo<'info>,
        payer: &AccountInfo<'info>,
        system_program: &AccountInfo<'info>,
        message_digest: [u8; 32],
        message_metadata_digest: [u8; 32],
        signature_scheme: u16,
        owner: Option<[u8; 32]>,
        signing_key: Option<[u8; 32]>,
        voucher_seeds: Option<&[&[u8]]>,
    ) -> Result<(), ProgramError> {
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
        coordinator: &AccountInfo<'info>,
        future_signature_voucher: &AccountInfo<'info>,
        dwallet: &AccountInfo<'info>,
        payer: &AccountInfo<'info>,
        system_program: &AccountInfo<'info>,
        message_digest: [u8; 32],
        message_metadata_digest: [u8; 32],
        signature_scheme: u16,
        owner: Option<[u8; 32]>,
        signing_key: Option<[u8; 32]>,
        voucher_seeds: Option<&[&[u8]]>,
    ) -> Result<(), ProgramError> {
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
        coordinator: &AccountInfo<'info>,
        signature_voucher: &AccountInfo<'info>,
        dwallet: &AccountInfo<'info>,
        payer: &AccountInfo<'info>,
        system_program: &AccountInfo<'info>,
        message_digest: [u8; 32],
        message_metadata_digest: [u8; 32],
        signature_scheme: u16,
        owner: Option<[u8; 32]>,
        signing_key: Option<[u8; 32]>,
        voucher_seeds: Option<&[&[u8]]>,
    ) -> Result<(), ProgramError> {
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

        self.require_ika_program()?;
        let ix = Instruction {
            program_id: *self.dwallet_program.key,
            accounts: vec![
                AccountMeta::new_readonly(*coordinator.key, false),
                AccountMeta::new(*signature_voucher.key, true),
                AccountMeta::new_readonly(*dwallet.key, false),
                AccountMeta::new_readonly(*self.caller_program.key, false),
                AccountMeta::new_readonly(*self.cpi_authority.key, true),
                AccountMeta::new(*payer.key, true),
                AccountMeta::new_readonly(*system_program.key, false),
            ],
            data: ix_data,
        };

        let account_infos = [
            coordinator.clone(),
            signature_voucher.clone(),
            dwallet.clone(),
            self.caller_program.clone(),
            self.cpi_authority.clone(),
            payer.clone(),
            system_program.clone(),
            self.dwallet_program.clone(),
        ];

        let cpi_seeds: &[&[u8]] = &[CPI_AUTHORITY_SEED, &[self.cpi_authority_bump]];
        match voucher_seeds {
            Some(voucher_seeds) => invoke_signed(&ix, &account_infos, &[cpi_seeds, voucher_seeds]),
            None => invoke_signed(&ix, &account_infos, &[cpi_seeds]),
        }
    }

    /// Set a voucher's signing key via CPI.
    ///
    /// The voucher must be pending, and its owner must be this program's CPI
    /// authority PDA.
    ///
    /// # Accounts (program mode)
    ///
    /// - `signature_voucher`: writable, program-owned -- the voucher
    /// - `caller_program`: readonly, executable -- the calling program (from context)
    /// - `cpi_authority`: readonly, signer -- the CPI authority PDA (from context)
    pub fn set_voucher_signing_key(
        &self,
        signature_voucher: &AccountInfo<'info>,
        signing_key: [u8; 32],
    ) -> Result<(), ProgramError> {
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
    pub fn revoke_signature_voucher(
        &self,
        signature_voucher: &AccountInfo<'info>,
    ) -> Result<(), ProgramError> {
        self.voucher_control(IX_REVOKE_SIGNATURE_VOUCHER, signature_voucher, None)
    }

    /// Transfer a voucher to a new owner via CPI.
    ///
    /// The voucher's owner must be this program's CPI authority PDA.
    /// Accounts as for `set_voucher_signing_key`.
    pub fn transfer_signature_voucher(
        &self,
        signature_voucher: &AccountInfo<'info>,
        new_owner: [u8; 32],
    ) -> Result<(), ProgramError> {
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
        signature_voucher: &AccountInfo<'info>,
        key: Option<[u8; 32]>,
    ) -> Result<(), ProgramError> {
        let mut ix_data = Vec::with_capacity(33);
        ix_data.push(discriminator);
        if let Some(key) = key {
            ix_data.extend_from_slice(&key);
        }

        self.require_ika_program()?;
        let ix = Instruction {
            program_id: *self.dwallet_program.key,
            accounts: vec![
                AccountMeta::new(*signature_voucher.key, false),
                AccountMeta::new_readonly(*self.caller_program.key, false),
                AccountMeta::new_readonly(*self.cpi_authority.key, true),
            ],
            data: ix_data,
        };

        let account_infos = [
            signature_voucher.clone(),
            self.caller_program.clone(),
            self.cpi_authority.clone(),
            self.dwallet_program.clone(),
        ];

        let cpi_seeds: &[&[u8]] = &[CPI_AUTHORITY_SEED, &[self.cpi_authority_bump]];
        invoke_signed(&ix, &account_infos, &[cpi_seeds])
    }

    /// Transfer dWallet ownership via CPI.
    ///
    /// Transfers ownership of a dWallet to a new owner pubkey.
    /// The dWallet's current owner must be this program's CPI authority PDA.
    ///
    /// # Accounts (program mode)
    ///
    /// - `caller_program`: readonly, executable -- the calling program (from context)
    /// - `cpi_authority`: readonly, signer -- the CPI authority PDA (from context)
    /// - `dwallet`: writable, program-owned -- the dWallet account
    pub fn transfer_dwallet(
        &self,
        dwallet: &AccountInfo<'info>,
        new_owner: &Pubkey,
    ) -> Result<(), ProgramError> {
        let mut ix_data = Vec::with_capacity(33);
        ix_data.push(IX_TRANSFER_OWNERSHIP);
        ix_data.extend_from_slice(new_owner.as_ref());

        self.require_ika_program()?;
        let ix = Instruction {
            program_id: *self.dwallet_program.key,
            accounts: vec![
                AccountMeta::new_readonly(*self.caller_program.key, false),
                AccountMeta::new_readonly(*self.cpi_authority.key, true),
                AccountMeta::new(*dwallet.key, false),
            ],
            data: ix_data,
        };

        let account_infos = &[
            self.caller_program.clone(),
            self.cpi_authority.clone(),
            dwallet.clone(),
            self.dwallet_program.clone(),
        ];

        let seeds = &[CPI_AUTHORITY_SEED, &[self.cpi_authority_bump]];
        invoke_signed(&ix, account_infos, &[seeds])
    }
}
