// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! Pinocchio CPI SDK for the Ika dWallet program.
//!
//! Provides `DWalletContext` for calling dWallet instructions via CPI
//! from other Pinocchio programs.
//!
//! # Usage
//!
//! ```ignore
//! use ika_dwallet_pinocchio::DWalletContext;
//!
//! let ctx = DWalletContext {
//!     dwallet_program: &dwallet_program_account,
//!     cpi_authority: &cpi_authority_account,
//!     caller_program: &my_program_account,
//!     cpi_authority_bump: bump,
//! };
//!
//! ctx.issue_signature_voucher(
//!     &coordinator,
//!     &signature_voucher,
//!     &dwallet,
//!     &payer,
//!     &system_program,
//!     message_digest,
//!     message_metadata_digest,
//!     signature_scheme,
//!     None,              // owner: this program's CPI authority
//!     Some(signing_key), // the key a sign request must come from
//!     Some(&voucher_seeds),
//! )?;
//! ```

#![no_std]

pub mod cpi;

pub use cpi::*;

/// Seed for deriving the CPI authority PDA from a caller program.
/// A calling program derives: `find_program_address(&[CPI_AUTHORITY_SEED], caller_program_id)`.
pub const CPI_AUTHORITY_SEED: &[u8] = b"__ika_cpi_authority";
/// The ika protocol program's address on the network this crate was built
/// for: one network feature picks it (`devnet-pre-alpha` for the Solana
/// devnet pre-alpha, `localnet` for a local validator), and with none it is
/// the local development placeholder the test suites use. It comes from the
/// `ika-protocol-program-id` crate, the one place it is written.
/// `DWalletContext` calls no other program as the dWallet program, and a
/// program that reads a dWallet account checks the account's owner is this.
pub const ID: pinocchio::Address = pinocchio::Address::new_from_array(ika_protocol_program_id::ID);
