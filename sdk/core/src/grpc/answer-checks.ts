// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The checks of the network's answer to a request that changes state.
 *
 * `DWalletGrpcClient.submitTransaction` returns the answer of one validator,
 * once it decodes. Nothing in that answer proves it answers the request that
 * was sent: a validator, or anyone on a plaintext connection, can answer with
 * an old attestation that the trusted network key once signed. So each of the
 * four requests below has a check of its answer, which the caller runs on the
 * answer before it treats the request as done:
 *
 * - `verifyPresignAnswer`, for a `Presign` or a `PresignForDWallet`;
 * - `verifyMakeSharePublicAnswer`, for a `MakeSharePublic`;
 * - `verifyReEncryptShareAnswer`, for a `ReEncryptShare`;
 * - `verifyFutureSignAnswer`, for a `FutureSign`, step 1 of a future sign.
 *
 * Each check takes the answer as `submitTransaction` returns it, and the
 * network keys the caller trusts (`trustedNetworkKeys`, each 32 bytes):
 * read from the network keys' own records, or configured. Each throws, and
 * returns nothing, when the answer is an `Error`, when it is a `Signature`,
 * when its attestation names, as the key that holds the dWallet's network
 * share (`network_pubkey`), another key than the one the request used
 * (`verifyAttestationNetworkKey`), when its signer
 * (`signer_noa_public_key`) is not trusted (check `signer`), when its
 * signature does not verify under its signer as the kind of attestation the
 * request is answered with, and when it does not name what the request sent.
 * The network's signing key can change from one epoch to the next, so the
 * signer of an answer about a dWallet made under an earlier key differs from
 * that dWallet's key. A refusal of the attestation itself is an
 * `AttestationRecordError` that names the failed check and, for a `binding`
 * failure, the attestation field that differs.
 *
 * The Rust SDK makes the same checks.
 */
import { keccak_256 } from '@noble/hashes/sha3.js';

import {
	AttestationRecordError,
	recordOfAttestation,
	verifyAttestationNetworkKey,
	verifyAttestationRecord,
	verifyEncryptedShareAttestationRecord,
	verifyPublicShareAttestationRecord,
} from './attestation-record.js';
import type {
	EncryptedShareAttestation,
	PublicShareAttestation,
	VerifiedDWalletAttestation,
} from './attestation-record.js';
import {
	VersionedDWalletDataAttestationBcs,
	VersionedPartialUserSignatureAttestationBcs,
	VersionedPresignDataAttestationBcs,
} from './bcs.js';
import type { DWalletCurveBcs, DWalletSignatureAlgorithmBcs } from './bcs.js';
import type { IkaNetwork, TrustedNetworkKeys } from './deployed-networks.js';
import { futureSignMessageDigests } from './requests.js';
import type {
	DWalletSignatureSchemeInput,
	HeldAttestation,
	PartialUserSignatureAttestation,
} from './requests.js';
import { dwalletAttestationDigest } from './share-acceptance.js';
import type { TransactionResponseData } from './types.js';

function equalBytes(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
	return (
		left.length === right.length && Array.from(left).every((byte, index) => byte === right[index])
	);
}

/**
 * A `binding` failure unless `holds`: the answer's attestation names, in
 * `field`, something else than `what`.
 */
function requireSent(field: string, holds: boolean, what: string): void {
	if (!holds) {
		throw new AttestationRecordError('binding', `the attestation's ${field} is not ${what}`, field);
	}
}

/**
 * The attestation an answer carries, once the key it names as holding the
 * dWallet's network share (`network_pubkey`) is `expectedNetworkKeyId`, the
 * key the request used.
 *
 * An `Error` answer is the network's refusal, and a `Signature` answer is
 * never the answer to a request that changes state: both throw an `Error`. An
 * attestation whose `network_pubkey` is not `expectedNetworkKeyId` is refused
 * as `binding`, field `network_pubkey` (`verifyAttestationNetworkKey`, with
 * no trusted set), and so is one that names a key this SDK does not list for
 * `network` on mainnet and testnet. The key need not be one the caller trusts
 * now, so an answer about a dWallet made under an earlier network key passes.
 * The
 * signature itself is checked by the record check of the answer's kind: its
 * signer must be one of the trusted keys, and the signature must verify under
 * that signer.
 */
