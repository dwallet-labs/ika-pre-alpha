// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The check of an attestation record read from any chain.
 *
 * The network signs an attestation for each result it commits: a dWallet, an
 * encrypted share, a public share, a partial user signature. A chain record
 * keeps no attestation bytes and no hash. It keeps the attestation's fields
 * as typed values, and one proof envelope that no contract opens
 * (`VersionedAttestationProofBcs`): the attestation's version, the public
 * key of the network key that signed (the signer), and the network's Ed25519
 * signature. A reader decodes the proof (`decodeAttestationProof`, which
 * refuses a version this SDK does not know), rebuilds the attestation's bytes
 * from the stored fields at that version (`rebuildDWalletAttestation` and the
 * other rebuild functions), and makes the record this check takes
 * (`attestationRecordOf`). Every chain's reader rebuilds the same way, so
 * this check is the same for every chain.
 *
 * The network signs the attestation's exact bytes, not a digest of them,
 * behind a prefix and a tag naming the attestation's kind
 * (`attestationSigningMessage`, as `AttestationKind::signing_message` and
 * `NetworkSignedAttestation::verify_signature` in `ika-types`). So a record
 * whose stored fields are not the signed ones is rebuilt into other bytes,
 * and the signature does not verify over them. The keccak256 of the rebuilt
 * bytes, which the reader computes itself, is what a holder signs to accept
 * a dWallet's share (`dwalletAttestationDigest`).
 *
 * A valid signature says only that the network signed these bytes. It does
 * not say the bytes are about the dWallet or the holder the caller asked
 * for: a record could hold a validly signed attestation of another dWallet.
 * So a caller checks a record with the function for its kind
 * (`verifyDWalletAttestationRecord`, `verifyEncryptedShareAttestationRecord`,
 * `verifyPublicShareAttestationRecord`), which also decodes the attestation
 * and requires it to name what was asked for.
 *
 * Every check takes the set of network keys the caller trusts: read from the
 * network keys' own records, or configured. A record names its own signer,
 * because the network's signing key can change from one epoch to the next and
 * a record keeps the signature of the epoch that agreed it. The check
 * requires that signer to be one of the trusted keys, and only then verifies
 * the signature under it. Never build the trusted set from what a record
 * states about itself: a record that verifies under a key it names itself
 * proves nothing. An empty set refuses every record.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

import {
	VersionedAttestationProofBcs,
	VersionedDWalletDataAttestationBcs,
	VersionedEncryptedUserKeyShareAttestationBcs,
	VersionedPartialUserSignatureAttestationBcs,
	VersionedPresignDataAttestationBcs,
	VersionedPublicUserKeyShareAttestationBcs,
} from './bcs.js';
import { attestationNetworkKeyRefusalIn } from './deployed-networks-internal.js';
import { IKA_DEPLOYED_NETWORKS, listedNetworkKey } from './deployed-networks.js';
import type { IkaNetwork, TrustedNetworkKeys } from './deployed-networks.js';
import type { NetworkEncryptionKeyChainRecord, NetworkKeyChainReader } from './requests.js';
import { dwalletAttestationDigest } from './share-acceptance.js';

/**
 * One attestation as the checks take it: from a chain record, the bytes the
 * reader rebuilt from the stored fields with what the record's proof holds
 * (`attestationRecordOf`); from a validator's answer, the answer's bytes
 * (`recordOfAttestation`). A record stores no hash: a check that needs it
 * hashes `attestationData` itself.
 */
export interface AttestationRecord {
	/** The attestation's BCS bytes: rebuilt from a record's fields, or an answer's. */
	attestationData: Uint8Array;
	/** The version: the variant index of the versioned attestation. */
	attestationVersion: number;
	/**
	 * The stored Ed25519 signature of the network over `attestationData`,
	 * signed as its kind (`attestationSigningMessage`).
	 */
	networkSignature: Uint8Array;
	/**
	 * The stored public key of the network key that made
	 * `networkSignature`. The check verifies under it once it is one of the
	 * keys the caller trusts.
	 */
	signerNoaPublicKey: Uint8Array;
}

/**
 * The attestation versions this SDK can read. Each versioned attestation is a
 * BCS enum, and its first byte is the variant index: `V1` is 0.
 */
export const KNOWN_ATTESTATION_VERSIONS: readonly number[] = [0];

/**
 * The kinds of attestation the network signs. The network signs each kind's
 * BCS bytes behind a prefix and the kind's own tag
 * (`attestationSigningMessage`), so a signature over one kind never verifies
 * as another kind. A check is told the kind it expects, verifies the
 * signature as that kind, and decodes the bytes as exactly that kind.
 *
 * `partial_user_signature` answers step 1 of a future sign
 * (`decodePartialUserSignatureAttestation` decodes it), and the completion
 * carries it back.
 */
export type AttestationKind =
	'dwallet' | 'presign' | 'partial_user_signature' | 'encrypted_share' | 'public_share';

/** The kinds of attestation a chain record keeps. */
export type AttestationRecordKind = 'dwallet' | 'encrypted_share' | 'public_share';

/**
 * The one byte that names each kind in the message the network signs, as the
 * node's `AttestationKind::tag` numbers them.
 */
export const ATTESTATION_KIND_TAGS: Readonly<Record<AttestationKind, number>> = {
	dwallet: 0,
	presign: 1,
	partial_user_signature: 2,
	encrypted_share: 3,
	public_share: 4,
};

/**
 * The first bytes of every attestation message the network signs: the byte
 * `0xFE` and the text `ika-attestation` (`ATTESTATION_SIGNING_PREFIX` in the
 * node's `ika-types`). They keep an attestation message apart from every
 * other message the network's key signs, such as a gas release or a Solana
 * transaction.
 */
export const ATTESTATION_SIGNING_PREFIX: Uint8Array = Uint8Array.from([
	0xfe,
	...new TextEncoder().encode('ika-attestation'),
]);

/**
 * The message the network signs for `attestationData` of `kind`: the prefix,
 * the kind's tag, then the attestation bytes unchanged.
 */
export function attestationSigningMessage(
	kind: AttestationKind,
	attestationData: ArrayLike<number>,
): Uint8Array {
	return Uint8Array.from([
		...ATTESTATION_SIGNING_PREFIX,
		ATTESTATION_KIND_TAGS[kind],
		...Array.from(attestationData),
	]);
}

