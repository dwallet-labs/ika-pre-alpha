// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * `createClassGroupsKeypair` derives a class-groups keypair with the portable
 * sampler, so a seed gives the same key bytes here as native Rust.
 *
 * The expected values are the SHA-256 of the key bytes that native Rust's
 * `generate_cg_keypair_from_seed` gives for the seed of 32 bytes of 42, one
 * pair per curve. They are the fingerprints the network's native Rust code
 * pins. The keypair here comes
 * from the real WASM, which is a 32-bit target, so the test fails if the core
 * ever derives keys with the historical sampler, whose bytes differ by
 * platform.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';

import { createClassGroupsKeypair } from '../../src/client/cryptography';
import { Curve } from '../../src/client/types';

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

const seed = new Uint8Array(32).fill(42);

// Native Rust's private key fingerprint is the same on every curve.
const privateKeyFingerprint = 'a60572fa54a24f66fec043e5f4c47d652163dbfd1568671062288c5ad6ebaacc';

const nativePublicKeyFingerprints: [Curve, string][] = [
	[Curve.SECP256K1, '7415d98b6969534c7100d9db1030c804089295974d705f44abbd8d4b0e3d2cf8'],
	[Curve.SECP256R1, '7cb749c22b960baf812086ea162cfa9d22f1f99a05e7c288e83958e5b7b578f1'],
	[Curve.ED25519, 'ddf91a1b79eba0fa9a335627b5fca83baafeaaaad8f41e3f521ecd5fe1bf3eeb'],
	[Curve.RISTRETTO, 'ddf91a1b79eba0fa9a335627b5fca83baafeaaaad8f41e3f521ecd5fe1bf3eeb'],
];

describe('createClassGroupsKeypair', () => {
	it.each(nativePublicKeyFingerprints)(
		'gives the key bytes of native generate_cg_keypair_from_seed for %s',
		async (curve, publicKeyFingerprint) => {
			const keys = await createClassGroupsKeypair(seed, curve);
			const publicKey = toHex(sha256(keys.encryptionKey));
			const privateKey = toHex(sha256(keys.decryptionKey));
			expect(publicKey, 'the encryption key equals native Rust').toBe(publicKeyFingerprint);
			expect(privateKey, 'the decryption key equals native Rust').toBe(privateKeyFingerprint);
		},
	);
});
