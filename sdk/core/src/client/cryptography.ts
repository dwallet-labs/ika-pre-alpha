// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

import { bcs } from '@mysten/bcs';

import {
	fromCurveAndSignatureAlgorithmAndHashToNumbers,
	fromCurveToNumber,
} from './hash-signature-validation.js';
import type {
	ValidHashForSignature,
	ValidSignatureAlgorithmForCurve,
} from './hash-signature-validation.js';
import { refuseMockValues } from './mock-format.js';
import { Curve } from './types.js';
import {
	centralized_and_decentralized_parties_dkg_output_match,
	create_dkg_centralized_output_v2,
	create_imported_dwallet_centralized_step,
	create_sign_centralized_party_message_ecdsa_blake2b256,
	create_sign_centralized_party_message_with_centralized_party_dkg_output,
	create_sign_centralized_party_message as create_sign_user_message,
	decrypt_user_share,
	dwallet_output_at_latest_version,
	encrypt_secret_share,
	generate_secp_cg_keypair_from_seed_v2,
	network_dkg_public_output_to_protocol_pp,
	public_key_from_centralized_dkg_output,
	public_key_from_dwallet_output,
	reconfiguration_public_output_to_protocol_pp,
	verify_ecdsa_blake2b256_signature,
	verify_signature,
	verify_user_share,
} from './wasm-loader.js';

/**
 * Create a class groups keypair from a seed for encryption/decryption operations.
 * Uses SECP256k1, SECP256r1, Ristretto, or ED25519 curves with class groups for homomorphic encryption capabilities.
 *
 * The keypair is derived with the portable sampler, so the same seed and curve give the
 * same key bytes here as native Rust's `generate_cg_keypair_from_seed`, on any platform.
 *
 * @param seed - The seed bytes to generate the keypair from
 * @param curve - The curve to use for key generation
 * @returns Object containing the encryption key (public) and decryption key (private)
 */
export async function createClassGroupsKeypair(
	seed: Uint8Array,
	curve: Curve,
): Promise<{
	encryptionKey: Uint8Array;
	decryptionKey: Uint8Array;
}> {
	if (seed.length !== 32) {
		throw new Error('Seed must be 32 bytes');
	}

	let encryptionKey: Uint8Array;
	let decryptionKey: Uint8Array;

	if (
		curve === Curve.SECP256K1 ||
		curve === Curve.SECP256R1 ||
		curve === Curve.RISTRETTO ||
		curve === Curve.ED25519
	) {
		[encryptionKey, decryptionKey] = await generate_secp_cg_keypair_from_seed_v2(
			fromCurveToNumber(curve),
			seed,
		);
	} else {
		throw new Error(
			'Only SECP256K1, SECP256R1, RISTRETTO, and ED25519 curves are supported for now',
		);
	}

	return {
		encryptionKey: Uint8Array.from(encryptionKey),
		decryptionKey: Uint8Array.from(decryptionKey),
	};
}

/**
 * Encrypt a secret share using the provided encryption key.
 * This creates an encrypted share that can only be decrypted by the corresponding decryption key.
 *
 * @param curve - The curve to use for encryption
 * @param userSecretKeyShare - The secret key share to encrypt
 * @param encryptionKey - The public encryption key to encrypt with
 * @param protocolPublicParameters - The protocol public parameters for encryption
 * @returns The encrypted secret share with proof of correct encryption
 */
export async function encryptSecretShare(
	curve: Curve,
	userSecretKeyShare: Uint8Array,
	encryptionKey: Uint8Array,
	protocolPublicParameters: Uint8Array,
): Promise<Uint8Array> {
	refuseMockValues(protocolPublicParameters);
	const encryptedUserShareAndProof = await encrypt_secret_share(
		fromCurveToNumber(curve),
		userSecretKeyShare,
		encryptionKey,
		protocolPublicParameters,
	);

	return Uint8Array.from(encryptedUserShareAndProof);
}

