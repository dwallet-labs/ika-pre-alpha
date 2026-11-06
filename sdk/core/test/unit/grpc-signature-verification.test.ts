// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	createUserSignMessageEcdsaBlake2b256,
	createUserSignMessageWithPublicOutput,
	verifyEcdsaBlake2b256Signature,
	verifySignature,
} from '../../src/client/cryptography';
import { Curve, Hash, SignatureAlgorithm } from '../../src/client/types';
import {
	createUserSignMessageWithScheme,
	requireMessageMetadataOfScheme,
	signatureFromResponseVerified,
	verifySignatureWithScheme,
} from '../../src/grpc/signature-verification';
import type { TransactionResponseData } from '../../src/grpc/types';

// The two verifiers and the two makers of the user's sign message are
// replaced by doubles. These tests prove what `verifySignatureWithScheme` and
// `createUserSignMessageWithScheme` pass to them. That the verifiers accept
// and refuse correctly is proved by the Rust tests of the verifier. That the
// user's sign message hashes as the network does is proved by the Rust test
// `the_user_and_the_node_hash_with_the_same_metadata` in ika-core.
vi.mock('../../src/client/cryptography', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../src/client/cryptography')>()),
	verifySignature: vi.fn(async () => {}),
	verifyEcdsaBlake2b256Signature: vi.fn(async () => {}),
	createUserSignMessageWithPublicOutput: vi.fn(async () => Uint8Array.from([0x44])),
	createUserSignMessageEcdsaBlake2b256: vi.fn(async () => Uint8Array.from([0x55])),
}));

/** `DWalletCurve` numbers. */
const SECP256K1 = 0;
const SECP256R1 = 1;
const CURVE25519 = 2;
const RISTRETTO = 3;

/** `DWalletSignatureScheme` numbers. */
const ECDSA_KECCAK256 = 0;
const ECDSA_SHA256 = 1;
const ECDSA_DOUBLE_SHA256 = 2;
const TAPROOT_SHA256 = 3;
const ECDSA_BLAKE2B256 = 4;
const EDDSA_SHA512 = 5;
const SCHNORRKEL_MERLIN = 6;

const message = new Uint8Array(32).fill(0x11);
const dWalletPublicOutput = new Uint8Array(48).fill(0x22);
const signature = new Uint8Array(64).fill(0x33);
const noMetadata = new Uint8Array(0);

/** The BCS bytes of a `SchnorrkelMessageMetadata` with this context. */
function schnorrkelMetadata(context: Uint8Array): Uint8Array {
	return Uint8Array.from([context.length, ...context]);
}

const ascii = (text: string) => new TextEncoder().encode(text);

/** The BCS bytes of a `Blake2bMessageMetadata` with this personal and salt. */
function blake2bMetadata(personal: Uint8Array, salt: Uint8Array): Uint8Array {
	return Uint8Array.from([personal.length, ...personal, salt.length, ...salt]);
}

