// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * One seed gives the same keys in this SDK and in the Rust SDK: the request key, the holder key and the class-groups
 * encryption key, for the seed 1, 2, ..., 32. The Rust SDK's tests pin the
 * same values.
 */
import { Curve } from '@ika.xyz/sdk-core';
import { UserShareEncryptionKeys } from '@ika.xyz/sdk-core/common';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { describe, expect, it } from 'vitest';

const SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('UserShareEncryptionKeys.fromRootSeedKey', () => {
	it.each([
		[
			Curve.SECP256K1,
			'49500b423344ea32ac30cceaa64c61768c131a987587be4eb92d6e8a32dcaae2',
			'76d2a8cae9c93f8defa9381d3a0a05b0cbdf736fbfc41ff0aa67e0d9b0422c1a',
		],
		[
			Curve.ED25519,
			'95ad64041427d68474bd97b98c5238312f9a84370e4b56fa3260890a558b0bb8',
			'aba5348a82d7e80b912d344d9c23e12c727d413c917dafbe2a3e06ad75bc4d41',
		],
	])(
		'derives the Rust SDK keys on %s',
		async (curve, holder, encryptionKeyDigest) => {
			const keys = await UserShareEncryptionKeys.fromRootSeedKey(SEED, curve);
			expect(hex(keys.getRequestPublicKeyBytes())).toBe(
				'eecf28e13e7dd993aea9bde8bfcae4f701c0584abb74a279b201d8c8472005aa',
			);
			expect(hex(keys.getSigningPublicKeyBytes())).toBe(holder);
			expect(hex(keccak_256(keys.encryptionKey))).toBe(encryptionKeyDigest);
		},
		120_000,
	);
});
