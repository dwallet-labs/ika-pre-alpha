// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The client side of a Solana gas deposit: the minimum first deposit is
 * checked before a create or a top-up is built, a withdrawal request takes
 * no amount, a transfer names the new owner, and the program's deposit
 * events decode.
 */
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import type { GasDepositAccount, GasDepositMinimum } from '../src/accounts.js';
import { gasDepositPda } from '../src/addresses.js';
import {
	checkMinFirstDeposit,
	checkMinTopUp,
	checkTransferAllowed,
	GasDepositAlreadyOpenError,
	GasDepositBelowMinimumError,
	GasDepositClosedError,
	gasDepositEvent,
	gasDepositEvents,
	GasDepositIncarnationMismatchError,
	GasTopUpBelowMinimumError,
	TransferWhileWithdrawalPendingError,
} from '../src/gas-deposits.js';
import { IkaTransaction } from '../src/web3/index.js';
import { EVENT_INSTRUCTION_TAG, eventDiscriminator, instructionByte } from '../src/wire-tables.js';

const programId = Keypair.generate().publicKey;
const owner = Keypair.generate().publicKey;
const requestPublicKey = new Uint8Array(32).fill(7);
const treasuryVault = new Uint8Array(32).fill(9);
const ikaTokenAccount = Keypair.generate().publicKey;
const depositAddress = new PublicKey(gasDepositPda(programId.toBytes(), requestPublicKey).address);

const FUNDED: GasDepositAccount = {
	userPublicKey: requestPublicKey,
	ikaBalance: 90n,
	solBalance: 60n,
	withdrawalSequence: 0n,
	ikaDebt: 5n,
	solDebt: 0n,
	sequence: 3n,
	owner: owner.toBytes(),
	withdrawalPending: false,
	ikaDestination: new Uint8Array(32),
	incarnation: 2n,
	closed: false,
};

/**
 * A transaction whose client reads `deposit` for the request key, the
 * minimum first deposit `minFirstDeposit` and the minimum balance
 * `minBalance`, none by default, and the deposit fee `fee`, paid to
 * `FEE_RECIPIENT`, none by default.
 */
function transactionOf(
	deposit: GasDepositAccount | null,
	minFirstDeposit: GasDepositMinimum,
	minBalance: GasDepositMinimum = { ika: 0n, sol: 0n, protocolVersion: 0n },
	fee = 0n,
) {
	const ikaClient = {
		programId,
		chainNumber: 9,
		networkValue: 3,
		getDWalletCoordinator: async () => ({
			treasuryVault,
			minFirstDeposit,
			minBalance,
			depositFee: { sol: fee, recipient: FEE_RECIPIENT.toBytes(), protocolVersion: 8n },
		}),
		getGasDeposit: async () => deposit,
	};
	return new IkaTransaction({
		ikaClient: ikaClient as never,
		transaction: new Transaction(),
		owner,
	});
}

const MINIMUM: GasDepositMinimum = { ika: 100n, sol: 50n, protocolVersion: 8n };

/** Where the tests' deposit fee goes. */
const FEE_RECIPIENT = Keypair.generate().publicKey;

/** The deposit after a payout that paid everything ended its life 2. */
const CLOSED: GasDepositAccount = {
	...FUNDED,
	ikaBalance: 0n,
	solBalance: 0n,
	ikaDebt: 0n,
	owner: new Uint8Array(32),
	closed: true,
};

/** The SOL a create or a top-up moves: its data's last eight bytes. */
function solMoved(data: Uint8Array): bigint {
	return new DataView(data.buffer, data.byteOffset, data.length).getBigUint64(
		data.length - 8,
		true,
	);
}

