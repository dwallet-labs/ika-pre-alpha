// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

import { status } from '@grpc/grpc-js';
import { describe, expect, it } from 'vitest';

import { TransactionResponseDataBcs } from '../../src/grpc/bcs';
import { DWalletGrpcClient, EPOCH_CLOSING_REFUSAL } from '../../src/grpc/client';
import { callThroughStubs } from './stub-validators';

/**
 * Sending a request to the next validator when one answers `UNAVAILABLE`.
 *
 * A validator that could not make one of its own checks submits nothing and
 * answers the retryable `UNAVAILABLE`. A client built with further validators
 * then sends the identical bytes to the next one, each validator once.
 */
describe('submitting to the next validator', () => {
	/** The error grpc-js throws for a status a validator answers. */
	function grpcError(code: number, details: string): Error {
		return Object.assign(new Error(`${code} ${status[code]}: ${details}`), { code, details });
	}

	const signature = TransactionResponseDataBcs.serialize({
		Signature: { signature: [1, 2, 3] },
	}).toBytes();

	type Answer = Error | Uint8Array;
	interface Submission {
		userSignature: number[];
		signedRequestData: number[];
		deadline: Date;
	}

	/**
	 * A client with one validator per entry of `answers`. Each validator
	 * answers `SubmitTransaction` with its entry, and records what it was
	 * sent. The first entry is the first validator; the rest are the further
	 * validators, in order.
	 */
	function clientOfValidators(answers: Answer[]): {
		client: DWalletGrpcClient;
		received: Submission[][];
	} {
		const received: Submission[][] = answers.map(() => []);
		const services = answers.map((answer, index) => ({
			SubmitTransaction: (
				request: { user_signature: Uint8Array; signed_request_data: Uint8Array },
				options: { deadline: Date },
				callback: (error: Error | null, response?: object) => void,
			) => {
				received[index].push({
					userSignature: [...request.user_signature],
					signedRequestData: [...request.signed_request_data],
					deadline: options.deadline,
				});
				// Answered on a later turn of the event loop, as a real call is.
				setImmediate(() => {
					if (answer instanceof Error) {
						callback(answer);
					} else {
						callback(null, { response_data: Buffer.from(answer) });
					}
				});
			},
		}));
		// Built without the constructor, which would open real channels.
		const client = Object.create(DWalletGrpcClient.prototype) as {
			service: unknown;
			furtherServices: unknown[];
			call: unknown;
			furtherValidatorCount: number;
		};
		client.service = services[0];
		client.furtherServices = services.slice(1);
		client.call = callThroughStubs(() => [client.service, ...client.furtherServices]);
		client.furtherValidatorCount = services.length - 1;
		return { client: client as unknown as DWalletGrpcClient, received };
	}

	const userSignature = new Uint8Array([9, 8, 7]);
	const signedRequestData = new Uint8Array([4, 5, 6]);
	const unavailable = (details: string) => grpcError(status.UNAVAILABLE, details);

	it('sends the identical request to the second validator when the first answers UNAVAILABLE', async () => {
		const { client, received } = clientOfValidators([
			unavailable('gas deposit read failed'),
			signature,
		]);

		const result = await client.submitTransaction(userSignature, signedRequestData);

		expect(result.Signature?.signature).toEqual([1, 2, 3]);
		expect(received[0]).toHaveLength(1);
		expect(received[1]).toHaveLength(1);
		expect(received[1][0].userSignature).toEqual([9, 8, 7]);
		expect(received[1][0].signedRequestData).toEqual([4, 5, 6]);
		// The deadline covers the whole call: the second validator gets the
		// time left, which is the same instant the first was given.
		expect(received[1][0].deadline.getTime()).toBe(received[0][0].deadline.getTime());
	});

	it('sends the second validator the bytes of the call when the caller changes its arrays meanwhile', async () => {
		const callerSignature = new Uint8Array([9, 8, 7]);
		const callerRequestData = new Uint8Array([4, 5, 6]);
		const { client, received } = clientOfValidators([
			unavailable('gas deposit read failed'),
			signature,
		]);
		// The first validator's call is pending when the caller reuses its
		// two arrays for something else.
		const services = client as unknown as {
			service: { SubmitTransaction: (...args: unknown[]) => void };
		};
		const submitToFirst = services.service.SubmitTransaction;
		services.service.SubmitTransaction = (...args: unknown[]) => {
			callerSignature.fill(0xff);
			callerRequestData.fill(0xee);
			submitToFirst(...args);
		};

		const result = await client.submitTransaction(callerSignature, callerRequestData);

		expect(result.Signature?.signature).toEqual([1, 2, 3]);
		expect([...callerSignature]).toEqual([0xff, 0xff, 0xff]);
		expect([...callerRequestData]).toEqual([0xee, 0xee, 0xee]);
		expect(received[1]).toHaveLength(1);
		expect(received[1][0].userSignature).toEqual([9, 8, 7]);
		expect(received[1][0].signedRequestData).toEqual([4, 5, 6]);
	});

	it('sends the second validator the bytes of the call when the caller changes its Buffers meanwhile', async () => {
		// A Node `Buffer` is accepted where a `Uint8Array` is asked for, and
		// `Buffer.prototype.slice` returns a view of the same memory, not a copy.
		const callerSignature = Buffer.from([9, 8, 7]);
		const callerRequestData = Buffer.from([4, 5, 6]);
		const { client, received } = clientOfValidators([
			unavailable('gas deposit read failed'),
			signature,
		]);
		// The first validator's call is pending when the caller reuses its
		// two buffers for something else.
		const services = client as unknown as {
			service: { SubmitTransaction: (...args: unknown[]) => void };
		};
		const submitToFirst = services.service.SubmitTransaction;
		services.service.SubmitTransaction = (...args: unknown[]) => {
			callerSignature.fill(0xff);
			callerRequestData.fill(0xee);
			submitToFirst(...args);
		};

		const result = await client.submitTransaction(callerSignature, callerRequestData);

		expect(result.Signature?.signature).toEqual([1, 2, 3]);
		expect([...callerSignature]).toEqual([0xff, 0xff, 0xff]);
		expect([...callerRequestData]).toEqual([0xee, 0xee, 0xee]);
		expect(received[1]).toHaveLength(1);
		expect(received[1][0].userSignature).toEqual([9, 8, 7]);
		expect(received[1][0].signedRequestData).toEqual([4, 5, 6]);
	});

	it('does not send an epoch-closing refusal to the next validator', async () => {
		const { client, received } = clientOfValidators([
			unavailable(EPOCH_CLOSING_REFUSAL),
			signature,
		]);

		await expect(client.submitTransaction(userSignature, signedRequestData)).rejects.toMatchObject({
			code: status.UNAVAILABLE,
			details: EPOCH_CLOSING_REFUSAL,
		});
		expect(received[0]).toHaveLength(1);
		expect(received[1]).toHaveLength(0);
	});

	it('does not send a request refused with INVALID_ARGUMENT to the next validator', async () => {
		const { client, received } = clientOfValidators([
			grpcError(status.INVALID_ARGUMENT, 'empty payload'),
			signature,
		]);

		await expect(client.submitTransaction(userSignature, signedRequestData)).rejects.toMatchObject({
			code: status.INVALID_ARGUMENT,
			details: 'empty payload',
		});
		expect(received[1]).toHaveLength(0);
	});

	it('throws the last error when every validator answers UNAVAILABLE', async () => {
		const { client, received } = clientOfValidators([
			unavailable('first'),
			unavailable('second'),
			unavailable('third'),
		]);

		await expect(client.submitTransaction(userSignature, signedRequestData)).rejects.toMatchObject({
			code: status.UNAVAILABLE,
			details: 'third',
		});
		expect(received.map((submissions) => submissions.length)).toEqual([1, 1, 1]);
	});

	it('with one validator, throws its UNAVAILABLE after one submission', async () => {
		const { client, received } = clientOfValidators([unavailable('gas deposit read failed')]);

		await expect(client.submitTransaction(userSignature, signedRequestData)).rejects.toMatchObject({
			code: status.UNAVAILABLE,
			details: 'gas deposit read failed',
		});
		expect(received[0]).toHaveLength(1);
	});
});
