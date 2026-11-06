// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

import { describe, expect, it, vi } from 'vitest';

import { TransactionResponseDataBcs } from '../../src/grpc/bcs';
import { decodeRequest, encodeResponse } from '../../src/grpc/messages';
import { EPOCH_CLOSING_REFUSAL, isEpochClosingRefusal } from '../../src/grpc/transport';
import { DWalletGrpcClient } from '../../src/grpc/web';
import type { FetchFunction } from '../../src/grpc/web-transport';
import {
	GRPC_WEB_CONTENT_TYPE,
	GRPC_WEB_MAX_ANSWER_BYTES,
	grpcStatusOf,
	GrpcWebFrameReader,
	grpcWebRequestBody,
	GrpcWebStatus,
	parseGrpcWebTrailers,
	WebTransport,
} from '../../src/grpc/web-transport';

/**
 * The browser transport: the gRPC-Web framing, the trailer, the deadline, the
 * error mapping, and the options a browser cannot honour. Every call goes
 * through a fake `fetch`, so no server and no network is needed.
 */

const VALIDATOR = 'https://validator.example:8443';
const encoder = new TextEncoder();

/** One frame: the flag byte, the length as 4 big-endian bytes, the payload. */
function frame(flag: number, payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(5 + payload.length);
	out[0] = flag;
	new DataView(out.buffer).setUint32(1, payload.length);
	out.set(payload, 5);
	return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	parts.reduce((offset, part) => {
		out.set(part, offset);
		return offset + part.length;
	}, 0);
	return out;
}

function trailerFrame(lines: string): Uint8Array {
	return frame(0x80, encoder.encode(lines));
}

/** A `fetch` answer whose body arrives in `chunks`, in order. */
function answer(
	chunks: Uint8Array[],
	init: { status?: number; headers?: Record<string, string> } = {},
): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			chunks.forEach((chunk) => controller.enqueue(chunk));
			controller.close();
		},
	});
	return new Response(body, {
		status: init.status ?? 200,
		headers: { 'content-type': GRPC_WEB_CONTENT_TYPE, ...init.headers },
	});
}

/** A fetch that records each call and answers with `respond`. */
function fakeFetch(respond: (url: string, init: RequestInit) => Promise<Response>): {
	fetch: FetchFunction;
	calls: { url: string; init: RequestInit }[];
} {
	const calls: { url: string; init: RequestInit }[] = [];
	return {
		calls,
		fetch: (url, init) => {
			calls.push({ url, init });
			return respond(url, init);
		},
	};
}

/** A fetch that never answers, and rejects as a browser does when its signal aborts. */
const fetchUntilAborted: FetchFunction = (_url, init) =>
	new Promise((_, reject) => {
		init.signal!.addEventListener('abort', () =>
			reject(new DOMException('The operation was aborted.', 'AbortError')),
		);
	});

async function rejectionOf(work: Promise<unknown>): Promise<any> {
	try {
		await work;
	} catch (error) {
		return error;
	}
	throw new Error('expected a rejection');
}

describe('the gRPC-Web framing', () => {
	it('sends one data frame: flag 0, the length big-endian, then the message', () => {
		const body = grpcWebRequestBody(Uint8Array.from([7, 8, 9]));
		expect([...body]).toEqual([0, 0, 0, 0, 3, 7, 8, 9]);
		expect([...grpcWebRequestBody(new Uint8Array(0))]).toEqual([0, 0, 0, 0, 0]);
		expect([...grpcWebRequestBody(new Uint8Array(0x0102)).subarray(0, 5)]).toEqual([0, 0, 0, 1, 2]);
	});

	it('reads a data frame and a trailer frame from one chunk', () => {
		const reader = new GrpcWebFrameReader();
		const frames = reader.push(
			concat(frame(0, Uint8Array.from([1, 2, 3])), trailerFrame('grpc-status: 0\r\n')),
		);
		expect(frames.map((f) => f.flag)).toEqual([0, 0x80]);
		expect([...frames[0].payload]).toEqual([1, 2, 3]);
		expect(new TextDecoder().decode(frames[1].payload)).toBe('grpc-status: 0\r\n');
		expect(reader.pendingBytes).toBe(0);
	});

	it('reads a frame split across chunks, its header too, only once it is whole', () => {
		const bytes = concat(frame(0, Uint8Array.from([10, 20, 30, 40])), trailerFrame('a: b\r\n'));
		const reader = new GrpcWebFrameReader();
		// One byte at a time: the header is split as well as the payload.
		const seen = [...bytes].flatMap((byte, index) =>
			reader.push(Uint8Array.of(byte)).map((f) => ({ at: index, frame: f })),
		);
		expect(seen.map(({ at }) => at)).toEqual([8, bytes.length - 1]);
		expect([...seen[0].frame.payload]).toEqual([10, 20, 30, 40]);
		expect(seen[1].frame.flag).toBe(0x80);
		expect(reader.pendingBytes).toBe(0);
	});

	it('keeps the bytes of an unfinished frame', () => {
		const reader = new GrpcWebFrameReader();
		expect(reader.push(frame(0, Uint8Array.from([1, 2, 3])).subarray(0, 6))).toEqual([]);
		expect(reader.pendingBytes).toBe(6);
	});
});