describe('verifySignatureWithScheme', () => {
	beforeEach(() => {
		vi.mocked(verifySignature).mockClear();
		vi.mocked(verifyEcdsaBlake2b256Signature).mockClear();
	});

	it('passes the Schnorrkel context of the metadata to the verifier, and `substrate` when the metadata names none', async () => {
		await verifySignatureWithScheme({
			curve: RISTRETTO,
			signatureScheme: SCHNORRKEL_MERLIN,
			message,
			messageMetadata: schnorrkelMetadata(ascii('my-chain')),
			dWalletPublicOutput,
			signature,
		});
		expect(verifySignature).toHaveBeenCalledWith(
			Curve.RISTRETTO,
			SignatureAlgorithm.Schnorrkel,
			Hash.Merlin,
			dWalletPublicOutput,
			message,
			signature,
			{ Schnorrkel: { signing_context: Array.from(ascii('my-chain')) } },
		);

		vi.mocked(verifySignature).mockClear();
		await verifySignatureWithScheme({
			curve: RISTRETTO,
			signatureScheme: SCHNORRKEL_MERLIN,
			message,
			messageMetadata: schnorrkelMetadata(new Uint8Array(0)),
			dWalletPublicOutput,
			signature,
		});
		expect(verifySignature).toHaveBeenCalledWith(
			Curve.RISTRETTO,
			SignatureAlgorithm.Schnorrkel,
			Hash.Merlin,
			dWalletPublicOutput,
			message,
			signature,
			{ Schnorrkel: { signing_context: Array.from(ascii('substrate')) } },
		);
	});

	it('maps each scheme and curve to the algorithm and the hash the network signs with', async () => {
		const cases = [
			[
				SECP256K1,
				ECDSA_KECCAK256,
				Curve.SECP256K1,
				SignatureAlgorithm.ECDSASecp256k1,
				Hash.KECCAK256,
			],
			[SECP256K1, ECDSA_SHA256, Curve.SECP256K1, SignatureAlgorithm.ECDSASecp256k1, Hash.SHA256],
			[
				SECP256K1,
				ECDSA_DOUBLE_SHA256,
				Curve.SECP256K1,
				SignatureAlgorithm.ECDSASecp256k1,
				Hash.DoubleSHA256,
			],
			[SECP256K1, TAPROOT_SHA256, Curve.SECP256K1, SignatureAlgorithm.Taproot, Hash.SHA256],
			[SECP256R1, ECDSA_SHA256, Curve.SECP256R1, SignatureAlgorithm.ECDSASecp256r1, Hash.SHA256],
			[CURVE25519, EDDSA_SHA512, Curve.ED25519, SignatureAlgorithm.EdDSA, Hash.SHA512],
		] as const;

		for (const [curve, signatureScheme, verifierCurve, signatureAlgorithm, hash] of cases) {
			vi.mocked(verifySignature).mockClear();
			await verifySignatureWithScheme({
				curve,
				signatureScheme,
				message,
				messageMetadata: noMetadata,
				dWalletPublicOutput,
				signature,
			});
			expect(verifySignature).toHaveBeenCalledWith(
				verifierCurve,
				signatureAlgorithm,
				hash,
				dWalletPublicOutput,
				message,
				signature,
				undefined,
			);
		}
	});

	it('rejects when the verifier rejects', async () => {
		vi.mocked(verifySignature).mockRejectedValueOnce(new Error('the signature does not verify'));
		await expect(
			verifySignatureWithScheme({
				curve: CURVE25519,
				signatureScheme: EDDSA_SHA512,
				message,
				messageMetadata: noMetadata,
				dWalletPublicOutput,
				signature,
			}),
		).rejects.toThrow('the signature does not verify');
	});

	it('verifies an EcdsaBlake2b256 signature with the personal and the salt of the metadata', async () => {
		const personal = ascii('ZcashSigHash').slice();
		const salt = ascii('a-salt');
		await verifySignatureWithScheme({
			curve: SECP256K1,
			signatureScheme: ECDSA_BLAKE2B256,
			message,
			messageMetadata: blake2bMetadata(personal, salt),
			dWalletPublicOutput,
			signature,
		});
		expect(verifyEcdsaBlake2b256Signature).toHaveBeenCalledWith(
			dWalletPublicOutput,
			message,
			signature,
			personal,
			salt,
		);
		expect(verifySignature).not.toHaveBeenCalled();
	});

	it('rejects an EcdsaBlake2b256 signature when its verifier rejects', async () => {
		vi.mocked(verifyEcdsaBlake2b256Signature).mockRejectedValueOnce(
			new Error('the signature does not verify'),
		);
		await expect(
			verifySignatureWithScheme({
				curve: SECP256K1,
				signatureScheme: ECDSA_BLAKE2B256,
				message,
				messageMetadata: blake2bMetadata(ascii('ZcashSigHash'), new Uint8Array(0)),
				dWalletPublicOutput,
				signature,
			}),
		).rejects.toThrow('the signature does not verify');
	});

	it('refuses bytes after the EcdsaBlake2b256 metadata and does not call a verifier', async () => {
		const metadata = blake2bMetadata(ascii('ZcashSigHash'), new Uint8Array(0));
		await expect(
			verifySignatureWithScheme({
				curve: SECP256K1,
				signatureScheme: ECDSA_BLAKE2B256,
				message,
				messageMetadata: Uint8Array.from([...metadata, 0]),
				dWalletPublicOutput,
				signature,
			}),
		).rejects.toThrow('bytes remain after the salt');
		expect(verifyEcdsaBlake2b256Signature).not.toHaveBeenCalled();
		expect(verifySignature).not.toHaveBeenCalled();
	});

	it('refuses EcdsaBlake2b256 on a curve other than secp256k1', async () => {
		await expect(
			verifySignatureWithScheme({
				curve: SECP256R1,
				signatureScheme: ECDSA_BLAKE2B256,
				message,
				messageMetadata: blake2bMetadata(ascii('ZcashSigHash'), new Uint8Array(0)),
				dWalletPublicOutput,
				signature,
			}),
		).rejects.toThrow('does not sign on curve');
		expect(verifyEcdsaBlake2b256Signature).not.toHaveBeenCalled();
	});

	it('refuses a scheme that does not sign on the curve', async () => {
		await expect(
			verifySignatureWithScheme({
				curve: SECP256R1,
				signatureScheme: ECDSA_KECCAK256,
				message,
				messageMetadata: noMetadata,
				dWalletPublicOutput,
				signature,
			}),
		).rejects.toThrow('does not sign on curve');
		await expect(
			verifySignatureWithScheme({
				curve: SECP256K1,
				signatureScheme: SCHNORRKEL_MERLIN,
				message,
				messageMetadata: schnorrkelMetadata(new Uint8Array(0)),
				dWalletPublicOutput,
				signature,
			}),
		).rejects.toThrow('does not sign on curve');
		expect(verifySignature).not.toHaveBeenCalled();
	});

	it('refuses metadata on a scheme that takes none', async () => {
		await expect(
			verifySignatureWithScheme({
				curve: CURVE25519,
				signatureScheme: EDDSA_SHA512,
				message,
				messageMetadata: Uint8Array.from([1]),
				dWalletPublicOutput,
				signature,
			}),
		).rejects.toThrow('message_metadata must be empty');
		expect(verifySignature).not.toHaveBeenCalled();
	});

	it('refuses Schnorrkel metadata with bytes after the context', async () => {
		await expect(
			verifySignatureWithScheme({
				curve: RISTRETTO,
				signatureScheme: SCHNORRKEL_MERLIN,
				message,
				messageMetadata: Uint8Array.from([0, 7]),
				dWalletPublicOutput,
				signature,
			}),
		).rejects.toThrow('bytes remain after the context');
		expect(verifySignature).not.toHaveBeenCalled();
	});
});

