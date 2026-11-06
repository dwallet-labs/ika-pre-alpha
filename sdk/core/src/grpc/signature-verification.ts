// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * Signing and verifying a signature of the new flow.
 *
 * A sign request of the new flow names one `DWalletSignatureScheme`, and
 * carries the hash's context in `message_metadata`. The verifier,
 * `verifySignature`, takes a signature algorithm, a hash and a hash context.
 * `verifySignatureWithScheme` maps the one to the other the way the network
 * does when it takes the request (`to_internal_for_curve` and
 * `hash_context_from_metadata` in the node), and then verifies. The scheme
 * `EcdsaBlake2b256` goes to `verifyEcdsaBlake2b256Signature`, because
 * `verifySignature` cannot name its hash.
 *
 * `createUserSignMessageWithScheme` makes the user's sign message with the
 * same mapping, so the user hashes the message as the network does.
 */
import { bcs } from '@mysten/bcs';

import type { SignatureHashContext } from '../client/cryptography.js';
import type {
	ValidHashForSignature,
	ValidSignatureAlgorithmForCurve,
} from '../client/hash-signature-validation.js';
import { Curve, Hash, SignatureAlgorithm } from '../client/types.js';
import { realCryptography } from '../client/user-cryptography.js';
import type { UserCryptography } from '../client/user-cryptography.js';
import type { TransactionResponseData } from './types.js';

/** `DWalletCurve`, by its number in a request and in an attestation. */
const SECP256K1 = 0;
const SECP256R1 = 1;
const CURVE25519 = 2;
const RISTRETTO = 3;

/** `DWalletSignatureScheme`, by its number in a request and in a voucher. */
const ECDSA_KECCAK256 = 0;
const ECDSA_SHA256 = 1;
const ECDSA_DOUBLE_SHA256 = 2;
const TAPROOT_SHA256 = 3;
const ECDSA_BLAKE2B256 = 4;
const EDDSA_SHA512 = 5;
const SCHNORRKEL_MERLIN = 6;

/** The Schnorrkel signing context the network uses when the metadata names none. */
const DEFAULT_SCHNORRKEL_CONTEXT = Array.from(new TextEncoder().encode('substrate'));

/** `SchnorrkelMessageMetadata`: the `message_metadata` of a `SchnorrkelMerlin` sign. */
const SchnorrkelMessageMetadataBcs = bcs.struct('SchnorrkelMessageMetadata', {
	context: bcs.vector(bcs.u8()),
});

/** `Blake2bMessageMetadata`: the `message_metadata` of an `EcdsaBlake2b256` sign. */
const Blake2bMessageMetadataBcs = bcs.struct('Blake2bMessageMetadata', {
	personal: bcs.vector(bcs.u8()),
	salt: bcs.vector(bcs.u8()),
});

/** What `verifySignatureWithScheme` takes. */
export interface SignatureWithScheme {
	/** The dWallet's curve, as `DWalletCurve` numbers it. */
	curve: number;
	/** The scheme the sign request named, as `DWalletSignatureScheme` numbers it. */
	signatureScheme: number;
	/** The message the sign request named. */
	message: Uint8Array;
	/** The sign request's `message_metadata`; empty for a scheme that takes none. */
	messageMetadata: Uint8Array;
	/** The dWallet's DKG public output, already checked by the caller. */
	dWalletPublicOutput: Uint8Array;
	/** The signature as the network returned it. */
	signature: Uint8Array;
	/**
	 * The client's cryptography. Absent means the 2PC-MPC protocol, which
	 * refuses a mock dWallet's output.
	 */
	cryptography?: UserCryptography;
}

/**
 * Verify a signature of the new flow under the public key inside the dWallet's
 * DKG output. It throws when the signature does not verify.
 *
 * The check proves only that the signature was made by the key in
 * `dWalletPublicOutput`. Pass an output you already checked. A signature
 * always verifies under the key of an output its sender chose.
 *
 * The scheme and the metadata are read as the network reads them:
 * - A Schnorrkel signature takes its signing context from the metadata, and
 *   `substrate` when the metadata names none.
 * - An `EcdsaBlake2b256` signature takes the BLAKE2b personal and salt from
 *   the metadata. Bytes after them are refused.
 * - Every other scheme takes no metadata, and metadata that is not empty is
 *   refused.
 * - A scheme that does not sign on the curve is refused.
 *
 * A signature made with a Fast Schnorr (VSS) algorithm is not covered. The
 * function maps each scheme to its base algorithm (`Taproot`, `EdDSA`,
 * `Schnorrkel`), because the verifier's numbering has no numbers for the VSS
 * algorithms. The network signs no user request with them today.
 */
