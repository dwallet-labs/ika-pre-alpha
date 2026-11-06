// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The check of a network key's public outputs against the records the
 * network writes on a chain.
 *
 * A validator serves a network key's outputs (`GetNetworkKeyOutput`): the
 * network DKG output, and the latest reshare output once the key has been
 * reshared. The chain keeps the network's records of both:
 * - the key's record holds the Blake2b-256 digest of its DKG output and the
 *   network's proof over that digest;
 * - each reshare has its own record, keyed by the key and by the epoch whose
 *   committee holds the reshared shares. It holds the digest of that output
 *   and the network's proof over it.
 *
 * `verifyNetworkKeyOutput` checks the served outputs against those records,
 * through a chain-specific reader (`NetworkKeyOutputRecordReader`). The Sui
 * reader is in `@ika.xyz/sdk-sui` and the Solana reader in
 * `@ika.xyz/sdk-solana`.
 *
 * A record's proof is the BCS of `VersionedAttestationProof`: an attestation
 * version, the network key that signed, and its Ed25519 signature over the
 * record's message. The message is the 16-byte prefix `0xFE`
 * "ika-attestation", a tag byte, then the key, the epoch for a reshare
 * record, and the digest. The tag is 5 for a reshare record (89 bytes in
 * all) and 6 for a DKG record (81 bytes). The node builds the same bytes
 * (`network_key_reconfiguration_attestation_data` and
 * `network_key_dkg_attestation_data` in `ika-types`).
 * `verifyNetworkKeyRecordProof` checks one proof. Every record must carry
 * one.
 *
 * The network writes a record's proof some time after it writes the digest,
 * and writes a reshare's record some time after its validators start serving
 * the reshare output. So while the chain has no reshare record for the
 * served epoch, or a record's proof is still empty, the check reads the chain
 * again for a while (`RESHARE_RECORD_WAIT`) before it refuses. The two
 * records share that one wait.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';

import { ATTESTATION_SIGNING_PREFIX, AttestationRecordError } from './attestation-record.js';
import { VersionedAttestationProofBcs } from './bcs.js';
import type { TrustedNetworkKeys } from './deployed-networks.js';
import type { NetworkKeyOutput } from './types.js';

/** The tag byte of a reshare record's message (`AttestationKind::NetworkKeyReconfiguration`). */
export const NETWORK_KEY_RECONFIGURATION_RECORD_TAG = 5;

/** The tag byte of a DKG record's message (`AttestationKind::NetworkKeyDkg`). */
export const NETWORK_KEY_DKG_RECORD_TAG = 6;

/**
 * The digest a chain records of a network key's output: the Blake2b-256 of
 * its bytes, as the network computes it when it agrees the output
 * (`mpc_data_blob_hash` in the node).
 */
export function networkOutputDigest(output: Uint8Array): Uint8Array {
	return blake2b(output, { dkLen: 32 });
}

function requireLength(name: string, bytes: Uint8Array, length: number): void {
	if (bytes.length !== length) {
		throw new Error(`${name} is ${bytes.length} bytes, not ${length}`);
	}
}

/** The epoch as 8 bytes, little-endian, as BCS writes a `u64`. */
function u64LittleEndian(epoch: bigint): Uint8Array {
	if (epoch < 0n || epoch > 0xffff_ffff_ffff_ffffn) {
		throw new Error(`the epoch ${epoch} is not a u64`);
	}
	const bytes = new Uint8Array(8);
	new DataView(bytes.buffer).setBigUint64(0, epoch, true);
	return bytes;
}

/**
 * The message the network signs for the record of a network key's reshare:
 * the prefix, the tag 5, then the key (32 bytes), the epoch (8 bytes,
 * little-endian) and the digest (32 bytes). 89 bytes in all.
 */
export function networkKeyReconfigurationRecordMessage(
	noaPublicKey: Uint8Array,
	epoch: bigint,
	digest: Uint8Array,
): Uint8Array {
	requireLength('the network key', noaPublicKey, 32);
	requireLength('the digest', digest, 32);
	return Uint8Array.from([
		...ATTESTATION_SIGNING_PREFIX,
		NETWORK_KEY_RECONFIGURATION_RECORD_TAG,
		...noaPublicKey,
		...u64LittleEndian(epoch),
		...digest,
	]);
}

