// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The ids a request's lookup derives from its session must be the node's.
 * The vectors are the ones the node's own tests pin.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
	findSession,
	gasChargeId,
	settledAtEpoch,
	signatureCommitItemId,
} from '../../src/common/request-records.js';
import type { PendingRequest, RequestRecordReader } from '../../src/common/request-records.js';
import {
	Curve,
	publicKeyFromCentralizedDKGOutput,
	publicKeyFromDWalletOutput,
} from '../../src/index.js';
import type { AttestationRecord, DWalletShareReader } from '../../src/index.js';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('the ids a lookup derives', () => {
	it("derives a charge id as the node's gas_charge_id does", () => {
		expect(hex(gasChargeId('GivenUpShareCommit', new Uint8Array(32).fill(0x8b)))).toBe(
			'bfcfdd03dc53cee11884c0cacd62daf92019aa81d9bc932f0f08623445df3e94',
		);
	});

	it("derives a signature commit's item id as the node does", () => {
		expect(hex(signatureCommitItemId(new Uint8Array(32).fill(0xc7)))).toBe(
			'6a724e875b0e112e638a7e5b535e3c3830296e5806bd4f561747e19b6ffd7a6f',
		);
	});
});

const SESSION = new Uint8Array(32).fill(0x51);
const TRANSPORT = new Uint8Array(32).fill(0x52);
const VOUCHER = new Uint8Array(32).fill(0x53);
const base = {
	epoch: 7n,
	sessionIdentifier: SESSION,
	transportKey: TRANSPORT,
	curve: 2,
	networkKeyId: new Uint8Array(32).fill(0x54),
};

/** Chain records holding the charges `charged`, and the vouchers given. */
function records(
	charged: Uint8Array[] = [],
	vouchers: {
		signature?: Uint8Array;
		future?: { stepOneSession: Uint8Array | null; signature: Uint8Array | null; closed: boolean };
	} = {},
): RequestRecordReader {
	return {
		hasGasCharge: async (key, chargeId) =>
			hex(key) === hex(TRANSPORT) && charged.some((id) => hex(id) === hex(chargeId)),
		voucherSignature: async () => vouchers.signature ?? null,
		futureVoucher: async () => vouchers.future ?? null,
	};
}

const DWALLET = { curve: 2, publicKey: new Uint8Array(32).fill(0x56) };

/** A share reader with no dWallet on the chain. */
const noDWallet: DWalletShareReader = {
	chain: 'solana',
	trustedNetworkKeys: {} as never,
	readDWallet: async () => undefined,
};

/** A share reader whose one dWallet holds the shares given. */
function shares(held: { public?: boolean; holder?: Uint8Array } = {}): DWalletShareReader {
	const record = {} as AttestationRecord;
	return {
		chain: 'solana',
		trustedNetworkKeys: {} as never,
		readDWallet: async () => ({
			address: new Uint8Array(32),
			networkPublicKey: new Uint8Array(32),
			attestation: record,
			readEncryptedShare: async (key: Uint8Array) =>
				held.holder !== undefined && hex(key) === hex(held.holder) ? record : undefined,
			readPublicShare: async () => (held.public ? record : undefined),
		}),
	};
}

