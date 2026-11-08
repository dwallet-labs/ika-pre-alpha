// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

import { describe, expect, it } from 'vitest';

import { TransactionResponseDataBcs } from '../../src/grpc/bcs';
import {
	decodeRefusalDetails,
	encodeRefusalDetails,
	encodeResponse,
} from '../../src/grpc/messages';
import { isRefusal, RefusalCode, refusalCodeOf } from '../../src/grpc/refusal-code';
import { EPOCH_CLOSING_REFUSAL, isEpochClosingRefusal } from '../../src/grpc/transport';
import { DWalletGrpcClient } from '../../src/grpc/web';
import type { FetchFunction } from '../../src/grpc/web-transport';
import {
	GRPC_WEB_CONTENT_TYPE,
	refusalCodeOfFields,
	WebTransport,
} from '../../src/grpc/web-transport';

/**
 * The typed refusal codes. A validator sends a code beside the refusal's
 * sentence: in a `TransactionResponse`'s `refusal_code`, or in a gRPC status's
 * `grpc-status-details-bin` trailer. The client acts on the code, and on the
 * sentence only when no code came, as from a validator built before the code
 * existed. Every call goes through the browser transport and a fake `fetch`.
 */

const VALIDATOR = 'https://validator.example:8443';
const encoder = new TextEncoder();

/** One gRPC-Web frame: the flag byte, the length as 4 big-endian bytes, the payload. */
function frame(flag: number, payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(5 + payload.length);
	out[0] = flag;
	new DataView(out.buffer).setUint32(1, payload.length);
	out.set(payload, 5);
	return out;
}

/** A `fetch` that answers every call with the frames `frames`, in one chunk. */
function fetchAnswering(...frames: Uint8Array[]): FetchFunction {
	return async () => {
		const body = new Uint8Array(frames.reduce((sum, part) => sum + part.length, 0));
		frames.reduce((offset, part) => {
			body.set(part, offset);
			return offset + part.length;
		}, 0);
		return new Response(body, { status: 200, headers: { 'content-type': GRPC_WEB_CONTENT_TYPE } });
	};
}

/** The trailer frame of a status `code` with `message`, and `details` when given. */
function statusTrailer(code: number, message: string, details?: Uint8Array): Uint8Array {
	// gRPC sends a binary trailer in base64, here without its padding.
	const detailsLine =
		details === undefined
			? ''
			: `grpc-status-details-bin: ${Buffer.from(details).toString('base64').replace(/=+$/, '')}\r\n`;
	return frame(
		0x80,
		encoder.encode(
			`grpc-status: ${code}\r\ngrpc-message: ${encodeURIComponent(message)}\r\n${detailsLine}`,
		),
	);
}

async function rejectionOf(work: Promise<unknown>): Promise<any> {
	try {
		await work;
	} catch (error) {
		return error;
	}
	throw new Error('expected a rejection');
}

/** The status error a call through the browser transport rejects with, for `fetch`. */
function statusErrorOf(fetch: FetchFunction): Promise<any> {
	const transport = new WebTransport([{ endpoint: VALIDATOR }], fetch);
	return rejectionOf(
		transport.unary(0, 'SubmitTransaction', new Uint8Array(0), Date.now() + 5_000),
	);
}

/** The answer `submitTransaction` returns for the `TransactionResponse` `response`. */
function submitAnswering(response: object) {
	const client = new DWalletGrpcClient(VALIDATOR);
	(client as any).transport = new WebTransport(
		[{ endpoint: VALIDATOR }],
		fetchAnswering(
			frame(0, encodeResponse('SubmitTransaction', response)),
			frame(0x80, encoder.encode('grpc-status: 0\r\n')),
		),
	);
	return client.submitTransaction(new Uint8Array(64), new Uint8Array(1));
}

const refusalOf = (message: string) =>
	TransactionResponseDataBcs.serialize({ Error: { message } }).toBytes();

describe('the refusal details of a gRPC status', () => {
	it('decode to the code they carry, and to no code when they do not decode', () => {
		expect(decodeRefusalDetails(encodeRefusalDetails(RefusalCode.PRESIGN_POOL_EMPTY))).toBe(
			RefusalCode.PRESIGN_POOL_EMPTY,
		);
		expect(decodeRefusalDetails(Uint8Array.of(0xff, 0xff, 0xff))).toBe(RefusalCode.UNSPECIFIED);
		expect(refusalCodeOfFields({})).toBe(RefusalCode.UNSPECIFIED);
		expect(refusalCodeOfFields({ 'grpc-status-details-bin': '!!' })).toBe(RefusalCode.UNSPECIFIED);
	});
});

describe('a coded refusal', () => {
	it('a status whose code is the epoch-closing refusal is one, whatever its sentence says', async () => {
		const error = await statusErrorOf(
			fetchAnswering(
				statusTrailer(
					14,
					'the epoch is closing, in a wording this client does not know',
					encodeRefusalDetails(RefusalCode.EPOCH_CLOSING),
				),
			),
		);
		expect(refusalCodeOf(error)).toBe(RefusalCode.EPOCH_CLOSING);
		expect(isEpochClosingRefusal(error)).toBe(true);
	});

	it('a status whose code is another refusal is not the epoch-closing one, though its sentence is', async () => {
		const error = await statusErrorOf(
			fetchAnswering(
				statusTrailer(
					14,
					EPOCH_CLOSING_REFUSAL,
					encodeRefusalDetails(RefusalCode.TOO_MANY_CHAIN_READS),
				),
			),
		);
		expect(isEpochClosingRefusal(error)).toBe(false);
	});

	it("an Error answer keeps its response's refusal code, and the code decides", async () => {
		const answer = await submitAnswering({
			response_data: refusalOf('the presign pool is empty, in another wording'),
			refusal_code: RefusalCode.PRESIGN_POOL_EMPTY,
		});
		expect(answer.$kind).toBe('Error');
		expect(refusalCodeOf(answer)).toBe(RefusalCode.PRESIGN_POOL_EMPTY);
		expect(isRefusal(answer, [RefusalCode.PRESIGN_POOL_EMPTY], () => false)).toBe(true);
		// The code is kept out of sight: a copy of the answer does not carry it.
		expect(Object.getOwnPropertySymbols({ ...answer })).toEqual([]);
		expect(answer.Error!.message).toBe('the presign pool is empty, in another wording');
	});
});

describe('a refusal with no code, from a validator built before the code existed', () => {
	it('a status is read by its sentence', async () => {
		const closing = await statusErrorOf(fetchAnswering(statusTrailer(14, EPOCH_CLOSING_REFUSAL)));
		expect(refusalCodeOf(closing)).toBe(RefusalCode.UNSPECIFIED);
		expect(isEpochClosingRefusal(closing)).toBe(true);

		const busy = await statusErrorOf(fetchAnswering(statusTrailer(14, 'validator is busy')));
		expect(isEpochClosingRefusal(busy)).toBe(false);
	});

	it('an Error answer is read by its sentence', async () => {
		const answer = await submitAnswering({
			response_data: refusalOf('presign pool empty for requested algorithm'),
		});
		expect(refusalCodeOf(answer)).toBe(RefusalCode.UNSPECIFIED);
		expect(isRefusal(answer, [RefusalCode.PRESIGN_POOL_EMPTY], () => true)).toBe(true);
		expect(isRefusal(answer, [RefusalCode.PRESIGN_POOL_EMPTY], () => false)).toBe(false);
	});
});