/**
 * Which part of the check a record failed. `version` means the attestation's
 * version is not one this SDK knows. `signer` means the record's signer
 * is not one of the network keys the caller trusts. `decode` means the bytes are not
 * exactly an attestation of the expected kind. `length` means a public share
 * attestation's share is not the length a public share has (the error's
 * `field` is `public_user_secret_key_share`). `binding` means the attestation
 * names another dWallet or holder than the caller asked for; the error's
 * `field` names the attestation field that differs. `record` means a value
 * the record stores does not match the signed attestation, or cannot be read
 * or written into it; the error's `field` names the stored field.
 */
export type AttestationRecordCheck =
	'version' | 'signer' | 'signature' | 'decode' | 'length' | 'binding' | 'record';

/** A record that fails a check, naming the failed check. */
export class AttestationRecordError extends Error {
	readonly check: AttestationRecordCheck;
	/** For a `length`, `binding` or `record` failure, the field that differs. */
	readonly field?: string;

	constructor(check: AttestationRecordCheck, message: string, field?: string) {
		super(message);
		this.name = 'AttestationRecordError';
		this.check = check;
		this.field = field;
	}
}

function equalBytes(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
	return (
		left.length === right.length && Array.from(left).every((byte, index) => byte === right[index])
	);
}

/** Each kind's versioned BCS type and its name in errors. */
const KIND_TYPES = {
	dwallet: { name: 'dWallet', type: VersionedDWalletDataAttestationBcs },
	presign: { name: 'presign', type: VersionedPresignDataAttestationBcs },
	partial_user_signature: {
		name: 'partial-signature',
		type: VersionedPartialUserSignatureAttestationBcs,
	},
	encrypted_share: { name: 'encrypted share', type: VersionedEncryptedUserKeyShareAttestationBcs },
	public_share: { name: 'public share', type: VersionedPublicUserKeyShareAttestationBcs },
} as const;

type Decoded<K extends AttestationKind> = (typeof KIND_TYPES)[K]['type']['$inferType'];

/**
 * The exact length of a public share, by curve number (0 secp256k1, 1
 * secp256r1, 2 Curve25519, 3 Ristretto).
 *
 * A public share is the BCS bytes of `VersionedDwalletUserSecretShare::V1`
 * holding the BCS bytes of the curve's centralized party secret key share,
 * which is one scalar. The variant index and the outer vector's length take
 * one byte each. A secp256k1 or secp256r1 scalar serializes as a byte vector
 * of 32 bytes behind a one-byte length, 33 bytes in all, so its share is 35
 * bytes. A Curve25519 or Ristretto scalar serializes as 32 bytes with no
 * length, so its share is 34 bytes.
 *
 * The network admits a DKG with a public share only when the share decodes
 * as exactly that (`public_share_session_input_refusal` in the node's MPC
 * service, through `decode_dkg_centralized_party_inputs`). It writes the
 * request's share into the attestation unchanged
 * (`share_attestation_of_output`). The conformance vectors pin these lengths
 * (`public_share_lengths`), and a node test decodes a share of each length.
 *
 * An encrypted share attestation whose `encrypted_share_hash` starts with
 * byte `0x60` also decodes as a public share attestation of the same dWallet,
 * with a 96-byte share. The network's signature names the kind, so such bytes
 * fail the signature check as a public share. The length check refuses them
 * as well, and it refuses any share the node would not have admitted.
 */
export const PUBLIC_SHARE_LENGTHS: readonly number[] = [35, 35, 34, 34];

/**
 * Require a public share to be exactly the length of `curve`'s public share.
 * Throws a `length` failure otherwise, naming both lengths.
 */
function requirePublicShareLength(share: ArrayLike<number>, curve: number): void {
	const expected = PUBLIC_SHARE_LENGTHS[curve];
	if (share.length !== expected) {
		throw new AttestationRecordError(
			'length',
			`the public share is ${share.length} bytes, and a public share of curve ${curve} ` +
				`is exactly ${expected} bytes`,
			'public_user_secret_key_share',
		);
	}
}

/**
 * Decode `bytes` as exactly an attestation of `kind`: the parse must succeed,
 * and serializing the result must give back every byte, so no byte is left
 * over and every length is written the one way BCS writes it. Throws a
 * `decode` failure otherwise.
 */
function decodeExactly<K extends AttestationKind>(kind: K, bytes: Uint8Array): Decoded<K> {
	const { name, type } = KIND_TYPES[kind];
	let decoded: Decoded<K>;
	try {
		decoded = type.parse(bytes) as Decoded<K>;
	} catch (error) {
		throw new AttestationRecordError(
			'decode',
			`the attestation bytes are not a ${name} attestation: ` +
				`${error instanceof Error ? error.message : String(error)}`,
		);
	}
	let reserialized: Uint8Array;
	try {
		reserialized = (type as { serialize(value: unknown): { toBytes(): Uint8Array } })
			.serialize(decoded)
			.toBytes();
	} catch {
		reserialized = new Uint8Array();
	}
	if (!equalBytes(reserialized, bytes)) {
		throw new AttestationRecordError(
			'decode',
			`the attestation bytes are not exactly a ${name} attestation: bytes are left over, ` +
				'or a length is not written as BCS writes it',
		);
	}
	if (decoded.$kind !== 'V1') {
		throw new AttestationRecordError(
			'decode',
			`the ${name} attestation is variant ${decoded.$kind}, not V1`,
		);
	}
	return decoded;
}

/**
 * Check an attestation record of `kind` read from a chain against the network
 * keys the caller trusts (`trustedNetworkKeys`, each the 32-byte Ed25519
 * network key), and return the decoded attestation. Throws
 * an `AttestationRecordError` naming the first check that fails:
 *
 * - `version`: the version is not one this SDK knows;
 * - `signer`: the record's signer (`signerNoaPublicKey`) is not one of
 *   `trustedNetworkKeys`; an empty set refuses every record;
 * - `signature`: the network's signature does not verify over the bytes
 *   signed as `kind` (`attestationSigningMessage`) under the record's signer;
 * - `decode`: the bytes are not exactly an attestation of `kind`;
 * - `length`: for a public share, the share is not exactly the length of the
 *   public share of `publicShareCurve`, the dWallet's curve
 *   (`PUBLIC_SHARE_LENGTHS`).
 *
 * A public share can be checked only against its dWallet's curve, so the
 * curve is required for that kind.
 *
 * For a chain record the bytes are the ones the reader rebuilt from the
 * stored fields, so a record whose stored fields are not the signed ones
 * fails `signature`. No stored hash is compared, because a record stores
 * none. The bytes are not compared with the version either: the rebuild
 * writes the version as the first byte, and `recordOfAttestation` reads it
 * from there.
 */
