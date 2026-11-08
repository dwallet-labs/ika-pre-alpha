// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The dWallet gRPC client's calls and the rules every transport shares: the
 * encoding of each request and the decoding of each answer, the sending of a
 * request on to further validators, the carrying of a request across an epoch
 * close, and the repeated read of the network keys.
 *
 * Nothing here needs Node. Each entry point builds this client over its own
 * transport: `./client.ts` over grpc-js (`./node-transport.ts`), and `./web.ts`
 * over gRPC-Web through `fetch` (`./web-transport.ts`).
 */
import { TransactionResponseDataBcs } from './bcs.js';
import { decodeResponse, encodeRequest } from './messages.js';
import type { NetworkKeyId } from './network-key-id.js';
import { latestNetworkKeyIdOf, networkKeyIdFromBytes } from './network-key-id.js';
import { markRefusalCode, RefusalCode } from './refusal-code.js';
import type { DWalletTransport } from './transport.js';
import {
	beforeDeadline,
	closedClientError,
	GrpcStatus,
	isEpochClosingRefusal,
	isNotACommitteeMember,
	isRefusedPinnedSetup,
	markRefusedPinnedSetup,
} from './transport.js';
import type { NetworkKeyOutput, PresignInfo, TransactionResponseData } from './types.js';

/** A signed request: the BCS bytes `submitTransaction` sends. */
export interface SignedGrpcRequest {
	userSignature: Uint8Array;
	signedRequestData: Uint8Array;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long a read may take, from the call to the answer. The setup of a
 * pinned connection is not counted: it has its own window
 * (`PINNED_SETUP_WINDOW_MS` in `./node-transport.ts`).
 */
const READ_TIMEOUT_MS = 15_000;

/** How the read of the epoch's network keys is repeated after a transport failure. */
interface NetworkKeysReadRetry {
	/** How long one attempt may take, in milliseconds. */
	attemptTimeoutMs: number;
	/** The pause after a failed attempt, before the next one, in milliseconds. */
	pauseMs: number;
	/**
	 * How long the attempts and the pauses may take together, in
	 * milliseconds, counted from the start of the first attempt.
	 */
	budgetMs: number;
}

/**
 * A validator stops its gRPC server while it changes epoch, and starts the
 * next epoch's server about 15 seconds later. So the read is tried every 5
 * seconds for up to 60 seconds, each attempt for at most `READ_TIMEOUT_MS`.
 */
const NETWORK_KEYS_READ_RETRY: NetworkKeysReadRetry = {
	attemptTimeoutMs: READ_TIMEOUT_MS,
	pauseMs: 5_000,
	budgetMs: 60_000,
};

/**
 * Whether `error`, thrown by an attempt to read the network keys, is a
 * transport failure: no answer came from the validator, or it came too late.
 *
 * grpc-js reports a refused connection, and a connection that broke, with
 * the status `UNAVAILABLE`. A validator that is busy or shutting down
 * answers the same status itself, and the two cannot be told apart; both
 * pass with time. `DEADLINE_EXCEEDED` is an attempt that ran out of time,
 * whether in its call or in the setup of a pinned connection. A pinned setup
 * that failed is one only when a connection it made was refused, its TLS
 * handshake timed out, or its committee read got no answer: the transport
 * marks every other failed setup
 * (`isRefusedPinnedSetup`). Every other error is an answer, or a check that
 * failed, and asking again would not change it.
 */
function isTransportFailure(error: unknown): boolean {
	if (isRefusedPinnedSetup(error)) {
		return false;
	}
	const { code } = (error ?? {}) as { code?: number };
	return code === GrpcStatus.UNAVAILABLE || code === GrpcStatus.DEADLINE_EXCEEDED;
}

/**
 * The start of the error's message, and its `details`, when the pinned TLS
 * check refused every validator a call may go to. The Rust client says the
 * same (`EVERY_VALIDATOR_REFUSED` in ika-sdk-core).
 */
export const EVERY_VALIDATOR_REFUSED =
	'no validator left to ask: the pinned TLS check refused every validator';

/**
 * How long, in milliseconds, a validator whose key the pinned TLS check
 * refused is passed over. After it, the validator is asked again, and its key
 * is checked against the committee anew. A refusal can come from someone
 * between the client and the validator, who answers with a key of its own and
 * relays a genuine committee. A refusal kept for good would then shut the
 * client out of that validator for the rest of the process's life. While such
 * an attacker stays in place, each new try is refused again. The Rust client
 * waits the same (`PIN_REFUSAL_MAX_AGE` in ika-sdk-core).
 */
export const PIN_REFUSAL_MAX_AGE_MS = 60_000;

/**
 * The error of a call when the pinned TLS check refused every validator it
 * may go to, the last refusal being `last`. A refusal holds for
 * `PIN_REFUSAL_MAX_AGE_MS`, so the error carries `FAILED_PRECONDITION`, which
 * a loop that retries `UNAVAILABLE` does not repeat. It stays marked as a
 * refused setup, and `last` is its cause.
 */
function everyValidatorRefused(last: unknown): Error {
	// `undefined` when every validator was refused by earlier calls, and
	// this one tried none.
	const error = Object.assign(
		last === undefined
			? new Error(EVERY_VALIDATOR_REFUSED)
			: new Error(
					`${EVERY_VALIDATOR_REFUSED}: ${last instanceof Error ? last.message : String(last)}`,
					{ cause: last },
				),
		{ code: GrpcStatus.FAILED_PRECONDITION, details: EVERY_VALIDATOR_REFUSED },
	);
	markRefusedPinnedSetup(error);
	return error;
}

/**
 * The client's calls, over the transport an entry point gives it. Import
 * `DWalletGrpcClient` from `@ika.xyz/pre-alpha-core/client` for Node, or from
 * `@ika.xyz/pre-alpha-core/web` for a browser.
 */
export class DWalletGrpcClientBase {
	/** The transport every call goes through. */
	private readonly transport: DWalletTransport;
	/** How many further validators `submitTransaction` may send a request on to. */
	private readonly furtherValidatorCount: number;
	/**
	 * Set by `close()`, and never cleared. A closed client builds no channel
	 * and starts no call.
	 */
	private closed = false;
	/** Each ends one pause of the network keys read at once; `close()` calls them. */
	private readonly pauseEnders = new Set<() => void>();
	/**
	 * How the read of the network keys is repeated. Unset, it is
	 * `NETWORK_KEYS_READ_RETRY`. Tests set it, to repeat the read within a
	 * few seconds instead of a minute.
	 */
	private networkKeysReadRetry?: NetworkKeysReadRetry;
	/**
	 * The validators, by index, whose key the pinned TLS check refused, with
	 * the time of the last refusal in milliseconds on `monotonicNow`: a key that is not the
	 * network key of a member of a verified, fresh committee, or not the
	 * `networkPublicKey` given (`isNotACommitteeMember`). 0 is the first
	 * validator, and `i` the `i`-th further one. A recorded validator is not
	 * asked again for `refusalMaxAgeMs` after its refusal: neither a request
	 * nor a read goes to it, and the transport does not set it up again. After
	 * that it is set up again at its next call. No other failed setup is
	 * recorded: it passes with time, and the next call sets the validator up
	 * again. Made on first use, through `refused`.
	 */
	private refusedValidators?: Map<number, number>;
	/**
	 * How long a refused validator is passed over: `PIN_REFUSAL_MAX_AGE_MS`.
	 * Tests set it.
	 */
	private refusalMaxAgeMs = PIN_REFUSAL_MAX_AGE_MS;
	/**
	 * The clock a refusal's age is measured on, in milliseconds. It is
	 * monotonic (`performance.now()`), not the wall clock: a wall clock set
	 * back would keep a refused validator passed over for as long as the
	 * step. Tests set it.
	 */
	private monotonicNow = (): number => performance.now();

