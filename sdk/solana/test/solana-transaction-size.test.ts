// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * `IkaTransaction` on Solana refuses an instruction that would make the
 * transaction larger than Solana takes, and leaves the transaction as it
 * was, for a legacy and for a versioned transaction. Its count of the size
 * is checked to the byte against what `@solana/web3.js` serializes: a
 * transaction filled to exactly the limit is taken, one byte more is not.
 */
import {
	Connection,
	Keypair,
	PACKET_DATA_SIZE,
	PublicKey,
	Transaction,
	TransactionInstruction,
} from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import {
	Curve,
	IkaClient,
	IkaTransaction,
	TransactionTooLargeError,
	UserShareEncryptionKeys,
} from '../src/web3/index.js';

const ikaClient = new IkaClient({
	connection: new Connection('http://127.0.0.1:1'),
	grpc: {} as never,
	config: {
		network: { custom: { networkPublicKeys: [] } },
		programId: Keypair.generate().publicKey,
		chainNumber: 9,
		networkValue: 3,
	},
});
const owner = Keypair.generate().publicKey;
const keys = UserShareEncryptionKeys.fromRootSeedKey(new Uint8Array(32), Curve.SECP256K1);
const blockhash = PublicKey.default.toBase58();

/** An instruction of a new program with no accounts and `length` bytes of data. */
const filler = (length: number) =>
	new TransactionInstruction({
		programId: Keypair.generate().publicKey,
		keys: [],
		data: Buffer.alloc(length),
	});

/** What a filler of `length` data bytes adds: its program's key, its indexes, its data. */
const fillerCost = (length: number) => 32 + 1 + 1 + (length < 128 ? 1 : 2) + length;

/** The filler data length that brings a transaction of `size` bytes to exactly the limit. */
function fillTo(size: number): number {
	const room = PACKET_DATA_SIZE - size;
	const length = room - 32 - 1 - 1 - 2;
	expect(fillerCost(length)).toBe(room);
	return length;
}

function legacySize(transaction: Transaction): number {
	transaction.feePayer = owner;
	transaction.recentBlockhash = blockhash;
	return transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
}

describe('IkaTransaction on Solana', () => {
	it('refuses what does not fit, and keeps the transaction as it was', async () => {
		const transaction = new Transaction();
		const ikaTx = new IkaTransaction({
			ikaClient,
			transaction,
			owner,
			userShareEncryptionKeys: await keys,
		});
		ikaTx.registerEncryptionKey();
		expect(legacySize(transaction)).toBeLessThanOrEqual(PACKET_DATA_SIZE);

		// Gas deposits are added until one does not fit.
		let before = [...transaction.instructions];
		let refused: unknown;
		for (let added = 0; added < 4 && refused === undefined; added++) {
			before = [...transaction.instructions];
			try {
				ikaTx.createGasDeposit();
			} catch (error) {
				refused = error;
			}
		}
		expect(refused).toBeInstanceOf(TransactionTooLargeError);
		expect((refused as TransactionTooLargeError).size).toBeGreaterThan(PACKET_DATA_SIZE);
		expect(transaction.instructions).toEqual(before);
	}, 120_000);

	it("counts the caller's own instructions, even ones too large to serialize", async () => {
		const transaction = new Transaction().add(filler(1200));
		const ikaTx = new IkaTransaction({
			ikaClient,
			transaction,
			owner,
			userShareEncryptionKeys: await keys,
		});
		expect(() => ikaTx.createGasDeposit()).toThrow(TransactionTooLargeError);
		expect(transaction.instructions).toHaveLength(1);
	}, 120_000);

	it('takes a legacy transaction of exactly the limit, and not one byte more', async () => {
		const transaction = new Transaction();
		const ikaTx = new IkaTransaction({
			ikaClient,
			transaction,
			owner,
			userShareEncryptionKeys: await keys,
		});
		ikaTx.createGasDeposit();
		const length = fillTo(legacySize(transaction));
		expect(() => ikaTx.add(filler(length + 1))).toThrow(TransactionTooLargeError);
		ikaTx.add(filler(length));
		expect(legacySize(transaction)).toBe(PACKET_DATA_SIZE);
	}, 120_000);

	it('builds a versioned transaction, measured to the byte the same way', async () => {
		const ikaTx = new IkaTransaction({
			ikaClient,
			version: 0,
			owner,
			userShareEncryptionKeys: await keys,
		});
		ikaTx.createGasDeposit();
		const built = ikaTx.buildVersionedTransaction({ recentBlockhash: blockhash });
		expect(built.version).toBe(0);
		const length = fillTo(built.serialize().length);
		expect(() => ikaTx.add(filler(length + 1))).toThrow(TransactionTooLargeError);
		ikaTx.add(filler(length));
		expect(ikaTx.buildVersionedTransaction({ recentBlockhash: blockhash }).serialize().length).toBe(
			PACKET_DATA_SIZE,
		);
	}, 120_000);

	it('refuses to build a versioned transaction from a legacy one', async () => {
		const ikaTx = new IkaTransaction({ ikaClient, transaction: new Transaction(), owner });
		expect(() => ikaTx.buildVersionedTransaction({ recentBlockhash: blockhash })).toThrow(
			/pass `version: 0`/,
		);
	});
});
