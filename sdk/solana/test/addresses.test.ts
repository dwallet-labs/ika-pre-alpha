// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The addresses this package derives, against the ones the network derives.
 *
 * A wrong derivation does not look like an error. The client polls an
 * address that will never hold an account, and waits until it gives up, so
 * the failure reads as a slow network rather than as a client that is
 * looking in the wrong place. That is why these are vectors and not shapes.
 */
import { describe, expect, it } from 'vitest';

import {
	approvalMessageDigests,
	deriveSeeds,
	dwalletPda,
	dwalletSeedRoot,
	encryptedShareAttestationPda,
	encryptedUserSecretKeySharePda,
	findProgramAddress,
	gasChargePda,
	publicUserShareAttestationPda,
} from '../src/addresses.js';
import { accountDiscriminator, instructionByte } from '../src/wire-tables.js';

const PROGRAM_ID = new Uint8Array(32).fill(7);
const CURVE_SECP256K1 = 0;
const DWALLET_PUBLIC_KEY = new Uint8Array(33).fill(0xaa);
/** The session identifier of the import request in the imported vectors. */
const IMPORT_SESSION = new Uint8Array(32).fill(0x44);

const text = (value: string) => new TextEncoder().encode(value);
const hex = (bytes: Uint8Array) =>
	Array.from(bytes)
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');

describe('gasChargePda', () => {
	/**
	 * The record a node test fixture probes, whose program id is the same
	 * 32 bytes of 7.
	 */
	it('matches the record address the node derives', () => {
		const { address, bump } = gasChargePda(PROGRAM_ID, new Uint8Array(32).fill(0x51));
		expect(Array.from(address)).toEqual([
			194, 35, 47, 109, 29, 152, 92, 207, 1, 168, 140, 75, 9, 17, 168, 37, 51, 42, 70, 109, 254, 18,
			97, 18, 14, 140, 32, 197, 253, 101, 134, 138,
		]);
		expect(bump).toBe(255);
	});
});

describe('dwalletPda', () => {
	it('puts an imported dWallet at the address of its import request', () => {
		// `solana_imported_dwallet_pda_matches_its_vector` asserts the same
		// vector in ika-types.
		const { address, bump } = dwalletPda(
			PROGRAM_ID,
			CURVE_SECP256K1,
			DWALLET_PUBLIC_KEY,
			IMPORT_SESSION,
		);
		expect(Array.from(address)).toEqual([
			187, 127, 28, 233, 148, 64, 207, 84, 111, 112, 72, 141, 176, 86, 185, 227, 78, 17, 222, 62,
			141, 94, 58, 232, 255, 160, 85, 39, 81, 76, 64, 53,
		]);
		expect(bump).toBe(252);
		expect(hex(address)).not.toBe(
			hex(dwalletPda(PROGRAM_ID, CURVE_SECP256K1, DWALLET_PUBLIC_KEY).address),
		);
	});
});

describe('the share addresses', () => {
	/** The holder in the share vectors. */
	const HOLDER = new Uint8Array(32).fill(0x55);

	/**
	 * `solana_share_pdas_match_their_vectors` asserts the same six addresses
	 * in ika-types, from `solana_encrypted_user_share_pda`,
	 * `solana_encrypted_share_attestation_pda` and
	 * `solana_public_user_share_attestation_pda`, which the node writes the
	 * accounts at.
	 */
	it.each([
		[
			"a DKG dWallet's encrypted share",
			() => encryptedUserSecretKeySharePda(PROGRAM_ID, CURVE_SECP256K1, DWALLET_PUBLIC_KEY, HOLDER),
			[
				111, 18, 178, 120, 169, 38, 117, 56, 65, 252, 118, 199, 212, 149, 168, 220, 221, 207, 171,
				58, 131, 251, 169, 124, 90, 84, 239, 68, 186, 12, 41, 75,
			],
		],
		[
			"an imported dWallet's encrypted share",
			() =>
				encryptedUserSecretKeySharePda(
					PROGRAM_ID,
					CURVE_SECP256K1,
					DWALLET_PUBLIC_KEY,
					HOLDER,
					IMPORT_SESSION,
				),
			[
				168, 22, 201, 255, 118, 103, 174, 23, 225, 149, 244, 233, 63, 73, 76, 63, 23, 42, 148, 154,
				88, 99, 146, 117, 127, 104, 181, 212, 13, 213, 83, 242,
			],
		],
		[
			"a DKG dWallet's encrypted share attestation",
			() => encryptedShareAttestationPda(PROGRAM_ID, CURVE_SECP256K1, DWALLET_PUBLIC_KEY, HOLDER),
			[
				80, 33, 194, 126, 33, 94, 58, 148, 66, 124, 63, 51, 105, 153, 174, 147, 253, 150, 136, 13,
				90, 167, 28, 194, 185, 90, 196, 159, 45, 18, 127, 31,
			],
		],
		[
			"an imported dWallet's encrypted share attestation",
			() =>
				encryptedShareAttestationPda(
					PROGRAM_ID,
					CURVE_SECP256K1,
					DWALLET_PUBLIC_KEY,
					HOLDER,
					IMPORT_SESSION,
				),
			[
				248, 135, 73, 51, 20, 101, 120, 165, 160, 95, 102, 196, 127, 165, 228, 107, 49, 197, 217, 7,
				175, 196, 139, 162, 21, 107, 153, 237, 3, 194, 204, 168,
			],
		],
		[
			"a DKG dWallet's public share attestation",
			() => publicUserShareAttestationPda(PROGRAM_ID, CURVE_SECP256K1, DWALLET_PUBLIC_KEY),
			[
				124, 56, 25, 181, 57, 33, 64, 207, 159, 230, 115, 67, 158, 29, 117, 137, 76, 94, 66, 136,
				213, 86, 242, 29, 69, 73, 183, 181, 128, 97, 211, 116,
			],
		],
		[
			"an imported dWallet's public share attestation",
			() =>
				publicUserShareAttestationPda(
					PROGRAM_ID,
					CURVE_SECP256K1,
					DWALLET_PUBLIC_KEY,
					IMPORT_SESSION,
				),
			[
				58, 32, 155, 4, 149, 89, 79, 2, 203, 185, 100, 178, 236, 31, 110, 84, 36, 110, 89, 175, 173,
				33, 156, 112, 133, 55, 29, 226, 252, 58, 202, 72,
			],
		],
	] as const)('derives the address the node derives for %s', (_, derive, expected) => {
		expect(Array.from(derive().address)).toEqual(expected);
	});

	it("puts an imported share's session identifier after the root and before the holder", () => {
		const seeds = deriveSeeds('ImportedEncryptedUserSecretKeyShare', {
			dwallet_root: dwalletSeedRoot(CURVE_SECP256K1, DWALLET_PUBLIC_KEY),
			session_identifier: IMPORT_SESSION,
			encryption_key_owner: HOLDER,
		});
		expect(hex(seeds[0])).toBe(hex(text('dwallet')));
		expect(hex(seeds[1])).toBe(hex(text('imported_encrypted_user_share')));
		expect(seeds[2].length).toBe(32);
		expect(seeds[3].length).toBe(3);
		expect(hex(seeds[4])).toBe(hex(IMPORT_SESSION));
		expect(hex(seeds[5])).toBe(hex(HOLDER));
		expect(seeds.length).toBe(6);
	});
});

