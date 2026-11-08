// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * With `useWasmWorker`, the SDK's slow computations run in a worker: they
 * give the same result as on the calling thread, the calling thread keeps
 * running meanwhile, and a computation's error reaches the caller.
 */
import { Curve, publicKeyFromDWalletOutput } from '@ika.xyz/pre-alpha-core';
import { stopWasmWorker, UserShareEncryptionKeys, useWasmWorker } from '@ika.xyz/pre-alpha-core/common';
import { afterEach, describe, expect, it } from 'vitest';

const SEED = new Uint8Array(32).fill(4);

/** Run `work`, and count how often a 10 ms timer fired on this thread meanwhile. */
async function ticksDuring<T>(work: () => Promise<T>): Promise<{ result: T; ticks: number }> {
	let ticks = 0;
	const timer = setInterval(() => ticks++, 10);
	try {
		return { result: await work(), ticks };
	} finally {
		clearInterval(timer);
	}
}

describe('useWasmWorker', () => {
	afterEach(() => stopWasmWorker());

	it('computes the same keys in a worker, while this thread keeps running', async () => {
		const here = await ticksDuring(() =>
			UserShareEncryptionKeys.fromRootSeedKey(SEED, Curve.ED25519),
		);
		useWasmWorker();
		const there = await ticksDuring(() =>
			UserShareEncryptionKeys.fromRootSeedKey(SEED, Curve.ED25519),
		);
		expect(there.result.encryptionKey).toEqual(here.result.encryptionKey);
		expect(here.ticks, 'on this thread, the computation blocks the timer').toBeLessThan(5);
		expect(there.ticks, 'in the worker, the timer keeps firing').toBeGreaterThan(20);
	}, 120_000);

	it("rejects with the computation's error", async () => {
		useWasmWorker();
		await expect(
			publicKeyFromDWalletOutput(Curve.ED25519, new Uint8Array([1, 2, 3])),
		).rejects.toThrow();
	}, 60_000);
});
