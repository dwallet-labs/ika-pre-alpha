// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The Node transport of the dWallet gRPC client: grpc-js channels, one per
 * validator.
 *
 * By default each connection is TLS pinned to the network key of a member of
 * the committee the network signed (`CommitteePin` below), the way Sui's
 * validator client pins a validator's key (`./network-key-tls.ts`).
 */
import * as grpc from '@grpc/grpc-js';

import type { ChainEpochRetry, CommitteeChainReader } from './committee.js';
import {
	CHAIN_EPOCH_RETRY,
	IKA_DWALLET_GRPC_SERVER_NAME,
	VerifiedMembers,
	verifyCommitteeAnswer,
} from './committee.js';
import {
	decodeCommitteeAnswer,
	decodeRefusalDetails,
	decodeRequest,
	DWALLET_SERVICE_METHOD_NAMES,
	DWALLET_SERVICE_NAME,
	encodeRequest,
	encodeResponse,
} from './messages.js';
import {
	certificatePem,
	checkNetworkKeyCertificate,
	checkServedNetworkKeyCertificate,
	fetchServedCertificate,
	pinNetworkKeyCertificate,
	UnexpectedNetworkKeyError,
} from './network-key-tls.js';
import { markRefusalCode } from './refusal-code.js';
import type { DWalletTransport, UnaryAnswer } from './transport.js';
import {
	beforeDeadline,
	closedClientError,
	GrpcStatus,
	isEpochClosingRefusal,
	markNotACommitteeMember,
	markPinnedSetupReachedNoServer,
	markRefusedPinnedSetup,
} from './transport.js';

/**
 * A further validator that `submitTransaction` sends a request to when the
 * validators before it answered `UNAVAILABLE`. `endpoint` is `host:port` of
 * its dWallet gRPC server. Each validator serves its own certificate, so each
 * entry says how to connect to it, by the rule of
 * {@link DWalletGrpcClientOptions}: `tls`, `insecure` and `networkPublicKey`
 * are as there. An entry with none of them is pinned to the committee, through
 * the client's `committeeReader`.
 */
export interface GrpcValidatorEndpoint {
	endpoint: string;
	tls?: { rootCert?: Uint8Array; servername?: string };
	insecure?: boolean;
	networkPublicKey?: Uint8Array;
}

/**
 * Whether `error`, thrown by a gRPC call, says the call reached no server: no
 * connection was made, or the connection broke. grpc-js reports both with the
 * status `UNAVAILABLE`, as a validator does for some answers of its own, so
 * the details tell them apart. An epoch-closing refusal is an answer, and is
 * never one of these.
 */
function isConnectionFailure(error: unknown): boolean {
	const { code, details } = (error ?? {}) as { code?: number; details?: string };
	return (
		code === grpc.status.UNAVAILABLE &&
		!isEpochClosingRefusal(error) &&
		/^No connection established|^Connection dropped|ECONNREFUSED|Connection refused/.test(
			details ?? '',
		)
	);
}

/**
 * The socket error codes of a connection that was refused, and of a TLS
 * handshake that did not finish in time (`fetchServedCertificate`).
 */
const TRANSPORT_SOCKET_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT']);

/** Whether `error`, or an error among its causes, has a code of `TRANSPORT_SOCKET_CODES`. */
function hasTransportSocketCause(error: unknown): boolean {
	let current: unknown = error;
	while (current instanceof Error) {
		const { code } = current as { code?: unknown };
		if (typeof code === 'string' && TRANSPORT_SOCKET_CODES.has(code)) {
			return true;
		}
		current = current.cause;
	}
	return false;
}

/**
 * Whether `error` is a gRPC call's failure to get an answer: `UNAVAILABLE` or
 * `DEADLINE_EXCEEDED`. In a pinned setup only the committee read
 * (`CommitteePin.readCommitteeFrom`) fails with a gRPC status, so this marks
 * that read reaching no validator, or a validator too busy to answer it. Both
 * pass with time, like a refused connection.
 */
function isUnansweredCall(error: unknown): boolean {
	const { code } = (error ?? {}) as { code?: unknown };
	return code === GrpcStatus.UNAVAILABLE || code === GrpcStatus.DEADLINE_EXCEEDED;
}