	/** The record of refused validators. */
	private get refused(): Map<number, number> {
		this.refusedValidators ??= new Map();
		return this.refusedValidators;
	}

	/** Whether the validator at `index` was refused less than `refusalMaxAgeMs` ago. */
	private isRefused(index: number): boolean {
		const refusedAt = this.refused.get(index);
		return refusedAt !== undefined && this.monotonicNow() - refusedAt < this.refusalMaxAgeMs;
	}

	/**
	 * Every validator's index, in the order a call tries them. A call checks
	 * the record of refused validators before each try, not once at its
	 * start: another call running at the same time may record a refusal
	 * meanwhile, and the refused validator must not be set up again.
	 */
	private validatorIndexes(): number[] {
		return Array.from({ length: this.furtherValidatorCount + 1 }, (_, index) => index);
	}

	/**
	 * @param transport - the transport every call goes through.
	 * @param furtherValidatorCount - how many further validators the
	 * transport reaches after the first.
	 */
	protected constructor(transport: DWalletTransport, furtherValidatorCount: number) {
		this.transport = transport;
		this.furtherValidatorCount = furtherValidatorCount;
	}

	/**
	 * Send one call of `method` to the validator at `index`: encode `request`,
	 * a plain object with the proto's field names, send it through the
	 * transport, and decode the answer the same way. The call ends at
	 * `deadline`, a time in milliseconds.
	 */
	private async call(
		index: number,
		method: string,
		request: object,
		deadline: number,
	): Promise<any> {
		const { response } = await this.transport.unary(
			index,
			method,
			encodeRequest(method, request),
			deadline,
		);
		return decodeResponse(method, response);
	}

