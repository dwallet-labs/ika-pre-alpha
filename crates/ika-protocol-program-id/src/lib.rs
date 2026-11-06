// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! The ika protocol program's address on each network, as 32 bytes.
//!
//! This is the one place the address is written. The ika program is built
//! against the same address, and the program SDK crates (`ika-dwallet-pinocchio`,
//! `ika-dwallet-native`, `ika-dwallet-anchor`) export the same address as their
//! `ID`. Their `DWalletContext` refuses any other program as the dWallet
//! program, so a program that holds dWallets never makes a call, signed by its
//! CPI authority, to a program that only claims to be ika's.
//!
//! One network feature picks the address: `devnet-pre-alpha`, `devnet-alpha1`,
//! `devnet-alpha2`, `devnet-beta`, `devnet`, `mainnet` or `localnet`. With
//! none, the address is the local development placeholder the test suites
//! load the program at.

#![no_std]

// Only one network feature can be enabled at a time.
#[cfg(any(
    all(feature = "mainnet", feature = "devnet"),
    all(feature = "mainnet", feature = "devnet-pre-alpha"),
    all(feature = "mainnet", feature = "devnet-alpha1"),
    all(feature = "mainnet", feature = "devnet-alpha2"),
    all(feature = "mainnet", feature = "devnet-beta"),
    all(feature = "devnet", feature = "devnet-pre-alpha"),
    all(feature = "devnet", feature = "devnet-alpha1"),
    all(feature = "devnet", feature = "devnet-alpha2"),
    all(feature = "devnet", feature = "devnet-beta"),
    all(feature = "devnet-pre-alpha", feature = "devnet-alpha1"),
    all(feature = "devnet-pre-alpha", feature = "devnet-alpha2"),
    all(feature = "devnet-pre-alpha", feature = "devnet-beta"),
    all(feature = "devnet-alpha1", feature = "devnet-alpha2"),
    all(feature = "devnet-alpha1", feature = "devnet-beta"),
    all(feature = "devnet-alpha2", feature = "devnet-beta"),
    all(feature = "localnet", feature = "mainnet"),
    all(feature = "localnet", feature = "devnet"),
    all(feature = "localnet", feature = "devnet-pre-alpha"),
    all(feature = "localnet", feature = "devnet-alpha1"),
    all(feature = "localnet", feature = "devnet-alpha2"),
    all(feature = "localnet", feature = "devnet-beta"),
))]
compile_error!("only one network feature can be enabled at a time");

// The Solana devnet pre-alpha. A pre-alpha wipe can deploy the program at a
// new address; the new address is then written here, and every program built
// with `devnet-pre-alpha` is rebuilt and redeployed.
#[cfg(feature = "devnet-pre-alpha")]
pub const ID: [u8; 32] = [
    // CqGtQgrYFUhobuknomFNntwoxCgKGkBRUtemgdPuM9qT
    0xaf, 0xce, 0x65, 0xd4, 0xf3, 0x5b, 0xdf, 0x36, 0x74, 0xbc, 0x5c, 0x31, 0x14, 0x52, 0x4c, 0x7d,
    0x0f, 0x69, 0x34, 0x17, 0xb5, 0x1f, 0x21, 0x62, 0x99, 0xf1, 0x73, 0x6a, 0xc8, 0xcd, 0x4e, 0xba,
];

// The networks below have no deployment yet: their addresses are
// placeholders, and the assertion further down refuses to build them.

#[cfg(feature = "devnet-alpha1")]
pub const ID: [u8; 32] = [0x00; 32];

#[cfg(feature = "devnet-alpha2")]
pub const ID: [u8; 32] = [0x00; 32];

#[cfg(feature = "devnet-beta")]
pub const ID: [u8; 32] = [0x00; 32];

#[cfg(feature = "devnet")]
pub const ID: [u8; 32] = [0x00; 32];

#[cfg(feature = "mainnet")]
pub const ID: [u8; 32] = [0x00; 32];

// A local validator running the ika program built for `localnet`.
#[cfg(feature = "localnet")]
pub const ID: [u8; 32] = [
    // C77MKGqqiWeNQUXHjCgvoy7NS7kvn8cvq1DVLxtPA8LN
    0xa5, 0x01, 0x38, 0xa7, 0x7d, 0x72, 0x39, 0xbb, 0x53, 0x8d, 0x83, 0x57, 0xe4, 0xf1, 0x8d, 0xed,
    0x2d, 0xcc, 0xca, 0x1e, 0xa3, 0x00, 0x71, 0x52, 0xba, 0x5e, 0x37, 0x30, 0xb9, 0x1d, 0xdd, 0x47,
];

// A network build must never use a placeholder address: a program built
// against an all-zero ika address would refuse every real dWallet. So a
// network whose address is not written yet does not build.
#[cfg(any(
    feature = "devnet-pre-alpha",
    feature = "devnet-alpha1",
    feature = "devnet-alpha2",
    feature = "devnet-beta",
    feature = "devnet",
    feature = "mainnet",
))]
const _: () = assert!(
    !is_all_zeros(&ID),
    "network program id is still the all-zeros placeholder"
);

/// Whether every byte of `address` is zero, at compile time.
#[cfg(any(
    feature = "devnet-pre-alpha",
    feature = "devnet-alpha1",
    feature = "devnet-alpha2",
    feature = "devnet-beta",
    feature = "devnet",
    feature = "mainnet",
))]
const fn is_all_zeros(address: &[u8; 32]) -> bool {
    let mut index = 0;
    while index < address.len() {
        if address[index] != 0 {
            return false;
        }
        index += 1;
    }
    true
}

// No network feature: the local development address. The test suites load
// the ika program here (`bin/ika_protocol_test.so`).
#[cfg(not(any(
    feature = "devnet-pre-alpha",
    feature = "devnet-alpha1",
    feature = "devnet-alpha2",
    feature = "devnet-beta",
    feature = "devnet",
    feature = "mainnet",
    feature = "localnet",
)))]
pub const ID: [u8; 32] = [
    0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f,
    0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x0f, 0x01,
];
