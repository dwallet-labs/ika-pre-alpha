// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The user's keys, all derived from one root seed the app keeps, as in
 * `@ika.xyz/sdk`.
 *
 * A wallet signs its chain's transactions and nothing else. So the keys that
 * sign raw bytes come from the seed:
 *
 * - The class-groups keypair, which a dWallet's user share is encrypted to.
 * - The holder key, an Ed25519 key that signs the encryption key's
 *   registration and accepts each share. Its seed and its derivation are
 *   those of `UserShareEncryptionKeys` in `@ika.xyz/sdk`, so a seed used with
 *   the classic SDK gives the same holder and encryption key here, and the
 *   shares of dWallets migrated from the classic contracts still decrypt.
 * - The request key, an Ed25519 key that signs every request to the network
 *   and pays for it through its gas deposit. The classic flow had none: each
 *   request was a transaction the wallet signed. It does not depend on the
 *   curve, so one gas deposit serves the keys of every curve.
 */
import { bcs } from '@mysten/bcs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

import { createClassGroupsKeypair, fromCurveToNumber, fromNumberToCurve } from '../index.js';
import type { Curve, GrpcTransportKeypair } from '../index.js';

/**
 * The serialized keys. `V3` follows the classic SDK's `V1` and `V2`, which
 * hold no request key and a holder key in Sui's string form; this SDK reads
 * only `V3`.
 */
const VersionedUserShareEncryptionKeysBcs = bcs.enum('VersionedUserShareEncryptionKeys', {
	V1: null,
	V2: null,
	V3: bcs.struct('UserShareEncryptionKeysV3', {
		encryptionKey: bcs.vector(bcs.u8()),
		decryptionKey: bcs.vector(bcs.u8()),
		holderSecretKey: bcs.vector(bcs.u8()),
		requestSecretKey: bcs.vector(bcs.u8()),
		curve: bcs.u32(),
	}),
});

/** The keypairs the SDK signs with, kept out of the class's public fields. */
const SIGNING_KEYS = new WeakMap<
	UserShareEncryptionKeys,
	{ holder: GrpcTransportKeypair; request: GrpcTransportKeypair }
>();

/** The holder key of `keys`: it registers the encryption key and accepts shares. */
export function holderKeypair(keys: UserShareEncryptionKeys): GrpcTransportKeypair {
	return SIGNING_KEYS.get(keys)!.holder;
}

/** The request key of `keys`: it signs every request and pays through its gas deposit. */
export function requestKeypair(keys: UserShareEncryptionKeys): GrpcTransportKeypair {
	return SIGNING_KEYS.get(keys)!.request;
}

export class UserShareEncryptionKeys {
	/** The class-groups key a share is encrypted to. */
	readonly encryptionKey: Uint8Array;
	/** Decrypts the user's shares. Never send it anywhere, or store it unencrypted. */
	readonly decryptionKey: Uint8Array;
	/** The curve these keys are for. */
	readonly curve: Curve;

	/** The domain strings of the derivation, those of `@ika.xyz/sdk` and one for the request key. */
	static domainSeparators = {
		classGroups: 'CLASS_GROUPS_DECRYPTION_KEY_V1',
		encryptionSignerKey: 'ED25519_SIGNING_KEY_V1',
		requestKey: 'IKA_REQUEST_KEY_V1',
	};

	private constructor(
		encryptionKey: Uint8Array,
		decryptionKey: Uint8Array,
		holderSecretKey: Uint8Array,
		requestSecretKey: Uint8Array,
		curve: Curve,
	) {
		this.encryptionKey = encryptionKey;
		this.decryptionKey = decryptionKey;
		this.curve = curve;
		SIGNING_KEYS.set(this, {
			holder: keypairOf(holderSecretKey),
			request: keypairOf(requestSecretKey),
		});
	}

