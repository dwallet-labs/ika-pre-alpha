// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The browser transport of the dWallet gRPC client: gRPC-Web over `fetch`.
 *
 * A browser cannot make a plain gRPC call. Plain gRPC puts a call's status in
 * HTTP/2 trailers, and no browser API lets a page read trailers. gRPC-Web is
 * the same call with the status moved into the last frame of the body. This
 * transport speaks its binary mode (`application/grpc-web+proto`), so a 16 MB
 * answer is not base64-encoded on the way.
 *
 * One unary call is one `POST` to `<endpoint>/ika.dwallet.v1alpha1.DWalletService/<method>`.
 * Its body is one frame: a flag byte of 0, the message's length as 4
 * big-endian bytes, then the encoded message. The answer's body is a series
 * of frames of the same form. A frame whose flag has its top bit set (`0x80`)
 * is the trailer frame: its payload is header lines, `grpc-status: 0` and
 * maybe `grpc-message: ...`, which carry the call's status. Every other frame
 * is a data frame, and a unary answer has exactly one.
 *
 * Nothing here needs Node. Node's own `fetch` runs it too.
 */
import { decodeRefusalDetails, DWALLET_SERVICE_NAME } from './messages.js';
import { markRefusalCode } from './refusal-code.js';
import type { DWalletTransport, UnaryAnswer } from './transport.js';
import { closedClientError, GrpcStatus } from './transport.js';

/**
 * A validator the browser client reaches. `endpoint` is the `https://` URL of
 * the validator's gRPC-Web listener, for example
 * `https://dwallet.validator.example:8443`. A plaintext `http://` URL is taken
 * only with `insecure: true`, which only localnet callers pass: a production
 * validator's browser listener serves a publicly trusted certificate.
 */
export interface GrpcWebValidatorEndpoint {
	endpoint: string;
	insecure?: boolean;
}

/** The gRPC status codes, by name. They are the values grpc-js uses. */
export const GrpcWebStatus = {
	OK: 0,
	CANCELLED: 1,
	UNKNOWN: 2,
	INVALID_ARGUMENT: 3,
	DEADLINE_EXCEEDED: GrpcStatus.DEADLINE_EXCEEDED,
	NOT_FOUND: 5,
	ALREADY_EXISTS: 6,
	PERMISSION_DENIED: 7,
	RESOURCE_EXHAUSTED: 8,
	FAILED_PRECONDITION: 9,
	ABORTED: 10,
	OUT_OF_RANGE: 11,
	UNIMPLEMENTED: 12,
	INTERNAL: 13,
	UNAVAILABLE: GrpcStatus.UNAVAILABLE,
	DATA_LOSS: 15,
	UNAUTHENTICATED: 16,
} as const;

const STATUS_NAMES: Record<number, string> = Object.fromEntries(
	Object.entries(GrpcWebStatus).map(([name, code]) => [code, name]),
);

/**
 * The error a gRPC-Web call rejects with. It carries the gRPC status `code`
 * and its `details`, the two fields of a grpc-js error that the client's rules
 * read, and its message has the form grpc-js gives: `14 UNAVAILABLE: ...`.
 */
export function grpcWebError(
	code: number,
	details: string,
	cause?: unknown,
): Error & { code: number; details: string } {
	const message = `${code} ${STATUS_NAMES[code] ?? 'UNKNOWN'}: ${details}`;
	return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
		code,
		details,
	});
}

/** The content type of binary gRPC-Web, which this transport sends and expects. */
export const GRPC_WEB_CONTENT_TYPE = 'application/grpc-web+proto';

/** The length of a frame's header: one flag byte and four length bytes. */
const FRAME_HEADER_LENGTH = 5;

/** The flag bit of the trailer frame. */
const TRAILER_FLAG = 0x80;

/** The flag bit of a compressed frame. This transport asks for none. */
const COMPRESSED_FLAG = 0x01;

/**
 * The most bytes the transport takes in one frame: 16 MiB. A validator's gRPC
 * server never sends a larger message (`DEFAULT_MAX_MESSAGE_SIZE` in
 * ika-grpc-server), so an honest answer is never refused. A frame over it is
 * refused with `RESOURCE_EXHAUSTED`, the code grpc-js gives an answer over its
 * receive limit. The limit alone does not bound an answer, because an answer
 * can hold any number of frames, even empty ones. So a unary answer is also
 * refused at its second data frame, and at any frame after its trailer frame.
 * It then holds at most one data frame and one trailer frame. Without these
 * checks, whoever answers the call could make the page keep any number of
 * bytes until the call's deadline.
 */