function verifyAndDecode<K extends AttestationKind>(
	record: AttestationRecord,
	trustedNetworkKeys: TrustedNetworkKeys,
	kind: K,
	publicShareCurve?: number,
): Decoded<K> {
	if (
		kind === 'public_share' &&
		(publicShareCurve === undefined || PUBLIC_SHARE_LENGTHS[publicShareCurve] === undefined)
	) {
		throw new TypeError(
			"a public share attestation is checked against its dWallet's curve: pass the curve, " +
				'0 to 3',
		);
	}
	requireKnownVersion(record.attestationVersion);
	if (!trustedNetworkKeys.publicKeys.some((key) => equalBytes(key, record.signerNoaPublicKey))) {
		throw new AttestationRecordError(
			'signer',
			"the record's signer is not one of the network keys the caller trusts",
		);
	}
	let verified: boolean;
	try {
		verified = ed25519.verify(
			record.networkSignature,
			attestationSigningMessage(kind, record.attestationData),
			record.signerNoaPublicKey,
		);
	} catch {
		verified = false;
	}
	if (!verified) {
		throw new AttestationRecordError(
			'signature',
			`the network's signature does not verify over the attestation bytes as a ` +
				`${KIND_TYPES[kind].name} attestation under its signer`,
		);
	}
	const decoded = decodeExactly(kind, record.attestationData);
	if (kind === 'public_share' && publicShareCurve !== undefined) {
		requirePublicShareLength(
			(decoded as Decoded<'public_share'>).V1.public_user_secret_key_share,
			publicShareCurve,
		);
	}
	return decoded;
}

/**
 * Check an attestation record of `kind` (`version`, `signer`, `signature`,
 * `decode` and, for a public share, `length`, as above). This does not check
 * what the attestation is about. A caller that asked for a particular dWallet
 * or share uses the function for its kind, which also does that.
 *
 * A presign or a partial-signature attestation is not kept as a chain record,
 * but it arrives in an answer, and is checked the same way: the answer checks
 * (`answer-checks.ts`) build its record with `recordOfAttestation`.
 *
 * A public share attestation takes `curve`, its dWallet's curve number, and
 * its share must be exactly that curve's public share length (see
 * `PUBLIC_SHARE_LENGTHS`), so the curve is required, and a call without it
 * throws.
 */
export function verifyAttestationRecord(
	record: AttestationRecord,
	trustedNetworkKeys: TrustedNetworkKeys,
	kind: 'dwallet' | 'encrypted_share' | 'presign' | 'partial_user_signature',
): void;
export function verifyAttestationRecord(
	record: AttestationRecord,
	trustedNetworkKeys: TrustedNetworkKeys,
	kind: 'public_share',
	curve: number,
): void;
export function verifyAttestationRecord(
	record: AttestationRecord,
	trustedNetworkKeys: TrustedNetworkKeys,
	kind: AttestationKind,
	curve?: number,
): void {
	verifyAndDecode(record, trustedNetworkKeys, kind, curve);
}

/**
 * An attestation as a record, so that the record checks can run on an
 * attestation that came in an answer: its bytes, the version their first byte
 * states, the signature, and the signer the attestation
 * names (`signer_noa_public_key`). Its `network_pubkey` is the key that holds
 * the dWallet's network share, not the signer. Bytes with no first byte state
 * a version no SDK knows (255), so the record check refuses them as
 * `version`. The named signer is only the attestation's claim: the check
 * refuses it unless it is one of the keys the caller trusts.
 */
export function recordOfAttestation(attestation: {
	attestation_data: ArrayLike<number>;
	network_signature: ArrayLike<number>;
	signer_noa_public_key: ArrayLike<number>;
}): AttestationRecord {
	const attestationData = Uint8Array.from(Array.from(attestation.attestation_data));
	return {
		attestationData,
		attestationVersion: attestationData.length === 0 ? 255 : attestationData[0],
		networkSignature: Uint8Array.from(Array.from(attestation.network_signature)),
		signerNoaPublicKey: Uint8Array.from(Array.from(attestation.signer_noa_public_key)),
	};
}

/** Throw a `version` failure unless this SDK knows `attestationVersion`. */
function requireKnownVersion(attestationVersion: number): void {
	if (!KNOWN_ATTESTATION_VERSIONS.includes(attestationVersion)) {
		throw new AttestationRecordError(
			'version',
			`attestation version ${attestationVersion} is not one this SDK knows`,
		);
	}
}

/**
 * A chain record's proof envelope, decoded: the attestation's version, the
 * network public key of the network key that signed, and the network's Ed25519
 * signature over the attestation's signing message.
 */
export interface AttestationProof {
	attestationVersion: number;
	signerNoaPublicKey: Uint8Array;
	networkSignature: Uint8Array;
}

/**
 * Decode a chain record's proof envelope, the BCS of
 * `VersionedAttestationProof` (`VersionedAttestationProofBcs`), and refuse
 * an attestation version this SDK cannot rebuild. Bytes that are not exactly
 * one V1 envelope (they do not decode, or bytes are left over) throw check
 * `record`, field `attestation_proof`. An unknown version throws check
 * `version`, before any bytes are rebuilt. The Rust
 * `decode_attestation_proof` (`ika-sdk-core`) makes the same checks.
 */
export function decodeAttestationProof(attestationProof: Uint8Array): AttestationProof {
	let decoded: typeof VersionedAttestationProofBcs.$inferType;
	try {
		decoded = VersionedAttestationProofBcs.parse(attestationProof);
	} catch (error) {
		throw new AttestationRecordError(
			'record',
			"the record's stored attestation_proof is not a proof envelope: " +
				`${error instanceof Error ? error.message : String(error)}`,
			'attestation_proof',
		);
	}
	const reserialized = VersionedAttestationProofBcs.serialize(decoded).toBytes();
	if (!equalBytes(reserialized, attestationProof) || decoded.V1 === undefined) {
		throw new AttestationRecordError(
			'record',
			"the record's stored attestation_proof is not exactly one V1 proof envelope",
			'attestation_proof',
		);
	}
	const proof = decoded.V1;
	requireKnownVersion(proof.attestation_version);
	return {
		attestationVersion: proof.attestation_version,
		signerNoaPublicKey: Uint8Array.from(proof.signer_noa_public_key),
		networkSignature: Uint8Array.from(proof.noa_signature),
	};
}

