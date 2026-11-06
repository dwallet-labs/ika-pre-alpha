// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

import { keccak_256 } from '@noble/hashes/sha3.js';

/**
 * The signature scheme of the key that signs a gRPC request, named as the
 * `UserSignature` variants are.
 */
export type GrpcRequestSignerScheme = 'Ed25519' | 'Secp256k1' | 'Secp256r1';

/**
 * The byte each scheme has in the session identifier: the index of its
 * `UserSignature` variant, which is also its `SignatureScheme` discriminant
 * in `ika-types`.
 */
const SIGNER_SCHEME_BYTE: Record<GrpcRequestSignerScheme, number> = {
	Ed25519: 0,
	Secp256k1: 1,
	Secp256r1: 2,
};

/**
 * The session identifier a gRPC request opens:
 * `keccak256(be64(0) || "GRPC" || be64(epoch) || scheme || signerPublicKey || preimage)`.
 * It must match `SessionIdentifier::new_grpc_request` in `ika-types`.
 *
 * `signerPublicKey` is the key that signs the request, the same key its gas
 * deposit is kept under. It is part of the hash, so another key that names
 * the same preimage opens a different session and cannot take this one.
 * `scheme` is one byte that fixes the key's length and curve: an Ed25519 key
 * is 32 bytes and a secp256k1 or secp256r1 key is 33.
 */
export function grpcSessionIdentifier(
	epoch: bigint,
	signerScheme: GrpcRequestSignerScheme,
	signerPublicKey: Uint8Array,
	preimage: Uint8Array,
): Uint8Array {
	const versionBytes = new Uint8Array(8); // version 0, big-endian
	const epochBytes = new Uint8Array(8);
	new DataView(epochBytes.buffer).setBigUint64(0, epoch, false);
	return keccak_256(
		Uint8Array.from([
			...versionBytes,
			...new TextEncoder().encode('GRPC'),
			...epochBytes,
			SIGNER_SCHEME_BYTE[signerScheme],
			...signerPublicKey,
			...preimage,
		]),
	);
}
