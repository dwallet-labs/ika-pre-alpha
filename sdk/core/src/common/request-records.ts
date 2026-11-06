// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * What a request leaves on the chain, found from its session identifier.
 *
 * Once the chain shows that a request's epoch closed, every request that was
 * sequenced in that epoch has its outcome settled on the chain: a delivery,
 * or a charge record. A charge's id is derived from the session identifier,
 * and its record is never removed. So a request with nothing on the chain
 * never ran, and the SDK may send it again under a new session.
 *
 * Two kinds of request are the exception: a DKG, whose dWallet's address
 * needs a public key only the network's answer gives, and an ended dWallet
 * commit or step 1 of a future sign, whose charge id needs the network's
 * attestation. For those, nothing found decides nothing.
 */
import { bcs } from '@mysten/bcs';
import { keccak_256 } from '@noble/hashes/sha3.js';

import {
	dwalletAttestationDigest,
	VersionedEncryptedUserKeyShareAttestationBcs,
	VersionedPublicUserKeyShareAttestationBcs,
} from '../index.js';
import type { DWalletLookup, DWalletShareReader } from '../index.js';

/** Why the network charged a session without delivering anything, as the node names it. */
export type GasChargeSource =
	| 'RefusedRequest'
	| 'RejectedSession'
	| 'CompletedPresign'
	| 'MovedNetworkKeySession'
	| 'GivenUpSignature'
	| 'GivenUpShareCommit';

/**
 * The id of a charge: `keccak256(bcs(("IkaGasCharge", source, id)))`, as the
 * node's `gas_charge_id` derives it. `id` is the session identifier, or for
 * a given-up commit its settled item id.
 */
export function gasChargeId(source: GasChargeSource, id: Uint8Array): Uint8Array {
	return keccak_256(
		bcs
			.tuple([bcs.string(), bcs.string(), bcs.fixedArray(32, bcs.u8())])
			.serialize(['IkaGasCharge', source, Array.from(id)])
			.toBytes(),
	);
}

/**
 * The settled item id of a signature commit, from the sign's session:
 * `keccak256(bcs(("IkaSignatureCommit", session)))`, as the node's
 * `signature_commit_item_id` derives it. A given-up sign's charge id is
 * derived from it.
 */
export function signatureCommitItemId(sessionIdentifier: Uint8Array): Uint8Array {
	return keccak_256(
		bcs
			.tuple([bcs.string(), bcs.fixedArray(32, bcs.u8())])
			.serialize(['IkaSignatureCommit', Array.from(sessionIdentifier)])
			.toBytes(),
	);
}

/** The dWallet attestation fields a share attestation repeats. */
interface DWalletAttested {
	/** The dWallet attestation's exact bytes. */
	attestationData: Uint8Array;
	intendedChainSender: Uint8Array;
	publicKey: Uint8Array;
}

/**
 * The bytes of the share attestation the network signs for a make-public
 * session, as the node's `existing_share_attestation_of_output` builds them.
 * Their keccak256 is the share commit's settled item id.
 */
export function publicShareAttestationBytes(
	sessionIdentifier: Uint8Array,
	dwallet: DWalletAttested,
	publicUserSecretKeyShare: Uint8Array,
): Uint8Array {
	return VersionedPublicUserKeyShareAttestationBcs.serialize({
		V1: {
			session_identifier: Array.from(sessionIdentifier),
			intended_chain_sender: Array.from(dwallet.intendedChainSender),
			dwallet_public_key: Array.from(dwallet.publicKey),
			public_user_secret_key_share: Array.from(publicUserSecretKeyShare),
			dwallet_attestation_digest: Array.from(dwalletAttestationDigest(dwallet.attestationData)),
		},
	}).toBytes();
}

/**
 * The bytes of the share attestation the network signs for a re-encryption
 * session, as the node's `existing_share_attestation_of_output` builds them.
 * Their keccak256 is the share commit's settled item id.
 */
export function encryptedShareAttestationBytes(
	sessionIdentifier: Uint8Array,
	dwallet: DWalletAttested,
	encryptedShareAndProof: Uint8Array,
	encryptionKey: Uint8Array,
	holderSignerPublicKey: Uint8Array,
): Uint8Array {
	return VersionedEncryptedUserKeyShareAttestationBcs.serialize({
		V1: {
			session_identifier: Array.from(sessionIdentifier),
			intended_chain_sender: Array.from(dwallet.intendedChainSender),
			dwallet_public_key: Array.from(dwallet.publicKey),
			encrypted_share_hash: Array.from(keccak_256(encryptedShareAndProof)),
			encryption_key_hash: Array.from(keccak_256(encryptionKey)),
			holder: {
				signature_scheme: { Ed25519: null },
				signer_public_key: Array.from(holderSignerPublicKey),
			} as any,
			dwallet_attestation_digest: Array.from(dwalletAttestationDigest(dwallet.attestationData)),
		},
	}).toBytes();
}

