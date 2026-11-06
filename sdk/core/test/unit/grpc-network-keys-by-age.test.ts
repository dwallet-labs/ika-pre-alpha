// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

import { describe, expect, it } from 'vitest';

import { DWalletGrpcClient } from '../../src/grpc/client';
import { latestNetworkKeyIdOf, networkKeyIdFromBytes } from '../../src/grpc/network-key-id';
import { callThroughStubs } from './stub-validators';

/**
 * The key a DKG or an imported-key verification names by default.
 *
 * The network refuses either request under any key but the epoch's latest
 * usable key, which the validator answers beside the list of network keys.
 * While the newest key is held, that is an older entry. A validator built
 * before the answer existed sends only the list, and the default is then the
 * last entry, taken in the order the network answered, and not the largest id
 * or the first one.
 */
describe('the default key of a new dWallet', () => {
	// The older key has the larger id, so a default picked by id order would
	// choose the wrong one.
	const older = new Uint8Array(32).fill(0x90);
	const latest = new Uint8Array(32).fill(0x10);

	/**
	 * A client whose transport answers `GetNetworkKeysByAge` with `ids` and,
	 * when given, `latestUsable`. Without it the answer is an older
	 * validator's, which has no usable-key field.
	 */
	function clientAnswering(ids: Uint8Array[], latestUsable?: Uint8Array): DWalletGrpcClient {
		const client = Object.create(DWalletGrpcClient.prototype) as {
			service: unknown;
			call: unknown;
			furtherValidatorCount: number;
		};
		// One validator, the one reads choose: no further validators.
		client.furtherValidatorCount = 0;
		client.call = callThroughStubs(() => [client.service]);
		client.service = {
			GetNetworkKeysByAge: (
				_request: object,
				_options: object,
				callback: (error: Error | null, response: object) => void,
			) =>
				callback(null, {
					network_key_ids: ids.map((id) => Buffer.from(id)),
					...(latestUsable === undefined
						? {}
						: { latest_usable_network_key_id: Buffer.from(latestUsable) }),
				}),
		};
		return client as unknown as DWalletGrpcClient;
	}

	it('is the usable key the validator answers, not the held last entry', async () => {
		// The newest key is held: the list ends with it, and the validator
		// names the older key as the usable one.
		const client = clientAnswering([older, latest], older);
		expect(await client.getNetworkKeysByAge()).toEqual([
			networkKeyIdFromBytes(older),
			networkKeyIdFromBytes(latest),
		]);
		expect(await client.latestNetworkKeyId()).toEqual(networkKeyIdFromBytes(older));
	});

	it('is the last entry when the validator sends no usable key', async () => {
		expect(await clientAnswering([older, latest]).latestNetworkKeyId()).toEqual(
			networkKeyIdFromBytes(latest),
		);
		// An empty field is how proto3 reads an absent one.
		expect(await clientAnswering([older, latest], new Uint8Array()).latestNetworkKeyId()).toEqual(
			networkKeyIdFromBytes(latest),
		);
	});

	it('is the last entry of the list the RPC returns', async () => {
		const client = clientAnswering([older, latest]);
		expect(await client.getNetworkKeysByAge()).toEqual([
			networkKeyIdFromBytes(older),
			networkKeyIdFromBytes(latest),
		]);
		expect(await client.latestNetworkKeyId()).toEqual(networkKeyIdFromBytes(latest));
	});

	it('is the only entry of a one-entry list', () => {
		expect(latestNetworkKeyIdOf([networkKeyIdFromBytes(older)])).toEqual(
			networkKeyIdFromBytes(older),
		);
	});

	it('is refused when the epoch has no network key for new dWallets', async () => {
		await expect(clientAnswering([]).latestNetworkKeyId()).rejects.toThrow(
			'this epoch has no network key for new dWallets',
		);
	});
});