export const GRPC_WEB_MAX_ANSWER_BYTES = 16 * 1024 * 1024;

/** The request body of a unary call: one data frame that holds `message`. */
export function grpcWebRequestBody(message: Uint8Array) {
	const body = new Uint8Array(FRAME_HEADER_LENGTH + message.length);
	new DataView(body.buffer).setUint32(1, message.length);
	body.set(message, FRAME_HEADER_LENGTH);
	return body;
}

/** One frame of a gRPC-Web body: its flag byte and its payload. */
export interface GrpcWebFrame {
	flag: number;
	payload: Uint8Array;
}

/**
 * Cuts a gRPC-Web body into frames as its bytes arrive. `fetch` hands the body
 * over in chunks of any size, so a frame, and even a frame's 5-byte header,
 * may be split across chunks. Each chunk is copied out once.
 *
 * A frame whose header declares more than `GRPC_WEB_MAX_ANSWER_BYTES` is
 * refused as soon as its header is read, before its payload arrives.
 *
 * `push` hands each frame to its `onFrame` as soon as the frame is cut, before
 * it reads the next frame's header. So a caller that refuses a frame by
 * throwing from `onFrame` stops the reader there. The later frames of the same
 * chunk are never cut, and their bytes stay buffered.
 */
export class GrpcWebFrameReader {
	/** The bytes that arrived and are not part of a returned frame yet. */
	private chunks: Uint8Array[] = [];
	/** How many bytes `chunks` holds. */
	private buffered = 0;

	/**
	 * Add `chunk`, and return every frame that is now complete, in order. Each
	 * frame is first handed to `onFrame`, as soon as it is cut. Throws
	 * `RESOURCE_EXHAUSTED` for a frame that declares more than
	 * `GRPC_WEB_MAX_ANSWER_BYTES`, and throws what `onFrame` throws.
	 */
	push(chunk: Uint8Array, onFrame: (frame: GrpcWebFrame) => void = () => {}): GrpcWebFrame[] {
		if (chunk.length > 0) {
			this.chunks.push(chunk);
			this.buffered += chunk.length;
		}
		const frames: GrpcWebFrame[] = [];
		while (this.buffered >= FRAME_HEADER_LENGTH) {
			const header = this.read(FRAME_HEADER_LENGTH, false);
			const length = new DataView(header.buffer, header.byteOffset, FRAME_HEADER_LENGTH).getUint32(
				1,
			);
			if (length > GRPC_WEB_MAX_ANSWER_BYTES) {
				throw grpcWebError(
					GrpcWebStatus.RESOURCE_EXHAUSTED,
					`a gRPC-Web frame declares ${length} bytes, more than the ` +
						`${GRPC_WEB_MAX_ANSWER_BYTES} bytes the client takes`,
				);
			}
			if (this.buffered < FRAME_HEADER_LENGTH + length) {
				break;
			}
			this.read(FRAME_HEADER_LENGTH, true);
			const frame = { flag: header[0], payload: this.read(length, true) };
			onFrame(frame);
			frames.push(frame);
		}
		return frames;
	}

	/** How many bytes arrived that make no complete frame. */
	get pendingBytes(): number {
		return this.buffered;
	}

	/** The first `count` buffered bytes, and drop them when `consume` is set. */
	private read(count: number, consume: boolean): Uint8Array {
		const out = new Uint8Array(count);
		let copied = 0;
		let index = 0;
		while (copied < count) {
			const chunk = this.chunks[index];
			const taken = Math.min(count - copied, chunk.length);
			out.set(chunk.subarray(0, taken), copied);
			copied += taken;
			if (consume) {
				if (taken === chunk.length) {
					this.chunks.shift();
				} else {
					this.chunks[0] = chunk.subarray(taken);
				}
			} else {
				index += 1;
			}
		}
		if (consume) {
			this.buffered -= count;
		}
		return out;
	}
}

/**
 * The header lines of a trailer frame, by lower-case name. Each line is
 * `name: value`, and lines end with CRLF. A line with no name is skipped.
 */