/**
 * The message the network signs for the record of a network key's DKG
 * output: the prefix, the tag 6, then the key (32 bytes) and the digest (32
 * bytes). It names no epoch, because a key has one DKG output. 81 bytes in
 * all.
 */
export function networkKeyDkgRecordMessage(
	noaPublicKey: Uint8Array,
	digest: Uint8Array,
): Uint8Array {
	requireLength('the network key', noaPublicKey, 32);
	requireLength('the digest', digest, 32);
	return Uint8Array.from([
		...ATTESTATION_SIGNING_PREFIX,
		NETWORK_KEY_DKG_RECORD_TAG,
		...noaPublicKey,
		...digest,
	]);
}

/**
 * One record of a network key's output, as a chain stores it. A reader hands
 * over the stored proof's bytes as they are and judges nothing about them.
 */
export interface NetworkKeyOutputRecord {
	/** The Blake2b-256 digest of the output (32 bytes). */
	digest: Uint8Array;
	/**
	 * The record's proof as the chain stores it: the BCS of
	 * `VersionedAttestationProof`, which carries the signer and the
	 * signature. Empty while the network has not written it yet.
	 */
	proof: Uint8Array;
}

/**
 * The chain-specific half of the check: reads of the records one chain keeps.
 * Every method rejects on a read that fails for any reason other than "no
 * such record", and resolves `undefined` (or `false`) only for that reason.
 */
export interface NetworkKeyOutputRecordReader {
	/**
	 * The record of the DKG output of the network key `noaPublicKey`: the
	 * digest the key's own record holds, with the record's proof. `undefined`
	 * when no key of that public key is registered.
	 */
	dkgRecord(noaPublicKey: Uint8Array): Promise<NetworkKeyOutputRecord | undefined>;
	/**
	 * The record of the reshare of the network key `noaPublicKey` for
	 * `epoch`, the epoch whose committee holds the reshared shares.
	 * `undefined` when the network wrote none.
	 */
	reconfigurationRecord(
		noaPublicKey: Uint8Array,
		epoch: bigint,
	): Promise<NetworkKeyOutputRecord | undefined>;
	/** Whether a network key of the public key `noaPublicKey` is registered on the chain. */
	isRegisteredNetworkKey(noaPublicKey: Uint8Array): Promise<boolean>;
}

/**
 * Which check a served output failed. `key` means the validator answered for
 * another key. `record` means the chain has no record of the output, or its
 * record holds no proof. `digest` means the output does not hash to the
 * recorded digest. `decode` means the record's proof is all zeros or is not
 * exactly one `VersionedAttestationProof`. `version` means the proof is of an
 * attestation version other than 0. `signature` means the proof's signature
 * does not verify under its signer. `signer` means the proof's signer is not
 * a network key registered on the chain.
 */
export type NetworkKeyOutputCheck =
	'key' | 'record' | 'digest' | 'decode' | 'version' | 'signer' | 'signature';

/** A served network key output that fails a check, naming the check. */
export class NetworkKeyOutputError extends Error {
	readonly check: NetworkKeyOutputCheck;

	constructor(check: NetworkKeyOutputCheck, message: string) {
		super(message);
		this.name = 'NetworkKeyOutputError';
		this.check = check;
	}
}

/** How the chain's records of a served answer are read again while one is missing or unsigned. */
export interface ReshareRecordWait {
	/** The pause between two reads, in milliseconds. */
	pauseMs: number;
	/**
	 * How long the reads and the pauses of both records may take together, in
	 * milliseconds, counted from the first read.
	 */
	budgetMs: number;
}

/**
 * The records are read every 2 seconds for up to 2 minutes. A validator
 * serves the new epoch's reshare output as soon as the epoch starts, and the
 * network writes the chain's record of it later. On the localnet in CI the
 * record came 47 to 70 seconds after the output was first served. A record's
 * proof is written one round after the network agrees its signature. The
 * Rust client waits the same way (`RESHARE_RECORD_WAIT` in `ika-sdk-core`).
 */
