// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The request engine (`Network`) against stub validators.
 *
 * The client is the real `DWalletGrpcClient` with its gRPC calls answered by
 * stubs, so the resends, the request signing and the user
 * side's cryptography all run for real.
 *
 * The P-256 sign runs on the `p256_*` acceptance fixtures, which one real run
 * of the protocol wrote (`write_sdk_p256_sign_fixtures` in ika-core): the
 * network key's DKG output, a presign, a dWallet's output and user share, a
 * message and the network's signature over it.
 */
import { readFileSync } from 'node:fs';
import { status } from '@grpc/grpc-js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { describe, expect, it } from 'vitest';

import {
	EpochClosedBeforeAnswer,
	Network,
	NO_GAS_DEPOSIT_REFUSAL,
	PRESIGN_POOL_EMPTY_REFUSAL,
	PresignExpiredWithTheEpoch,
	signatureSchemeNumber,
} from '../../src/common/engine.js';
import type { DWallet, Presign, ReEncryptedShare, Requester } from '../../src/common/engine.js';
import { RequestKey } from '../../src/common/request-key.js';
import {
	gasChargeId,
	RequestRanBeforeAnswer,
	signatureCommitItemId,
} from '../../src/common/request-records.js';
import type { RequestRecordReader } from '../../src/common/request-records.js';
import { DWalletGrpcClient, EPOCH_CLOSING_REFUSAL } from '../../src/grpc/client.js';
import {
	assertDWalletUsable,
	attestationSigningMessage,
	Curve,
	grpcSessionIdentifier,
	networkKeyDkgRecordMessage,
	networkKeyIdFromBytes,
	networkOutputDigest,
	publicKeyFromDWalletOutput,
	requestSigningMessage,
	SignedRequestDataBcs,
	TransactionResponseDataBcs,
	trustedNetworkKeys,
	UserSignatureBcs,
	VersionedDWalletDataAttestationBcs,
	VersionedEncryptedUserKeyShareAttestationBcs,
	VersionedPartialUserSignatureAttestationBcs,
	VersionedPresignDataAttestationBcs,
} from '../../src/index.js';
import type {
	AttestationKind,
	AttestationRecord,
	DWalletShareReader,
	NetworkKeyOutputRecordReader,
} from '../../src/index.js';
import { callThroughStubs } from './stub-validators.js';

const fixture = (name: string) =>
	Uint8Array.from(
		readFileSync(new URL(`../../../core/test/unit/fixtures/acceptance/${name}`, import.meta.url)),
	);

const NETWORK_SECRET = new Uint8Array(32).fill(0x21);
const NETWORK_KEY = networkKeyIdFromBytes(ed25519.getPublicKey(NETWORK_SECRET));
const OTHER_SECRET = new Uint8Array(32).fill(0x22);
const OTHER_KEY = networkKeyIdFromBytes(ed25519.getPublicKey(OTHER_SECRET));
const EPOCH = 4n;
const NETWORK = { custom: { networkPublicKeys: [NETWORK_KEY] } };

const REQUEST_SECRET = new Uint8Array(32).fill(0x31);
const requester: Requester = {
	keypair: { secretKey: REQUEST_SECRET, publicKey: ed25519.getPublicKey(REQUEST_SECRET) },
	chain: 'Solana',
	intendedChainSender: ed25519.getPublicKey(REQUEST_SECRET),
};

const hex = (bytes: ArrayLike<number>) =>
	Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** The proof a chain stores of a record: `VersionedAttestationProof::V1`, version 0. */
const proofOf = (signer: Uint8Array, signature: Uint8Array) =>
	Uint8Array.from([0, 0, ...signer, ...signature]);

/** A chain that registers `NETWORK_KEY` and holds the network-signed record of `dkgOutput`. */
function chainRecording(dkgOutput: Uint8Array): NetworkKeyOutputRecordReader {
	const digest = networkOutputDigest(dkgOutput);
	const record = {
		digest,
		proof: proofOf(
			NETWORK_KEY,
			ed25519.sign(networkKeyDkgRecordMessage(NETWORK_KEY, digest), NETWORK_SECRET),
		),
	};
	return {
		dkgRecord: async (key) => (hex(key) === hex(NETWORK_KEY) ? record : undefined),
		reconfigurationRecord: async () => undefined,
		isRegisteredNetworkKey: async (key) => hex(key) === hex(NETWORK_KEY),
	};
}

function grpcError(code: number, details: string): Error {
	return Object.assign(new Error(`${code} ${status[code]}: ${details}`), { code, details });
}

/** A request as a stub validator received it, decoded and checked like a validator does. */
interface Received {
	data: ReturnType<typeof SignedRequestDataBcs.parse>;
	epoch: bigint;
	sessionIdentifier: Uint8Array;
	/** The bytes sent, in hex: the user's signature and the signed request data. */
	sentBytes: string;
}

type Answer = Error | Parameters<typeof TransactionResponseDataBcs.serialize>[0];

/**
 * A `DWalletGrpcClient` whose one validator is a stub. `answer` answers each
 * submitted request; `epochs` are the epochs the network key read reports,
 * one per read, the last one repeated.
 */
function stubClient(options: {
	dkgOutput: Uint8Array;
	answer: (received: Received) => Answer;
	epochs?: bigint[];
	latestKey?: Uint8Array;
	/** How many network key reads fail first, as while an epoch starts. */
	unavailableKeyReads?: number;
}) {
	const received: Received[] = [];
	const epochs = [...(options.epochs ?? [EPOCH])];
	let keyReads = 0;
	let unavailableKeyReads = options.unavailableKeyReads ?? 0;
	const client = Object.create(DWalletGrpcClient.prototype) as any;
	client.furtherValidatorCount = 0;
	client.monotonicNow = () => performance.now();
	client.call = callThroughStubs(() => [client.service]);
	client.service = {
		GetNetworkKeysByAge: (_request: object, _options: object, callback: any) =>
			setImmediate(() =>
				callback(null, {
					network_key_ids: [options.latestKey ?? NETWORK_KEY],
					latest_usable_network_key_id: options.latestKey ?? NETWORK_KEY,
				}),
			),
		GetNetworkKeyOutput: (_request: object, _options: object, callback: any) => {
			keyReads++;
			if (unavailableKeyReads > 0) {
				unavailableKeyReads--;
				setImmediate(() =>
					callback(
						grpcError(status.UNAVAILABLE, 'network keys are not ready on this validator yet'),
					),
				);
				return;
			}
			const epoch = epochs.length > 1 ? epochs.shift()! : epochs[0];
			setImmediate(() =>
				callback(null, {
					network_dkg_output: options.dkgOutput,
					latest_reconfiguration_output: new Uint8Array(0),
					epoch: epoch.toString(),
					dkg_at_epoch: '1',
					noa_public_key: NETWORK_KEY,
				}),
			);
		},
		SubmitTransaction: (
			request: { user_signature: Uint8Array; signed_request_data: Uint8Array },
			_options: object,
			callback: any,
		) => {
			const bytes = Uint8Array.from(request.signed_request_data);
			const signature = UserSignatureBcs.parse(Uint8Array.from(request.user_signature)).Ed25519!;
			// A validator verifies the user's signature over the exact bytes sent.
			expect(
				ed25519.verify(
					Uint8Array.from(signature.signature),
					requestSigningMessage(bytes),
					Uint8Array.from(signature.public_key),
				),
			).toBe(true);
			const data = SignedRequestDataBcs.parse(bytes);
			const epoch = BigInt(data.epoch);
			const entry = {
				data,
				sentBytes: `${hex(request.user_signature)}:${hex(bytes)}`,
				epoch,
				sessionIdentifier: grpcSessionIdentifier(
					epoch,
					'Ed25519',
					Uint8Array.from(signature.public_key),
					Uint8Array.from(data.session_identifier_preimage),
				),
			};
			received.push(entry);
			const answer = options.answer(entry);
			setImmediate(() =>
				answer instanceof Error
					? callback(answer)
					: callback(null, {
							response_data: Buffer.from(TransactionResponseDataBcs.serialize(answer).toBytes()),
						}),
			);
		},
	};
	return { client: client as DWalletGrpcClient, received, keyReads: () => keyReads };
}

