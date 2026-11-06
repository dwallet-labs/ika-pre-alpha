// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The client's check of the committee the network signs.
 *
 * The pinned bytes are the design's conformance vectors, shared with the
 * node's tests in ika-types (`committee_member_bytes_are_pinned`,
 * `committee_attestation_bytes_are_pinned`, `a_committee_signature_verifies_as_its_kind`).
 * The committee serves epoch 7 and has two members: member A with consensus
 * key `11` repeated 32 times and network key `22` repeated, member B with
 * `33` and `44`. The signer is the ordinary Ed25519 key of seed `01`
 * repeated 32 times, never a real network key.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';

import type { CommitteeChainReader, SignedCommittee } from '../../src/grpc/committee';
import {
	CommitteeMembersBcs,
	committeeMembersDigest,
	committeeSigningMessage,
	decodeCommitteeAttestation,
	decodeCommitteeMembers,
	unsignedCommittee,
	VerifiedMembers,
	verifyCommitteeAnswer,
	verifySignedCommittee,
} from '../../src/grpc/committee';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const fromHex = (text: string) => new Uint8Array(Buffer.from(text, 'hex'));
const filled = (byte: number) => new Uint8Array(32).fill(byte);

const VECTOR_MEMBERS = '02' + '11'.repeat(32) + '22'.repeat(32) + '33'.repeat(32) + '44'.repeat(32);
const VECTOR_MEMBERS_DIGEST = 'fd9dabee904f829fb06c70d8549fd9f3600c044264eac3e028d95654ce7a2499';
const VECTOR_ATTESTATION = `000700000000000000${VECTOR_MEMBERS_DIGEST}`;
const VECTOR_MESSAGE = `fe696b612d6174746573746174696f6e07${VECTOR_ATTESTATION}`;
const VECTOR_SIGNER_SEED = new Uint8Array(32).fill(0x01);
const VECTOR_SIGNER = '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c';
const VECTOR_SIGNATURE =
	'2d2a8964f88fde8998a153cb96a306092627d299111e8e1cf91592235314a696' +
	'5b38476fff243d9d88169c5cf784cccbb4664ed9fc686375ffb3909662ae8a02';

const MEMBER_A = { consensusPubkey: filled(0x11), networkPubkey: filled(0x22) };
const MEMBER_B = { consensusPubkey: filled(0x33), networkPubkey: filled(0x44) };

/** The committee of `epoch` with `members`, signed by the key of `seed`. */
function signedBy(
	seed: Uint8Array,
	epoch: bigint,
	members: Array<{ consensusPubkey: Uint8Array; networkPubkey: Uint8Array }>,
): SignedCommittee {
	const committee = unsignedCommittee(epoch, members);
	return {
		members: committee.members,
		attestation: committee.attestation,
		signerNoaPublicKey: ed25519.getPublicKey(seed),
		signature: ed25519.sign(committeeSigningMessage(committee.attestation), seed),
	};
}

/** The vector committee, signed by the vector's key. */
function vectorCommittee(): SignedCommittee {
	return signedBy(VECTOR_SIGNER_SEED, 7n, [MEMBER_A, MEMBER_B]);
}

/** A committee of `epoch` whose one member has the network key `networkKey`. */
function committeeOf(epoch: bigint, networkKey: Uint8Array, seed = VECTOR_SIGNER_SEED) {
	return signedBy(seed, epoch, [{ consensusPubkey: filled(0x10), networkPubkey: networkKey }]);
}

/**
 * A chain that shows the epochs of `epochs`, one per read and the last one
 * from then on, and registers the keys of `registered`.
 */
function scriptedChain(
	epochs: bigint[],
	registered: Uint8Array[] = [fromHex(VECTOR_SIGNER)],
): CommitteeChainReader & { epochReads: number } {
	const chain = {
		epochReads: 0,
		async currentEpoch() {
			chain.epochReads += 1;
			return epochs.length > 1 ? epochs.shift()! : epochs[0];
		},
		async isRegisteredNetworkKey(noaPublicKey: Uint8Array) {
			return registered.some((key) => hex(key) === hex(noaPublicKey));
		},
	};
	return chain;
}

/** The chain's epoch read again every 10 ms for up to 200 ms. */
const SHORT_RETRY = { pauseMs: 10, budgetMs: 200 };

const MEMBER = filled(0xa1);
const NEXT_MEMBER = filled(0xa2);