describe('checkMinFirstDeposit', () => {
	it('checks each coin on its own, and a zero minimum passes an empty deposit', () => {
		expect(() =>
			checkMinFirstDeposit({ ika: 1_000n, sol: 1n }, { ika: 0n, sol: 2n, protocolVersion: 8n }),
		).toThrow(GasDepositBelowMinimumError);
		expect(() =>
			checkMinFirstDeposit({ ika: 0n, sol: 0n }, { ika: 0n, sol: 0n, protocolVersion: 0n }),
		).not.toThrow();
	});

	it('counts a debt above the balance as zero, as the contracts do', () => {
		expect(() =>
			checkMinFirstDeposit({ ika: -5n, sol: 10n }, { ika: 0n, sol: 10n, protocolVersion: 8n }),
		).not.toThrow();
		expect(() =>
			checkMinFirstDeposit({ ika: 10n, sol: -5n }, { ika: 10n, sol: 0n, protocolVersion: 8n }),
		).not.toThrow();
		expect(() =>
			checkMinFirstDeposit({ ika: -5n, sol: 10n }, { ika: 1n, sol: 10n, protocolVersion: 8n }),
		).toThrow(GasDepositBelowMinimumError);
	});
});

describe('checkMinTopUp', () => {
	const minBalance: GasDepositMinimum = { ika: 50n, sol: 10n, protocolVersion: 8n };

	it('refuses a coin above zero and below the minimum balance', () => {
		expect(() => checkMinTopUp({ ika: 49n, sol: 10n }, minBalance)).toThrow(
			GasTopUpBelowMinimumError,
		);
		expect(() => checkMinTopUp({ ika: 49n, sol: 10n }, minBalance)).toThrow(
			"adds 49 IKA, below the network's minimum balance of 50 IKA",
		);
	});

	it('passes the minimum balance, and checks only the coin a top-up adds', () => {
		expect(() => checkMinTopUp({ ika: 50n, sol: 10n }, minBalance)).not.toThrow();
		expect(() => checkMinTopUp({ ika: 0n, sol: 10n }, minBalance)).not.toThrow();
		expect(() => checkMinTopUp({ ika: 50n, sol: 0n }, minBalance)).not.toThrow();
	});
});

describe('createFundedGasDeposit', () => {
	it('refuses amounts below the minimum first deposit, and names the minimum', async () => {
		const call = transactionOf(null, MINIMUM).createFundedGasDeposit({
			ikaTokenAccount,
			ikaAmount: 100n,
			solAmount: 49n,
			consented: { requestPublicKey, consent: new Uint8Array(64) },
		});
		await expect(call).rejects.toBeInstanceOf(GasDepositBelowMinimumError);
		await expect(call).rejects.toThrow(
			'minimum first deposit of 100 IKA base units and 50 lamports (set at protocol version 8)',
		);
	});

	it('funds the deposit as it creates it, from the coordinator treasury vault', async () => {
		const tx = await transactionOf(null, MINIMUM).createFundedGasDeposit({
			ikaTokenAccount,
			ikaAmount: 100n,
			solAmount: 50n,
			consented: { requestPublicKey, consent: new Uint8Array(64) },
		});
		const create = tx.instructions[1]!;
		expect(create.data[0]).toBe(instructionByte('DWalletCreateDeposit'));
		const amounts = new DataView(create.data.buffer, create.data.byteOffset, create.data.length);
		expect(amounts.getBigUint64(98, true)).toBe(100n);
		expect(amounts.getBigUint64(106, true)).toBe(50n);
		expect(create.keys[6]!.pubkey.equals(ikaTokenAccount)).toBe(true);
		expect(create.keys[7]!.pubkey.equals(new PublicKey(treasuryVault))).toBe(true);
	});
});

describe('topUpGasDeposit', () => {
	it('counts the minimum as a total net of debt: a top-up that leaves the deposit short is refused', async () => {
		// 90 + 10 - 5 = 95 IKA base units net of debt, below 100.
		await expect(
			transactionOf(FUNDED, MINIMUM).topUpGasDeposit({
				ikaTokenAccount,
				ikaAmount: 10n,
				solAmount: 0n,
				requestPublicKey,
			}),
		).rejects.toBeInstanceOf(GasDepositBelowMinimumError);
	});

	it('accepts a small top-up that brings the total to the minimum', async () => {
		const tx = await transactionOf(FUNDED, MINIMUM).topUpGasDeposit({
			ikaTokenAccount,
			ikaAmount: 15n,
			solAmount: 0n,
			requestPublicKey,
		});
		const topUp = tx.instructions[0]!;
		expect(topUp.data[0]).toBe(instructionByte('DWalletTopUp'));
		expect(topUp.keys[0]!.pubkey.equals(depositAddress)).toBe(true);
	});

	it('refuses a coin below the minimum balance, naming the coin, the amount and the minimum', async () => {
		const topUp = transactionOf(FUNDED, MINIMUM, {
			ika: 15n,
			sol: 10n,
			protocolVersion: 8n,
		}).topUpGasDeposit({
			ikaTokenAccount,
			ikaAmount: 15n,
			solAmount: 9n,
			requestPublicKey,
		});
		await expect(topUp).rejects.toBeInstanceOf(GasTopUpBelowMinimumError);
		await expect(topUp).rejects.toThrow(
			"adds 9 lamports, below the network's minimum balance of 10 lamports",
		);
	});

	it('refuses a request key with no deposit', async () => {
		await expect(
			transactionOf(null, MINIMUM).topUpGasDeposit({
				ikaTokenAccount,
				ikaAmount: 1_000n,
				solAmount: 1_000n,
				requestPublicKey,
			}),
		).rejects.toThrow('has no gas deposit');
	});
});