function attestationOfAnswer(
	response: TransactionResponseData,
	network: IkaNetwork,
	expectedNetworkKeyId: ArrayLike<number>,
): HeldAttestation {
	if (response.$kind === 'Error') {
		throw new Error(`the network refused the request: ${response.Error.message}`);
	}
	if (response.$kind !== 'Attestation') {
		throw new Error('a request that changes state was answered with a signature');
	}
	const attestation = response.Attestation;
	verifyAttestationNetworkKey(attestation.network_pubkey, expectedNetworkKeyId, network);
	return attestation;
}

/** What a `MakeSharePublic` request sent: the session it opened, and the share it revealed. */
export interface SentMakeSharePublic {
	/** The request's session identifier (`grpcSessionIdentifier`), 32 bytes. */
	sessionIdentifier: Uint8Array;
	/**
	 * The network key the request's dWallet attestation names, the dWallet's
	 * key (its `network_pubkey`), 32 bytes. The answer must name it too.
	 */
	networkKeyId: Uint8Array;
	/** The request's `public_user_secret_key_share`. */
	publicUserSecretKeyShare: Uint8Array;
}

/**
 * Check the answer to a `MakeSharePublic` request: the public share's
 * attestation, which the network commits as the dWallet's public share
 * record. Returns the decoded attestation.
 *
 * The attestation must name `sent.networkKeyId` as its `network_pubkey`
 * (`verifyAttestationNetworkKey`). It must pass `verifyPublicShareAttestationRecord` under
 * `trustedNetworkKeys`, for `dwallet`, the dWallet's attestation as
 * `verifyDWalletAttestationRecord` verified it: its signature as a public
 * share attestation, its exact decode, the exact length of a public share of
 * the dWallet's curve, the dWallet's sender and public key, and the digest of
 * the dWallet's attestation. Then it must name the request's own session
 * (field `session_identifier`) and hold the very share the request sent
 * (field `public_user_secret_key_share`). The first check that fails throws.
 */
export function verifyMakeSharePublicAnswer(
	response: TransactionResponseData,
	trustedNetworkKeys: TrustedNetworkKeys,
	dwallet: VerifiedDWalletAttestation,
	sent: SentMakeSharePublic,
): PublicShareAttestation {
	const answer = attestationOfAnswer(response, trustedNetworkKeys.network, sent.networkKeyId);
	const attestation = verifyPublicShareAttestationRecord(
		recordOfAttestation(answer),
		trustedNetworkKeys,
		dwallet,
	);
	requireSent(
		'session_identifier',
		equalBytes(attestation.session_identifier, sent.sessionIdentifier),
		"the make-public request's session identifier",
	);
	requireSent(
		'public_user_secret_key_share',
		equalBytes(attestation.public_user_secret_key_share, sent.publicUserSecretKeyShare),
		'the share the request sent',
	);
	return attestation;
}

/**
 * What a `ReEncryptShare` request sent: the session it opened, the share
 * encrypted to the new holder, the encryption key it was encrypted to, and
 * the new holder.
 */
export interface SentReEncryptShare {
	/** The request's session identifier (`grpcSessionIdentifier`), 32 bytes. */
	sessionIdentifier: Uint8Array;
	/**
	 * The network key the request's dWallet attestation names, the dWallet's
	 * key (its `network_pubkey`), 32 bytes. The answer must name it too.
	 */
	networkKeyId: Uint8Array;
	/** The request's `encrypted_centralized_secret_share_and_proof`. */
	encryptedShareAndProof: Uint8Array;
	/** The request's `encryption_key`. */
	encryptionKey: Uint8Array;
	/** The new holder's Ed25519 signer public key, the request's `holder`. */
	holderSignerPublicKey: Uint8Array;
}