/**
 * Compute the user's half of a distributed key generation, for a session
 * whose identifier the caller already holds.
 *
 * `prepareDKG` does two further things that a request sent over the
 * dWallet gRPC transport must not do. It derives the session identifier
 * itself, the way a Sui transaction does, from the sender's address and
 * some bytes to hash. A gRPC request's identifier comes from the epoch,
 * the key that signs the request and the request's own preimage instead,
 * through `grpcSessionIdentifier`, and the caller has it before it builds the
 * request. `prepareDKG` also encrypts the secret share to an encryption
 * key, where a gRPC request may send the share in the clear, so that the
 * network can sign without the user taking part.
 *
 * So this returns the three byte arrays and computes nothing else.
 *
 * The session identifier is not decoration. Validators recompute it from
 * the epoch, the request's signer and the preimage in the request, and they
 * refuse a contribution that was bound to a different one.
 *
 * SECURITY WARNING: *the secret key share must be kept private!* Never
 * send it to anyone, and never store it unencrypted.
 */
export async function prepareDKGForSessionIdentifier(
	protocolPublicParameters: Uint8Array,
	curve: Curve,
	sessionIdentifier: Uint8Array,
): Promise<{
	userDKGMessage: Uint8Array;
	userPublicOutput: Uint8Array;
	userSecretKeyShare: Uint8Array;
}> {
	refuseMockValues(protocolPublicParameters);
	const [userDKGMessage, userPublicOutput, userSecretKeyShare] =
		await create_dkg_centralized_output_v2(
			fromCurveToNumber(curve),
			protocolPublicParameters,
			sessionIdentifier,
		);

	return {
		userDKGMessage: Uint8Array.from(userDKGMessage),
		userPublicOutput: Uint8Array.from(userPublicOutput),
		userSecretKeyShare: Uint8Array.from(userSecretKeyShare),
	};
}

/**
 * Compute the user's half of an imported-key verification: the user's share
 * of `secretKey`, the user's public output, and the message the
 * `ImportedKeyVerification` request carries as `centralized_party_message`.
 *
 * `sessionIdentifier` is the session the request opens
 * (`grpcSessionIdentifier`), which the network recomputes and binds the
 * message to. Each request opens a new session, so compute this again for
 * each request.
 *
 * SECURITY WARNING: `secretKey` is the key being imported and
 * `userSecretKeyShare` the user's share of it. Never send either anywhere, or
 * store either unencrypted.
 */
export async function prepareImportedKeyVerificationForSessionIdentifier(
	protocolPublicParameters: Uint8Array,
	curve: Curve,
	sessionIdentifier: Uint8Array,
	secretKey: Uint8Array,
): Promise<{
	userMessage: Uint8Array;
	userPublicOutput: Uint8Array;
	userSecretKeyShare: Uint8Array;
}> {
	refuseMockValues(protocolPublicParameters);
	const [userSecretKeyShare, userPublicOutput, userMessage] =
		await create_imported_dwallet_centralized_step(
			fromCurveToNumber(curve),
			protocolPublicParameters,
			sessionIdentifier,
			secretKey,
		);

	return {
		userMessage: Uint8Array.from(userMessage),
		userPublicOutput: Uint8Array.from(userPublicOutput),
		userSecretKeyShare: Uint8Array.from(userSecretKeyShare),
	};
}

/**
 * Decrypt a user secret share encrypted to your class-groups key, and check
 * that it is a share of `dWalletPublicOutput`. Throws when it is not.
 *
 * `dWalletPublicOutput` must come from a dWallet attestation you checked
 * under a trusted network key, never from the party that sent the share.
 */