/**
 * The record the checks take for a chain record's attestation:
 * `attestationData`, the bytes the reader rebuilt from the stored fields at
 * the proof's version, with the version, the signature and the signer the
 * proof holds.
 */
export function attestationRecordOf(
	proof: AttestationProof,
	attestationData: Uint8Array,
): AttestationRecord {
	return {
		attestationData,
		attestationVersion: proof.attestationVersion,
		networkSignature: proof.networkSignature,
		signerNoaPublicKey: proof.signerNoaPublicKey,
	};
}

/** The fields of a dWallet's attestation as the rebuild writes them. */
export type DWalletAttestationFields = Parameters<
	typeof VersionedDWalletDataAttestationBcs.serialize
>[0] extends infer Input
	? Input extends { V1: infer Fields }
		? Fields
		: never
	: never;

/** The fields of an encrypted share's attestation as the rebuild writes them. */
export type EncryptedShareAttestationFields = Parameters<
	typeof VersionedEncryptedUserKeyShareAttestationBcs.serialize
>[0] extends infer Input
	? Input extends { V1: infer Fields }
		? Fields
		: never
	: never;

/** The fields of a public share's attestation as the rebuild writes them. */
export type PublicShareAttestationFields = Parameters<
	typeof VersionedPublicUserKeyShareAttestationBcs.serialize
>[0] extends infer Input
	? Input extends { V1: infer Fields }
		? Fields
		: never
	: never;

/** The fields of a partial user signature's attestation as the rebuild writes them. */
export type PartialSignatureAttestationFields = Parameters<
	typeof VersionedPartialUserSignatureAttestationBcs.serialize
>[0] extends infer Input
	? Input extends { V1: infer Fields }
		? Fields
		: never
	: never;

/**
 * Serialize `value` with `serialize`, throwing check `record` when a stored
 * field cannot be written (for example a 32-byte field of another length).
 */
function writeAttestation(name: string, serialize: () => Uint8Array): Uint8Array {
	try {
		return serialize();
	} catch (error) {
		throw new AttestationRecordError(
			'record',
			`the record's stored fields cannot be written as a ${name} attestation: ` +
				`${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * The exact bytes of a dWallet's attestation of `attestationVersion`,
 * rebuilt from its fields as a chain record stores them. Every chain's
 * reader rebuilds through this function. An unknown version throws check
 * `version` before anything is written; a field that cannot be written
 * throws check `record`. The Rust `rebuild_dwallet_attestation`
 * (`ika-sdk-core`) writes the same bytes.
 */
export function rebuildDWalletAttestation(
	attestationVersion: number,
	fields: DWalletAttestationFields,
): Uint8Array {
	requireKnownVersion(attestationVersion);
	return writeAttestation('dWallet', () =>
		VersionedDWalletDataAttestationBcs.serialize({ V1: fields }).toBytes(),
	);
}

/** The exact bytes of an encrypted share's attestation, as `rebuildDWalletAttestation`. */
export function rebuildEncryptedShareAttestation(
	attestationVersion: number,
	fields: EncryptedShareAttestationFields,
): Uint8Array {
	requireKnownVersion(attestationVersion);
	return writeAttestation('encrypted share', () =>
		VersionedEncryptedUserKeyShareAttestationBcs.serialize({ V1: fields }).toBytes(),
	);
}

/** The exact bytes of a public share's attestation, as `rebuildDWalletAttestation`. */
export function rebuildPublicShareAttestation(
	attestationVersion: number,
	fields: PublicShareAttestationFields,
): Uint8Array {
	requireKnownVersion(attestationVersion);
	return writeAttestation('public share', () =>
		VersionedPublicUserKeyShareAttestationBcs.serialize({ V1: fields }).toBytes(),
	);
}

/**
 * The exact bytes of a partial user signature's attestation from the fields
 * a future signature voucher stores, as `rebuildDWalletAttestation`.
 */
export function rebuildPartialSignatureAttestation(
	attestationVersion: number,
	fields: PartialSignatureAttestationFields,
): Uint8Array {
	requireKnownVersion(attestationVersion);
	return writeAttestation('partial-signature', () =>
		VersionedPartialUserSignatureAttestationBcs.serialize({ V1: fields }).toBytes(),
	);
}

/** `DWalletCurve` in variant order, as the attestation and the chains number it. */
export const ATTESTATION_CURVES: readonly string[] = [
	'Secp256k1',
	'Secp256r1',
	'Curve25519',
	'Ristretto',
];
const CURVES = ATTESTATION_CURVES;

/** `SignatureScheme` in variant order: Ed25519 is 0. */
export const ATTESTATION_SIGNATURE_SCHEMES: readonly string[] = [
	'Ed25519',
	'Secp256k1',
	'Secp256r1',
];
const SIGNATURE_SCHEMES = ATTESTATION_SIGNATURE_SCHEMES;

/** The epoch a migrated dWallet's attestation carries: u64::MAX, as BCS decodes it. */
export const MIGRATED_DWALLET_ATTESTATION_EPOCH = '18446744073709551615';

function requireField(field: string, holds: boolean, what: string): void {
	if (!holds) {
		throw new AttestationRecordError(
			'binding',
			`the attestation's ${field} is not the ${what} that was asked for`,
			field,
		);
	}
}

/** A dWallet's attestation, decoded, every field signed by the network. */
export type DWalletAttestation = (typeof VersionedDWalletDataAttestationBcs.$inferType)['V1'];

/** An encrypted share's attestation, decoded, every field signed by the network. */
export type EncryptedShareAttestation =
	(typeof VersionedEncryptedUserKeyShareAttestationBcs.$inferType)['V1'];

/** A public share's attestation, decoded, every field signed by the network. */
export type PublicShareAttestation =
	(typeof VersionedPublicUserKeyShareAttestationBcs.$inferType)['V1'];

/** A dWallet's attestation that passed `verifyDWalletAttestationRecord`. */
export interface VerifiedDWalletAttestation {
	/** The attestation's exact bytes, signed by one of the trusted network keys. */
	attestationData: Uint8Array;
	/** The decoded attestation: curve, public key, public output, holder and the rest. */
	attestation: DWalletAttestation;
	/**
	 * The record's network signature, which verified over `attestationData`,
	 * signed as a dWallet attestation, under the record's signer, one of the
	 * trusted network keys.
	 */
	networkSignature: Uint8Array;
	/** The record's signer: the network key that made `networkSignature`. */
	signerNoaPublicKey: Uint8Array;
}

