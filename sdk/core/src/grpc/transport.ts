// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The transport the dWallet gRPC client sends its calls through.
 *
 * The client keeps the rules every transport shares: it encodes each request,
 * decodes each answer, sends a request on to further validators, carries a
 * request across an epoch close, and repeats the read of the network keys.
 * A transport only moves one call's bytes to one validator and back. The Node
 * transport (`./node-transport.ts`) does that over grpc-js.
 */

import { isRefusal, RefusalCode } from './refusal-code.js';

/** The gRPC status codes the client's rules read. */
export const GrpcStatus = {
	DEADLINE_EXCEEDED: 4,
	NOT_FOUND: 5,
	FAILED_PRECONDITION: 9,
	UNAVAILABLE: 14,
} as const;

/** The answer to one unary call. */
export interface UnaryAnswer {
	/** The encoded answer message. */
	response: Uint8Array;
	/** The response headers the validator sent. */
	headers: Record<string, string>;
}

/**
 * One way to reach the client's validators. Validator 0 is the first
 * validator, and validator `i` is the `i`-th further validator.
 */
export interface DWalletTransport {
	/**
	 * Send one unary call of `method` of `ika.dwallet.v1alpha1.DWalletService`, with
	 * the encoded `request`, to the validator at `validatorIndex`. The call
	 * ends at `deadline`, a time in milliseconds. A transport that must first
	 * set up a pinned channel gives that setup its own window, and does not
	 * count the setup's time against `deadline`. It rejects with an error that
	 * carries the gRPC status `code` and its `details`.
	 */
	unary(
		validatorIndex: number,
		method: string,
		request: Uint8Array,
		deadline: number,
	): Promise<UnaryAnswer>;
	/** Close every connection. No call is started after it. */
	close(): void;
}

/**
 * The sentence a validator answers, with the gRPC status `UNAVAILABLE`, to a
 * request it refuses because the epoch is closing. From the epoch's cutoff
 * round on, the network starts no new session, and every request that
 * arrives or still waits is refused this way and charged nothing. The one
 * exception is `GAS_WAIT_ENDED_WITH_THE_EPOCH`. The node sends the same
 * sentence (`EPOCH_CLOSING_REFUSAL` in ika-core).
 */
export const EPOCH_CLOSING_REFUSAL = 'the epoch is closing; retry the request in the next epoch';

/**
 * The sentence a validator answers, with the gRPC status `UNAVAILABLE`, to a
 * request that was still waiting for its gas deposit to be read when the
 * epoch reached its cutoff round. It is the epoch-closing refusal for that
 * one case, and it is also charged nothing. The node sends the same sentence
 * (`GAS_WAIT_ENDED_WITH_THE_EPOCH` in ika-core).
 */
export const GAS_WAIT_ENDED_WITH_THE_EPOCH =
	'the epoch ended while this request waited for its gas deposit to be read; ' +
	'retry in the next epoch';

/**
 * Whether `error`, thrown by a gRPC call, is one of the validator's
 * epoch-closing refusals, with the status `UNAVAILABLE`. The status's refusal
 * code decides: `EPOCH_CLOSING` or `GAS_WAIT_ENDED_WITH_THE_EPOCH`. A status
 * with no code is read by its sentence: `EPOCH_CLOSING_REFUSAL` or
 * `GAS_WAIT_ENDED_WITH_THE_EPOCH`.
 */
export function isEpochClosingRefusal(error: unknown): boolean {
	const { code, details } = (error ?? {}) as { code?: number; details?: string };
	return (
		code === GrpcStatus.UNAVAILABLE &&
		isRefusal(
			error,
			[RefusalCode.EPOCH_CLOSING, RefusalCode.GAS_WAIT_ENDED_WITH_THE_EPOCH],
			() => details === EPOCH_CLOSING_REFUSAL || details === GAS_WAIT_ENDED_WITH_THE_EPOCH,
		)
	);
}

/**
 * The key of the flag a transport sets on the error of a pinned TLS setup
 * that failed for a reason other than a refused connection or a timeout: for
 * example a certificate the check refused, a server that does not speak TLS,
 * or a key reader that answered an error. Such an error carries
 * `UNAVAILABLE`, so that `submitTransaction` sends a request on to the next
 * validator, but it is not a transport failure.
 */
