// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The second Solana endpoint the reads that no network signature covers are
 * cross-checked against.
 *
 * Most accounts this package reads carry the network's signature, so the
 * endpoint that serves them cannot forge them. A few reads carry none, and
 * one endpoint alone would decide what they say: the program's epoch
 * (`solanaCommitteeReader`), whether a network key is registered on a custom
 * network (`solanaNetworkKeyOutputRecordReader`), and whether a dWallet has a
 * public share attestation (`dwalletShareReader`). Each takes a required
 * {@link SolanaReadCrossCheck}: a second endpoint's `getAccount`, run by
 * another provider, or `'not-cross-checked'` to read through the first
 * endpoint alone. `readEncryptionKey` takes the same choice.
 *
 * The rules of the cross-check are `crossCheckedRead`'s in
 * `@ika.xyz/sdk-core`. `getAccount` reports no slot, so the slot rule the
 * Rust reader applies (re-read the lagging endpoint at the other's slot)
 * cannot run here. A read whose value only grows, the epoch, uses the value
 * itself as the position, so the endpoint with the lower value is read again
 * until it catches up. Every other read here is of an account that never
 * changes once written, and answers at one position: an endpoint that finds
 * nothing while the other finds the account is read again until the window
 * ends, and two different accounts are refused at once.
 */
import { crossCheckedRead } from '@ika.xyz/sdk-core';

import type { ReadAccount } from './usability.js';

/** One endpoint's read of one account by its 32-byte address; `null` when none exists. */
export type GetAccount = (address: Uint8Array) => Promise<ReadAccount | null>;

/**
 * A second endpoint's `getAccount`, run by another provider, that the reads
 * no network signature covers are cross-checked against, or
 * `'not-cross-checked'` to read them through the first endpoint alone.
 */
export type SolanaReadCrossCheck = { getAccount: GetAccount } | 'not-cross-checked';

/** The names the refusal of a cross-checked read gives the two endpoints. */
const ENDPOINT_NAMES = [
	'the first Solana endpoint (getAccount)',
	'the second Solana endpoint (crossCheck.getAccount)',
] as const;

/**
 * Throw unless `crossCheck` is a second endpoint's `{ getAccount }` or
 * `'not-cross-checked'`. `what` names the read in the error.
 */
export function assertSolanaReadCrossCheck(crossCheck: SolanaReadCrossCheck, what: string): void {
	if (crossCheck !== 'not-cross-checked' && typeof crossCheck?.getAccount !== 'function') {
		throw new Error(
			`the ${what} read needs crossCheck: a second endpoint's { getAccount }, or ` +
				"'not-cross-checked' to read it through one endpoint",
		);
	}
}

/**
 * What `read` decodes through `getAccount`, and through `crossCheck`'s
 * `getAccount` as well unless it is `'not-cross-checked'`, refused unless
 * both agree (`crossCheckedRead`). `read` resolves `undefined` when no
 * account is there. `position` gives the position of a decoded value, for a
 * value that only grows; without it every answer is at one position.
 */
export async function crossCheckedAccountRead<T>(params: {
	getAccount: GetAccount;
	crossCheck: SolanaReadCrossCheck;
	what: string;
	read: (getAccount: GetAccount) => Promise<T | undefined>;
	equal: (first: T, second: T) => boolean;
	position?: (value: T) => bigint;
}): Promise<T | undefined> {
	const { getAccount, crossCheck, what, read, equal, position } = params;
	assertSolanaReadCrossCheck(crossCheck, what);
	if (crossCheck === 'not-cross-checked') {
		return read(getAccount);
	}
	return crossCheckedRead({
		endpoints: ENDPOINT_NAMES,
		what,
		read: async (endpoint) => {
			const value = await read(endpoint === 0 ? getAccount : crossCheck.getAccount);
			return {
				position: value === undefined || position === undefined ? 0n : position(value),
				value,
			};
		},
		equal,
	});
}