describe('the committee vector', () => {
	it('pins the member list bytes and their digest', () => {
		const committee = unsignedCommittee(7n, [MEMBER_A, MEMBER_B]);
		expect(committee.members.length).toBe(129);
		expect(hex(committee.members)).toBe(VECTOR_MEMBERS);
		expect(hex(committeeMembersDigest(committee.members))).toBe(VECTOR_MEMBERS_DIGEST);
	});

	it('pins the attestation bytes and the signed message', () => {
		const committee = unsignedCommittee(7n, [MEMBER_A, MEMBER_B]);
		expect(committee.attestation.length).toBe(41);
		expect(hex(committee.attestation)).toBe(VECTOR_ATTESTATION);
		const message = committeeSigningMessage(committee.attestation);
		expect(message.length).toBe(58);
		expect(hex(message)).toBe(VECTOR_MESSAGE);
	});

	it('decodes the committee vector', () => {
		const attestation = decodeCommitteeAttestation(fromHex(VECTOR_ATTESTATION));
		expect(attestation.epoch).toBe(7n);
		expect(hex(attestation.membersDigest)).toBe(VECTOR_MEMBERS_DIGEST);
	});

	it('pins the vector signature, and accepts it', () => {
		expect(hex(ed25519.getPublicKey(VECTOR_SIGNER_SEED))).toBe(VECTOR_SIGNER);
		const signed = vectorCommittee();
		expect(hex(signed.signature)).toBe(VECTOR_SIGNATURE);
		const verified = verifySignedCommittee({
			members: fromHex(VECTOR_MEMBERS),
			attestation: fromHex(VECTOR_ATTESTATION),
			signerNoaPublicKey: fromHex(VECTOR_SIGNER),
			signature: fromHex(VECTOR_SIGNATURE),
		});
		expect(verified.epoch).toBe(7n);
		expect(verified.members.map((member) => hex(member.networkPubkey))).toEqual([
			'22'.repeat(32),
			'44'.repeat(32),
		]);
	});

	it('gives the same bytes whatever order the members are given in', () => {
		expect(hex(unsignedCommittee(7n, [MEMBER_B, MEMBER_A]).members)).toBe(VECTOR_MEMBERS);
	});

	it('refuses to build a committee with a repeated member or no member', () => {
		expect(() => unsignedCommittee(7n, [MEMBER_A, MEMBER_A])).toThrow(/twice/);
		expect(() => unsignedCommittee(7n, [])).toThrow('the committee has no members');
	});
});

describe('the strict decode', () => {
	it('refuses a committee attestation of an unknown variant', () => {
		expect(() =>
			decodeCommitteeAttestation(fromHex(`010700000000000000${VECTOR_MEMBERS_DIGEST}`)),
		).toThrow('unknown variant 1');
		// The variant is refused before the length is read.
		expect(() => decodeCommitteeAttestation(Uint8Array.from([1]))).toThrow('unknown variant 1');
	});

	it('refuses a committee attestation of any length but 41 bytes', () => {
		const bytes = fromHex(VECTOR_ATTESTATION);
		[bytes.slice(0, 40), Uint8Array.from([...bytes, 0]), new Uint8Array(0)].forEach((wrong) =>
			expect(() => decodeCommitteeAttestation(wrong)).toThrow(),
		);
	});

	it('accepts the vector members', () => {
		const members = decodeCommitteeMembers(fromHex(VECTOR_MEMBERS), fromHex(VECTOR_MEMBERS_DIGEST));
		expect(members).toHaveLength(2);
		expect(hex(members[0].consensusPubkey)).toBe('11'.repeat(32));
		expect(hex(members[1].networkPubkey)).toBe('44'.repeat(32));
	});

	it('refuses members that do not hash to the signed digest', () => {
		const other = unsignedCommittee(7n, [MEMBER_A]).members;
		expect(() => decodeCommitteeMembers(other, fromHex(VECTOR_MEMBERS_DIGEST))).toThrow(
			'the members do not hash to the signed digest',
		);
		expect(() => verifySignedCommittee({ ...vectorCommittee(), members: other })).toThrow(
			'the members do not hash to the signed digest',
		);
	});

	it('refuses a member list with trailing bytes, no member, or members out of order', () => {
		const member = (byte: number) => ({
			consensus_pubkey: Array.from(filled(byte)),
			network_pubkey: Array.from(filled(byte)),
		});
		const serialize = (members: ReturnType<typeof member>[]) =>
			CommitteeMembersBcs.serialize(members).toBytes();
		[
			Uint8Array.from([...fromHex(VECTOR_MEMBERS), 0]),
			serialize([]),
			serialize([member(2), member(1)]),
			serialize([member(1), member(1)]),
		].forEach((bytes) =>
			expect(() => decodeCommitteeMembers(bytes, committeeMembersDigest(bytes))).toThrow(),
		);
	});
});

describe('the signature', () => {
	it('a committee with a bad signature is refused', () => {
		const signed = vectorCommittee();
		signed.signature[0] ^= 1;
		expect(() => verifySignedCommittee(signed)).toThrow('does not verify under its signer');
	});

	it('a signed committee of another epoch does not verify', () => {
		const signed = vectorCommittee();
		// The epoch is inside the signed bytes: epoch 8 under epoch 7's signature.
		signed.attestation[1] = 8;
		expect(() => verifySignedCommittee(signed)).toThrow('does not verify under its signer');
	});

	it('a signer or a signature of the wrong length is refused', () => {
		const signed = vectorCommittee();
		expect(() =>
			verifySignedCommittee({ ...signed, signerNoaPublicKey: signed.signerNoaPublicKey.slice(1) }),
		).toThrow('a signer of 31 bytes, not 32');
		expect(() =>
			verifySignedCommittee({ ...signed, signature: signed.signature.slice(1) }),
		).toThrow('a signature of 63 bytes, not 64');
	});
});