function signedAttestation(kind: AttestationKind, data: Uint8Array, secret = NETWORK_SECRET) {
	return {
		attestation_data: Array.from(data),
		network_signature: Array.from(ed25519.sign(attestationSigningMessage(kind, data), secret)),
		network_pubkey: Array.from(NETWORK_KEY),
		signer_noa_public_key: Array.from(ed25519.getPublicKey(secret)),
	};
}

/** The presign answer a validator gives `received`, with `overrides` on its fields. */
function presignAnswer(
	received: Received,
	overrides: {
		userPubkey?: Uint8Array;
		sessionIdentifier?: Uint8Array;
		curve?: string;
		algorithm?: string;
	} = {},
): Answer {
	const data = VersionedPresignDataAttestationBcs.serialize({
		V1: {
			session_identifier: Array.from(overrides.sessionIdentifier ?? received.sessionIdentifier),
			epoch: received.epoch,
			presign_session_identifier: Array.from(new Uint8Array(32).fill(0x44)),
			presign_data: Array.from(new Uint8Array(8).fill(0x45)),
			curve: { [overrides.curve ?? 'Curve25519']: null } as any,
			signature_algorithm: { [overrides.algorithm ?? 'EdDSA']: null } as any,
			dwallet_public_key: null,
			user_pubkey: Array.from(overrides.userPubkey ?? requester.keypair.publicKey),
			network_key_id: NETWORK_KEY,
		} as any,
	}).toBytes();
	return { Attestation: signedAttestation('presign', data) };
}

async function refusal(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		return error as Error;
	}
	throw new Error('expected a refusal');
}

const NETWORK_KEY_DKG_OUTPUT = fixture('network_key_dkg_output.bcs');

async function connected(
	answer: (received: Received) => Answer,
	options: {
		epochs?: bigint[];
		latestKey?: Uint8Array;
		curve?: Curve;
		dkgOutput?: Uint8Array;
		/** The chain's epoch, which a test may move. */
		chain?: { epoch: bigint };
		/** The chain's records of requests, for the lookup after an epoch close. */
		requestRecords?: RequestRecordReader;
	} = {},
) {
	const dkgOutput = options.dkgOutput ?? NETWORK_KEY_DKG_OUTPUT;
	const chain = options.chain ?? { epoch: EPOCH };
	const stub = stubClient({
		dkgOutput,
		answer,
		epochs: options.epochs,
		latestKey: options.latestKey,
	});
	const network = await Network.connect({
		client: stub.client,
		curve: options.curve ?? Curve.ED25519,
		networkKeyId: NETWORK_KEY,
		network: NETWORK,
		records: chainRecording(dkgOutput),
		chainEpoch: async () => chain.epoch,
		requestRecords: options.requestRecords,
	});
	return { network, chain, ...stub };
}

