// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * Solana-as-counterparty helpers for the ika dWallet request flow.
 *
 * What is here is what is specific to Solana: the addresses the ika-dwallet
 * program stores its accounts at, and the instruction bytes and account
 * discriminators it answers to. Both come from
 * the program's wire table (`src/wire-tables-data.ts`), the same table the
 * program's tests and the node read.
 *
 * What is NOT here is the request format. A dWallet request is the same on
 * every chain, and it is defined once, in `@ika.xyz/pre-alpha-core` — import
 * `SignedRequestDataBcs`, `signGrpcRequest` and `grpcSessionIdentifier`
 * from there, and `DWalletGrpcClient` from `@ika.xyz/pre-alpha-core/client`. This package used to carry a second copy
 * of that schema; the copy had drifted, so requests built through it
 * serialized to bytes no validator accepts.
 *
 * The instruction builders are NOT here. They are the one part of this
 * package that is not plain bytes — they build `@solana/web3.js`
 * transaction instructions — so they are a subpath,
 * `@ika.xyz/pre-alpha-solana/instructions`, and importing that
 * subpath is what requires the peer dependency. Everything this file
 * exports resolves with nothing installed but `@noble`, `@mysten/bcs` and
 * the core, `@ika.xyz/pre-alpha-core`.
 */

export * from './accounts.js';
export * from './addresses.js';
export * from './gas-deposits.js';
export * from './network-key-output.js';
export * from './read-cross-check.js';
export * from './record-checks.js';
export * from './usability.js';
export * from './wire-tables.js';
export * from './committee-reader.js';
