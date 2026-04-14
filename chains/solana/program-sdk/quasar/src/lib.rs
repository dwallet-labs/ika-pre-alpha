// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! Quasar CPI SDK for the Ika dWallet program.
//!
//! Provides `DWalletContext` for calling dWallet instructions via CPI
//! from other Quasar programs.
//!
//! # Usage
//!
//! ```ignore
//! use ika_dwallet_quasar::DWalletContext;
//!
//! let ctx = DWalletContext {
//!     dwallet_program: &dwallet_program_view,
//!     cpi_authority: &cpi_authority_view,
//!     caller_program: &caller_program_view,
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

pub mod cpi;

pub use cpi::*;

/// Seed for deriving the CPI authority PDA from a caller program.
/// A calling program derives: `Address::find_program_address(&[CPI_AUTHORITY_SEED], caller_program_id)`.
pub const CPI_AUTHORITY_SEED: &[u8] = b"__ika_cpi_authority";