export const RESHARE_RECORD_WAIT: ReshareRecordWait = {
	pauseMs: 2_000,
	budgetMs: 120_000,
};

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Check a network key record's stored `proof` over the record's `message`,
 * the 81-byte DKG or 89-byte reshare message rebuilt from the record's stored
 * fields (`networkKeyDkgRecordMessage`, `networkKeyReconfigurationRecordMessage`),
 * and return the public key of the network key that signed. `what` names
 * the record in the errors. The steps, in order, each throwing an
 * `AttestationRecordError`:
 * 1. a proof whose bytes are all zero is no proof (check `decode`). It comes
 *    first, because 98 zero bytes do decode as a proof of the zero key;
 * 2. the proof must be exactly one `VersionedAttestationProof`, with no byte
 *    missing or left over and no unknown variant (`decode`);
 * 3. its `attestation_version` must be 0, the only version of the two network
 *    key record kinds (`version`);
 * 4. its Ed25519 signature must verify over `message` under the signer it
 *    names (`signature`).
 *
 * Whether the signer may sign is the caller's check: `verifyNetworkKeyOutput`
 * requires it to be registered on the chain, and the standalone checks
 * require it to be a key the caller trusts. The Rust
 * `verify_network_key_record_proof` (`ika-sdk-core`) makes the same checks in
 * the same order.
 */
export function verifyNetworkKeyRecordProof(
	what: string,
	message: Uint8Array,
	proof: Uint8Array,
): Uint8Array {
	if (proof.length !== 0 && proof.every((byte) => byte === 0)) {
		throw new AttestationRecordError(
			'decode',
			`the ${what} stores an all-zero proof, which is no proof`,
		);
	}
	let decoded: ReturnType<typeof VersionedAttestationProofBcs.parse>;
	try {
		decoded = VersionedAttestationProofBcs.parse(proof);
		if (!sameBytes(VersionedAttestationProofBcs.serialize(decoded).toBytes(), proof)) {
			throw new Error('the proof does not re-encode to its own bytes');
		}
	} catch {
		throw new AttestationRecordError(
			'decode',
			`the ${what} stores a proof that is not one VersionedAttestationProof`,
		);
	}
	const version = decoded.V1.attestation_version;
	if (version !== 0) {
		throw new AttestationRecordError(
			'version',
			`the ${what} carries a proof of attestation version ${version}; network ` +
				'key records are version 0',
		);
	}
	const signer = Uint8Array.from(decoded.V1.signer_noa_public_key);
	let verified: boolean;
	try {
		verified = ed25519.verify(Uint8Array.from(decoded.V1.noa_signature), message, signer);
	} catch {
		verified = false;
	}
	if (!verified) {
		throw new AttestationRecordError(
			'signature',
			`the signature on the ${what} does not verify under its signer ${hex(signer)}`,
		);
	}
	return signer;
}

/**
 * Check one served output against its record: the digest, then the record's
 * proof (`verifyRecordProof`). `what` names the output in the errors.
 */
async function verifyAgainstRecord(
	what: string,
	output: Uint8Array,
	record: NetworkKeyOutputRecord,
	message: (digest: Uint8Array) => Uint8Array,
	reader: NetworkKeyOutputRecordReader,
	deadline: number,
	wait: ReshareRecordWait,
): Promise<void> {
	if (!sameBytes(networkOutputDigest(output), record.digest)) {
		throw new NetworkKeyOutputError(
			'digest',
			`the ${what} the validator served does not hash to the digest the chain records`,
		);
	}
	await verifyRecordProof(what, record, message, reader, deadline, wait);
}

/**
 * Check one record's proof, in order: a proof is there, the proof itself
 * (`verifyNetworkKeyRecordProof` over `message`), and the proof's signer is a
 * network key registered on the chain. `what` names the record's output in
 * the errors.
 *
 * The read of the signer's registration may take only the time left before
 * `deadline`, the deadline every read of the check shares, in milliseconds.
 * A read still open then is no longer awaited and the check rejects, so an
 * answer that comes later is never used.
 */
