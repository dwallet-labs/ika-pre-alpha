// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The client pins each validator's TLS certificate to a network key, the way
 * Sui's validator client does (sui-tls `ServerCertVerifier`): to the one key
 * it was given, or to the key of any member of the committee the network
 * signed.
 *
 * The servers here serve a real node certificate. The fixtures under
 * `fixtures/network-key-tls` are written by the ika-node test
 * `the_typescript_network_key_tls_fixtures_are_the_node_certificates`,
 * through the node's own `network_key_grpc_tls` and sui-tls, and that test
 * fails when the node's certificate format changes. Each fixture holds a
 * test-only seed, its network public key and the certificate. The seeds are
 * the bytes of fixed public strings, never a real validator's key. No
 * private key is committed: this test builds the server's key from the seed.
 *
 * The committees the servers answer are signed by the ordinary Ed25519 key
 * of seed `01` repeated 32 times, which the test chains register. It is never
 * a real network key.
 */
import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import * as grpc from '@grpc/grpc-js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DWalletGrpcClient, EVERY_VALIDATOR_REFUSED } from '../../src/grpc/client';
import type { CommitteeChainReader } from '../../src/grpc/committee';
import { committeeSigningMessage, unsignedCommittee } from '../../src/grpc/committee';
import {
	checkNetworkKeyCertificate,
	checkServedNetworkKeyCertificate,
	fetchServedCertificate,
} from '../../src/grpc/network-key-tls';
import { serviceDefinitionForTestsOnly } from '../../src/grpc/node-transport';

interface NetworkKeyTlsFixture {
	seed_hex: string;
	network_public_key_hex: string;
	certificate_pem: string;
}

/** One fixture validator: its network key, its certificate and its private key. */
function fixture(name: string) {
	const json: NetworkKeyTlsFixture = JSON.parse(
		readFileSync(new URL(`./fixtures/network-key-tls/${name}.json`, import.meta.url), 'utf8'),
	);
	// The PKCS#8 version 1 DER of an Ed25519 private key, then its 32 seed
	// bytes. The ika-node fixture test checks that the node's key is this.
	const pkcs8 = Buffer.concat([
		Buffer.from('302e020100300506032b657004220420', 'hex'),
		Buffer.from(json.seed_hex, 'hex'),
	]);
	const privateKeyPem = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })
		.export({ type: 'pkcs8', format: 'pem' })
		.toString();
	const certificateDer = Buffer.from(
		json.certificate_pem.replace(/-----[A-Z ]+-----|\s/g, ''),
		'base64',
	);
	return {
		networkKey: new Uint8Array(Buffer.from(json.network_public_key_hex, 'hex')),
		certificatePem: json.certificate_pem,
		certificateDer: new Uint8Array(certificateDer),
		privateKeyPem,
	};
}

type Validator = ReturnType<typeof fixture>;

const validatorOne = fixture('validator-one');
const validatorTwo = fixture('validator-two');

/** The seed of the key that signs the test committees. */
const SIGNER_SEED = new Uint8Array(32).fill(0x01);
const SIGNER_KEY = ed25519.getPublicKey(SIGNER_SEED);

/**
 * The `GetCommittee` answer of a validator in `epoch`, whose committee lists
 * the network keys of `members`, as the proto's plain object.
 */
function committeeAnswer(epoch: bigint, members: Validator[]) {
	const committee = unsignedCommittee(
		epoch,
		members.map((member, index) => ({
			consensusPubkey: new Uint8Array(32).fill(0x10 + index),
			networkPubkey: member.networkKey,
		})),
	);
	return {
		committee: {
			members: committee.members,
			attestation: committee.attestation,
			signer_noa_public_key: SIGNER_KEY,
			signature: ed25519.sign(committeeSigningMessage(committee.attestation), SIGNER_SEED),
		},
	};
}

/** A chain whose epoch is `state.epoch` and which registers the test signer. */
function chainAt(state: { epoch: bigint }): CommitteeChainReader {
	return {
		async currentEpoch() {
			return state.epoch;
		},
		async isRegisteredNetworkKey(noaPublicKey: Uint8Array) {
			return Buffer.from(noaPublicKey).equals(Buffer.from(SIGNER_KEY));
		},
	};
}

/** A localhost port nothing listens on. */
async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as { port: number }).port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

/** What a test server received. */
interface Received {
	/** The calls of `GetPresigns` and `SubmitTransaction`. */
	calls: number;
	/** The calls of `GetCommittee`. */
	committeeReads: number;
}

const received = (): Received => ({ calls: 0, committeeReads: 0 });

/**
 * Serve on `port`, over TLS with `validator`'s certificate, or in plaintext
 * when `validator` is `undefined`. It serves `GetPresigns` with no presigns,
 * `SubmitTransaction`, which answers `submitAnswer` (`INTERNAL` by
 * default), and `GetCommittee`, which answers `committee` (the committee of
 * epoch 7 listing this validator by default). Its first `unsignedReads`
 * reads of the committee answer `FAILED_PRECONDITION`, as a validator does
 * while its committee is not signed yet.
 */
async function serve(
	port: number,
	validator: Validator | undefined,
	counts: Received = received(),
	options: {
		/** The committee answer, or a function that gives it at each read. */
		committee?: object | (() => object);
		submitAnswer?: { code: grpc.status; details: string };
		/** How long the `n`-th `SubmitTransaction` call (from 1) waits before it is answered. */
		submitDelayMs?: (call: number) => number;
		unsignedReads?: number;
	} = {},
): Promise<grpc.Server> {
	const server = new grpc.Server();
	const committee = options.committee ?? committeeAnswer(7n, [validator ?? validatorOne]);
	server.addService(serviceDefinitionForTestsOnly(), {
		GetPresigns: (_call: unknown, callback: grpc.sendUnaryData<object>) => {
			counts.calls += 1;
			callback(null, { presigns: [] });
		},
		SubmitTransaction: (_call: unknown, callback: grpc.sendUnaryData<object>) => {
			counts.calls += 1;
			const answer = () =>
				callback(options.submitAnswer ?? { code: grpc.status.INTERNAL, details: 'test server' });
			const delayMs = options.submitDelayMs?.(counts.calls) ?? 0;
			if (delayMs > 0) {
				setTimeout(answer, delayMs);
			} else {
				answer();
			}
		},
		GetCommittee: (_call: unknown, callback: grpc.sendUnaryData<object>) => {
			counts.committeeReads += 1;
			if (counts.committeeReads <= (options.unsignedReads ?? 0)) {
				callback({
					code: grpc.status.FAILED_PRECONDITION,
					details: 'the committee of this epoch is not signed yet',
				});
				return;
			}
			callback(null, typeof committee === 'function' ? committee() : committee);
		},
	});
	const credentials = validator
		? grpc.ServerCredentials.createSsl(null, [
				{
					cert_chain: Buffer.from(validator.certificatePem),
					private_key: Buffer.from(validator.privateKeyPem),
				},
			])
		: grpc.ServerCredentials.createInsecure();
	await new Promise<void>((resolve, reject) =>
		server.bindAsync(`127.0.0.1:${port}`, credentials, (error) =>
			error ? reject(error) : resolve(),
		),
	);
	return server;
}