/**
 * Check a dWallet's attestation record (`verifyAttestationRecord`, as a
 * `dwallet` kind), then require the attestation to name the dWallet that was
 * asked for: its `curve`, its `public_key`, and whether it is imported. For
 * an imported dWallet (`importedSessionIdentifier` given) its
 * `session_identifier` must be the import request's, the one in the dWallet's
 * address. Leaving `importedSessionIdentifier` out asks for a DKG dWallet, so
 * an imported dWallet's record is then refused (`is_imported_key`); it never
 * turns a check off.
 */
export function verifyDWalletAttestationRecord(
	record: AttestationRecord,
	trustedNetworkKeys: TrustedNetworkKeys,
	expected: { curve: number; publicKey: Uint8Array; importedSessionIdentifier?: Uint8Array },
): VerifiedDWalletAttestation {
	const attestation = verifyAndDecode(record, trustedNetworkKeys, 'dwallet').V1;
	requireField('curve', CURVES.indexOf(attestation.curve.$kind) === expected.curve, 'curve');
	requireField('public_key', equalBytes(attestation.public_key, expected.publicKey), 'public key');
	const imported = expected.importedSessionIdentifier !== undefined;
	requireField(
		'is_imported_key',
		attestation.is_imported_key === imported,
		imported ? 'imported dWallet' : 'DKG dWallet',
	);
	if (expected.importedSessionIdentifier !== undefined) {
		requireField(
			'session_identifier',
			equalBytes(attestation.session_identifier, expected.importedSessionIdentifier),
			"import request's session identifier",
		);
	}
	return {
		attestationData: record.attestationData,
		attestation,
		networkSignature: record.networkSignature,
		signerNoaPublicKey: record.signerNoaPublicKey,
	};
}

/**
 * Whether a share attestation was made by the request that made its dWallet:
 * the network builds a new dWallet's share attestation from the same request
 * as the dWallet's attestation (`share_attestation_of_output` in the node's
 * MPC service), so the two name the same session identifier. A share
 * attestation of another session was made by a later request on the existing
 * dWallet: a re-encryption (`ReEncryptShare`) or a make-public
 * (`MakeSharePublic`), which name their own session
 * (`existing_share_attestation_of_output`).
 */
export function isShareOfTheCreatingRequest(
	share: { session_identifier: number[] },
	dwallet: DWalletAttestation,
): boolean {
	return equalBytes(share.session_identifier, dwallet.session_identifier);
}

/**
 * Require a share attestation to be its dWallet's own: the network builds a
 * dWallet's share attestation from the same request as the dWallet's
 * attestation (`share_attestation_of_output` beside the dWallet attestation
 * in the node's MPC service), so the two name the same session identifier,
 * sender and public key. The caller then compares the fields only a first
 * share names, and last the digest (`requireDWalletAttestationDigest`), so a
 * refusal names the first field that differs.
 */
function requireSameRequest(
	share: {
		session_identifier: number[];
		intended_chain_sender: number[];
		dwallet_public_key: number[];
	},
	dwallet: VerifiedDWalletAttestation,
): void {
	requireField(
		'session_identifier',
		equalBytes(share.session_identifier, dwallet.attestation.session_identifier),
		"dWallet attestation's session identifier",
	);
	requireSameSenderAndKey(share, dwallet);
}

/**
 * Require a share attestation to name the dWallet: the dWallet's sender and
 * public key, as its attestation states them, and the digest of the
 * dWallet's attestation bytes. A share written later to an existing dWallet
 * names its own session, so the session is not compared here.
 */
function requireSameDWallet(
	share: {
		intended_chain_sender: number[];
		dwallet_public_key: number[];
		dwallet_attestation_digest: number[];
	},
	dwallet: VerifiedDWalletAttestation,
): void {
	requireSameSenderAndKey(share, dwallet);
	requireDWalletAttestationDigest(share, dwallet);
}

function requireSameSenderAndKey(
	share: {
		intended_chain_sender: number[];
		dwallet_public_key: number[];
	},
	dwallet: VerifiedDWalletAttestation,
): void {
	requireField(
		'intended_chain_sender',
		equalBytes(share.intended_chain_sender, dwallet.attestation.intended_chain_sender),
		"dWallet attestation's sender",
	);
	requireField(
		'dwallet_public_key',
		equalBytes(share.dwallet_public_key, dwallet.attestation.public_key),
		"dWallet's public key",
	);
}

/**
 * Require a share attestation to name the digest of the dWallet's
 * attestation bytes (`dwalletAttestationDigest`). The digest binds the share
 * to this very dWallet. Two imports of one key by one sender are two dWallets
 * with the same sender and public key; only their attestations, and so the
 * digests, differ.
 */
function requireDWalletAttestationDigest(
	share: { dwallet_attestation_digest: number[] },
	dwallet: VerifiedDWalletAttestation,
): void {
	requireField(
		'dwallet_attestation_digest',
		equalBytes(share.dwallet_attestation_digest, dwalletAttestationDigest(dwallet.attestationData)),
		"digest of the dWallet's attestation",
	);
}

/**
 * Check an encrypted share's attestation record (`verifyAttestationRecord`,
 * as an `encrypted_share` kind), then require it to be a share of the
 * verified `dwallet`, held by the holder that was asked for: its first share,
 * or a share re-encrypted to that holder.
 *
 * - A first share's attestation names the dWallet's session
 *   (`isShareOfTheCreatingRequest`). Every field the two attestations share
 *   must be equal: the session identifier, the sender, the public key, the
 *   encrypted share's hash, the encryption key's hash and the holder.
 * - A re-encrypted share's attestation names the re-encryption's session.
 *   Its sender and public key must be the dWallet's. Its hashes are of the new
 *   share and key, which the dWallet's attestation does not name: a record
 *   check compares the share's hash with the stored share.
 *
 * Either way the share attestation must name the digest of the dWallet's
 * attestation bytes (`dwalletAttestationDigest`), which tells apart two
 * dWallets of one key and one sender.
 *
 * Either way the holder must be the one asked for (its signer key, and its
 * scheme: Ed25519, 0, when `holderSignatureScheme` is left out). A failure is
 * check `binding`, naming the share attestation's field. The share
 * attestation names no curve; the dWallet's curve was checked with the
 * dWallet. Returns the decoded share attestation.
 */
