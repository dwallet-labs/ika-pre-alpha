// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The signing of a request's bytes by the transport key, for any request
 * kind. The package entry point does not export it: `signGrpcRequest` uses
 * it for every kind but a sign, and `signDWalletSignRequest` uses it for a
 * sign once the ownership check has passed.
 */
import { ed25519 } from '@noble/curves/ed25519.js';

import { SignedRequestDataBcs, UserSignatureBcs } from './bcs.js';
import {
	assertRequestFieldsWithinLimits,
	assertSignedRequestDataWithinLimit,
} from './request-size-limits.js';

/**
 * The first bytes of the message a user signs for a request: the byte `0xFF`
 * and the text `ika-request` (`REQUEST_SIGNING_PREFIX` in the node's
 * `ika-types`). A validator verifies a request's signature over this prefix
 * and then the request's BCS bytes, never over the bare bytes. The bytes sent,
 * their digest and the session identifier do not include the prefix.
 *
 * The prefix keeps a request apart from every other message the key may
 * sign. A Solana wallet signs a transaction's message bytes as they are, and
 * no Solana transaction message starts with `0xFF`. Without the prefix, a
 * Solana message can be laid out so that its bytes also decode as a request.
 */
export const REQUEST_SIGNING_PREFIX: Uint8Array = Uint8Array.from([
	0xff,
	...new TextEncoder().encode('ika-request'),
]);

/**
 * The message a user signs, and a validator verifies, for a request whose BCS
 * bytes are `signedRequestData`: `REQUEST_SIGNING_PREFIX`, then the bytes
 * unchanged.
 */
export function requestSigningMessage(signedRequestData: ArrayLike<number>): Uint8Array {
	return Uint8Array.from([...REQUEST_SIGNING_PREFIX, ...Array.from(signedRequestData)]);
}

/** 32-byte Ed25519 secret key and its public key. */
export interface TransportKeypair {
	secretKey: Uint8Array;
	publicKey: Uint8Array;
}

/**
 * BCS-encode `signedData` and sign it with the transport key.
 *
 * Throws, and signs nothing, when the request is over one of the network's
 * size limits (`GRPC_REQUEST_SIZE_LIMITS`). The network would refuse such a
 * request and charge the signer for it. Each byte field is checked before the
 * request is encoded. The whole request is checked once it is encoded,
 * because its length exists only then.
 */
export function signRequestBytes(
	keypair: TransportKeypair,
	signedData: Parameters<typeof SignedRequestDataBcs.serialize>[0],
): { userSignature: Uint8Array; signedRequestData: Uint8Array } {
	assertRequestFieldsWithinLimits(signedData);
	return signSerializedRequest(keypair, SignedRequestDataBcs.serialize(signedData).toBytes());
}

/**
 * Sign the BCS bytes of a `SignedRequestData` with the transport key: the
 * signature is over `requestSigningMessage` of the bytes, and the bytes are
 * returned exactly as given. Throws, and signs nothing, when the bytes are
 * over the network's limit for a whole signed request.
 */
export function signSerializedRequest(
	keypair: TransportKeypair,
	signedRequestData: Uint8Array,
): { userSignature: Uint8Array; signedRequestData: Uint8Array } {
	assertSignedRequestDataWithinLimit(signedRequestData);
	const signature = ed25519.sign(requestSigningMessage(signedRequestData), keypair.secretKey);
	const userSignature = UserSignatureBcs.serialize({
		Ed25519: {
			signature: Array.from(signature),
			public_key: Array.from(keypair.publicKey),
		},
	}).toBytes();
	return { userSignature, signedRequestData };
}