export async function decryptUserShareOfOutput(
	curve: Curve,
	decryptionKey: Uint8Array,
	dWalletPublicOutput: Uint8Array,
	encryptedShareAndProof: Uint8Array,
	protocolPublicParameters: Uint8Array,
): Promise<Uint8Array> {
	refuseMockValues(dWalletPublicOutput, encryptedShareAndProof, protocolPublicParameters);
	const userSecretKeyShare = Uint8Array.from(
		await decrypt_user_share(
			fromCurveToNumber(curve),
			decryptionKey,
			dWalletPublicOutput,
			encryptedShareAndProof,
			protocolPublicParameters,
		),
	);
	if (
		!(await verifyUserShare(
			curve,
			userSecretKeyShare,
			dWalletPublicOutput,
			protocolPublicParameters,
		))
	) {
		throw new Error("the decrypted share is not a share of the dWallet's public output");
	}
	return userSecretKeyShare;
}

/**
 * Create the user's sign message for the signature generation process.
 * This function combines the user's secret key, presign, and message to create a sign message to be sent to the network.
 *
 * This function is used when developer has access to the user's public output which should be verified before using this method.
 *
 * @param protocolPublicParameters - The protocol public parameters
 * @param publicOutput - The user's public output
 * @param userSecretKeyShare - The user's secret key share
 * @param presign - The presignature data from a completed presign operation
 * @param message - The message bytes to sign
 * @param hash - The hash scheme to use for signing
 * @param signatureAlgorithm - The signature algorithm to use
 * @param curve - The curve to use
 * @param hashContext - The context the message's hash takes, which a sign request's metadata names: a Schnorrkel signing context. When omitted, the context is the one the algorithm signs with: `substrate` for Schnorrkel, none otherwise. The network refuses a sign message made over another hash; `createUserSignMessageWithScheme` reads the context from the metadata
 * @returns The user's sign message that will be sent to the network for signature generation
 */
export async function createUserSignMessageWithPublicOutput<
	C extends Curve,
	S extends ValidSignatureAlgorithmForCurve<C>,
	H extends ValidHashForSignature<S>,
>(
	protocolPublicParameters: Uint8Array,
	publicOutput: Uint8Array,
	userSecretKeyShare: Uint8Array,
	presign: Uint8Array,
	message: Uint8Array,
	hash: H,
	signatureAlgorithm: S,
	curve: C,
	hashContext?: SignatureHashContext,
): Promise<Uint8Array> {
	refuseMockValues(protocolPublicParameters, publicOutput, presign);
	const { signatureAlgorithmNumber, hashNumber, curveNumber } =
		fromCurveAndSignatureAlgorithmAndHashToNumbers(curve, signatureAlgorithm, hash);

	return Uint8Array.from(
		await create_sign_user_message(
			protocolPublicParameters,
			publicOutput,
			userSecretKeyShare,
			presign,
			message,
			hashNumber,
			signatureAlgorithmNumber,
			curveNumber,
			hashContext === undefined
				? undefined
				: SignatureHashContextBcs.serialize(hashContext).toBytes(),
		),
	);
}

/**
 * Create the user's sign message from the user's own DKG public output,
 * before the network's output exists: the sign of a sign during DKG. It
 * takes the same arguments as {@link createUserSignMessageWithPublicOutput},
 * with the user's public output in place of the dWallet's.
 */
export async function createUserSignMessageWithUserPublicOutput<
	C extends Curve,
	S extends ValidSignatureAlgorithmForCurve<C>,
	H extends ValidHashForSignature<S>,
>(
	protocolPublicParameters: Uint8Array,
	userPublicOutput: Uint8Array,
	userSecretKeyShare: Uint8Array,
	presign: Uint8Array,
	message: Uint8Array,
	hash: H,
	signatureAlgorithm: S,
	curve: C,
	hashContext?: SignatureHashContext,
): Promise<Uint8Array> {
	refuseMockValues(protocolPublicParameters, userPublicOutput, presign);
	const { signatureAlgorithmNumber, hashNumber, curveNumber } =
		fromCurveAndSignatureAlgorithmAndHashToNumbers(curve, signatureAlgorithm, hash);

	return Uint8Array.from(
		await create_sign_centralized_party_message_with_centralized_party_dkg_output(
			protocolPublicParameters,
			userPublicOutput,
			userSecretKeyShare,
			presign,
			message,
			hashNumber,
			signatureAlgorithmNumber,
			curveNumber,
			hashContext === undefined
				? undefined
				: SignatureHashContextBcs.serialize(hashContext).toBytes(),
		),
	);
}

