// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The SDK's mock mode: the user's half of each protocol step, for a mock ika
 * network, with no 2PC-MPC.
 *
 * This module is reached only through the entry `@ika.xyz/sdk-core/mock`. The
 * main entry never imports it, so an app that does not import that entry
 * ships no mock code. A client runs it only when it was created with
 * {@link mockCryptography}, through `withMockCryptography`; every other
 * client refuses mock values.
 *
 * A mock network is one backend that holds an ordinary key for each dWallet
 * and signs with it. It serves the Solana devnet pre-alpha. It is not secure:
 * the backend holds every dWallet's whole key and can sign anything with it.
 *
 * No private key is ever sent to the backend. It makes every dWallet's key
 * itself, an imported dWallet's too: in mock mode the SDK does not read the
 * key a user imports, so an imported dWallet of the mock network holds a new
 * key of the backend's, not the imported one.
 *
 * Each step accepts mock values only (`./mock-format.ts`): a value of the
 * real protocol given to a client in mock mode is refused.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { p256 } from '@noble/curves/nist.js';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { randomBytes } from '@noble/hashes/utils.js';

import { fromCurveToNumber } from './hash-signature-validation.js';
import { isMockValue, MOCK_MAGIC, MockKind, mockValue } from './mock-format.js';
import type { UserCryptography } from './user-cryptography.js';

/**
 * A user share's length on each curve, the length of a public share
 * (`PUBLIC_SHARE_LENGTHS`). A mock share is random bytes of that length: the
 * backend signs with the dWallet's key, so the share is never used.
 */
const SHARE_LENGTHS = [35, 35, 34, 34];

/**
 * The payload of `bytes`, which must be a mock value of `kind`. Throws for
 * any other value, a value of the real protocol included.
 */
function payloadOf(bytes: ArrayLike<number>, kind: MockKind, what: string): Uint8Array {
	if (!isMockValue(bytes) || bytes[MOCK_MAGIC.length] !== kind) {
		throw new Error(
			`a client in mock mode was given a ${what} that is not a mock value of its kind`,
		);
	}
	return Uint8Array.from(Array.from(bytes).slice(MOCK_MAGIC.length + 1));
}

/** The network key output a mock network serves. */
export function mockNetworkKeyOutput(): Uint8Array {
	return mockValue(MockKind.NetworkKeyOutput);
}

/** The protocol parameters of `curve`, from a mock network key output. */
export function mockProtocolPublicParameters(
	curve: number,
	networkKeyOutput: Uint8Array,
): Uint8Array {
	payloadOf(networkKeyOutput, MockKind.NetworkKeyOutput, 'network key output');
	return mockValue(MockKind.ProtocolPublicParameters, [curve]);
}

function curveOfParameters(protocolPublicParameters: Uint8Array, curve: number): void {
	const payload = payloadOf(
		protocolPublicParameters,
		MockKind.ProtocolPublicParameters,
		'protocol parameters',
	);
	if (payload.length !== 1 || payload[0] !== curve) {
		throw new Error(`the mock protocol parameters are not for curve ${curve}`);
	}
}

/**
 * The user's half of a mock DKG: the curve, and nothing else. The backend
 * makes the dWallet's key, and the key never leaves it. The user's output
 * names only the curve, so the dWallet's public key is known from the
 * network's answer, not before it.
 */
export function mockPrepareDKG(
	protocolPublicParameters: Uint8Array,
	curve: number,
): { userDKGMessage: Uint8Array; userPublicOutput: Uint8Array; userSecretKeyShare: Uint8Array } {
	curveOfParameters(protocolPublicParameters, curve);
	return {
		userDKGMessage: mockValue(MockKind.KeyMessage, [curve]),
		userPublicOutput: mockValue(MockKind.UserOutput, [curve]),
		userSecretKeyShare: randomBytes(SHARE_LENGTHS[curve]!),
	};
}

/**
 * The user's half of a mock import, which is a mock DKG: `secretKey` is not
 * read, and nothing derived from it is sent. The backend makes a new key for
 * the dWallet, so an imported dWallet of the mock network does not hold the
 * imported key, and has another public key and address.
 */