/**
 * Check the answer to a `ReEncryptShare` request: the new share's
 * attestation, which the new holder accepts. Returns the decoded attestation.
 *
 * The attestation must name `sent.networkKeyId` as its `network_pubkey`
 * (`verifyAttestationNetworkKey`). It must pass
 * `verifyEncryptedShareAttestationRecord` under
 * `trustedNetworkKeys`, for `dwallet` (the dWallet's attestation as
 * `verifyDWalletAttestationRecord` verified it) and for the new holder: its
 * signature as an encrypted share attestation, its exact decode, the dWallet's
 * sender and public key, the digest of the dWallet's attestation, and the
 * holder. Then it must name the request's own session (field
 * `session_identifier`), the keccak256 of the encrypted share sent (field
 * `encrypted_share_hash`), and the keccak256 of the encryption key sent (field
 * `encryption_key_hash`). The first check that fails throws.
 */
export function verifyReEncryptShareAnswer(
	response: TransactionResponseData,
	trustedNetworkKeys: TrustedNetworkKeys,
	dwallet: VerifiedDWalletAttestation,
	sent: SentReEncryptShare,
): EncryptedShareAttestation {
	const answer = attestationOfAnswer(response, trustedNetworkKeys.network, sent.networkKeyId);
	const attestation = verifyEncryptedShareAttestationRecord(
		recordOfAttestation(answer),
		trustedNetworkKeys,
		dwallet,
		{ holderSignerPublicKey: sent.holderSignerPublicKey },
	);
	requireSent(
		'session_identifier',
		equalBytes(attestation.session_identifier, sent.sessionIdentifier),
		"the re-encryption request's session identifier",
	);
	requireSent(
		'encrypted_share_hash',
		equalBytes(attestation.encrypted_share_hash, keccak_256(sent.encryptedShareAndProof)),
		'the hash of the encrypted share sent',
	);
	requireSent(
		'encryption_key_hash',
		equalBytes(attestation.encryption_key_hash, keccak_256(sent.encryptionKey)),
		'the hash of the encryption key sent',
	);
	return attestation;
}

/** What a `FutureSign` request sent, which its answer must name. */
export interface SentFutureSign {
	/** The request's session identifier (`grpcSessionIdentifier`), 32 bytes. */
	sessionIdentifier: Uint8Array;
	/** The request's `intended_chain_sender`. */
	intendedChainSender: Uint8Array;
	/** The dWallet attestation the request carried. */
	dwalletAttestation: HeldAttestation;
	/** The presign's attestation the request carried. */
	presignAttestation: HeldAttestation;
	message: Uint8Array;
	messageMetadata: Uint8Array;
	signatureScheme: DWalletSignatureSchemeInput;
	/** The voucher's 32-byte address. */
	futureSignatureVoucher: Uint8Array;
}

