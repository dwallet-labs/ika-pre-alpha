// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The network keys and chain numbers of the ika networks this SDK ships,
 * and the set of network keys a caller trusts.
 *
 * Every record check in the new flow verifies a network signature under a
 * trusted network key. On mainnet and testnet those keys are the ones listed
 * here, and nothing else is trusted: a chain node or RPC that served another
 * key, or another record of a listed key, is refused. On a local network or
 * any other network, the caller passes its own keys (`{ custom }`).
 *
 * The caller chooses the network. It is never taken from an RPC: an RPC that
 * could name the network could also name a network without a list.
 *
 * The new flow is not deployed on mainnet or testnet yet. So both lists are
 * empty, and every mainnet and testnet path that needs a network key refuses
 * until the deploy fills them. Testnet lists no chain number for the same
 * reason. A network key is never removed from a list: a dWallet keeps
 * the key it was created under.
 */
import {
	listedNetworkKeyIn,
	listedNetworkKeyRecordReaderIn,
	notDeployed,
	trustedNetworkKeysIn,
} from './deployed-networks-internal.js';
import type { NetworkKeyOutputRecordReader } from './network-key-output.js';

/** The networks whose network keys this SDK lists. */
export type DeployedNetworkName = 'mainnet' | 'testnet';

/**
 * The network a caller works on: mainnet or testnet, whose network keys this
 * SDK lists, or a custom network (a local network, or any other) whose
 * network keys the caller supplies, each a 32-byte network public key.
 */
export type IkaNetwork =
	DeployedNetworkName | { custom: { networkPublicKeys: readonly Uint8Array[] } };

/** One network key deployed on a network, as this SDK lists it. Every field is 32 bytes. */
export interface DeployedNetworkKey {
	/** The key's Ed25519 public key, which is also its network key id. */
	noaPublicKey: Uint8Array;
	/** The Blake2b-256 digest of the key's network DKG output, fixed when the key was created. */
	dkgOutputDigest: Uint8Array;
	/** The id of the key's `NetworkEncryptionKey` object on Sui. */
	suiRecordAddress: Uint8Array;
	/** The address of the key's `NetworkEncryptionKey` account on Solana. */
	solanaRecordAddress: Uint8Array;
}

/** What this SDK ships for one network. */
export interface DeployedNetwork {
	/** Every network key deployed on the network, oldest first. */
	networkKeys: readonly DeployedNetworkKey[];
	/**
	 * The network's value, which every coordinator of the network records
	 * and which a holder's encryption key registration and a gas deposit's
	 * proof of possession carry after the chain number: 1 mainnet, 2
	 * testnet. A local network is 3. A chain number is the same on every
	 * network, so this value is what keeps a testnet signature from
	 * verifying on mainnet.
	 */
	network: number;
	/**
	 * The chain number of the network's Sui chain: the fixed number the
	 * protocol config gives it, which the Sui coordinator records and which a
	 * holder's encryption key registration and a gas deposit's proof of
	 * possession sign. Zero, which no chain holds, while the network is not
	 * deployed on Sui.
	 */
	suiChainNumber: number;
	/**
	 * The chain number of the network's Solana chain, which the Solana
	 * coordinator records. Zero while the network is not deployed on Solana.
	 */
	solanaChainNumber: number;
}

/**
 * The network keys and chain numbers this SDK ships. Both key lists are
 * empty until the new flow is deployed on the network. A release that adds a
 * key keeps every older key. Mainnet's chain numbers are the ones the
 * protocol config gives Sui (2) and Solana (1), the same on every network.
 */
export const IKA_DEPLOYED_NETWORKS: Readonly<Record<DeployedNetworkName, DeployedNetwork>> =
	Object.freeze({
		mainnet: Object.freeze({
			networkKeys: Object.freeze([]),
			network: 1,
			suiChainNumber: 2,
			solanaChainNumber: 1,
		}),
		testnet: Object.freeze({
			networkKeys: Object.freeze([]),
			network: 2,
			suiChainNumber: 0,
			solanaChainNumber: 0,
		}),
	});

/** The custom network's keys, or `undefined` for mainnet and testnet. */
function customKeys(network: IkaNetwork): readonly Uint8Array[] | undefined {
	return typeof network === 'string' ? undefined : network.custom.networkPublicKeys;
}

/**
 * The entry this SDK lists for the network key `noaPublicKey` on `network`.
 * `undefined` on a custom network, which has no list. On mainnet and testnet
 * it throws when the key is not listed, and when no key is listed because the
 * new flow is not deployed there yet.
 */
export function listedNetworkKey(
	network: IkaNetwork,
	noaPublicKey: Uint8Array,
): DeployedNetworkKey | undefined {
	return typeof network === 'string'
		? listedNetworkKeyIn(IKA_DEPLOYED_NETWORKS[network], network, noaPublicKey)
		: undefined;
}

