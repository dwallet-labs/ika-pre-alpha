// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * `IkaClient` keeps one connection per curve and network key. A presign
 * names the latest key and a sign names its dWallet's key id; when those are
 * the same key, both go through one connection, which keeps the epoch it
 * last saw. With two, the sign's connection would go on naming an epoch the
 * presign's had already left.
 */
import { Curve } from '@ika.xyz/pre-alpha-core';
import type { NetworkKeyOutputRecordReader } from '@ika.xyz/pre-alpha-core';
import { Connection, Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { DWalletGrpcClient, IkaClient } from '../src/web3/index.js';

const KEY = new Uint8Array(32).fill(9);

class CountingClient extends IkaClient {
	checks = 0;

	protected networkKeyRecords(): NetworkKeyOutputRecordReader {
		return {
			isRegisteredNetworkKey: () => {
				this.checks += 1;
				// The connection stays pending: only how many were opened matters.
				return new Promise<boolean>(() => {});
			},
		} as unknown as NetworkKeyOutputRecordReader;
	}

	open(curve: Curve, networkKeyId?: Uint8Array): void {
		void this.engine(curve, networkKeyId);
	}
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('IkaClient connections', () => {
	it('shares one connection between the latest key and the same key by its id', async () => {
		const client = new CountingClient({
			connection: new Connection('http://127.0.0.1:1'),
			grpc: { latestNetworkKeyId: async () => KEY } as never,
			config: {
				network: { custom: { networkPublicKeys: [KEY] } },
				programId: Keypair.generate().publicKey,
				chainNumber: 9,
				networkValue: 3,
			},
		});
		client.open(Curve.ED25519);
		await settle();
		client.open(Curve.ED25519, Uint8Array.from(KEY));
		client.open(Curve.ED25519);
		await settle();
		expect(client.checks).toBe(1);

		client.open(Curve.SECP256K1, Uint8Array.from(KEY));
		await settle();
		expect(client.checks, 'another curve has its own connection').toBe(2);
	});
});

describe('IkaClient gRPC endpoint', () => {
	const config = {
		network: { custom: { networkPublicKeys: [KEY] } },
		programId: Keypair.generate().publicKey,
		chainNumber: 9,
		networkValue: 3,
	};
	const connection = new Connection('http://127.0.0.1:1');

	it('makes the client from a URL, once, and keeps a client it was given', () => {
		const fromUrl = new IkaClient({ connection, grpc: '127.0.0.1:1', config });
		expect(fromUrl.grpc).toBeInstanceOf(DWalletGrpcClient);
		expect(fromUrl.grpc, 'made once').toBe(fromUrl.grpc);

		const plaintext = new IkaClient({
			connection,
			grpc: { url: '127.0.0.1:1', insecure: true },
			config,
		});
		expect(plaintext.grpc).toBeInstanceOf(DWalletGrpcClient);

		const given = new DWalletGrpcClient('127.0.0.1:1', undefined, [], { insecure: true });
		expect(new IkaClient({ connection, grpc: given, config }).grpc).toBe(given);
	});
});
