// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The cross-check of the reads no network signature covers: two endpoints
 * must agree, a lagging endpoint is read again, and anything else refuses.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { crossCheckedRead } from '../../src/grpc/read-cross-check';
import type { CrossCheckEndpoint, EndpointAnswer } from '../../src/grpc/read-cross-check';

const ENDPOINTS = ['https://first', 'https://second'] as const;

type Script = (EndpointAnswer<number> | Error)[];

/**
 * A read whose endpoints answer from `first` and `second`, one answer per
 * call, the last answer repeating. Records every call.
 */
function readScripted(first: Script, second: Script) {
	const scripts = [first, second];
	const calls: [CrossCheckEndpoint, bigint | undefined][] = [];
	const outcome = crossCheckedRead<number>({
		endpoints: ENDPOINTS,
		what: 'record',
		read: async (endpoint, minPosition) => {
			calls.push([endpoint, minPosition]);
			const script = scripts[endpoint]!;
			const answer = script.length > 1 ? script.shift()! : script[0]!;
			if (answer instanceof Error) {
				throw answer;
			}
			return answer;
		},
		equal: (left, right) => left === right,
		windowMs: 200,
		retryIntervalMs: 10,
	});
	return { outcome, calls };
}

const at = (position: number, value: number | undefined): EndpointAnswer<number> => ({
	position: BigInt(position),
	value,
});

/**
 * Starts a read with fake timers whose endpoints answer through `read`, and
 * records how it settled: `pending` until it does.
 */
function startFaked(
	read: (
		endpoint: CrossCheckEndpoint,
		minPosition: bigint | undefined,
	) => Promise<EndpointAnswer<number>>,
) {
	vi.useFakeTimers();
	const settled: { outcome: 'pending' | number | undefined | Error } = { outcome: 'pending' };
	crossCheckedRead<number>({
		endpoints: ENDPOINTS,
		what: 'record',
		read,
		equal: (left, right) => left === right,
		windowMs: 200,
		retryIntervalMs: 10,
	}).then(
		(value) => {
			settled.outcome = value;
		},
		(error: Error) => {
			settled.outcome = error;
		},
	);
	return settled;
}

describe('crossCheckedRead', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('gives the value two endpoints agree on, at any positions', async () => {
		const { outcome, calls } = readScripted([at(5, 1)], [at(9, 1)]);
		await expect(outcome).resolves.toBe(1);
		expect(calls).toHaveLength(2);
	});

	it('refuses two endpoints that serve different values at the same position, naming both', async () => {
		const { outcome } = readScripted([at(5, 1)], [at(5, 2)]);
		await expect(outcome).rejects.toThrow(
			'https://first and https://second disagree on the record at the same position',
		);
	});

	it('reads a lagging endpoint again, pinned to the other position, until it agrees', async () => {
		const { outcome, calls } = readScripted([at(5, 1), 'behind', at(9, 2)], [at(9, 2)]);
		await expect(outcome).resolves.toBe(2);
		expect(calls.slice(2)).toEqual([
			[0, 9n],
			[0, 9n],
		]);
	});

	it('reads an endpoint that has not seen a fresh entry again until it has', async () => {
		const { outcome, calls } = readScripted(
			[at(4, 3)],
			[at(0, undefined), at(0, undefined), at(4, 3)],
		);
		await expect(outcome).resolves.toBe(3);
		expect(calls.slice(2).every(([endpoint, min]) => endpoint === 1 && min === 4n)).toBe(true);
	});

	it('refuses an endpoint that stays behind past the window, naming both', async () => {
		const { outcome } = readScripted([at(5, 1)], [at(9, 2)]);
		await expect(outcome).rejects.toThrow(
			'https://first and https://second still disagree on the record',
		);
	});

	it('refuses the read when one endpoint fails, with no fallback to the other', async () => {
		const { outcome } = readScripted([at(5, 1)], [new Error('connection refused')]);
		await expect(outcome).rejects.toThrow('read the record from https://second');
	});

	it('gives undefined when both endpoints find nothing', async () => {
		const { outcome } = readScripted([at(0, undefined)], [at(0, undefined)]);
		await expect(outcome).resolves.toBeUndefined();
	});

	it('refuses within the window, naming the endpoint, when one endpoint never answers', async () => {
		const settled = startFaked((endpoint) =>
			endpoint === 1 ? new Promise<never>(() => {}) : Promise.resolve(at(5, 1)),
		);
		await vi.advanceTimersByTimeAsync(200);
		expect(settled.outcome).toBeInstanceOf(Error);
		expect((settled.outcome as Error).message).toBe(
			'read the record from https://second: no answer within the 200 ms window',
		);
	});

	it('refuses a re-read that answers only after the window, naming the endpoint', async () => {
		// The first endpoint lags at position 5. Its re-read would agree, but
		// answers 1,000 ms later, long after the 200 ms window.
		const settled = startFaked((endpoint, minPosition) => {
			if (endpoint === 1) {
				return Promise.resolve(at(9, 2));
			}
			if (minPosition === undefined) {
				return Promise.resolve(at(5, 1));
			}
			return new Promise((resolve) => setTimeout(() => resolve(at(9, 2)), 1_000));
		});
		await vi.advanceTimersByTimeAsync(200);
		expect(settled.outcome).toBeInstanceOf(Error);
		expect((settled.outcome as Error).message).toBe(
			'read the record from https://first: no answer within the 200 ms window',
		);
	});
});