	/**
	 * Send one read of `method` to the first validator, from the validator at
	 * `from` on and wrapping around, whose key the pinned TLS check has not
	 * refused. When the check refuses that validator's key now, it is
	 * recorded, and the read goes on to the next one, as a submission does.
	 * Every other error is the read's, a setup that will pass with time
	 * included. When no validator is left, the error is
	 * `everyValidatorRefused`'s `FAILED_PRECONDITION`.
	 */
	private async read(method: string, request: object, deadline: number, from = 0): Promise<any> {
		const indexes = this.validatorIndexes();
		// The last refusal of the pinned TLS check.
		let lastError: unknown;
		for (const index of [...indexes.slice(from), ...indexes.slice(0, from)]) {
			if (this.isRefused(index)) {
				continue;
			}
			try {
				return await this.call(index, method, request, deadline);
			} catch (error) {
				if (!isNotACommitteeMember(error)) {
					throw error;
				}
				this.refused.set(index, this.monotonicNow());
				lastError = error;
			}
		}
		throw everyValidatorRefused(lastError);
	}

	/**
	 * Submit a signed request and wait for the network result.
	 * `userSignature` / `signedRequestData` are the BCS bytes of the
	 * corresponding `ika-types` structs (see `./bcs.ts`).
	 *
	 * The validator that receives the request can refuse it at once, without
	 * submitting it to consensus: an `Error` result that arrives without the
	 * usual wait. It refuses a request that fails a check it can make alone,
	 * such as an attestation that does not verify, a transport key with no gas
	 * deposit on the chain, or a deposit that does not cover the request.
	 * Nothing was submitted, so the same signed request can be sent again. A
	 * refusal for the deposit can be retried once a top-up has been read
	 * (about 10 to 20 seconds), or sent to another validator. Repeated
	 * refusals count as errors of the client's address, and too many of them
	 * block the address for a while (`RESOURCE_EXHAUSTED`).
	 *
	 * While the epoch is closing, the request is refused with
	 * `EPOCH_CLOSING_REFUSAL` and must be signed again for the next epoch;
	 * `submitTransactionAcrossEpochClose` does that.
	 *
	 * The request goes to the first validator. When that validator answers
	 * the gRPC status `UNAVAILABLE`, and the client was built with further
	 * validators, the identical bytes go to the next one, at once, and so on,
	 * each validator once. A validator answers `UNAVAILABLE` when it could not
	 * make one of its own checks and submitted nothing. grpc-js reports a
	 * failed connection the same way. When every validator answered
	 * `UNAVAILABLE`, this throws the last one's error. When the pinned TLS
	 * check refused the key of every validator (a key that is not a committee
	 * member's, or not the `networkPublicKey` given), no validator is left to
	 * ask, and this throws `FAILED_PRECONDITION` with the details
	 * `EVERY_VALIDATOR_REFUSED` and the last refusal as its cause. A validator
	 * whose key was refused is recorded and not asked again, by a request or
	 * a read, for `PIN_REFUSAL_MAX_AGE_MS` after the refusal. Reads go to the
	 * first validator not recorded, move on when its key is refused, and
	 * answer the same `FAILED_PRECONDITION` when none is left. Every other
	 * failed setup is not recorded: the next call sets that validator up
	 * again. An epoch-closing
	 * refusal (`isEpochClosingRefusal`) is thrown at once and not sent on,
	 * because every validator answers it the same way. Every other status is
	 * thrown, and every result is returned, from the validator that gave it.
	 * Some `UNAVAILABLE` refusals are stored with the request, and every
	 * validator then answers the same: the further calls are charged nothing
	 * and end in the same error. `timeoutMs` covers the whole call: each
	 * validator is given the time that is left. The setup of a pinned
	 * connection is not counted in it: the read of the certificate the
	 * validator serves and, for a validator pinned to the committee, the read
	 * of the committee and its check against the chain. That setup has its own
	 * window of 120 seconds, the Rust client's connect window. A setup still
	 * pending at the window's end ends the call with `DEADLINE_EXCEEDED`, and
	 * no further validator is tried.
	 */
	async submitTransaction(
		userSignature: Uint8Array,
		signedRequestData: Uint8Array,
		timeoutMs = 600_000,
	): Promise<TransactionResponseData> {
		// Copies: every validator's call encodes `request` again, so a caller
		// that changes its arrays while a call is pending changes no later one.
		// `Uint8Array.from` and not `slice`: a caller may pass a Node `Buffer`,
		// and `Buffer.prototype.slice` returns a view of the same memory.
		const request = {
			user_signature: Uint8Array.from(userSignature),
			signed_request_data: Uint8Array.from(signedRequestData),
		};
		const deadline = Date.now() + timeoutMs;
		const submitTo = async (index: number): Promise<TransactionResponseData> => {
			const response: { response_data: Uint8Array; refusal_code?: number } = await this.call(
				index,
				'SubmitTransaction',
				request,
				deadline,
			);
			const answer = TransactionResponseDataBcs.parse(new Uint8Array(response.response_data));
			// The refusal code, kept on an `Error` answer beside its sentence.
			if (answer.$kind === 'Error') {
				markRefusalCode(answer, response.refusal_code ?? RefusalCode.UNSPECIFIED);
			}
			return answer;
		};
		// Whether the pinned TLS check refused the key of every validator tried
		// so far, and the last error a validator gave.
		let everyOneRefused = true;
		let lastError: unknown;
		for (const index of this.validatorIndexes()) {
			// Checked before each try: a call running at the same time may have
			// recorded this validator's refusal since this call started.
			if (this.isRefused(index)) {
				continue;
			}
			try {
				return await submitTo(index);
			} catch (error) {
				const code = (error as { code?: number }).code;
				if (code !== GrpcStatus.UNAVAILABLE || isEpochClosingRefusal(error)) {
					throw error;
				}
				if (isNotACommitteeMember(error)) {
					this.refused.set(index, this.monotonicNow());
				} else {
					everyOneRefused = false;
				}
				lastError = error;
			}
		}
		throw everyOneRefused ? everyValidatorRefused(lastError) : lastError;
	}