/**
 * The network value the coordinators of `name` record and the signed
 * messages carry: 1 mainnet, 2 testnet. A local network is 3; set it from
 * your own configuration.
 */
export function deployedNetworkValue(name: DeployedNetworkName): number {
	return IKA_DEPLOYED_NETWORKS[name].network;
}

/**
 * The chain number the Sui coordinator of `name` records, as this SDK ships
 * it. Throws while it is zero, because the new flow is not deployed there
 * yet.
 */
export function deployedSuiChainNumber(name: DeployedNetworkName): number {
	const chainNumber = IKA_DEPLOYED_NETWORKS[name].suiChainNumber;
	if (chainNumber === 0) {
		throw notDeployed(name);
	}
	return chainNumber;
}

/**
 * The chain number the Solana coordinator of `name` records, as this SDK
 * ships it. Throws while it is zero, because the new flow is not deployed
 * there yet.
 */
export function deployedSolanaChainNumber(name: DeployedNetworkName): number {
	const chainNumber = IKA_DEPLOYED_NETWORKS[name].solanaChainNumber;
	if (chainNumber === 0) {
		throw notDeployed(name);
	}
	return chainNumber;
}

declare const trustedNetworkKeysBrand: unique symbol;

/**
 * The network keys a caller trusts as the signer of a record or an answer,
 * each a 32-byte network public key, with the network they belong to. Only
 * `trustedNetworkKeys` makes one, so on mainnet and testnet the set is
 * always the keys this SDK lists.
 */
export type TrustedNetworkKeys = {
	readonly network: IkaNetwork;
	readonly publicKeys: readonly Uint8Array[];
	readonly [trustedNetworkKeysBrand]: true;
};

/**
 * The network keys a caller trusts on `network`.
 *
 * - On mainnet and testnet: every key this SDK lists for the network. It
 *   throws while the list is empty, because the new flow is not deployed
 *   there yet.
 * - On a custom network: a copy of the caller's keys. Each must be 32 bytes.
 *   An empty set is allowed, and every record check under it refuses.
 */
export function trustedNetworkKeys(network: IkaNetwork): TrustedNetworkKeys {
	const custom = customKeys(network);
	if (custom === undefined) {
		const name = network as DeployedNetworkName;
		return trustedNetworkKeysIn(IKA_DEPLOYED_NETWORKS[name], name);
	}
	const publicKeys = custom.map((key) => {
		if (key.length !== 32) {
			throw new Error(`a trusted network key is 32 bytes, got ${key.length}`);
		}
		return Uint8Array.from(key);
	});
	const customNetwork: IkaNetwork = { custom: { networkPublicKeys: publicKeys } };
	return Object.freeze({
		network: customNetwork,
		publicKeys: Object.freeze(publicKeys),
	}) as TrustedNetworkKeys;
}

/**
 * A copy of `keys` whose byte arrays are new, so that a check that keeps it
 * is not changed by a caller that later writes into the arrays it passed.
 */
export function copyTrustedNetworkKeys(keys: TrustedNetworkKeys): TrustedNetworkKeys {
	const network =
		typeof keys.network === 'string'
			? keys.network
			: {
					custom: {
						networkPublicKeys: keys.network.custom.networkPublicKeys.map((key) =>
							Uint8Array.from(key),
						),
					},
				};
	return Object.freeze({
		network,
		publicKeys: Object.freeze(keys.publicKeys.map((key) => Uint8Array.from(key))),
	}) as TrustedNetworkKeys;
}

/** The chain whose record of a network key a reader reads. */
export type NetworkKeyRecordChain = 'sui' | 'solana';

/**
 * Wrap `reader`, the reader of a network key's records on `chain`, so that
 * on mainnet and testnet every record is checked against this SDK's list for
 * `network`:
 * - the DKG record is read only for a listed key, only at the address the
 *   list holds for it on `chain` (`recordAddress` derives the address the
 *   reader reads), and must hold the DKG digest the list holds;
 * - a reshare record is read only for a listed key;
 * - a signer is a registered network key only when the list holds it.
 *
 * Every refusal throws. While the list is empty everything is refused,
 * because the new flow is not deployed there yet. On a custom network it is
 * `reader` unchanged.
 */
export function listedNetworkKeyRecordReader(
	reader: NetworkKeyOutputRecordReader,
	network: IkaNetwork,
	chain: NetworkKeyRecordChain,
	recordAddress: (noaPublicKey: Uint8Array) => Uint8Array,
): NetworkKeyOutputRecordReader {
	return typeof network === 'string'
		? listedNetworkKeyRecordReaderIn(
				reader,
				IKA_DEPLOYED_NETWORKS[network],
				network,
				chain,
				recordAddress,
			)
		: reader;
}
