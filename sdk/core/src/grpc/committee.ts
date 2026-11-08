// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The committee a client trusts, checked against the client's own chain.
 *
 * The network signs each epoch's committee with its network key. It signs
 * the attestation `VersionedCommitteeAttestation::V1 { epoch, members_digest }`
 * as the attestation kind `Committee`, tag 7. Any validator serves the signed
 * committee of its epoch, and of the next epoch once that one is signed
 * (`GetCommittee`). So a client learns the committee from any validator and
 * trusts none of them. `verifyCommitteeAnswer` checks an answer:
 * - it decodes each attestation strictly, verifies the signature over it,
 *   and checks that the served members hash to the signed digest and decode
 *   strictly (`verifySignedCommittee`);
 * - the signer must be a network key registered on the client's chain, as a
 *   reshare record's signer must;
 * - the signed epoch must be the chain's current epoch or the one after.
 *
 * The epoch check is what refuses an old committee. Every signed committee
 * stays valid forever, so a former member could serve the committee it was
 * in. That committee's epoch is below the chain's, and it is refused.
 *
 * The chain's half of the check is a `CommitteeChainReader`:
 * `createSuiCommitteeReader` of `@ika.xyz/sdk-sui` reads the `ika_protocol`
 * coordinator's epoch, and `solanaCommitteeReader` of `@ika.xyz/pre-alpha-solana`
 * reads the program's `SystemState.epoch`.
 *
 * The bytes and the rules are those of the node and of the Rust client
 * (`SignedCommittee::verify` in ika-types, `verify_committee_answer` in
 * ika-sdk-core). Nothing here needs Node.
 */
import { bcs } from '@mysten/bcs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';

import { ATTESTATION_SIGNING_PREFIX } from './attestation-record.js';

/** The server name a validator's network-key certificate is made for. */
export const IKA_DWALLET_GRPC_SERVER_NAME = 'ika-dwallet-grpc';

/** The tag byte of a committee's signed message (`AttestationKind::Committee`). */
export const COMMITTEE_ATTESTATION_TAG = 7;

/**
 * The length of a committee attestation's bytes: one byte of variant index,
 * eight of epoch and 32 of members' digest.
 */
export const COMMITTEE_ATTESTATION_LENGTH = 41;

/**
 * One member of a committee, as BCS writes it: its 32-byte Ed25519 consensus
 * key, the member's id, then its 32-byte Ed25519 network key, the key its TLS
 * certificate is made from. Field order is wire format.
 */
export const CommitteeMemberBcs = bcs.struct('CommitteeMember', {
	consensus_pubkey: bcs.fixedArray(32, bcs.u8()),
	network_pubkey: bcs.fixedArray(32, bcs.u8()),
});

/**
 * A committee's member list, `Vec<CommitteeMember>`: the member count as
 * ULEB128, then each member's 64 bytes. The list is sorted strictly ascending
 * by consensus key, has no repeated member, and is not empty.
 */
export const CommitteeMembersBcs = bcs.vector(CommitteeMemberBcs);

/** One member of a verified committee. */
export interface CommitteeMember {
	/** The member's Ed25519 consensus key (32 bytes). */
	consensusPubkey: Uint8Array;
	/** The member's Ed25519 network key (32 bytes). */
	networkPubkey: Uint8Array;
}

/** A committee attestation, decoded. */
export interface CommitteeAttestation {
	/** The epoch the committee serves. */
	epoch: bigint;
	/** The Blake2b-256 of the BCS bytes of the committee's member list. */
	membersDigest: Uint8Array;
}

/**
 * A committee with the network's signature, as a validator serves it.
 * `members` is the member list's BCS bytes and `attestation` the BCS bytes of
 * the attestation. The signature is Ed25519, under `signerNoaPublicKey`, over
 * the attestation's signing message (`committeeSigningMessage`).
 */
