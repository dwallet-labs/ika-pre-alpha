// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * `resolveSession` answers what became of a request whose epoch closed
 * before an answer, from the chain alone: it waits for the epoch at which
 * the request's epoch is settled, then looks for the session.
 */
import { gasChargeId } from '@ika.xyz/sdk-core/common';
import type { PendingRequest, RequestRecordReader } from '@ika.xyz/sdk-core/common';
import { Connection, Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { IkaClient } from '../src/web3/index.js';

const SESSION = new Uint8Array(32).fill(0x61);
const TRANSPORT = new Uint8Array(32).fill(0x62);
const pending: PendingRequest = {
	kind: 'presign',
	epoch: 5n,
	sessionIdentifier: SESSION,
	transportKey: TRANSPORT,
	curve: 2,
	networkKeyId: new Uint8Array(32).fill(0x63),
};

/** A client whose chain shows `epoch` and holds the charges `charged`. */
class ChainOnly extends IkaClient {
	constructor(
		private readonly epoch: bigint,
		private readonly charged: Uint8Array[],
	) {
		super({
			connection: new Connection('http://127.0.0.1:1'),
			grpc: {} as never,
			config: {
				network: { custom: { networkPublicKeys: [pending.networkKeyId] } },
				programId: Keypair.generate().publicKey,
				chainNumber: 9,
				networkValue: 3,
			},
		});
	}

	protected async chainEpoch(): Promise<bigint> {
		return this.epoch;
	}

	protected requestRecords(): RequestRecordReader {
		return {
			hasGasCharge: async (_key, chargeId) =>
				this.charged.some((id) => Buffer.from(id).equals(Buffer.from(chargeId))),
			voucherSignature: async () => null,
			futureVoucher: async () => null,
		};
	}
}

describe('resolveSession', () => {
	it("waits while the chain has not settled the request's epoch", async () => {
		expect(await new ChainOnly(5n, []).resolveSession(pending)).toEqual({
			status: 'waiting',
			chainEpoch: 5n,
			settledAt: 6n,
		});
	});

	it('says a request with nothing on the chain never ran, and may be sent again', async () => {
		expect(await new ChainOnly(6n, []).resolveSession(pending)).toEqual({ status: 'neverRan' });
	});

	it('names the record of a request that ran', async () => {
		const charged = [gasChargeId('CompletedPresign', SESSION)];
		expect(await new ChainOnly(30n, charged).resolveSession(pending)).toEqual({
			status: 'ran',
			record: 'the charge record CompletedPresign',
		});
	});
});
