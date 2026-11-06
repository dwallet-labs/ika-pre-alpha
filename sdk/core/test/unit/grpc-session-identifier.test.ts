// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

import { describe, expect, it } from 'vitest';

import { grpcSessionIdentifier } from '../../src/grpc/session-identifier';

/**
 * The identifier a request over the dWallet gRPC transport opens.
 *
 * The client computes it before it sends anything, and the user's half of
 * the distributed key generation is bound to it. Validators recompute it
 * from the epoch, the request's signer and the preimage the request
 * carries, and they refuse a contribution bound to a different identifier.
 * So this derivation has to agree with the network's, byte for byte, or
 * every request this SDK builds is rejected on chain for a reason the
 * error does not name.
 *
 * The vector below is the one the network's Rust code asserts, from the same inputs: epoch 7, a secp256k1 signer whose 33-byte key
 * is `0x02` followed by 32 bytes of `0xCD`, and a preimage of 32 bytes of
 * `0xAB`. Changing either derivation fails one of the two tests.
 */
describe('grpcSessionIdentifier', () => {
	const preimage = new Uint8Array(32).fill(0xab);
	const signer = Uint8Array.from([0x02, ...new Uint8Array(32).fill(0xcd)]);
	const vector = 'eddc4063632578b9f0998c807f9812c17ae7928ed44f352a7187de8bda76d634';

	const hex = (bytes: Uint8Array) =>
		Array.from(bytes)
			.map((byte) => byte.toString(16).padStart(2, '0'))
			.join('');

	it('matches the identifier the network computes', () => {
		expect(hex(grpcSessionIdentifier(7n, 'Secp256k1', signer, preimage))).toBe(vector);
	});

	// The tests below compare against a freshly computed identifier rather
	// than against the vector. Comparing against the vector would pass even
	// if the derivation ignored the input in question, since the result
	// would then differ from the vector for the wrong reason.

	it('gives a different identifier in a different epoch', () => {
		// The epoch is inside the hash so that the same preimage cannot
		// open the same session twice across a boundary.
		expect(hex(grpcSessionIdentifier(8n, 'Secp256k1', signer, preimage))).not.toBe(
			hex(grpcSessionIdentifier(7n, 'Secp256k1', signer, preimage)),
		);
	});

	it('gives a different identifier for a different preimage', () => {
		const other = new Uint8Array(32).fill(0xac);
		expect(hex(grpcSessionIdentifier(7n, 'Secp256k1', signer, other))).not.toBe(
			hex(grpcSessionIdentifier(7n, 'Secp256k1', signer, preimage)),
		);
	});

	it('gives a different identifier for a different signer', () => {
		// The signer is inside the hash so that another key naming the same
		// preimage opens its own session instead of taking this one.
		const otherSigner = Uint8Array.from([0x03, ...new Uint8Array(32).fill(0xcd)]);
		expect(hex(grpcSessionIdentifier(7n, 'Secp256k1', otherSigner, preimage))).not.toBe(
			hex(grpcSessionIdentifier(7n, 'Secp256k1', signer, preimage)),
		);
	});

	it('gives a different identifier for a different scheme over the same key bytes', () => {
		// A secp256k1 key and a secp256r1 key are both 33 bytes. The scheme
		// byte keeps the same bytes under the two curves apart.
		expect(hex(grpcSessionIdentifier(7n, 'Secp256r1', signer, preimage))).not.toBe(
			hex(grpcSessionIdentifier(7n, 'Secp256k1', signer, preimage)),
		);
	});

	it('never repeats: one preimage under two epochs and two signers gives four identifiers', () => {
		// The same four inputs as a test of the network's Rust code.
		const secondSigner = new Uint8Array(32).fill(0xce);
		const identifiers = new Set([
			hex(grpcSessionIdentifier(7n, 'Secp256k1', signer, preimage)),
			hex(grpcSessionIdentifier(8n, 'Secp256k1', signer, preimage)),
			hex(grpcSessionIdentifier(7n, 'Ed25519', secondSigner, preimage)),
			hex(grpcSessionIdentifier(8n, 'Ed25519', secondSigner, preimage)),
		]);
		expect(identifiers.size).toBe(4);
	});
});