export function verifyEncryptedShareAttestationRecord(
	record: AttestationRecord,
	trustedNetworkKeys: TrustedNetworkKeys,
	dwallet: VerifiedDWalletAttestation,
	holder: { holderSignerPublicKey: Uint8Array; holderSignatureScheme?: number },
): EncryptedShareAttestation {
	const attestation = verifyAndDecode(record, trustedNetworkKeys, 'encrypted_share').V1;
	const dwalletAttestation = dwallet.attestation;
	const askedHolder =
		SIGNATURE_SCHEMES.indexOf(attestation.holder.signature_scheme.$kind) ===
			(holder.holderSignatureScheme ?? 0) &&
		equalBytes(attestation.holder.signer_public_key, holder.holderSignerPublicKey);
	if (!isShareOfTheCreatingRequest(attestation, dwalletAttestation)) {
		requireSameDWallet(attestation, dwallet);
		requireField('holder', askedHolder, 'holder');
		return attestation;
	}
	requireSameRequest(attestation, dwallet);
	requireField(
		'encrypted_share_hash',
		dwalletAttestation.encrypted_share_hash !== null &&
			dwalletAttestation.encrypted_share_hash !== undefined &&
			equalBytes(attestation.encrypted_share_hash, dwalletAttestation.encrypted_share_hash),
		"dWallet attestation's encrypted share hash",
	);
	requireField(
		'encryption_key_hash',
		dwalletAttestation.encryption_key_hash !== null &&
			dwalletAttestation.encryption_key_hash !== undefined &&
			equalBytes(attestation.encryption_key_hash, dwalletAttestation.encryption_key_hash),
		"dWallet attestation's encryption key hash",
	);
	const dwalletHolder = dwalletAttestation.holder;
	requireField(
		'holder',
		dwalletHolder !== null &&
			dwalletHolder !== undefined &&
			attestation.holder.signature_scheme.$kind === dwalletHolder.signature_scheme.$kind &&
			equalBytes(attestation.holder.signer_public_key, dwalletHolder.signer_public_key) &&
			askedHolder,
		'holder',
	);
	requireDWalletAttestationDigest(attestation, dwallet);
	return attestation;
}

/**
 * Check a public share's attestation record (`verifyAttestationRecord`, as a
 * `public_share` kind), then require the share to be exactly the length of
 * the dWallet's curve's public share (`PUBLIC_SHARE_LENGTHS`, check
 * `length`), then require it to be the public share of the verified
 * `dwallet`:
 *
 * - made with the dWallet: the session identifier, the sender and the public
 *   key must equal the dWallet attestation's, and the dWallet attestation
 *   must name no holder (a dWallet created with a public share);
 * - or made public later (`MakeSharePublic`): the attestation names the
 *   make-public's own session, and its sender and public key must equal the
 *   dWallet attestation's. The dWallet may name a holder: its share was
 *   encrypted until it was made public.
 *
 * Either way the share attestation must name the digest of the dWallet's
 * attestation bytes (`dwalletAttestationDigest`).
 *
 * A failure is check `binding`, naming the field. Returns the decoded
 * attestation, which holds the share.
 */
export function verifyPublicShareAttestationRecord(
	record: AttestationRecord,
	trustedNetworkKeys: TrustedNetworkKeys,
	dwallet: VerifiedDWalletAttestation,
): PublicShareAttestation {
	const attestation = verifyAndDecode(
		record,
		trustedNetworkKeys,
		'public_share',
		CURVES.indexOf(dwallet.attestation.curve.$kind),
	).V1;
	if (!isShareOfTheCreatingRequest(attestation, dwallet.attestation)) {
		requireSameDWallet(attestation, dwallet);
		return attestation;
	}
	requireSameRequest(attestation, dwallet);
	requireField(
		'holder',
		dwallet.attestation.holder === null || dwallet.attestation.holder === undefined,
		'dWallet without a holder (a dWallet created with a public share)',
	);
	requireDWalletAttestationDigest(attestation, dwallet);
	return attestation;
}

/**
 * Refuse a chain record whose stored `field` does not match its signed
 * attestation, unless `holds`. The failure is check `record`, naming the
 * field. The chain packages' record checks use it, so every chain refuses a
 * stored field the same way.
 */
export function requireStoredField(field: string, holds: boolean): void {
	if (!holds) {
		throw new AttestationRecordError(
			'record',
			`the record's stored ${field} does not match its signed attestation`,
			field,
		);
	}
}

/**
 * What a chain's dWallet record stores about the dWallet apart from its
 * attestation's fields, such as a Solana dWallet account.
 * `importedSessionIdentifier` is the session identifier the record stores
 * for an imported dWallet; it is left out when the record stores none, as
 * for a DKG dWallet.
 *
 * The record's owner is not among them, because the owner can change after
 * the commit. Solana's `TransferDWallet` writes a new owner into the dWallet
 * account. The attestation's `intended_chain_sender` names the requester
 * that created the dWallet, and it never changes. So comparing the two
 * would refuse every transferred dWallet.
 */
export interface StoredDWallet {
	curve: number;
	publicKey: Uint8Array;
	isImportedKey: boolean;
	importedSessionIdentifier?: Uint8Array;
}

/**
 * Check the values a chain's dWallet record stores apart from its
 * attestation against the verified `dwallet` attestation. A contract no
 * longer compares them when it commits the dWallet, so a reader does. Each
 * difference throws check `record`, naming the stored field: `curve`,
 * `public_key`, `is_imported_key`, and `session_identifier` (an imported dWallet's record
 * must store the attestation's session identifier, and a DKG dWallet's
 * record must store none). The Rust `verify_stored_dwallet`
 * (`ika-sdk-core`) makes the same checks.
 */
export function verifyStoredDWallet(
	stored: StoredDWallet,
	dwallet: VerifiedDWalletAttestation,
): void {
	const attestation = dwallet.attestation;
	requireStoredField('curve', CURVES.indexOf(attestation.curve.$kind) === stored.curve);
	requireStoredField('public_key', equalBytes(stored.publicKey, attestation.public_key));
	requireStoredField('is_imported_key', stored.isImportedKey === attestation.is_imported_key);
	requireStoredField(
		'session_identifier',
		attestation.is_imported_key
			? stored.importedSessionIdentifier !== undefined &&
					equalBytes(stored.importedSessionIdentifier, attestation.session_identifier)
			: stored.importedSessionIdentifier === undefined,
	);
}

/**
 * Check a share attestation's `encryption_key_hash` against the holder's
 * encryption key as the chain registered it: the keccak256 of
 * `registeredEncryptionKey` must be the hash the network signed. A contract
 * no longer compares them when it commits the share, so a reader does:
 * otherwise a share could be stored encrypted to a key its holder never
 * registered. A difference throws check `record`, field
 * `encryption_key_hash`. The Rust `verify_registered_encryption_key`
 * (`ika-sdk-core`) makes the same check.
 */