describe('createUserSignMessageWithScheme', () => {
	beforeEach(() => {
		vi.mocked(createUserSignMessageWithPublicOutput).mockClear();
		vi.mocked(createUserSignMessageEcdsaBlake2b256).mockClear();
	});

	const protocolPublicParameters = new Uint8Array(16).fill(0x66);
	const userSecretKeyShare = new Uint8Array(32).fill(0x77);
	const presign = new Uint8Array(24).fill(0x88);
	const inputs = {
		protocolPublicParameters,
		message,
		dWalletPublicOutput,
		userSecretKeyShare,
		presign,
	};

	it('makes an EcdsaBlake2b256 sign message with the personal and the salt of the metadata', async () => {
		const personal = ascii('ZcashSigHash');
		const salt = ascii('a-salt');
		await expect(
			createUserSignMessageWithScheme({
				...inputs,
				curve: SECP256K1,
				signatureScheme: ECDSA_BLAKE2B256,
				messageMetadata: blake2bMetadata(personal, salt),
			}),
		).resolves.toEqual(Uint8Array.from([0x55]));
		expect(createUserSignMessageEcdsaBlake2b256).toHaveBeenCalledWith(
			protocolPublicParameters,
			dWalletPublicOutput,
			userSecretKeyShare,
			presign,
			message,
			personal,
			salt,
		);
		expect(createUserSignMessageWithPublicOutput).not.toHaveBeenCalled();
	});

	it('makes a Schnorrkel sign message with the context of the metadata, and `substrate` when the metadata names none', async () => {
		for (const [context, signingContext] of [
			[ascii('my-chain'), ascii('my-chain')],
			[new Uint8Array(0), ascii('substrate')],
		] as const) {
			vi.mocked(createUserSignMessageWithPublicOutput).mockClear();
			await createUserSignMessageWithScheme({
				...inputs,
				curve: RISTRETTO,
				signatureScheme: SCHNORRKEL_MERLIN,
				messageMetadata: schnorrkelMetadata(context),
			});
			expect(createUserSignMessageWithPublicOutput).toHaveBeenCalledWith(
				protocolPublicParameters,
				dWalletPublicOutput,
				userSecretKeyShare,
				presign,
				message,
				Hash.Merlin,
				SignatureAlgorithm.Schnorrkel,
				Curve.RISTRETTO,
				{ Schnorrkel: { signing_context: Array.from(signingContext) } },
			);
		}
	});

	it('makes the sign message of a scheme that takes no metadata with no hash context', async () => {
		await createUserSignMessageWithScheme({
			...inputs,
			curve: SECP256R1,
			signatureScheme: ECDSA_SHA256,
			messageMetadata: noMetadata,
		});
		expect(createUserSignMessageWithPublicOutput).toHaveBeenCalledWith(
			protocolPublicParameters,
			dWalletPublicOutput,
			userSecretKeyShare,
			presign,
			message,
			Hash.SHA256,
			SignatureAlgorithm.ECDSASecp256r1,
			Curve.SECP256R1,
			undefined,
		);
	});

	it('refuses metadata the network would refuse, and makes no sign message', async () => {
		const refusals = [
			[SECP256K1, ECDSA_BLAKE2B256, noMetadata, /./],
			[
				SECP256K1,
				ECDSA_BLAKE2B256,
				Uint8Array.from([...blake2bMetadata(ascii('ZcashSigHash'), noMetadata), 0]),
				/bytes remain after the salt/,
			],
			[RISTRETTO, SCHNORRKEL_MERLIN, Uint8Array.from([0, 7]), /bytes remain after the context/],
			[CURVE25519, EDDSA_SHA512, Uint8Array.from([1]), /message_metadata must be empty/],
			[
				SECP256R1,
				ECDSA_BLAKE2B256,
				blake2bMetadata(ascii('ZcashSigHash'), noMetadata),
				/does not sign on curve/,
			],
		] as const;
		for (const [curve, signatureScheme, messageMetadata, refusal] of refusals) {
			await expect(
				createUserSignMessageWithScheme({ ...inputs, curve, signatureScheme, messageMetadata }),
			).rejects.toThrow(refusal);
		}
		expect(createUserSignMessageWithPublicOutput).not.toHaveBeenCalled();
		expect(createUserSignMessageEcdsaBlake2b256).not.toHaveBeenCalled();
	});
});