export function mockPrepareImportedKey(
	protocolPublicParameters: Uint8Array,
	curve: number,
	_secretKey: Uint8Array,
): { userMessage: Uint8Array; userPublicOutput: Uint8Array; userSecretKeyShare: Uint8Array } {
	const { userDKGMessage, userPublicOutput, userSecretKeyShare } = mockPrepareDKG(
		protocolPublicParameters,
		curve,
	);
	return { userMessage: userDKGMessage, userPublicOutput, userSecretKeyShare };
}

/** The curve a user's mock DKG output names. */
export function mockUserOutputCurve(output: Uint8Array): number {
	const payload = payloadOf(output, MockKind.UserOutput, "user's DKG output");
	if (payload.length !== 1) throw new Error("the mock user's DKG output is not one curve number");
	return payload[0]!;
}

/** A mock dWallet public output: the curve, then the public key. */
export function mockDWalletOutput(curve: number, publicKey: Uint8Array): Uint8Array {
	return mockValue(MockKind.DWalletOutput, [curve, ...publicKey]);
}

/** The curve and public key of a mock dWallet output. */
export function mockOutputKey(output: Uint8Array): { curve: number; publicKey: Uint8Array } {
	const payload = payloadOf(output, MockKind.DWalletOutput, 'dWallet output');
	if (payload.length < 33) throw new Error('the mock dWallet output is too short');
	return { curve: payload[0]!, publicKey: payload.slice(1) };
}

/** The public key of a mock dWallet output of `curve`. */
export function mockPublicKeyOfOutput(curve: number, output: Uint8Array): Uint8Array {
	const key = mockOutputKey(output);
	if (key.curve !== curve) {
		throw new Error(`the mock dWallet output is on curve ${key.curve}, not ${curve}`);
	}
	return key.publicKey;
}

/** "Encrypt" a share: a mock share is random bytes, carried as they are. */
export function mockEncryptShare(
	protocolPublicParameters: Uint8Array,
	curve: number,
	share: Uint8Array,
) {
	curveOfParameters(protocolPublicParameters, curve);
	return mockValue(MockKind.EncryptedShare, share);
}

/** The share inside a mock encrypted share, checked to be a share of `curve`. */
export function mockDecryptShare(curve: number, encryptedShare: Uint8Array): Uint8Array {
	const share = payloadOf(encryptedShare, MockKind.EncryptedShare, 'encrypted share');
	if (share.length !== SHARE_LENGTHS[curve]) {
		throw new Error(`the mock share is not a share of curve ${curve}`);
	}
	return share;
}

/**
 * The user's sign message: the backend signs with the dWallet's key, so it
 * carries nothing. The presign must be a mock presign.
 */
export function mockSignMessage(
	protocolPublicParameters: Uint8Array,
	curve: number,
	presign: Uint8Array,
): Uint8Array {
	curveOfParameters(protocolPublicParameters, curve);
	payloadOf(presign, MockKind.Presign, 'presign');
	return mockValue(MockKind.SignMessage);
}

/**
 * Verify a signature the mock backend returned, under the key of a mock
 * dWallet output, in the network's encodings:
 *
 * - ECDSA: 65 bytes, the recovery byte then `r` and `s`, with a low `s`, over
 *   the message's hash. The recovery byte must recover the dWallet's key.
 * - Taproot: BIP-340 over the SHA-256 of the message, under the key's x-only
 *   form.
 * - EdDSA: RFC 8032 over the message.
 * - Schnorrkel: only the length is checked. No sr25519 verifier is a
 *   dependency of this package; the backend's own test verifies it.
 */