async function verifyRecordProof(
	what: string,
	record: NetworkKeyOutputRecord,
	message: (digest: Uint8Array) => Uint8Array,
	reader: NetworkKeyOutputRecordReader,
	deadline: number,
	wait: ReshareRecordWait,
): Promise<void> {
	// The wait never hands over a record without a proof; refuse one that
	// arrives anyway.
	if (record.proof.length === 0) {
		throw new NetworkKeyOutputError('record', `the chain's record of the ${what} holds no proof`);
	}
	let signer: Uint8Array;
	try {
		signer = verifyNetworkKeyRecordProof(
			`record of the ${what}`,
			message(record.digest),
			record.proof,
		);
	} catch (error) {
		if (
			error instanceof AttestationRecordError &&
			(error.check === 'decode' || error.check === 'version' || error.check === 'signature')
		) {
			throw new NetworkKeyOutputError(error.check, error.message);
		}
		throw error;
	}
	const registered = await withinTimeLeft(
		reader.isRegisteredNetworkKey(signer),
		deadline - Date.now(),
		() =>
			new Error(
				`the chain did not answer the read of whether ${hex(signer)}, the signer of the record ` +
					`of the ${what}, is a registered network key within the ${wait.budgetMs} ms the ` +
					'records were read for',
			),
	);
	if (!registered) {
		throw new NetworkKeyOutputError(
			'signer',
			`the record of the ${what} is signed by ${hex(signer)}, which is not a network key ` +
				'registered on the chain',
		);
	}
}

/**
 * `read`'s value, or a rejection with `timedOut()` when `read` has not
 * settled within `timeLeftMs`. A read that settles later is ignored.
 */
async function withinTimeLeft<T>(
	read: Promise<T>,
	timeLeftMs: number,
	timedOut: () => Error,
): Promise<T> {
	// A read that rejects after the time ran out must not be an unhandled rejection.
	read.catch(() => undefined);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(timedOut()), Math.max(0, timeLeftMs));
	});
	try {
		return await Promise.race([read, deadline]);
	} finally {
		clearTimeout(timer);
	}
}

/** Which record of a network key a read is for: the DKG record, or the reshare record of `epoch`. */
type RecordKind = { kind: 'dkg' } | { kind: 'reshare'; epoch: bigint };

/**
 * The record of `kind` of the network key `networkKeyId`, once it holds a
 * proof or holds another digest than `servedDigest`, the digest of the output
 * the validator served.
 *
 * Each read and what follows it:
 * - no record: for the DKG record the key is not registered, and the read
 *   rejects at once with a `record` error. For a reshare record the network
 *   has not written it yet, and the record is read again;
 * - a record of another digest is returned at once, and the check that
 *   follows refuses it. A digest is written once, so no later read can change
 *   it;
 * - a record whose proof is empty is not signed yet, and is read again;
 * - a record with a proof is returned.
 *
 * A record is read again every `wait.pauseMs` until `deadline`, a time in
 * milliseconds the caller sets once for every record of one answer; then the
 * read rejects with a `record` error. Each read may take only the time left
 * before `deadline`. A read still open at that time is no longer awaited, and
 * the wait rejects, so the wait never runs past `deadline`. A read that
 * rejects ends the wait.
 */
async function recordOnceSigned(
	reader: NetworkKeyOutputRecordReader,
	networkKeyId: Uint8Array,
	kind: RecordKind,
	servedDigest: Uint8Array,
	deadline: number,
	wait: ReshareRecordWait,
): Promise<NetworkKeyOutputRecord> {
	const key = hex(networkKeyId);
	const name =
		kind.kind === 'dkg'
			? `record of the DKG output of the network key ${key}`
			: `record of the reshare of the network key ${key} for epoch ${kind.epoch}`;
	for (;;) {
		const record = await withinTimeLeft(
			kind.kind === 'dkg'
				? reader.dkgRecord(networkKeyId)
				: reader.reconfigurationRecord(networkKeyId, kind.epoch),
			deadline - Date.now(),
			() =>
				new Error(
					`the chain did not answer the read of the ${name} within the ${wait.budgetMs} ms ` +
						'the records were read for',
				),
		);
		if (record === undefined && kind.kind === 'dkg') {
			throw new NetworkKeyOutputError('record', `no network key ${key} is registered on the chain`);
		}
		if (
			record !== undefined &&
			(!sameBytes(record.digest, servedDigest) || record.proof.length !== 0)
		) {
			return record;
		}
		if (Date.now() + wait.pauseMs > deadline) {
			throw new NetworkKeyOutputError(
				'record',
				record === undefined
					? `the chain has no ${name}, and none was written in the ${wait.budgetMs} ms the ` +
							'records were read for'
					: `the chain's ${name} holds no proof yet, and none was written in the ` +
							`${wait.budgetMs} ms the records were read for`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, wait.pauseMs));
	}
}