	/**
	 * Submit a request like `submitTransaction`, and carry it into the next
	 * epoch when the validator answers that the epoch is closing.
	 *
	 * A signed request names its epoch, so a request refused in a closing
	 * epoch cannot be sent again as it is: the next epoch refuses it for the
	 * wrong epoch. This method therefore takes `build` instead of the bytes.
	 * It reads the current epoch with `currentEpoch`, calls `build(epoch)`,
	 * and submits the result. On an epoch-closing refusal (`EPOCH_CLOSING_REFUSAL`
	 * or `GAS_WAIT_ENDED_WITH_THE_EPOCH`, gRPC `UNAVAILABLE`), it reads the epoch
	 * again every `pollIntervalMs` until a read shows an epoch later than the
	 * one the refused request named. It then calls `build` with the epoch that
	 * read showed, and submits again. It never signs for an epoch at or below
	 * one that has refused the request, even when a later read answers an
	 * older epoch. `build` must sign a new request for the epoch it is given,
	 * under a new session.
	 *
	 * The chain shows a new epoch some seconds before the validator enters
	 * it, and the validator's gRPC server is down for a while in between.
	 * In that time the validator answers the re-signed request with
	 * `UNAVAILABLE`, or the connection fails, which grpc-js also reports as
	 * `UNAVAILABLE`. On any `UNAVAILABLE` after a closing refusal, this sends
	 * the same request again every `pollIntervalMs`: the bytes `build`
	 * returned, copied when it returned, so a caller that changes those arrays
	 * later changes nothing that is sent. That includes a pinned
	 * setup that failed in a way that passes with time, such as a chain read
	 * that lagged: the next call sets the validator up again. When the pinned
	 * TLS check refused the key of every validator, `submitTransaction` throws
	 * `FAILED_PRECONDITION` with the details `EVERY_VALIDATOR_REFUSED`, and
	 * that ends the wait at once, because sending again would not change it.
	 *
	 * Each closing refusal goes to `recordClosingRefusal`, with the epoch the
	 * refused request named, as soon as it is handled: the first request's
	 * refusal, and that of each rebuilt request refused again. That happens
	 * before the bound below is checked and before the epoch is read again,
	 * so a refusal that ends the call at the bound is still recorded.
	 *
	 * Everything after the first closing refusal shares one bound: the waits,
	 * the epoch reads and the calls to `build` that sign again, which are
	 * raced against the time left, the resends and every later closing
	 * refusal. When `epochWaitMs` has passed, this throws
	 * an error that names the last epoch that refused the request. Every
	 * other answer and every other error is returned or thrown as
	 * `submitTransaction` returns or throws it.
	 *
	 * @param params.build - signs the request for the epoch it is given.
	 * @param params.currentEpoch - reads the network's current epoch. It must
	 * read fresh state: a cached epoch never changes, and the wait then ends
	 * in the error. With an `IkaClient`, call `invalidateCache()` before
	 * `getEpoch()`.
	 * @param params.recordClosingRefusal - is given the epoch of each request
	 * refused because its epoch is closing, when the refusal is handled.
	 * Optional: a caller that keeps no record of closing epochs leaves it out.
	 * @param params.epochWaitMs - the most time spent after the first closing
	 * refusal; 30 minutes by default.
	 * @param params.pollIntervalMs - how often the epoch is read while
	 * waiting, and how long to wait before sending again to a validator that
	 * answers `UNAVAILABLE`; 5 seconds by default.
	 * @param params.timeoutMs - each submission's deadline, as in
	 * `submitTransaction`; after a closing refusal it is cut to the time left.
	 * @throws before anything is sent, if `epochWaitMs`, `pollIntervalMs` or
	 * `timeoutMs` is given and is not a finite number above zero.
	 */
	async submitTransactionAcrossEpochClose(params: {
		build: (epoch: bigint) => Promise<SignedGrpcRequest>;
		currentEpoch: () => Promise<bigint>;
		recordClosingRefusal?: (refusedEpoch: bigint) => void;
		epochWaitMs?: number;
		pollIntervalMs?: number;
		timeoutMs?: number;
	}): Promise<TransactionResponseData> {
		const epochWaitMs = positiveMilliseconds(params.epochWaitMs ?? 1_800_000, 'epochWaitMs');
		const pollIntervalMs = positiveMilliseconds(params.pollIntervalMs ?? 5_000, 'pollIntervalMs');
		const timeoutMs = positiveMilliseconds(params.timeoutMs ?? 600_000, 'timeoutMs');

		let refusedEpoch = await params.currentEpoch();
		const first = await params.build(refusedEpoch);
		try {
			return await this.submitTransaction(first.userSignature, first.signedRequestData, timeoutMs);
		} catch (error) {
			if (!isEpochClosingRefusal(error)) {
				throw error;
			}
			params.recordClosingRefusal?.(refusedEpoch);
		}

		const deadline = Date.now() + epochWaitMs;
		const outOfTime = () =>
			new Error(
				`the validator refused the request because epoch ${refusedEpoch} is closing, ` +
					`and the request was not answered in a later epoch within ${epochWaitMs} ms`,
			);
		for (;;) {
			const epoch = await waitForEpochAfter(
				refusedEpoch,
				params.currentEpoch,
				deadline,
				pollIntervalMs,
				outOfTime,
			);
			const built = await beforeDeadline(params.build(epoch), deadline, outOfTime);
			// Copies, taken once: every resend below sends these bytes, so a
			// caller that changes the arrays `build` returned changes no resend.
			// `Uint8Array.from` for the reason `submitTransaction` gives.
			const request = {
				userSignature: Uint8Array.from(built.userSignature),
				signedRequestData: Uint8Array.from(built.signedRequestData),
			};
			for (;;) {
				const remaining = deadline - Date.now();
				if (remaining <= 0) {
					throw outOfTime();
				}
				try {
					return await this.submitTransaction(
						request.userSignature,
						request.signedRequestData,
						Math.min(timeoutMs, remaining),
					);
				} catch (error) {
					if (isEpochClosingRefusal(error)) {
						refusedEpoch = epoch;
						params.recordClosingRefusal?.(refusedEpoch);
						break;
					}
					const code = (error as { code?: number }).code;
					if (code === GrpcStatus.DEADLINE_EXCEEDED && Date.now() >= deadline) {
						throw outOfTime();
					}
					// The validator has not entered the epoch yet, no server is
					// listening, or a pinned setup failed in a way that passes
					// with time (a chain read that lagged or failed, a committee
					// not signed yet, an old committee): the same request is sent
					// again, and the next call sets the validator up again. When
					// the pin refused every validator's key, submitTransaction
					// answers FAILED_PRECONDITION, which ends the wait here.
					if (code !== GrpcStatus.UNAVAILABLE) {
						throw error;
					}
				}
				await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
			}
		}
	}