/** Wait, at most 10 s, until `channel` is no longer `READY`. */
async function leaveReady(channel: grpc.Channel): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (channel.getConnectivityState(false) === grpc.connectivityState.READY) {
		await new Promise<void>((resolve, reject) =>
			channel.watchConnectivityState(grpc.connectivityState.READY, deadline, (error) =>
				error ? reject(error) : resolve(),
			),
		);
	}
}

describe('the network-key certificate check', () => {
	it('accepts the node certificate under its own network key', () => {
		expect(() =>
			checkNetworkKeyCertificate(validatorOne.certificateDer, validatorOne.networkKey),
		).not.toThrow();
	});

	it('refuses the node certificate under another network key', () => {
		expect(() =>
			checkNetworkKeyCertificate(validatorOne.certificateDer, validatorTwo.networkKey),
		).toThrow(/is not the validator's network key/);
	});

	it('refuses a certificate whose signature is not its key', () => {
		const der = Uint8Array.from(validatorOne.certificateDer);
		// The certificate ends with its 64-byte Ed25519 signature.
		der[der.length - 1] ^= 0x01;
		expect(() => checkNetworkKeyCertificate(der, validatorOne.networkKey)).toThrow(
			/does not verify under its own key/,
		);
		expect(() => checkServedNetworkKeyCertificate(der)).toThrow(
			/does not verify under its own key/,
		);
	});

	it('gives the key of a served certificate that passes every other rule', () => {
		expect(checkServedNetworkKeyCertificate(validatorTwo.certificateDer)).toEqual(
			validatorTwo.networkKey,
		);
	});
});

describe('a client pinned to one network key', () => {
	const toClose: Array<() => void> = [];
	afterEach(() => {
		toClose.splice(0).forEach((close) => close());
	});

	it('reads the certificate a TLS server serves', async () => {
		const port = await freePort();
		const server = await serve(port, validatorOne);
		toClose.push(() => server.forceShutdown());
		expect(await fetchServedCertificate(`127.0.0.1:${port}`)).toEqual(validatorOne.certificateDer);
	});

	it('connects to a validator serving the certificate of the key it was given', async () => {
		const port = await freePort();
		const server = await serve(port, validatorOne);
		toClose.push(() => server.forceShutdown());
		const client = new DWalletGrpcClient(`127.0.0.1:${port}`, undefined, [], {
			networkPublicKey: validatorOne.networkKey,
		});
		toClose.push(() => client.close());
		expect(await client.getPresigns(new Uint8Array(32))).toEqual([]);
	});

	it('refuses a validator serving a certificate under another key', async () => {
		const port = await freePort();
		const server = await serve(port, validatorTwo);
		toClose.push(() => server.forceShutdown());
		const client = new DWalletGrpcClient(`127.0.0.1:${port}`, undefined, [], {
			networkPublicKey: validatorOne.networkKey,
		});
		toClose.push(() => client.close());
		await expect(client.getPresigns(new Uint8Array(32))).rejects.toMatchObject({
			code: grpc.status.FAILED_PRECONDITION,
			message: expect.stringMatching(/is not the validator's network key/),
		});
	});

	// The read of the network keys tries again after a transport failure. A
	// certificate under another key is a failed check, so the read fails at
	// once, although the error carries UNAVAILABLE.
	it('refuses at once, with no new try, a certificate under another key on the read of the network keys', async () => {
		const port = await freePort();
		const server = await serve(port, validatorTwo);
		toClose.push(() => server.forceShutdown());
		const client = new DWalletGrpcClient(`127.0.0.1:${port}`, undefined, [], {
			networkPublicKey: validatorOne.networkKey,
		});
		toClose.push(() => client.close());
		(client as any).networkKeysReadRetry = {
			attemptTimeoutMs: 5_000,
			pauseMs: 10_000,
			budgetMs: 60_000,
		};
		const started = Date.now();
		await expect(client.latestNetworkKeyId()).rejects.toMatchObject({
			code: grpc.status.FAILED_PRECONDITION,
			message: expect.stringMatching(/is not the validator's network key/),
		});
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	it('refuses a validator serving plaintext', async () => {
		const port = await freePort();
		const server = await serve(port, undefined);
		toClose.push(() => server.forceShutdown());
		const client = new DWalletGrpcClient(`127.0.0.1:${port}`, undefined, [], {
			networkPublicKey: validatorOne.networkKey,
		});
		toClose.push(() => client.close());
		await expect(client.getPresigns(new Uint8Array(32))).rejects.toMatchObject({
			// A server without TLS is not a refused key: it is not recorded, and
			// the next call tries it again.
			code: grpc.status.UNAVAILABLE,
			message: expect.stringMatching(/reading the TLS certificate of 127\.0\.0\.1:\d+ failed/),
		});
	});

	it('refuses to build a client for a validator with no tls, no key, no committee reader and no insecure flag', () => {
		expect(() => new DWalletGrpcClient('127.0.0.1:1')).toThrow(/insecure: true/);
		expect(() => new DWalletGrpcClient('127.0.0.1:1')).toThrow(/committeeReader/);
		expect(
			() =>
				new DWalletGrpcClient('127.0.0.1:1', undefined, [{ endpoint: '127.0.0.1:2' }], {
					insecure: true,
				}),
		).toThrow(/127\.0\.0\.1:2/);
	});
});

describe('a client pinned to the committee', () => {
	const toClose: Array<() => void> = [];
	afterEach(() => {
		toClose.splice(0).forEach((close) => close());
	});

	/** Serve `validator` on a free port, and close it after the test. */
	async function served(
		validator: Validator,
		options: Parameters<typeof serve>[3] = {},
	): Promise<{ endpoint: string; counts: Received; server: grpc.Server }> {
		const port = await freePort();
		const counts = received();
		const server = await serve(port, validator, counts, options);
		toClose.push(() => server.forceShutdown());
		return { endpoint: `127.0.0.1:${port}`, counts, server };
	}

	it('the first validator is kept when its key is in the committee', async () => {
		const member = await served(validatorOne);
		const client = new DWalletGrpcClient(member.endpoint, undefined, [], {
			committeeReader: chainAt({ epoch: 7n }),
		});
		toClose.push(() => client.close());
		expect(await client.getPresigns(new Uint8Array(32))).toEqual([]);
		expect(await client.getPresigns(new Uint8Array(32))).toEqual([]);
		expect(member.counts.committeeReads).toBe(1);
		expect(member.counts.calls).toBe(2);
	});

	it('a certificate under a member key is pinned', async () => {
		const committee = committeeAnswer(7n, [validatorOne, validatorTwo]);
		const busy = await served(validatorOne, {
			committee,
			submitAnswer: { code: grpc.status.UNAVAILABLE, details: 'busy' },
		});
		const ready = await served(validatorTwo, { committee });
		const client = new DWalletGrpcClient(busy.endpoint, undefined, [{ endpoint: ready.endpoint }], {
			committeeReader: chainAt({ epoch: 7n }),
		});
		toClose.push(() => client.close());
		// The second validator's answer, INTERNAL, shows the request reached it.
		await expect(
			client.submitTransaction(new Uint8Array(1), new Uint8Array(1), 20_000),
		).rejects.toMatchObject({ code: grpc.status.INTERNAL });
		expect(ready.counts.calls).toBe(1);
		// The committee read through the first validator already lists the
		// second one's key, so the second one is not asked for it.
		expect(ready.counts.committeeReads).toBe(0);
	}, 30_000);

	it('a certificate under a non-member key is refused', async () => {
		const committee = committeeAnswer(7n, [validatorOne]);
		const busy = await served(validatorOne, {
			committee,
			submitAnswer: { code: grpc.status.UNAVAILABLE, details: 'busy' },
		});
		const outsider = await served(validatorTwo, { committee });
		const client = new DWalletGrpcClient(
			busy.endpoint,
			undefined,
			[{ endpoint: outsider.endpoint }],
			{ committeeReader: chainAt({ epoch: 7n }) },
		);
		toClose.push(() => client.close());
		await expect(
			client.submitTransaction(new Uint8Array(1), new Uint8Array(1), 20_000),
		).rejects.toMatchObject({
			code: grpc.status.UNAVAILABLE,
			message: expect.stringMatching(/which is not the network key of a member/),
		});
		expect(outsider.counts.calls).toBe(0);
	}, 30_000);

	it('answers FAILED_PRECONDITION when the pin refuses every validator of a submission', async () => {
		const committee = committeeAnswer(7n, [validatorOne]);
		const firstOutsider = await served(validatorTwo, { committee });
		const secondOutsider = await served(validatorTwo, { committee });
		const client = new DWalletGrpcClient(
			firstOutsider.endpoint,
			undefined,
			[{ endpoint: secondOutsider.endpoint }],
			{ committeeReader: chainAt({ epoch: 7n }) },
		);
		toClose.push(() => client.close());
		// No validator is left to ask, and asking again would not change it,
		// so the code is not UNAVAILABLE, which a retry loop would repeat.
		await expect(
			client.submitTransaction(new Uint8Array(1), new Uint8Array(1), 20_000),
		).rejects.toMatchObject({
			code: grpc.status.FAILED_PRECONDITION,
			details: EVERY_VALIDATOR_REFUSED,
			message: expect.stringMatching(/which is not the network key of a member/),
		});
		expect(firstOutsider.counts.calls).toBe(0);
		expect(secondOutsider.counts.calls).toBe(0);
	}, 30_000);

	it('sets a validator refused by one submission up no second time for a submission running at the same time', async () => {
		const committee = committeeAnswer(7n, [validatorOne]);
		// The first validator is a busy member. It answers the first submission
		// at once and the second only after 1.5 s, so the second reaches the
		// outsider after the first has already been refused there.
		const busy = await served(validatorOne, {
			committee,
			submitAnswer: { code: grpc.status.UNAVAILABLE, details: 'busy' },
			submitDelayMs: (call) => (call === 1 ? 0 : 1_500),
		});
		const outsider = await served(validatorTwo, { committee });
		const member = await served(validatorOne, { committee });
		const client = new DWalletGrpcClient(
			busy.endpoint,
			undefined,
			[{ endpoint: outsider.endpoint }, { endpoint: member.endpoint }],
			{ committeeReader: chainAt({ epoch: 7n }) },
		);
		toClose.push(() => client.close());
		const submit = () => client.submitTransaction(new Uint8Array(1), new Uint8Array(1), 20_000);

		// Both submissions start together, so both start before any refusal is
		// recorded. Each ends at the member, which answers INTERNAL.
		const results = await Promise.allSettled([submit(), submit()]);

		results.forEach((result) =>
			expect(result).toMatchObject({
				status: 'rejected',
				reason: { code: grpc.status.INTERNAL },
			}),
		);
		expect(member.counts.calls).toBe(2);
		// The outsider was set up once: its one committee read. The second
		// submission checked the record before trying it, and passed it over.
		expect(outsider.counts.committeeReads).toBe(1);
		expect(outsider.counts.calls).toBe(0);
	}, 30_000);

	it('the first validator is dropped when its key is not in the committee', async () => {
		const committee = committeeAnswer(7n, [validatorOne]);
		const outsider = await served(validatorTwo, { committee });
		const member = await served(validatorOne, { committee });
		const client = new DWalletGrpcClient(
			outsider.endpoint,
			undefined,
			[{ endpoint: member.endpoint }],
			{ committeeReader: chainAt({ epoch: 7n }) },
		);
		toClose.push(() => client.close());
		// A request goes on to the member at once.
		await expect(
			client.submitTransaction(new Uint8Array(1), new Uint8Array(1), 20_000),
		).rejects.toMatchObject({ code: grpc.status.INTERNAL });
		expect(member.counts.calls).toBe(1);
		// The pin's refusal is recorded, so a read passes the outsider over and
		// goes to the member, and the outsider is not set up again: it served
		// its one committee read and nothing else. If the pin let the
		// outsider's key through, nothing would be recorded, the read would go
		// to the outsider and fail its handshake ("No connection established"),
		// so the read's answer is the direct sign.
		expect(await client.getPresigns(new Uint8Array(32))).toEqual([]);
		expect(member.counts.calls).toBe(2);
		expect(outsider.counts.calls).toBe(0);
		expect(outsider.counts.committeeReads).toBe(1);
	}, 30_000);

	it('moves a read past a first validator the pin refuses, and keeps reading from the next', async () => {
		const committee = committeeAnswer(7n, [validatorOne]);
		const outsider = await served(validatorTwo, { committee });
		const member = await served(validatorOne, { committee });
		const client = new DWalletGrpcClient(
			outsider.endpoint,
			undefined,
			[{ endpoint: member.endpoint }],
			{ committeeReader: chainAt({ epoch: 7n }) },
		);
		toClose.push(() => client.close());
		// The first read meets the refusal of the first validator and goes on
		// to the second at once.
		expect(await client.getPresigns(new Uint8Array(32))).toEqual([]);
		// The next read goes straight to the second: the refused validator is
		// recorded and not set up again.
		expect(await client.getPresigns(new Uint8Array(32))).toEqual([]);
		expect(member.counts.calls).toBe(2);
		expect(outsider.counts.calls).toBe(0);
		expect(outsider.counts.committeeReads).toBe(1);
	}, 30_000);

	it('asks a refused validator again once its refusal is older than the refusal period', async () => {
		const committee = committeeAnswer(7n, [validatorOne]);
		const outsider = await served(validatorTwo, { committee });
		const member = await served(validatorOne, { committee });
		const client = new DWalletGrpcClient(
			outsider.endpoint,
			undefined,
			[{ endpoint: member.endpoint }],
			{ committeeReader: chainAt({ epoch: 7n }) },
		);
		toClose.push(() => client.close());
		// The first read meets the refusal of the outsider and goes on to the
		// member.
		expect(await client.getPresigns(new Uint8Array(32))).toEqual([]);
		expect(outsider.counts.committeeReads).toBe(1);
		// A refusal can come from someone between the client and the
		// validator, so it holds only for a while. With a period of zero, the
		// recorded refusal has already passed, and the next read sets the
		// outsider up again: its committee is read through it a second time.
		// It is still an outsider, so it is refused again, and the read goes
		// on to the member.
		(client as any).refusalMaxAgeMs = 0;
		expect(await client.getPresigns(new Uint8Array(32))).toEqual([]);
		expect(
			outsider.counts.committeeReads,
			'a refusal older than the refusal period must expire, so the validator is asked again',
		).toBe(2);
		expect(outsider.counts.calls).toBe(0);
		expect(member.counts.calls).toBe(2);
	}, 30_000);

	it('measures a refusal on the monotonic clock, so a wall clock set back does not extend it', async () => {
		const committee = committeeAnswer(7n, [validatorOne]);
		const outsider = await served(validatorTwo, { committee });
		const member = await served(validatorOne, { committee });
		const client = new DWalletGrpcClient(
			outsider.endpoint,
			undefined,
			[{ endpoint: member.endpoint }],
			{ committeeReader: chainAt({ epoch: 7n }) },
		);
		toClose.push(() => client.close());
		let monotonic = 1_000;
		(client as any).monotonicNow = () => monotonic;
		// The first read records the outsider's refusal at monotonic time
		// 1000 and goes on to the member.
		expect(await client.getPresigns(new Uint8Array(32))).toEqual([]);
		expect(outsider.counts.committeeReads).toBe(1);
		// The wall clock is set back an hour, and the monotonic clock moves
		// on 61 seconds, past the 60-second refusal period. The refusal has
		// expired, so the next read sets the outsider up again: its committee
		// is read a second time. Measured on the wall clock, the refusal
		// would look an hour younger and still hold. The wall clock is set
		// back only while the client checks the record of refusals, which is
		// synchronous. grpc-js reads the same wall clock for its deadlines,
		// and the calls around the check must keep the true time.
		const isRefused = (client as any).isRefused.bind(client);
		(client as any).isRefused = (index: number) => {
			const realNow = Date.now.bind(Date);
			const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() - 3_600_000);
			try {
				return isRefused(index);
			} finally {
				clock.mockRestore();
			}
		};
		monotonic += 61_000;
		expect(await client.getPresigns(new Uint8Array(32))).toEqual([]);
		expect(
			outsider.counts.committeeReads,
			'a refusal must expire on the monotonic clock, even when the wall clock is set back',
		).toBe(2);
		expect(outsider.counts.calls).toBe(0);
		expect(member.counts.calls).toBe(2);
	}, 30_000);

	it('refuses a validator that serves an old committee', async () => {
		const formerMember = await served(validatorOne, {
			committee: committeeAnswer(6n, [validatorOne]),
		});
		const client = new DWalletGrpcClient(formerMember.endpoint, undefined, [], {
			committeeReader: chainAt({ epoch: 7n }),
		});
		toClose.push(() => client.close());
		await expect(client.getPresigns(new Uint8Array(32))).rejects.toMatchObject({
			// An old committee fails the committee check; it is not a refused key,
			// so it is not recorded.
			code: grpc.status.UNAVAILABLE,
			message: expect.stringMatching(/older than the chain's epoch 7/),
		});
		expect(formerMember.counts.calls).toBe(0);
	});

	it('a member of a later committee is accepted after the committee is read again', async () => {
		const chain = { epoch: 7n };
		const busy = await served(validatorOne, {
			committee: committeeAnswer(7n, [validatorOne]),
			submitAnswer: { code: grpc.status.UNAVAILABLE, details: 'busy' },
		});
		const later = await served(validatorTwo, { committee: committeeAnswer(8n, [validatorTwo]) });
		const client = new DWalletGrpcClient(busy.endpoint, undefined, [{ endpoint: later.endpoint }], {
			committeeReader: chainAt(chain),
		});
		toClose.push(() => client.close());
		// The first validator's committee is read, at epoch 7.
		expect(await client.getPresigns(new Uint8Array(32))).toEqual([]);
		chain.epoch = 8n;
		await expect(
			client.submitTransaction(new Uint8Array(1), new Uint8Array(1), 20_000),
		).rejects.toMatchObject({ code: grpc.status.INTERNAL });
		expect(later.counts.committeeReads).toBe(1);
		expect(later.counts.calls).toBe(1);
	}, 30_000);

	it('reads the certificate and the committee again after the validator changed its key', async () => {
		const port = await freePort();
		const before = received();
		const serverBefore = await serve(port, validatorOne, before);
		const chain = { epoch: 7n };
		const client = new DWalletGrpcClient(`127.0.0.1:${port}`, undefined, [], {
			committeeReader: chainAt(chain),
		});
		toClose.push(() => client.close());
		expect(await client.getPresigns(new Uint8Array(32))).toEqual([]);

		// The validator restarts with its new key in the next epoch, whose
		// committee lists it. The client's channel notices the closed
		// connection before the next call, as it would after a restart.
		const channel: grpc.Channel = (client as any).transport.service.getChannel();
		serverBefore.forceShutdown();
		await leaveReady(channel);
		const after = received();
		const serverAfter = await serve(port, validatorTwo, after, {
			committee: committeeAnswer(8n, [validatorTwo]),
		});
		toClose.push(() => serverAfter.forceShutdown());
		chain.epoch = 8n;

		// The open channel's connection is gone, and the next handshake
		// presents a certificate the channel's pin refuses. That failure makes
		// the client drop the channel, and the call after it reads the
		// certificate and the committee again.
		await expect(client.getPresigns(new Uint8Array(32))).rejects.toMatchObject({
			code: grpc.status.UNAVAILABLE,
			details: expect.stringMatching(/^No connection established/),
		});
		expect(await client.getPresigns(new Uint8Array(32))).toEqual([]);
		expect(before.committeeReads).toBe(1);
		expect(after.committeeReads).toBe(1);
	}, 30_000);

	it('refuses a former member once the chain passes the cached committee it came from', async () => {
		const chain = { epoch: 7n };
		const committee = committeeAnswer(7n, [validatorOne]);
		// Two endpoints serve the same member key: the first validator, and a
		// further one that keeps serving the old committee after it left.
		const firstPort = await freePort();
		const first = received();
		const firstServer = await serve(firstPort, validatorOne, first, {
			committee,
			submitAnswer: { code: grpc.status.UNAVAILABLE, details: 'busy' },
		});
		toClose.push(() => firstServer.forceShutdown());
		const former = await served(validatorOne, { committee });
		const client = new DWalletGrpcClient(
			`127.0.0.1:${firstPort}`,
			undefined,
			[{ endpoint: former.endpoint }],
			{ committeeReader: chainAt(chain) },
		);
		toClose.push(() => client.close());
		// A cached key is checked against a read of the chain's epoch at most
		// 1 s old.
		(client as any).transport.committeePin.chainEpochMaxAgeMs = 1_000;
		// The key is cached under the committee of epoch 7.
		expect(await client.getPresigns(new Uint8Array(32))).toEqual([]);

		// The chain passes epoch 7, and the last read grows older than 1 s.
		// The first validator's channel stays open, so nothing reads the chain.
		chain.epoch = 8n;
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		// A request goes on from the busy first
		// validator to a new connection with the same key. The client reads the
		// chain's epoch, drops the committee of epoch 7, reads the committee
		// again through that validator, and refuses its old committee.
		await expect(
			client.submitTransaction(new Uint8Array(1), new Uint8Array(1), 20_000),
		).rejects.toMatchObject({
			code: grpc.status.UNAVAILABLE,
			message: expect.stringMatching(/older than the chain's epoch 8/),
		});
		expect(former.counts.calls).toBe(0);
		expect(former.counts.committeeReads).toBe(1);

		// The first validator's channel, built under epoch 7, reconnects after a
		// restart. Its synchronous check uses the last read epoch, 8, and
		// refuses the key, so nothing reaches the validator.
		const channel: grpc.Channel = (client as any).transport.service.getChannel();
		firstServer.forceShutdown();
		await leaveReady(channel);
		const restarted = received();
		const restartedServer = await serve(firstPort, validatorOne, restarted, { committee });
		toClose.push(() => restartedServer.forceShutdown());
		await expect(client.getPresigns(new Uint8Array(32))).rejects.toMatchObject({
			code: grpc.status.UNAVAILABLE,
			details: expect.stringMatching(/^No connection established/),
		});
		expect(restarted.calls).toBe(0);
	}, 30_000);

	it("refuses a channel's own reconnect once the chain read is older than the maximum age", async () => {
		const chain = { epoch: 7n };
		const port = await freePort();
		const before = await serve(port, validatorOne);
		toClose.push(() => before.forceShutdown());
		const client = new DWalletGrpcClient(`127.0.0.1:${port}`, undefined, [], {
			committeeReader: chainAt(chain),
		});
		toClose.push(() => client.close());
		(client as any).transport.committeePin.chainEpochMaxAgeMs = 1_000;
		// The key is pinned under the committee of epoch 7.
		expect(await client.getPresigns(new Uint8Array(32))).toEqual([]);

		// The chain passes epoch 7 while the channel stays open, so nothing reads
		// the chain, and the last read grows older than the maximum age.
		chain.epoch = 8n;
		await new Promise((resolve) => setTimeout(resolve, 1_200));

		// The validator restarts with the same key, still serving the committee
		// of epoch 7, and the channel reconnects by itself. Its synchronous check
		// refuses: the last chain read is too old to trust the cached committee.
		const channel: grpc.Channel = (client as any).transport.service.getChannel();
		before.forceShutdown();
		await leaveReady(channel);
		const restarted = received();
		const after = await serve(port, validatorOne, restarted);
		toClose.push(() => after.forceShutdown());
		await expect(client.getPresigns(new Uint8Array(32))).rejects.toMatchObject({
			code: grpc.status.UNAVAILABLE,
			details: expect.stringMatching(/^No connection established/),
		});
		expect(restarted.calls).toBe(0);

		// The next call goes through the setup, which reads the chain again and
		// refuses the committee of epoch 7 as old.
		await expect(client.getPresigns(new Uint8Array(32))).rejects.toMatchObject({
			code: grpc.status.UNAVAILABLE,
			message: expect.stringMatching(/older than the chain's epoch 8/),
		});
		expect(restarted.calls).toBe(0);
	}, 30_000);

	it('drops a cached committee on the epoch a failed committee check read, and refuses its key at the next reconnect', async () => {
		const chain = { epoch: 7n };
		const committee = committeeAnswer(7n, [validatorOne]);
		const port = await freePort();
		const before = await serve(port, validatorOne, received(), {
			committee,
			submitAnswer: { code: grpc.status.UNAVAILABLE, details: 'busy' },
		});
		toClose.push(() => before.forceShutdown());
		// A validator outside the committee, which still serves the committee
		// of epoch 7.
		const outsider = await served(validatorTwo, { committee });
		const client = new DWalletGrpcClient(
			`127.0.0.1:${port}`,
			undefined,
			[{ endpoint: outsider.endpoint }],
			{ committeeReader: chainAt(chain) },
		);
		toClose.push(() => client.close());
		// The first validator's key is pinned under the committee of epoch 7.
		expect(await client.getPresigns(new Uint8Array(32))).toEqual([]);

		// The chain passes epoch 7. A request goes on from the busy first
		// validator to the outsider. Its committee check reads epoch 8 and fails
		// on the old committee 7, but the read of 8 is kept: the cached
		// committee 7 is dropped, although the last read is not old.
		chain.epoch = 8n;
		await expect(
			client.submitTransaction(new Uint8Array(1), new Uint8Array(1), 20_000),
		).rejects.toMatchObject({
			code: grpc.status.UNAVAILABLE,
			message: expect.stringMatching(/older than the chain's epoch 8/),
		});

		// The first validator restarts with the same key, and its channel
		// reconnects by itself. Its synchronous check finds the key in no held
		// committee and refuses it, so nothing reaches the validator.
		const channel: grpc.Channel = (client as any).transport.service.getChannel();
		before.forceShutdown();
		await leaveReady(channel);
		const restarted = received();
		const after = await serve(port, validatorOne, restarted, { committee });
		toClose.push(() => after.forceShutdown());
		await expect(client.getPresigns(new Uint8Array(32))).rejects.toMatchObject({
			code: grpc.status.UNAVAILABLE,
		});
		expect(restarted.calls).toBe(0);
	}, 30_000);

	it("does not record a member when another setup's chain read drops its committee between the add and the check", async () => {
		const chain = { epoch: 7n };
		let servedEpoch = 7n;
		const member = await served(validatorOne, {
			committee: () => committeeAnswer(servedEpoch, [validatorOne]),
		});
		const client = new DWalletGrpcClient(member.endpoint, undefined, [], {
			committeeReader: chainAt(chain),
		});
		toClose.push(() => client.close());
		// Another setup's chain read lands in the window between the step that
		// keeps the committee of epoch 7 and the code that runs after the
		// committee read returns. It reads epoch 8 and drops committee 7, as
		// the pin's own record of a chain read does. The window is made exact
		// by running that read's effect as the first microtask after the add.
		const pin = (client as any).transport.committeePin;
		const keep = pin.members.add.bind(pin.members);
		let concurrentReadDone = false;
		pin.members.add = (verified: unknown) => {
			keep(verified);
			if (!concurrentReadDone) {
				concurrentReadDone = true;
				queueMicrotask(() => {
					chain.epoch = 8n;
					servedEpoch = 8n;
					pin.recordChainEpoch(8n);
				});
			}
		};

		// The answer just checked listed the key, so the validator is not
		// recorded as refused. Its first connection then meets the dropped
		// committee and fails, as a passing failure.
		await expect(client.getPresigns(new Uint8Array(32))).rejects.toMatchObject({
			code: grpc.status.UNAVAILABLE,
		});
		expect(concurrentReadDone).toBe(true);
		// The next call reads the committee of epoch 8 through the same
		// validator, which is accepted.
		expect(await client.getPresigns(new Uint8Array(32))).toEqual([]);
		expect(member.counts.committeeReads).toBe(2);
		expect(member.counts.calls).toBe(1);
	}, 30_000);

	it('does not record a member whose committee meets a lagging chain read, and accepts its next committee', async () => {
		// The validator serves the committee of epoch 7 first, then that of 8,
		// and its key is in both.
		let servedEpoch = 7n;
		const member = await served(validatorOne, {
			committee: () => committeeAnswer(servedEpoch, [validatorOne]),
		});
		// The chain shows epoch 8 at the first read, then a lagging RPC answers
		// 7 once, then 8 from then on.
		const epochs = [8n, 7n];
		const chain: CommitteeChainReader = {
			async currentEpoch() {
				return epochs.length > 0 ? epochs.shift()! : 8n;
			},
			async isRegisteredNetworkKey(noaPublicKey: Uint8Array) {
				return Buffer.from(noaPublicKey).equals(Buffer.from(SIGNER_KEY));
			},
		};
		const client = new DWalletGrpcClient(member.endpoint, undefined, [], {
			committeeReader: chain,
		});
		toClose.push(() => client.close());
		// The committee of epoch 7 passes the check against the lagging read of
		// 7, but the client already read 8: it is an old committee, which is
		// not a refused key. The read fails with UNAVAILABLE.
		await expect(client.getPresigns(new Uint8Array(32))).rejects.toMatchObject({
			code: grpc.status.UNAVAILABLE,
			message: expect.stringMatching(/committee of epoch 7, older than the chain's epoch 8/),
		});
		// The validator was not recorded: once it serves the committee of epoch
		// 8, the next read sets it up again and is answered.
		servedEpoch = 8n;
		expect(await client.getPresigns(new Uint8Array(32))).toEqual([]);
		expect(member.counts.committeeReads).toBe(2);
		expect(member.counts.calls).toBe(1);
	}, 30_000);

	it('asks again for a committee not signed yet, and pins once it is signed', async () => {
		const member = await served(validatorOne, { unsignedReads: 1 });
		const client = new DWalletGrpcClient(member.endpoint, undefined, [], {
			committeeReader: chainAt({ epoch: 7n }),
		});
		toClose.push(() => client.close());
		(client as any).transport.committeePin.retry = { pauseMs: 50, budgetMs: 1_000 };
		expect(await client.getPresigns(new Uint8Array(32))).toEqual([]);
		expect(member.counts.committeeReads).toBe(2);
		expect(member.counts.calls).toBe(1);
	}, 30_000);

	it('refuses a pinned key at its next connection once a later committee leaves it out', async () => {
		const chain = { epoch: 7n };
		const firstPort = await freePort();
		const first = received();
		const firstServer = await serve(firstPort, validatorOne, first, {
			submitAnswer: { code: grpc.status.UNAVAILABLE, details: 'busy' },
		});
		toClose.push(() => firstServer.forceShutdown());
		const later = await served(validatorTwo, { committee: committeeAnswer(8n, [validatorTwo]) });
		const client = new DWalletGrpcClient(
			`127.0.0.1:${firstPort}`,
			undefined,
			[{ endpoint: later.endpoint }],
			{ committeeReader: chainAt(chain) },
		);
		toClose.push(() => client.close());
		// The first validator is pinned under the committee of epoch 7.
		expect(await client.getPresigns(new Uint8Array(32))).toEqual([]);

		// The chain moves to epoch 8. A request goes on from the busy first
		// validator to the second, whose committee of epoch 8 leaves out the
		// first validator's key. The client then drops the committee of epoch 7.
		chain.epoch = 8n;
		await expect(
			client.submitTransaction(new Uint8Array(1), new Uint8Array(1), 20_000),
		).rejects.toMatchObject({ code: grpc.status.INTERNAL });

		// The first validator restarts with the same key, and its channel must
		// connect again.
		const channel: grpc.Channel = (client as any).transport.service.getChannel();
		firstServer.forceShutdown();
		await leaveReady(channel);
		const restarted = received();
		const restartedServer = await serve(firstPort, validatorOne, restarted);
		toClose.push(() => restartedServer.forceShutdown());

		// The channel's own check refuses the key at the new connection, and
		// nothing reaches the validator.
		await expect(client.getPresigns(new Uint8Array(32))).rejects.toMatchObject({
			code: grpc.status.UNAVAILABLE,
			details: expect.stringMatching(/^No connection established/),
		});
		expect(restarted.calls).toBe(0);
		// The next setup reads the committee again, of epoch 7, which is now
		// older than the chain's epoch. That fails the committee check, which
		// is not a refused key: the read fails, and nothing reaches the
		// validator.
		await expect(client.getPresigns(new Uint8Array(32))).rejects.toMatchObject({
			code: grpc.status.UNAVAILABLE,
			message: expect.stringMatching(/older than the chain's epoch 8/),
		});
		expect(restarted.calls).toBe(0);
		expect(restarted.committeeReads).toBe(1);
	}, 30_000);

	it('does not record a validator whose setup failed a chain read, and sets it up again on the next call', async () => {
		const member = await served(validatorOne);
		// A chain whose first registration read fails, as an RPC that answers
		// an error once, and which answers from then on.
		let registrationReads = 0;
		const chain: CommitteeChainReader = {
			async currentEpoch() {
				return 7n;
			},
			async isRegisteredNetworkKey(noaPublicKey: Uint8Array) {
				registrationReads += 1;
				if (registrationReads === 1) {
					throw new Error('the chain RPC answered 503');
				}
				return Buffer.from(noaPublicKey).equals(Buffer.from(SIGNER_KEY));
			},
		};
		const client = new DWalletGrpcClient(member.endpoint, undefined, [], {
			committeeReader: chain,
		});
		toClose.push(() => client.close());
		// The failed chain read passes with time: the read fails with
		// UNAVAILABLE, and the validator is not recorded.
		await expect(client.getPresigns(new Uint8Array(32))).rejects.toMatchObject({
			code: grpc.status.UNAVAILABLE,
			message: expect.stringMatching(/the chain RPC answered 503/),
		});
		// The next call sets the validator up again, and the read succeeds.
		expect(await client.getPresigns(new Uint8Array(32))).toEqual([]);
		expect(member.counts.committeeReads).toBe(2);
		expect(member.counts.calls).toBe(1);
	}, 30_000);
});

/**
 * A TCP server on a free localhost port that accepts every connection and
 * never answers, so a TLS handshake with it never finishes. `connections`
 * counts the connections it accepted.
 */
async function serveSilence(): Promise<{
	endpoint: string;
	connections: number;
	close: () => void;
}> {
	const sockets: Socket[] = [];
	const server = createServer((socket) => {
		silent.connections += 1;
		sockets.push(socket);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const silent = {
		endpoint: `127.0.0.1:${(server.address() as { port: number }).port}`,
		connections: 0,
		close: () => {
			sockets.forEach((socket) => socket.destroy());
			server.close();
		},
	};
	return silent;
}

/**
 * A chain at epoch 7 that registers the test signer, whose reads of a
 * signer's registration wait until `release()` is called. `registrationReads`
 * counts those reads.
 */
function heldChain() {
	let release: () => void = () => {};
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const chain = {
		registrationReads: 0,
		release: () => release(),
		async currentEpoch() {
			return 7n;
		},
		async isRegisteredNetworkKey(noaPublicKey: Uint8Array) {
			chain.registrationReads += 1;
			await released;
			return Buffer.from(noaPublicKey).equals(Buffer.from(SIGNER_KEY));
		},
	};
	return chain;
}

/**
 * A chain at epoch 7 that registers the test signer, whose read of a signer's
 * registration number `i` answers only once `release(i)` is called.
 * `registrationReads` counts the reads started.
 */
function scriptedChain() {
	const releases: Array<() => void> = [];
	const chain = {
		registrationReads: 0,
		release: (read: number) => releases[read](),
		async currentEpoch() {
			return 7n;
		},
		async isRegisteredNetworkKey(noaPublicKey: Uint8Array) {
			const read = chain.registrationReads;
			chain.registrationReads += 1;
			await new Promise<void>((resolve) => {
				releases[read] = resolve;
			});
			return Buffer.from(noaPublicKey).equals(Buffer.from(SIGNER_KEY));
		},
	};
	return chain;
}

/** Wait, at most `timeoutMs` (10 s by default), until `condition()` holds. */
async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error(`the condition did not hold within ${timeoutMs / 1_000} s`);
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** How long `work` took to reject, and its error. Fails when it resolves. */
async function rejectionOf(work: Promise<unknown>): Promise<{ elapsed: number; error: any }> {
	const start = Date.now();
	try {
		await work;
	} catch (error) {
		return { elapsed: Date.now() - start, error };
	}
	throw new Error('the call resolved, and a rejection was expected');
}

/** Give `client`'s pinned setups a window of `ms` milliseconds instead of two minutes. */
function setupWindow(client: DWalletGrpcClient, ms: number): void {
	(client as any).transport.setupWindowMs = ms;
}

describe('the setup of a pinned connection has its own window', () => {
	const toClose: Array<() => void> = [];
	afterEach(() => {
		toClose.splice(0).forEach((close) => close());
	});

	it('finishes a setup that takes longer than the call deadline, and sends the call', async () => {
		const port = await freePort();
		const counts = received();
		const server = await serve(port, validatorOne, counts);
		toClose.push(() => server.forceShutdown());
		const chain = heldChain();
		toClose.push(() => chain.release());
		const client = new DWalletGrpcClient(`127.0.0.1:${port}`, undefined, [], {
			committeeReader: chain,
		});
		toClose.push(() => client.close());
		// The submission has 300 ms. The chain answers after 1 s.
		const submission = client.submitTransaction(new Uint8Array(1), new Uint8Array(1), 300);
		await until(() => chain.registrationReads === 1);
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		chain.release();
		// The test server's answer, INTERNAL, shows the call was sent.
		await expect(submission).rejects.toMatchObject({ code: grpc.status.INTERNAL });
		expect(counts.calls).toBe(1);
	}, 30_000);

	it('ends a submission at the end of the setup window while the chain never answers, and tries no further validator', async () => {
		const port = await freePort();
		const server = await serve(port, validatorOne);
		toClose.push(() => server.forceShutdown());
		const second = await serveSilence();
		toClose.push(second.close);
		const chain = heldChain();
		toClose.push(() => chain.release());
		const client = new DWalletGrpcClient(
			`127.0.0.1:${port}`,
			undefined,
			[{ endpoint: second.endpoint }],
			{ committeeReader: chain },
		);
		toClose.push(() => client.close());
		setupWindow(client, 2_000);
		const { elapsed, error } = await rejectionOf(
			client.submitTransaction(new Uint8Array(1), new Uint8Array(1), 600_000),
		);
		expect(error).toMatchObject({
			code: grpc.status.DEADLINE_EXCEEDED,
			message: expect.stringMatching(/were not read within the 2000 ms setup window/),
		});
		expect(elapsed).toBeLessThan(5_000);
		expect(chain.registrationReads).toBe(1);
		expect(second.connections).toBe(0);
	}, 30_000);

	it('ends a submission at the end of the setup window while the server never finishes TLS, and tries no further validator', async () => {
		const first = await serveSilence();
		const second = await serveSilence();
		toClose.push(first.close, second.close);
		const client = new DWalletGrpcClient(
			first.endpoint,
			undefined,
			[{ endpoint: second.endpoint, networkPublicKey: validatorOne.networkKey }],
			{ networkPublicKey: validatorOne.networkKey },
		);
		toClose.push(() => client.close());
		setupWindow(client, 300);
		const { elapsed, error } = await rejectionOf(
			client.submitTransaction(new Uint8Array(1), new Uint8Array(1), 600_000),
		);
		expect(error).toMatchObject({ code: grpc.status.DEADLINE_EXCEEDED });
		// The certificate fetch alone would wait 10 s.
		expect(elapsed).toBeLessThan(3_000);
		expect(first.connections).toBe(1);
		expect(second.connections).toBe(0);
	}, 30_000);

	it('ends a read at the end of the setup window, not at its 15 s deadline, while the chain never answers', async () => {
		const port = await freePort();
		const server = await serve(port, validatorOne);
		toClose.push(() => server.forceShutdown());
		const chain = heldChain();
		toClose.push(() => chain.release());
		const client = new DWalletGrpcClient(`127.0.0.1:${port}`, undefined, [], {
			committeeReader: chain,
		});
		toClose.push(() => client.close());
		setupWindow(client, 17_000);
		const { elapsed, error } = await rejectionOf(client.getPresigns(new Uint8Array(32)));
		expect(error).toMatchObject({ code: grpc.status.DEADLINE_EXCEEDED });
		expect(elapsed).toBeGreaterThanOrEqual(16_500);
		expect(elapsed).toBeLessThan(22_000);
	}, 60_000);

	it('starts a new setup on the next call after a setup passed its window', async () => {
		const port = await freePort();
		const counts = received();
		const server = await serve(port, validatorOne, counts);
		toClose.push(() => server.forceShutdown());
		const chain = heldChain();
		toClose.push(() => chain.release());
		const client = new DWalletGrpcClient(`127.0.0.1:${port}`, undefined, [], {
			committeeReader: chain,
		});
		toClose.push(() => client.close());
		setupWindow(client, 2_000);
		const { error } = await rejectionOf(client.getPresigns(new Uint8Array(32)));
		expect(error).toMatchObject({ code: grpc.status.DEADLINE_EXCEEDED });
		setupWindow(client, 120_000);
		// The next call starts a new setup, which reads the committee again and
		// waits in the chain read too.
		const next = client.getPresigns(new Uint8Array(32));
		await until(() => chain.registrationReads === 2);
		expect(counts.committeeReads).toBe(2);
		// The held reads now answer, for the forgotten setup and for the new
		// one. The forgotten setup's channel, whichever finishes first, is
		// closed.
		chain.release();
		expect(await next).toEqual([]);
	}, 30_000);

	/**
	 * A setup reads the first key's certificate and is forgotten at the end of
	 * its window while it checks the committee. The validator then serves the
	 * second key's certificate, and a newer setup reads it. The committee
	 * lists both keys. It returns the client, the newer setup's call, the
	 * chain, and a way to swap the certificate the validator serves. The
	 * forgotten setup must never install its channel, whichever setup
	 * finishes first.
	 */
	async function forgottenSetupAndNewerSetup() {
		const port = await freePort();
		const committee = committeeAnswer(7n, [validatorOne, validatorTwo]);
		let server = await serve(port, validatorOne, received(), { committee });
		toClose.push(() => server.forceShutdown());
		const serveCertificateOf = async (validator: Validator) => {
			server.forceShutdown();
			server = await serve(port, validator, received(), { committee });
		};
		const chain = scriptedChain();
		toClose.push(() => {
			for (let read = 0; read < chain.registrationReads; read += 1) {
				chain.release(read);
			}
		});
		const client = new DWalletGrpcClient(`127.0.0.1:${port}`, undefined, [], {
			committeeReader: chain,
		});
		toClose.push(() => client.close());
		setupWindow(client, 2_000);
		const { error } = await rejectionOf(client.getPresigns(new Uint8Array(32)));
		expect(error).toMatchObject({ code: grpc.status.DEADLINE_EXCEEDED });
		// The newer setup gets a full window, so it waits for its release.
		setupWindow(client, 120_000);
		await serveCertificateOf(validatorTwo);
		const newer = client.getPresigns(new Uint8Array(32));
		await until(() => chain.registrationReads === 2);
		return { client, newer, chain, serveCertificateOf };
	}

	it('uses the newer setup when the forgotten setup for the first key finishes first', async () => {
		const { newer, chain } = await forgottenSetupAndNewerSetup();

		// The forgotten setup builds a channel pinned to the first key, which
		// the validator no longer serves.
		chain.release(0);
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		chain.release(1);

		// A call on a channel pinned to the first key would fail its handshake.
		expect(await newer).toEqual([]);
	}, 30_000);

	it('keeps the newer setup when the forgotten setup for the first key finishes last', async () => {
		const { client, newer, chain } = await forgottenSetupAndNewerSetup();

		chain.release(1);
		expect(await newer).toEqual([]);

		// The forgotten setup finishes now, with a channel pinned to the first
		// key, and must close it.
		chain.release(0);
		await new Promise((resolve) => setTimeout(resolve, 1_000));

		expect(await client.getPresigns(new Uint8Array(32))).toEqual([]);
		expect(chain.registrationReads).toBe(2);
	}, 30_000);

	// The window passes between the check before the setup starts and the wait
	// for it (`beforeDeadline`'s `remaining <= 0`). The call then rejects at
	// once, before anything waits on the setup. The setup, which finishes
	// later, closes its channel and rejects, and only `beforeDeadline`'s own
	// `catch` observes that rejection: Node ends the process on one that is
	// not observed. While time is left the race inside `beforeDeadline`
	// observes it too, so only this path tests that `catch`.
	//
	// A tiny window cannot reach this path: the committee read takes the
	// window's end as its own gRPC deadline, so with 1 ms the read fails at
	// once and the setup never gets as far as the chain. So the clock is moved
	// instead, at the moment the setup starts.
	it('leaves no unobserved rejection when the window passes as the setup starts', async () => {
		const port = await freePort();
		const server = await serve(port, validatorOne);
		toClose.push(() => server.forceShutdown());
		const unobserved: unknown[] = [];
		const onUnhandled = (reason: unknown) => unobserved.push(reason);
		process.on('unhandledRejection', onUnhandled);
		toClose.push(() => process.off('unhandledRejection', onUnhandled));
		const client = new DWalletGrpcClient(`127.0.0.1:${port}`, undefined, [], {
			committeeReader: chainAt({ epoch: 7n }),
		});
		toClose.push(() => client.close());
		const frozenAt = Date.now();
		let clockMoved = false;
		const clock = vi
			.spyOn(Date, 'now')
			.mockImplementation(() => (clockMoved ? frozenAt + 3_600_000 : frozenAt));
		toClose.push(() => clock.mockRestore());
		// The setup step, wrapped: the window passes as it starts, and the
		// test learns when the setup itself has settled.
		const transport = (client as any).transport;
		const startSetup = transport.pinnedServiceAt;
		let setupSettled = false;
		transport.pinnedServiceAt = (index: number, setupDeadline: number) => {
			clockMoved = true;
			const setup: Promise<unknown> = startSetup(index, setupDeadline);
			setup.then(
				() => {
					setupSettled = true;
				},
				() => {
					setupSettled = true;
				},
			);
			return setup;
		};

		await expect(client.getPresigns(new Uint8Array(32))).rejects.toMatchObject({
			code: grpc.status.DEADLINE_EXCEEDED,
		});
		// The call rejected before the setup finished: it reached the path.
		expect(clockMoved).toBe(true);
		expect(setupSettled).toBe(false);
		clock.mockRestore();

		// The forgotten setup now reads the certificate and the committee,
		// checks it, and builds its channel; the transport then closes that
		// channel and rejects. That rejection follows the setup's own settling
		// in the same turn, and Node reports an unobserved rejection at the end
		// of that turn, before `until` looks again.
		await until(() => setupSettled, 30_000);
		await new Promise((resolve) => setImmediate(resolve));

		expect(unobserved).toEqual([]);
	}, 60_000);
});

describe('a closed client', () => {
	const toClose: Array<() => void> = [];
	afterEach(() => {
		toClose.splice(0).forEach((close) => close());
	});

	it('sends nothing when close() ran while the pinned setup was pending', async () => {
		const port = await freePort();
		const counts = received();
		const server = await serve(port, validatorOne, counts);
		toClose.push(() => server.forceShutdown());
		const chain = heldChain();
		toClose.push(() => chain.release());
		const client = new DWalletGrpcClient(`127.0.0.1:${port}`, undefined, [], {
			committeeReader: chain,
		});
		toClose.push(() => client.close());
		const submission = client.submitTransaction(new Uint8Array(1), new Uint8Array(1), 20_000);
		await until(() => chain.registrationReads === 1);
		client.close();
		chain.release();
		const { error } = await rejectionOf(submission);
		expect(error.message).toBe('the client is closed');
		// A later read is refused too, and nothing reached the server.
		const { error: later } = await rejectionOf(client.getPresigns(new Uint8Array(32)));
		expect(later.message).toBe('the client is closed');
		expect(counts.calls).toBe(0);
	}, 30_000);

	it('ends a call waiting on a pinned setup that never finishes at close(), not at the window', async () => {
		const port = await freePort();
		const counts = received();
		const server = await serve(port, validatorOne, counts);
		toClose.push(() => server.forceShutdown());
		// The chain is never released while the call waits, so the setup
		// never finishes.
		const chain = heldChain();
		toClose.push(() => chain.release());
		const client = new DWalletGrpcClient(`127.0.0.1:${port}`, undefined, [], {
			committeeReader: chain,
		});
		toClose.push(() => client.close());
		setupWindow(client, 5_000);
		const submission = client.submitTransaction(new Uint8Array(1), new Uint8Array(1), 20_000);
		await until(() => chain.registrationReads === 1);
		client.close();
		const { elapsed, error } = await rejectionOf(submission);
		expect(error.message).toBe('the client is closed');
		expect(elapsed).toBeLessThan(2_000);
		expect(counts.calls).toBe(0);
	}, 30_000);

	it('refuses every call after close(), and reads nothing', async () => {
		const chain = heldChain();
		toClose.push(() => chain.release());
		const pinned = new DWalletGrpcClient(`127.0.0.1:${await freePort()}`, undefined, [], {
			committeeReader: chain,
		});
		pinned.close();
		const { error } = await rejectionOf(pinned.getPresigns(new Uint8Array(32)));
		expect(error.message).toBe('the client is closed');
		expect(chain.registrationReads).toBe(0);

		const port = await freePort();
		const counts = received();
		const server = await serve(port, undefined, counts);
		toClose.push(() => server.forceShutdown());
		const plaintext = new DWalletGrpcClient(`127.0.0.1:${port}`, undefined, [], {
			insecure: true,
		});
		expect(await plaintext.getPresigns(new Uint8Array(32))).toEqual([]);
		plaintext.close();
		const { error: afterClose } = await rejectionOf(
			plaintext.submitTransaction(new Uint8Array(1), new Uint8Array(1), 5_000),
		);
		expect(afterClose.message).toBe('the client is closed');
		expect(counts.calls).toBe(1);
	}, 30_000);
});