/**
 * Check what a validator served for the network key `networkKeyId` (its
 * Ed25519 public key) against the records on one chain, and return the
 * served value once every check passes.
 *
 * Every check fails closed, with a `NetworkKeyOutputError`:
 * - the answer must name `networkKeyId`;
 * - the key must be registered, and the DKG output must hash to the digest
 *   its record holds;
 * - when the answer carries a reshare output, the chain must hold the record
 *   of the key's reshare for the answer's `epoch`, and the output must hash to
 *   its digest. The answer's `epoch` is the epoch of the key's latest output,
 *   which is the epoch whose committee holds the reshared shares, the epoch
 *   the record is keyed by;
 * - each record must carry the network's proof, which must pass
 *   `verifyNetworkKeyRecordProof` over the record's message, and the proof's
 *   signer must be a network key registered on the chain.
 *
 * While the chain has no reshare record for the answer's `epoch`, or a
 * record's proof is empty, the record is read again every 2 seconds. Both
 * records share one deadline, 2 minutes after the check starts (`wait`, by
 * default `RESHARE_RECORD_WAIT`), and the check fails if a record is still
 * missing or unsigned then. A missing DKG record, or a record that holds
 * another digest, fails the check at once.
 *
 * `networkKeyId` is the key the caller trusts, never one taken from the
 * answer.
 *
 * The check proves that a key registered on the chain signed each record. How
 * far "registered" can be trusted depends on the reader: on mainnet and
 * testnet the SDK's own list of keys fixes it, and on a custom network with a
 * second endpoint both endpoints must agree. On a custom network with one
 * endpoint, a lying endpoint can invent a key, register it and sign with it.
 */
export async function verifyNetworkKeyOutput(
	served: NetworkKeyOutput,
	networkKeyId: Uint8Array,
	reader: NetworkKeyOutputRecordReader,
	wait: ReshareRecordWait = RESHARE_RECORD_WAIT,
): Promise<NetworkKeyOutput> {
	if (!sameBytes(served.networkKeyId, networkKeyId)) {
		throw new NetworkKeyOutputError(
			'key',
			`the validator answered for the network key ${hex(served.networkKeyId)}, not for ` +
				hex(networkKeyId),
		);
	}
	const deadline = Date.now() + wait.budgetMs;
	const dkgRecord = await recordOnceSigned(
		reader,
		networkKeyId,
		{ kind: 'dkg' },
		networkOutputDigest(served.networkDkgOutput),
		deadline,
		wait,
	);
	await verifyAgainstRecord(
		'network DKG output',
		served.networkDkgOutput,
		dkgRecord,
		(digest) => networkKeyDkgRecordMessage(networkKeyId, digest),
		reader,
		deadline,
		wait,
	);
	if (served.latestReconfigurationOutput !== undefined) {
		const reconfigurationRecord = await recordOnceSigned(
			reader,
			networkKeyId,
			{ kind: 'reshare', epoch: served.epoch },
			networkOutputDigest(served.latestReconfigurationOutput),
			deadline,
			wait,
		);
		await verifyAgainstRecord(
			`reshare output for epoch ${served.epoch}`,
			served.latestReconfigurationOutput,
			reconfigurationRecord,
			(digest) => networkKeyReconfigurationRecordMessage(networkKeyId, served.epoch, digest),
			reader,
			deadline,
			wait,
		);
	}
	return served;
}

/**
 * Check that the chain's record of the network key `noaPublicKey`'s DKG
 * output holds `dkgOutputDigest` and carries the network's proof, signed by a
 * network key registered on the chain, throwing a `NetworkKeyOutputError`
 * otherwise. It is the DKG record's half of `verifyNetworkKeyOutput`, for a
 * read of a key's trust anchor, which has the digest but no served output:
 * `createSuiNetworkEncryptionKeyReader` of `@ika.xyz/sdk-sui` runs it on the
 * digest it reads. The Rust `verify_signed_dkg_record` (`ika-sdk-core`) makes
 * the same checks.
 *
 * While the record's proof is empty, the record is read again every 2 seconds
 * for up to 2 minutes (`wait`, by default `RESHARE_RECORD_WAIT`), and the
 * check fails if it is still unsigned then. A missing record, or a record of
 * another digest, fails at once.
 */
