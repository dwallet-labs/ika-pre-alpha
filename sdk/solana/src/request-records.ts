// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The Solana reads that find a request's session once its epoch closed
 * before an answer (`RequestRecordReader` in `@ika.xyz/pre-alpha-core/common`).
 *
 * Every read goes through `getAccount`, cross-checked against the second
 * endpoint when one is set: an endpoint that hid a record would make the SDK
 * send a request again that already ran.
 */
import type { RequestRecordReader } from '@ika.xyz/pre-alpha-core/common';

import {
	FUTURE_SIGNATURE_VOUCHER_SETTLED_WITHOUT_DELIVERY,
	readFutureSignatureVoucherUnverified,
	readSignatureVoucherUnverified,
} from './accounts.js';
import { gasChargePda } from './addresses.js';
import { crossCheckedAccountRead } from './read-cross-check.js';
import type { GetAccount, SolanaReadCrossCheck } from './read-cross-check.js';

export function solanaRequestRecordReader(
	programId: Uint8Array,
	getAccount: GetAccount,
	crossCheck: SolanaReadCrossCheck,
): RequestRecordReader {
	return {
		// A charge record's address is derived from its charge id alone, and
		// only the program can create an account there. Nothing closes it.
		async hasGasCharge(_transportKey, chargeId) {
			const address = gasChargePda(programId, chargeId).address;
			const found = await crossCheckedAccountRead({
				getAccount,
				crossCheck,
				what: 'a gas charge record',
				read: async (get) => ((await get(address)) === null ? undefined : true),
				equal: (first, second) => first === second,
			});
			return found === true;
		},
		async voucherSignature(voucher) {
			const signature = await crossCheckedAccountRead({
				getAccount,
				crossCheck,
				what: "a voucher's signature",
				read: async (get) => {
					const account = await get(voucher);
					const read = account === null ? null : readSignatureVoucherUnverified(account.data);
					return read === null || read.signature.length === 0
						? undefined
						: Uint8Array.from(read.signature);
				},
				equal: sameBytes,
			});
			return signature ?? null;
		},
		async futureVoucher(voucher) {
			const state = await crossCheckedAccountRead({
				getAccount,
				crossCheck,
				what: 'a future signature voucher',
				read: async (get) => {
					const account = await get(voucher);
					const read = account === null ? null : readFutureSignatureVoucherUnverified(account.data);
					if (read === null) return undefined;
					return {
						// The stored attestation fields open with the step's
						// 32-byte session identifier.
						stepOneSession: read.hasPartialSignature
							? Uint8Array.from(read.attestation.subarray(0, 32))
							: null,
						signature: read.signature.length === 0 ? null : Uint8Array.from(read.signature),
						closed: read.status === FUTURE_SIGNATURE_VOUCHER_SETTLED_WITHOUT_DELIVERY,
					};
				},
				equal: (first, second) =>
					sameOrBothNull(first.stepOneSession, second.stepOneSession) &&
					sameOrBothNull(first.signature, second.signature) &&
					first.closed === second.closed,
			});
			return state ?? null;
		},
	};
}

function sameBytes(first: Uint8Array, second: Uint8Array): boolean {
	return first.length === second.length && first.every((byte, index) => byte === second[index]);
}

function sameOrBothNull(first: Uint8Array | null, second: Uint8Array | null): boolean {
	return first === null || second === null ? first === second : sameBytes(first, second);
}