describe('Network.connect', () => {
	it('derives the protocol parameters from the checked output, and takes its epoch', async () => {
		const { network } = await connected(() => grpcError(status.INTERNAL, 'unused'));
		expect(network.epoch).toBe(EPOCH);
		expect(network.protocolPublicParameters.length).toBeGreaterThan(0);
		expect(hex(network.networkKeyId)).toBe(hex(NETWORK_KEY));
	});

	it('derives the protocol parameters once per key output and curve', async () => {
		const dkgOutput = fixture('p256_network_key_dkg_output.bcs');
		const timed = async () => {
			const started = performance.now();
			const { network } = await connected(() => grpcError(13, 'unused'), {
				curve: Curve.SECP256R1,
				dkgOutput,
			});
			return { network, elapsed: performance.now() - started };
		};
		const first = await timed();
		const second = await timed();
		expect(second.network.protocolPublicParameters).toBe(first.network.protocolPublicParameters);
		expect(second.elapsed).toBeLessThan(first.elapsed / 4);
	}, 300_000);

	it('takes several presigns at once, each for its own session', async () => {
		const { network, received } = await connected((request) => presignAnswer(request));
		const presigns = await network.requestPresigns(requester, 5, 3);
		expect(presigns).toHaveLength(3);
		expect(new Set(received.map((request) => hex(request.sessionIdentifier))).size).toBe(3);
	}, 300_000);

	it('reads the network key again while the validator is starting its epoch', async () => {
		const stub = stubClient({
			dkgOutput: NETWORK_KEY_DKG_OUTPUT,
			answer: () => grpcError(13, ''),
			unavailableKeyReads: 1,
		});
		const network = await Network.connect({
			client: stub.client,
			curve: Curve.ED25519,
			networkKeyId: NETWORK_KEY,
			network: NETWORK,
			records: chainRecording(NETWORK_KEY_DKG_OUTPUT),
			chainEpoch: async () => EPOCH,
		});
		expect(network.epoch).toBe(EPOCH);
		expect(stub.keyReads()).toBe(2);
	}, 300_000);

	it('refuses a key that is not one of the custom network keys', async () => {
		const stub = stubClient({ dkgOutput: NETWORK_KEY_DKG_OUTPUT, answer: () => grpcError(13, '') });
		const error = await refusal(
			Network.connect({
				client: stub.client,
				curve: Curve.ED25519,
				networkKeyId: OTHER_KEY,
				network: NETWORK,
				records: chainRecording(NETWORK_KEY_DKG_OUTPUT),
				chainEpoch: async () => EPOCH,
			}),
		);
		expect(error.message).toMatch(/not one of the custom network's keys/);
	});

	it('refuses served outputs that do not match the chain record', async () => {
		const stub = stubClient({ dkgOutput: Uint8Array.of(1, 2, 3), answer: () => grpcError(13, '') });
		await expect(
			Network.connect({
				client: stub.client,
				curve: Curve.ED25519,
				networkKeyId: NETWORK_KEY,
				network: NETWORK,
				records: chainRecording(NETWORK_KEY_DKG_OUTPUT),
				chainEpoch: async () => EPOCH,
			}),
		).rejects.toThrow();
	});

	it('refuses an unlisted key on mainnet before any read', async () => {
		const stub = stubClient({ dkgOutput: NETWORK_KEY_DKG_OUTPUT, answer: () => grpcError(13, '') });
		const error = await refusal(
			Network.connect({
				client: stub.client,
				curve: Curve.ED25519,
				networkKeyId: NETWORK_KEY,
				network: 'mainnet',
				records: chainRecording(NETWORK_KEY_DKG_OUTPUT),
				chainEpoch: async () => EPOCH,
			}),
		);
		// Nothing is deployed on mainnet yet, so the refusal names that.
		expect(error.message).toMatch(/not deployed on mainnet|not one this SDK lists/);
		expect(stub.keyReads()).toBe(0);
	});
});

describe('Network presigns', () => {
	it('signs a presign for the connection epoch and returns the attested presign', async () => {
		const { network, received } = await connected((request) => presignAnswer(request));
		const presign = await network.requestPresign(requester, 5);
		expect(received).toHaveLength(1);
		expect(received[0].epoch).toBe(EPOCH);
		expect(received[0].data.chain_id.$kind).toBe('Solana');
		expect(received[0].data.request.$kind).toBe('Presign');
		expect(received[0].data.request.Presign!.signature_algorithm.$kind).toBe('EdDSA');
		expect(presign.material).toEqual(new Uint8Array(8).fill(0x45));
		expect(presign.epoch).toBe(EPOCH);
	});

	it('signs through a request signer, with no secret key in the requester', async () => {
		const { network, received } = await connected((request) => presignAnswer(request));
		const signer = RequestKey.fromSecretKey(REQUEST_SECRET);
		let calls = 0;
		const presign = await network.requestPresign(
			{
				...requester,
				keypair: { publicKey: signer.publicKey, secretKey: new Uint8Array(0) },
				signer: {
					publicKey: signer.publicKey,
					signRequest: (bytes) => ((calls += 1), signer.signRequest(bytes)),
				},
			},
			5,
		);
		expect(calls).toBe(1);
		expect(received).toHaveLength(1);
		expect(presign.material).toEqual(new Uint8Array(8).fill(0x45));
	});

	it("refuses a request signer's signature that does not verify, before sending", async () => {
		const { network, received } = await connected((request) => presignAnswer(request));
		const other = RequestKey.fromSecretKey(OTHER_SECRET);
		await expect(
			network.requestPresign(
				{
					...requester,
					keypair: { publicKey: requester.keypair.publicKey, secretKey: new Uint8Array(0) },
					signer: {
						publicKey: requester.keypair.publicKey,
						signRequest: (bytes) => other.signRequest(bytes),
					},
				},
				5,
			),
		).rejects.toThrow(/does not verify under the request key/);
		expect(received).toHaveLength(0);
	});

	it('sends the same bytes again while the gas deposit is not read yet', async () => {
		let refusals = 1;
		const { network, received } = await connected((request) =>
			refusals-- > 0
				? {
						Error: {
							message: `${NO_GAS_DEPOSIT_REFUSAL}; create one, wait until it is read, and retry`,
						},
					}
				: presignAnswer(request),
		);
		await network.requestPresign(requester, 5);
		expect(received).toHaveLength(2);
		expect(hex(received[1].sessionIdentifier)).toBe(hex(received[0].sessionIdentifier));
	});

	it('throws EpochClosedBeforeAnswer on a stale-epoch refusal, and signs nothing again', async () => {
		const chain = { epoch: EPOCH };
		const { network, received } = await connected(
			(request) => {
				chain.epoch = EPOCH + 1n;
				return request.epoch === EPOCH
					? {
							Error: {
								message: `request epoch ${EPOCH} does not match current epoch ${EPOCH + 1n}`,
							},
						}
					: presignAnswer(request);
			},
			{ chain },
		);
		const error = await refusal(network.requestPresign(requester, 5));
		expect(error).toBeInstanceOf(EpochClosedBeforeAnswer);
		const closed = error as EpochClosedBeforeAnswer;
		expect(closed.epoch).toBe(EPOCH);
		expect(closed.chainEpoch).toBe(EPOCH + 1n);
		expect(hex(closed.sessionIdentifier)).toBe(hex(received[0].sessionIdentifier));
		expect(received).toHaveLength(1);

		// The next request names the epoch the chain shows.
		const presign = await network.requestPresign(requester, 5);
		expect(received[1].epoch).toBe(EPOCH + 1n);
		expect(presign.epoch).toBe(EPOCH + 1n);
	});

	it("names the chain's epoch, not the one the validator serves", async () => {
		const chain = { epoch: EPOCH };
		// The validator still serves the network key with the old epoch.
		const { network, received } = await connected((request) => presignAnswer(request), {
			chain,
			epochs: [EPOCH],
		});
		chain.epoch = EPOCH + 1n;
		await network.requestPresign(requester, 5);
		expect(received[0].epoch).toBe(EPOCH + 1n);
		expect(network.epoch).toBe(EPOCH + 1n);
	});

	it('sends byte-identical requests on every resend within an epoch', async () => {
		const resends: Answer[] = [
			grpcError(status.ABORTED, 'validator dropped the request (epoch change or restart)'),
			grpcError(
				status.UNAVAILABLE,
				'this validator has not entered the epoch the request names yet; retry shortly',
			),
			grpcError(status.DEADLINE_EXCEEDED, 'deadline exceeded'),
			{
				Error: {
					message: `${NO_GAS_DEPOSIT_REFUSAL}; create one, wait until it is read, and retry`,
				},
			},
		];
		const { network, received } = await connected(
			(request) => resends.shift() ?? presignAnswer(request),
		);
		await network.requestPresign(requester, 'EddsaSha512');
		expect(received).toHaveLength(5);
		// One signed request, sent five times: one session, so one charge.
		expect(new Set(received.map((request) => request.sentBytes)).size).toBe(1);
	}, 60_000);

	it('sends the same request again when a validator dropped it', async () => {
		let answered = 0;
		const { network, received } = await connected((request) =>
			answered++ === 0
				? grpcError(status.ABORTED, 'validator dropped the request (epoch change or restart)')
				: presignAnswer(request),
		);
		await network.requestPresign(requester, 'EddsaSha512');
		expect(received).toHaveLength(2);
		expect(hex(received[1].sessionIdentifier)).toBe(hex(received[0].sessionIdentifier));
	});

	it('sends the same request again while the validator has not entered its epoch', async () => {
		let answered = 0;
		const { network, received } = await connected((request) =>
			answered++ === 0
				? grpcError(
						status.UNAVAILABLE,
						'this validator has not entered the epoch the request names yet; retry shortly',
					)
				: presignAnswer(request),
		);
		await network.requestPresign(requester, 'EddsaSha512');
		expect(received).toHaveLength(2);
		expect(hex(received[1].sessionIdentifier)).toBe(hex(received[0].sessionIdentifier));
	});

	it('asks again under a new session while the presign pool is empty, when told to wait', async () => {
		let answered = 0;
		const empty = { Error: { message: PRESIGN_POOL_EMPTY_REFUSAL } };
		const { network, received } = await connected((request) =>
			answered++ === 0 ? empty : presignAnswer(request),
		);
		await expect(network.requestPresign(requester, 'EddsaSha512')).rejects.toThrow(
			PRESIGN_POOL_EMPTY_REFUSAL,
		);
		answered = 0;
		await network.requestPresign(requester, 'EddsaSha512', { poolWaitMs: 30_000 });
		expect(received).toHaveLength(3);
		expect(hex(received[2].sessionIdentifier)).not.toBe(hex(received[1].sessionIdentifier));
	});

	it('takes a scheme by its name', async () => {
		expect(signatureSchemeNumber('EddsaSha512')).toBe(5);
		expect(signatureSchemeNumber('EcdsaKeccak256')).toBe(0);
		expect(signatureSchemeNumber(3)).toBe(3);
		expect(() => signatureSchemeNumber('Rsa' as any)).toThrow(/not one the network knows/);
		expect(() => signatureSchemeNumber(7)).toThrow(/not one the network knows/);
		const { network, received } = await connected((request) => presignAnswer(request));
		await network.requestPresign(requester, 'EddsaSha512');
		expect(received[0].data.request.Presign!.signature_algorithm.$kind).toBe('EdDSA');
	});

	it('uses a fresh session for every request', async () => {
		const { network, received } = await connected((request) => presignAnswer(request));
		await network.requestPresign(requester, 5);
		await network.requestPresign(requester, 5);
		expect(hex(received[0].sessionIdentifier)).not.toBe(hex(received[1].sessionIdentifier));
	});

	it('refuses a scheme that does not sign on the curve before sending', async () => {
		const { network, received } = await connected((request) => presignAnswer(request));
		await expect(network.requestPresign(requester, 0)).rejects.toThrow(/does not sign on/);
		expect(received).toHaveLength(0);
	});

	it('refuses a presign served to another requester', async () => {
		const { network } = await connected((request) =>
			presignAnswer(request, { userPubkey: new Uint8Array(32).fill(9) }),
		);
		await expect(network.requestPresign(requester, 5)).rejects.toThrow();
	});

	it('refuses a replayed presign answer for another session', async () => {
		const { network } = await connected((request) =>
			presignAnswer(request, { sessionIdentifier: new Uint8Array(32).fill(7) }),
		);
		await expect(network.requestPresign(requester, 5)).rejects.toThrow();
	});

	it('refuses an answer signed by a key the connection does not trust', async () => {
		const { network } = await connected((request) => {
			const answer = presignAnswer(request) as any;
			const data = Uint8Array.from(answer.Attestation.attestation_data);
			return { Attestation: signedAttestation('presign', data, OTHER_SECRET) };
		});
		await expect(network.requestPresign(requester, 5)).rejects.toThrow();
	});

	/** Chain records that hold the charges `charged` and nothing else. */
	const recordsHolding = (charged: Uint8Array[] = []): RequestRecordReader => ({
		hasGasCharge: async (_key, chargeId) => charged.some((id) => hex(id) === hex(chargeId)),
		voucherSignature: async () => null,
		futureVoucher: async () => null,
	});

	it('builds a presign again for the next epoch when the chain shows it never ran', async () => {
		const chain = { epoch: EPOCH };
		const { network, received } = await connected(
			(request) => {
				if (request.epoch === EPOCH) {
					chain.epoch = EPOCH + 1n;
					return grpcError(status.UNAVAILABLE, EPOCH_CLOSING_REFUSAL);
				}
				return presignAnswer(request);
			},
			{ chain, requestRecords: recordsHolding() },
		);
		const presign = await network.requestPresign(requester, 5);
		expect(received.map((request) => request.epoch)).toEqual([EPOCH, EPOCH + 1n]);
		expect(hex(received[1].sessionIdentifier)).not.toBe(hex(received[0].sessionIdentifier));
		expect(presign.epoch).toBe(EPOCH + 1n);
	}, 30_000);

	it('throws RequestRanBeforeAnswer, and sends nothing again, when the chain holds its charge', async () => {
		const chain = { epoch: EPOCH };
		const charged: Uint8Array[] = [];
		const { network, received } = await connected(
			(request) => {
				chain.epoch = EPOCH + 1n;
				// The network served the presign and charged it, and the
				// answer never reached this client.
				charged.push(gasChargeId('CompletedPresign', request.sessionIdentifier));
				return grpcError(status.UNAVAILABLE, EPOCH_CLOSING_REFUSAL);
			},
			{ chain, requestRecords: recordsHolding(charged) },
		);
		const error = await refusal(network.requestPresign(requester, 5));
		expect(error).toBeInstanceOf(RequestRanBeforeAnswer);
		expect((error as RequestRanBeforeAnswer).record).toMatch(/CompletedPresign/);
		expect(hex((error as RequestRanBeforeAnswer).sessionIdentifier)).toBe(
			hex(received[0].sessionIdentifier),
		);
		expect(received).toHaveLength(1);
	}, 30_000);

	it('throws EpochClosedBeforeAnswer when the chain read fails', async () => {
		const chain = { epoch: EPOCH };
		const { network, received } = await connected(
			() => {
				chain.epoch = EPOCH + 1n;
				return grpcError(status.UNAVAILABLE, EPOCH_CLOSING_REFUSAL);
			},
			{
				chain,
				requestRecords: {
					...recordsHolding(),
					hasGasCharge: async () => {
						throw new Error('the endpoints disagree');
					},
				},
			},
		);
		const error = await refusal(network.requestPresign(requester, 5));
		expect(error).toBeInstanceOf(EpochClosedBeforeAnswer);
		expect(received).toHaveLength(1);
	}, 30_000);

	it('throws EpochClosedBeforeAnswer on a closing refusal once the chain passes the epoch', async () => {
		const chain = { epoch: EPOCH };
		const { network, received } = await connected(
			() => {
				setTimeout(() => (chain.epoch = EPOCH + 1n), 1_000);
				return grpcError(status.UNAVAILABLE, EPOCH_CLOSING_REFUSAL);
			},
			{ chain },
		);
		const started = Date.now();
		const error = await refusal(network.requestPresign(requester, 5));
		expect(error).toBeInstanceOf(EpochClosedBeforeAnswer);
		const closed = error as EpochClosedBeforeAnswer;
		expect(closed.epoch).toBe(EPOCH);
		expect(closed.chainEpoch).toBe(EPOCH + 1n);
		expect(closed.refusal).toBe(EPOCH_CLOSING_REFUSAL);
		expect(hex(closed.sessionIdentifier)).toBe(hex(received[0].sessionIdentifier));
		// It waited for the chain, and never signed the request again.
		expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
		expect(received).toHaveLength(1);
		expect(network.epoch).toBe(EPOCH + 1n);
	}, 120_000);
});

describe('Network.createDWallet', () => {
	it('refuses before computing anything when the connection key is not the latest', async () => {
		const { network, received } = await connected(() => grpcError(13, 'unused'), {
			latestKey: OTHER_KEY,
		});
		await expect(
			network.createDWallet(requester, {
				holder: requester.keypair,
				encryptionKey: new Uint8Array(32),
			}),
		).rejects.toThrow(/latest key/);
		expect(received).toHaveLength(0);
	});
});

describe('Network signing on the P-256 fixtures', () => {
	const NETWORK_OUTPUT = fixture('p256_network_output.bcs');
	const PRESIGN = fixture('p256_presign.bcs');
	const USER_SHARE = fixture('p256_user_secret_share.bcs');
	const MESSAGE = fixture('p256_message.bin');
	const SIGNATURE = fixture('p256_signature.bin');
	const HOLDER = requester.keypair.publicKey;
	const SESSION = new Uint8Array(32).fill(0x11);
	const ENCRYPTION_KEY_HASH = new Uint8Array(32).fill(0x15);
	const CIPHERTEXT = Uint8Array.of(1, 2, 3);
	const VOUCHER = new Uint8Array(32).fill(0x77);
	// `EcdsaSha256`, which signs as ECDSA over SHA-256 on secp256r1.
	const ECDSA_SHA256 = 1;
	const SECP256R1 = 1;

	function record(kind: AttestationKind, data: Uint8Array): AttestationRecord {
		return {
			attestationData: data,
			attestationVersion: 0,
			networkSignature: ed25519.sign(attestationSigningMessage(kind, data), NETWORK_SECRET),
			signerNoaPublicKey: NETWORK_KEY,
		};
	}

	async function p256DWallet() {
		const publicKey = await publicKeyFromDWalletOutput(Curve.SECP256R1, NETWORK_OUTPUT);
		const holder = { signature_scheme: { Ed25519: null }, signer_public_key: Array.from(HOLDER) };
		const dwalletData = VersionedDWalletDataAttestationBcs.serialize({
			V1: {
				session_identifier: Array.from(SESSION),
				intended_chain_sender: Array.from(requester.intendedChainSender),
				curve: { Secp256r1: null },
				public_key: Array.from(publicKey),
				public_output: Array.from(NETWORK_OUTPUT),
				is_imported_key: false,
				sign_during_dkg_signature: null,
				holder,
				encryption_key_hash: Array.from(ENCRYPTION_KEY_HASH),
				encrypted_share_hash: Array.from(keccak_256(CIPHERTEXT)),
				epoch: EPOCH,
			},
		}).toBytes();
		const shareData = VersionedEncryptedUserKeyShareAttestationBcs.serialize({
			V1: {
				session_identifier: Array.from(SESSION),
				intended_chain_sender: Array.from(requester.intendedChainSender),
				dwallet_public_key: Array.from(publicKey),
				encrypted_share_hash: Array.from(keccak_256(CIPHERTEXT)),
				encryption_key_hash: Array.from(ENCRYPTION_KEY_HASH),
				holder,
				dwallet_attestation_digest: Array.from(keccak_256(dwalletData)),
			},
		}).toBytes();
		const reader: DWalletShareReader = {
			chain: 'solana',
			trustedNetworkKeys: trustedNetworkKeys(NETWORK),
			readDWallet: async () => ({
				address: new Uint8Array(32).fill(0xd1),
				networkPublicKey: NETWORK_KEY,
				attestation: record('dwallet', dwalletData),
				readEncryptedShare: async () => record('encrypted_share', shareData),
				readPublicShare: async () => undefined,
			}),
		};
		const attestation = signedAttestation('dwallet', dwalletData);
		const usable = await assertDWalletUsable(
			reader,
			{ getSigningPublicKeyBytes: () => HOLDER },
			attestation,
		);
		const dwallet: DWallet = {
			curve: SECP256R1,
			publicKey,
			networkPublicOutput: usable.publicOutput,
			userSecretKeyShare: USER_SHARE,
			attestation: {
				attestation_data: Uint8Array.from(attestation.attestation_data),
				network_signature: Uint8Array.from(attestation.network_signature),
				network_pubkey: Uint8Array.from(attestation.network_pubkey),
				signer_noa_public_key: Uint8Array.from(attestation.signer_noa_public_key),
			},
			networkKeyId: NETWORK_KEY,
			share: { kind: 'encrypted', holder: HOLDER },
		};
		return { dwallet, usable };
	}

	const presign: Presign = {
		reference: new Uint8Array(32).fill(0x44),
		material: PRESIGN,
		attestation: {
			attestation_data: new Uint8Array(0),
			network_signature: new Uint8Array(0),
			network_pubkey: NETWORK_KEY,
			signer_noa_public_key: NETWORK_KEY,
		},
		epoch: EPOCH,
	};

	const connectP256 = (answer: (received: Received) => Answer) =>
		connected(answer, {
			curve: Curve.SECP256R1,
			dkgOutput: fixture('p256_network_key_dkg_output.bcs'),
		});

	it('computes the user half, signs a Sign, and returns the verified signature', async () => {
		const { network, received } = await connectP256(() => ({
			Signature: { signature: Array.from(SIGNATURE) },
		}));
		const { dwallet, usable } = await p256DWallet();
		const signature = await network.requestSignature(requester, {
			dwallet,
			usable,
			presign,
			message: MESSAGE,
			signatureScheme: ECDSA_SHA256,
			signatureVoucher: VOUCHER,
		});
		expect(signature).toEqual(SIGNATURE);
		const sign = received[0].data.request.Sign!;
		expect(sign.signature_scheme.$kind).toBe('EcdsaSha256');
		expect(sign.signature_voucher).toEqual(Array.from(VOUCHER));
		expect(sign.message_centralized_signature.length).toBeGreaterThan(0);
	}, 120_000);

	it('signs a Sign through a request signer', async () => {
		const { network, received } = await connectP256(() => ({
			Signature: { signature: Array.from(SIGNATURE) },
		}));
		const { dwallet, usable } = await p256DWallet();
		const signer = RequestKey.fromSecretKey(REQUEST_SECRET);
		const signature = await network.requestSignature(
			{
				...requester,
				keypair: { publicKey: signer.publicKey, secretKey: new Uint8Array(0) },
				signer,
			},
			{
				dwallet,
				usable,
				presign,
				message: MESSAGE,
				signatureScheme: ECDSA_SHA256,
				signatureVoucher: VOUCHER,
			},
		);
		expect(signature).toEqual(SIGNATURE);
		expect(received).toHaveLength(1);
	}, 120_000);

	it('sends the same sign again while the validator has not entered its epoch', async () => {
		let answered = 0;
		const { network, received } = await connectP256(() =>
			answered++ === 0
				? grpcError(
						status.UNAVAILABLE,
						'this validator has not entered the epoch the request names yet; retry shortly',
					)
				: { Signature: { signature: Array.from(SIGNATURE) } },
		);
		const { dwallet, usable } = await p256DWallet();
		const signature = await network.requestSignature(requester, {
			dwallet,
			usable,
			presign,
			message: MESSAGE,
			signatureScheme: ECDSA_SHA256,
			signatureVoucher: VOUCHER,
		});
		expect(signature).toEqual(SIGNATURE);
		// The same signed bytes, so the network runs the sign at most once.
		expect(received).toHaveLength(2);
		expect(hex(received[1].sessionIdentifier)).toBe(hex(received[0].sessionIdentifier));
	}, 120_000);

	it('refuses a signature that does not verify under the dWallet output', async () => {
		const { network } = await connectP256(() => ({
			Signature: {
				signature: Array.from(SIGNATURE.map((byte, index) => (index === 10 ? byte ^ 1 : byte))),
			},
		}));
		const { dwallet, usable } = await p256DWallet();
		await expect(
			network.requestSignature(requester, {
				dwallet,
				usable,
				presign,
				message: MESSAGE,
				signatureScheme: ECDSA_SHA256,
				signatureVoucher: VOUCHER,
			}),
		).rejects.toThrow();
	}, 120_000);

	it('throws EpochClosedBeforeAnswer on a closing refusal, and the next presign names the chain epoch', async () => {
		let answered = 0;
		const chain = { epoch: EPOCH };
		const { network, received } = await connected(
			(request) => {
				answered++;
				if (answered === 1) {
					chain.epoch = EPOCH + 1n;
					return grpcError(status.UNAVAILABLE, EPOCH_CLOSING_REFUSAL);
				}
				return presignAnswer(request, { curve: 'Secp256r1', algorithm: 'ECDSASecp256r1' });
			},
			{
				curve: Curve.SECP256R1,
				dkgOutput: fixture('p256_network_key_dkg_output.bcs'),
				chain,
			},
		);
		const { dwallet, usable } = await p256DWallet();
		const error = await refusal(
			network.requestSignature(requester, {
				dwallet,
				usable,
				presign,
				message: MESSAGE,
				signatureScheme: ECDSA_SHA256,
				signatureVoucher: VOUCHER,
			}),
		);
		expect(error).toBeInstanceOf(EpochClosedBeforeAnswer);
		expect((error as EpochClosedBeforeAnswer).epoch).toBe(EPOCH);
		// One sign, never signed again for the next epoch.
		expect(received).toHaveLength(1);

		const next = await network.requestPresign(requester, ECDSA_SHA256);
		expect(received[1].epoch).toBe(EPOCH + 1n);
		expect(next.epoch).toBe(EPOCH + 1n);
	}, 120_000);

	it("returns the voucher's signature when the sign's epoch closed before an answer", async () => {
		const chain = { epoch: EPOCH };
		const { network, received } = await connected(
			() => {
				chain.epoch = EPOCH + 1n;
				return grpcError(status.UNAVAILABLE, EPOCH_CLOSING_REFUSAL);
			},
			{
				curve: Curve.SECP256R1,
				dkgOutput: fixture('p256_network_key_dkg_output.bcs'),
				chain,
				requestRecords: {
					hasGasCharge: async () => false,
					voucherSignature: async (voucher) => (hex(voucher) === hex(VOUCHER) ? SIGNATURE : null),
					futureVoucher: async () => null,
				},
			},
		);
		const { dwallet, usable } = await p256DWallet();
		const signature = await network.requestSignature(requester, {
			dwallet,
			usable,
			presign,
			message: MESSAGE,
			signatureScheme: ECDSA_SHA256,
			signatureVoucher: VOUCHER,
		});
		expect(signature).toEqual(SIGNATURE);
		expect(received).toHaveLength(1);
	}, 120_000);

	it('throws PresignExpiredWithTheEpoch when the chain shows the sign never ran', async () => {
		const chain = { epoch: EPOCH };
		const { network, received } = await connected(
			() => {
				chain.epoch = EPOCH + 1n;
				return grpcError(status.UNAVAILABLE, EPOCH_CLOSING_REFUSAL);
			},
			{
				curve: Curve.SECP256R1,
				dkgOutput: fixture('p256_network_key_dkg_output.bcs'),
				chain,
				requestRecords: {
					hasGasCharge: async () => false,
					voucherSignature: async () => null,
					futureVoucher: async () => null,
				},
			},
		);
		const { dwallet, usable } = await p256DWallet();
		const error = await refusal(
			network.requestSignature(requester, {
				dwallet,
				usable,
				presign,
				message: MESSAGE,
				signatureScheme: ECDSA_SHA256,
				signatureVoucher: VOUCHER,
			}),
		);
		expect(error).toBeInstanceOf(PresignExpiredWithTheEpoch);
		expect(received).toHaveLength(1);
	}, 120_000);

	it("throws RequestRanBeforeAnswer when the chain holds the given-up sign's charge", async () => {
		const chain = { epoch: EPOCH };
		let session: Uint8Array = new Uint8Array(0);
		const { network } = await connected(
			(request) => {
				session = request.sessionIdentifier;
				chain.epoch = EPOCH + 1n;
				return grpcError(status.UNAVAILABLE, EPOCH_CLOSING_REFUSAL);
			},
			{
				curve: Curve.SECP256R1,
				dkgOutput: fixture('p256_network_key_dkg_output.bcs'),
				chain,
				requestRecords: {
					hasGasCharge: async (_key, chargeId) =>
						hex(chargeId) === hex(gasChargeId('GivenUpSignature', signatureCommitItemId(session))),
					voucherSignature: async () => null,
					futureVoucher: async () => null,
				},
			},
		);
		const { dwallet, usable } = await p256DWallet();
		const error = await refusal(
			network.requestSignature(requester, {
				dwallet,
				usable,
				presign,
				message: MESSAGE,
				signatureScheme: ECDSA_SHA256,
				signatureVoucher: VOUCHER,
			}),
		);
		expect(error).toBeInstanceOf(RequestRanBeforeAnswer);
		expect((error as RequestRanBeforeAnswer).record).toMatch(/GivenUpSignature/);
	}, 120_000);

	it('refuses a sign whose presign epoch the chain is past, before sending', async () => {
		const chain = { epoch: EPOCH };
		const { network, received } = await connected(
			() => ({ Signature: { signature: Array.from(SIGNATURE) } }),
			{
				curve: Curve.SECP256R1,
				dkgOutput: fixture('p256_network_key_dkg_output.bcs'),
				chain,
			},
		);
		chain.epoch = EPOCH + 1n;
		const { dwallet, usable } = await p256DWallet();
		const error = await refusal(
			network.requestSignature(requester, {
				dwallet,
				usable,
				presign,
				message: MESSAGE,
				signatureScheme: ECDSA_SHA256,
				signatureVoucher: VOUCHER,
			}),
		);
		expect(error).toBeInstanceOf(PresignExpiredWithTheEpoch);
		expect((error as PresignExpiredWithTheEpoch).epoch).toBe(EPOCH);
		expect((error as PresignExpiredWithTheEpoch).chainEpoch).toBe(EPOCH + 1n);
		expect(received).toHaveLength(0);
	}, 120_000);

	it('refuses a dWallet whose output is not the checked one before sending', async () => {
		const { network, received } = await connectP256(() => ({ Signature: { signature: [] } }));
		const { dwallet, usable } = await p256DWallet();
		await expect(
			network.requestSignature(requester, {
				dwallet: { ...dwallet, networkPublicOutput: Uint8Array.of(1, 2, 3) },
				usable,
				presign,
				message: MESSAGE,
				signatureScheme: ECDSA_SHA256,
				signatureVoucher: VOUCHER,
			}),
		).rejects.toThrow(/not the one its ownership check verified/);
		expect(received).toHaveLength(0);
	}, 120_000);

	it('refuses a dWallet of another network key at once', async () => {
		const { network, received } = await connectP256(() => ({ Signature: { signature: [] } }));
		const { dwallet, usable } = await p256DWallet();
		await expect(
			network.requestSignature(requester, {
				dwallet: { ...dwallet, networkKeyId: OTHER_KEY },
				usable,
				presign,
				message: MESSAGE,
				signatureScheme: ECDSA_SHA256,
				signatureVoucher: VOUCHER,
			}),
		).rejects.toThrow(/connect under the dWallet's key/);
		expect(received).toHaveLength(0);
	}, 120_000);

	it('refuses a future sign completion whose partial signature the trusted key did not sign', async () => {
		const { network, received } = await connectP256(() => ({ Signature: { signature: [] } }));
		const { dwallet } = await p256DWallet();
		const partialData = VersionedPartialUserSignatureAttestationBcs.serialize({
			V1: {
				session_identifier: Array.from(SESSION),
				intended_chain_sender: Array.from(requester.intendedChainSender),
				dwallet_public_key: Array.from(dwallet.publicKey),
				dwallet_attestation_hash: Array.from(
					keccak_256(Uint8Array.from(dwallet.attestation.attestation_data)),
				),
				future_signature_voucher: Array.from(VOUCHER),
				presign_session_identifier: Array.from(presign.reference),
				presign_attestation_hash: Array.from(new Uint8Array(32)),
				message_digest: Array.from(keccak_256(MESSAGE)),
				message_metadata_digest: Array.from(new Uint8Array(32)),
				signature_scheme: { EcdsaSha256: null },
				verified_sign_data: [],
			},
		}).toBytes();
		const forged = signedAttestation('partial_user_signature', partialData, OTHER_SECRET);
		await expect(
			network.completeFutureSignature(requester, {
				partialUserSignatureAttestation: forged,
				dwalletAttestation: dwallet.attestation,
				message: MESSAGE,
				messageMetadata: new Uint8Array(0),
				futureSignatureVoucher: VOUCHER,
				attested: undefined as any,
			}),
		).rejects.toThrow();
		expect(received).toHaveLength(0);
	}, 120_000);
});

describe('Network.createDWalletAndSign', () => {
	/** A presign attestation for `requester`, with `overrides`, as the network signs one. */
	function presignFor(overrides: Parameters<typeof presignAnswer>[1] & { epoch?: bigint } = {}) {
		const received = {
			epoch: overrides.epoch ?? EPOCH,
			sessionIdentifier: new Uint8Array(32).fill(0x61),
		} as Received;
		const answer = presignAnswer(received, overrides) as any;
		const data = VersionedPresignDataAttestationBcs.parse(
			Uint8Array.from(answer.Attestation.attestation_data),
		).V1!;
		const presign: Presign = {
			reference: Uint8Array.from(data.presign_session_identifier),
			material: Uint8Array.from(data.presign_data),
			attestation: answer.Attestation,
			epoch: received.epoch,
		};
		return presign;
	}

	const share = { holder: requester.keypair, encryptionKey: new Uint8Array(32) };
	const sign = (presign: Presign) => ({
		presign,
		message: new TextEncoder().encode('signed during DKG'),
		signatureScheme: 5,
	});

	it.each([
		[
			'served to another requester',
			{ userPubkey: new Uint8Array(32).fill(9) },
			/another requester/,
		],
		['of another algorithm', { curve: 'Curve25519', algorithm: 'ECDSASecp256k1' }, /it is for/],
		['of another epoch', { epoch: EPOCH - 1n }, /made in epoch/],
	] as const)(
		'refuses a presign %s before sending',
		async (_, overrides, refusal) => {
			const { network, received } = await connected(() => grpcError(13, 'unused'));
			await expect(
				network.createDWalletAndSign(requester, share, sign(presignFor(overrides as any))),
			).rejects.toThrow(refusal);
			expect(received).toHaveLength(0);
		},
		120_000,
	);

	it('sends the sign once, and throws EpochClosedBeforeAnswer on a closing refusal', async () => {
		// The user's half is computed for real, so the presign is the real
		// P-256 pool presign of the acceptance fixtures.
		const chain = { epoch: EPOCH };
		const { network, received } = await connected(
			() => {
				chain.epoch = EPOCH + 1n;
				return grpcError(status.UNAVAILABLE, EPOCH_CLOSING_REFUSAL);
			},
			{
				curve: Curve.SECP256R1,
				dkgOutput: fixture('p256_network_key_dkg_output.bcs'),
				chain,
			},
		);
		const material = fixture('p256_presign.bcs');
		const data = VersionedPresignDataAttestationBcs.serialize({
			V1: {
				session_identifier: Array.from(new Uint8Array(32).fill(0x61)),
				epoch: EPOCH,
				presign_session_identifier: Array.from(new Uint8Array(32).fill(0x44)),
				presign_data: Array.from(material),
				curve: { Secp256r1: null },
				signature_algorithm: { ECDSASecp256r1: null },
				dwallet_public_key: null,
				user_pubkey: Array.from(requester.keypair.publicKey),
				network_key_id: NETWORK_KEY,
			} as any,
		}).toBytes();
		const presign: Presign = {
			reference: new Uint8Array(32).fill(0x44),
			material,
			attestation: signedAttestation('presign', data),
			epoch: EPOCH,
		};
		const error = await refusal(
			network.createDWalletWithPublicShareAndSign(requester, {
				presign,
				message: new TextEncoder().encode('signed during DKG'),
				signatureScheme: 1,
			}),
		);
		expect(error).toBeInstanceOf(EpochClosedBeforeAnswer);
		expect(received).toHaveLength(1);
		const dkg = received[0].data.request.Dkg!;
		expect(dkg.sign_during_dkg_request!.signature_scheme.$kind).toBe('EcdsaSha256');
		expect(dkg.sign_during_dkg_request!.message_centralized_signature.length).toBeGreaterThan(0);
		expect(dkg.user_secret_key_share.$kind).toBe('Public');
	}, 300_000);
});

/**
 * The acceptance of a re-encrypted share, on the re-encryption of the
 * acceptance fixtures: the share of the Curve25519 dWallet whose output is
 * `dkg_network_output.bcs`, encrypted to the class-groups key of seed 35.
 * The stub chain holds the dWallet's record and the sender's share record,
 * both signed by the network key.
 */
describe('Network.acceptReEncryptedShare', () => {
	const DWALLET_OUTPUT = fixture('dkg_network_output.bcs');
	const ENCRYPTION_KEY = fixture('re_encryption_encryption_key.bcs');
	const DECRYPTION_KEY = fixture('re_encryption_decryption_key.bcs');
	const ENCRYPTED_SHARE = fixture('re_encryption_encrypted_share.bcs');
	const SENDER_SECRET = new Uint8Array(32).fill(0x41);
	const SENDER = ed25519.getPublicKey(SENDER_SECRET);
	const HOLDER_SECRET = new Uint8Array(32).fill(0x42);
	const holder = { secretKey: HOLDER_SECRET, publicKey: ed25519.getPublicKey(HOLDER_SECRET) };
	const SESSION = new Uint8Array(32).fill(0x11);
	const OWNER = new Uint8Array(32).fill(0x12);
	const SENDER_CIPHERTEXT = Uint8Array.of(9, 9, 9);
	const SENDER_KEY_HASH = new Uint8Array(32).fill(0x15);

	const holderOf = (key: Uint8Array) => ({
		signature_scheme: { Ed25519: null },
		signer_public_key: Array.from(key),
	});

	function record(kind: AttestationKind, data: Uint8Array): AttestationRecord {
		return {
			attestationData: data,
			attestationVersion: 0,
			networkSignature: ed25519.sign(attestationSigningMessage(kind, data), NETWORK_SECRET),
			signerNoaPublicKey: NETWORK_KEY,
		};
	}

	async function fixtureShare() {
		const publicKey = await publicKeyFromDWalletOutput(Curve.ED25519, DWALLET_OUTPUT);
		const dwalletData = VersionedDWalletDataAttestationBcs.serialize({
			V1: {
				session_identifier: Array.from(SESSION),
				intended_chain_sender: Array.from(OWNER),
				curve: { Curve25519: null },
				public_key: Array.from(publicKey),
				public_output: Array.from(DWALLET_OUTPUT),
				is_imported_key: false,
				sign_during_dkg_signature: null,
				holder: holderOf(SENDER),
				encryption_key_hash: Array.from(SENDER_KEY_HASH),
				encrypted_share_hash: Array.from(keccak_256(SENDER_CIPHERTEXT)),
				epoch: EPOCH,
			},
		}).toBytes();
		const shareOf = (holderKey: Uint8Array, keyHash: Uint8Array, ciphertext: Uint8Array) =>
			VersionedEncryptedUserKeyShareAttestationBcs.serialize({
				V1: {
					session_identifier: Array.from(SESSION),
					intended_chain_sender: Array.from(OWNER),
					dwallet_public_key: Array.from(publicKey),
					encrypted_share_hash: Array.from(keccak_256(ciphertext)),
					encryption_key_hash: Array.from(keyHash),
					holder: holderOf(holderKey),
					dwallet_attestation_digest: Array.from(keccak_256(dwalletData)),
				},
			}).toBytes();
		const senderShare = shareOf(SENDER, SENDER_KEY_HASH, SENDER_CIPHERTEXT);
		const newShare = shareOf(holder.publicKey, keccak_256(ENCRYPTION_KEY), ENCRYPTED_SHARE);
		const reader: DWalletShareReader = {
			chain: 'solana',
			trustedNetworkKeys: trustedNetworkKeys(NETWORK),
			readDWallet: async () => ({
				address: new Uint8Array(32).fill(0xd1),
				networkPublicKey: NETWORK_KEY,
				attestation: record('dwallet', dwalletData),
				readEncryptedShare: async (key) =>
					hex(key) === hex(SENDER) ? record('encrypted_share', senderShare) : undefined,
				readPublicShare: async () => undefined,
			}),
		};
		const received: ReEncryptedShare = {
			dwalletAttestation: signedAttestation('dwallet', dwalletData),
			shareAttestation: signedAttestation('encrypted_share', newShare),
			encryptedShareAndProof: ENCRYPTED_SHARE,
		};
		return { reader, received, publicKey, newShare };
	}

	const accept = (network: Network, reader: DWalletShareReader, received: ReEncryptedShare) =>
		network.acceptReEncryptedShare({
			reader,
			holder,
			encryptionKey: ENCRYPTION_KEY,
			decryptionKey: DECRYPTION_KEY,
			senderSignerPublicKey: SENDER,
			received,
		});

	it('signs the acceptance, sends nothing, and returns the dWallet with the decrypted share', async () => {
		const { reader, received, publicKey, newShare } = await fixtureShare();
		const { network, received: sent } = await connected(() => grpcError(13, 'unused'));
		const dwallet = await accept(network, reader, received);
		// The holder accepts on the chain, so nothing goes to the network.
		expect(sent).toHaveLength(0);
		// The acceptance is the holder's signature over the digest of the
		// share's own attestation, which the share record on the chain stores.
		const acceptance = dwallet.acceptance!;
		expect(hex(acceptance.holderPublicKey)).toBe(hex(holder.publicKey));
		expect(hex(acceptance.acceptanceDigest)).toBe(hex(keccak_256(newShare)));
		expect(
			ed25519.verify(acceptance.signature, acceptance.acceptanceDigest, holder.publicKey),
		).toBe(true);
		expect(hex(dwallet.publicKey)).toBe(hex(publicKey));
		expect(hex(dwallet.networkPublicOutput)).toBe(hex(DWALLET_OUTPUT));
		expect(dwallet.userSecretKeyShare.length).toBeGreaterThan(0);
		expect(dwallet.share).toEqual({ kind: 'encrypted', holder: holder.publicKey });
	}, 300_000);

	it('refuses a share the sender has no record of, before sending', async () => {
		const { reader, received } = await fixtureShare();
		const { network, received: sent } = await connected(() => grpcError(13, 'unused'));
		await expect(
			network.acceptReEncryptedShare({
				reader,
				holder,
				encryptionKey: ENCRYPTION_KEY,
				decryptionKey: DECRYPTION_KEY,
				senderSignerPublicKey: new Uint8Array(32).fill(3),
				received,
			}),
		).rejects.toThrow(/no share record of the sender/);
		expect(sent).toHaveLength(0);
	}, 300_000);
});
