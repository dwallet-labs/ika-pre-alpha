// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The ika dWallet SDK on Solana, with `@solana/kit`: `IkaClient` sends the
 * network's requests and reads the ika program's accounts, `IkaTransaction`
 * makes the program's instructions as kit `Instruction`s, and
 * `UserShareEncryptionKeys` holds the user's keys. Every address is a kit
 * `Address`. The instructions are built with `@solana/web3.js` inside the
 * SDK, so it must be installed too.
 */

// The ika dWallet SDK: `IkaClient` sends the network's requests and reads the
// chain, `IkaTransaction` adds the chain's calls to a transaction the app's
// wallet signs, and `UserShareEncryptionKeys` holds the user's keys.
export {
	EpochClosedBeforeAnswer,
	Curve,
	decodeSignedRequest,
	Hash,
	PresignExpiredWithTheEpoch,
	RequestRanBeforeAnswer,
	RequestKey,
	SignatureAlgorithm,
	stopWasmWorker,
	UserShareEncryptionKeys,
	useWasmWorker,
} from '@ika.xyz/sdk-core/common';
export type {
	CreatedDWallet,
	DecodedRequest,
	DWallet,
	GrpcEndpoint,
	IkaNetwork,
	NetworkKeyId,
	PartialUserSignature,
	PendingRequest,
	Presign,
	ReEncryptedShare,
	RequestSigner,
	SessionResolution,
	ShareAcceptanceSignature,
	SignDuringDKGRequest,
	WaitOptions,
	WasmWorker,
} from '@ika.xyz/sdk-core/common';
/** The client of the validators' gRPC: the Node client in Node, and the gRPC-Web client in a browser. */
export { DWalletGrpcClient } from '@ika.xyz/sdk-core/auto';
export { IkaClient } from './ika-client.js';
export type { IkaClientOptions, IkaConfig } from './ika-client.js';
export { IkaTransaction } from './ika-transaction.js';
export type { ApproveMessageParams, IkaTransactionParams } from './ika-transaction.js';
export { TransactionTooLargeError } from '../web3/ika-transaction.js';
export type { GetAccount, SolanaReadCrossCheck } from '../read-cross-check.js';
export type { EncryptionKeyEntry } from '../instructions.js';