	async getPresigns(userPubkey: Uint8Array): Promise<PresignInfo[]> {
		return this.presignQuery('GetPresigns', { user_pubkey: userPubkey });
	}

	/**
	 * Presigns bound to one imported dWallet. Every import request creates its
	 * own dWallet, so the dWallet is named by its public key and the session
	 * identifier of the import that created it (32 bytes).
	 */
	async getPresignsForDWallet(
		userPubkey: Uint8Array,
		dwalletPublicKey: Uint8Array,
		importedSessionIdentifier: Uint8Array,
	): Promise<PresignInfo[]> {
		return this.presignQuery('GetPresignsForDWallet', {
			user_pubkey: userPubkey,
			dwallet_public_key: dwalletPublicKey,
			imported_session_identifier: importedSessionIdentifier,
		});
	}

	/**
	 * Fetch a network encryption key's public outputs (network DKG output +
	 * latest reconfiguration output). `networkKeyIdentifier` is either the
	 * key's classic coordinator object id or its NetworkKeyId (32 bytes
	 * either way): this read keeps accepting the object id, which is how a
	 * client that only knows it learns the key's id. This method does not
	 * check the returned bytes against chain state. Check them with
	 * `verifyNetworkKeyOutput` (`./network-key-output.js`) through a chain
	 * reader, or read them through `readNetworkKeyOutputVerified` of
	 * `@ika.xyz/sdk-sui` or `readSolanaNetworkKeyOutputVerified` of
	 * `@ika.xyz/pre-alpha-solana`, before treating them as trusted input.
	 */
	async getNetworkKeyOutput(networkKeyIdentifier: Uint8Array): Promise<NetworkKeyOutput> {
		const deadline = Date.now() + READ_TIMEOUT_MS;
		const response: {
			network_dkg_output: Uint8Array;
			latest_reconfiguration_output: Uint8Array;
			epoch: string | number;
			dkg_at_epoch: string | number;
			noa_public_key: Uint8Array;
		} = await this.read(
			'GetNetworkKeyOutput',
			{ network_key_identifier: networkKeyIdentifier },
			deadline,
		);
		const reconfiguration = new Uint8Array(response.latest_reconfiguration_output);
		return {
			networkDkgOutput: new Uint8Array(response.network_dkg_output),
			latestReconfigurationOutput: reconfiguration.length > 0 ? reconfiguration : undefined,
			epoch: BigInt(response.epoch),
			dkgAtEpoch: BigInt(response.dkg_at_epoch),
			networkKeyId: networkKeyIdFromBytes(new Uint8Array(response.noa_public_key)),
		};
	}

