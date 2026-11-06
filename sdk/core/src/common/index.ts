// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The part of the ika dWallet SDK every chain shares: the request engine,
 * the base of each chain's `IkaClient`, and the user's keys. An app imports
 * its chain's package, `@ika.xyz/sdk-sui` or `@ika.xyz/sdk-solana`, which
 * re-exports what an app uses from here.
 */
export { Curve, Hash, SignatureAlgorithm, stopWasmWorker, useWasmWorker } from '../index.js';
export type { IkaNetwork, NetworkKeyId, ShareAcceptanceSignature, WasmWorker } from '../index.js';
export {
	EpochClosedBeforeAnswer,
	isImported,
	Network,
	PresignExpiredWithTheEpoch,
	SIGNATURE_SCHEMES,
	signatureSchemeNumber,
} from './engine.js';
export type {
	DWallet,
	PartialSignature as PartialUserSignature,
	Presign,
	ReEncryptedShare,
	Requester,
} from './engine.js';
export { IkaClientBase } from './ika-client-base.js';
export type {
	CreatedDWallet,
	GrpcClientClass,
	GrpcEndpoint,
	IkaClientBaseOptions,
	SessionResolution,
	SignDuringDKGRequest,
	VoucherApproval,
} from './ika-client-base.js';
export { presignSchemeOf, signatureSchemeOf } from './schemes.js';
export {
	holderKeypair,
	requestKeypair,
	UserShareEncryptionKeys,
} from './user-share-encryption-keys.js';
export {
	encryptedShareAttestationBytes,
	findSession,
	gasChargeId,
	publicShareAttestationBytes,
	RequestRanBeforeAnswer,
	settledAtEpoch,
	signatureCommitItemId,
} from './request-records.js';
export type {
	GasChargeSource,
	PendingRequest,
	PendingRequestBase,
	PendingRequestKind,
	RequestOutcome,
	RequestRecordReader,
} from './request-records.js';
export { poll } from './wait.js';
export type { WaitOptions } from './wait.js';
export { decodeSignedRequest, RequestKey } from './request-key.js';
export type { DecodedRequest, RequestSigner } from './request-key.js';