export async function verifySignatureWithScheme({
	curve,
	signatureScheme,
	message,
	messageMetadata,
	dWalletPublicOutput,
	signature,
	cryptography = realCryptography,
}: SignatureWithScheme): Promise<void> {
	const verify = <
		C extends Curve,
		S extends ValidSignatureAlgorithmForCurve<C>,
		H extends ValidHashForSignature<S>,
	>(
		verifierCurve: C,
		signatureAlgorithm: S,
		hash: H,
		hashContext?: SignatureHashContext,
	) =>
		cryptography.verifySignature(
			verifierCurve,
			signatureAlgorithm,
			hash,
			dWalletPublicOutput,
			message,
			signature,
			hashContext,
		);

	const signsOn = (scheme: number, schemeCurve: number) =>
		signatureScheme === scheme && curve === schemeCurve;

	if (signsOn(ECDSA_BLAKE2B256, SECP256K1)) {
		const metadata = parseBlake2bMessageMetadata(messageMetadata);
		await cryptography.verifyEcdsaBlake2b256Signature(
			dWalletPublicOutput,
			message,
			signature,
			Uint8Array.from(metadata.personal),
			Uint8Array.from(metadata.salt),
		);
		return;
	}

	if (signsOn(SCHNORRKEL_MERLIN, RISTRETTO)) {
		const metadata = parseSchnorrkelMessageMetadata(messageMetadata);
		const signingContext =
			metadata.context.length === 0 ? DEFAULT_SCHNORRKEL_CONTEXT : metadata.context;
		await verify(Curve.RISTRETTO, SignatureAlgorithm.Schnorrkel, Hash.Merlin, {
			Schnorrkel: { signing_context: signingContext },
		});
		return;
	}

	const takesMetadata =
		signatureScheme === SCHNORRKEL_MERLIN || signatureScheme === ECDSA_BLAKE2B256;
	if (!takesMetadata && messageMetadata.length !== 0) {
		throw new Error('message_metadata must be empty for this signature scheme');
	}

	if (signsOn(ECDSA_KECCAK256, SECP256K1)) {
		await verify(Curve.SECP256K1, SignatureAlgorithm.ECDSASecp256k1, Hash.KECCAK256);
	} else if (signsOn(ECDSA_SHA256, SECP256K1)) {
		await verify(Curve.SECP256K1, SignatureAlgorithm.ECDSASecp256k1, Hash.SHA256);
	} else if (signsOn(ECDSA_DOUBLE_SHA256, SECP256K1)) {
		await verify(Curve.SECP256K1, SignatureAlgorithm.ECDSASecp256k1, Hash.DoubleSHA256);
	} else if (signsOn(TAPROOT_SHA256, SECP256K1)) {
		await verify(Curve.SECP256K1, SignatureAlgorithm.Taproot, Hash.SHA256);
	} else if (signsOn(ECDSA_SHA256, SECP256R1)) {
		await verify(Curve.SECP256R1, SignatureAlgorithm.ECDSASecp256r1, Hash.SHA256);
	} else if (signsOn(EDDSA_SHA512, CURVE25519)) {
		await verify(Curve.ED25519, SignatureAlgorithm.EdDSA, Hash.SHA512);
	} else {
		throw new Error(`Signature scheme ${signatureScheme} does not sign on curve ${curve}`);
	}
}

/** What `createUserSignMessageWithScheme` takes. */
export interface UserSignMessageWithScheme {
	/** The protocol public parameters of the network key. */
	protocolPublicParameters: Uint8Array;
	/** The dWallet's curve, as `DWalletCurve` numbers it. */
	curve: number;
	/** The scheme the sign request names, as `DWalletSignatureScheme` numbers it. */
	signatureScheme: number;
	/** The message the sign request names. */
	message: Uint8Array;
	/** The sign request's `message_metadata`; empty for a scheme that takes none. */
	messageMetadata: Uint8Array;
	/** The dWallet's DKG public output, already checked by the caller. */
	dWalletPublicOutput: Uint8Array;
	/** The user's secret key share. */
	userSecretKeyShare: Uint8Array;
	/** The presign's material. */
	presign: Uint8Array;
	/** The client's cryptography. Absent means the 2PC-MPC protocol. */
	cryptography?: UserCryptography;
}

/**
 * Make the user's sign message for a sign request of the new flow: the
 * user's half of the signature, which the request carries as
 * `message_centralized_signature`.
 *
 * The network hashes the message with the context it reads from the
 * request's metadata (`hash_context_from_metadata` in the node), and refuses
 * a sign message made over another hash. So the scheme and the metadata are
 * read here as `verifySignatureWithScheme` reads them:
 * - An `EcdsaBlake2b256` sign hashes with BLAKE2b-256, under the personal
 *   and the salt of the metadata.
 * - A Schnorrkel sign takes its signing context from the metadata, and
 *   `substrate` when the metadata names none.
 * - Every other scheme takes no metadata, and metadata that is not empty is
 *   refused.
 * - A scheme that does not sign on the curve is refused.
 *
 * Metadata that does not decode, or that has bytes after its last field, is
 * refused, as the network refuses it.
 */