	/**
	 * The NetworkKeyId of the network key the classic coordinator lists
	 * under `objectId` (the `id` of an `IkaClient` `NetworkEncryptionKey`).
	 * Signed requests name a key by its id and not by its object id, and
	 * the id exists nowhere a client can read except a running validator.
	 */
	async networkKeyIdOf(objectId: string): Promise<NetworkKeyId> {
		const digits = objectId.startsWith('0x') ? objectId.slice(2) : objectId;
		const objectIdBytes = bytesFromHex(digits);
		return (await this.getNetworkKeyOutput(objectIdBytes)).networkKeyId;
	}

	/**
	 * The epoch's active network keys in the order the network created them,
	 * oldest first. Every validator answers the list the previous epoch's
	 * handoff certificate carries. The last entry is the newest key. While
	 * that key waits for its registration on every chain, the network still
	 * signs with an older key and refuses new dWallets under the newest one,
	 * so use `latestNetworkKeyId` to pick the key for a new dWallet. An empty
	 * list means the epoch has no network key for new dWallets.
	 */
	async getNetworkKeysByAge(): Promise<NetworkKeyId[]> {
		const response = await this.networkKeysByAgeResponse();
		return (response.network_key_ids ?? []).map((id) => networkKeyIdFromBytes(new Uint8Array(id)));
	}