describe('the check against the chain', () => {
	it('the chains epoch and the next are accepted', async () => {
		for (const epoch of [7n, 8n]) {
			const verified = await verifyCommitteeAnswer(
				{ committee: committeeOf(epoch, MEMBER) },
				scriptedChain([7n]),
				SHORT_RETRY,
			);
			expect(verified.chainEpoch).toBe(7n);
			expect(verified.committee.epoch).toBe(epoch);
			expect(hex(verified.committee.members[0].networkPubkey)).toBe(hex(MEMBER));
		}
	});

	it('a committee older than the chain epoch is refused', async () => {
		await expect(
			verifyCommitteeAnswer(
				{ committee: committeeOf(6n, MEMBER) },
				scriptedChain([7n]),
				SHORT_RETRY,
			),
		).rejects.toThrow("older than the chain's epoch 7");
	});

	it('a committee two epochs ahead is refused after the retry', async () => {
		const chain = scriptedChain([7n]);
		await expect(
			verifyCommitteeAnswer({ committee: committeeOf(9n, MEMBER) }, chain, SHORT_RETRY),
		).rejects.toThrow("epoch 9, more than one epoch after the chain's epoch 7");
		expect(chain.epochReads).toBeGreaterThan(1);
	});

	it('a committee ahead of a lagging chain is accepted once the chain moves', async () => {
		const chain = scriptedChain([7n, 7n, 8n]);
		const verified = await verifyCommitteeAnswer(
			{ committee: committeeOf(9n, MEMBER) },
			chain,
			SHORT_RETRY,
		);
		expect(verified.chainEpoch).toBe(8n);
		expect(chain.epochReads).toBe(3);
	});

	it('a committee signed by an unregistered key is refused', async () => {
		await expect(
			verifyCommitteeAnswer(
				{ committee: committeeOf(7n, MEMBER, new Uint8Array(32).fill(0x02)) },
				scriptedChain([7n]),
				SHORT_RETRY,
			),
		).rejects.toThrow('not a network key registered on the chain');
	});

	it('an answer with no committee is refused', async () => {
		await expect(verifyCommitteeAnswer({}, scriptedChain([7n]), SHORT_RETRY)).rejects.toThrow(
			'the validator answered no committee',
		);
	});

	it('keeps the next committee only one epoch after and not past the chain', async () => {
		const kept = await verifyCommitteeAnswer(
			{ committee: committeeOf(7n, MEMBER), nextCommittee: committeeOf(8n, NEXT_MEMBER) },
			scriptedChain([7n]),
			SHORT_RETRY,
		);
		expect(kept.nextCommittee?.epoch).toBe(8n);

		const pastTheChain = await verifyCommitteeAnswer(
			{ committee: committeeOf(8n, MEMBER), nextCommittee: committeeOf(9n, NEXT_MEMBER) },
			scriptedChain([7n]),
			SHORT_RETRY,
		);
		expect(pastTheChain.nextCommittee).toBeUndefined();

		const notTheNextEpoch = await verifyCommitteeAnswer(
			{ committee: committeeOf(7n, MEMBER), nextCommittee: committeeOf(7n, NEXT_MEMBER) },
			scriptedChain([7n]),
			SHORT_RETRY,
		);
		expect(notTheNextEpoch.nextCommittee).toBeUndefined();

		const badNext = committeeOf(8n, NEXT_MEMBER);
		badNext.signature[0] ^= 1;
		await expect(
			verifyCommitteeAnswer(
				{ committee: committeeOf(7n, MEMBER), nextCommittee: badNext },
				scriptedChain([7n]),
				SHORT_RETRY,
			),
		).rejects.toThrow('the next committee is refused');
	});

	it('the verified members drop a committee the chain has passed', async () => {
		const members = new VerifiedMembers();
		members.add(
			await verifyCommitteeAnswer(
				{ committee: committeeOf(7n, MEMBER), nextCommittee: committeeOf(8n, NEXT_MEMBER) },
				scriptedChain([7n]),
				SHORT_RETRY,
			),
		);
		expect(members.contains(MEMBER)).toBe(true);
		expect(members.contains(NEXT_MEMBER)).toBe(true);

		members.add(
			await verifyCommitteeAnswer(
				{ committee: committeeOf(8n, NEXT_MEMBER) },
				scriptedChain([8n]),
				SHORT_RETRY,
			),
		);
		expect(members.contains(MEMBER)).toBe(false);
		expect(members.contains(NEXT_MEMBER)).toBe(true);
	});
});