describe('the withdrawal request and the transfer', () => {
	it('requests the whole deposit as its owner, with no amount', async () => {
		const ikaDestination = Keypair.generate().publicKey;
		const tx = await transactionOf(FUNDED, MINIMUM).requestGasWithdrawal({
			ikaDestination,
			incarnation: FUNDED.incarnation,
			requestPublicKey,
		});
		const request = tx.instructions[0]!;
		expect(Array.from(request.data)).toEqual([
			instructionByte('DWalletRequestWithdraw'),
			2,
			0,
			0,
			0,
			0,
			0,
			0,
			0,
		]);
		expect(request.keys[0]).toMatchObject({ isSigner: true });
		expect(request.keys[0]!.pubkey.equals(owner)).toBe(true);
		expect(request.keys[1]!.pubkey.equals(depositAddress)).toBe(true);
		expect(request.keys[3]!.pubkey.equals(ikaDestination)).toBe(true);
	});

	it('hands the deposit to a new owner', async () => {
		const newOwner = Keypair.generate().publicKey;
		const tx = await transactionOf(FUNDED, MINIMUM).transferGasDeposit({
			newOwner,
			requestPublicKey,
		});
		const transfer = tx.instructions[0]!;
		expect(transfer.data[0]).toBe(instructionByte('DWalletTransferGasDeposit'));
		expect(Uint8Array.from(transfer.data.subarray(1, 33))).toEqual(newOwner.toBytes());
		// The deposit's own incarnation, read before the transfer is built.
		expect(Array.from(transfer.data.subarray(33))).toEqual([2, 0, 0, 0, 0, 0, 0, 0]);
		expect(transfer.keys[1]!.pubkey.equals(depositAddress)).toBe(true);
	});

	it('refuses a transfer while a withdrawal is pending, before building it', async () => {
		const pending: GasDepositAccount = {
			...FUNDED,
			withdrawalPending: true,
			withdrawalSequence: 1n,
		};
		const newOwner = Keypair.generate().publicKey;
		const transfer = transactionOf(pending, MINIMUM).transferGasDeposit({
			newOwner,
			requestPublicKey,
		});
		await expect(transfer).rejects.toBeInstanceOf(TransferWhileWithdrawalPendingError);
		await expect(transfer).rejects.toThrow('a withdrawal request is final');
		expect(() => checkTransferAllowed(FUNDED)).not.toThrow();
	});

	it('refuses a transfer of a request key with no deposit', async () => {
		const newOwner = Keypair.generate().publicKey;
		const transfer = transactionOf(null, MINIMUM).transferGasDeposit({
			newOwner,
			requestPublicKey,
		});
		await expect(transfer).rejects.toThrow('has no gas deposit');
	});
});