	/**
	 * The key a DKG or an imported-key verification names by default: the
	 * epoch's latest usable network key. The network refuses either request
	 * under any other key, so this is the key to pass to the request builders.
	 *
	 * The validator answers that key beside the list of `getNetworkKeysByAge`.
	 * It is the newest listed key that the previous epoch's handoff
	 * certificate records as registered on every chain. While a new key waits
	 * for its registrations, it is an older entry, not the last one. A
	 * validator built before that answer existed sends none, and this then
	 * returns the last entry of the list.
	 *
	 * @throws if the epoch has no network key for new dWallets.
	 */
	async latestNetworkKeyId(): Promise<NetworkKeyId> {
		const response = await this.networkKeysByAgeResponse();
		const latestUsable = response.latest_usable_network_key_id;
		if (latestUsable !== undefined && latestUsable.length > 0) {
			return networkKeyIdFromBytes(new Uint8Array(latestUsable));
		}
		return latestNetworkKeyIdOf(
			(response.network_key_ids ?? []).map((id) => networkKeyIdFromBytes(new Uint8Array(id))),
		);
	}

	/**
	 * Read the epoch's network keys from the first validator.
	 *
	 * A validator stops its gRPC server while it changes epoch, and starts
	 * the next epoch's server about 15 seconds later. A read in that gap fails
	 * in transport: the connection is refused, or the read is not answered in
	 * time. So the read is tried again after a transport failure
	 * (`isTransportFailure`): every 5 seconds, for up to 60 seconds in all.
	 * Each attempt ends at its own deadline, 15 seconds after its start, or at
	 * the end of the 60 seconds when that comes first. The package has no
	 * logging, so a new try prints nothing. Any other error is thrown at once.
	 * After `close()`, nothing is tried again: a pause ends at once, and the
	 * read rejects with "the client is closed". When the 60 seconds are used,
	 * the read rejects with the last error's code and details, and a message
	 * that says the validator stayed unreachable.
	 */
	private async networkKeysByAgeResponse(): Promise<{
		network_key_ids?: Uint8Array[];
		latest_usable_network_key_id?: Uint8Array;
	}> {
		const retry = this.networkKeysReadRetry ?? NETWORK_KEYS_READ_RETRY;
		const budgetEnd = Date.now() + retry.budgetMs;
		for (;;) {
			try {
				return await this.networkKeysByAgeAttempt(
					Math.min(Date.now() + retry.attemptTimeoutMs, budgetEnd),
				);
			} catch (error) {
				if (!isTransportFailure(error) || this.closed) {
					throw error;
				}
				if (budgetEnd - Date.now() <= retry.pauseMs) {
					const { code, details } = error as { code?: number; details?: string };
					const reason = error instanceof Error ? error.message : String(error);
					throw Object.assign(
						new Error(
							`read the epoch's network keys: the validator stayed unreachable for the ` +
								`${retry.budgetMs} ms the read is retried: ${reason}`,
							{ cause: error },
						),
						{ code, details },
					);
				}
				await this.pauseUnlessClosed(retry.pauseMs);
				if (this.closed) {
					throw closedClientError();
				}
			}
		}
	}