export function parseGrpcWebTrailers(payload: Uint8Array): Record<string, string> {
	const trailers: Record<string, string> = {};
	new TextDecoder()
		.decode(payload)
		.split(/\r?\n/)
		.forEach((line) => {
			const colon = line.indexOf(':');
			if (colon > 0) {
				trailers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
			}
		});
	return trailers;
}

/**
 * The call's status from `fields`, the trailers or the response headers:
 * `grpc-status` as a number, and `grpc-message`, which gRPC percent-encodes,
 * decoded. `undefined` when `fields` has no `grpc-status`.
 */
export function grpcStatusOf(
	fields: Record<string, string>,
): { code: number; details: string } | undefined {
	const status = fields['grpc-status'];
	if (status === undefined) {
		return undefined;
	}
	const code = /^\d+$/.test(status) ? Number(status) : GrpcWebStatus.UNKNOWN;
	const message = fields['grpc-message'] ?? '';
	let details: string;
	try {
		details = decodeURIComponent(message);
	} catch {
		details = message;
	}
	return { code, details };
}

/**
 * The refusal code in `fields`, the trailers or the response headers: the
 * `RefusalDetails` message of the `grpc-status-details-bin` field, which gRPC
 * sends in base64, maybe without its padding. A missing field, or one that
 * does not decode, gives `RefusalCode.UNSPECIFIED`, 0.
 */
export function refusalCodeOfFields(fields: Record<string, string>): number {
	const encoded = fields['grpc-status-details-bin'];
	if (encoded === undefined) {
		return 0;
	}
	let bytes: Uint8Array;
	try {
		const padded = encoded.padEnd(encoded.length + ((4 - (encoded.length % 4)) % 4), '=');
		bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
	} catch {
		return 0;
	}
	return decodeRefusalDetails(bytes);
}

/**
 * The error of the status `status`, read from `fields`, keeping the refusal
 * code `fields` carry.
 */
function statusError(
	status: { code: number; details: string },
	fields: Record<string, string>,
): Error & { code: number; details: string } {
	const error = grpcWebError(status.code, status.details);
	markRefusalCode(error, refusalCodeOfFields(fields));
	return error;
}

/**
 * The gRPC status of an HTTP answer that is not `200` and carries no
 * `grpc-status`: a proxy or a server that refused the call before gRPC saw it.
 * It is the mapping the gRPC project gives for HTTP status codes.
 */
export function grpcStatusOfHttp(httpStatus: number): number {
	switch (httpStatus) {
		case 400:
			return GrpcWebStatus.INTERNAL;
		case 401:
			return GrpcWebStatus.UNAUTHENTICATED;
		case 403:
			return GrpcWebStatus.PERMISSION_DENIED;
		case 404:
			return GrpcWebStatus.UNIMPLEMENTED;
		case 429:
		case 502:
		case 503:
		case 504:
			return GrpcWebStatus.UNAVAILABLE;
		default:
			return GrpcWebStatus.UNKNOWN;
	}
}

/**
 * The words added to a failed `fetch`. A browser rejects `fetch` with a
 * `TypeError` and a bare message for a refused connection, a dropped
 * connection, a certificate it does not trust, a request its CORS check
 * refused, and a redirect, which the client refuses, alike. It does so on purpose, so that a page cannot probe other
 * origins. So the client cannot tell these apart, and says so.
 */
export const FETCH_FAILURE_CAUSES =
	'the browser reports a refused or dropped connection, an untrusted certificate, a ' +
	"request its CORS check refused, and a redirect, which the client refuses, the same way; a validator whose gRPC-Web listener does not allow this page's origin also looks unreachable";

/**
 * The base URL of a validator's gRPC-Web listener, with no trailing slash.
 * Throws for a URL that does not parse, for a scheme other than `https:` and
 * `http:`, for `http:` without `insecure`, and for a URL with a query, a
 * fragment or credentials.
 */