/**
 * Create the user's sign message for a secp256k1 ECDSA sign over the
 * BLAKE2b-256 hash of the message: the new flow's scheme `EcdsaBlake2b256`.
 * `createUserSignMessageWithPublicOutput` cannot name it, because `Hash` has
 * no BLAKE2b value.
 *
 * The network hashes the message with the personal and the salt of the sign
 * request's metadata, and refuses a sign message made over another hash. So
 * pass the two values the request's `Blake2bMessageMetadata` carries.
 * `createUserSignMessageWithScheme` reads them from the metadata.
 *
 * @param protocolPublicParameters - The protocol public parameters
 * @param publicOutput - The dWallet's DKG public output, already checked by the caller
 * @param userSecretKeyShare - The user's secret key share
 * @param presign - The presignature data from a completed presign operation
 * @param message - The message bytes to sign
 * @param personal - The BLAKE2b personalization, at most 16 bytes
 * @param salt - The BLAKE2b salt, at most 16 bytes
 * @returns The user's sign message that will be sent to the network for signature generation
 */
export async function createUserSignMessageEcdsaBlake2b256(
	protocolPublicParameters: Uint8Array,
	publicOutput: Uint8Array,
	userSecretKeyShare: Uint8Array,
	presign: Uint8Array,
	message: Uint8Array,
	personal: Uint8Array,
	salt: Uint8Array,
): Promise<Uint8Array> {
	refuseMockValues(protocolPublicParameters, publicOutput, presign);
	return Uint8Array.from(
		await create_sign_centralized_party_message_ecdsa_blake2b256(
			protocolPublicParameters,
			publicOutput,
			userSecretKeyShare,
			presign,
			message,
			personal,
			salt,
		),
	);
}

/**
 * Convert a network DKG public output to the protocol public parameters.
 *
 * @param curve - The curve to use for key generation
 * @param network_dkg_public_output - The network DKG public output
 * @returns The protocol public parameters
 */
export async function networkDkgPublicOutputToProtocolPublicParameters(
	curve: Curve,
	network_dkg_public_output: Uint8Array,
): Promise<Uint8Array> {
	refuseMockValues(network_dkg_public_output);
	return Uint8Array.from(
		await network_dkg_public_output_to_protocol_pp(
			fromCurveToNumber(curve),
			network_dkg_public_output,
		),
	);
}

/**
 * Convert a reconfiguration DKG public output to the protocol public parameters.
 *
 * @param curve - The curve to use for key generation
 * @param reconfiguration_public_output - The reconfiguration DKG public output
 * @param network_dkg_public_output - The network DKG public output
 * @returns The protocol public parameters
 */
export async function reconfigurationPublicOutputToProtocolPublicParameters(
	curve: Curve,
	reconfiguration_public_output: Uint8Array,
	network_dkg_public_output: Uint8Array,
): Promise<Uint8Array> {
	refuseMockValues(reconfiguration_public_output, network_dkg_public_output);
	return Uint8Array.from(
		await reconfiguration_public_output_to_protocol_pp(
			fromCurveToNumber(curve),
			reconfiguration_public_output,
			network_dkg_public_output,
		),
	);
}

/**
 * Verify a user's secret key share.
 *
 * @param curve - The curve to use for key generation
 * @param userSecretKeyShare - The user's unencrypted secret key share
 * @param userDKGOutput - The user's DKG output
 * @param networkDkgPublicOutput - The network DKG public output
 * @returns True if the user's secret key share is valid, false otherwise
 */