export function verifyRegisteredEncryptionKey(
	share: EncryptedShareAttestation,
	registeredEncryptionKey: Uint8Array,
): void {
	requireStoredField(
		'encryption_key_hash',
		equalBytes(keccak_256(registeredEncryptionKey), share.encryption_key_hash),
	);
}

/**
 * Check the encrypted share a chain record stores against its attestation:
 * the keccak256 of `encryptedShare` must be the attestation's
 * `encrypted_share_hash`. The network signs only the hash, and a contract no
 * longer compares it with the stored ciphertext. A difference throws check
 * `record`, field `encrypted_share`. The Rust `verify_stored_encrypted_share`
 * (`ika-sdk-core`) makes the same check.
 */
export function verifyStoredEncryptedShare(
	share: EncryptedShareAttestation,
	encryptedShare: Uint8Array,
): void {
	requireStoredField(
		'encrypted_share',
		equalBytes(keccak_256(encryptedShare), share.encrypted_share_hash),
	);
}

/** `DWalletSignatureScheme` in variant order, as a voucher numbers it: EcdsaKeccak256 is 0. */
export const ATTESTATION_DWALLET_SIGNATURE_SCHEMES: readonly string[] = [
	'EcdsaKeccak256',
	'EcdsaSha256',
	'EcdsaDoubleSha256',
	'TaprootSha256',
	'EcdsaBlake2b256',
	'EddsaSha512',
	'SchnorrkelMerlin',
];

/**
 * What a future signature voucher stores about itself, apart from its
 * partial-signature attestation: its own address, and the message digest,
 * metadata digest and signature scheme (`DWalletSignatureScheme` numbering)
 * it was issued for.
 */
export interface StoredVoucher {
	address: Uint8Array;
	messageDigest: Uint8Array;
	messageMetadataDigest: Uint8Array;
	signatureScheme: number;
}

/**
 * Check the partial-signature attestation a future signature voucher
 * stores, as its fields and its decoded proof envelope. The bytes are
 * rebuilt from `fields` at the proof's version
 * (`rebuildPartialSignatureAttestation`) and checked as
 * `verifyPartialSignatureAttestationRecord` does: the version, the signer
 * among `trustedNetworkKeys`, and the signature over the rebuilt bytes.
 * Then the attestation must name the voucher it was read from: its
 * `future_signature_voucher`, `message_digest`, `message_metadata_digest`
 * and `signature_scheme` must be the voucher's, each refused as check
 * `binding` on that field. A contract no longer checks this binding when it
 * commits step 1, so a reader does. Returns the decoded attestation. The
 * Rust `verify_partial_signature_voucher_record` (`ika-sdk-core`) makes the
 * same checks.
 */
export function verifyPartialSignatureVoucherRecord(
	proof: AttestationProof,
	fields: PartialSignatureAttestationFields,
	trustedNetworkKeys: TrustedNetworkKeys,
	voucher: StoredVoucher,
): (typeof VersionedPartialUserSignatureAttestationBcs.$inferType)['V1'] {
	const rebuilt = rebuildPartialSignatureAttestation(proof.attestationVersion, fields);
	const attestation = verifyPartialSignatureAttestationRecord(
		attestationRecordOf(proof, rebuilt),
		trustedNetworkKeys,
	);
	requireField(
		'future_signature_voucher',
		equalBytes(attestation.future_signature_voucher, voucher.address),
		'voucher it was read from',
	);
	requireField(
		'message_digest',
		equalBytes(attestation.message_digest, voucher.messageDigest),
		"voucher's message digest",
	);
	requireField(
		'message_metadata_digest',
		equalBytes(attestation.message_metadata_digest, voucher.messageMetadataDigest),
		"voucher's metadata digest",
	);
	requireField(
		'signature_scheme',
		ATTESTATION_DWALLET_SIGNATURE_SCHEMES.indexOf(attestation.signature_scheme.$kind) ===
			voucher.signatureScheme,
		"voucher's signature scheme",
	);
	return attestation;
}

/**
 * Check the key an attestation names as holding the dWallet's network share
 * (`networkPubkey`, the attestation's `network_pubkey`) against
 * `expectedNetworkKeyId`, the network key the request or the client uses.
 * Every check of an attestation's `network_pubkey` in this SDK calls this
 * function, and nothing else compares that field.
 *
 * The checks, each refused as a `binding` failure on the field
 * `network_pubkey`:
 * 1. When `trustedNetworkKeys` is given, `networkPubkey` is one of its keys.
 *    The acceptance (`signDWalletShareAcceptance`) gives it: the holder signs
 *    an acceptance only of a dWallet under a key it trusts now. On mainnet
 *    and testnet that set is the keys this SDK lists. On a custom network it
 *    is the caller's keys, each read from its chain with
 *    `readAndVerifyNetworkKey`. The answer checks give none: an answer about
 *    a dWallet made under an earlier network key is accepted, and its signer
 *    is still checked under the trusted keys.
 * 2. `networkPubkey` is `expectedNetworkKeyId`. Being one of the trusted keys
 *    is not enough. After a key rotation a caller trusts two keys, and the
 *    network signs only the attestation's bytes, which do not name this key.
 *    So one faulty validator could answer with the other trusted key.
 * 3. On mainnet and testnet, `expectedNetworkKeyId` is a key this SDK lists
 *    for `network` (`listedNetworkKey`). This check runs on every call,
 *    answers included. The list keeps every network key ever deployed on the
 *    network, earlier keys included, so a key it does not hold is never
 *    legitimate there. A custom network has no list.
 *
 * The function reads nothing, so a check that runs on every answer costs no
 * chain read. The Rust `verify_attestation_network_key` (`ika-sdk-core`)
 * makes the same checks in the same order; its list check also compares the
 * key's DKG output digest with the listed one.
 */
export function verifyAttestationNetworkKey(
	networkPubkey: ArrayLike<number>,
	expectedNetworkKeyId: ArrayLike<number>,
	network: IkaNetwork,
	trustedNetworkKeys?: TrustedNetworkKeys,
): void {
	const refusal = attestationNetworkKeyRefusalIn(
		IKA_DEPLOYED_NETWORKS,
		networkPubkey,
		expectedNetworkKeyId,
		network,
		trustedNetworkKeys,
	);
	if (refusal !== undefined) {
		throw new AttestationRecordError('binding', refusal, 'network_pubkey');
	}
}