export async function createUserSignMessageWithScheme(
	args: UserSignMessageWithScheme,
): Promise<Uint8Array> {
	return userSignMessageWithScheme(args, 'dwallet');
}

/** What `createUserSignMessageForSignDuringDkg` takes. */
export type UserSignMessageForSignDuringDkg = Omit<
	UserSignMessageWithScheme,
	'dWalletPublicOutput'
> & {
	/** The user's own DKG public output, computed for the DKG request that carries the sign. */
	userPublicOutput: Uint8Array;
};

/**
 * Make the user's sign message for a sign during DKG: the user's half of a
 * signature with the dWallet the same request creates. No network output
 * exists yet, so it is computed from the user's own DKG public output. The
 * scheme and the metadata are read as {@link createUserSignMessageWithScheme}
 * reads them.
 *
 * `EcdsaBlake2b256` is refused: the centralized party computes a BLAKE2b-256
 * sign only from the network's output.
 */
export async function createUserSignMessageForSignDuringDkg(
	args: UserSignMessageForSignDuringDkg,
): Promise<Uint8Array> {
	return userSignMessageWithScheme({ ...args, dWalletPublicOutput: args.userPublicOutput }, 'user');
}

async function userSignMessageWithScheme(
	{
		protocolPublicParameters,
		curve,
		signatureScheme,
		message,
		messageMetadata,
		dWalletPublicOutput,
		userSecretKeyShare,
		presign,
		cryptography = realCryptography,
	}: UserSignMessageWithScheme,
	output: 'dwallet' | 'user',
): Promise<Uint8Array> {
	const sign = <
		C extends Curve,
		S extends ValidSignatureAlgorithmForCurve<C>,
		H extends ValidHashForSignature<S>,
	>(
		signerCurve: C,
		signatureAlgorithm: S,
		hash: H,
		hashContext?: SignatureHashContext,
	) =>
		(output === 'dwallet'
			? cryptography.createUserSignMessageWithPublicOutput
			: cryptography.createUserSignMessageWithUserPublicOutput)(
			protocolPublicParameters,
			dWalletPublicOutput,
			userSecretKeyShare,
			presign,
			message,
			hash,
			signatureAlgorithm,
			signerCurve,
			hashContext,
		);

	const signsOn = (scheme: number, schemeCurve: number) =>
		signatureScheme === scheme && curve === schemeCurve;

	if (signsOn(ECDSA_BLAKE2B256, SECP256K1)) {
		const metadata = parseBlake2bMessageMetadata(messageMetadata);
		if (output === 'user') {
			throw new Error(
				'a sign during DKG cannot use EcdsaBlake2b256: the BLAKE2b-256 sign is computed from the network output only',
			);
		}
		return cryptography.createUserSignMessageEcdsaBlake2b256(
			protocolPublicParameters,
			dWalletPublicOutput,
			userSecretKeyShare,
			presign,
			message,
			Uint8Array.from(metadata.personal),
			Uint8Array.from(metadata.salt),
		);
	}

	if (signsOn(SCHNORRKEL_MERLIN, RISTRETTO)) {
		const metadata = parseSchnorrkelMessageMetadata(messageMetadata);
		const signingContext =
			metadata.context.length === 0 ? DEFAULT_SCHNORRKEL_CONTEXT : metadata.context;
		return sign(Curve.RISTRETTO, SignatureAlgorithm.Schnorrkel, Hash.Merlin, {
			Schnorrkel: { signing_context: signingContext },
		});
	}

	const takesMetadata =
		signatureScheme === SCHNORRKEL_MERLIN || signatureScheme === ECDSA_BLAKE2B256;
	if (!takesMetadata && messageMetadata.length !== 0) {
		throw new Error('message_metadata must be empty for this signature scheme');
	}

	if (signsOn(ECDSA_KECCAK256, SECP256K1)) {
		return sign(Curve.SECP256K1, SignatureAlgorithm.ECDSASecp256k1, Hash.KECCAK256);
	}
	if (signsOn(ECDSA_SHA256, SECP256K1)) {
		return sign(Curve.SECP256K1, SignatureAlgorithm.ECDSASecp256k1, Hash.SHA256);
	}
	if (signsOn(ECDSA_DOUBLE_SHA256, SECP256K1)) {
		return sign(Curve.SECP256K1, SignatureAlgorithm.ECDSASecp256k1, Hash.DoubleSHA256);
	}
	if (signsOn(TAPROOT_SHA256, SECP256K1)) {
		return sign(Curve.SECP256K1, SignatureAlgorithm.Taproot, Hash.SHA256);
	}
	if (signsOn(ECDSA_SHA256, SECP256R1)) {
		return sign(Curve.SECP256R1, SignatureAlgorithm.ECDSASecp256r1, Hash.SHA256);
	}
	if (signsOn(EDDSA_SHA512, CURVE25519)) {
		return sign(Curve.ED25519, SignatureAlgorithm.EdDSA, Hash.SHA512);
	}
	throw new Error(`Signature scheme ${signatureScheme} does not sign on curve ${curve}`);
}