/** How long one read of the committee from a validator may take. */
const COMMITTEE_READ_TIMEOUT_MS = 15_000;

/**
 * How long the setup of a pinned channel may take, counted from its start:
 * the read of the certificate, and, for a validator pinned to the committee,
 * the reads of the committee and the chain. It is the Rust client's connect
 * window, and it does not depend on the deadline of the call that needs the
 * channel. So the chain's epoch can be read again for its full 60 seconds,
 * and a committee not signed yet can be asked for again, even under a read's
 * 15 seconds.
 */
export const PINNED_SETUP_WINDOW_MS = 120_000;

/**
 * How old the client's last read of the chain's epoch may be when a key of a
 * committee it verified earlier is accepted for a new connection. An older
 * read is made again first, and every committee below the epoch it shows is
 * dropped. So a key that left the committee is refused within a minute of
 * the chain's epoch passing its committee.
 */
export const CHAIN_EPOCH_MAX_AGE_MS = 60_000;

/** The pause of `ms` milliseconds. */
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The committee check of one client's pinned connections: the chain the
 * committees are checked against, and the members of the committees that
 * passed. Every validator of the client shares it. It is the Rust client's
 * `CommitteePin`.
 *
 * Each new channel to a validator takes three steps:
 * 1. Read the certificate the validator serves, and check it by every rule
 *    of Sui's `ServerCertVerifier` except which key it holds: it verifies
 *    under its own key, is valid now, is for server authentication and names
 *    `ika-dwallet-grpc`. Its key is the validator's served network key.
 * 2. When that key is not a verified member's, read `GetCommittee` from this
 *    validator over a channel pinned to exactly that key, check the answer
 *    against the chain (`verifyCommitteeAnswer`), keep the committees that
 *    pass, and close that channel. This is how the first validator gives the
 *    client its committee, and how the client follows the committee into a
 *    later epoch. A key that is still not a member's is refused.
 * 3. Build the validator's channel with that certificate as its one trusted
 *    root. Its `checkServerIdentity` accepts, on every connection the channel
 *    makes, only a certificate of that key while the key is still a verified
 *    member's.
 *
 * The client accepts any verified member. It does not check which member it
 * reached: it needs to know that it talks to a member of the committee and
 * that nobody sits in between, and every answer is checked against the
 * network's own signature anyway. A former member cannot pass: the committee
 * it was in is signed, but its epoch is below the chain's, and it is refused.
 */
class CommitteePin {
	private readonly members = new VerifiedMembers();
	/**
	 * How the chain's epoch is read again while a validator answers a
	 * committee ahead of the chain. Tests set it, to wait milliseconds
	 * instead of a minute.
	 */
	retry: ChainEpochRetry = CHAIN_EPOCH_RETRY;
	/**
	 * How old the last read of the chain's epoch may be when a cached key is
	 * accepted: `CHAIN_EPOCH_MAX_AGE_MS`. Tests set it.
	 */
	chainEpochMaxAgeMs = CHAIN_EPOCH_MAX_AGE_MS;
	/** The highest chain epoch read so far, or `undefined` before the first read. */
	private chainEpoch: bigint | undefined;
	/** When the chain's epoch was last read, in milliseconds. */
	private chainEpochReadAt = 0;

	constructor(private readonly reader: CommitteeChainReader) {}

	/**
	 * The reader a committee check uses: every read of the chain's epoch is
	 * recorded at once, before the check decides. A check that reads epoch 8
	 * and then refuses committee 7 has still shown the client epoch 8, so a
	 * cached committee 7 is dropped and its keys are no longer accepted.
	 */
	private readonly recordingReader: CommitteeChainReader = {
		currentEpoch: async () => {
			const chainEpoch = await this.reader.currentEpoch();
			this.recordChainEpoch(chainEpoch);
			return chainEpoch;
		},
		isRegisteredNetworkKey: (noaPublicKey) => this.reader.isRegisteredNetworkKey(noaPublicKey),
	};