export function mockVerifySignature(args: {
	curve: number;
	algorithm: 'ECDSASecp256k1' | 'ECDSASecp256r1' | 'Taproot' | 'EdDSA' | 'Schnorrkel';
	hash: 'KECCAK256' | 'SHA256' | 'DoubleSHA256' | 'SHA512' | 'Merlin' | 'Blake2b256';
	blake2b?: { personal: Uint8Array; salt: Uint8Array };
	output: Uint8Array;
	message: Uint8Array;
	signature: Uint8Array;
}): void {
	const publicKey = mockPublicKeyOfOutput(args.curve, args.output);
	const fail = () => {
		throw new Error("the signature does not verify under the dWallet's public key");
	};
	switch (args.algorithm) {
		case 'ECDSASecp256k1':
		case 'ECDSASecp256r1': {
			const curve = args.algorithm === 'ECDSASecp256k1' ? secp256k1 : p256;
			const digest = messageDigest(args.hash, args.message, args.blake2b);
			if (args.signature.length !== 65) fail();
			const compact = args.signature.slice(1);
			if (!curve.verify(compact, digest, publicKey, { prehash: false, format: 'compact' })) fail();
			let recovered: Uint8Array;
			try {
				recovered = curve.recoverPublicKey(args.signature, digest, { prehash: false });
			} catch {
				return fail();
			}
			if (!sameBytes(recovered, publicKey)) {
				throw new Error(
					"the ECDSA signature's recovery byte does not recover the dWallet's public key",
				);
			}
			return;
		}
		case 'Taproot':
			if (args.hash !== 'SHA256') fail();
			if (!schnorr.verify(args.signature, sha256(args.message), taprootKey(publicKey))) fail();
			return;
		case 'EdDSA':
			if (!ed25519.verify(args.signature, args.message, publicKey, { zip215: false })) fail();
			return;
		case 'Schnorrkel':
			if (args.signature.length !== 64) fail();
			return;
	}
}

/** The BIP-340 x-only key of a compressed secp256k1 key. */
function taprootKey(compressed: Uint8Array): Uint8Array {
	return compressed.slice(1);
}

function messageDigest(
	hash: string,
	message: Uint8Array,
	blake2bContext: { personal: Uint8Array; salt: Uint8Array } | undefined,
): Uint8Array {
	switch (hash) {
		case 'KECCAK256':
			return keccak_256(message);
		case 'SHA256':
			return sha256(message);
		case 'DoubleSHA256':
			return sha256(sha256(message));
		case 'Blake2b256':
			return blake2b(message, {
				dkLen: 32,
				personalization: padded16(blake2bContext?.personal ?? new Uint8Array(0)),
				salt: padded16(blake2bContext?.salt ?? new Uint8Array(0)),
			});
		default:
			throw new Error(`an ECDSA signature is not made over ${hash}`);
	}
}

/** BLAKE2b's personal and salt, zero-padded to 16 bytes as the `blake2b_simd` crate pads them. */
function padded16(bytes: Uint8Array): Uint8Array {
	if (bytes.length > 16) throw new Error('a BLAKE2b personal or salt is at most 16 bytes');
	const out = new Uint8Array(16);
	out.set(bytes);
	return out;
}

function sameBytes(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
	return (
		left.length === right.length && Array.from(left).every((byte, index) => byte === right[index])
	);
}

type VerifiedAlgorithm = Parameters<typeof mockVerifySignature>[0]['algorithm'];
type VerifiedHash = Parameters<typeof mockVerifySignature>[0]['hash'];

/** The share of a mock encrypted share for a mock dWallet output on `curve`. */
function decryptedMockShare(
	curve: number,
	publicOutput: Uint8Array,
	encryptedShareAndProof: Uint8Array,
	protocolPublicParameters: Uint8Array,
): Uint8Array {
	curveOfParameters(protocolPublicParameters, curve);
	mockPublicKeyOfOutput(curve, publicOutput);
	return mockDecryptShare(curve, encryptedShareAndProof);
}

/**
 * A mock ika network's cryptography, for one client. Pass it to a client
 * with `withMockCryptography`. Not secure: see this module's comment.
 */
