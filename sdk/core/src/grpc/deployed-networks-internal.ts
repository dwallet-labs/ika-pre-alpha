// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The forms of the deployed-network checks that take a network's table as an
 * argument. The public functions of `./deployed-networks.ts` call them with
 * `IKA_DEPLOYED_NETWORKS`, and tests call them with a table built for the
 * test.
 *
 * The package does not export this module. A caller that could pass its own
 * table could make a `TrustedNetworkKeys` labelled mainnet or testnet out of
 * keys this SDK does not list.
 */
import type {
	DeployedNetwork,
	DeployedNetworkKey,
	DeployedNetworkName,
	IkaNetwork,
	NetworkKeyRecordChain,
	TrustedNetworkKeys,
} from './deployed-networks.js';
import type { NetworkKeyOutputRecord, NetworkKeyOutputRecordReader } from './network-key-output.js';

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function notDeployed(name: DeployedNetworkName): Error {
	return new Error(
		`the new flow is not deployed on ${name} yet: this SDK lists no network key for ${name}`,
	);
}

/**
 * The entry `table` lists for the network key `noaPublicKey` of the deployed
 * network `name`. Throws when the table lists no key at all, because the new
 * flow is not deployed there yet, and when it does not list this key.
 */
export function listedNetworkKeyIn(
	table: DeployedNetwork,
	name: DeployedNetworkName,
	noaPublicKey: Uint8Array,
): DeployedNetworkKey {
	if (table.networkKeys.length === 0) {
		throw notDeployed(name);
	}
	const entry = table.networkKeys.find((key) => equalBytes(key.noaPublicKey, noaPublicKey));
	if (entry === undefined) {
		throw new Error(`network key ${toHex(noaPublicKey)} is not a network key of ${name}`);
	}
	return entry;
}

/**
 * The check of an attestation's network key (`verifyAttestationNetworkKey`
 * of `./attestation-record.ts`), with `tables` as the deployed networks'
 * lists. Returns why the key is refused, or `undefined` when it passes; the
 * caller throws the refusal as an `AttestationRecordError` on the field
 * `network_pubkey`. It returns the reason instead of throwing so that this
 * module does not import `./attestation-record.ts`, which imports it.
 *
 * The checks, in order:
 * 1. When `trustedNetworkKeys` is given, `networkPubkey` is one of its keys.
 * 2. `networkPubkey` is `expectedNetworkKeyId`.
 * 3. On mainnet and testnet, `expectedNetworkKeyId` is a key the network's
 *    list holds (`listedNetworkKeyIn`), on every call, with or without
 *    `trustedNetworkKeys`. A custom network has no list.
 */
export function attestationNetworkKeyRefusalIn(
	tables: Readonly<Record<DeployedNetworkName, DeployedNetwork>>,
	networkPubkey: ArrayLike<number>,
	expectedNetworkKeyId: ArrayLike<number>,
	network: IkaNetwork,
	trustedNetworkKeys?: TrustedNetworkKeys,
): string | undefined {
	const named = Uint8Array.from(networkPubkey);
	const expected = Uint8Array.from(expectedNetworkKeyId);
	if (
		trustedNetworkKeys !== undefined &&
		!trustedNetworkKeys.publicKeys.some((key) => equalBytes(Uint8Array.from(key), named))
	) {
		return "the attestation's network_pubkey is not a network key the caller trusts";
	}
	if (!equalBytes(named, expected)) {
		return "the attestation's network_pubkey is not the network key the request uses";
	}
	if (typeof network === 'string') {
		try {
			listedNetworkKeyIn(tables[network], network, expected);
		} catch (error) {
			return (
				"the attestation's network_pubkey is not a network key this SDK lists for the " +
				`network: ${(error as Error).message}`
			);
		}
	}
	return undefined;
}

/**
 * The trusted network keys of `table`, the table of the deployed network
 * `name`. Throws when the table lists no key, because the new flow is not
 * deployed there yet.
 */
export function trustedNetworkKeysIn(
	table: DeployedNetwork,
	name: DeployedNetworkName,
): TrustedNetworkKeys {
	if (table.networkKeys.length === 0) {
		throw notDeployed(name);
	}
	return Object.freeze({
		network: name,
		publicKeys: Object.freeze(table.networkKeys.map((key) => Uint8Array.from(key.noaPublicKey))),
	}) as TrustedNetworkKeys;
}

/**
 * Wrap `reader`, the reader of a network key's records on `chain`, so that
 * on a deployed network every record is checked against `table`, the table
 * of the network `name`:
 * - the DKG record is read only for a listed key, only at the address the
 *   table lists for it on `chain` (`recordAddress` derives the address the
 *   reader reads), and must hold the DKG digest the table lists;
 * - a reshare record is read only for a listed key;
 * - a signer is a registered network key only when the table lists it.
 *
 * Every refusal throws. A table that lists no key refuses everything,
 * because the new flow is not deployed there yet.
 */
export function listedNetworkKeyRecordReaderIn(
	reader: NetworkKeyOutputRecordReader,
	table: DeployedNetwork,
	name: DeployedNetworkName,
	chain: NetworkKeyRecordChain,
	recordAddress: (noaPublicKey: Uint8Array) => Uint8Array,
): NetworkKeyOutputRecordReader {
	const listedAt = (noaPublicKey: Uint8Array): DeployedNetworkKey => {
		const entry = listedNetworkKeyIn(table, name, noaPublicKey);
		const listedAddress = chain === 'sui' ? entry.suiRecordAddress : entry.solanaRecordAddress;
		if (!equalBytes(recordAddress(noaPublicKey), listedAddress)) {
			throw new Error(
				`the ${chain} record of network key ${toHex(noaPublicKey)} is not at the address ` +
					`this SDK lists for ${name}`,
			);
		}
		return entry;
	};
	return {
		async dkgRecord(noaPublicKey: Uint8Array): Promise<NetworkKeyOutputRecord | undefined> {
			const entry = listedAt(noaPublicKey);
			const record = await reader.dkgRecord(noaPublicKey);
			if (record !== undefined && !equalBytes(record.digest, entry.dkgOutputDigest)) {
				throw new Error(
					`the ${chain} record of network key ${toHex(noaPublicKey)} holds another DKG ` +
						`output digest than the one this SDK lists for ${name}`,
				);
			}
			return record;
		},
		async reconfigurationRecord(
			noaPublicKey: Uint8Array,
			epoch: bigint,
		): Promise<NetworkKeyOutputRecord | undefined> {
			listedAt(noaPublicKey);
			return reader.reconfigurationRecord(noaPublicKey, epoch);
		},
		async isRegisteredNetworkKey(noaPublicKey: Uint8Array): Promise<boolean> {
			if (table.networkKeys.length === 0) {
				throw notDeployed(name);
			}
			if (!table.networkKeys.some((key) => equalBytes(key.noaPublicKey, noaPublicKey))) {
				return false;
			}
			return reader.isRegisteredNetworkKey(noaPublicKey);
		},
	};
}