	/**
	 * Record `chainEpoch`, read from the chain just now, and drop every cached
	 * committee older than it. A read that shows an older epoch than one read
	 * before, from a lagging RPC, does not move the epoch back.
	 */
	private recordChainEpoch(chainEpoch: bigint): void {
		this.chainEpochReadAt = Date.now();
		if (this.chainEpoch === undefined || chainEpoch > this.chainEpoch) {
			this.chainEpoch = chainEpoch;
		}
		this.members.dropOlderThan(this.chainEpoch);
	}

	/**
	 * Read the chain's epoch again when the last read is older than
	 * `chainEpochMaxAgeMs`, so a cached committee the chain has passed is
	 * dropped before any of its keys is accepted.
	 */
	private async refreshChainEpoch(): Promise<void> {
		if (
			this.chainEpoch === undefined ||
			Date.now() - this.chainEpochReadAt > this.chainEpochMaxAgeMs
		) {
			this.recordChainEpoch(await this.reader.currentEpoch());
		}
	}

	/**
	 * Read the committee from the validator at `endpoint` over a channel built
	 * by `serviceWith` and pinned to the served key `networkKey`, check the
	 * answer against the chain, and keep the committees that pass. The
	 * channel is closed after the read. Resolves whether `networkKey` is the
	 * network key of a member of a committee of this answer, decided in the
	 * same synchronous step that keeps the committees.
	 *
	 * A validator answers `FAILED_PRECONDITION` while the committee of its
	 * epoch is not signed yet. The committee is then asked for again every
	 * `retry.pauseMs`, as long as the next try starts before `setupDeadline`,
	 * the end of the setup's window. Every other answer is final.
	 */
	private async readCommitteeFrom(
		endpoint: string,
		der: Uint8Array,
		networkKey: Uint8Array,
		setupDeadline: number,
		serviceWith: (credentials: grpc.ChannelCredentials) => any,
	): Promise<boolean> {
		const service = serviceWith(
			grpc.credentials.createSsl(Buffer.from(certificatePem(der)), undefined, undefined, {
				checkServerIdentity: (_hostname: string, certificate: { raw: Uint8Array }) =>
					keyCheckOf(new Uint8Array(certificate.raw), networkKey),
			}),
		);
		const readOnce = (): Promise<Uint8Array> =>
			new Promise((resolve, reject) =>
				service.GetCommittee(
					encodeRequest('GetCommittee', {}),
					{ deadline: new Date(Math.min(Date.now() + COMMITTEE_READ_TIMEOUT_MS, setupDeadline)) },
					(error: Error | null, answer: Uint8Array) => (error ? reject(error) : resolve(answer)),
				),
			);
		try {
			let response: Uint8Array | undefined;
			while (response === undefined) {
				try {
					response = await readOnce();
				} catch (error) {
					const { code } = (error ?? {}) as { code?: unknown };
					if (
						code !== grpc.status.FAILED_PRECONDITION ||
						Date.now() + this.retry.pauseMs >= setupDeadline
					) {
						throw error;
					}
					await pause(this.retry.pauseMs);
				}
			}
			const verified = await verifyCommitteeAnswer(
				decodeCommitteeAnswer(response),
				this.recordingReader,
				this.retry,
			);
			// The committee is checked against the highest chain epoch read so
			// far, not only against the read the check just made: an RPC that
			// lags can answer an epoch below one read before. A committee below
			// the held epoch is an old committee. That fails the committee check
			// and is never recorded as a refused key, so the validator is
			// checked again at its next use.
			this.recordChainEpoch(verified.chainEpoch);
			const heldEpoch = this.chainEpoch ?? verified.chainEpoch;
			if (verified.committee.epoch < heldEpoch) {
				throw new Error(
					`the validator answered the committee of epoch ${verified.committee.epoch}, older ` +
						`than the chain's epoch ${heldEpoch} read before`,
				);
			}
			this.members.add(verified);
			this.members.dropOlderThan(heldEpoch);
			// The membership answer comes from this same synchronous step: is
			// the key in a committee of this answer, which is fresh against the
			// held epoch? Read after an await, the held committees could already
			// have changed under another setup's chain read, and a real member
			// would be recorded as refused.
			return [verified.committee, verified.nextCommittee].some(
				(committee) =>
					committee !== undefined &&
					committee.members.some((member) =>
						Buffer.from(member.networkPubkey).equals(Buffer.from(networkKey)),
					),
			);
		} catch (error) {
			if (isUnansweredCall(error)) {
				throw error;
			}
			throw new Error(
				`the committee read from ${endpoint} failed: ` +
					(error instanceof Error ? error.message : String(error)),
				{ cause: error },
			);
		} finally {
			grpc.closeClient(service);
		}
	}

