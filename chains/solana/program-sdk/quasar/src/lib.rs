// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! Quasar CPI SDK for the Ika dWallet program.

#![cfg_attr(not(test), no_std)]

pub mod cpi;

pub use cpi::*;

/// Seed for deriving the CPI authority PDA from a caller program.
pub const CPI_AUTHORITY_SEED: &[u8] = b"__ika_cpi_authority";
