// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The read of the epoch's network keys goes on across a validator's epoch
 * change.
 *
 * A validator stops its gRPC server while it changes epoch, and starts the
 * next epoch's server about 15 seconds later. The client tries the read
 * again after a transport failure: a refused connection, or a read not
 * answered in time. It tries every 5 seconds for up to 60 seconds. These
 * tests shorten that to a pause of 200 ms and 3 seconds in all, and run real
 * servers on localhost ports.
 */
import { createServer } from 'node:net';
import * as grpc from '@grpc/grpc-js';
import { afterEach, describe, expect, it } from 'vitest';

import { DWalletGrpcClient } from '../../src/grpc/client';
import { networkKeyIdFromBytes } from '../../src/grpc/network-key-id';
import { serviceDefinitionForTestsOnly } from '../../src/grpc/node-transport';

/** The read's repeat in these tests: the default's rules, within a few seconds. */
const SHORT_RETRY = { attemptTimeoutMs: 500, pauseMs: 200, budgetMs: 3_000 };

const key = new Uint8Array(32).fill(0x90);

/** A localhost port nothing listens on. */
async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as { port: number }).port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

/** A plaintext client of the validator at `port`, whose read repeats by `retry`. */
function clientOf(port: number, retry: object = SHORT_RETRY): DWalletGrpcClient {
	const client = new DWalletGrpcClient(`127.0.0.1:${port}`, undefined, [], { insecure: true });
	(client as any).networkKeysReadRetry = retry;
	return client;
}

/** The service definition of the client's proto. */
function serviceDefinition(): grpc.ServiceDefinition {
	return serviceDefinitionForTestsOnly();
}

/**
 * How the test validator handles one `GetNetworkKeysByAge` call: `hang`
 * never answers, as a validator that cannot be reached; a number answers
 * that status; `answer` answers the key.
 */
type Handling = 'hang' | 'answer' | number;

/**
 * Serve `GetNetworkKeysByAge` on `port`, handling the calls in turn as
 * `script` says, and every call after the script by its last entry.
 * `received.calls` counts the calls.
 */
async function serve(
	port: number,
	script: Handling[],
	received: { calls: number } = { calls: 0 },
): Promise<grpc.Server> {
	const server = new grpc.Server();
	server.addService(serviceDefinition(), {
		GetNetworkKeysByAge: (_call: unknown, callback: grpc.sendUnaryData<object>) => {
			const handling = script[Math.min(received.calls, script.length - 1)];
			received.calls += 1;
			if (handling === 'answer') {
				callback(null, {
					network_key_ids: [Buffer.from(key)],
					latest_usable_network_key_id: Buffer.from(key),
				});
			} else if (handling !== 'hang') {
				callback({ code: handling, details: 'refused by the test' });
			}
		},
	});
	await new Promise<void>((resolve, reject) =>
		server.bindAsync(`127.0.0.1:${port}`, grpc.ServerCredentials.createInsecure(), (error) =>
			error ? reject(error) : resolve(),
		),
	);
	return server;
}

/** How long `work` took to reject, and what it rejected with. */
async function rejectionOf(work: Promise<unknown>): Promise<{ elapsed: number; error: any }> {
	const started = Date.now();
	try {
		await work;
	} catch (error) {
		return { elapsed: Date.now() - started, error };
	}
	throw new Error('the read was expected to reject');
}

describe('the read of the network keys across an epoch change', () => {
	const toClose: Array<() => void> = [];
	afterEach(() => {
		toClose.splice(0).forEach((close) => close());
	});

	it('goes on while the validator does not answer, and returns its answer', async () => {
		const port = await freePort();
		const received = { calls: 0 };
		const server = await serve(port, ['hang', 'hang', 'answer'], received);
		toClose.push(() => server.forceShutdown());
		const client = clientOf(port);
		toClose.push(() => client.close());

		expect(await client.latestNetworkKeyId()).toEqual(networkKeyIdFromBytes(key));
		expect(received.calls).toBe(3);
	});

	it('goes on while the validator refuses connections, until a server listens', async () => {
		const port = await freePort();
		const client = clientOf(port);
		toClose.push(() => client.close());
		const downtimeMs = 900;
		const started = Date.now();

		const read = client.latestNetworkKeyId();
		await new Promise((resolve) => setTimeout(resolve, downtimeMs));
		const received = { calls: 0 };
		const server = await serve(port, ['answer'], received);
		toClose.push(() => server.forceShutdown());

		expect(await read).toEqual(networkKeyIdFromBytes(key));
		expect(received.calls).toBe(1);
		expect(Date.now() - started).toBeGreaterThanOrEqual(downtimeMs);
	});

	it('fails with the last error, naming the budget, when the validator never answers', async () => {
		const port = await freePort();
		const received = { calls: 0 };
		const server = await serve(port, ['hang'], received);
		toClose.push(() => server.forceShutdown());
		const client = clientOf(port);
		toClose.push(() => client.close());

		const { elapsed, error } = await rejectionOf(client.latestNetworkKeyId());

		expect(error).toMatchObject({
			code: grpc.status.DEADLINE_EXCEEDED,
			message: expect.stringContaining(
				`the validator stayed unreachable for the ${SHORT_RETRY.budgetMs} ms the read is retried`,
			),
		});
		expect(received.calls).toBeGreaterThan(1);
		expect(elapsed).toBeLessThan(SHORT_RETRY.budgetMs + 2_000);
	});

	it('fails at once, after one attempt, on an answer that is not a transport failure', async () => {
		const port = await freePort();
		const received = { calls: 0 };
		const server = await serve(port, [grpc.status.NOT_FOUND, 'answer'], received);
		toClose.push(() => server.forceShutdown());
		const client = clientOf(port);
		toClose.push(() => client.close());

		await expect(client.latestNetworkKeyId()).rejects.toMatchObject({
			code: grpc.status.NOT_FOUND,
		});
		expect(received.calls).toBe(1);
	});

	it('stops at close(), without waiting for the pause to end', async () => {
		const port = await freePort();
		const client = clientOf(port, { attemptTimeoutMs: 500, pauseMs: 10_000, budgetMs: 60_000 });

		const read = rejectionOf(client.getNetworkKeysByAge());
		await new Promise((resolve) => setTimeout(resolve, 300));
		client.close();
		const { elapsed, error } = await read;

		expect(error).toMatchObject({ message: 'the client is closed' });
		expect(elapsed).toBeLessThan(2_000);
	});
});
