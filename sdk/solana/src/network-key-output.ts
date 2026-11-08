// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The verified read of a network key's public outputs, against the records
 * the ika protocol program keeps on Solana.
 *
 * Two accounts are read, both at program addresses derived from the key's
 * public key:
 * - the key's `NetworkEncryptionKey` account (`["network_encryption_key",
 *   noa_public_key]`). It holds the Blake2b-256 digest of the key's DKG
 *   output, and the record's proof, empty while the record is unsigned.
 * - the record of each reshare, a `NetworkReconfigurationOutput` account
 *   (`["network_reconfig", noa_public_key, epoch as u64 LE]`). It holds the
 *   digest of the reshare output and the record's proof, empty while
 *   unsigned.
 *
 * A proof is the BCS of `VersionedAttestationProof`, which carries the signer
 * and the signature the check verifies. The reader hands the stored proof's
 * bytes to the check as they are.
 *
 * Every account read must be owned by the program, be of its type, and be
 * exactly its length; otherwise the read rejects.
 */
import {
	listedNetworkKey,
	listedNetworkKeyRecordReader,
	verifyNetworkKeyOutput,
} from '@ika.xyz/pre-alpha-core';
import type {
	IkaNetwork,
	NetworkKeyOutput,
	NetworkKeyOutputRecord,
	NetworkKeyOutputRecordReader,
} from '@ika.xyz/pre-alpha-core';

import { readNetworkEncryptionKey, readNetworkReconfigurationOutput } from './accounts.js';
import { networkEncryptionKeyPda, networkReconfigurationOutputPda } from './addresses.js';
import { assertSolanaReadCrossCheck, crossCheckedAccountRead } from './read-cross-check.js';
import type { GetAccount, SolanaReadCrossCheck } from './read-cross-check.js';
import { accountDataLen } from './wire-tables.js';

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * The proof a record stores, as stored: empty while unsigned. A proof length
 * above the slot (`null`) rejects.
 */
function storedProof(proof: Uint8Array | null): Uint8Array {
	if (proof === null) {
		throw new Error('the record stores a proof length above its slot');
	}
	return Uint8Array.from(proof);
}

/**
 * The `NetworkKeyOutputRecordReader` over the program `programId` on Solana.
 * `getAccount` reads one account by its 32-byte address and resolves `null`
 * when none exists (for example a wrapper around
 * `Connection.getAccountInfo`). `programId` comes from the caller's own
 * configuration, never from a served answer.
 *
 * `network` is the network the caller chose. On mainnet and testnet every
 * read is checked against the network keys `@ika.xyz/pre-alpha-core` lists
 * (`listedNetworkKeyRecordReader`): a key it does not list is refused, and is
 * not a registered signer; a key's account must be at the address the list
 * names and hold the DKG digest the list names. While the list is empty, the
 * new flow is not deployed there, and every read is refused. On a custom
 * network the reads are not checked against any list.
 *
 * `crossCheck` is a second endpoint's `getAccount`, run by another provider,
 * or `'not-cross-checked'` (`SolanaReadCrossCheck`). On a custom network
 * `isRegisteredNetworkKey` reads the key's account through both endpoints:
 * the key is registered only when both find the account with the same DKG
 * output digest, not registered only when both find none, and refused
 * otherwise. On mainnet and testnet the list already decides which keys are
 * registered, and a lying endpoint can only say a listed key's account is
 * absent, which refuses the signature, so the account is read through
 * `getAccount` alone.
 *
 * Every record is read through `getAccount`, and its stored proof is handed
 * to the check as it is. The check requires each record's proof, signed by a
 * registered network key, so no record digest is cross-checked against the
 * second endpoint; the signer's registration is, as above.
 */
export function solanaNetworkKeyOutputRecordReader(
	programId: Uint8Array,
	getAccount: GetAccount,
	crossCheck: SolanaReadCrossCheck,
	network: IkaNetwork,
): NetworkKeyOutputRecordReader {
	assertSolanaReadCrossCheck(crossCheck, 'network key registration');
	const custom = typeof network !== 'string';
	return listedNetworkKeyRecordReader(
		chainNetworkKeyOutputRecordReader(
			programId,
			getAccount,
			custom ? crossCheck : 'not-cross-checked',
		),
		network,
		'solana',
		(noaPublicKey) => networkEncryptionKeyPda(programId, noaPublicKey).address,
	);
}

/**
 * The reads of `solanaNetworkKeyOutputRecordReader`, before any check against
 * a list. `registrationCrossCheck` names the cross-check of
 * `isRegisteredNetworkKey`.
 */
function chainNetworkKeyOutputRecordReader(
	programId: Uint8Array,
	getAccount: GetAccount,
	registrationCrossCheck: SolanaReadCrossCheck,
): NetworkKeyOutputRecordReader {
	const readThrough = async <T>(
		readAccount: GetAccount,
		address: Uint8Array,
		name: string,
		decode: (data: Uint8Array) => T | null,
	): Promise<T | undefined> => {
		const account = await readAccount(address);
		if (account === null) {
			return undefined;
		}
		if (!sameBytes(account.owner, programId)) {
			throw new Error(`the ${name} account is not owned by the ika protocol program`);
		}
		const decoded = account.data.length === accountDataLen(name) ? decode(account.data) : null;
		if (decoded === null) {
			throw new Error(`the ${name} account does not read as one`);
		}
		return decoded;
	};
	const readKeyThrough = async (readAccount: GetAccount, noaPublicKey: Uint8Array) => {
		const key = await readThrough(
			readAccount,
			networkEncryptionKeyPda(programId, noaPublicKey).address,
			'NetworkEncryptionKey',
			readNetworkEncryptionKey,
		);
		if (key !== undefined && !sameBytes(key.noaPublicKey, noaPublicKey)) {
			throw new Error('the NetworkEncryptionKey account names another key');
		}
		return key;
	};
	const dkgRecordThrough = async (
		readAccount: GetAccount,
		noaPublicKey: Uint8Array,
	): Promise<NetworkKeyOutputRecord | undefined> => {
		const key = await readKeyThrough(readAccount, noaPublicKey);
		if (key === undefined) {
			return undefined;
		}
		return {
			digest: Uint8Array.from(key.dkgOutputDigest),
			proof: storedProof(key.proof),
		};
	};
	const reshareRecordThrough = async (
		readAccount: GetAccount,
		noaPublicKey: Uint8Array,
		epoch: bigint,
	): Promise<NetworkKeyOutputRecord | undefined> => {
		const record = await readThrough(
			readAccount,
			networkReconfigurationOutputPda(programId, noaPublicKey, epoch).address,
			'NetworkReconfigurationOutput',
			readNetworkReconfigurationOutput,
		);
		if (record === undefined) {
			return undefined;
		}
		if (!sameBytes(record.noaPublicKey, noaPublicKey) || record.epoch !== epoch) {
			throw new Error('the NetworkReconfigurationOutput account names another key or epoch');
		}
		return {
			digest: Uint8Array.from(record.digest),
			proof: storedProof(record.proof),
		};
	};
	return {
		async dkgRecord(noaPublicKey) {
			return dkgRecordThrough(getAccount, noaPublicKey);
		},
		async reconfigurationRecord(noaPublicKey, epoch) {
			return reshareRecordThrough(getAccount, noaPublicKey, epoch);
		},
		async isRegisteredNetworkKey(noaPublicKey) {
			if (noaPublicKey.length !== 32) {
				return false;
			}
			const key = await crossCheckedAccountRead({
				getAccount,
				crossCheck: registrationCrossCheck,
				what: 'NetworkEncryptionKey',
				read: (readAccount) => readKeyThrough(readAccount, noaPublicKey),
				equal: (first, second) =>
					sameBytes(first.noaPublicKey, second.noaPublicKey) &&
					sameBytes(first.dkgOutputDigest, second.dkgOutputDigest),
			});
			return key !== undefined;
		},
	};
}

/** Where the network key's outputs are served from: `DWalletGrpcClient` of `@ika.xyz/pre-alpha-core/client`. */
export interface NetworkKeyOutputSource {
	getNetworkKeyOutput(networkKeyIdentifier: Uint8Array): Promise<NetworkKeyOutput>;
}

/**
 * Read the network key `networkKeyId`'s public outputs from the validators,
 * and check them against the records the program keeps on Solana
 * (`verifyNetworkKeyOutput` of `@ika.xyz/pre-alpha-core`): the DKG digest, the
 * reshare digest of the epoch the validator serves, and each record's proof,
 * which must be signed by a network key registered on Solana. A record whose
 * proof is still empty is read again until the check's wait ends, and then
 * refused.
 *
 * `networkKeyId` is the key's public key, the key the caller trusts, and
 * `network` the network the caller chose. On mainnet and testnet it rejects,
 * before any read, a key that `@ika.xyz/pre-alpha-core` does not list for the
 * network, and every key while the list is empty, because the new flow is not
 * deployed there yet. The accounts are then checked against the list
 * (`solanaNetworkKeyOutputRecordReader`, which cross-checks the signer's
 * registration against `crossCheck` on a custom network). Rejects with a
 * `NetworkKeyOutputError` naming the failed check, or with the read's own
 * error.
 */
export async function readSolanaNetworkKeyOutputVerified(
	programId: Uint8Array,
	getAccount: GetAccount,
	crossCheck: SolanaReadCrossCheck,
	network: IkaNetwork,
	validators: NetworkKeyOutputSource,
	networkKeyId: Uint8Array,
): Promise<NetworkKeyOutput> {
	listedNetworkKey(network, networkKeyId);
	const records = solanaNetworkKeyOutputRecordReader(programId, getAccount, crossCheck, network);
	const served = await validators.getNetworkKeyOutput(networkKeyId);
	return verifyNetworkKeyOutput(served, networkKeyId, records);
}