describe('the trailer', () => {
	it('parses header lines by lower-case name', () => {
		const trailers = parseGrpcWebTrailers(
			encoder.encode('Grpc-Status: 14\r\ngrpc-message: busy\r\nx-other:  v \r\n'),
		);
		expect(trailers).toEqual({ 'grpc-status': '14', 'grpc-message': 'busy', 'x-other': 'v' });
	});

	it('decodes a percent-encoded grpc-message', () => {
		expect(grpcStatusOf({ 'grpc-status': '9', 'grpc-message': 'not%20signed%3B%20yet' })).toEqual({
			code: 9,
			details: 'not signed; yet',
		});
		expect(grpcStatusOf({})).toBeUndefined();
	});
});

describe('a call through the browser transport', () => {
	const message = encodeResponse('GetPresigns', { presigns: [] });

	it('posts binary gRPC-Web to the method URL and returns the data frame', async () => {
		const response = concat(frame(0, Uint8Array.from([5, 6])), trailerFrame('grpc-status: 0\r\n'));
		// The answer arrives in three uneven chunks.
		const { fetch, calls } = fakeFetch(async () =>
			answer([response.subarray(0, 3), response.subarray(3, 9), response.subarray(9)], {
				headers: { 'x-answer': 'yes' },
			}),
		);
		const transport = new WebTransport([{ endpoint: `${VALIDATOR}/` }], fetch);
		const result = await transport.unary(0, 'GetPresigns', message, Date.now() + 5_000);
		expect([...result.response]).toEqual([5, 6]);
		expect(result.headers['x-answer']).toBe('yes');
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(`${VALIDATOR}/ika.dwallet.v1alpha1.DWalletService/GetPresigns`);
		expect(calls[0].init.method).toBe('POST');
		const headers = calls[0].init.headers as Record<string, string>;
		expect(headers['content-type']).toBe('application/grpc-web+proto');
		expect(headers['x-grpc-web']).toBe('1');
		expect(headers['grpc-timeout']).toMatch(/^\d+m$/);
		expect([...(calls[0].init.body as Uint8Array)]).toEqual([...grpcWebRequestBody(message)]);
	});

	it('rejects with the status of the trailer, which the client rules read', async () => {
		const { fetch } = fakeFetch(async () =>
			answer([
				trailerFrame(
					`grpc-status: 14\r\ngrpc-message: ${encodeURIComponent(EPOCH_CLOSING_REFUSAL)}\r\n`,
				),
			]),
		);
		const transport = new WebTransport([{ endpoint: VALIDATOR }], fetch);
		const error = await rejectionOf(
			transport.unary(0, 'SubmitTransaction', message, Date.now() + 5_000),
		);
		expect(error.code).toBe(GrpcWebStatus.UNAVAILABLE);
		expect(error.details).toBe(EPOCH_CLOSING_REFUSAL);
		expect(isEpochClosingRefusal(error)).toBe(true);
	});

	it('takes the status from the headers of an answer with no body', async () => {
		const { fetch } = fakeFetch(async () =>
			answer([], { headers: { 'grpc-status': '5', 'grpc-message': 'no share' } }),
		);
		const transport = new WebTransport([{ endpoint: VALIDATOR }], fetch);
		const error = await rejectionOf(transport.unary(0, 'GetPresigns', message, Date.now() + 5_000));
		expect(error.code).toBe(GrpcWebStatus.NOT_FOUND);
		expect(error.details).toBe('no share');
	});

	it('maps an HTTP status with no grpc-status', async () => {
		const statusOf = async (httpStatus: number) => {
			const { fetch } = fakeFetch(async () => answer([], { status: httpStatus }));
			const transport = new WebTransport([{ endpoint: VALIDATOR }], fetch);
			return (await rejectionOf(transport.unary(0, 'GetPresigns', message, Date.now() + 5_000)))
				.code;
		};
		expect(await statusOf(503)).toBe(GrpcWebStatus.UNAVAILABLE);
		expect(await statusOf(502)).toBe(GrpcWebStatus.UNAVAILABLE);
		expect(await statusOf(404)).toBe(GrpcWebStatus.UNIMPLEMENTED);
		expect(await statusOf(500)).toBe(GrpcWebStatus.UNKNOWN);
	});

	it('refuses a frame that declares over 16 MiB at its header, before its payload', async () => {
		// Only the header arrives, and the body stays open. Without the limit
		// the call would wait for the payload until its deadline, which aborts
		// the body as a browser does.
		const header = new Uint8Array(5);
		new DataView(header.buffer).setUint32(1, GRPC_WEB_MAX_ANSWER_BYTES + 1);
		let cancelled = false;
		const respond = async (_url: string, init: RequestInit) => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(header);
					init.signal!.addEventListener('abort', () =>
						controller.error(new DOMException('The operation was aborted.', 'AbortError')),
					);
				},
				cancel() {
					cancelled = true;
				},
			});
			const headers = { 'content-type': GRPC_WEB_CONTENT_TYPE };
			return new Response(body, { status: 200, headers });
		};
		const transport = new WebTransport([{ endpoint: VALIDATOR }], fakeFetch(respond).fetch);
		const error = await rejectionOf(transport.unary(0, 'GetPresigns', message, Date.now() + 1_000));
		const refusal = `an oversized frame was not refused at its header: ${error.message}`;
		expect(error.code, refusal).toBe(GrpcWebStatus.RESOURCE_EXHAUSTED);
		expect(cancelled).toBe(true);
	});

	it('refuses a second data frame at once, even an empty one, and cancels the body', async () => {
		// Two empty data frames arrive, and the body stays open. Each frame is
		// under the frame limit, so only a refusal at the second frame stops
		// the answer from growing. Without it, the call would wait until its
		// deadline, which aborts the body as a browser does.
		const twoEmptyFrames = concat(frame(0, new Uint8Array(0)), frame(0, new Uint8Array(0)));
		let cancelled = false;
		const respond = async (_url: string, init: RequestInit) => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(twoEmptyFrames);
					init.signal!.addEventListener('abort', () =>
						controller.error(new DOMException('The operation was aborted.', 'AbortError')),
					);
				},
				cancel() {
					cancelled = true;
				},
			});
			const headers = { 'content-type': GRPC_WEB_CONTENT_TYPE };
			return new Response(body, { status: 200, headers });
		};
		const transport = new WebTransport([{ endpoint: VALIDATOR }], fakeFetch(respond).fetch);
		const error = await rejectionOf(transport.unary(0, 'GetPresigns', message, Date.now() + 1_000));
		const refusal = `a second data frame was not refused at once: ${error.message}`;
		expect(error.code, refusal).toBe(GrpcWebStatus.INTERNAL);
		expect(cancelled).toBe(true);
	});

	it('refuses a second data frame before it cuts any later frame of the same chunk', async () => {
		// One chunk holds two empty data frames, a thousand more, and last a
		// frame whose header declares more than the frame limit. The reader
		// must stop at the second data frame. If it cut the whole chunk first,
		// it would copy every later frame and then refuse the last header with
		// RESOURCE_EXHAUSTED, before the second data frame is looked at.
		const empty = frame(0, new Uint8Array(0));
		const oversized = new Uint8Array(5);
		new DataView(oversized.buffer).setUint32(1, GRPC_WEB_MAX_ANSWER_BYTES + 1);
		const chunk = concat(empty, empty, ...Array.from({ length: 1_000 }, () => empty), oversized);
		// Every byte the reader takes out of its buffer goes through `read` with
		// `consume` set, so their sum is the size of what was cut.
		const read = vi.spyOn(GrpcWebFrameReader.prototype as any, 'read');
		try {
			const { fetch } = fakeFetch(async () => answer([chunk]));
			const transport = new WebTransport([{ endpoint: VALIDATOR }], fetch);
			const error = await rejectionOf(
				transport.unary(0, 'GetPresigns', message, Date.now() + 5_000),
			);
			const cutBytes = read.mock.calls
				.filter(([, consume]) => consume === true)
				.reduce((sum, [count]) => sum + (count as number), 0);
			const refusal =
				`the second data frame was not refused before the later frames were cut: ` +
				`${error.message}, ${cutBytes} bytes cut`;
			expect(error.code, refusal).toBe(GrpcWebStatus.INTERNAL);
			expect(error.message, refusal).toContain('second data frame');
			// The two empty data frames are 5 bytes each, and nothing after them.
			expect(cutBytes, refusal).toBe(2 * empty.length);
		} finally {
			read.mockRestore();
		}
	});

	it('counts an answer that ends before its trailer as UNAVAILABLE', async () => {
		const { fetch } = fakeFetch(async () => answer([frame(0, Uint8Array.from([1]))]));
		const transport = new WebTransport([{ endpoint: VALIDATOR }], fetch);
		const error = await rejectionOf(transport.unary(0, 'GetPresigns', message, Date.now() + 5_000));
		expect(error.code).toBe(GrpcWebStatus.UNAVAILABLE);
	});

	it('maps a fetch TypeError to UNAVAILABLE, with a message that names CORS', async () => {
		const { fetch } = fakeFetch(async () => {
			throw new TypeError('Failed to fetch');
		});
		const transport = new WebTransport([{ endpoint: VALIDATOR }], fetch);
		const error = await rejectionOf(transport.unary(0, 'GetPresigns', message, Date.now() + 5_000));
		expect(error.code).toBe(GrpcWebStatus.UNAVAILABLE);
		expect(error.message).toContain('Failed to fetch');
		expect(error.message).toContain('CORS');
		expect(error.cause).toBeInstanceOf(TypeError);
	});

	it('refuses a redirect: UNAVAILABLE, and nothing sent to its target', async () => {
		const target = 'http://elsewhere.example/ika.dwallet.v1alpha1.DWalletService/GetPresigns';
		const sentToTarget: unknown[] = [];
		// A fetch that handles redirects as the Fetch standard says: with
		// `redirect: 'error'` it rejects with a TypeError; with 'follow', the
		// default, it sends the request again to the target.
		const redirectingFetch: FetchFunction = async (url, init) => {
			if (url === target) {
				sentToTarget.push(init.body);
				return answer([frame(0, Uint8Array.from([1])), trailerFrame('grpc-status: 0\r\n')]);
			}
			const redirect = new Response(null, { status: 307, headers: { location: target } });
			if (init.redirect === 'error') {
				throw new TypeError('fetch failed: unexpected redirect');
			}
			if (init.redirect === 'manual') {
				return redirect;
			}
			return redirectingFetch(redirect.headers.get('location')!, init);
		};
		const transport = new WebTransport([{ endpoint: VALIDATOR }], redirectingFetch);
		const error = await rejectionOf(transport.unary(0, 'GetPresigns', message, Date.now() + 5_000));
		expect(error.code).toBe(GrpcWebStatus.UNAVAILABLE);
		expect(error.message).toContain('redirect');
		expect(sentToTarget).toHaveLength(0);
	});

	it('aborts the fetch at the deadline, and rejects with DEADLINE_EXCEEDED', async () => {
		const transport = new WebTransport([{ endpoint: VALIDATOR }], fetchUntilAborted);
		const started = Date.now();
		const error = await rejectionOf(transport.unary(0, 'GetPresigns', message, started + 50));
		expect(error.code).toBe(GrpcWebStatus.DEADLINE_EXCEEDED);
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	it('sends nothing when the deadline has passed', async () => {
		const { fetch, calls } = fakeFetch(async () => answer([]));
		const transport = new WebTransport([{ endpoint: VALIDATOR }], fetch);
		const error = await rejectionOf(transport.unary(0, 'GetPresigns', message, Date.now() - 1));
		expect(error.code).toBe(GrpcWebStatus.DEADLINE_EXCEEDED);
		expect(calls).toHaveLength(0);
	});

	it('cancels a call in flight on close, and refuses every later call', async () => {
		const transport = new WebTransport([{ endpoint: VALIDATOR }], fetchUntilAborted);
		const pending = rejectionOf(transport.unary(0, 'GetPresigns', message, Date.now() + 5_000));
		transport.close();
		expect((await pending).code).toBe(GrpcWebStatus.CANCELLED);
		const later = await rejectionOf(transport.unary(0, 'GetPresigns', message, Date.now() + 5_000));
		expect(later.message).toBe('the client is closed');
	});
});

