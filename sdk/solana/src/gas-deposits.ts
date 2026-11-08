// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The rules and events of a gas deposit on Solana that need no RPC client:
 * the client-side check of the network's minimum first deposit, and the
 * decoder of the program's deposit events.
 *
 * A gas deposit pays for the network's work for one request key. The
 * network sets two minimums on the coordinator (`readDWalletCoordinator`):
 * - the minimum first deposit: a create and every top-up must leave the
 *   deposit, net of its debt, at or above it in each coin, or the program
 *   refuses with `BelowMinimumDeposit`;
 * - the minimum balance: what the validators require before they accept a
 *   new request paid from the deposit. Each coin a top-up adds must also be
 *   zero or at least it, or the program refuses with `BelowMinimumTopUp`.
 *
 * Every create, reopen and top-up also pays the network's deposit fee in
 * SOL (`readDWalletCoordinator`'s `depositFee`). The program takes it out of
 * the SOL the instruction moves and credits the rest. The clients take the
 * amount to CREDIT and add the current fee themselves, so a caller names what
 * the deposit gets, and the minimums are checked on that amount.
 *
 * A withdrawal returns the whole deposit. The request is final: there is no
 * cancel. A payout that pays everything closes the deposit, and an owner who
 * wants to keep spending reopens it with a create, as its next life. The
 * network pays it with its own transaction, `SettleGasWithdrawal`: it takes
 * its charge first, then sends what is left, SOL to the owner and IKA to the
 * destination the request named. There is no claim step. While a request is
 * pending the program refuses a transfer of the deposit
 * (`TransferWhileWithdrawalPending`), and so does the client
 * ({@link checkTransferAllowed}).
 */
import type { GasDepositMinimum } from './accounts.js';
import { EVENT_INSTRUCTION_TAG, eventDiscriminator } from './wire-tables.js';

/**
 * A create or a top-up that would leave the deposit below the network's
 * minimum first deposit. The program would refuse it, so the client does
 * not build it.
 */
export class GasDepositBelowMinimumError extends Error {
	constructor(
		/** What the deposit would hold, net of debt, after the change. */
		readonly netAfter: { ika: bigint; sol: bigint },
		/** The minimum the coordinator records now. */
		readonly minimum: GasDepositMinimum,
	) {
		super(
			`the gas deposit would hold ${netAfter.ika} IKA base units and ${netAfter.sol} lamports ` +
				`net of debt, below the network's minimum first deposit of ${minimum.ika} IKA base ` +
				`units and ${minimum.sol} ` +
				`lamports (set at protocol version ${minimum.protocolVersion}); a create and every ` +
				'top-up must leave at least the minimum in each coin',
		);
		this.name = 'GasDepositBelowMinimumError';
	}
}

/**
 * Throw {@link GasDepositBelowMinimumError} unless `netAfter`, the deposit's
 * balance net of debt after a create or a top-up, reaches `minimum` in each
 * coin. A negative amount, from debt above the balance, counts as zero, as
 * the contracts count it: a zero minimum accepts it, and any other minimum
 * refuses it.
 */
export function checkMinFirstDeposit(
	netAfter: { ika: bigint; sol: bigint },
	minimum: GasDepositMinimum,
): void {
	if (atLeastZero(netAfter.ika) < minimum.ika || atLeastZero(netAfter.sol) < minimum.sol) {
		throw new GasDepositBelowMinimumError(netAfter, minimum);
	}
}

/** `amount`, or zero when it is negative. */
function atLeastZero(amount: bigint): bigint {
	return amount < 0n ? 0n : amount;
}

/**
 * A top-up whose amount in one coin is above zero and below the network's
 * minimum balance in that coin. The program would refuse it (`BelowMinimumTopUp`, 4078), so the client does not
 * build it.
 */
export class GasTopUpBelowMinimumError extends Error {
	constructor(
		/** The coin that is short: `'IKA'`, or the chain coin's smallest unit. */
		readonly coin: 'IKA' | 'lamports',
		/** What the top-up adds of that coin. */
		readonly amount: bigint,
		/** The minimum balance the chain records now. */
		readonly minimum: GasDepositMinimum,
	) {
		const minimumOfCoin = coin === 'IKA' ? minimum.ika : minimum.sol;
		super(
			`the top-up adds ${amount} ${coin}, below the network's minimum balance of ` +
				`${minimumOfCoin} ${coin} (set at protocol version ${minimum.protocolVersion}); ` +
				'each coin a top-up adds must be zero or at least the minimum balance in that coin',
		);
		this.name = 'GasTopUpBelowMinimumError';
	}
}

/**
 * Throw {@link GasTopUpBelowMinimumError} when `added`, what a top-up adds,
 * holds an amount above zero and below `minBalance` in its coin. Zero in a
 * coin adds nothing of it and is not checked, so a top-up of one coin checks
 * only that coin. IKA is checked first.
 */
export function checkMinTopUp(
	added: { ika: bigint; sol: bigint },
	minBalance: GasDepositMinimum,
): void {
	if (added.ika !== 0n && added.ika < minBalance.ika) {
		throw new GasTopUpBelowMinimumError('IKA', added.ika, minBalance);
	}
	if (added.sol !== 0n && added.sol < minBalance.sol) {
		throw new GasTopUpBelowMinimumError('lamports', added.sol, minBalance);
	}
}

/**
 * A create of a request key whose deposit is open, or pending its payout.
 * Only a closed deposit reopens, so the program would refuse the create
 * (`AccountAlreadyInitialized`) and the client does not build it. Top the
 * deposit up instead.
 */
export class GasDepositAlreadyOpenError extends Error {
	constructor(
		/** The deposit's current life. */
		readonly incarnation: bigint,
		readonly withdrawalPending: boolean,
	) {
		super(
			`the request key already has an open gas deposit (incarnation ${incarnation}` +
				`${withdrawalPending ? ', a withdrawal pending' : ''}); only a closed deposit reopens, ` +
				'so top it up instead',
		);
		this.name = 'GasDepositAlreadyOpenError';
	}
}

/**
 * A top-up, a withdrawal request or a transfer of a closed deposit. The
 * payout that paid everything ended its life, so the program would refuse
 * the call (`DepositClosed`, 4080) and the client does not build it. A
 * create reopens the deposit as its next life.
 */
export class GasDepositClosedError extends Error {
	constructor(
		/** The life that ended. */
		readonly incarnation: bigint,
		readonly action: 'top up' | 'request' | 'transfer',
	) {
		super(
			`the gas deposit is closed (incarnation ${incarnation} ended), so it cannot ` +
				`${action === 'top up' ? 'be topped up' : action === 'request' ? 'be requested' : 'be transferred'}; ` +
				`a create reopens it as incarnation ${incarnation + 1n}`,
		);
		this.name = 'GasDepositClosedError';
	}
}

/**
 * A withdrawal request or a transfer that names another life of the deposit
 * than the open one. The program would refuse it
 * (`GasDepositIncarnationMismatch`, 4081), so a call meant for a life that
 * ended never acts on the next one, and the client does not build it.
 */
export class GasDepositIncarnationMismatchError extends Error {
	constructor(
		/** The life the call names. */
		readonly expected: bigint,
		/** The deposit's open life. */
		readonly current: bigint,
	) {
		super(
			`the call names incarnation ${expected} of the gas deposit, but its open life is ` +
				`incarnation ${current}`,
		);
		this.name = 'GasDepositIncarnationMismatchError';
	}
}

/**
 * Throw {@link GasDepositClosedError} when `deposit`, as the client read it,
 * is closed, and {@link GasDepositIncarnationMismatchError} when `expected`
 * is given and is not its open life.
 */
export function checkDepositLife(
	deposit: { closed: boolean; incarnation: bigint },
	action: 'top up' | 'request' | 'transfer',
	expected?: bigint,
): void {
	if (deposit.closed) {
		throw new GasDepositClosedError(deposit.incarnation, action);
	}
	if (expected !== undefined && expected !== deposit.incarnation) {
		throw new GasDepositIncarnationMismatchError(expected, deposit.incarnation);
	}
}

/**
 * A transfer of a deposit whose withdrawal is pending. A request is final,
 * and only the network's payout ends it, so the program would refuse the
 * transfer (`TransferWhileWithdrawalPending`, 4079) and the client does not
 * build it.
 */
export class TransferWhileWithdrawalPendingError extends Error {
	constructor() {
		super(
			'the gas deposit has a pending withdrawal, so it cannot be transferred; ' +
				"a withdrawal request is final, and only the network's payout ends it",
		);
		this.name = 'TransferWhileWithdrawalPendingError';
	}
}

/**
 * Throw {@link TransferWhileWithdrawalPendingError} when `deposit`, as the
 * client read it, has a pending withdrawal.
 */
export function checkTransferAllowed(deposit: { withdrawalPending: boolean }): void {
	if (deposit.withdrawalPending) {
		throw new TransferWhileWithdrawalPendingError();
	}
}

/**
 * A deposit's state after a change: the first 90 bytes of every deposit
 * event. `sequence` grows by one on every change of the deposit, so a reader
 * applies a state only when its `sequence` is above the last one it holds.
 */
export interface GasDepositState {
	/** The request key the deposit pays for. */
	userPublicKey: Uint8Array;
	sequence: bigint;
	withdrawalSequence: bigint;
	ikaBalance: bigint;
	solBalance: bigint;
	ikaDebt: bigint;
	solDebt: bigint;
	withdrawalPending: boolean;
	/** The deposit's life, counted from 1 at the first create. */
	incarnation: bigint;
	/** Whether a payout that paid everything ended the deposit's life. */
	closed: boolean;
}

/**
 * One deposit event of the program, decoded. Amounts are IKA base units
 * (10^-8 IKA) and lamports.
 */
export type GasDepositEvent =
	| {
			kind: 'created';
			state: GasDepositState;
			owner: Uint8Array;
			ikaAmount: bigint;
			solAmount: bigint;
			epoch: bigint;
	  }
	| {
			kind: 'toppedUp';
			state: GasDepositState;
			ikaAmount: bigint;
			solAmount: bigint;
			epoch: bigint;
	  }
	| {
			kind: 'withdrawalRequested';
			state: GasDepositState;
			owner: Uint8Array;
			ikaDestination: Uint8Array;
			epoch: bigint;
	  }
	| {
			/** One charge of the deposit, the charge of a withdrawal's payout among them. */
			kind: 'settled';
			state: GasDepositState;
			ikaCharged: bigint;
			solCharged: bigint;
			ikaCollected: bigint;
			solCollected: bigint;
			epoch: bigint;
	  }
	| {
			/**
			 * The network paid the deposit out after its charge. What a
			 * destination could not take stayed in the deposit, as kept.
			 */
			kind: 'withdrawn';
			state: GasDepositState;
			owner: Uint8Array;
			ikaDestination: Uint8Array;
			ikaPaid: bigint;
			solPaid: bigint;
			ikaKept: bigint;
			solKept: bigint;
			epoch: bigint;
	  }
	| {
			/** The deposit did not cover the payout's charge; the request waits for a top-up. */
			kind: 'withdrawalShortOfCharge';
			state: GasDepositState;
			withdrawalSequence: bigint;
			ikaCharge: bigint;
			solCharge: bigint;
			epoch: bigint;
	  }
	| {
			/** No request was pending at the payout's counter: the deposit was charged and nothing was paid. */
			kind: 'withdrawalNotPaid';
			state: GasDepositState;
			withdrawalSequence: bigint;
			epoch: bigint;
	  }
	| {
			kind: 'transferred';
			state: GasDepositState;
			gasDeposit: Uint8Array;
			previousOwner: Uint8Array;
			newOwner: Uint8Array;
	  }
	| { kind: 'minFirstDepositSet'; minimum: GasDepositMinimum }
	| { kind: 'minBalanceSet'; minimum: GasDepositMinimum };

/** The length of the state at the front of every deposit event. */
const STATE_LEN = 90;
/** The tag and the event number before an event's fields. */
const PREFIX_LEN = EVENT_INSTRUCTION_TAG.length + 1;

/** Reads fields in order from one event's bytes after the prefix. */
class FieldReader {
	#offset = PREFIX_LEN;
	constructor(readonly data: Uint8Array) {}

	bytes(length: number): Uint8Array {
		const value = this.data.slice(this.#offset, this.#offset + length);
		this.#offset += length;
		return value;
	}

	u64(): bigint {
		const value = new DataView(
			this.data.buffer,
			this.data.byteOffset,
			this.data.byteLength,
		).getBigUint64(this.#offset, true);
		this.#offset += 8;
		return value;
	}

	flag(): boolean {
		return this.bytes(1)[0] !== 0;
	}

	state(): GasDepositState {
		return {
			userPublicKey: this.bytes(32),
			sequence: this.u64(),
			withdrawalSequence: this.u64(),
			ikaBalance: this.u64(),
			solBalance: this.u64(),
			ikaDebt: this.u64(),
			solDebt: this.u64(),
			withdrawalPending: this.flag(),
			incarnation: this.u64(),
			closed: this.flag(),
		};
	}

	minimum(): GasDepositMinimum {
		return { ika: this.u64(), sol: this.u64(), protocolVersion: this.u64() };
	}
}

/** Each deposit event's name in the wire tables, the length of its fields, and its decoder. */
const DEPOSIT_EVENTS: [string, number, (reader: FieldReader) => GasDepositEvent][] = [
	[
		'GasDepositCreated',
		STATE_LEN + 32 + 24,
		(r) => ({
			kind: 'created',
			state: r.state(),
			owner: r.bytes(32),
			ikaAmount: r.u64(),
			solAmount: r.u64(),
			epoch: r.u64(),
		}),
	],
	[
		'GasDeposited',
		STATE_LEN + 24,
		(r) => ({
			kind: 'toppedUp',
			state: r.state(),
			ikaAmount: r.u64(),
			solAmount: r.u64(),
			epoch: r.u64(),
		}),
	],
	[
		'GasWithdrawalRequested',
		STATE_LEN + 64 + 8,
		(r) => ({
			kind: 'withdrawalRequested',
			state: r.state(),
			owner: r.bytes(32),
			ikaDestination: r.bytes(32),
			epoch: r.u64(),
		}),
	],
	[
		'GasSettled',
		STATE_LEN + 40,
		(r) => ({
			kind: 'settled',
			state: r.state(),
			ikaCharged: r.u64(),
			solCharged: r.u64(),
			ikaCollected: r.u64(),
			solCollected: r.u64(),
			epoch: r.u64(),
		}),
	],
	[
		'GasWithdrawn',
		STATE_LEN + 64 + 40,
		(r) => ({
			kind: 'withdrawn',
			state: r.state(),
			owner: r.bytes(32),
			ikaDestination: r.bytes(32),
			ikaPaid: r.u64(),
			solPaid: r.u64(),
			ikaKept: r.u64(),
			solKept: r.u64(),
			epoch: r.u64(),
		}),
	],
	[
		'WithdrawalShortOfCharge',
		STATE_LEN + 32,
		(r) => ({
			kind: 'withdrawalShortOfCharge',
			state: r.state(),
			withdrawalSequence: r.u64(),
			ikaCharge: r.u64(),
			solCharge: r.u64(),
			epoch: r.u64(),
		}),
	],
	[
		'WithdrawalNotPaid',
		STATE_LEN + 16,
		(r) => ({
			kind: 'withdrawalNotPaid',
			state: r.state(),
			withdrawalSequence: r.u64(),
			epoch: r.u64(),
		}),
	],
	[
		'GasDepositTransferred',
		STATE_LEN + 96,
		(r) => ({
			kind: 'transferred',
			state: r.state(),
			gasDeposit: r.bytes(32),
			previousOwner: r.bytes(32),
			newOwner: r.bytes(32),
		}),
	],
	['MinFirstDepositSet', 24, (r) => ({ kind: 'minFirstDepositSet', minimum: r.minimum() })],
	['MinBalanceSet', 24, (r) => ({ kind: 'minBalanceSet', minimum: r.minimum() })],
];

/**
 * The deposit event in `data`, the data of one inner instruction that ran
 * the program, or `null` when it is not one: not an event, or another
 * event of the program. Throws for a deposit event of the wrong length.
 *
 * This reads bytes only. A caller that trusts the event must check that the
 * inner instruction ran the program and was signed by its event authority
 * (`eventAuthorityAddress`), and that the transaction succeeded.
 */
export function gasDepositEvent(data: Uint8Array): GasDepositEvent | null {
	if (
		data.length < PREFIX_LEN ||
		!EVENT_INSTRUCTION_TAG.every((byte, index) => data[index] === byte)
	) {
		return null;
	}
	const entry = DEPOSIT_EVENTS.find(
		([name]) => eventDiscriminator(name) === data[EVENT_INSTRUCTION_TAG.length],
	);
	if (entry === undefined) {
		return null;
	}
	const [name, length, decode] = entry;
	if (data.length !== PREFIX_LEN + length) {
		throw new Error(`a ${name} event is ${PREFIX_LEN + length} bytes, got ${data.length}`);
	}
	return decode(new FieldReader(data));
}

/**
 * The deposit events among `instructionData`, the data of a transaction's
 * inner instructions that ran the program, in order. Everything else is
 * skipped. The same checks as {@link gasDepositEvent} are the caller's.
 */
export function gasDepositEvents(instructionData: readonly Uint8Array[]): GasDepositEvent[] {
	return instructionData.flatMap((data) => {
		const event = gasDepositEvent(data);
		return event === null ? [] : [event];
	});
}