export async function verifyUserShare(
	curve: Curve,
	userSecretKeyShare: Uint8Array,
	userDKGOutput: Uint8Array,
	networkDkgPublicOutput: Uint8Array,
): Promise<boolean> {
	refuseMockValues(userDKGOutput, networkDkgPublicOutput);
	return await verify_user_share(
		fromCurveToNumber(curve),
		userSecretKeyShare,
		userDKGOutput,
		networkDkgPublicOutput,
	);
}

/**
 * The context a signature's hash takes beside the message (`HashContext` in
 * the network's cryptography library, in its variant order).
 *
 * `Schnorrkel` carries the signing context of a Schnorrkel signature.
 * `Blake2b` is listed to keep the variant order; no hash of this SDK takes it.
 */
export const SignatureHashContextBcs = bcs.enum('HashContext', {
	None: null,
	Blake2b: bcs.struct('Blake2b', {
		personal: bcs.vector(bcs.u8()),
		salt: bcs.vector(bcs.u8()),
	}),
	Schnorrkel: bcs.struct('Schnorrkel', {
		signing_context: bcs.vector(bcs.u8()),
	}),
});

export type SignatureHashContext = typeof SignatureHashContextBcs.$inferInput;

/**
 * Verify a signature the network returned, under the public key inside the
 * dWallet's DKG output. Works for every signature algorithm in
 * `SignatureAlgorithm` and every hash in `Hash`.
 *
 * Two kinds of signature cannot be verified by this function, because its
 * arguments cannot name them. Neither is invalid for that reason:
 * - An ECDSA signature over a BLAKE2b hash (the new flow's scheme
 *   `EcdsaBlake2b256`). `Hash` has no BLAKE2b value.
 *   `verifyEcdsaBlake2b256Signature` verifies one, and
 *   `verifySignatureWithScheme` calls it for a sign of the new flow.
 * - A signature made with a Fast Schnorr (VSS) algorithm. `SignatureAlgorithm`
 *   has no value for one, and the network signs no user request with them
 *   today.
 *
 * The check proves only that the signature was made by the key in
 * `dWalletPublicOutput`. Pass an output you already checked, such as the one
 * `userAndNetworkDKGOutputMatch` accepted when the dWallet was created. A
 * signature always verifies under the key of an output its sender chose.
 *
 * @param curve - The dWallet's curve
 * @param signatureAlgorithm - The signature algorithm the message was signed with
 * @param hash - The hash the message was signed with
 * @param dWalletPublicOutput - The dWallet's DKG public output, already checked by the caller
 * @param message - The message that was signed
 * @param signature - The sign output as the network returns it, before `parseSignatureFromSignOutput`
 * @param hashContext - The hash context. When omitted, the context is the one the algorithm signs with: `substrate` for Schnorrkel, none otherwise
 * @throws When the signature does not verify, or an argument does not decode
 */
export async function verifySignature<
	C extends Curve,
	S extends ValidSignatureAlgorithmForCurve<C>,
	H extends ValidHashForSignature<S>,
>(
	curve: C,
	signatureAlgorithm: S,
	hash: H,
	dWalletPublicOutput: Uint8Array,
	message: Uint8Array,
	signature: Uint8Array,
	hashContext?: SignatureHashContext,
): Promise<void> {
	refuseMockValues(dWalletPublicOutput);
	const { signatureAlgorithmNumber, hashNumber, curveNumber } =
		fromCurveAndSignatureAlgorithmAndHashToNumbers(curve, signatureAlgorithm, hash);

	await verify_signature(
		curveNumber,
		signatureAlgorithmNumber,
		hashNumber,
		hashContext === undefined
			? undefined
			: SignatureHashContextBcs.serialize(hashContext).toBytes(),
		dWalletPublicOutput,
		message,
		signature,
	);
}