	/** Wait `ms` milliseconds, or less when `close()` runs first. */
	private pauseUnlessClosed(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const end = () => {
				clearTimeout(timer);
				this.pauseEnders.delete(end);
				resolve();
			};
			const timer = setTimeout(end, ms);
			this.pauseEnders.add(end);
		});
	}

	/** One attempt of `networkKeysByAgeResponse`, which ends at `deadline`. */
	private async networkKeysByAgeAttempt(deadline: number): Promise<{
		network_key_ids?: Uint8Array[];
		latest_usable_network_key_id?: Uint8Array;
	}> {
		return this.read('GetNetworkKeysByAge', {}, deadline);
	}

	/**
	 * How many validators the client can send to: the first one and the
	 * further ones its constructor was given.
	 */
	get validatorCount(): number {
		return this.furtherValidatorCount + 1;
	}

	private async presignQuery(method: string, request: object): Promise<PresignInfo[]> {
		const deadline = Date.now() + READ_TIMEOUT_MS;
		const response: { presigns: any[] } = await this.read(method, request, deadline);
		return (response.presigns ?? []).map((p) => ({
			presignId: new Uint8Array(p.presign_id),
			dwalletBindingId: new Uint8Array(p.dwallet_binding_id),
			signatureAlgorithm: Number(p.signature_algorithm),
			assignedEpoch: BigInt(p.assigned_epoch),
		}));
	}

	/**
	 * Close every channel. The client is then closed for good: every later
	 * call rejects with "the client is closed", and a pinned connection whose
	 * setup was still pending closes its channel when the setup finishes, and
	 * the call waiting on it rejects the same way. A read of the network keys
	 * that waits to be tried again rejects the same way at once. A call
	 * already sent on a channel ends as grpc-js ends a call on a closed
	 * channel, and is not tried again.
	 */
	close(): void {
		this.closed = true;
		[...this.pauseEnders].forEach((end) => end());
		this.transport.close();
	}
}

/**
 * The bytes `digits` spells in hex, two digits a byte. Throws on an odd count
 * or a character that is not a hex digit. It runs in a browser.
 */
function bytesFromHex(digits: string): Uint8Array {
	if (digits.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(digits)) {
		throw new Error(`an object id is an even number of hex digits, got '${digits}'`);
	}
	return Uint8Array.from({ length: digits.length / 2 }, (_, index) =>
		parseInt(digits.slice(index * 2, index * 2 + 2), 16),
	);
}

/** `value` when it is a finite number of milliseconds above zero; throws otherwise. */
function positiveMilliseconds(value: number, name: string): number {
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`${name} must be a finite number of milliseconds above zero, got ${value}`);
	}
	return value;
}

/**
 * Read the epoch with `currentEpoch` every `pollIntervalMs` until it is later
 * than `refusedEpoch`, and return the epoch read. Each read is raced against
 * the time left before `deadline`. A read still pending at the deadline, or
 * one that answers after it, ends the wait with `outOfTime()`.
 */
async function waitForEpochAfter(
	refusedEpoch: bigint,
	currentEpoch: () => Promise<bigint>,
	deadline: number,
	pollIntervalMs: number,
	outOfTime: () => Error,
): Promise<bigint> {
	for (;;) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			throw outOfTime();
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<undefined>((resolve) => {
			timer = setTimeout(() => resolve(undefined), remaining);
		});
		let epoch: bigint | undefined;
		try {
			epoch = await Promise.race([currentEpoch(), timedOut]);
		} finally {
			clearTimeout(timer);
		}
		if (epoch === undefined || Date.now() > deadline) {
			throw outOfTime();
		}
		if (epoch > refusedEpoch) {
			return epoch;
		}
		await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
	}
}