describe('signatureFromResponseVerified', () => {
	beforeEach(() => {
		vi.mocked(verifySignature).mockClear();
	});

	const expected = {
		curve: CURVE25519,
		signatureScheme: EDDSA_SHA512,
		message,
		messageMetadata: noMetadata,
		dWalletPublicOutput,
	};
	const signatureAnswer: TransactionResponseData = {
		$kind: 'Signature',
		Signature: { signature: Array.from(signature) },
	};

	it('returns the signature of an answer the verifier accepts', async () => {
		await expect(signatureFromResponseVerified(signatureAnswer, expected)).resolves.toEqual(
			signature,
		);
		expect(verifySignature).toHaveBeenCalledWith(
			Curve.ED25519,
			SignatureAlgorithm.EdDSA,
			Hash.SHA512,
			dWalletPublicOutput,
			message,
			signature,
			undefined,
		);
	});

	it('refuses an answer whose signature the verifier refuses', async () => {
		vi.mocked(verifySignature).mockRejectedValueOnce(new Error('the signature does not verify'));
		await expect(signatureFromResponseVerified(signatureAnswer, expected)).rejects.toThrow(
			'the signature does not verify',
		);
	});

	it("refuses an `Error` answer with the network's message", async () => {
		const answer: TransactionResponseData = {
			$kind: 'Error',
			Error: { message: 'the voucher is revoked' },
		};
		await expect(signatureFromResponseVerified(answer, expected)).rejects.toThrow(
			'the network refused the sign: the voucher is revoked',
		);
		expect(verifySignature).not.toHaveBeenCalled();
	});

	it('refuses an `Attestation` answer', async () => {
		const answer: TransactionResponseData = {
			$kind: 'Attestation',
			Attestation: {
				attestation_data: [1],
				network_signature: [2],
				network_pubkey: [3],
				signer_noa_public_key: Array.from(new Uint8Array(32).fill(3)),
			},
		};
		await expect(signatureFromResponseVerified(answer, expected)).rejects.toThrow(
			'a sign request answered with an attestation',
		);
		expect(verifySignature).not.toHaveBeenCalled();
	});
});

