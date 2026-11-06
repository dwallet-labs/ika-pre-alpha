// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The verified read of a network key's outputs against the program's records
 * on Solana, through `readSolanaNetworkKeyOutputVerified`.
 *
 * The accounts are laid out at the offsets the readers use, which
 * `accounts.test.ts` pins to the program's own structs through the fixtures.
 * The validator is a stub that answers one `NetworkKeyOutput`.
 */
import {
	networkKeyDkgRecordMessage,
	networkKeyIdFromBytes,
	NetworkKeyOutputError,
	networkKeyReconfigurationRecordMessage,
	networkOutputDigest,
} from '@ika.xyz/sdk-core';
import type { IkaNetwork, NetworkKeyOutput } from '@ika.xyz/sdk-core';
import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it, vi } from 'vitest';

import { networkEncryptionKeyPda, networkReconfigurationOutputPda } from '../src/addresses.js';
import {
	readSolanaNetworkKeyOutputVerified,
	solanaNetworkKeyOutputRecordReader,
} from '../src/network-key-output.js';
import type { ReadAccount } from '../src/usability.js';
import { accountDataLen, accountDiscriminator } from '../src/wire-tables.js';

/** A custom network: the reads are checked against no list of network keys. */
const CUSTOM: IkaNetwork = { custom: { networkPublicKeys: [] } };

const PROGRAM_ID = new Uint8Array(32).fill(0x05);
const SIGNER_SECRET = new Uint8Array(32).fill(0x07);
const SIGNER = ed25519.getPublicKey(SIGNER_SECRET);
/** The key read is also the signing key, as on a one-key network. */
const KEY = networkKeyIdFromBytes(SIGNER);
const DKG_OUTPUT = Uint8Array.from([1, 2, 3, 4]);
const RESHARE_OUTPUT = Uint8Array.from([5, 6, 7]);
const EPOCH = 9n;
const ZEROS_32 = new Uint8Array(32);
const ZEROS_64 = new Uint8Array(64);

function u64(data: Uint8Array, offset: number, value: bigint) {
	new DataView(data.buffer, data.byteOffset, data.byteLength).setBigUint64(offset, value, true);
}

/**
 * The proof slot of a record signed by `signer` with `signature`: the
 * length, then the V1 proof (the variant, `attestation_version` 0, the signer
 * and the signature). An all-zero signer and signature leave the slot all
 * zeros: its length is 0, the empty proof of an unsigned record.
 */
function setProofSlot(data: Uint8Array, offset: number, signer: Uint8Array, signature: Uint8Array) {
	if (signer.every((byte) => byte === 0) && signature.every((byte) => byte === 0)) {
		return;
	}
	data[offset] = 98;
	data.set([0, 0], offset + 1);
	data.set(signer, offset + 3);
	data.set(signature, offset + 35);
}

/** A `NetworkEncryptionKey` account: the digest at 51, the proof slot at 100. */
function keyAccount(
	noaPublicKey: Uint8Array,
	digest: Uint8Array,
	signer: Uint8Array,
	signature: Uint8Array,
): Uint8Array {
	const data = new Uint8Array(accountDataLen('NetworkEncryptionKey'));
	data[0] = accountDiscriminator('NetworkEncryptionKey');
	data[1] = 1;
	data.set(noaPublicKey, 2);
	data[34] = 1;
	data.set(digest, 51);
	setProofSlot(data, 100, signer, signature);
	return data;
}