/** What `signatureFromResponseVerified` verifies the answer's signature against. */
export type ExpectedSignature = Omit<SignatureWithScheme, 'signature'>;

/**
 * Take the signature from the answer to a sign request, and return it only
 * after it verifies.
 *
 * One validator answers a sign request, and nothing in the answer proves the
 * signature. So the signature is verified here, with
 * `verifySignatureWithScheme`, under the public key inside
 * `expected.dWalletPublicOutput`, for the message, the metadata and the
 * scheme the request named. Pass an output you already checked: the one the
 * ownership check returned (`DWalletUsable.publicOutput`), or the one the
 * acceptance of the new dWallet compared with your own. A signature always
 * verifies under the key of an output its sender chose.
 *
 * It throws, and returns no signature:
 * - for an `Error` answer, with the network's message;
 * - for an `Attestation` answer, which no sign request is answered with;
 * - when the signature does not verify, with the verifier's error.
 */
export async function signatureFromResponseVerified(
	response: TransactionResponseData,
	expected: ExpectedSignature,
): Promise<Uint8Array> {
	if (response.$kind === 'Error') {
		throw new Error(`the network refused the sign: ${response.Error.message}`);
	}
	if (response.$kind !== 'Signature') {
		throw new Error('a sign request answered with an attestation');
	}
	const signature = Uint8Array.from(response.Signature.signature);
	await verifySignatureWithScheme({ ...expected, signature });
	return signature;
}

/**
 * Refuse `messageMetadata` that the network would refuse for the scheme
 * `signatureScheme` names (a `DWalletSignatureScheme` variant name, such as
 * `EcdsaBlake2b256`). The network decodes a sign's metadata by its scheme
 * (`hash_context_from_metadata` in the node) and refuses the request, with a
 * charge, when it does not decode:
 * - an `EcdsaBlake2b256` sign's metadata must be exactly one
 *   `Blake2bMessageMetadata`;
 * - a `SchnorrkelMerlin` sign's metadata must be exactly one
 *   `SchnorrkelMessageMetadata`;
 * - every other scheme takes empty metadata.
 * Throws an `Error` naming the scheme's metadata otherwise.
 */
export function requireMessageMetadataOfScheme(
	signatureScheme: string,
	messageMetadata: Uint8Array,
): void {
	const decodes = (name: string, parse: (metadata: Uint8Array) => unknown) => {
		try {
			parse(messageMetadata);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(
				reason.startsWith('invalid ') ? reason : `invalid ${name} message_metadata: ${reason}`,
				{ cause: error },
			);
		}
	};
	if (signatureScheme === 'EcdsaBlake2b256') {
		decodes('Blake2b', parseBlake2bMessageMetadata);
	} else if (signatureScheme === 'SchnorrkelMerlin') {
		decodes('Schnorrkel', parseSchnorrkelMessageMetadata);
	} else if (messageMetadata.length !== 0) {
		throw new Error(`message_metadata must be empty for the scheme ${signatureScheme}`);
	}
}

/** Decodes an `EcdsaBlake2b256` sign's metadata, and refuses bytes after it, as the network does. */
function parseBlake2bMessageMetadata(messageMetadata: Uint8Array): {
	personal: number[];
	salt: number[];
} {
	const metadata = Blake2bMessageMetadataBcs.parse(messageMetadata);
	if (Blake2bMessageMetadataBcs.serialize(metadata).toBytes().length !== messageMetadata.length) {
		throw new Error('invalid Blake2b message_metadata: bytes remain after the salt');
	}
	return metadata;
}

/** Decodes a Schnorrkel sign's metadata, and refuses bytes after it, as the network does. */
function parseSchnorrkelMessageMetadata(messageMetadata: Uint8Array): { context: number[] } {
	const metadata = SchnorrkelMessageMetadataBcs.parse(messageMetadata);
	if (
		SchnorrkelMessageMetadataBcs.serialize(metadata).toBytes().length !== messageMetadata.length
	) {
		throw new Error('invalid Schnorrkel message_metadata: bytes remain after the context');
	}
	return metadata;
}