describe('the metadata a scheme takes', () => {
	const blake2bMetadata = Uint8Array.from(
		readFileSync(
			new URL('./fixtures/acceptance/ecdsa_blake2b256_message_metadata.bin', import.meta.url),
		),
	);
	/** `SchnorrkelMessageMetadata` with the context `ika`: a one-byte length, then the bytes. */
	const schnorrkelMetadata = Uint8Array.from([3, 0x69, 0x6b, 0x61]);

	it('takes Blake2b metadata for EcdsaBlake2b256, Schnorrkel metadata for SchnorrkelMerlin, and none for the rest', () => {
		expect(() => requireMessageMetadataOfScheme('EcdsaBlake2b256', blake2bMetadata)).not.toThrow();
		expect(() =>
			requireMessageMetadataOfScheme('SchnorrkelMerlin', schnorrkelMetadata),
		).not.toThrow();
		expect(() => requireMessageMetadataOfScheme('EddsaSha512', new Uint8Array())).not.toThrow();
	});

	it('refuses metadata that does not decode for its scheme, empty metadata included', () => {
		expect(() => requireMessageMetadataOfScheme('EcdsaBlake2b256', new Uint8Array())).toThrow(
			/invalid Blake2b message_metadata/,
		);
		expect(() =>
			requireMessageMetadataOfScheme('EcdsaBlake2b256', Uint8Array.from([...blake2bMetadata, 0])),
		).toThrow(/invalid Blake2b message_metadata/);
		expect(() => requireMessageMetadataOfScheme('SchnorrkelMerlin', new Uint8Array())).toThrow(
			/invalid Schnorrkel message_metadata/,
		);
		expect(() =>
			requireMessageMetadataOfScheme(
				'SchnorrkelMerlin',
				Uint8Array.from([...schnorrkelMetadata, 0]),
			),
		).toThrow(/invalid Schnorrkel message_metadata/);
	});

	it('refuses metadata for a scheme that takes none', () => {
		expect(() => requireMessageMetadataOfScheme('EcdsaKeccak256', Uint8Array.from([1]))).toThrow(
			'message_metadata must be empty for the scheme EcdsaKeccak256',
		);
	});
});