/**
 * Read the network key `noaPublicKey`'s record from its chain through
 * `reader`, and check it. Resolves the record.
 *
 * This is the read half of the check of an attestation's `network_pubkey`.
 * Call it once for each key, before trusting the key: on a custom network,
 * pass the keys it returned to `trustedNetworkKeys`. Then every check of an
 * attestation's `network_pubkey` (`verifyAttestationNetworkKey`) reads
 * nothing.
 *
 * `reader` is the chain's verified reader of a network key's record, such as
 * `createSuiNetworkEncryptionKeyReader` of `@ika.xyz/sdk-sui`. On mainnet and
 * testnet it reads only a key this SDK lists, at the address the list names.
 * On a custom network, given reads from `crossCheckedSuiReads`, it reads the
 * record through two endpoints and refuses a disagreement.
 *
 * Throws an `AttestationRecordError` on the field `network_pubkey` when
 * `network` is mainnet or testnet and the key is not listed, when the chain
 * has no record of the key, and when the record names another key. A failed
 * read throws the reader's own error.
 */
export async function readAndVerifyNetworkKey(
	reader: NetworkKeyChainReader,
	noaPublicKey: Uint8Array,
	network: IkaNetwork,
): Promise<NetworkEncryptionKeyChainRecord> {
	const key = Uint8Array.from(noaPublicKey);
	try {
		listedNetworkKey(network, key);
	} catch (error) {
		throw new AttestationRecordError(
			'binding',
			`the network key is not one this SDK lists for the network: ${
				error instanceof Error ? error.message : String(error)
			}`,
			'network_pubkey',
		);
	}
	const record = await reader.fetchNetworkEncryptionKey(Uint8Array.from(key));
	if (record === undefined) {
		throw new AttestationRecordError(
			'binding',
			'the chain has no record of the network key',
			'network_pubkey',
		);
	}
	if (!equalBytes(record.noaPublicKey, key)) {
		throw new AttestationRecordError(
			'binding',
			'the chain record read for the network key names another key',
			'network_pubkey',
		);
	}
	return { noaPublicKey: Uint8Array.from(record.noaPublicKey) };
}

/**
 * Check a presign attestation as a record (`hash`, `version`, `signer`,
 * `signature` as a `presign` attestation, then `decode`), and return the
 * decoded presign. It checks nothing about what the presign is for: the
 * answer check `verifyPresignAnswer` compares it with the request. The Rust
 * `verify_presign_attestation_record` (`ika-sdk-core`) makes the same checks.
 */
export function verifyPresignAttestationRecord(
	record: AttestationRecord,
	trustedNetworkKeys: TrustedNetworkKeys,
): (typeof VersionedPresignDataAttestationBcs.$inferType)['V1'] {
	return verifyAndDecode(record, trustedNetworkKeys, 'presign').V1;
}

/**
 * Check a partial user signature's attestation, the answer to step 1 of a
 * future sign, as a record (`hash`, `version`, `signer`, `signature` as a
 * `partial_user_signature` attestation, then `decode`), and return it
 * decoded. It checks nothing about what was signed: the answer check
 * `verifyFutureSignAnswer` compares it with the request. The Rust
 * `verify_partial_signature_attestation_record` (`ika-sdk-core`) makes the
 * same checks.
 */
export function verifyPartialSignatureAttestationRecord(
	record: AttestationRecord,
	trustedNetworkKeys: TrustedNetworkKeys,
): (typeof VersionedPartialUserSignatureAttestationBcs.$inferType)['V1'] {
	return verifyAndDecode(record, trustedNetworkKeys, 'partial_user_signature').V1;
}

/**
 * An attestation to check with `verifyAttestation`: a validator's answer,
 * which names its own `network_pubkey`, or a record read from a chain with
 * the network key the chain stores beside it (`networkPubkey`, such as the
 * `noa_public_key` of a Sui dWallet object or of a Solana dWallet account).
 */
export type AttestationToVerify =
	| {
			answer: {
				attestation_data: ArrayLike<number>;
				network_signature: ArrayLike<number>;
				network_pubkey: ArrayLike<number>;
				signer_noa_public_key: ArrayLike<number>;
			};
	  }
	| { record: AttestationRecord; networkPubkey: ArrayLike<number> };

/** An attestation that passed `verifyAttestation`, decoded, with its kind. */
export type VerifiedAttestation = {
	[K in AttestationKind]: { kind: K; attestation: NonNullable<Decoded<K>['V1']> };
}[AttestationKind];

/**
 * Check every part of one attestation of `kind`, as a validator answered it
 * or as a chain stores it, and return it decoded. The checks, in order; the
 * first that fails throws an `AttestationRecordError`:
 * 1. The key it names as holding the dWallet's network share
 *    (`network_pubkey`) is `expectedNetworkKeyId` (`verifyAttestationNetworkKey`
 *    with no trusted set, field `network_pubkey`).
 * 2. The record check: `hash`, `version`, `signer` (one of
 *    `trustedNetworkKeys`) and `signature` as `kind`.
 * 3. The bytes decode as exactly one V1 attestation of `kind` (`decode`). A
 *    public share is also checked against its dWallet's curve
 *    (`publicShareCurve`, required for that kind, `length`).
 *
 * It covers the five kinds a dWallet's requests are answered with. It checks
 * nothing about what the attestation is about: the per-kind record checks
 * and the answer checks compare it with the dWallet or the request. A
 * network key's records and a committee have their own checks
 * (`verifyNetworkKeyDkgRecord`, `verifyNetworkKeyReconfigurationRecord`,
 * `verifySignedCommittee`). The Rust `verify_attestation` (`ika-sdk-core`)
 * makes the same checks.
 */
export function verifyAttestation(
	attestation: AttestationToVerify,
	kind: AttestationKind,
	expectedNetworkKeyId: ArrayLike<number>,
	trustedNetworkKeys: TrustedNetworkKeys,
	publicShareCurve?: number,
): VerifiedAttestation {
	const { record, networkPubkey } =
		'answer' in attestation
			? {
					record: recordOfAttestation(attestation.answer),
					networkPubkey: attestation.answer.network_pubkey,
				}
			: attestation;
	verifyAttestationNetworkKey(networkPubkey, expectedNetworkKeyId, trustedNetworkKeys.network);
	const decoded = verifyAndDecode(record, trustedNetworkKeys, kind, publicShareCurve);
	return { kind, attestation: decoded.V1 } as VerifiedAttestation;
}