export function grpcWebBaseUrl(endpoint: string, insecure: boolean): string {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		throw new Error(
			`the browser client takes a validator's https:// URL, got '${endpoint}', which is not a URL`,
		);
	}
	if (url.protocol === 'http:' && !insecure) {
		throw new Error(
			`the browser client takes a validator's https:// URL, got the plaintext '${endpoint}'; ` +
				'pass insecure: true only for a plaintext localnet node',
		);
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new Error(
			`the browser client takes a validator's https:// URL, got '${endpoint}', whose scheme is ` +
				`'${url.protocol}'`,
		);
	}
	if (url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
		throw new Error(
			`the browser client takes a validator's URL with no query, fragment or credentials, ` +
				`got '${endpoint}'`,
		);
	}
	return url.href.replace(/\/+$/, '');
}

/** The response headers, by lower-case name. */
function headersOf(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	headers.forEach((value, name) => {
		out[name.toLowerCase()] = value;
	});
	return out;
}

/** The fetch function the transport calls. Tests pass their own. */
export type FetchFunction = (input: string, init: RequestInit) => Promise<Response>;

/**
 * The transport of the browser client. Each call is one `fetch`, so there is
 * no channel to keep, renew or pin. The browser checks the validator's
 * certificate against the authorities it trusts.
 */
export class WebTransport implements DWalletTransport {
	/** Each validator's base URL, by validator index. */
	private readonly baseUrls: string[];
	/** The fetch every call goes through. */
	private readonly fetchFunction: FetchFunction;
	/** The abort controller of each call in flight. `close()` aborts them. */
	private readonly inFlight = new Set<AbortController>();
	/** Set by `close()`, and never cleared. A closed transport starts no call. */
	private closed = false;

	/**
	 * @param validators - the first validator, then the further validators.
	 * @param fetchFunction - the fetch to call: the global `fetch` unless a
	 * test gives its own.
	 */
	constructor(validators: GrpcWebValidatorEndpoint[], fetchFunction?: FetchFunction) {
		this.baseUrls = validators.map((validator) =>
			grpcWebBaseUrl(validator.endpoint, validator.insecure === true),
		);
		this.fetchFunction = fetchFunction ?? ((input, init) => globalThis.fetch(input, init));
	}

	async unary(
		validatorIndex: number,
		method: string,
		request: Uint8Array,
		deadline: number,
	): Promise<UnaryAnswer> {
		if (this.closed) {
			throw closedClientError();
		}
		const url = `${this.baseUrls[validatorIndex]}/${DWALLET_SERVICE_NAME}/${method}`;
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			throw grpcWebError(
				GrpcWebStatus.DEADLINE_EXCEEDED,
				`the call to ${url} passed its deadline before it was sent`,
			);
		}
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, remaining);
		this.inFlight.add(controller);
		// Every failure of `fetch` and of the body's read comes here: the abort
		// at the deadline, the abort of `close()`, and the browser's TypeError.
		const failure = (error: unknown): Error => {
			if (timedOut) {
				return grpcWebError(
					GrpcWebStatus.DEADLINE_EXCEEDED,
					`the call to ${url} passed its deadline`,
					error,
				);
			}
			if (this.closed) {
				return grpcWebError(GrpcWebStatus.CANCELLED, 'the client is closed', error);
			}
			if (error instanceof TypeError) {
				return grpcWebError(
					GrpcWebStatus.UNAVAILABLE,
					`could not reach the validator at ${url}: ${error.message}. ${FETCH_FAILURE_CAUSES}`,
					error,
				);
			}
			const reason = error instanceof Error ? error.message : String(error);
			return grpcWebError(GrpcWebStatus.UNKNOWN, `the call to ${url} failed: ${reason}`, error);
		};
		try {
			let response: Response;
			try {
				response = await this.fetchFunction(url, {
					method: 'POST',
					headers: {
						'content-type': GRPC_WEB_CONTENT_TYPE,
						'x-grpc-web': '1',
						'grpc-timeout': `${remaining}m`,
					},
					body: grpcWebRequestBody(request),
					credentials: 'omit',
					// A redirect is refused, and fetch rejects with a TypeError.
					// Followed, it would send the signed body again, to a URL the
					// https check never saw, which may be another host.
					redirect: 'error',
					signal: controller.signal,
				});
			} catch (error) {
				throw failure(error);
			}
			return await readUnaryAnswer(url, response, failure);
		} finally {
			clearTimeout(timer);
			this.inFlight.delete(controller);
		}
	}

	/**
	 * Close the transport. Every call in flight is aborted and rejects with
	 * `CANCELLED`, and every later call rejects with "the client is closed".
	 */
	close(): void {
		this.closed = true;
		[...this.inFlight].forEach((controller) => controller.abort());
	}
}

