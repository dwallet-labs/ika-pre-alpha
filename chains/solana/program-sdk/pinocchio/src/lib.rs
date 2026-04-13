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
//! ctx.approve_message(
//!     &coordinator,
//!     &message_approval,
//!     &dwallet,
//!     &payer,
//!     &system_program,
//!     message_digest,
//!     message_metadata_digest,
//!     user_pubkey,
//!     signature_scheme,
//!     bump,
//! )?;
//! ```

#![no_std]

pub mod cpi;

pub use cpi::*;

/// Seed for deriving the CPI authority PDA from a caller program.
/// A calling program derives: `find_program_address(&[CPI_AUTHORITY_SEED], caller_program_id)`.
pub const CPI_AUTHORITY_SEED: &[u8] = b"__ika_cpi_authority";
