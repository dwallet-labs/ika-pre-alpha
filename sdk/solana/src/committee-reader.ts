// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The Solana `CommitteeChainReader` of `@ika.xyz/pre-alpha-core`: the two reads of
 * Solana that the committee the network signed is checked against.
 *
 * - The chain's epoch is the program's `SystemState.epoch`, at byte offset 2 of
 *   the program's `SystemState` account. From protocol version 10 it is the
 *   network's epoch: the network ends an epoch when finalized Solana's epoch
 *   passes it. It is cross-checked against the second endpoint, on every
 *   network: no list fixes the epoch, and an endpoint that served an older
 *   one would let a former committee pass the check.
 * - A signer is registered when its `NetworkEncryptionKey` account exists,
 *   as for the signer of a network key's output record
 *   (`solanaNetworkKeyOutputRecordReader`), cross-checked on a custom network.
 *
 * The Rust client's `SolanaChain` in ika-solana-sdk makes the same two reads.
 */
import type { CommitteeChainReader, IkaNetwork } from '@ika.xyz/pre-alpha-core';

import { deriveAddress } from './addresses.js';
import { solanaNetworkKeyOutputRecordReader } from './network-key-output.js';
import { crossCheckedAccountRead } from './read-cross-check.js';
import type { GetAccount, SolanaReadCrossCheck } from './read-cross-check.js';
import { accountDataLen, accountDiscriminator } from './wire-tables.js';

/** The byte offset of `epoch` in the `SystemState` account. */
const SYSTEM_STATE_EPOCH = 2;

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * Build the reader over the program `programId`. `getAccount` reads one
 * account by its 32-byte address and resolves `null` when none exists (for
 * example a wrapper around `Connection.getAccountInfo`). `programId` comes
 * from the caller's own configuration, never from a served answer.
 *
 * `currentEpoch` rejects when the `SystemState` account is missing, is not
 * owned by `programId`, or does not read as a `SystemState`: its exact length
 * and its tag.
 *
 * `crossCheck` is a second endpoint's `getAccount`, run by another provider,
 * or `'not-cross-checked'` (`SolanaReadCrossCheck`). With a second endpoint
 * the epoch is read through both and refused unless both show the same one.
 * `getAccount` reports no slot, so the epoch itself is the position: the
 * epoch only grows, so the endpoint that shows the lower one is read again
 * until it catches up, or the window ends and the read is refused.
 *
 * `network` is the network the caller chose. On mainnet and testnet a signer
 * is registered only when `@ika.xyz/pre-alpha-core` lists it for the network, and
 * every signer is refused while the list is empty, because the new flow is
 * not deployed there yet.
 */
export function solanaCommitteeReader(
	programId: Uint8Array,
	getAccount: GetAccount,
	crossCheck: SolanaReadCrossCheck,
	network: IkaNetwork,
): CommitteeChainReader {
	const records = solanaNetworkKeyOutputRecordReader(programId, getAccount, crossCheck, network);
	const readEpoch = async (read: GetAccount): Promise<bigint | undefined> => {
		const account = await read(deriveAddress('SystemState', programId).address);
		if (account === null) {
			return undefined;
		}
		if (!sameBytes(account.owner, programId)) {
			throw new Error('the SystemState account is not owned by the ika protocol program');
		}
		if (
			account.data.length !== accountDataLen('SystemState') ||
			account.data[0] !== accountDiscriminator('SystemState')
		) {
			throw new Error('the SystemState account does not read as one');
		}
		return new DataView(
			account.data.buffer,
			account.data.byteOffset,
			account.data.byteLength,
		).getBigUint64(SYSTEM_STATE_EPOCH, true);
	};
	return {
		async currentEpoch() {
			const epoch = await crossCheckedAccountRead({
				getAccount,
				crossCheck,
				what: 'SystemState epoch',
				read: readEpoch,
				equal: (first, second) => first === second,
				position: (value) => value,
			});
			if (epoch === undefined) {
				throw new Error('no SystemState account at the address read');
			}
			return epoch;
		},
		isRegisteredNetworkKey(noaPublicKey) {
			return records.isRegisteredNetworkKey(noaPublicKey);
		},
	};
}
