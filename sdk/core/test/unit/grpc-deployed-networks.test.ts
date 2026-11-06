// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The network keys and chain numbers the SDK ships for mainnet and
 * testnet, and the trust a caller builds from them.
 *
 * The new flow is not deployed on either network yet, so both lists are
 * empty and every mainnet and testnet path refuses. The checks a filled list
 * makes are tested here through a table built for the test, with the forms
 * that take a table, which the package does not export.
 */
import { describe, expect, it } from 'vitest';

import {
	deployedNetworkValue,
	deployedSolanaChainNumber,
	deployedSuiChainNumber,
	IKA_DEPLOYED_NETWORKS,
	listedNetworkKey,
	trustedNetworkKeys,
} from '../../src/grpc/deployed-networks';
import type { DeployedNetwork } from '../../src/grpc/deployed-networks';
import {
	listedNetworkKeyIn,
	listedNetworkKeyRecordReaderIn,
	trustedNetworkKeysIn,
} from '../../src/grpc/deployed-networks-internal';
import type { NetworkKeyOutputRecordReader } from '../../src/grpc/network-key-output';
import * as packageRoot from '../../src/index';

const toHex = (bytes: Uint8Array) =>
	Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

const KEY = new Uint8Array(32).fill(0x11);
const OTHER_KEY = new Uint8Array(32).fill(0x12);
const DIGEST = new Uint8Array(32).fill(0x21);
const SUI_ADDRESS = new Uint8Array(32).fill(0x31);
const SOLANA_ADDRESS = new Uint8Array(32).fill(0x41);

/** A table that lists one key, as a release that fills the list would. */
const TABLE: DeployedNetwork = {
	networkKeys: [
		{
			noaPublicKey: KEY,
			dkgOutputDigest: DIGEST,
			suiRecordAddress: SUI_ADDRESS,
			solanaRecordAddress: SOLANA_ADDRESS,
		},
	],
	network: 3,
	suiChainNumber: 9,
	solanaChainNumber: 10,
};

/** How many reads a chain reader made. */
interface ReadCount {
	reads: number;
}

/** The proof of an unsigned record. */
const NO_PROOF = new Uint8Array();

/** A chain reader that answers every key with a record of `digest`, counting its reads in `count`. */
function chainReader(
	digest: Uint8Array,
	count: ReadCount = { reads: 0 },
): NetworkKeyOutputRecordReader {
	return {
		async dkgRecord() {
			count.reads += 1;
			return { digest, proof: NO_PROOF };
		},
		async reconfigurationRecord() {
			count.reads += 1;
			return { digest, proof: NO_PROOF };
		},
		async isRegisteredNetworkKey() {
			count.reads += 1;
			return true;
		},
	};
}

describe('the networks the SDK ships', () => {
	it('lists no network key for mainnet or testnet, and refuses every key there', async () => {
		for (const network of ['mainnet', 'testnet'] as const) {
			expect(IKA_DEPLOYED_NETWORKS[network].networkKeys).toEqual([]);
			const notDeployed = `the new flow is not deployed on ${network} yet: this SDK lists no network key for ${network}`;
			expect(() => trustedNetworkKeys(network)).toThrow(notDeployed);
			expect(() => listedNetworkKey(network, KEY)).toThrow(notDeployed);
		}
	});

	it('does not export the forms that take a table, so a caller cannot label its own keys mainnet', () => {
		const exported = Object.keys(packageRoot);
		for (const name of [
			'listedNetworkKeyIn',
			'trustedNetworkKeysIn',
			'listedNetworkKeyRecordReaderIn',
		]) {
			expect(exported).not.toContain(name);
		}
		expect(exported).toContain('trustedNetworkKeys');
		expect(() => packageRoot.trustedNetworkKeys('mainnet')).toThrow(
			'the new flow is not deployed on mainnet yet',
		);
	});

	it("pins mainnet's chain numbers, and has none for testnet yet", () => {
		// The numbers the protocol config gives Sui and Solana on every network.
		expect(deployedSuiChainNumber('mainnet')).toBe(2);
		expect(deployedSolanaChainNumber('mainnet')).toBe(1);
		expect(() => deployedSuiChainNumber('testnet')).toThrow(
			'the new flow is not deployed on testnet yet',
		);
		expect(() => deployedSolanaChainNumber('testnet')).toThrow(
			'the new flow is not deployed on testnet yet',
		);
	});

	it('pins each network value, which the chain numbers cannot tell apart', () => {
		// The `Network` values of the protocol config: 1 mainnet, 2 testnet.
		expect(deployedNetworkValue('mainnet')).toBe(1);
		expect(deployedNetworkValue('testnet')).toBe(2);
	});
});