describe('findSession', () => {
	it('finds a served presign by its charge, and calls an uncharged one never run', async () => {
		const pending: PendingRequest = { ...base, kind: 'presign' };
		const served = await findSession(pending, records([gasChargeId('CompletedPresign', SESSION)]));
		expect(served).toEqual({ kind: 'ran', record: 'the charge record CompletedPresign' });
		expect(await findSession(pending, records())).toEqual({ kind: 'notRun' });
	});

	it("finds every request's refusal charge", async () => {
		const pending: PendingRequest = { ...base, kind: 'dkg', dwallet: DWALLET };
		const refused = await findSession(
			pending,
			records([gasChargeId('RefusedRequest', SESSION)]),
			noDWallet,
		);
		expect(refused).toEqual({ kind: 'ran', record: 'the charge record RefusedRequest' });
	});

	it('finds a DKG or an import by its dWallet, and cannot tell with nothing on the chain', async () => {
		for (const kind of ['dkg', 'importedKey'] as const) {
			const pending: PendingRequest = { ...base, kind, dwallet: DWALLET };
			expect(await findSession(pending, records(), shares())).toEqual({
				kind: 'ran',
				record: 'the dWallet',
			});
			// A given-up dWallet commit's charge is not found from the session.
			expect(await findSession(pending, records(), noDWallet)).toEqual({ kind: 'unknown' });
		}
	});

	it("returns a sign's voucher signature, and finds a given-up sign by its charge", async () => {
		const pending: PendingRequest = { ...base, kind: 'sign', voucher: VOUCHER };
		const signature = new Uint8Array(64).fill(9);
		expect(await findSession(pending, records([], { signature }))).toEqual({
			kind: 'signature',
			signature,
		});
		const givenUp = gasChargeId('GivenUpSignature', signatureCommitItemId(SESSION));
		expect((await findSession(pending, records([givenUp]))).kind).toBe('ran');
		expect(await findSession(pending, records())).toEqual({ kind: 'notRun' });
	});

	it('reads a step 1 from its voucher, and cannot tell for a voucher the network closed', async () => {
		const pending: PendingRequest = { ...base, kind: 'futureSignStepOne', voucher: VOUCHER };
		const stepOne = (stepOneSession: Uint8Array | null, closed = false) =>
			records([], { future: { stepOneSession, signature: null, closed } });
		expect(await findSession(pending, stepOne(SESSION))).toEqual({
			kind: 'ran',
			record: "this request's step 1 in the voucher",
		});
		expect(await findSession(pending, stepOne(new Uint8Array(32)))).toEqual({
			kind: 'ran',
			record: 'another step 1 in the voucher',
		});
		expect(await findSession(pending, stepOne(null, true))).toEqual({ kind: 'unknown' });
		expect(await findSession(pending, stepOne(null))).toEqual({ kind: 'notRun' });
	});

	it('finds a make-public by the public share or its share commit charge', async () => {
		const shareCommitItemId = new Uint8Array(32).fill(0x8b);
		const pending: PendingRequest = {
			...base,
			kind: 'makeSharePublic',
			dwallet: { curve: 2, publicKey: new Uint8Array(32) },
			shareCommitItemId,
		};
		expect((await findSession(pending, records(), shares({ public: true }))).kind).toBe('ran');
		const givenUp = gasChargeId('GivenUpShareCommit', shareCommitItemId);
		expect((await findSession(pending, records([givenUp]), shares())).kind).toBe('ran');
		expect(await findSession(pending, records(), shares())).toEqual({ kind: 'notRun' });
	});

	it('finds a re-encryption by the new holder share, and waits two epochs for it', async () => {
		const newHolder = new Uint8Array(32).fill(0x55);
		const pending: PendingRequest = {
			...base,
			kind: 'reEncryptShare',
			dwallet: { curve: 2, publicKey: new Uint8Array(32) },
			newHolder,
			shareCommitItemId: new Uint8Array(32),
		};
		expect(settledAtEpoch(pending)).toBe(9n);
		expect(settledAtEpoch({ ...base, kind: 'presign' })).toBe(8n);
		expect((await findSession(pending, records(), shares({ holder: newHolder }))).kind).toBe('ran');
		expect(await findSession(pending, records(), shares())).toEqual({ kind: 'notRun' });
	});
});

describe("a new dWallet's address, before the network answers", () => {
	const fixture = (name: string) =>
		Uint8Array.from(readFileSync(new URL(`./fixtures/acceptance/${name}`, import.meta.url)));

	it.each([
		['dkg', Curve.ED25519],
		['ecdsa_blake2b256', Curve.SECP256K1],
		['import', Curve.SECP256K1],
	] as const)(
		"takes the %s dWallet's public key from the user's own output, as the network's output holds it",
		async (name, curve) => {
			const fromUser = await publicKeyFromCentralizedDKGOutput(
				curve,
				fixture(`${name}_user_public_output.bcs`),
			);
			const fromNetwork = await publicKeyFromDWalletOutput(
				curve,
				fixture(`${name}_network_output.bcs`),
			);
			expect(hex(fromUser)).toBe(hex(fromNetwork));
		},
		120_000,
	);
});