	/**
	 * Derive the keys of `rootSeedKey` for `curve`. The seed is the app's
	 * secret: whoever has it can decrypt the user's shares and spend the gas
	 * deposit. The class-groups key takes some seconds to derive.
	 */
	static async fromRootSeedKey(
		rootSeedKey: Uint8Array,
		curve: Curve,
	): Promise<UserShareEncryptionKeys> {
		const { encryptionKey, decryptionKey } = await createClassGroupsKeypair(
			UserShareEncryptionKeys.hash(
				UserShareEncryptionKeys.domainSeparators.classGroups,
				rootSeedKey,
				curve,
			),
			curve,
		);
		const holderSecretKey = suiEd25519SecretKey(
			UserShareEncryptionKeys.hash(
				UserShareEncryptionKeys.domainSeparators.encryptionSignerKey,
				rootSeedKey,
				curve,
			),
		);
		const requestSecretKey = keccak_256(
			Uint8Array.from([
				...new TextEncoder().encode(UserShareEncryptionKeys.domainSeparators.requestKey),
				...rootSeedKey,
			]),
		);
		return new UserShareEncryptionKeys(
			encryptionKey,
			decryptionKey,
			holderSecretKey,
			requestSecretKey,
			curve,
		);
	}

	/** Restore keys that `toShareEncryptionKeysBytes` wrote. */
	static fromShareEncryptionKeysBytes(bytes: Uint8Array): UserShareEncryptionKeys {
		const parsed = VersionedUserShareEncryptionKeysBcs.parse(bytes);
		if (parsed.V3 === undefined) {
			throw new Error(
				'these are keys the classic SDK serialized. fromRootSeedKey here derives a different encryption key from the same seed, so do not derive them again: recover these keys with the classic SDK (@ika.xyz/sdk), decrypt your share with them, and re-encrypt it to the key fromRootSeedKey derives here',
			);
		}
		const { encryptionKey, decryptionKey, holderSecretKey, requestSecretKey, curve } = parsed.V3;
		return new UserShareEncryptionKeys(
			Uint8Array.from(encryptionKey),
			Uint8Array.from(decryptionKey),
			Uint8Array.from(holderSecretKey),
			Uint8Array.from(requestSecretKey),
			fromNumberToCurve(curve),
		);
	}

	/** The keys as bytes, for storage. They hold every secret key: store them encrypted. */
	toShareEncryptionKeysBytes(): Uint8Array {
		return VersionedUserShareEncryptionKeysBcs.serialize({
			V3: {
				encryptionKey: this.encryptionKey,
				decryptionKey: this.decryptionKey,
				holderSecretKey: holderKeypair(this).secretKey,
				requestSecretKey: requestKeypair(this).secretKey,
				curve: fromCurveToNumber(this.curve),
			},
		}).toBytes();
	}

	/** The holder key's Ed25519 public key: the one the encryption key is registered under. */
	getSigningPublicKeyBytes(): Uint8Array {
		return Uint8Array.from(holderKeypair(this).publicKey);
	}

	/** The request key's Ed25519 public key: the one its gas deposit and every voucher name. */
	getRequestPublicKeyBytes(): Uint8Array {
		return Uint8Array.from(requestKeypair(this).publicKey);
	}

	/**
	 * `keccak256(ASCII(domain) || curveNumber || rootSeed)`, as
	 * `UserShareEncryptionKeys.hash` of `@ika.xyz/sdk` computes it.
	 */
	static hash(domainSeparator: string, rootSeed: Uint8Array, curve: Curve): Uint8Array {
		return keccak_256(
			Uint8Array.from([
				...new TextEncoder().encode(domainSeparator),
				fromCurveToNumber(curve),
				...rootSeed,
			]),
		);
	}
}

/** The path `Ed25519Keypair.deriveKeypairFromSeed` of `@mysten/sui` uses by default. */
const SUI_ED25519_PATH = [44, 784, 0, 0, 0];

/**
 * The Ed25519 secret key `Ed25519Keypair.deriveKeypairFromSeed` gives for
 * `seed`: SLIP-10 along `m/44'/784'/0'/0'/0'`, every step hardened.
 */
function suiEd25519SecretKey(seed: Uint8Array): Uint8Array {
	const master = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed);
	return SUI_ED25519_PATH.reduce(
		(parent, index) => {
			const data = new Uint8Array(37);
			data.set(parent.key, 1);
			new DataView(data.buffer).setUint32(33, index + 0x8000_0000);
			const child = hmac(sha512, parent.chainCode, data);
			return { key: child.slice(0, 32), chainCode: child.slice(32) };
		},
		{ key: master.slice(0, 32), chainCode: master.slice(32) },
	).key;
}

function keypairOf(secretKey: Uint8Array): GrpcTransportKeypair {
	return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}