/** Decode `attestationData` as a V1 attestation of the versioned `type`, or throw a `decode` failure. */
function decodeV1<T extends { V1?: unknown }>(
	type: { parse(bytes: Uint8Array): T },
	attestationData: ArrayLike<number>,
	name: string,
): NonNullable<T['V1']> {
	let decoded: T;
	try {
		decoded = type.parse(Uint8Array.from(Array.from(attestationData)));
	} catch (error) {
		throw new AttestationRecordError(
			'decode',
			`the ${name} attestation does not decode: ` +
				`${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (decoded.V1 === undefined || decoded.V1 === null) {
		throw new AttestationRecordError('decode', `the ${name} attestation is not V1`);
	}
	return decoded.V1 as NonNullable<T['V1']>;
}

/**
 * Check the answer to a `FutureSign` request, step 1 of a future sign: the
 * partial-signature attestation, which the network also writes into the
 * voucher and which the completion carries back. Returns the decoded
 * attestation.
 *
 * The checks, in order. The first that fails throws:
 * 1. It names, as its `network_pubkey`, the key the sent dWallet attestation
 *    names (`verifyAttestationNetworkKey`). Then the record check under
 *    `trustedNetworkKeys`, as a `partial_user_signature` attestation: its
 *    version, its signature and its exact decode.
 * 2. It names what the request sent: the request's session (field
 *    `session_identifier`), its chain sender, the dWallet's public key, the
 *    digest of the dWallet attestation's bytes (field
 *    `dwallet_attestation_hash`), the voucher, the presign's reference
 *    and the keccak256 of its attestation's bytes (field
 *    `presign_attestation_hash`), the digests of the message and of its
 *    metadata as a voucher records them (field `message_digest`, as
 *    `futureSignMessageDigests` computes them), and the signature scheme.
 *
 * The verified sign data the attestation holds is the network's own. The SDK
 * passes it back unread in the completion.
 */
export function verifyFutureSignAnswer(
	response: TransactionResponseData,
	trustedNetworkKeys: TrustedNetworkKeys,
	sent: SentFutureSign,
): PartialUserSignatureAttestation {
	const answer = attestationOfAnswer(
		response,
		trustedNetworkKeys.network,
		sent.dwalletAttestation.network_pubkey,
	);
	verifyAttestationRecord(
		recordOfAttestation(answer),
		trustedNetworkKeys,
		'partial_user_signature',
	);
	const attestation = decodeV1(
		VersionedPartialUserSignatureAttestationBcs,
		answer.attestation_data,
		'partial-signature',
	);
	const { messageDigest, messageMetadataDigest } = futureSignMessageDigests(
		sent.message,
		sent.messageMetadata,
	);
	requireSent(
		'session_identifier',
		equalBytes(attestation.session_identifier, sent.sessionIdentifier),
		"the future sign request's session identifier",
	);
	requireSent(
		'intended_chain_sender',
		equalBytes(attestation.intended_chain_sender, sent.intendedChainSender),
		'the chain sender the request named',
	);
	const dwallet = decodeV1(
		VersionedDWalletDataAttestationBcs,
		sent.dwalletAttestation.attestation_data,
		'dWallet',
	);
	requireSent(
		'dwallet_public_key',
		equalBytes(attestation.dwallet_public_key, dwallet.public_key),
		"the dWallet's public key",
	);
	requireSent(
		'dwallet_attestation_hash',
		equalBytes(
			attestation.dwallet_attestation_hash,
			dwalletAttestationDigest(sent.dwalletAttestation.attestation_data),
		),
		'the digest of the dWallet attestation sent',
	);
	requireSent(
		'future_signature_voucher',
		equalBytes(attestation.future_signature_voucher, sent.futureSignatureVoucher),
		'the voucher the request named',
	);
	const presign = decodeV1(
		VersionedPresignDataAttestationBcs,
		sent.presignAttestation.attestation_data,
		'presign',
	);
	requireSent(
		'presign_session_identifier',
		equalBytes(attestation.presign_session_identifier, presign.presign_session_identifier),
		"the presign's reference",
	);
	requireSent(
		'presign_attestation_hash',
		equalBytes(
			attestation.presign_attestation_hash,
			keccak_256(Uint8Array.from(sent.presignAttestation.attestation_data)),
		),
		'the hash of the presign attestation sent',
	);
	requireSent(
		'message_digest',
		equalBytes(attestation.message_digest, messageDigest) &&
			equalBytes(attestation.message_metadata_digest, messageMetadataDigest),
		'the digests of the message and metadata sent',
	);
	// The scheme the request named is the one key of its input other than `$kind`.
	const sentScheme = Object.keys(sent.signatureScheme).find((key) => key !== '$kind');
	requireSent(
		'signature_scheme',
		attestation.signature_scheme.$kind === sentScheme,
		'the scheme the request named',
	);
	return attestation;
}

/** A presign attestation, decoded. */
export type PresignDataAttestation = (typeof VersionedPresignDataAttestationBcs.$inferType)['V1'];

/** What a `Presign` or a `PresignForDWallet` request sent, which its answer must name. */
export interface SentPresign {
	/** The request's session identifier (`grpcSessionIdentifier`), 32 bytes. */
	sessionIdentifier: Uint8Array;
	/** The epoch the request was stamped with, its `SignedRequestData.epoch`. */
	epoch: bigint | number;
	/** The request's `curve`, as the request names it, such as `{ Secp256k1: null }`. */
	curve: Parameters<typeof DWalletCurveBcs.serialize>[0];
	/** The request's `signature_algorithm`, as the request names it, such as `{ EdDSA: null }`. */
	signatureAlgorithm: Parameters<typeof DWalletSignatureAlgorithmBcs.serialize>[0];
	/** The `dwallet_public_key` a `PresignForDWallet` named, and `null` for a global `Presign`. */
	dwalletPublicKey: Uint8Array | null;
	/**
	 * The request's `network_key_id`, 32 bytes: the key of the pool a global
	 * `Presign` draws from, or the dWallet's key for a `PresignForDWallet`.
	 * The answer must name it as its `network_pubkey`.
	 */
	networkKeyId: Uint8Array;
}

/** The variant an enum input names: its one key other than `$kind`. */
function variantOf(input: object): string | undefined {
	return Object.keys(input).find((key) => key !== '$kind');
}

/**
 * Check the answer to a `Presign` or a `PresignForDWallet` request: the
 * presign attestation the network served. Returns the decoded attestation.
 *
 * The network writes the request's own session identifier and epoch into the
 * presign attestation, with the curve and the algorithm the request named,
 * and the dWallet a `PresignForDWallet` named (none for a global `Presign`).
 * Without these comparisons, a validator could answer with an earlier presign
 * attestation of the same requester, which the trusted key signed too. That
 * presign may already be consumed, and a store or a sign that uses it is
 * refused and charged. The session identifier hashes the key that signed the
 * request, so a presign that names the request's session was also served to
 * that key.
 *
 * The checks, in order. The first that fails throws:
 * 1. It names the request's `networkKeyId` as its `network_pubkey`
 *    (`verifyAttestationNetworkKey`). Then the record check under
 *    `trustedNetworkKeys`, as a `presign` attestation: its version, its
 *    signature and its exact decode.
 * 2. It names what the request sent: the request's session (field
 *    `session_identifier`), its epoch (field `epoch`), its curve (field
 *    `curve`), its algorithm (field `signature_algorithm`), and the dWallet a
 *    `PresignForDWallet` named, or none for a global `Presign` (field
 *    `dwallet_public_key`).
 *
 * The Rust SDK makes the same five comparisons.
 */
export function verifyPresignAnswer(
	response: TransactionResponseData,
	trustedNetworkKeys: TrustedNetworkKeys,
	sent: SentPresign,
): PresignDataAttestation {
	const answer = attestationOfAnswer(response, trustedNetworkKeys.network, sent.networkKeyId);
	verifyAttestationRecord(recordOfAttestation(answer), trustedNetworkKeys, 'presign');
	const attestation = decodeV1(
		VersionedPresignDataAttestationBcs,
		answer.attestation_data,
		'presign',
	);
	requireSent(
		'session_identifier',
		equalBytes(attestation.session_identifier, sent.sessionIdentifier),
		"the presign request's session identifier",
	);
	requireSent(
		'epoch',
		BigInt(attestation.epoch) === BigInt(sent.epoch),
		'the epoch the request was stamped with',
	);
	requireSent(
		'curve',
		attestation.curve.$kind === variantOf(sent.curve),
		'the curve the request named',
	);
	requireSent(
		'signature_algorithm',
		attestation.signature_algorithm.$kind === variantOf(sent.signatureAlgorithm),
		'the algorithm the request named',
	);
	const boundTo = attestation.dwallet_public_key ?? null;
	requireSent(
		'dwallet_public_key',
		sent.dwalletPublicKey === null
			? boundTo === null
			: boundTo !== null && equalBytes(boundTo, sent.dwalletPublicKey),
		'the dWallet the request named, or none for a global presign',
	);
	return attestation;
}