/**
 * Verify a secp256k1 ECDSA signature over the BLAKE2b-256 hash of a message,
 * under the public key inside the dWallet's DKG output. The new flow's scheme
 * `EcdsaBlake2b256` makes such a signature. `verifySignature` cannot name it,
 * because `Hash` has no BLAKE2b value.
 *
 * The check proves only that the signature was made by the key in
 * `dWalletPublicOutput`. Pass an output you already checked. A signature
 * always verifies under the key of an output its sender chose.
 *
 * @param dWalletPublicOutput - The dWallet's DKG public output, already checked by the caller
 * @param message - The message that was signed
 * @param signature - The sign output as the network returns it
 * @param personal - The BLAKE2b personalization the message was hashed with, at most 16 bytes
 * @param salt - The BLAKE2b salt the message was hashed with, at most 16 bytes
 * @throws When the signature does not verify, or an argument does not decode
 */
export async function verifyEcdsaBlake2b256Signature(
	dWalletPublicOutput: Uint8Array,
	message: Uint8Array,
	signature: Uint8Array,
	personal: Uint8Array,
	salt: Uint8Array,
): Promise<void> {
	refuseMockValues(dWalletPublicOutput);
	await verify_ecdsa_blake2b256_signature(personal, salt, dWalletPublicOutput, message, signature);
}

/**
 * Create a public key from a DWallet output.
 *
 * @param curve - The curve to use for key generation
 * @param dWalletOutput - The DWallet output
 *
 * @returns The BCS-encoded public key
 */
export async function publicKeyFromDWalletOutput(
	curve: Curve,
	dWalletOutput: Uint8Array,
): Promise<Uint8Array> {
	refuseMockValues(dWalletOutput);
	return Uint8Array.from(
		await public_key_from_dwallet_output(fromCurveToNumber(curve), dWalletOutput),
	);
}

/**
 * The dWallet's public key, from the user's own DKG output
 * (`userPublicOutput` of `prepareDKGForSessionIdentifier`, or of an imported
 * key's verification). It is known before the request is sent, so the
 * dWallet's address on the chain is too.
 */
export async function publicKeyFromCentralizedDKGOutput(
	curve: Curve,
	userPublicOutput: Uint8Array,
): Promise<Uint8Array> {
	refuseMockValues(userPublicOutput);
	return Uint8Array.from(
		await public_key_from_centralized_dkg_output(fromCurveToNumber(curve), userPublicOutput),
	);
}

/**
 * Re-encode a dWallet's public output as V2, the way a migration from the
 * classic contracts does before the network attests it.
 *
 * A V2-tagged output is returned as it came. A V1-tagged output of a curve
 * other than secp256k1 is refused. A V1-tagged output is converted and wrapped
 * as V2 with `publicKey` in its public key field.
 *
 * `publicKey` is not compared with the key inside the output.
 *
 * @param curve - The dWallet's curve
 * @param dWalletOutput - The dWallet's public output, V1-tagged or V2-tagged
 * @param publicKey - The public key the V2 output names, as `publicKeyFromDWalletOutput` returns it
 * @returns The V2-tagged public output
 * @throws When the output does not decode, or is V1-tagged and the curve is not secp256k1
 */
export async function dWalletOutputAtLatestVersion(
	curve: Curve,
	dWalletOutput: Uint8Array,
	publicKey: Uint8Array,
): Promise<Uint8Array> {
	refuseMockValues(dWalletOutput);
	return Uint8Array.from(
		await dwallet_output_at_latest_version(fromCurveToNumber(curve), dWalletOutput, publicKey),
	);
}

/**
 * Verify that the user's public output matches the network's public output.
 *
 * @param curve - The curve to use
 * @param userPublicOutput - The user's public output
 * @param networkDKGOutput - The network's public output
 * @returns True if the user's public output matches the network's public output, false otherwise
 */
export async function userAndNetworkDKGOutputMatch(
	curve: Curve,
	userPublicOutput: Uint8Array,
	networkDKGOutput: Uint8Array,
): Promise<boolean> {
	refuseMockValues(userPublicOutput, networkDKGOutput);
	return await centralized_and_decentralized_parties_dkg_output_match(
		fromCurveToNumber(curve),
		userPublicOutput,
		networkDKGOutput,
	);
}
