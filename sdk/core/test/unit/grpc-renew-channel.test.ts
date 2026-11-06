// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The client builds a new channel for a validator after a call fails to reach
 * it.
 *
 * A validator's gRPC server is down for a while at every epoch change. grpc-js
 * keeps a channel whose connection failed in reconnect backoff, and while it
 * waits it fails every call at once with "No connection established", even
 * after the server listens again. These tests start a real server on a
 * localhost port only after a call has failed to reach that port, and call
 * again at once.
 */
import { createServer } from 'node:net';
import * as grpc from '@grpc/grpc-js';
import { afterEach, describe, expect, it } from 'vitest';

import { DWalletGrpcClient, EPOCH_CLOSING_REFUSAL } from '../../src/grpc/client';
import { serviceDefinitionForTestsOnly } from '../../src/grpc/node-transport';

/** A localhost port nothing listens on. */
async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as { port: number }).port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

/** Serve `GetPresigns` on `port` with `answer`. */
async function serve(
	port: number,
	serviceDefinition: grpc.ServiceDefinition,
	answer: (callback: grpc.sendUnaryData<object>) => void,
): Promise<grpc.Server> {
	const server = new grpc.Server();
	server.addService(serviceDefinition, {
		GetPresigns: (_call: unknown, callback: grpc.sendUnaryData<object>) => answer(callback),
	});
	await new Promise<void>((resolve, reject) =>
		server.bindAsync(`127.0.0.1:${port}`, grpc.ServerCredentials.createInsecure(), (error) =>
			error ? reject(error) : resolve(),
		),
	);
	return server;
}

/** Wait, at most 10 s, until `channel` is in `state`. */
async function waitForState(channel: grpc.Channel, state: grpc.connectivityState): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (channel.getConnectivityState(false) !== state) {
		const current = channel.getConnectivityState(false);
		await new Promise<void>((resolve, reject) =>
			channel.watchConnectivityState(current, deadline, (error) =>
				error ? reject(error) : resolve(),
			),
		);
	}
}

describe('a new channel after a connection failure', () => {
	const toClose: Array<() => void> = [];
	afterEach(() => {
		toClose.splice(0).forEach((close) => close());
	});

	it('answers at once when the server listens again after a call failed to reach it', async () => {
		const port = await freePort();
		const client = new DWalletGrpcClient(`127.0.0.1:${port}`, undefined, [], { insecure: true });
		toClose.push(() => client.close());
		const serviceDefinition = serviceDefinitionForTestsOnly();

		await expect(client.getPresigns(new Uint8Array(32))).rejects.toMatchObject({
			code: grpc.status.UNAVAILABLE,
		});

		const server = await serve(port, serviceDefinition, (callback) =>
			callback(null, { presigns: [] }),
		);
		toClose.push(() => server.forceShutdown());

		// grpc-js waits about a second before it tries the failed connection
		// again, and fails every call on that channel at once until then.
		await expect(client.getPresigns(new Uint8Array(32))).resolves.toEqual([]);
	});

	it('closes the old channel when it builds the new one', async () => {
		const port = await freePort();
		const client = new DWalletGrpcClient(`127.0.0.1:${port}`, undefined, [], { insecure: true });
		toClose.push(() => client.close());
		const first = (client as any).transport.service;

		await expect(client.getPresigns(new Uint8Array(32))).rejects.toMatchObject({
			code: grpc.status.UNAVAILABLE,
		});

		expect((client as any).transport.service).not.toBe(first);
		expect(first.getChannel().getConnectivityState(false)).toBe(grpc.connectivityState.SHUTDOWN);
	});

	// By default grpc-js shares one subchannel among every channel to the same
	// address. While another channel to the validator stays open, that
	// subchannel stays in its reconnect backoff, and a renewed channel that
	// shared it would fail at once with "No connection established. Last
	// error: null". Each channel's own subchannel pool prevents that.
	it('answers at once after a renewal while another client to the validator stays open', async () => {
		const port = await freePort();
		const other = new DWalletGrpcClient(`127.0.0.1:${port}`, undefined, [], { insecure: true });
		const client = new DWalletGrpcClient(`127.0.0.1:${port}`, undefined, [], { insecure: true });
		toClose.push(
			() => other.close(),
			() => client.close(),
		);
		const serviceDefinition = serviceDefinitionForTestsOnly();

		// The other client's channel tries to connect, fails, and waits in its
		// reconnect backoff.
		const otherChannel: grpc.Channel = (other as any).transport.service.getChannel();
		otherChannel.getConnectivityState(true);
		await waitForState(otherChannel, grpc.connectivityState.TRANSIENT_FAILURE);

		await expect(client.getPresigns(new Uint8Array(32))).rejects.toMatchObject({
			code: grpc.status.UNAVAILABLE,
		});

		const server = await serve(port, serviceDefinition, (callback) =>
			callback(null, { presigns: [] }),
		);
		toClose.push(() => server.forceShutdown());

		await expect(client.getPresigns(new Uint8Array(32))).resolves.toEqual([]);
	});

	it('keeps the channel when the server answered, even with UNAVAILABLE', async () => {
		const port = await freePort();
		const client = new DWalletGrpcClient(`127.0.0.1:${port}`, undefined, [], { insecure: true });
		toClose.push(() => client.close());
		const serviceDefinition = serviceDefinitionForTestsOnly();
		const server = await serve(port, serviceDefinition, (callback) =>
			callback({ code: grpc.status.UNAVAILABLE, details: EPOCH_CLOSING_REFUSAL }),
		);
		toClose.push(() => server.forceShutdown());
		const first = (client as any).transport.service;

		await expect(client.getPresigns(new Uint8Array(32))).rejects.toMatchObject({
			code: grpc.status.UNAVAILABLE,
			details: EPOCH_CLOSING_REFUSAL,
		});

		expect((client as any).transport.service).toBe(first);
	});
});