/**
 * The answer of one unary call, from `response`. A failure while the body is
 * read goes through `failure`, as a failed `fetch` does.
 *
 * The status comes from, in order: the trailer frame; the response headers,
 * which carry it when the server answered with no body (a "trailers-only"
 * answer); the HTTP status. An answer that ends before its status is a call
 * whose end the client did not see. It counts as `UNAVAILABLE`, like a
 * connection grpc-js saw drop, so `submitTransaction` sends the request on.
 */
async function readUnaryAnswer(
	url: string,
	response: Response,
	failure: (error: unknown) => Error,
): Promise<UnaryAnswer> {
	const headers = headersOf(response.headers);
	const fromHeaders = grpcStatusOf(headers);
	if (response.status !== 200) {
		throw fromHeaders === undefined
			? grpcWebError(
					grpcStatusOfHttp(response.status),
					`the validator at ${url} answered HTTP ${response.status} ${response.statusText}`.trim(),
				)
			: statusError(fromHeaders, headers);
	}
	if (fromHeaders !== undefined && fromHeaders.code !== GrpcWebStatus.OK) {
		throw statusError(fromHeaders, headers);
	}
	const contentType = headers['content-type'] ?? '';
	if (!contentType.startsWith(GRPC_WEB_CONTENT_TYPE) && contentType !== 'application/grpc-web') {
		throw grpcWebError(
			GrpcWebStatus.UNKNOWN,
			`the validator at ${url} did not answer binary gRPC-Web: its content type is '${contentType}'`,
		);
	}

	const reader = new GrpcWebFrameReader();
	const data: Uint8Array[] = [];
	let trailers: Record<string, string> | undefined;
	// The reader hands each frame here as soon as it is cut. A refusal thrown
	// here stops the reader at that frame, so no later frame of the same chunk
	// is cut.
	const takeFrame = (frame: GrpcWebFrame) => {
		if (trailers !== undefined) {
			throw grpcWebError(
				GrpcWebStatus.INTERNAL,
				`the validator at ${url} sent a frame after its trailer frame`,
			);
		}
		if ((frame.flag & COMPRESSED_FLAG) !== 0) {
			throw grpcWebError(
				GrpcWebStatus.INTERNAL,
				`the validator at ${url} sent a compressed frame, which the client did not ask for`,
			);
		}
		if ((frame.flag & TRAILER_FLAG) !== 0) {
			trailers = parseGrpcWebTrailers(frame.payload);
		} else {
			// A unary answer holds one message. A second data frame, even an
			// empty one, is refused at once, not at the end of the body,
			// which may never come.
			if (data.length > 0) {
				throw grpcWebError(
					GrpcWebStatus.INTERNAL,
					`the validator at ${url} sent a second data frame in the answer to a unary call`,
				);
			}
			data.push(frame.payload);
		}
	};
	// A response with no body (`body` is `null`) has no frames.
	if (response.body !== null) {
		const bodyReader = response.body.getReader();
		for (;;) {
			let chunk: ReadableStreamReadResult<Uint8Array>;
			try {
				chunk = await bodyReader.read();
			} catch (error) {
				throw failure(error);
			}
			if (chunk.done) {
				break;
			}
			try {
				reader.push(chunk.value, takeFrame);
			} catch (error) {
				// The answer is refused: the rest of the body is not read.
				bodyReader.cancel().catch(() => {});
				throw error;
			}
		}
	}

	const status = trailers === undefined ? fromHeaders : grpcStatusOf(trailers);
	if (status === undefined) {
		throw grpcWebError(
			GrpcWebStatus.UNAVAILABLE,
			reader.pendingBytes > 0
				? `the answer of the validator at ${url} ended inside a frame`
				: `the answer of the validator at ${url} ended before its status`,
		);
	}
	if (status.code !== GrpcWebStatus.OK) {
		throw statusError(status, trailers ?? headers);
	}
	if (data.length !== 1) {
		throw grpcWebError(
			GrpcWebStatus.INTERNAL,
			`the validator at ${url} answered a unary call with ${data.length} messages`,
		);
	}
	return { response: data[0], headers };
}