/** A `NetworkReconfigurationOutput` account: the epoch at 34, the digest at 42, the proof slot at 74. */
function reshareAccount(
	digest: Uint8Array,
	signer: Uint8Array,
	signature: Uint8Array,
	epoch = EPOCH,
): Uint8Array {
	const data = new Uint8Array(accountDataLen('NetworkReconfigurationOutput'));
	data[0] = accountDiscriminator('NetworkReconfigurationOutput');
	data[1] = 1;
	data.set(KEY, 2);
	u64(data, 34, epoch);
	data.set(digest, 42);
	setProofSlot(data, 74, signer, signature);
	return data;
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

type Accounts = Map<string, Uint8Array>;

function getAccount(accounts: Accounts, owner = PROGRAM_ID) {
	return async (address: Uint8Array): Promise<ReadAccount | null> => {
		const data = accounts.get(hex(address));
		return data === undefined ? null : { owner, data };
	};
}

const keyAddress = hex(networkEncryptionKeyPda(PROGRAM_ID, KEY).address);
const reshareAddress = hex(networkReconfigurationOutputPda(PROGRAM_ID, KEY, EPOCH).address);

const dkgDigest = networkOutputDigest(DKG_OUTPUT);
const reshareDigest = networkOutputDigest(RESHARE_OUTPUT);
const dkgSignature = ed25519.sign(networkKeyDkgRecordMessage(KEY, dkgDigest), SIGNER_SECRET);
const reshareSignature = ed25519.sign(
	networkKeyReconfigurationRecordMessage(KEY, EPOCH, reshareDigest),
	SIGNER_SECRET,
);

function signedAccounts(): Accounts {
	return new Map([
		[keyAddress, keyAccount(KEY, dkgDigest, SIGNER, dkgSignature)],
		[reshareAddress, reshareAccount(reshareDigest, SIGNER, reshareSignature)],
	]);
}

const served = (overrides: Partial<NetworkKeyOutput> = {}): NetworkKeyOutput => ({
	networkDkgOutput: DKG_OUTPUT,
	latestReconfigurationOutput: RESHARE_OUTPUT,
	epoch: EPOCH,
	dkgAtEpoch: 1n,
	networkKeyId: KEY,
	...overrides,
});

const validator = (answer: NetworkKeyOutput) => ({
	async getNetworkKeyOutput() {
		return answer;
	},
});

async function check(accounts: Accounts, answer: NetworkKeyOutput = served()): Promise<string> {
	try {
		await readSolanaNetworkKeyOutputVerified(
			PROGRAM_ID,
			getAccount(accounts),
			'not-cross-checked',
			CUSTOM,
			validator(answer),
			KEY,
		);
	} catch (error) {
		expect(error).toBeInstanceOf(NetworkKeyOutputError);
		return (error as NetworkKeyOutputError).check;
	}
	return 'passed';
}

describe('readSolanaNetworkKeyOutputVerified', () => {
	it('accepts outputs that match the signed records', async () => {
		await expect(
			readSolanaNetworkKeyOutputVerified(
				PROGRAM_ID,
				getAccount(signedAccounts()),
				'not-cross-checked',
				CUSTOM,
				validator(served()),
				KEY,
			),
		).resolves.toEqual(served());
	});

	it('refuses an unsigned record once the wait ends', async () => {
		// The check reads the record again for 2 minutes while its proof is
		// empty; fake timers run those pauses at once.
		vi.useFakeTimers();
		try {
			const accounts: Accounts = new Map([
				[keyAddress, keyAccount(KEY, dkgDigest, SIGNER, dkgSignature)],
				[reshareAddress, reshareAccount(reshareDigest, ZEROS_32, ZEROS_64)],
			]);
			const result = check(accounts);
			await vi.runAllTimersAsync();
			expect(await result).toBe('record');
		} finally {
			vi.useRealTimers();
		}
	});

	it('refuses a reshare output with another digest', async () => {
		const answer = served({ latestReconfigurationOutput: Uint8Array.from([9]) });
		expect(await check(signedAccounts(), answer)).toBe('digest');
	});

	it('refuses a DKG output with another digest', async () => {
		expect(await check(signedAccounts(), served({ networkDkgOutput: Uint8Array.from([9]) }))).toBe(
			'digest',
		);
	});

	it('refuses a wrong signature on the reshare record', async () => {
		const wrong = Uint8Array.from(reshareSignature);
		wrong[0] ^= 1;
		const accounts = signedAccounts();
		accounts.set(reshareAddress, reshareAccount(reshareDigest, SIGNER, wrong));
		expect(await check(accounts)).toBe('signature');
	});

	it('refuses a wrong signature on the DKG record', async () => {
		const wrong = Uint8Array.from(dkgSignature);
		wrong[0] ^= 1;
		const accounts = signedAccounts();
		accounts.set(keyAddress, keyAccount(KEY, dkgDigest, SIGNER, wrong));
		expect(await check(accounts)).toBe('signature');
	});

	it('refuses a signer that is not a registered network key', async () => {
		const otherSecret = new Uint8Array(32).fill(0x08);
		const other = ed25519.getPublicKey(otherSecret);
		const accounts = signedAccounts();
		accounts.set(
			reshareAddress,
			reshareAccount(
				reshareDigest,
				other,
				ed25519.sign(
					networkKeyReconfigurationRecordMessage(KEY, EPOCH, reshareDigest),
					otherSecret,
				),
			),
		);
		expect(await check(accounts)).toBe('signer');
	});

	it('refuses a reshare output with no record for the served epoch, after the wait', async () => {
		// The check reads the missing record again for 2 minutes; fake timers
		// run those pauses at once.
		vi.useFakeTimers();
		try {
			const accounts: Accounts = new Map([
				[keyAddress, keyAccount(KEY, dkgDigest, SIGNER, dkgSignature)],
			]);
			const result = check(accounts);
			await vi.runAllTimersAsync();
			expect(await result).toBe('record');
		} finally {
			vi.useRealTimers();
		}
	});

	it('refuses an account another program owns', async () => {
		await expect(
			readSolanaNetworkKeyOutputVerified(
				PROGRAM_ID,
				getAccount(signedAccounts(), new Uint8Array(32).fill(0x09)),
				'not-cross-checked',
				CUSTOM,
				validator(served()),
				KEY,
			),
		).rejects.toThrow(/not owned by the ika protocol program/);
	});

	it('refuses a record account that names another epoch', async () => {
		const accounts = signedAccounts();
		accounts.set(
			reshareAddress,
			reshareAccount(reshareDigest, SIGNER, reshareSignature, EPOCH + 1n),
		);
		await expect(
			readSolanaNetworkKeyOutputVerified(
				PROGRAM_ID,
				getAccount(accounts),
				'not-cross-checked',
				CUSTOM,
				validator(served()),
				KEY,
			),
		).rejects.toThrow(/names another key or epoch/);
	});
});

describe('readSolanaNetworkKeyOutputVerified with a second endpoint', () => {
	const otherSecret = new Uint8Array(32).fill(0x08);
	const other = ed25519.getPublicKey(otherSecret);
	const otherKeyAddress = hex(networkEncryptionKeyPda(PROGRAM_ID, other).address);

	/** The records, with the reshare record signed by `other`, and `other`'s key account when `registered`. */
	function signedByOther(registered: boolean): Accounts {
		const accounts = signedAccounts();
		accounts.set(
			reshareAddress,
			reshareAccount(
				reshareDigest,
				other,
				ed25519.sign(
					networkKeyReconfigurationRecordMessage(KEY, EPOCH, reshareDigest),
					otherSecret,
				),
			),
		);
		if (registered) {
			accounts.set(otherKeyAddress, keyAccount(other, dkgDigest, ZEROS_32, ZEROS_64));
		}
		return accounts;
	}

	const read = (first: Accounts, second: Accounts) =>
		readSolanaNetworkKeyOutputVerified(
			PROGRAM_ID,
			getAccount(first),
			{ getAccount: getAccount(second) },
			CUSTOM,
			validator(served()),
			KEY,
		);

	it('accepts a signer both endpoints show as registered', async () => {
		await expect(read(signedByOther(true), signedByOther(true))).resolves.toEqual(served());
	});

	it('refuses a signer only the first endpoint shows as registered', async () => {
		// The second endpoint has no account of the signer, so it is read again
		// until the 10-second window ends; fake timers run the pauses at once.
		vi.useFakeTimers();
		try {
			const outcome = read(signedByOther(true), signedByOther(false));
			outcome.catch(() => undefined);
			await vi.advanceTimersByTimeAsync(11_000);
			await expect(outcome).rejects.toThrow(/still disagree on the NetworkEncryptionKey/);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('solanaNetworkKeyOutputRecordReader hands over the stored proof', () => {
	const reader = (accounts: Accounts) =>
		solanaNetworkKeyOutputRecordReader(
			PROGRAM_ID,
			getAccount(accounts),
			'not-cross-checked',
			CUSTOM,
		);

	// The check, not the reader, decides what an empty proof means.
	it('reads an unsigned record as an empty proof', async () => {
		const accounts: Accounts = new Map([
			[keyAddress, keyAccount(KEY, dkgDigest, ZEROS_32, ZEROS_64)],
			[reshareAddress, reshareAccount(reshareDigest, ZEROS_32, ZEROS_64)],
		]);
		expect(await reader(accounts).reconfigurationRecord(KEY, EPOCH)).toEqual({
			digest: reshareDigest,
			proof: new Uint8Array(),
		});
		expect(await reader(accounts).dkgRecord(KEY)).toEqual({
			digest: dkgDigest,
			proof: new Uint8Array(),
		});
	});

	// 98 zero bytes, which the check refuses: the reader judges nothing.
	it('passes a zero-filled proof to the check unchanged', async () => {
		const key = keyAccount(KEY, dkgDigest, ZEROS_32, ZEROS_64);
		key[100] = 98;
		const reshare = reshareAccount(reshareDigest, ZEROS_32, ZEROS_64);
		reshare[74] = 98;
		const accounts: Accounts = new Map([
			[keyAddress, key],
			[reshareAddress, reshare],
		]);
		expect((await reader(accounts).reconfigurationRecord(KEY, EPOCH))?.proof).toEqual(
			new Uint8Array(98),
		);
		expect((await reader(accounts).dkgRecord(KEY))?.proof).toEqual(new Uint8Array(98));
	});
});