export const mockCryptography: UserCryptography = Object.freeze<UserCryptography>({
	mock: true,
	networkDkgPublicOutputToProtocolPublicParameters: async (curve, networkDkgOutput) =>
		mockProtocolPublicParameters(fromCurveToNumber(curve), networkDkgOutput),
	reconfigurationPublicOutputToProtocolPublicParameters: async () => {
		throw new Error('a mock network has no reconfiguration output');
	},
	prepareDKGForSessionIdentifier: async (protocolPublicParameters, curve) =>
		mockPrepareDKG(protocolPublicParameters, fromCurveToNumber(curve)),
	prepareImportedKeyVerificationForSessionIdentifier: async (
		protocolPublicParameters,
		curve,
		_sessionIdentifier,
		secretKey,
	) => mockPrepareImportedKey(protocolPublicParameters, fromCurveToNumber(curve), secretKey),
	encryptSecretShare: async (curve, userSecretKeyShare, _encryptionKey, protocolPublicParameters) =>
		mockEncryptShare(protocolPublicParameters, fromCurveToNumber(curve), userSecretKeyShare),
	decryptUserShareOfOutput: async (
		curve,
		_decryptionKey,
		dWalletPublicOutput,
		encryptedShareAndProof,
		protocolPublicParameters,
	) =>
		decryptedMockShare(
			fromCurveToNumber(curve),
			dWalletPublicOutput,
			encryptedShareAndProof,
			protocolPublicParameters,
		),
	decryptUserShare: async (
		curve,
		_decryptionKey,
		publicOutput,
		encryptedShareAndProof,
		protocolPublicParameters,
	) => decryptedMockShare(curve, publicOutput, encryptedShareAndProof, protocolPublicParameters),
	publicKeyFromDWalletOutput: async (curve, dWalletOutput) =>
		mockPublicKeyOfOutput(fromCurveToNumber(curve), dWalletOutput),
	publicKeyFromCentralizedDKGOutput: async (_curve, userPublicOutput) => {
		mockUserOutputCurve(userPublicOutput);
		throw new Error(
			"a mock dWallet's key is made by the mock network, so its public key is known only " +
				"from the network's answer",
		);
	},
	userAndNetworkDKGOutputMatch: async (curve, userPublicOutput, networkDKGOutput) => {
		// The user's output names only the curve: the network made the key.
		if (!isMockValue(userPublicOutput) || !isMockValue(networkDKGOutput)) return false;
		const network = mockOutputKey(networkDKGOutput);
		const curveNumber = fromCurveToNumber(curve);
		return mockUserOutputCurve(userPublicOutput) === curveNumber && network.curve === curveNumber;
	},
	createUserSignMessageWithPublicOutput: async (
		protocolPublicParameters,
		publicOutput,
		_userSecretKeyShare,
		presign,
		_message,
		_hash,
		_signatureAlgorithm,
		curve,
	) => {
		const curveNumber = fromCurveToNumber(curve);
		mockPublicKeyOfOutput(curveNumber, publicOutput);
		return mockSignMessage(protocolPublicParameters, curveNumber, presign);
	},
	createUserSignMessageWithUserPublicOutput: async (
		protocolPublicParameters,
		userPublicOutput,
		_userSecretKeyShare,
		presign,
		_message,
		_hash,
		_signatureAlgorithm,
		curve,
	) => {
		const curveNumber = fromCurveToNumber(curve);
		if (mockUserOutputCurve(userPublicOutput) !== curveNumber) {
			throw new Error("the mock user's DKG output is for another curve");
		}
		return mockSignMessage(protocolPublicParameters, curveNumber, presign);
	},
	createUserSignMessageEcdsaBlake2b256: async (
		protocolPublicParameters,
		publicOutput,
		_share,
		presign,
	) => {
		mockPublicKeyOfOutput(0, publicOutput);
		return mockSignMessage(protocolPublicParameters, 0, presign);
	},
	verifySignature: async (
		curve,
		signatureAlgorithm,
		hash,
		dWalletPublicOutput,
		message,
		signature,
	) => {
		mockVerifySignature({
			curve: fromCurveToNumber(curve),
			algorithm: signatureAlgorithm as VerifiedAlgorithm,
			hash: hash as VerifiedHash,
			output: dWalletPublicOutput,
			message,
			signature,
		});
	},
	verifyEcdsaBlake2b256Signature: async (
		dWalletPublicOutput,
		message,
		signature,
		personal,
		salt,
	) => {
		mockVerifySignature({
			curve: 0,
			algorithm: 'ECDSASecp256k1',
			hash: 'Blake2b256',
			blake2b: { personal, salt },
			output: dWalletPublicOutput,
			message,
			signature,
		});
	},
});