const REFUSED_PINNED_SETUP = Symbol('refused pinned setup');

/**
 * Mark `error` as a refused pinned setup. The flag is not enumerable, so the
 * error a caller sees has the same fields as before.
 */
export function markRefusedPinnedSetup(error: object): void {
	Object.defineProperty(error, REFUSED_PINNED_SETUP, { value: true });
}

/** Whether `error` was marked by `markRefusedPinnedSetup`. */
export function isRefusedPinnedSetup(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as { [REFUSED_PINNED_SETUP]?: boolean })[REFUSED_PINNED_SETUP] === true
	);
}

/**
 * The key of the second flag a transport sets on a refused pinned setup when
 * the client records the refusal, and passes the validator over for
 * `PIN_REFUSAL_MAX_AGE_MS`: the validator serves a key that is not the network
 * key of a member of a verified, fresh committee, or, for a validator pinned
 * to one `networkPublicKey`, a certificate under another key. The Rust
 * client's `NotACommitteeMember`. Every other refused setup (a chain read
 * that failed, a committee not signed in time, a lagging chain, a server
 * without TLS, a committee that does not verify) passes with time: it is
 * not tried again within the call, and the next call sets it up again.
 */
const NOT_A_COMMITTEE_MEMBER = Symbol('not a committee member');

/**
 * Mark `error`, a refused pinned setup, as a refusal of the validator's key
 * that the client records. It also gets `markRefusedPinnedSetup`'s flag.
 */
export function markNotACommitteeMember(error: object): void {
	markRefusedPinnedSetup(error);
	Object.defineProperty(error, NOT_A_COMMITTEE_MEMBER, { value: true });
}

/** Whether `error` was marked by `markNotACommitteeMember`. */
export function isNotACommitteeMember(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as { [NOT_A_COMMITTEE_MEMBER]?: boolean })[NOT_A_COMMITTEE_MEMBER] === true
	);
}

/**
 * The key of the flag the Node transport sets on the error of a pinned TLS
 * setup that reached no server: a socket of the setup was refused or timed
 * out (`hasTransportSocketCause` in `./node-transport.ts`). Its details are
 * the setup's own text, such as "reading the TLS certificate of <endpoint>
 * failed: connect ECONNREFUSED ...", so the flag, not the text, tells a
 * caller the call reached no server. A refused key and a committee that
 * does not verify are answers, and are never flagged.
 */
const PINNED_SETUP_REACHED_NO_SERVER = Symbol('pinned setup reached no server');

/**
 * Mark `error`, a failed pinned setup, as one that reached no server. The
 * flag is not enumerable, so the error a caller sees has the same fields as
 * before.
 */
export function markPinnedSetupReachedNoServer(error: object): void {
	Object.defineProperty(error, PINNED_SETUP_REACHED_NO_SERVER, { value: true });
}

/** Whether `error` was marked by `markPinnedSetupReachedNoServer`. */
export function isPinnedSetupThatReachedNoServer(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as { [PINNED_SETUP_REACHED_NO_SERVER]?: boolean })[PINNED_SETUP_REACHED_NO_SERVER] ===
			true
	);
}

/** The error of a call on a client after its `close()`. */
export function closedClientError(): Error {
	return new Error('the client is closed');
}

/**
 * Wait for `work`, but throw `outOfTime()` once `deadline` passes first. A
 * `work` that never settles then no longer holds its caller past the
 * deadline. The deadline's timer does not keep a Node process alive by
 * itself: a script that has nothing else left to do exits without waiting
 * for it.
 */
export async function beforeDeadline<T>(
	work: Promise<T>,
	deadline: number,
	outOfTime: () => Error,
): Promise<T> {
	// `work` may reject after this returns, for example a pinned setup that
	// finishes after its call's deadline and closes its own channel. Nothing
	// else may wait on it then, and Node ends the process on a rejection no
	// one observes. So its rejection is observed here, on every path.
	work.catch(() => {});
	const remaining = deadline - Date.now();
	if (remaining <= 0) {
		throw outOfTime();
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(outOfTime()), remaining);
		// A browser's `setTimeout` returns a number, which has no `unref`.
		timer.unref?.();
	});
	try {
		return await Promise.race([work, timedOut]);
	} finally {
		clearTimeout(timer);
	}
}