describe('the browser client', () => {
	it('sends a request on to the next validator after a fetch TypeError', async () => {
		const signature = TransactionResponseDataBcs.serialize({
			Signature: { signature: [1, 2, 3] },
		}).toBytes();
		const further = 'https://further.example';
		const { fetch, calls } = fakeFetch(async (url) => {
			if (url.startsWith(VALIDATOR)) {
				throw new TypeError('Failed to fetch');
			}
			return answer([
				frame(0, encodeResponse('SubmitTransaction', { response_data: signature })),
				trailerFrame('grpc-status: 0\r\n'),
			]);
		});
		const client = new DWalletGrpcClient(VALIDATOR, undefined, [{ endpoint: further }]);
		// The client's own transport, with the fake fetch in place of the global one.
		(client as any).transport = new WebTransport(
			[{ endpoint: VALIDATOR }, { endpoint: further }],
			fetch,
		);
		const result = await client.submitTransaction(Uint8Array.of(1), Uint8Array.of(2));
		expect(result).toEqual(TransactionResponseDataBcs.parse(signature));
		expect(calls.map(({ url }) => new URL(url).origin)).toEqual([VALIDATOR, further]);
	});

	it('refuses tls', () => {
		expect(() => new DWalletGrpcClient(VALIDATOR, {} as any)).toThrow(/cannot honour `tls`/);
	});

	it('refuses networkPublicKey', () => {
		expect(
			() =>
				new DWalletGrpcClient(VALIDATOR, undefined, [], {
					networkPublicKey: new Uint8Array(32),
				} as any),
		).toThrow(/cannot honour `networkPublicKey`.*raw TLS connection/);
	});

	it('refuses committeeReader', () => {
		expect(
			() => new DWalletGrpcClient(VALIDATOR, undefined, [], { committeeReader: {} } as any),
		).toThrow(/cannot honour `committeeReader`.*raw TLS connection/);
	});

	it('refuses a Node-only option on a further validator', () => {
		expect(
			() =>
				new DWalletGrpcClient(VALIDATOR, undefined, [
					{ endpoint: 'https://further.example', networkPublicKey: new Uint8Array(32) } as any,
				]),
		).toThrow(/cannot honour `networkPublicKey` for the validator at https:\/\/further.example/);
		expect(
			() =>
				new DWalletGrpcClient(VALIDATOR, undefined, [
					{ endpoint: 'https://further.example', tls: {} } as any,
				]),
		).toThrow(/cannot honour `tls`/);
	});

	it('takes https://, and http:// only with insecure', () => {
		expect(() => new DWalletGrpcClient(VALIDATOR)).not.toThrow();
		expect(() => new DWalletGrpcClient('http://127.0.0.1:9184')).toThrow(/plaintext/);
		expect(
			() => new DWalletGrpcClient('http://127.0.0.1:9184', undefined, [], { insecure: true }),
		).not.toThrow();
		expect(
			() => new DWalletGrpcClient(VALIDATOR, undefined, [{ endpoint: 'http://127.0.0.1:9185' }]),
		).toThrow(/plaintext/);
		// A Node client's `host:port` is not a browser URL.
		expect(() => new DWalletGrpcClient('validator.example:8443')).toThrow(/https:\/\//);
	});
});

describe('the object id networkKeyIdOf sends', () => {
	/**
	 * A browser client whose validator records each request it is sent and
	 * answers NOT_FOUND, so a call that reaches it ends there.
	 */
	function recordingClient(): { client: DWalletGrpcClient; sent: Uint8Array[] } {
		const sent: Uint8Array[] = [];
		const { fetch } = fakeFetch(async (_url, init) => {
			const body = init.body as Uint8Array;
			sent.push(decodeRequest('GetNetworkKeyOutput', body.subarray(5)).network_key_identifier);
			return answer([], { headers: { 'grpc-status': '5', 'grpc-message': 'no such key' } });
		});
		const client = new DWalletGrpcClient(VALIDATOR);
		(client as any).transport = new WebTransport([{ endpoint: VALIDATOR }], fetch);
		return { client, sent };
	}

	it('sends the bytes the hex spells, with or without 0x', async () => {
		const { client, sent } = recordingClient();
		const hex = 'ab'.repeat(32);
		await rejectionOf(client.networkKeyIdOf(`0x${hex}`));
		await rejectionOf(client.networkKeyIdOf(hex.toUpperCase()));
		expect(sent.map((bytes) => [...bytes])).toEqual([
			new Array(32).fill(0xab),
			new Array(32).fill(0xab),
		]);
	});

	it('throws on an odd number of digits, and sends nothing', async () => {
		const { client, sent } = recordingClient();
		const error = await rejectionOf(client.networkKeyIdOf(`0x${'ab'.repeat(31)}a`));
		expect(error.message).toMatch(/even number of hex digits/);
		expect(sent).toHaveLength(0);
	});

	it('throws on a character that is not a hex digit, and sends nothing', async () => {
		const { client, sent } = recordingClient();
		const error = await rejectionOf(client.networkKeyIdOf(`0x${'ab'.repeat(31)}zz`));
		expect(error.message).toMatch(/even number of hex digits/);
		expect(sent).toHaveLength(0);
	});
});