describe('the deposit fee', () => {
	it('adds the fee to the SOL a create sends, checks the minimum on what is credited, and pays the recorded recipient', async () => {
		const tx = await transactionOf(null, MINIMUM, undefined, 7n).createFundedGasDeposit({
			ikaTokenAccount,
			ikaAmount: 100n,
			solAmount: 50n,
			consented: { requestPublicKey, consent: new Uint8Array(64) },
		});
		const create = tx.instructions[1]!;
		expect(solMoved(create.data)).toBe(57n);
		expect(create.keys[11]!.pubkey.equals(FEE_RECIPIENT)).toBe(true);
		await expect(
			transactionOf(null, MINIMUM, undefined, 7n).createFundedGasDeposit({
				ikaTokenAccount,
				ikaAmount: 100n,
				solAmount: 49n,
				consented: { requestPublicKey, consent: new Uint8Array(64) },
			}),
		).rejects.toBeInstanceOf(GasDepositBelowMinimumError);
	});

	it('sends exactly the fee for a top-up of IKA alone', async () => {
		const tx = await transactionOf(FUNDED, MINIMUM, undefined, 7n).topUpGasDeposit({
			ikaTokenAccount,
			ikaAmount: 15n,
			solAmount: 0n,
			requestPublicKey,
		});
		const topUp = tx.instructions[0]!;
		expect(solMoved(topUp.data)).toBe(7n);
		expect(topUp.keys[9]!.pubkey.equals(FEE_RECIPIENT)).toBe(true);
	});
});

describe('the lives of a deposit', () => {
	it('reopens a closed deposit as its next life: the proof names incarnation 3', async () => {
		const tx = await transactionOf(CLOSED, MINIMUM).createFundedGasDeposit({
			ikaTokenAccount,
			ikaAmount: 100n,
			solAmount: 50n,
			consented: { requestPublicKey, consent: new Uint8Array(64) },
		});
		// The Ed25519 instruction ends with the signed message, whose last
		// eight bytes are the life it opens.
		const precompile = tx.instructions[0]!;
		expect(Array.from(precompile.data.subarray(precompile.data.length - 8))).toEqual([
			3, 0, 0, 0, 0, 0, 0, 0,
		]);
		expect(tx.instructions[1]!.data[0]).toBe(instructionByte('DWalletCreateDeposit'));
	});

	it('refuses a create of an open deposit', async () => {
		await expect(
			transactionOf(FUNDED, MINIMUM).createFundedGasDeposit({
				ikaTokenAccount,
				ikaAmount: 100n,
				solAmount: 50n,
				consented: { requestPublicKey, consent: new Uint8Array(64) },
			}),
		).rejects.toBeInstanceOf(GasDepositAlreadyOpenError);
	});

	it('refuses a top-up, a request and a transfer of a closed deposit', async () => {
		const ikaDestination = Keypair.generate().publicKey;
		const newOwner = Keypair.generate().publicKey;
		await expect(
			transactionOf(CLOSED, MINIMUM).topUpGasDeposit({
				ikaTokenAccount,
				ikaAmount: 1_000n,
				solAmount: 1_000n,
				requestPublicKey,
			}),
		).rejects.toBeInstanceOf(GasDepositClosedError);
		await expect(
			transactionOf(CLOSED, MINIMUM).requestGasWithdrawal({ ikaDestination, requestPublicKey }),
		).rejects.toThrow('a create reopens it as incarnation 3');
		await expect(
			transactionOf(CLOSED, MINIMUM).transferGasDeposit({ newOwner, requestPublicKey }),
		).rejects.toBeInstanceOf(GasDepositClosedError);
	});

	it('refuses a request and a transfer that name another life', async () => {
		const ikaDestination = Keypair.generate().publicKey;
		const newOwner = Keypair.generate().publicKey;
		const request = transactionOf(FUNDED, MINIMUM).requestGasWithdrawal({
			ikaDestination,
			incarnation: 1n,
			requestPublicKey,
		});
		await expect(request).rejects.toBeInstanceOf(GasDepositIncarnationMismatchError);
		await expect(request).rejects.toThrow('names incarnation 1');
		await expect(
			transactionOf(FUNDED, MINIMUM).transferGasDeposit({
				newOwner,
				incarnation: 1n,
				requestPublicKey,
			}),
		).rejects.toBeInstanceOf(GasDepositIncarnationMismatchError);
	});
});

/** The bytes of one event: the tag, the event's number, the fields. */
function eventBytes(name: string, ...fields: Uint8Array[]): Uint8Array {
	return Uint8Array.from([
		...EVENT_INSTRUCTION_TAG,
		eventDiscriminator(name),
		...fields.flatMap((f) => [...f]),
	]);
}

function u64(value: bigint): Uint8Array {
	const bytes = new Uint8Array(8);
	new DataView(bytes.buffer).setBigUint64(0, value, true);
	return bytes;
}