export async function verifySignedDkgRecord(
	reader: NetworkKeyOutputRecordReader,
	noaPublicKey: Uint8Array,
	dkgOutputDigest: Uint8Array,
	wait: ReshareRecordWait = RESHARE_RECORD_WAIT,
): Promise<void> {
	const deadline = Date.now() + wait.budgetMs;
	const record = await recordOnceSigned(
		reader,
		noaPublicKey,
		{ kind: 'dkg' },
		dkgOutputDigest,
		deadline,
		wait,
	);
	if (!sameBytes(record.digest, dkgOutputDigest)) {
		throw new NetworkKeyOutputError(
			'digest',
			`the chain's record of the DKG output of the network key ${hex(noaPublicKey)} holds ` +
				'another digest than the one read for the key',
		);
	}
	await verifyRecordProof(
		'network DKG output',
		record,
		(digest) => networkKeyDkgRecordMessage(noaPublicKey, digest),
		reader,
		deadline,
		wait,
	);
}

/**
 * Check one record's proof with `verifyNetworkKeyRecordProof`, then require
 * its signer to be one of `trustedNetworkKeys` (check `signer`).
 */
function verifyTrustedRecordProof(
	what: string,
	message: Uint8Array,
	proof: Uint8Array,
	trustedNetworkKeys: TrustedNetworkKeys,
): void {
	const signer = verifyNetworkKeyRecordProof(what, message, proof);
	if (!trustedNetworkKeys.publicKeys.some((key) => sameBytes(key, signer))) {
		throw new AttestationRecordError(
			'signer',
			`the ${what} is signed by ${hex(signer)}, which is not a network key the caller trusts`,
		);
	}
}

/**
 * Check the network's proof on the record of the network key
 * `noaPublicKey`'s DKG output, whose digest is `digest`: the proof must pass
 * `verifyNetworkKeyRecordProof` over the record's message
 * (`networkKeyDkgRecordMessage`), and its signer must be one of
 * `trustedNetworkKeys` (check `signer`). Throws an `AttestationRecordError`
 * otherwise.
 *
 * It checks the record alone, with no served output and no chain read.
 * `verifyNetworkKeyOutput` checks served outputs against a chain's records.
 * The Rust `verify_network_key_dkg_record` (`ika-sdk-core`) makes the same
 * checks.
 */
export function verifyNetworkKeyDkgRecord(
	noaPublicKey: Uint8Array,
	digest: Uint8Array,
	proof: Uint8Array,
	trustedNetworkKeys: TrustedNetworkKeys,
): void {
	verifyTrustedRecordProof(
		'record of the network DKG output',
		networkKeyDkgRecordMessage(noaPublicKey, digest),
		proof,
		trustedNetworkKeys,
	);
}

/**
 * Check the network's proof on the record of the network key
 * `noaPublicKey`'s reshare for `epoch`, the epoch whose committee holds the
 * reshared shares, whose digest is `digest`: the proof must pass
 * `verifyNetworkKeyRecordProof` over the record's message
 * (`networkKeyReconfigurationRecordMessage`), and its signer must be one of
 * `trustedNetworkKeys` (check `signer`). Throws an `AttestationRecordError`
 * otherwise.
 *
 * The Rust `verify_network_key_reconfiguration_record` (`ika-sdk-core`)
 * makes the same checks.
 */
export function verifyNetworkKeyReconfigurationRecord(
	noaPublicKey: Uint8Array,
	epoch: bigint,
	digest: Uint8Array,
	proof: Uint8Array,
	trustedNetworkKeys: TrustedNetworkKeys,
): void {
	verifyTrustedRecordProof(
		'record of the reshare output',
		networkKeyReconfigurationRecordMessage(noaPublicKey, epoch, digest),
		proof,
		trustedNetworkKeys,
	);
}
