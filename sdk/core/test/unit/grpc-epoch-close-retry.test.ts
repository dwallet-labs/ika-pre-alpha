// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

import { status } from '@grpc/grpc-js';
import { describe, expect, it } from 'vitest';

import { TransactionResponseDataBcs } from '../../src/grpc/bcs';
import {
	DWalletGrpcClient,
	EPOCH_CLOSING_REFUSAL,
	EVERY_VALIDATOR_REFUSED,
	GAS_WAIT_ENDED_WITH_THE_EPOCH,
	isEpochClosingRefusal,
} from '../../src/grpc/client';
import { markNotACommitteeMember, markRefusedPinnedSetup } from '../../src/grpc/transport';
import { callThroughStubs } from './stub-validators';

/**
 * Carrying a request into the next epoch when the validator answers that
 * the epoch is closing.
 *
 * From the epoch's cutoff round on, a validator refuses every request with
 * the retryable `UNAVAILABLE` and one of two epoch-closing sentences. A
 * signed request names its epoch, so the client waits for the next epoch and
 * signs the request again for it.
 */
describe('submitting across the epoch close', () => {
	/** The error grpc-js throws for a status a validator answers. */
	function grpcError(code: number, details: string): Error {
		return Object.assign(new Error(`${code} ${status[code]}: ${details}`), { code, details });
	}

	const closing = () => grpcError(status.UNAVAILABLE, EPOCH_CLOSING_REFUSAL);

	const signature = TransactionResponseDataBcs.serialize({
		Signature: { signature: [1, 2, 3] },
	}).toBytes();

	type Answer = Error | Uint8Array;

	/**
	 * A client whose transport answers `SubmitTransaction` with `answers` in
	 * turn (a signature once they run out), or with what `answers` returns for
	 * the submitted bytes. It records the `signed_request_data` of each
	 * submission in `submitted`, and its `user_signature` in `signatures`, in
	 * order, when it is sent. `delayMs` gives how long the answer to the
	 * submitted bytes waits; none by default.
	 */
	function clientAnswering(
		answers: Answer[] | ((bytes: number[]) => Answer),
		delayMs: (bytes: number[]) => number = () => 0,
	): {
		client: DWalletGrpcClient;
		submitted: number[][];
		signatures: number[][];
	} {
		const submitted: number[][] = [];
		const signatures: number[][] = [];
		const client = Object.create(DWalletGrpcClient.prototype) as {
			service: unknown;
			call: unknown;
			furtherValidatorCount: number;
			monotonicNow: () => number;
		};
		client.furtherValidatorCount = 0;
		// Object.create runs no field initializer, so the clock a refusal is
		// recorded on is set here, as the class sets it.
		client.monotonicNow = () => performance.now();
		client.call = callThroughStubs(() => [client.service]);
		client.service = {
			SubmitTransaction: (
				request: { user_signature: Uint8Array; signed_request_data: Uint8Array },
				_options: object,
				callback: (error: Error | null, response?: object) => void,
			) => {
				const bytes = [...request.signed_request_data];
				submitted.push(bytes);
				signatures.push([...request.user_signature]);
				const answer =
					typeof answers === 'function' ? answers(bytes) : (answers.shift() ?? signature);
				const respond = () => {
					if (answer instanceof Error) {
						callback(answer);
					} else {
						callback(null, { response_data: Buffer.from(answer) });
					}
				};
				// Answered on a later turn of the event loop, as a real call is,
				// so timers still fire while a client loops.
				const delay = delayMs(bytes);
				if (delay > 0) {
					setTimeout(respond, delay);
				} else {
					setImmediate(respond);
				}
			},
		};
		return { client: client as unknown as DWalletGrpcClient, submitted, signatures };
	}

	/** An epoch reader that answers `epochs` in turn, keeping the last one. */
	function epochsInTurn(epochs: bigint[]): {
		currentEpoch: () => Promise<bigint>;
		reads: () => number;
	} {
		let reads = 0;
		return {
			currentEpoch: async () => {
				reads++;
				return epochs.length > 1 ? epochs.shift()! : epochs[0];
			},
			reads: () => reads,
		};
	}

	/** Signs a request whose bytes are its epoch, and records each epoch it signs for. */
	function signer(): {
		build: (epoch: bigint) => Promise<{ userSignature: Uint8Array; signedRequestData: Uint8Array }>;
		signedFor: bigint[];
	} {
		const signedFor: bigint[] = [];
		return {
			build: async (epoch) => {
				signedFor.push(epoch);
				return {
					userSignature: new Uint8Array([0xaa]),
					signedRequestData: new Uint8Array([Number(epoch)]),
				};
			},
			signedFor,
		};
	}



	it('tells the epoch-closing refusals from other UNAVAILABLE answers', () => {
		expect(isEpochClosingRefusal(closing())).toBe(true);
		expect(
			isEpochClosingRefusal(grpcError(status.UNAVAILABLE, GAS_WAIT_ENDED_WITH_THE_EPOCH)),
		).toBe(true);
		expect(isEpochClosingRefusal(grpcError(status.UNAVAILABLE, 'validator is shutting down'))).toBe(
			false,
		);
		expect(isEpochClosingRefusal(grpcError(status.INVALID_ARGUMENT, EPOCH_CLOSING_REFUSAL))).toBe(
			false,
		);
		expect(
			isEpochClosingRefusal(grpcError(status.INVALID_ARGUMENT, GAS_WAIT_ENDED_WITH_THE_EPOCH)),
		).toBe(false);
		expect(isEpochClosingRefusal(undefined)).toBe(false);
	});

	it('on the epoch-closing refusal, waits for the next epoch and sends a request signed for it', async () => {
		const { client, submitted } = clientAnswering([closing(), signature]);
		// The first read builds the request; the wait then sees epoch 7 twice
		// before epoch 8.
		const epochs = epochsInTurn([7n, 7n, 7n, 8n]);
		const { build, signedFor } = signer();

		const response = await client.submitTransactionAcrossEpochClose({
			build,
			currentEpoch: epochs.currentEpoch,
			epochWaitMs: 5_000,
			pollIntervalMs: 1,
		});

		expect(response.Signature?.signature).toEqual([1, 2, 3]);
		expect(signedFor, 'the request is signed again for the new epoch').toEqual([7n, 8n]);
		expect(submitted, 'the resent request is the one signed for the new epoch').toEqual([[7], [8]]);
	});

	it('treats the gas wait ended by the epoch as an epoch-closing refusal, and signs again for the next epoch', async () => {
		const { client, submitted } = clientAnswering([
			grpcError(status.UNAVAILABLE, GAS_WAIT_ENDED_WITH_THE_EPOCH),
			signature,
		]);
		const epochs = epochsInTurn([7n, 7n, 8n]);
		const { build, signedFor } = signer();

		const response = await client.submitTransactionAcrossEpochClose({
			build,
			currentEpoch: epochs.currentEpoch,
			epochWaitMs: 5_000,
			pollIntervalMs: 1,
		});

		expect(response.Signature?.signature).toEqual([1, 2, 3]);
		expect(signedFor, 'the request is signed again for the new epoch').toEqual([7n, 8n]);
		expect(submitted, 'the resent request is the one signed for the new epoch').toEqual([[7], [8]]);
	});

	it('sends the same request again while the validator has not entered the new epoch or is not listening', async () => {
		const { client, submitted } = clientAnswering([
			closing(),
			// The validator is still in epoch 7.
			grpcError(
				status.UNAVAILABLE,
				'this validator has not entered the epoch the request names yet; retry shortly ' +
					'(request epoch 8, current epoch 7)',
			),
			// Its gRPC server is down while it reconfigures.
			grpcError(status.UNAVAILABLE, 'No connection established. Last error: ECONNREFUSED'),
			signature,
		]);
		const epochs = epochsInTurn([7n, 8n]);
		const { build, signedFor } = signer();

		const response = await client.submitTransactionAcrossEpochClose({
			build,
			currentEpoch: epochs.currentEpoch,
			epochWaitMs: 5_000,
			pollIntervalMs: 1,
		});

		expect(response.Signature?.signature).toEqual([1, 2, 3]);
		expect(signedFor, 'the request is signed once for the new epoch').toEqual([7n, 8n]);
		expect(submitted, 'the same request for the new epoch is sent until it is answered').toEqual([
			[7],
			[8],
			[8],
			[8],
		]);
	});

	it('resends the bytes build returned, even when the caller changes its arrays meanwhile', async () => {
		// The arrays each call to `build` returned, which the caller still holds.
		const returned: Uint8Array[] = [];
		const returnedSignatures: Uint8Array[] = [];
		const build = async (epoch: bigint) => {
			const signedRequestData = new Uint8Array([Number(epoch)]);
			const userSignature = new Uint8Array([0xaa]);
			returned.push(signedRequestData);
			returnedSignatures.push(userSignature);
			return { userSignature, signedRequestData };
		};
		const answers: Answer[] = [
			closing(),
			grpcError(status.UNAVAILABLE, 'No connection established. Last error: ECONNREFUSED'),
			signature,
		];
		const { client, submitted, signatures } = clientAnswering((bytes) => {
			// While the first send for epoch 8 is pending, the caller rewrites
			// both arrays `build` returned for epoch 8.
			if (bytes[0] === 8) {
				returned[1].fill(0x99);
				returnedSignatures[1].fill(0x99);
			}
			return answers.shift() ?? signature;
		});
		const epochs = epochsInTurn([7n, 8n]);

		const response = await client.submitTransactionAcrossEpochClose({
			build,
			currentEpoch: epochs.currentEpoch,
			epochWaitMs: 5_000,
			pollIntervalMs: 1,
		});

		expect(response.Signature?.signature).toEqual([1, 2, 3]);
		expect(submitted, 'the resend carries the bytes build returned for epoch 8').toEqual([
			[7],
			[8],
			[8],
		]);
		expect(signatures, 'the resend carries the signature build returned for epoch 8').toEqual([
			[0xaa],
			[0xaa],
			[0xaa],
		]);
	});

	it("stops at once with FAILED_PRECONDITION when the pin refused every validator's key", async () => {
		// The transport's refusal of a validator whose key is not a committee
		// member's: UNAVAILABLE, so a submission goes on to the next validator,
		// and marked as a refused key. With every validator refused,
		// submitTransaction answers FAILED_PRECONDITION, which ends the wait.
		const refused = grpcError(
			status.UNAVAILABLE,
			'the validator at 127.0.0.1:1 serves the network key 00, which is not the network key ' +
				'of a member of the committee the network signed',
		);
		markNotACommitteeMember(refused);
		const { client, submitted } = clientAnswering([closing(), refused, signature]);
		const epochs = epochsInTurn([7n, 8n]);
		const { build } = signer();

		await expect(
			client.submitTransactionAcrossEpochClose({
				build,
				currentEpoch: epochs.currentEpoch,
				epochWaitMs: 5_000,
				pollIntervalMs: 1,
			}),
		).rejects.toMatchObject({
			// The client's one validator was refused, so no validator is left.
			code: status.FAILED_PRECONDITION,
			details: EVERY_VALIDATOR_REFUSED,
			cause: refused,
		});
		expect(submitted, 'the refused request is not sent again').toEqual([[7], [8]]);
	});

	it('sends the request again after a pinned setup failure that passes with time, and is answered', async () => {
		// The transport's error when the last validator's setup meets a chain
		// read that lags: UNAVAILABLE, marked as a refused setup, but not as a
		// refused key. The next call sets the validator up again.
		const lagging = grpcError(
			status.UNAVAILABLE,
			'no pinned TLS connection to 127.0.0.1:1: the committee read from 127.0.0.1:1 failed: ' +
				"the validator answered the committee of epoch 7, older than the chain's epoch 8 read before",
		);
		markRefusedPinnedSetup(lagging);
		const { client, submitted } = clientAnswering([closing(), lagging, signature]);
		const epochs = epochsInTurn([7n, 8n]);
		const { build } = signer();

		const response = await client.submitTransactionAcrossEpochClose({
			build,
			currentEpoch: epochs.currentEpoch,
			epochWaitMs: 5_000,
			pollIntervalMs: 1,
		});

		expect(response.Signature?.signature).toEqual([1, 2, 3]);
		expect(submitted, 'the request for the new epoch is sent again and answered').toEqual([
			[7],
			[8],
			[8],
		]);
	});

	it('never signs again for an epoch that refused the request, when a read answers an older epoch', async () => {
		const refused: bigint[] = [];
		const { client, submitted } = clientAnswering((bytes) => {
			if (bytes[0] === 7) {
				refused.push(7n);
				return closing();
			}
			return signature;
		});
		// A reader behind a load balancer: after the first read it answers
		// 8, 7, 8, 7, ...
		let reads = 0;
		const currentEpoch = async () => (reads++ % 2 === 0 ? 7n : 8n);
		const signedFor: bigint[] = [];
		const build = async (epoch: bigint) => {
			if (refused.some((epochThatRefused) => epoch <= epochThatRefused)) {
				throw new Error(`signed again for epoch ${epoch}, at or below an epoch that refused it`);
			}
			signedFor.push(epoch);
			return {
				userSignature: new Uint8Array([0xaa]),
				signedRequestData: new Uint8Array([Number(epoch)]),
			};
		};

		const response = await client.submitTransactionAcrossEpochClose({
			build,
			currentEpoch,
			epochWaitMs: 5_000,
			pollIntervalMs: 1,
		});

		expect(response.Signature?.signature).toEqual([1, 2, 3]);
		expect(signedFor, 'the request is signed for the epoch the wait saw').toEqual([7n, 8n]);
		expect(submitted).toEqual([[7], [8]]);
	});

	it('bounds everything after the first refusal, even when every new epoch refuses too', async () => {
		// Every read shows a later epoch, and every epoch refuses: no single
		// wait is long, so only the bound over the whole call ends it.
		const { client, submitted } = clientAnswering(() => closing());
		let next = 7n;
		const currentEpoch = async () => next++;
		const { build, signedFor } = signer();

		const started = Date.now();
		await expect(
			client.submitTransactionAcrossEpochClose({
				build,
				currentEpoch,
				epochWaitMs: 60,
				pollIntervalMs: 1,
			}),
		).rejects.toThrow(/is closing, and the request was not answered in a later epoch within 60 ms/);
		expect(Date.now() - started, 'the call ends at its bound').toBeLessThan(2_000);
		expect(submitted.length).toBeGreaterThan(1);
		expect(
			signedFor.every((epoch, index) => index === 0 || epoch > signedFor[index - 1]),
			'each new request names a later epoch than the one before',
		).toBe(true);
	}, 5_000);

	it('bounds the resends to a validator that stays unavailable', async () => {
		const { client, submitted } = clientAnswering((bytes) =>
			bytes[0] === 7 ? closing() : grpcError(status.UNAVAILABLE, 'No connection established'),
		);
		const epochs = epochsInTurn([7n, 8n]);

		const started = Date.now();
		await expect(
			client.submitTransactionAcrossEpochClose({
				build: signer().build,
				currentEpoch: epochs.currentEpoch,
				epochWaitMs: 60,
				pollIntervalMs: 5,
			}),
		).rejects.toThrow(
			'the validator refused the request because epoch 7 is closing, and the request was not answered in a later epoch within 60 ms',
		);
		const elapsed = Date.now() - started;
		expect(elapsed, 'the resends end at the bound').toBeGreaterThanOrEqual(60);
		expect(elapsed, 'the resends end at the bound').toBeLessThan(2_000);
		expect(submitted.length, 'the request was sent again').toBeGreaterThan(2);
		expect(submitted.slice(1).every((bytes) => bytes[0] === 8)).toBe(true);
	}, 5_000);

	it('records a closing refusal that arrives after the bound, before the call ends', async () => {
		// The request names epoch 4 and is refused because 4 is closing. It is
		// rebuilt for 5, and the refusal because 5 is closing arrives after the
		// 50 ms bound has passed, so the call ends without reading the epoch
		// again. The record is the first open epoch, as the Solana examples'
		// `Network` keeps it: the epoch after the latest refused one. It must
		// be 6, not the 5 the first refusal left.
		const { client, submitted } = clientAnswering(
			() => closing(),
			(bytes) => (bytes[0] === 5 ? 80 : 0),
		);
		const epochs = epochsInTurn([4n, 5n]);
		let earliestOpenEpoch = 0n;

		await expect(
			client.submitTransactionAcrossEpochClose({
				build: signer().build,
				currentEpoch: epochs.currentEpoch,
				recordClosingRefusal: (refusedEpoch) => {
					if (refusedEpoch + 1n > earliestOpenEpoch) {
						earliestOpenEpoch = refusedEpoch + 1n;
					}
				},
				epochWaitMs: 50,
				pollIntervalMs: 1,
			}),
		).rejects.toThrow(
			'the validator refused the request because epoch 5 is closing, and the request was not answered in a later epoch within 50 ms',
		);
		expect(submitted).toEqual([[4], [5]]);
		expect(epochs.reads(), 'the epoch is not read again after the late refusal').toBe(2);
		expect(earliestOpenEpoch, 'the late refusal at 5 makes the record 6').toBe(6n);
	}, 5_000);

	it('gives up with an error naming the epoch when the epoch never changes', async () => {
		const { client, submitted } = clientAnswering([closing()]);
		const epochs = epochsInTurn([7n]);
		const { build, signedFor } = signer();

		const started = Date.now();
		await expect(
			client.submitTransactionAcrossEpochClose({
				build,
				currentEpoch: epochs.currentEpoch,
				epochWaitMs: 50,
				pollIntervalMs: 10,
			}),
		).rejects.toThrow(
			'the validator refused the request because epoch 7 is closing, and the request was not answered in a later epoch within 50 ms',
		);

		const elapsed = Date.now() - started;
		expect(elapsed, 'the wait ends at its bound').toBeGreaterThanOrEqual(50);
		expect(elapsed, 'the wait ends at its bound').toBeLessThan(2_000);
		expect(epochs.reads(), 'the epoch is read every poll interval while waiting').toBeGreaterThan(
			2,
		);
		expect(signedFor).toEqual([7n]);
		expect(submitted, 'nothing is resent in the same epoch').toEqual([[7]]);
	}, 5_000);

	it('ends the wait at its bound when an epoch read never answers', async () => {
		const { client, submitted } = clientAnswering([closing()]);
		let reads = 0;
		const currentEpoch = () =>
			reads++ === 0 ? Promise.resolve(7n) : new Promise<bigint>(() => undefined);

		const started = Date.now();
		await expect(
			client.submitTransactionAcrossEpochClose({
				build: signer().build,
				currentEpoch,
				epochWaitMs: 50,
				pollIntervalMs: 10,
			}),
		).rejects.toThrow(
			/epoch 7 is closing, and the request was not answered in a later epoch within 50 ms/,
		);
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(submitted).toEqual([[7]]);
	}, 5_000);

	it('ends the wait at its bound when signing again never returns', async () => {
		const { client, submitted } = clientAnswering([closing()]);
		const { currentEpoch } = epochsInTurn([7n, 8n]);
		let builds = 0;
		const build = (epoch: bigint) =>
			builds++ === 0
				? Promise.resolve({
						userSignature: new Uint8Array([0xaa]),
						signedRequestData: new Uint8Array([Number(epoch)]),
					})
				: new Promise<{ userSignature: Uint8Array; signedRequestData: Uint8Array }>(
						() => undefined,
					);

		const started = Date.now();
		await expect(
			client.submitTransactionAcrossEpochClose({
				build,
				currentEpoch,
				epochWaitMs: 50,
				pollIntervalMs: 10,
			}),
		).rejects.toThrow(
			/epoch 7 is closing, and the request was not answered in a later epoch within 50 ms/,
		);
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(builds).toBe(2);
		expect(submitted).toEqual([[7]]);
	}, 5_000);

	it('does not accept an epoch read that answers after the bound', async () => {
		const { client, submitted } = clientAnswering([closing()]);
		let reads = 0;
		const currentEpoch = () =>
			reads++ === 0
				? Promise.resolve(7n)
				: new Promise<bigint>((resolve) => setTimeout(() => resolve(8n), 150));
		const { build, signedFor } = signer();

		await expect(
			client.submitTransactionAcrossEpochClose({
				build,
				currentEpoch,
				epochWaitMs: 30,
				pollIntervalMs: 10,
			}),
		).rejects.toThrow(/epoch 7 is closing/);
		expect(signedFor, 'nothing is signed for the late read').toEqual([7n]);
		expect(submitted).toEqual([[7]]);
	}, 5_000);

	it.each(['epochWaitMs', 'pollIntervalMs', 'timeoutMs'] as const)(
		'refuses %s values that are not finite numbers above zero, before anything is sent',
		async (name) => {
			for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) {
				const { client, submitted } = clientAnswering([]);
				const epochs = epochsInTurn([7n]);
				await expect(
					client.submitTransactionAcrossEpochClose({
						build: signer().build,
						currentEpoch: epochs.currentEpoch,
						[name]: value,
					}),
				).rejects.toThrow(
					`${name} must be a finite number of milliseconds above zero, got ${value}`,
				);
				expect(submitted).toEqual([]);
				expect(epochs.reads()).toBe(0);
			}
		},
	);

	it('passes every other answer through, without waiting', async () => {
		const refusal = TransactionResponseDataBcs.serialize({
			Error: { message: 'the gas deposit does not cover the request' },
		}).toBytes();
		const answered = clientAnswering([refusal]);
		const epochs = epochsInTurn([7n]);
		const response = await answered.client.submitTransactionAcrossEpochClose({
			build: signer().build,
			currentEpoch: epochs.currentEpoch,
		});
		expect(response.Error?.message).toBe('the gas deposit does not cover the request');
		expect(answered.submitted).toHaveLength(1);
		expect(epochs.reads()).toBe(1);

		const thrown = clientAnswering([grpcError(status.UNAVAILABLE, 'validator is shutting down')]);
		await expect(
			thrown.client.submitTransactionAcrossEpochClose({
				build: signer().build,
				currentEpoch: epochsInTurn([7n]).currentEpoch,
			}),
		).rejects.toThrow('validator is shutting down');
		expect(thrown.submitted).toHaveLength(1);
	});
});
