// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The typed codes of the refusals a client acts on.
 *
 * A validator sends a code beside the refusal's sentence: in a
 * `TransactionResponse`'s `refusal_code`, or, for a refusal answered as a gRPC
 * status, in the status's details as a `RefusalDetails` message. The sentence
 * is unchanged. A validator built before the code existed sends none, so a
 * client that finds no code reads the sentence, as it did before.
 */

/**
 * The numbers of the proto enum `RefusalCode` (`proto/ika_dwallet.proto`),
 * without its `REFUSAL_CODE_` prefix. The Rust copy is `RefusalCode` in
 * ika-types.
 */
export const RefusalCode = {
	UNSPECIFIED: 0,
	EPOCH_CLOSING: 1,
	GAS_WAIT_ENDED_WITH_THE_EPOCH: 2,
	GAS_DEPOSIT_SNAPSHOT_STALE: 3,
	GAS_WAIT_FULL: 4,
	GAS_WAIT_FULL_FOR_KEY: 5,
	NO_GAS_DEPOSIT: 6,
	GAS_DEPOSIT_SHORT: 7,
	GAS_DEPOSIT_BELOW_MIN_BALANCE: 8,
	GAS_DEPOSIT_WITHDRAWAL_PENDING: 9,
	GAS_DEPOSIT_CLOSED: 10,
	GAS_DEPOSIT_PAID_OUT_THIS_EPOCH: 11,
	PRESIGN_POOL_EMPTY: 12,
	REQUEST_EPOCH_MISMATCH: 13,
	REQUEST_EPOCH_NOT_ENTERED_YET: 14,
	TOO_MANY_PENDING_PRECHECKS: 15,
	TOO_MANY_CHAIN_READS: 16,
	DOES_NOT_READ_SOLANA: 17,
} as const;

/**
 * The key under which an answer or an error keeps the refusal code the
 * validator sent with it. The property is not enumerable, so the object a
 * caller sees has the same fields as before.
 */
const REFUSAL_CODE = Symbol('refusal code');

/**
 * Keep `code` on `target`: an `Error` answer, or the error of a gRPC status.
 * `RefusalCode.UNSPECIFIED` keeps nothing.
 */
export function markRefusalCode(target: object, code: number): void {
	if (code === RefusalCode.UNSPECIFIED) {
		return;
	}
	Object.defineProperty(target, REFUSAL_CODE, { value: code });
}

/** The refusal code kept on `value`, or `RefusalCode.UNSPECIFIED` when it keeps none. */
export function refusalCodeOf(value: unknown): number {
	if (typeof value !== 'object' || value === null) {
		return RefusalCode.UNSPECIFIED;
	}
	return (value as { [REFUSAL_CODE]?: number })[REFUSAL_CODE] ?? RefusalCode.UNSPECIFIED;
}

/**
 * Whether `value`, an answer or an error, is one of the refusals `codes`.
 * When `value` keeps a code, the code decides. When it keeps none, as from a
 * validator built before the code existed, `sentenceMatches` decides.
 */
export function isRefusal(
	value: unknown,
	codes: readonly number[],
	sentenceMatches: () => boolean,
): boolean {
	const code = refusalCodeOf(value);
	return code === RefusalCode.UNSPECIFIED ? sentenceMatches() : codes.includes(code);
}