/**
 * The chain reads a request's lookup makes, from the chain package. A
 * package that reads through a second endpoint should cross-check each of
 * these: an endpoint that hid a record would make the SDK send a request
 * again that already ran.
 */
export interface RequestRecordReader {
	/** Whether the gas deposit of `transportKey` holds the charge record `chargeId`. */
	hasGasCharge(transportKey: Uint8Array, chargeId: Uint8Array): Promise<boolean>;
	/** The signature the signature voucher at `voucher` holds, unverified, or `null`. */
	voucherSignature(voucher: Uint8Array): Promise<Uint8Array | null>;
	/** What the future signature voucher at `voucher` holds, or `null` when there is none. */
	futureVoucher(voucher: Uint8Array): Promise<{
		/** The session step 1 stored, or `null` before step 1. */
		stepOneSession: Uint8Array | null;
		/** The signature the completion wrote, unverified, or `null`. */
		signature: Uint8Array | null;
		/** Whether the network closed it without delivery: a step 1 it gave up. */
		closed: boolean;
	} | null>;
}

/**
 * A request whose epoch closed before an answer, with what its lookup needs.
 * `EpochClosedBeforeAnswer` carries one. Keep it, and pass it to
 * `IkaClient.resolveSession` later: the session identifier alone finds the
 * charges, and the rest finds a delivered result, which is kept where the
 * request wrote it (a voucher, a share record), not under the session.
 */
/** What every pending request holds. */
export interface PendingRequestBase {
	/** The epoch the request named. */
	epoch: bigint;
	/** The session the request opened. */
	sessionIdentifier: Uint8Array;
	/** The key that signed the request; its gas deposit holds the charges. */
	transportKey: Uint8Array;
	/** The curve and network key of the connection the request went through. */
	curve: number;
	networkKeyId: Uint8Array;
}

/** What one kind of pending request holds besides. */
export type PendingRequestKind =
	| { kind: 'presign' }
	| { kind: 'sign'; voucher: Uint8Array }
	| { kind: 'futureSignStepOne'; voucher: Uint8Array }
	| { kind: 'futureSignCompletion'; voucher: Uint8Array }
	| {
			kind: 'makeSharePublic';
			dwallet: DWalletLookup;
			/** The settled item id of the share commit: the digest of its attestation. */
			shareCommitItemId: Uint8Array;
	  }
	| {
			kind: 'reEncryptShare';
			dwallet: DWalletLookup;
			newHolder: Uint8Array;
			shareCommitItemId: Uint8Array;
	  }
	/**
	 * A DKG, or an imported-key verification: the dWallet it creates, whose
	 * address the user's own DKG output already gives.
	 */
	| { kind: 'dkg'; dwallet: DWalletLookup }
	| { kind: 'importedKey'; dwallet: DWalletLookup };

export type PendingRequest = PendingRequestBase & PendingRequestKind;

/**
 * The epoch the chain must show before every session of `pending`'s epoch
 * is settled on it: the next one, or for a re-encryption the one after, as
 * its commit can land in the next epoch at protocol versions 8 to 10.
 */
export function settledAtEpoch(pending: PendingRequest): bigint {
	return pending.epoch + (pending.kind === 'reEncryptShare' ? 2n : 1n);
}

/**
 * Look on the chain for `pending`'s session, once the chain shows
 * {@link settledAtEpoch}. `shares` reads the dWallet's share records; it is
 * needed for a make-public and a re-encryption only.
 *
 * A record found means the session ran: a signature in the voucher is
 * returned as such. Nothing found means it never ran, except for a DKG and
 * an imported-key verification, whose dWallet commit the network may have
 * given up, and a step 1 whose voucher the network closed: those charges'
 * ids need the network's attestation, so the outcome is unknown.
 */