	/**
	 * Build the channel of the validator at `endpoint`, pinned to its network
	 * key once that key is a verified member's (the three steps above).
	 * `setupDeadline` ends the setup's window, and `serviceWith` builds a
	 * service over the given credentials. Rejects, and builds nothing, when
	 * the key is not a member's after the committee was read again through the
	 * validator. The client then passes the validator over for
	 * `PIN_REFUSAL_MAX_AGE_MS` (`DWalletGrpcClientBase`).
	 */
	async connect(
		endpoint: string,
		setupDeadline: number,
		serviceWith: (credentials: grpc.ChannelCredentials) => any,
	): Promise<any> {
		const der = await fetchServedCertificate(endpoint);
		const networkKey = checkServedNetworkKeyCertificate(der);
		// A cached key is accepted only while its committee is still fresh
		// against a chain epoch read at most `chainEpochMaxAgeMs` ago. A key in
		// no fresh committee goes on to read the committee again.
		await this.refreshChainEpoch();
		if (!this.members.contains(networkKey)) {
			// A refusal is recorded only from the answer just checked, never from
			// the held committees after the await: another setup's chain read may
			// have dropped a committee meanwhile.
			const isMember = await this.readCommitteeFrom(
				endpoint,
				der,
				networkKey,
				setupDeadline,
				serviceWith,
			);
			if (!isMember) {
				throw new UnexpectedNetworkKeyError(
					`the validator at ${endpoint} serves the network key ${hex(networkKey)}, which is ` +
						'not the network key of a member of the committee the network signed',
				);
			}
		}
		// The channel's own reconnects are checked synchronously, against the
		// committees still held after the last read of the chain's epoch. A key
		// whose committee that read has passed is refused. So is every key
		// while that read is older than `chainEpochMaxAgeMs`: the chain may
		// have moved since. Either way the channel is dropped, and the next
		// call comes back through `connect`, which reads the chain again. A
		// healthy channel that reconnects after a quiet minute is renewed once.
		return serviceWith(
			grpc.credentials.createSsl(Buffer.from(certificatePem(der)), undefined, undefined, {
				checkServerIdentity: (_hostname: string, certificate: { raw: Uint8Array }) =>
					keyCheckOf(new Uint8Array(certificate.raw), networkKey) ??
					this.reconnectCheck(networkKey),
			}),
		);
	}

	/**
	 * The synchronous check of a channel's own reconnect to the key
	 * `networkKey`: `undefined` when the last read of the chain's epoch is at
	 * most `chainEpochMaxAgeMs` old and the key is a member's of a committee
	 * still held, and the refusal otherwise.
	 */
	private reconnectCheck(networkKey: Uint8Array): Error | undefined {
		const readAge = Date.now() - this.chainEpochReadAt;
		if (readAge > this.chainEpochMaxAgeMs) {
			return new Error(
				`the chain's epoch was last read ${readAge} ms ago, more than ` +
					`${this.chainEpochMaxAgeMs} ms; the connection is set up again`,
			);
		}
		return this.members.contains(networkKey)
			? undefined
			: new Error(
					`the network key ${hex(networkKey)} is no longer the network key of a member ` +
						'of a verified committee',
				);
	}
}

/**
 * The `checkServerIdentity` answer for the certificate `der` against the one
 * key `networkKey`: `undefined` when it is that key's network-key
 * certificate, and the refusal otherwise.
 */