/**
 * A deposit state of 90 bytes: the key, then sequence 4, withdrawal sequence
 * 2, balances 30 and 40, debts 1 and 2, pending, incarnation 3, open.
 */
const STATE = Uint8Array.from([
	...requestPublicKey,
	...u64(4n),
	...u64(2n),
	...u64(30n),
	...u64(40n),
	...u64(1n),
	...u64(2n),
	1,
	...u64(3n),
	0,
]);

describe('gasDepositEvents', () => {
	it('names the events of a stale and a short payout by the numbers the program emits', () => {
		expect(eventDiscriminator('WithdrawalShortOfCharge')).toBe(129);
		expect(eventDiscriminator('WithdrawalNotPaid')).toBe(132);
	});

	it("decodes the program's deposit events in order, and skips what is not one", () => {
		const destination = new Uint8Array(32).fill(5);
		const events = gasDepositEvents([
			eventBytes('GasWithdrawalRequested', STATE, owner.toBytes(), destination, u64(11n)),
			new Uint8Array([1, 2, 3]),
			eventBytes('DWalletCommitted', new Uint8Array(10)),
			eventBytes('WithdrawalShortOfCharge', STATE, u64(2n), u64(7n), u64(8n), u64(11n)),
			eventBytes('GasSettled', STATE, u64(7n), u64(8n), u64(7n), u64(8n), u64(12n)),
			eventBytes('WithdrawalNotPaid', STATE, u64(1n), u64(12n)),
			eventBytes(
				'GasWithdrawn',
				STATE,
				owner.toBytes(),
				destination,
				u64(20n),
				u64(30n),
				u64(1n),
				u64(0n),
				u64(12n),
			),
			eventBytes('MinFirstDepositSet', u64(100n), u64(50n), u64(8n)),
		]);
		expect(events.map((event) => event.kind)).toEqual([
			'withdrawalRequested',
			'withdrawalShortOfCharge',
			'settled',
			'withdrawalNotPaid',
			'withdrawn',
			'minFirstDepositSet',
		]);
		expect(events[0]).toMatchObject({
			kind: 'withdrawalRequested',
			state: {
				sequence: 4n,
				withdrawalSequence: 2n,
				ikaBalance: 30n,
				solBalance: 40n,
				ikaDebt: 1n,
				solDebt: 2n,
				withdrawalPending: true,
				incarnation: 3n,
				closed: false,
			},
			ikaDestination: destination,
			epoch: 11n,
		});
		expect(events[1]).toMatchObject({ withdrawalSequence: 2n, ikaCharge: 7n, solCharge: 8n });
		expect(events[3]).toMatchObject({ withdrawalSequence: 1n, epoch: 12n });
		expect(events[4]).toMatchObject({ ikaPaid: 20n, solPaid: 30n, ikaKept: 1n, solKept: 0n });
		expect(events[5]).toEqual({
			kind: 'minFirstDepositSet',
			minimum: { ika: 100n, sol: 50n, protocolVersion: 8n },
		});
	});

	it('decodes the create, the top-up and the transfer', () => {
		const [created, toppedUp, transferred] = gasDepositEvents([
			eventBytes('GasDepositCreated', STATE, owner.toBytes(), u64(30n), u64(40n), u64(3n)),
			eventBytes('GasDeposited', STATE, u64(5n), u64(6n), u64(3n)),
			eventBytes(
				'GasDepositTransferred',
				STATE,
				depositAddress.toBytes(),
				owner.toBytes(),
				new Uint8Array(32).fill(4),
			),
		]);
		expect(created).toMatchObject({ kind: 'created', ikaAmount: 30n, solAmount: 40n });
		expect(toppedUp).toMatchObject({ kind: 'toppedUp', ikaAmount: 5n, solAmount: 6n });
		expect(transferred).toMatchObject({
			kind: 'transferred',
			newOwner: new Uint8Array(32).fill(4),
		});
	});

	it('refuses a deposit event of the wrong length', () => {
		expect(() => gasDepositEvent(eventBytes('WithdrawalNotPaid', STATE, u64(1n)))).toThrow(
			'a WithdrawalNotPaid event is 115 bytes, got 107',
		);
	});
});