export async function findSession(
	pending: PendingRequest,
	records: RequestRecordReader,
	shares?: DWalletShareReader,
): Promise<RequestOutcome> {
	const { sessionIdentifier } = pending;
	const charged = async (more: { source: GasChargeSource; id: Uint8Array }[] = []) => {
		const charges = [
			...(['RefusedRequest', 'RejectedSession', 'MovedNetworkKeySession'] as const).map(
				(source) => ({ source, id: sessionIdentifier }),
			),
			...more,
		];
		const held = await Promise.all(
			charges.map(({ source, id }) =>
				records.hasGasCharge(pending.transportKey, gasChargeId(source, id)),
			),
		);
		const found = charges.find((_, index) => held[index]);
		return found === undefined ? undefined : `the charge record ${found.source}`;
	};
	const ranOr = async (
		otherwise: RequestOutcome,
		more: { source: GasChargeSource; id: Uint8Array }[] = [],
	): Promise<RequestOutcome> => {
		const record = await charged(more);
		return record === undefined ? otherwise : { kind: 'ran', record };
	};
	const dwalletRecord = async (dwallet: DWalletLookup) => {
		if (shares === undefined) throw new Error('a share lookup needs the share reader');
		return shares.readDWallet(dwallet);
	};
	const notRun: RequestOutcome = { kind: 'notRun' };
	switch (pending.kind) {
		case 'presign':
			return ranOr(notRun, [{ source: 'CompletedPresign', id: sessionIdentifier }]);
		case 'sign': {
			// A signature in the voucher is the one the sign asked for,
			// whichever session wrote it.
			const signature = await records.voucherSignature(pending.voucher);
			if (signature !== null) return { kind: 'signature', signature };
			return ranOr(notRun, [
				{ source: 'GivenUpSignature', id: signatureCommitItemId(sessionIdentifier) },
			]);
		}
		case 'futureSignStepOne': {
			const voucher = await records.futureVoucher(pending.voucher);
			if (voucher === null) return { kind: 'unknown' };
			if (voucher.stepOneSession !== null) {
				const own = sameBytes(voucher.stepOneSession, sessionIdentifier);
				return {
					kind: 'ran',
					record: own ? "this request's step 1 in the voucher" : 'another step 1 in the voucher',
				};
			}
			if (voucher.signature !== null) return { kind: 'ran', record: 'a signature in the voucher' };
			// The network closes the voucher when it gives up a step 1, and
			// that charge's id needs the network's attestation.
			if (voucher.closed) return ranOr({ kind: 'unknown' });
			return ranOr(notRun);
		}
		case 'futureSignCompletion': {
			const voucher = await records.futureVoucher(pending.voucher);
			if (voucher?.signature != null) return { kind: 'signature', signature: voucher.signature };
			return ranOr(notRun, [
				{ source: 'GivenUpSignature', id: signatureCommitItemId(sessionIdentifier) },
			]);
		}
		case 'makeSharePublic': {
			// A public share on the chain means this request, or an earlier
			// one, made it public: sent again, it would only be charged.
			const record = await dwalletRecord(pending.dwallet);
			if (record !== undefined && (await record.readPublicShare()) !== undefined) {
				return { kind: 'ran', record: "the dWallet's public share" };
			}
			return ranOr(notRun, [{ source: 'GivenUpShareCommit', id: pending.shareCommitItemId }]);
		}
		case 'reEncryptShare': {
			// A share for the new holder on the chain means this request, or an
			// earlier one, wrote it: sent again, it would only be charged.
			const record = await dwalletRecord(pending.dwallet);
			if (
				record !== undefined &&
				(await record.readEncryptedShare(pending.newHolder)) !== undefined
			) {
				return { kind: 'ran', record: "the new holder's share" };
			}
			return ranOr(notRun, [{ source: 'GivenUpShareCommit', id: pending.shareCommitItemId }]);
		}
		case 'dkg':
		case 'importedKey': {
			// The dWallet's address comes from its public key, which only this
			// DKG's user share could give, and for an imported key from the
			// session too: a dWallet there is this request's.
			if ((await dwalletRecord(pending.dwallet)) !== undefined) {
				return { kind: 'ran', record: 'the dWallet' };
			}
			// A given-up dWallet commit's charge id needs the network's
			// attestation, so nothing found does not rule it out.
			return ranOr({ kind: 'unknown' });
		}
	}
}

function sameBytes(first: Uint8Array, second: Uint8Array): boolean {
	return first.length === second.length && first.every((byte, index) => byte === second[index]);
}

/** What a request's lookup found on the chain. */
export type RequestOutcome =
	/** Nothing names the session: it never ran, and may be sent again. */
	| { kind: 'notRun' }
	/** The session ran: `record` says what the chain holds. */
	| { kind: 'ran'; record: string }
	/** The voucher holds a signature: the sign ran. */
	| { kind: 'signature'; signature: Uint8Array }
	/** The chain cannot tell. */
	| { kind: 'unknown' };

/**
 * A request's epoch closed before the network answered it, and the chain
 * shows it ran: `record` says what the chain holds. It is not sent again.
 * A charge record means the network refused or rejected it, or did the work
 * and charged for it.
 */
export class RequestRanBeforeAnswer extends Error {
	constructor(
		/** The epoch the request named. */
		readonly epoch: bigint,
		/** The session the request opened. */
		readonly sessionIdentifier: Uint8Array,
		/** What the chain holds for the session. */
		readonly record: string,
	) {
		super(
			`the request for epoch ${epoch} got no answer before its epoch closed, and the chain shows it ran: ${record}`,
		);
		this.name = 'RequestRanBeforeAnswer';
	}
}