describe('a custom network', () => {
	it("trusts a copy of the caller's keys, and checks them against no list", () => {
		const key = Uint8Array.from(KEY);
		const trusted = trustedNetworkKeys({ custom: { networkPublicKeys: [key] } });
		key.fill(0);
		expect(trusted.publicKeys).toEqual([KEY]);
		expect(listedNetworkKey({ custom: { networkPublicKeys: [] } }, OTHER_KEY)).toBeUndefined();
	});

	it('refuses a key that is not 32 bytes', () => {
		expect(() =>
			trustedNetworkKeys({ custom: { networkPublicKeys: [new Uint8Array(31)] } }),
		).toThrow('a trusted network key is 32 bytes, got 31');
	});

	it('allows an empty set, which every record check refuses', () => {
		expect(trustedNetworkKeys({ custom: { networkPublicKeys: [] } }).publicKeys).toEqual([]);
	});
});

describe('a deployed network with a listed key', () => {
	it('trusts the listed keys and no other', () => {
		expect(trustedNetworkKeysIn(TABLE, 'mainnet').publicKeys).toEqual([KEY]);
		expect(listedNetworkKeyIn(TABLE, 'mainnet', KEY).dkgOutputDigest).toEqual(DIGEST);
		expect(() => listedNetworkKeyIn(TABLE, 'mainnet', OTHER_KEY)).toThrow(
			`network key ${toHex(OTHER_KEY)} is not a network key of mainnet`,
		);
	});

	it('reads the record of a listed key at its listed address with its listed digest', async () => {
		const chain = chainReader(DIGEST);
		const reader = listedNetworkKeyRecordReaderIn(
			chain,
			TABLE,
			'mainnet',
			'sui',
			() => SUI_ADDRESS,
		);
		await expect(reader.dkgRecord(KEY)).resolves.toEqual({ digest: DIGEST, proof: NO_PROOF });
		await expect(reader.reconfigurationRecord(KEY, 3n)).resolves.toEqual({
			digest: DIGEST,
			proof: NO_PROOF,
		});
		await expect(reader.isRegisteredNetworkKey(KEY)).resolves.toBe(true);
	});

	it('refuses another key before any read, and does not register it as a signer', async () => {
		const count = { reads: 0 };
		const reader = listedNetworkKeyRecordReaderIn(
			chainReader(DIGEST, count),
			TABLE,
			'mainnet',
			'sui',
			() => SUI_ADDRESS,
		);
		await expect(reader.dkgRecord(OTHER_KEY)).rejects.toThrow('is not a network key of mainnet');
		await expect(reader.reconfigurationRecord(OTHER_KEY, 3n)).rejects.toThrow(
			'is not a network key of mainnet',
		);
		await expect(reader.isRegisteredNetworkKey(OTHER_KEY)).resolves.toBe(false);
		expect(count.reads).toBe(0);
	});

	it('refuses a record at another address than the listed one', async () => {
		const chain = chainReader(DIGEST);
		const sui = listedNetworkKeyRecordReaderIn(
			chain,
			TABLE,
			'mainnet',
			'sui',
			() => SOLANA_ADDRESS,
		);
		await expect(sui.dkgRecord(KEY)).rejects.toThrow('is not at the address this SDK lists');
		const solana = listedNetworkKeyRecordReaderIn(
			chain,
			TABLE,
			'mainnet',
			'solana',
			() => SOLANA_ADDRESS,
		);
		await expect(solana.dkgRecord(KEY)).resolves.toEqual({ digest: DIGEST, proof: NO_PROOF });
	});

	it('refuses a record that holds another DKG digest than the listed one', async () => {
		const reader = listedNetworkKeyRecordReaderIn(
			chainReader(new Uint8Array(32).fill(0x22)),
			TABLE,
			'mainnet',
			'sui',
			() => SUI_ADDRESS,
		);
		await expect(reader.dkgRecord(KEY)).rejects.toThrow('holds another DKG output digest');
	});
});