describe('the seed order', () => {
	/** The holder of the share the seeds are derived for. */
	const HOLDER = new Uint8Array(32).fill(0x55);

	/**
	 * The tag has to come BEFORE the variable-length root.
	 *
	 * Solana hashes the seeds with nothing between them, so where one seed
	 * ends and the next begins does not exist in the derivation. A tag after
	 * the root can be swallowed by a longer root, which puts one kind of
	 * account on another kind's address; nothing here is ever closed, so that
	 * address is then taken for good and the other account can never be
	 * created. An address vector alone would not catch this, because
	 * regenerating it makes it agree with whatever the code does.
	 */
	it('puts the prefix and the kind tag ahead of the root', () => {
		const seeds = deriveSeeds('EncryptedUserSecretKeyShare', {
			dwallet_root: dwalletSeedRoot(CURVE_SECP256K1, DWALLET_PUBLIC_KEY),
			encryption_key_owner: HOLDER,
		});
		expect(hex(seeds[0])).toBe(hex(text('dwallet')));
		expect(hex(seeds[1])).toBe(hex(text('encrypted_user_share')));
		// 2 bytes of curve plus a 33-byte key is 35, so the root is two seeds.
		expect(seeds[2].length).toBe(32);
		expect(seeds[3].length).toBe(3);
		expect(hex(seeds[4])).toBe(hex(HOLDER));
		expect(seeds.length).toBe(5);
	});

	it('gives the dWallet record and its encrypted share different tags', () => {
		const root = dwalletSeedRoot(CURVE_SECP256K1, DWALLET_PUBLIC_KEY);
		const record = deriveSeeds('DWallet', { dwallet_root: root });
		const share = deriveSeeds('EncryptedUserSecretKeyShare', {
			dwallet_root: root,
			encryption_key_owner: HOLDER,
		});
		expect(hex(record[1])).toBe(hex(text('record')));
		expect(hex(share[1])).toBe(hex(text('encrypted_user_share')));
	});
});

describe('findProgramAddress', () => {
	it('refuses a seed longer than Solana allows', () => {
		expect(() => findProgramAddress([new Uint8Array(33)], PROGRAM_ID)).toThrow(/33 bytes/);
	});

	it('refuses a program id that is not 32 bytes', () => {
		expect(() => findProgramAddress([], new Uint8Array(31))).toThrow(/32 bytes/);
	});
});

describe('approvalMessageDigests', () => {
	it('represents absent metadata as the zero digest, not as a hash', () => {
		const { messageMetadataDigest } = approvalMessageDigests(text('hello'));
		expect(Array.from(messageMetadataDigest)).toEqual(Array.from(new Uint8Array(32)));
	});

	it('hashes the message with keccak256', () => {
		const { messageDigest } = approvalMessageDigests(text('ika grpc solana demo'));
		expect(messageDigest.length).toBe(32);
		expect(hex(messageDigest)).not.toBe(hex(new Uint8Array(32)));
	});
});

describe('the wire tables', () => {
	it('resolves the numbers a demo would otherwise write out', () => {
		expect(instructionByte('DWalletTransferOwnership')).toBe(129);
		expect(instructionByte('DWalletIssueSignatureVoucher')).toBe(156);
		expect(instructionByte('DWalletCommitDWallet')).toBe(132);
		expect(accountDiscriminator('DWallet')).toBe(97);
		expect(accountDiscriminator('SignatureVoucher')).toBe(108);
		expect(accountDiscriminator('DWalletCoordinator')).toBe(96);
	});

	it('throws on a name the program does not have, rather than defaulting', () => {
		expect(() => instructionByte('DWalletTransferOwnerhsip')).toThrow(/no instruction named/);
		expect(() => accountDiscriminator('Dwallet')).toThrow(/no account named/);
	});
});
