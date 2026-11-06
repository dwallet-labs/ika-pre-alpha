// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The Solana reads the committee the network signed is checked against,
 * through `solanaCommitteeReader`: the `SystemState` epoch, and whether a
 * network key's `NetworkEncryptionKey` account exists.
 */
import type { IkaNetwork } from '@ika.xyz/sdk-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { deriveAddress, networkEncryptionKeyPda } from '../src/addresses.js';
import { solanaCommitteeReader } from '../src/committee-reader.js';
import type { ReadAccount } from '../src/usability.js';
import { accountDataLen, accountDiscriminator } from '../src/wire-tables.js';

/** A custom network: the reads are checked against no list of network keys. */
const CUSTOM: IkaNetwork = { custom: { networkPublicKeys: [] } };

const PROGRAM_ID = new Uint8Array(32).fill(0x05);
const REGISTERED = new Uint8Array(32).fill(0x07);

/** A `SystemState` account in `epoch`, which sits at 2. */
function systemState(epoch: bigint): Uint8Array {
	const data = new Uint8Array(accountDataLen('SystemState'));
	data[0] = accountDiscriminator('SystemState');
	new DataView(data.buffer).setBigUint64(2, epoch, true);
	return data;
}

/** A `NetworkEncryptionKey` account of `noaPublicKey`, unsigned, with `dkgOutputDigest` at 51. */
function keyAccount(
	noaPublicKey: Uint8Array,
	dkgOutputDigest = new Uint8Array(32).fill(0x02),
): Uint8Array {
	const data = new Uint8Array(accountDataLen('NetworkEncryptionKey'));
	data[0] = accountDiscriminator('NetworkEncryptionKey');
	data[1] = 1;
	data.set(noaPublicKey, 2);
	data[34] = 1;
	data.set(dkgOutputDigest, 51);
	return data;
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/** `getAccount` over these accounts, by address, all owned by `owner`. */
function accounts(
	entries: Array<[Uint8Array, Uint8Array]>,
	owner = PROGRAM_ID,
): (address: Uint8Array) => Promise<ReadAccount | null> {
	const byAddress = new Map(entries.map(([address, data]) => [hex(address), data]));
	return async (address) => {
		const data = byAddress.get(hex(address));
		return data === undefined ? null : { owner, data };
	};
}

const systemStateAddress = deriveAddress('SystemState', PROGRAM_ID).address;
const keyAddress = networkEncryptionKeyPda(PROGRAM_ID, REGISTERED).address;

describe('solanaCommitteeReader', () => {
	it('reads the SystemState epoch', async () => {
		const reader = solanaCommitteeReader(
			PROGRAM_ID,
			accounts([[systemStateAddress, systemState(12n)]]),
			'not-cross-checked',
			CUSTOM,
		);
		expect(await reader.currentEpoch()).toBe(12n);
	});

	it('refuses a missing SystemState, one of another owner, and one that is not a SystemState', async () => {
		await expect(
			solanaCommitteeReader(PROGRAM_ID, accounts([]), 'not-cross-checked', CUSTOM).currentEpoch(),
		).rejects.toThrow(/no SystemState account/);
		await expect(
			solanaCommitteeReader(
				PROGRAM_ID,
				accounts([[systemStateAddress, systemState(12n)]], new Uint8Array(32).fill(0x09)),
				'not-cross-checked',
				CUSTOM,
			).currentEpoch(),
		).rejects.toThrow(/not owned by the ika protocol program/);
		const wrongTag = systemState(12n);
		wrongTag[0] ^= 0xff;
		await expect(
			solanaCommitteeReader(
				PROGRAM_ID,
				accounts([[systemStateAddress, wrongTag]]),
				'not-cross-checked',
				CUSTOM,
			).currentEpoch(),
		).rejects.toThrow(/does not read as one/);
		await expect(
			solanaCommitteeReader(
				PROGRAM_ID,
				accounts([[systemStateAddress, systemState(12n).slice(1)]]),
				'not-cross-checked',
				CUSTOM,
			).currentEpoch(),
		).rejects.toThrow(/does not read as one/);
	});

	it('answers whether a network key is registered', async () => {
		const reader = solanaCommitteeReader(
			PROGRAM_ID,
			accounts([[keyAddress, keyAccount(REGISTERED)]]),
			'not-cross-checked',
			CUSTOM,
		);
		expect(await reader.isRegisteredNetworkKey(REGISTERED)).toBe(true);
		expect(await reader.isRegisteredNetworkKey(new Uint8Array(32).fill(0x08))).toBe(false);
	});
});

/** The refusal of a read the two endpoints do not agree on. */
const REFUSED =
	/the first Solana endpoint \(getAccount\) and the second Solana endpoint \(crossCheck\.getAccount\) .*refusing the read/;

/**
 * `read` with fake timers, advanced past the cross-check's 10-second window,
 * so a read that waits for a lagging endpoint ends without a real wait.
 */
async function pastTheWindow<T>(read: () => Promise<T>): Promise<T> {
	vi.useFakeTimers();
	const outcome = read();
	outcome.catch(() => undefined);
	await vi.advanceTimersByTimeAsync(11_000);
	return outcome;
}

describe('solanaCommitteeReader with a second endpoint', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	const crossChecked = (
		first: Array<[Uint8Array, Uint8Array]>,
		second: Array<[Uint8Array, Uint8Array]>,
	) => solanaCommitteeReader(PROGRAM_ID, accounts(first), { getAccount: accounts(second) }, CUSTOM);

	it('takes the epoch two endpoints agree on', async () => {
		const reader = crossChecked(
			[[systemStateAddress, systemState(12n)]],
			[[systemStateAddress, systemState(12n)]],
		);
		expect(await reader.currentEpoch()).toBe(12n);
	});

	it('refuses an epoch the second endpoint does not show within the window', async () => {
		// The epoch only grows, so it is the position: the endpoint at the
		// lower epoch is read again, and still shows it when the window ends.
		const reader = crossChecked(
			[[systemStateAddress, systemState(12n)]],
			[[systemStateAddress, systemState(11n)]],
		);
		await expect(pastTheWindow(() => reader.currentEpoch())).rejects.toThrow(REFUSED);
	});

	it('reads an endpoint at a lower epoch again until it catches up', async () => {
		const answers = [systemState(11n), systemState(12n)];
		const reader = solanaCommitteeReader(
			PROGRAM_ID,
			accounts([[systemStateAddress, systemState(12n)]]),
			{
				getAccount: async () => ({
					owner: PROGRAM_ID,
					data: answers.length > 1 ? answers.shift()! : answers[0],
				}),
			},
			CUSTOM,
		);
		expect(await pastTheWindow(() => reader.currentEpoch())).toBe(12n);
	});

	it('refuses a network key only one endpoint shows as registered', async () => {
		const reader = crossChecked([[keyAddress, keyAccount(REGISTERED)]], []);
		await expect(pastTheWindow(() => reader.isRegisteredNetworkKey(REGISTERED))).rejects.toThrow(
			REFUSED,
		);
	});

	it('refuses two endpoints whose records of a network key hold different digests', async () => {
		const reader = crossChecked(
			[[keyAddress, keyAccount(REGISTERED)]],
			[[keyAddress, keyAccount(REGISTERED, new Uint8Array(32).fill(0x03))]],
		);
		await expect(reader.isRegisteredNetworkKey(REGISTERED)).rejects.toThrow(REFUSED);
	});

	it('agrees when both endpoints find the record, and when both find none', async () => {
		const reader = crossChecked(
			[[keyAddress, keyAccount(REGISTERED)]],
			[[keyAddress, keyAccount(REGISTERED)]],
		);
		expect(await reader.isRegisteredNetworkKey(REGISTERED)).toBe(true);
		expect(await reader.isRegisteredNetworkKey(new Uint8Array(32).fill(0x08))).toBe(false);
	});

	it('refuses a reader that names no crossCheck', () => {
		expect(() =>
			solanaCommitteeReader(PROGRAM_ID, accounts([]), undefined as never, CUSTOM),
		).toThrow(/needs crossCheck/);
	});
});