export interface SignedCommittee {
	members: Uint8Array;
	attestation: Uint8Array;
	signerNoaPublicKey: Uint8Array;
	signature: Uint8Array;
}

/** A committee whose signature and members passed `verifySignedCommittee`. */
export interface VerifiedCommittee {
	/** The epoch the committee serves, from the signed attestation. */
	epoch: bigint;
	/** The members, sorted strictly ascending by consensus key. */
	members: CommitteeMember[];
}

/** A `GetCommittee` answer: the committee of the validator's epoch, and the next one once signed. */
export interface CommitteeAnswer {
	committee?: SignedCommittee;
	nextCommittee?: SignedCommittee;
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** -1, 0 or 1 as `left` sorts before, equal to or after `right`, byte by byte. */
function compareBytes(left: Uint8Array, right: Uint8Array): number {
	const index = left.findIndex((byte, position) => byte !== right[position]);
	if (index < 0) {
		return left.length - right.length;
	}
	return left[index] < right[index] ? -1 : 1;
}

/** The members' digest of a committee: the Blake2b-256 of its member list's BCS bytes. */
export function committeeMembersDigest(members: Uint8Array): Uint8Array {
	return blake2b(members, { dkLen: 32 });
}

/**
 * The message the network signs for a committee: the attestation prefix, the
 * tag 7, then the attestation's bytes. 58 bytes for a valid attestation.
 */
export function committeeSigningMessage(attestation: Uint8Array): Uint8Array {
	return Uint8Array.from([
		...ATTESTATION_SIGNING_PREFIX,
		COMMITTEE_ATTESTATION_TAG,
		...attestation,
	]);
}

/**
 * Decode a committee attestation strictly. The variant is read first, and an
 * unknown one is refused before anything else is read. Then any length but
 * 41 bytes is refused.
 */
export function decodeCommitteeAttestation(bytes: Uint8Array): CommitteeAttestation {
	if (bytes.length === 0) {
		throw new Error('the committee attestation is empty');
	}
	if (bytes[0] !== 0) {
		throw new Error(`the committee attestation has an unknown variant ${bytes[0]}`);
	}
	if (bytes.length !== COMMITTEE_ATTESTATION_LENGTH) {
		throw new Error(
			`the committee attestation is ${bytes.length} bytes, not ${COMMITTEE_ATTESTATION_LENGTH}`,
		);
	}
	return {
		epoch: new DataView(bytes.buffer, bytes.byteOffset + 1, 8).getBigUint64(0, true),
		membersDigest: bytes.slice(9, 41),
	};
}

/** The BCS bytes of the `V1` attestation of `attestation`. */
export function encodeCommitteeAttestation(attestation: CommitteeAttestation): Uint8Array {
	if (attestation.membersDigest.length !== 32) {
		throw new Error(`the members' digest is ${attestation.membersDigest.length} bytes, not 32`);
	}
	if (attestation.epoch < 0n || attestation.epoch > 0xffff_ffff_ffff_ffffn) {
		throw new Error(`the epoch ${attestation.epoch} is not a u64`);
	}
	const bytes = new Uint8Array(COMMITTEE_ATTESTATION_LENGTH);
	new DataView(bytes.buffer).setBigUint64(1, attestation.epoch, true);
	bytes.set(attestation.membersDigest, 9);
	return bytes;
}

/**
 * Decode a committee's member list strictly, from the bytes a validator
 * served, against the members' digest the network signed. Refuses bytes whose
 * digest is not `membersDigest`, then bytes that do not decode or have
 * trailing bytes, an empty list, and members not in strictly ascending order
 * of consensus key. After these checks one committee has exactly one byte
 * string.
 */
export function decodeCommitteeMembers(
	members: Uint8Array,
	membersDigest: Uint8Array,
): CommitteeMember[] {
	if (!sameBytes(committeeMembersDigest(members), membersDigest)) {
		throw new Error('the members do not hash to the signed digest');
	}
	let decoded: Array<{ consensus_pubkey: number[]; network_pubkey: number[] }>;
	try {
		decoded = CommitteeMembersBcs.parse(members);
	} catch (error) {
		throw new Error(
			`the committee's members do not decode: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
	// BCS is canonical, so bytes that decode and serialize back to themselves
	// have no trailing bytes and no long form of the member count.
	if (!sameBytes(CommitteeMembersBcs.serialize(decoded).toBytes(), members)) {
		throw new Error("the committee's members do not decode: they have trailing bytes");
	}
	const list = decoded.map((member) => ({
		consensusPubkey: Uint8Array.from(member.consensus_pubkey),
		networkPubkey: Uint8Array.from(member.network_pubkey),
	}));
	if (list.length === 0) {
		throw new Error('the committee has no members');
	}
	if (
		!list.every(
			(member, index) =>
				index === 0 || compareBytes(list[index - 1].consensusPubkey, member.consensusPubkey) < 0,
		)
	) {
		throw new Error("the committee's members are not in strictly ascending order of consensus key");
	}
	return list;
}

/**
 * A committee before the network signs it: the member list's BCS bytes and
 * the attestation over them, for the committee of `epoch` with `members`.
 * The members are sorted by consensus key, so the order they are given in
 * changes no byte. A member listed twice and an empty list are refused. This
 * is the node's `UnsignedCommittee::new`.
 */
export function unsignedCommittee(
	epoch: bigint,
	members: CommitteeMember[],
): { members: Uint8Array; attestation: Uint8Array } {
	const sorted = [...members].sort((left, right) =>
		compareBytes(left.consensusPubkey, right.consensusPubkey),
	);
	const repeated = sorted.find(
		(member, index) =>
			index > 0 && sameBytes(sorted[index - 1].consensusPubkey, member.consensusPubkey),
	);
	if (repeated !== undefined) {
		throw new Error(`the committee lists ${hex(repeated.consensusPubkey)} twice`);
	}
	if (sorted.length === 0) {
		throw new Error('the committee has no members');
	}
	const memberBytes = CommitteeMembersBcs.serialize(
		sorted.map((member) => ({
			consensus_pubkey: Array.from(member.consensusPubkey),
			network_pubkey: Array.from(member.networkPubkey),
		})),
	).toBytes();
	return {
		members: memberBytes,
		attestation: encodeCommitteeAttestation({
			epoch,
			membersDigest: committeeMembersDigest(memberBytes),
		}),
	};
}

/**
 * Check a signed committee as a client receives it: refuse a signer that is
 * not 32 bytes and a signature that is not 64, decode the attestation
 * strictly, verify the signature over the committee's signing message, then
 * check that the members hash to the signed digest and decode strictly.
 * `which` names the committee in the errors.
 *
 * This proves only that `signerNoaPublicKey` signed this committee. The
 * caller must still check that the signer is a network key registered on
 * its chain, and that the epoch is fresh (`verifyCommitteeAnswer`).
 */
export function verifySignedCommittee(
	signed: SignedCommittee,
	which = 'committee',
): VerifiedCommittee {
	if (signed.signerNoaPublicKey.length !== 32) {
		throw new Error(
			`the ${which} names a signer of ${signed.signerNoaPublicKey.length} bytes, not 32`,
		);
	}
	if (signed.signature.length !== 64) {
		throw new Error(`the ${which} carries a signature of ${signed.signature.length} bytes, not 64`);
	}
	const refused = (reason: string) => new Error(`the ${which} is refused: ${reason}`);
	let attestation: CommitteeAttestation;
	try {
		attestation = decodeCommitteeAttestation(signed.attestation);
	} catch (error) {
		throw refused(error instanceof Error ? error.message : String(error));
	}
	let verified: boolean;
	try {
		verified = ed25519.verify(
			signed.signature,
			committeeSigningMessage(signed.attestation),
			signed.signerNoaPublicKey,
		);
	} catch {
		verified = false;
	}
	if (!verified) {
		throw refused(
			`the committee's signature does not verify under its signer ${hex(signed.signerNoaPublicKey)}`,
		);
	}
	let members: CommitteeMember[];
	try {
		members = decodeCommitteeMembers(signed.members, attestation.membersDigest);
	} catch (error) {
		throw refused(error instanceof Error ? error.message : String(error));
	}
	return { epoch: attestation.epoch, members };
}

/**
 * The reads of the client's own chain that a committee is checked against.
 * Every read rejects on an error, and answers `false` only when the chain
 * shows no such key.
 */
export interface CommitteeChainReader {
	/**
	 * The chain's current epoch: on Sui the `ika_protocol` coordinator's
	 * epoch, and on Solana the program's `SystemState.epoch`.
	 */
	currentEpoch(): Promise<bigint>;
	/** Whether a network key of the network public key `noaPublicKey` is registered on the chain. */
	isRegisteredNetworkKey(noaPublicKey: Uint8Array): Promise<boolean>;
}

/**
 * How the chain's epoch is read again while a validator answers a committee
 * more than one epoch ahead of it.
 */
export interface ChainEpochRetry {
	/** The pause between two reads, in milliseconds. */
	pauseMs: number;
	/** How long the reads and the pauses may take together, in milliseconds. */
	budgetMs: number;
}

/**
 * The chain's epoch is read every 5 seconds for up to 60 seconds, as the read
 * of the epoch's network keys is retried. On Sui the coordinator's epoch
 * moves through the network's settlement, one step at a time, so it can show
 * the epoch before the validators' for a while.
 */
export const CHAIN_EPOCH_RETRY: ChainEpochRetry = { pauseMs: 5_000, budgetMs: 60_000 };

/** Where a committee's signed epoch stands against the chain's epoch. */
type EpochStanding = 'old' | 'fresh' | 'ahead';

/**
 * Where `epoch` stands against the chain's epoch `chainEpoch`: below it is
 * old, it or the one after is fresh, and further is ahead.
 */
function epochStanding(epoch: bigint, chainEpoch: bigint): EpochStanding {
	if (epoch < chainEpoch) {
		return 'old';
	}
	return epoch - chainEpoch <= 1n ? 'fresh' : 'ahead';
}

/**
 * Check one served committee except for its epoch: `verifySignedCommittee`,
 * then the signer's registration on the chain `reader` reads.
 */
async function verifyCommitteeSigner(
	signed: SignedCommittee,
	which: string,
	reader: CommitteeChainReader,
): Promise<VerifiedCommittee> {
	const verified = verifySignedCommittee(signed, which);
	if (!(await reader.isRegisteredNetworkKey(signed.signerNoaPublicKey))) {
		throw new Error(
			`the ${which} is signed by ${hex(signed.signerNoaPublicKey)}, which is not a network key ` +
				'registered on the chain',
		);
	}
	return verified;
}

/**
 * Read the chain's epoch until the committee of `epoch` is fresh against it,
 * and return the chain's epoch then.
 *
 * An old committee is refused at once. A committee more than one epoch ahead
 * of the chain is the chain lagging the network: the chain's epoch is read
 * again every `retry.pauseMs`, until `retry.budgetMs` has passed. The window
 * is never widened, because it is what refuses a former member.
 */
async function freshChainEpoch(
	epoch: bigint,
	reader: CommitteeChainReader,
	retry: ChainEpochRetry,
): Promise<bigint> {
	const budgetEnd = Date.now() + retry.budgetMs;
	for (;;) {
		const chainEpoch = await reader.currentEpoch();
		const standing = epochStanding(epoch, chainEpoch);
		if (standing === 'fresh') {
			return chainEpoch;
		}
		if (standing === 'old') {
			throw new Error(
				`the validator answered the committee of epoch ${epoch}, older than the chain's ` +
					`epoch ${chainEpoch}`,
			);
		}
		if (Date.now() + retry.pauseMs > budgetEnd) {
			throw new Error(
				`the validator answered the committee of epoch ${epoch}, more than one epoch after ` +
					`the chain's epoch ${chainEpoch}, and the chain did not catch up in ${retry.budgetMs} ms`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, retry.pauseMs));
	}
}

/** A `GetCommittee` answer that passed every check. */
export interface VerifiedCommittees {
	/** The chain's epoch the committees were checked against. */
	chainEpoch: bigint;
	/** The committee of the answering validator's epoch. */
	committee: VerifiedCommittee;
	/**
	 * The committee after it, when the validator served it signed, it serves
	 * the epoch right after `committee`'s, and that epoch is at most one after
	 * the chain's. A next committee further ahead is left out, not refused.
	 */
	nextCommittee?: VerifiedCommittee;
}

/**
 * Check a validator's `GetCommittee` answer against the chain `reader` reads.
 *
 * Both committees are checked the same way: the strict decode, the
 * signature, the members against the signed digest, and the signer's
 * registration. A next committee that fails any of these makes the whole
 * answer fail. The current committee's epoch must then be the chain's epoch
 * or the one after; one further ahead makes the chain be read again, by
 * `retry`. The next committee is kept only when its epoch is the current
 * committee's plus one and at most one after the chain's.
 */
export async function verifyCommitteeAnswer(
	answer: CommitteeAnswer,
	reader: CommitteeChainReader,
	retry: ChainEpochRetry = CHAIN_EPOCH_RETRY,
): Promise<VerifiedCommittees> {
	if (answer.committee === undefined) {
		throw new Error('the validator answered no committee');
	}
	const committee = await verifyCommitteeSigner(answer.committee, 'committee', reader);
	const nextCommittee =
		answer.nextCommittee === undefined
			? undefined
			: await verifyCommitteeSigner(answer.nextCommittee, 'next committee', reader);
	const chainEpoch = await freshChainEpoch(committee.epoch, reader, retry);
	const keepNext =
		nextCommittee !== undefined &&
		nextCommittee.epoch === committee.epoch + 1n &&
		epochStanding(nextCommittee.epoch, chainEpoch) === 'fresh';
	return { chainEpoch, committee, nextCommittee: keepNext ? nextCommittee : undefined };
}

/**
 * The network keys of the members of every committee a client verified and
 * still holds fresh, by the epoch each committee serves. A transport's pinned
 * TLS connection accepts a certificate made from any of them.
 */
export class VerifiedMembers {
	private readonly networkKeysByEpoch = new Map<bigint, Uint8Array[]>();

	/**
	 * Add the committees of `verified`, and drop every committee older than
	 * the chain's epoch they were checked against.
	 */
	add(verified: VerifiedCommittees): void {
		[verified.committee, ...(verified.nextCommittee ? [verified.nextCommittee] : [])].forEach(
			(committee) =>
				this.networkKeysByEpoch.set(
					committee.epoch,
					committee.members.map((member) => member.networkPubkey),
				),
		);
		this.dropOlderThan(verified.chainEpoch);
	}

	/**
	 * Drop every committee older than `chainEpoch`, a chain epoch read since
	 * the committees were added. A committee below the chain's epoch is
	 * stale: a former member could serve it.
	 */
	dropOlderThan(chainEpoch: bigint): void {
		[...this.networkKeysByEpoch.keys()]
			.filter((epoch) => epoch < chainEpoch)
			.forEach((epoch) => this.networkKeysByEpoch.delete(epoch));
	}

	/** Whether `networkKey` is the network key of a member of a committee held here. */
	contains(networkKey: Uint8Array): boolean {
		return [...this.networkKeysByEpoch.values()].some((networkKeys) =>
			networkKeys.some((key) => sameBytes(key, networkKey)),
		);
	}
}