function keyCheckOf(der: Uint8Array, networkKey: Uint8Array): Error | undefined {
	try {
		checkNetworkKeyCertificate(der, networkKey);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
}

/**
 * The service definition the client's channels use. Each method's request and
 * answer are bytes, which the client encodes and decodes itself, so grpc-js
 * passes them through unchanged.
 */
const BYTES_SERVICE_DEFINITION: grpc.ServiceDefinition = Object.fromEntries(
	DWALLET_SERVICE_METHOD_NAMES.map((method) => [
		method,
		{
			path: `/${DWALLET_SERVICE_NAME}/${method}`,
			requestStream: false,
			responseStream: false,
			requestSerialize: (request: Uint8Array) =>
				Buffer.from(request.buffer, request.byteOffset, request.byteLength),
			requestDeserialize: (bytes: Buffer) => bytes,
			responseSerialize: (response: Uint8Array) =>
				Buffer.from(response.buffer, response.byteOffset, response.byteLength),
			responseDeserialize: (bytes: Buffer) => bytes,
		},
	]),
);

const BytesServiceClient = grpc.makeGenericClientConstructor(
	BYTES_SERVICE_DEFINITION,
	'DWalletService',
);

/**
 * FOR TESTS ONLY. Not part of the package's public types: no entry point
 * exports it. The service definition a test's grpc-js server serves the
 * client with. Its handlers take and answer plain objects with the proto's
 * field names, encoded and decoded as the client does.
 */
export function serviceDefinitionForTestsOnly(): grpc.ServiceDefinition {
	return Object.fromEntries(
		DWALLET_SERVICE_METHOD_NAMES.map((method) => [
			method,
			{
				path: `/${DWALLET_SERVICE_NAME}/${method}`,
				requestStream: false,
				responseStream: false,
				requestSerialize: (request: object) => Buffer.from(encodeRequest(method, request)),
				requestDeserialize: (bytes: Buffer) => decodeRequest(method, bytes),
				responseSerialize: (response: object) => Buffer.from(encodeResponse(method, response)),
				responseDeserialize: (bytes: Buffer) => bytes,
			},
		]),
	);
}

/**
 * Keep on `error`, the error of a gRPC status, the refusal code its
 * `grpc-status-details-bin` trailer carries. grpc-js leaves that trailer in
 * the error's `metadata`. A status with no details keeps no code.
 */
function keepStatusRefusalCode(error: Error): Error {
	const metadata = (error as { metadata?: grpc.Metadata }).metadata;
	const details = metadata?.get?.('grpc-status-details-bin')[0];
	if (details instanceof Uint8Array) {
		markRefusalCode(error, decodeRefusalDetails(details));
	}
	return error;
}

/** Response headers as strings. A binary header is given in base64. */
function headersOf(metadata: grpc.Metadata): Record<string, string> {
	return Object.fromEntries(
		Object.entries(metadata.getMap()).map(([key, value]) => [
			key,
			typeof value === 'string' ? value : value.toString('base64'),
		]),
	);
}

/**
 * The grpc-js transport. It connects to each validator by the rule of
 * `DWalletGrpcClientOptions`, builds a pinned validator's channel on first
 * use, and renews a channel after a call failed to reach its server.
 */
export class NodeTransport implements DWalletTransport {
	/**
	 * The first validator. Every read goes to it, and every request goes to it
	 * first. `undefined` while a pinned validator's channel is not built yet:
	 * it is built on first use (`serviceReady`).
	 */
	private service: any;
	/** The further validators, in the order `submitTransaction` tries them. */
	private furtherServices: any[];
	/**
	 * Builds a new service, with its own channel, for the validator at
	 * `index`: 0 is the first validator, and `i` is `furtherServices[i - 1]`.
	 * Returns `undefined` for a validator with a pinned connection, whose
	 * channel can be built only after its certificate has been read
	 * (`pinnedServiceAt`).
	 */
	private readonly serviceAt: (index: number) => any;
	/**
	 * Reads the certificate the validator at `index` serves, checks it against
	 * the validator's `networkPublicKey` or against the verified committee,
	 * and builds a channel pinned to it. The second argument is the end of
	 * the setup's window, a time in milliseconds.
	 */
	private readonly pinnedServiceAt: (index: number, setupDeadline: number) => Promise<any>;
	/**
	 * How long a pinned setup may take: `PINNED_SETUP_WINDOW_MS`. Tests set
	 * it, to wait milliseconds instead of two minutes.
	 */
	setupWindowMs = PINNED_SETUP_WINDOW_MS;
	/**
	 * The committee check every validator pinned to the committee shares.
	 * `undefined` when the client has no `committeeReader`.
	 */
	private readonly committeePin: CommitteePin | undefined;
	/** The pinned channels being built, by validator index, so that calls at once build one. */
	private readonly pinnedBuilds = new Map<number, Promise<any>>();
	/** Each validator's `host:port`, by validator index, for error messages. */
	private readonly endpoints: string[];
	/**
	 * Set by `close()`, and never cleared. A closed transport builds no
	 * channel and starts no call.
	 */
	private closed = false;
	/**
	 * One function per call waiting on a pinned setup. Each rejects its
	 * call's wait, so `close()` ends every wait still pending.
	 */
	private readonly setupWaits = new Set<(error: Error) => void>();

	/**
	 * @param validators - the first validator, then the further validators.
	 * @param committeeReader - the reader of the client's chain that the
	 * committee is checked against, for every validator pinned to the
	 * committee.
	 */
	constructor(
		validators: GrpcValidatorEndpoint[],
		committeeReader: CommitteeChainReader | undefined,
	) {
		validators.forEach((validator) => {
			if (
				!validator.tls &&
				validator.insecure !== true &&
				!validator.networkPublicKey &&
				committeeReader === undefined
			) {
				throw new Error(
					`no way to connect to the validator at ${validator.endpoint}: pass a committeeReader, ` +
						'for TLS pinned to a member of the committee the network signed; or its ' +
						'networkPublicKey, for TLS pinned to that one key; or tls; or insecure: true for a ' +
						'plaintext localnet node',
				);
			}
		});
		this.committeePin =
			committeeReader === undefined ? undefined : new CommitteePin(committeeReader);
		// Each channel gets its own subchannels. By default grpc-js shares one
		// subchannel among all channels to the same address, so a service
		// built to replace one whose connection failed would inherit the old
		// subchannel and its reconnect backoff (`renewAfterConnectionFailure`).
		const serviceWith = (
			validator: GrpcValidatorEndpoint,
			credentials: grpc.ChannelCredentials,
			servername: string | undefined,
		) =>
			new BytesServiceClient(validator.endpoint, credentials, {
				'grpc.use_local_subchannel_pool': 1,
				...(servername ? { 'grpc.ssl_target_name_override': servername } : {}),
			});
		this.serviceAt = (index) => {
			const validator = validators[index];
			if (validator.tls) {
				const credentials = grpc.credentials.createSsl(
					validator.tls.rootCert ? Buffer.from(validator.tls.rootCert) : undefined,
				);
				return serviceWith(validator, credentials, validator.tls.servername);
			}
			if (validator.insecure === true) {
				return serviceWith(validator, grpc.credentials.createInsecure(), undefined);
			}
			return undefined;
		};
		this.pinnedServiceAt = async (index, setupDeadline) => {
			const validator = validators[index];
			try {
				if (validator.networkPublicKey === undefined) {
					return await this.committeePin!.connect(
						validator.endpoint,
						setupDeadline,
						(credentials) => serviceWith(validator, credentials, IKA_DWALLET_GRPC_SERVER_NAME),
					);
				}
				const pinned = await pinNetworkKeyCertificate(
					validator.endpoint,
					validator.networkPublicKey,
				);
				const credentials = grpc.credentials.createSsl(
					Buffer.from(pinned.rootCertPem),
					undefined,
					undefined,
					{ checkServerIdentity: pinned.checkServerIdentity },
				);
				return serviceWith(validator, credentials, IKA_DWALLET_GRPC_SERVER_NAME);
			} catch (error) {
				// The status grpc-js gives a call that reached no server, so that
				// `submitTransaction` sends the request on to the next validator.
				const reason = error instanceof Error ? error.message : String(error);
				const failure = Object.assign(
					new Error(`no pinned TLS connection to ${validator.endpoint}: ${reason}`, {
						cause: error,
					}),
					{ code: grpc.status.UNAVAILABLE, details: reason },
				);
				// A key that is not the expected one is refused for a while: the
				// client records the validator and does not ask it again for
				// `PIN_REFUSAL_MAX_AGE_MS`. A refused
				// connection, a TLS handshake that timed out, and a committee read
				// that got no answer are transport failures. Every other failure
				// (a chain read that failed, a committee not signed in time, a
				// lagging chain, a server without TLS, a committee that does not
				// verify) is not tried again within the call, and the next call
				// sets the validator up again.
				// A refused connection or a TLS handshake that timed out is also
				// marked as a setup that reached no server, by this typed check
				// and not by its text.
				if (error instanceof UnexpectedNetworkKeyError) {
					markNotACommitteeMember(failure);
				} else if (hasTransportSocketCause(error)) {
					markPinnedSetupReachedNoServer(failure);
				} else if (!isUnansweredCall(error)) {
					markRefusedPinnedSetup(failure);
				}
				throw failure;
			}
		};
		this.endpoints = validators.map((validator) => validator.endpoint);
		this.service = this.serviceAt(0);
		this.furtherServices = validators.slice(1).map((_, index) => this.serviceAt(index + 1));
	}

	async unary(
		validatorIndex: number,
		method: string,
		request: Uint8Array,
		deadline: number,
	): Promise<UnaryAnswer> {
		const setupStarted = Date.now();
		const service = await this.serviceReady(validatorIndex);
		// The setup of a pinned channel has its own window, and its time is not
		// counted against the call: the call gets the time it had when it started.
		const callDeadline = deadline + (Date.now() - setupStarted);
		return new Promise((resolve, reject) => {
			let headers: Record<string, string> = {};
			const call = service[method](
				request,
				{ deadline: new Date(callDeadline) },
				(err: Error | null, response: Uint8Array) =>
					err
						? reject(this.renewAfterConnectionFailure(service, keepStatusRefusalCode(err)))
						: resolve({ response, headers }),
			);
			call.on('metadata', (metadata: grpc.Metadata) => {
				headers = headersOf(metadata);
			});
		});
	}

	/** The service of the validator at `index`, or `undefined` while it has none. */
	private serviceOf(index: number): any {
		return index === 0 ? this.service : this.furtherServices[index - 1];
	}

	/**
	 * The service of the validator at `index`, building its pinned channel
	 * first when it has none. A failed build leaves no channel, so the next
	 * call reads the validator's certificate, and the committee when needed,
	 * again.
	 *
	 * The build reads the certificate the validator serves and, for a
	 * validator pinned to the committee, may read the committee and check it
	 * against the chain. Each can take long: a server may accept the
	 * connection and never finish TLS, a chain read may never answer, or be
	 * repeated while the chain lags the network, and a committee not signed
	 * yet is asked for again. So the wait for the build has its own window,
	 * `setupWindowMs` from the start of this wait, whatever the deadline of
	 * the call that needs the channel. At the window's end it fails with an
	 * error of code `DEADLINE_EXCEEDED`. That code is not `UNAVAILABLE`, so
	 * `submitTransaction` stops there and does not go on to the next
	 * validator. A build still pending then is forgotten, so the next call
	 * starts a new one instead of waiting on it. Only the build that is still
	 * the validator's entry in `pinnedBuilds` installs its channel. A
	 * forgotten build that finishes later closes its channel, whatever the
	 * order: the validator may serve another key by then, and installing it
	 * would make the newer build return a channel pinned to the old key.
	 */
	private async serviceReady(index: number): Promise<any> {
		if (this.closed) {
			throw closedClientError();
		}
		const current = this.serviceOf(index);
		if (current !== undefined) {
			return current;
		}
		const deadline = Date.now() + this.setupWindowMs;
		const outOfTime = () =>
			Object.assign(
				new Error(
					`no pinned TLS connection to ${this.endpoints[index]}: the certificate and ` +
						`the committee were not read within the ${this.setupWindowMs} ms setup window`,
				),
				{ code: grpc.status.DEADLINE_EXCEEDED, details: 'pinned TLS setup passed its window' },
			);
		// Checked before a build starts, so that no build is left with nothing
		// waiting on it.
		if (deadline - Date.now() <= 0) {
			throw outOfTime();
		}
		const building = this.pinnedBuilds.get(index);
		const build: Promise<any> =
			building ??
			this.pinnedServiceAt(index, deadline)
				.then((service) => {
					// `close()` ran while this setup was pending: its channel is
					// closed at once and no call is sent on it.
					if (this.closed) {
						grpc.closeClient(service);
						throw closedClientError();
					}
					// Only the validator's current build installs its channel. A
					// build forgotten at its deadline is no longer the entry in
					// `pinnedBuilds`, and neither is one a newer build replaced.
					// Its channel may be pinned to a key the validator has since
					// rotated, so it is closed. A call still waiting on it gets
					// the channel the current build installed, if there is one.
					if (this.pinnedBuilds.get(index) !== build) {
						grpc.closeClient(service);
						const installedByCurrent = this.serviceOf(index);
						if (installedByCurrent !== undefined) {
							return installedByCurrent;
						}
						throw outOfTime();
					}
					const installed = this.serviceOf(index);
					if (installed !== undefined) {
						grpc.closeClient(service);
						return installed;
					}
					if (index === 0) {
						this.service = service;
					} else {
						this.furtherServices[index - 1] = service;
					}
					return service;
				})
				.finally(() => {
					if (this.pinnedBuilds.get(index) === build) {
						this.pinnedBuilds.delete(index);
					}
				});
		this.pinnedBuilds.set(index, build);
		// `close()` ends this wait with "the client is closed", so the wait's
		// window timer is cleared then and not at the window's end.
		let endWait: (error: Error) => void = () => {};
		const ended = new Promise<never>((_, reject) => {
			endWait = reject;
		});
		this.setupWaits.add(endWait);
		try {
			return await beforeDeadline(Promise.race([build, ended]), deadline, () => {
				if (this.pinnedBuilds.get(index) === build) {
					this.pinnedBuilds.delete(index);
				}
				return outOfTime();
			});
		} finally {
			this.setupWaits.delete(endWait);
		}
	}

	/**
	 * After a call through `service` failed to reach the server, replace that
	 * validator's service with a new one and close the old one. grpc-js keeps a
	 * channel whose connection failed in reconnect backoff, and while it waits
	 * it fails every call at once with "No connection established", even after
	 * the server listens again. A validator's gRPC server is down for a while
	 * at every epoch change, so a client that sends again after that would
	 * otherwise keep failing on the old channel. Any other error, including
	 * every answer a server sent, changes nothing. Returns `error`.
	 *
	 * A pinned validator gets no new channel here. Its channel is dropped, and
	 * the next call reads its certificate again before it builds one
	 * (`serviceReady`). A handshake that failed because the validator serves
	 * another key, or because its key left the verified committees, is such a
	 * failure. A validator pinned to the committee is then checked against the
	 * committee read again through it, so the client follows a new key once
	 * a committee the network signed lists it.
	 */
	private renewAfterConnectionFailure(service: any, error: Error): Error {
		// A closed transport builds no new channel.
		if (!isConnectionFailure(error) || this.closed) {
			return error;
		}
		if (service === this.service) {
			this.service = this.serviceAt(0);
		} else {
			const index = this.furtherServices.indexOf(service);
			// Already replaced by another call that failed on the same channel.
			if (index < 0) {
				return error;
			}
			this.furtherServices[index] = this.serviceAt(index + 1);
		}
		grpc.closeClient(service);
		return error;
	}

	/**
	 * Close every channel. A call waiting on a pinned setup still pending
	 * rejects at once with "the client is closed", and the setup's window
	 * timer is cleared. The setup itself goes on, and closes its channel
	 * when it finishes. A call already sent on a channel ends as grpc-js
	 * ends a call on a closed channel.
	 */
	close(): void {
		this.closed = true;
		this.setupWaits.forEach((endWait) => endWait(closedClientError()));
		this.setupWaits.clear();
		[this.service, ...this.furtherServices]
			.filter((service) => service !== undefined)
			.forEach((service) => grpc.closeClient(service));
	}
}
