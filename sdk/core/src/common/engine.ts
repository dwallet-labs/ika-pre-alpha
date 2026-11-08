// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * A connection to the ika network under one network key and one curve, with
 * every dWallet request as one call: create or import a dWallet, take a
 * presign, sign, make a share public, re-encrypt a share and accept it, and
 * the two steps of a future sign.
 *
 * Each call builds the request, computes the user's half of the protocol
 * step, signs the request with the requester's key, submits it, and checks
 * the answer against what it sent before it returns anything. The checks are
 * the ones the rest of this package exports; this class only runs them in
 * the right order.
 *
 * Its epoch rule differs: every request names the epoch the chain
 * shows, and a request whose epoch closes before an answer is never signed
 * again. The Rust SDK still rebuilds such a request for the epoch a
 * validator names. The chain packages (`@ika.xyz/pre-alpha-solana`,
 * `@ika.xyz/sdk-sui`) build the chain readers a connection takes.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

import { isMockValue, refuseMockValues } from '../client/mock-format.js';
import type { UserCryptography } from '../client/user-cryptography.js';
import {
	ATTESTATION_CURVES,
	completeFutureSignRequest,
	createUserSignMessageForSignDuringDkg,
	createUserSignMessageWithScheme,
	fromCurveToNumber,
	futureSignRequest,
	grpcSessionIdentifier,
	isEpochClosingRefusal,
	isRefusal,
	listedNetworkKey,
	makeSharePublicRequest,
	networkKeyIdFromBytes,
	networkOutputDigest,
	realCryptography,
	recordOfAttestation,
	reEncryptShareRequest,
	RefusalCode,
	requestNetworkValue,
	requestSigningMessage,
	signatureAlgorithmOnCurve,
	signatureFromResponseVerified,
	signDWalletShareAcceptance,
	signDWalletSignRequest,
	signGrpcRequest,
	signReEncryptedShareAcceptance,
	trustedNetworkKeys,
	UserSignatureBcs,
	verifyAttestation,
	verifyDWalletAttestationRecord,
	verifyFutureSignAnswer,
	verifyMakeSharePublicAnswer,
	verifyNetworkKeyOutput,
	verifyPresignAnswer,
	verifyPublicShareDkgAnswer,
	verifyReEncryptShareAnswer,
	VersionedDWalletDataAttestationBcs,
} from '../index.js';
import type {
	Curve,
	DWalletGrpcClientBase,
	DWalletLookup,
	DWalletShareReader,
	DWalletUsable,
	GrpcTransportKeypair,
	HeldAttestation,
	HolderEncryptionKeyEntry,
	IkaNetwork,
	NetworkKeyId,
	NetworkKeyOutputRecordReader,
	PartialUserSignatureAttestation,
	PresignDataAttestation,
	PublicShareAttestation,
	SentDWalletRequest,
	ShareAcceptanceSignature,
	SignedGrpcRequest,
	TransactionResponseData,
	TrustedNetworkKeys,
	VerifiedDWalletAttestation,
} from '../index.js';
import {
	encryptedShareAttestationBytes,
	findSession,
	publicShareAttestationBytes,
	RequestRanBeforeAnswer,
	settledAtEpoch,
} from './request-records.js';
import type {
	PendingRequest,
	PendingRequestKind,
	RequestOutcome,
	RequestRecordReader,
} from './request-records.js';

/**
 * The validator's refusal, before consensus, of a request whose gas deposit it
 * has not read yet (`NO_GAS_DEPOSIT` in the node). Nothing is charged, and the
 * same bytes may be sent again.
 */
export const NO_GAS_DEPOSIT_REFUSAL =
	'this transport key has no gas deposit on the chain the request names';
/**
 * The network's free refusal of a pool presign while the pool is empty, as
 * at the start of an epoch (`PRESIGN_POOL_EMPTY` in the node).
 */
export const PRESIGN_POOL_EMPTY_REFUSAL = 'presign pool empty for requested algorithm';
const POOL_RETRY_MS = 3_000;

/** How long a request refused for an unread gas deposit is sent again. */
export const DEPOSIT_READ_WAIT_MS = 20_000;
const DEPOSIT_READ_RETRY_MS = 1_000;
/** How often the same signed request is sent again while no validator answers it. */
const RESEND_INTERVAL_MS = 2_000;
/** How long the connect retries the network key read while it fails in transport. */
const NETWORK_KEY_READ_WAIT_MS = 120_000;
const NETWORK_KEY_READ_RETRY_MS = 2_000;

/** How long one submitted request may take, from send to answer. */
export const SUBMIT_TIMEOUT_MS = 5 * 60 * 1000;
/**
 * How long a request whose epoch closed before an answer waits for the chain
 * to show a later epoch, before {@link EpochClosedBeforeAnswer} is thrown.
 */
export const EPOCH_CLOSE_WAIT_MS = 30 * 60 * 1000;
const CHAIN_EPOCH_POLL_MS = 5_000;
/**
 * How many times a request whose epoch closed before an answer, and that the
 * chain shows never ran, is built again for a later epoch.
 */
const REBUILDS_AFTER_EPOCH_CLOSE = 2;

/** The scheme names in `DWalletSignatureScheme` variant order. */
export const SIGNATURE_SCHEMES = [
	'EcdsaKeccak256',
	'EcdsaSha256',
	'EcdsaDoubleSha256',
	'TaprootSha256',
	'EcdsaBlake2b256',
	'EddsaSha512',
	'SchnorrkelMerlin',
] as const;

/** A `DWalletSignatureScheme`, by its variant index (`0` is `EcdsaKeccak256`). */
export type SignatureSchemeNumber = number;

/** A `DWalletSignatureScheme` by its name, as the network names it. */
export type SignatureSchemeName = (typeof SIGNATURE_SCHEMES)[number];

/**
 * A signature scheme, by name (`'EddsaSha512'`, `'EcdsaSha256'`, ...) or by its
 * variant index. Each scheme signs on its own curves only: `EddsaSha512` on
 * Ed25519, `EcdsaSha256` on secp256k1 and P-256, `EcdsaKeccak256`,
 * `EcdsaDoubleSha256`, `TaprootSha256` and `EcdsaBlake2b256` on secp256k1, and
 * `SchnorrkelMerlin` on Ristretto.
 */
export type SignatureScheme = SignatureSchemeName | SignatureSchemeNumber;

/** The variant index of `signatureScheme`. Throws for a scheme the network does not know. */
export function signatureSchemeNumber(signatureScheme: SignatureScheme): SignatureSchemeNumber {
	const number =
		typeof signatureScheme === 'number'
			? signatureScheme
			: SIGNATURE_SCHEMES.indexOf(signatureScheme);
	if (SIGNATURE_SCHEMES[number] === undefined) {
		throw new Error(`the signature scheme ${signatureScheme} is not one the network knows`);
	}
	return number;
}

/**
 * The life of a gas deposit that its first create opens. A request whose
 * signer has no deposit yet names it (`deposit_incarnation`).
 */
export const FIRST_DEPOSIT_INCARNATION = 1n;

/** Who signs a request, and what the request names about its chain. */
export interface Requester {
	/**
	 * The Ed25519 key that signs the request. The network charges the request
	 * to this key's gas deposit on `chain`, and a presign is served to this key
	 * only.
	 */
	keypair: GrpcTransportKeypair;
	/**
	 * Signs in place of `keypair`'s secret key, for a request key held
	 * elsewhere, such as an app's backend that pays for its users' requests.
	 * `keypair.publicKey` must be its public key; `keypair.secretKey` is then
	 * not read.
	 */
	signer?: RequestSigner;
	/** The chain the request is for, and the one its gas deposit is on. */
	chain: 'Sui' | 'Solana';
	/**
	 * The chain address the request names (`intended_chain_sender`). A new
	 * dWallet is owned by this address on `chain`.
	 */
	intendedChainSender: Uint8Array;
}

/**
 * Signs the request bytes of a request key the SDK does not hold. It returns
 * the Ed25519 signature of the request signing message of
 * `signedRequestData` (`requestSigningMessage`), under `publicKey`. The SDK
 * verifies the signature before it sends the request.
 */
export interface RequestSigner {
	readonly publicKey: Uint8Array;
	signRequest(signedRequestData: Uint8Array): Promise<Uint8Array>;
}

/** Stands in for a request key's secret while the request is built for a `RequestSigner`. */
const UNSIGNED_KEYPAIR: GrpcTransportKeypair = (() => {
	const secretKey = new Uint8Array(32);
	return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
})();

/**
 * Sign a request for `requester`: with its own secret key, or through its
 * `signer`. `sign` builds the request and signs it with the keypair it is
 * given, after its own checks. For a signer, the request is built with a
 * placeholder key, then signed by the signer, whose signature must verify
 * under `requester.keypair.publicKey`.
 */
async function signFor(
	requester: Requester,
	sign: (keypair: GrpcTransportKeypair) => SignedGrpcRequest | Promise<SignedGrpcRequest>,
): Promise<SignedGrpcRequest> {
	if (requester.signer === undefined) {
		return sign(requester.keypair);
	}
	const { signedRequestData } = await sign(UNSIGNED_KEYPAIR);
	const publicKey = requester.keypair.publicKey;
	const signature = await requester.signer.signRequest(Uint8Array.from(signedRequestData));
	if (!ed25519.verify(signature, requestSigningMessage(signedRequestData), publicKey)) {
		throw new Error(
			'the request signer returned a signature that does not verify under the request key',
		);
	}
	return {
		signedRequestData,
		userSignature: UserSignatureBcs.serialize({
			Ed25519: { signature: Array.from(signature), public_key: Array.from(publicKey) },
		}).toBytes(),
	};
}

/**
 * Where a new dWallet's user share goes: encrypted to `encryptionKey`, and
 * held by `holder`, whose Ed25519 key signs the acceptance. The holder's
 * encryption key must already be registered on the requester's chain: the
 * network runs the request only when the holder's registry entry holds
 * exactly this key.
 */
export interface ShareEncryption {
	holder: GrpcTransportKeypair;
	encryptionKey: Uint8Array;
}

/** The share of a dWallet: encrypted to a holder, or public. */
export type DWalletShare = { kind: 'encrypted'; holder: Uint8Array } | { kind: 'public' };

/**
 * A dWallet and everything the user side keeps to use it.
 *
 * Restore one from storage only through a check: run `assertDWalletUsable`
 * on `attestation`, and take the public output from its result.
 */
export interface DWallet {
	/** The dWallet's curve, as `DWalletCurve` numbers it. */
	curve: number;
	publicKey: Uint8Array;
	/** The network's half of the key generation, from the checked attestation. */
	networkPublicOutput: Uint8Array;
	/**
	 * The user's secret key share. Never send it anywhere, or store it
	 * unencrypted. A dWallet whose share was made public still carries it.
	 */
	userSecretKeyShare: Uint8Array;
	/** The network's signed attestation of the dWallet, as every request on it carries it. */
	attestation: HeldAttestation;
	/** The network key the dWallet was created under, which every request on it names. */
	networkKeyId: NetworkKeyId;
	/** For an imported dWallet, the session identifier of its import; it is part of its address. */
	importedSessionIdentifier?: Uint8Array;
	share: DWalletShare;
	/**
	 * The holder's signed acceptance of its encrypted share, while the share
	 * waits on the chain for it. The chain refuses every use of a new dWallet
	 * until its first share is accepted. Send it in a chain transaction
	 * (`IkaTransaction.acceptEncryptedUserShare`); anyone may pay for it.
	 */
	acceptance?: ShareAcceptanceSignature;
}

/** One presign: the network's precomputed half of a future signature. */
export interface Presign {
	/** The network's reference to it, sent back in the sign request. */
	reference: Uint8Array;
	/** The presign material the user's half of the signature is computed against. */
	material: Uint8Array;
	/** The network's attestation of it; a future sign carries it. */
	attestation: HeldAttestation;
	/** The epoch it was assigned in. It expires with that epoch. */
	epoch: bigint;
}

/** A sign carried by a DKG request: one message signed with the dWallet it creates. */
export interface SignDuringDkg {
	/** A pool presign of this epoch, for the scheme's algorithm on the connection's curve. */
	presign: Presign;
	message: Uint8Array;
	/** The scheme's metadata; empty or omitted for a scheme that takes none. */
	messageMetadata?: Uint8Array;
	signatureScheme: SignatureScheme;
}

/** A sign during DKG with its scheme as its variant index. */
type NumberedSignDuringDkg = Omit<SignDuringDkg, 'signatureScheme'> & {
	signatureScheme: SignatureSchemeNumber;
};

/** What `makeSharePublic` returns. */
export interface MadePublic {
	dwallet: DWallet;
	publicShareAttestation: PublicShareAttestation;
}

/** What `reEncryptShare` returns, and what the sender gives the new holder. */
export interface ReEncryptedShare {
	dwalletAttestation: HeldAttestation;
	shareAttestation: HeldAttestation;
	encryptedShareAndProof: Uint8Array;
}

/** What step 1 of a future sign returns, and what its completion needs. */
export interface PartialSignature {
	partialUserSignatureAttestation: HeldAttestation;
	dwalletAttestation: HeldAttestation;
	message: Uint8Array;
	messageMetadata: Uint8Array;
	futureSignatureVoucher: Uint8Array;
	/** The decoded partial-signature attestation, checked under a trusted key. */
	attested: PartialUserSignatureAttestation;
}

/**
 * A request was sent, and its epoch closed before the network answered it.
 *
 * A validator refused the request because its epoch was closing, or because
 * that epoch had already closed. That is one validator's word. Another copy
 * of the same signed request may have run in the epoch, and been charged.
 * So the SDK does not sign the request again for a later epoch: a second
 * request would open a second session, and could be charged a second time.
 *
 * Before this is thrown, the SDK waits for up to {@link EPOCH_CLOSE_WAIT_MS}
 * until the chain shows that every session of the request's epoch is
 * settled, and looks on the chain for the request's session. This is thrown
 * when the chain did not get that far in time, or the lookup could not tell:
 * a DKG, an imported-key verification, a step 1 the network closed. Keep
 * `pending`, and pass it to `IkaClient.resolveSession` later, hours or a day
 * after: epochs last about a day. It says whether the request ran, or never
 * ran and may be sent again.
 */
export class EpochClosedBeforeAnswer extends Error {
	constructor(
		/** The epoch the request named. */
		readonly epoch: bigint,
		/** The session the request opened in that epoch. */
		readonly sessionIdentifier: Uint8Array,
		/** The latest epoch the chain showed when this was thrown. */
		readonly chainEpoch: bigint,
		/** The validator's refusal, as it sent it. */
		readonly refusal: string,
		/**
		 * The request, with what its lookup needs: keep it, and pass it to
		 * `IkaClient.resolveSession` later.
		 */
		readonly pending: PendingRequest,
	) {
		super(
			`the request for epoch ${epoch} was refused ("${refusal}"), and it may have run in that ` +
				`epoch: its session is ${hex(sessionIdentifier)}. The chain shows epoch ${chainEpoch}. ` +
				"Pass the error's pending request to IkaClient.resolveSession before you send the request again.",
		);
		this.name = 'EpochClosedBeforeAnswer';
	}
}

/**
 * A request that consumes a presign was not sent, because the chain is past
 * the presign's epoch. A presign expires with its epoch. Nothing was sent or
 * charged: take a new presign, and sign with it.
 */
export class PresignExpiredWithTheEpoch extends Error {
	constructor(
		/** The epoch the presign was made in. */
		readonly epoch: bigint,
		/** The epoch the chain shows. */
		readonly chainEpoch: bigint,
	) {
		super(
			`the presign was made in epoch ${epoch}, and the chain shows epoch ${chainEpoch}. ` +
				'The presign expired with its epoch, and nothing was sent: take a new presign, and sign with it.',
		);
		this.name = 'PresignExpiredWithTheEpoch';
	}
}

/** A request as it was signed and answered, and what its builder kept. */
interface Sent<T> {
	epoch: bigint;
	sessionIdentifier: Uint8Array;
	kept: T;
}

type BuiltRequest<T> = { request: any; kept: T };

/**
 * What a request type's lookup needs besides the session, once its epoch
 * closed before an answer (see `findSession`).
 */
type Describe<T> = (
	sessionIdentifier: Uint8Array,
	kept: T,
) => PendingRequestKind | Promise<PendingRequestKind>;

/** A request's epoch closed before a validator answered it. Caught inside `Network`. */
class ClosedBeforeAnswer<T> extends Error {
	constructor(
		readonly sent: Sent<T>,
		/** The validator's refusal, as it sent it. */
		readonly refusal: string,
	) {
		super(`the request's epoch ${sent.epoch} closed before an answer ("${refusal}")`);
	}
}

export interface ConnectArguments {
	/** The connection to the validators: the Node or the browser `DWalletGrpcClient`. */
	client: DWalletGrpcClientBase;
	/** The curve every dWallet of this connection is on. */
	curve: Curve;
	/**
	 * The network key the connection serves (its public key). To use an
	 * existing dWallet, the key it was created under. To create or import a
	 * dWallet, the epoch's latest usable key.
	 */
	networkKeyId: Uint8Array;
	/** The ika network the caller chose. */
	network: IkaNetwork;
	/**
	 * The reader of the chain's records of the network key's outputs, from the
	 * chain package (`solanaNetworkKeyOutputRecordReader`,
	 * `suiNetworkKeyOutputRecordReader`). The served outputs are checked
	 * against these records before anything is derived from them.
	 */
	records: NetworkKeyOutputRecordReader;
	/**
	 * Reads the chain's current epoch (`CommitteeChainReader.currentEpoch`).
	 * Every request names the epoch this read shows. No validator's word
	 * changes it.
	 */
	chainEpoch: () => Promise<bigint>;
	/**
	 * Reads the life (`incarnation`) of the gas deposit of `requestKey` on the
	 * chain, or `undefined` when the key has none, from the chain package.
	 * It is read before every request is signed, and the request names it
	 * (`deposit_incarnation`): the network admits a request only for the life
	 * it names, so a fresh read keeps a reopened deposit's requests from being
	 * refused. The deposit is the request key's own, also when someone else
	 * pays for it. Without the reader, and for a key with no deposit, a
	 * request names {@link FIRST_DEPOSIT_INCARNATION}.
	 */
	depositIncarnation?: (requestKey: Uint8Array) => Promise<bigint | undefined>;
	/**
	 * The chain reads that find a request's session once its epoch closed
	 * before an answer, from the chain package. Without them, every such
	 * request throws {@link EpochClosedBeforeAnswer}.
	 */
	requestRecords?: RequestRecordReader;
	/** The chain package's share reader, for the same lookups. */
	shares?: (trusted: TrustedNetworkKeys) => DWalletShareReader;
	/**
	 * The client's cryptography (`cryptography` of `IkaClient`). Absent means
	 * the 2PC-MPC protocol. Under a mock ika network's cryptography the served
	 * network key output must be the mock one; otherwise it must not be.
	 */
	cryptography?: UserCryptography;
}

/** A connection to the ika network under one network key and one curve. */
export class Network {
	/** The latest epoch the chain showed this connection. */
	#epoch: bigint;
	#trustedNetworkKeys: TrustedNetworkKeys;

	private constructor(
		readonly client: DWalletGrpcClientBase,
		readonly curve: Curve,
		readonly network: IkaNetwork,
		/** The network key this connection serves, and creates new dWallets under. */
		readonly networkKeyId: NetworkKeyId,
		/**
		 * The epoch's latest usable network key, as the validators report it. It
		 * decides only whether a DKG or an import is sent; nothing is checked
		 * against it.
		 */
		readonly latestNetworkKeyId: NetworkKeyId,
		/** The protocol parameters derived from the network key's checked output. */
		readonly protocolPublicParameters: Uint8Array,
		private readonly chainEpoch: () => Promise<bigint>,
		private readonly depositIncarnation:
			((requestKey: Uint8Array) => Promise<bigint | undefined>) | undefined,
		private readonly requestRecords: RequestRecordReader | undefined,
		private readonly shares: ((trusted: TrustedNetworkKeys) => DWalletShareReader) | undefined,
		/** The client's cryptography: the user's half of each protocol step. */
		readonly cryptography: UserCryptography,
		epoch: bigint,
		trusted: TrustedNetworkKeys,
	) {
		this.#epoch = epoch;
		this.#trustedNetworkKeys = trusted;
	}

	/**
	 * Connect under `networkKeyId`, check the network key's outputs the
	 * validators serve against the chain's records of them, and derive the
	 * protocol parameters of `curve` from the checked outputs.
	 *
	 * On mainnet and testnet the key must be one this SDK lists for the
	 * network, and its DKG output must have the listed digest; otherwise this
	 * fails before anything is derived. On a custom network the key must be
	 * one of the network's keys (`{ custom: { networkPublicKeys } }`), which
	 * the caller took from its own configuration.
	 *
	 * Every request names the epoch the chain shows (`chainEpoch`), read
	 * again before each request. The chain shows a new epoch a little before
	 * the validators enter it; until they do, they answer `UNAVAILABLE`, and
	 * the same request is sent again.
	 */
	static async connect(args: ConnectArguments): Promise<Network> {
		const networkKeyId = networkKeyIdFromBytes(Uint8Array.from(args.networkKeyId));
		const trusted = trustedNetworkKeys(args.network);
		const listed = listedNetworkKey(args.network, networkKeyId);
		if ('custom' in (args.network as object)) {
			if (!trusted.publicKeys.some((key) => sameBytes(key, networkKeyId))) {
				throw new Error(
					`the network key ${hex(networkKeyId)} is not one of the custom network's keys`,
				);
			}
		} else if (listed === undefined) {
			throw new Error(
				`the network key ${hex(networkKeyId)} is not one this SDK lists for ${String(args.network)}`,
			);
		}
		// The three reads are independent, so they go out together.
		const [latestNetworkKeyId, served, epoch] = await Promise.all([
			args.client.latestNetworkKeyId(),
			networkKeyOutputRetried(args.client, networkKeyId),
			args.chainEpoch(),
		]);
		if (
			listed !== undefined &&
			!sameBytes(networkOutputDigest(served.networkDkgOutput), listed.dkgOutputDigest)
		) {
			throw new Error(
				'the network DKG output the validator served does not have the digest this SDK lists for the key',
			);
		}
		const verified = await verifyNetworkKeyOutput(served, networkKeyId, args.records);
		const cryptography = args.cryptography ?? realCryptography;
		const servesMock = isMockValue(verified.networkDkgOutput);
		if (servesMock && !cryptography.mock) {
			try {
				refuseMockValues(verified.networkDkgOutput);
			} catch (error) {
				throw new Error(
					`the network serves the mock network key: it is a mock ika network: ${(error as Error).message}`,
					{ cause: error },
				);
			}
		}
		if (!servesMock && cryptography.mock) {
			throw new Error('the client is in mock mode, and the network serves a real network key');
		}
		const protocolPublicParameters = await protocolPublicParametersOf(
			cryptography,
			args.curve,
			verified.networkDkgOutput,
			verified.latestReconfigurationOutput,
		);
		return new Network(
			args.client,
			args.curve,
			args.network,
			networkKeyId,
			latestNetworkKeyId,
			protocolPublicParameters,
			args.chainEpoch,
			args.depositIncarnation,
			args.requestRecords,
			args.shares,
			cryptography,
			epoch,
			customOrListed(args.network, [networkKeyId]),
		);
	}

	/** The latest epoch the chain showed this connection. */
	get epoch(): bigint {
		return this.#epoch;
	}

	/** The curve of this connection, as `DWalletCurve` numbers it. */
	get curveNumber(): number {
		return fromCurveToNumber(this.curve);
	}

	/**
	 * The network keys this connection accepts as an answer's signer: on a
	 * custom network the connection's key and any key added with
	 * {@link withTrustedNetworkPublicKeys}; on mainnet and testnet every key
	 * this SDK lists.
	 */
	get trustedNetworkKeys(): TrustedNetworkKeys {
		return this.#trustedNetworkKeys;
	}

	/**
	 * Accept `networkPublicKeys` too as the signer of an answer.
	 *
	 * The network's signing key can change from one epoch to the next. A
	 * dWallet made under an earlier key keeps that key, and the answers on it
	 * are then signed by the newer key. Connect under the dWallet's key, and
	 * add the newer key here, read from your chain first
	 * (`readAndVerifyNetworkKey`). An added key is trusted only as a signer:
	 * an answer's `network_pubkey` must still be this connection's key.
	 *
	 * On mainnet and testnet every listed key is already trusted, and a key
	 * the SDK does not list is refused.
	 */
	withTrustedNetworkPublicKeys(networkPublicKeys: readonly Uint8Array[]): this {
		if (!('custom' in (this.network as object))) {
			const unlisted = networkPublicKeys.find(
				(key) => listedNetworkKey(this.network, key) === undefined,
			);
			if (unlisted !== undefined) {
				throw new Error(
					`the network key ${hex(unlisted)} is not one this SDK lists for ${String(this.network)}`,
				);
			}
			return this;
		}
		const keys = [...this.#trustedNetworkKeys.publicKeys];
		networkPublicKeys
			.filter((key) => !keys.some((trusted) => sameBytes(trusted, key)))
			.forEach((key) => keys.push(Uint8Array.from(key)));
		this.#trustedNetworkKeys = customOrListed(this.network, keys);
		return this;
	}

	// ── Submission ─────────────────────────────────────────────────────────

	/**
	 * Sign the request `build` makes with the requester's key, for the epoch
	 * the chain shows, and submit it (see {@link #signAndSend}).
	 *
	 * When the request's epoch closes before an answer, `lookup` decides what
	 * follows ({@link #outcomeAfterEpochClose}): a request that never ran is
	 * built again under a new session, for the epoch the chain then shows, up
	 * to {@link REBUILDS_AFTER_EPOCH_CLOSE} times.
	 */
	async #submit<T>(
		requester: Requester,
		build: (epoch: bigint, sessionIdentifier: Uint8Array) => Promise<BuiltRequest<T>>,
		describe: Describe<T>,
		rebuildsLeft = REBUILDS_AFTER_EPOCH_CLOSE,
	): Promise<{ response: TransactionResponseData; sent: Sent<T> }> {
		try {
			return await this.#signAndSend(
				requester,
				await this.#readChainEpoch(),
				(data) => signFor(requester, (keypair) => signGrpcRequest(keypair, data)),
				build,
			);
		} catch (error) {
			if (!(error instanceof ClosedBeforeAnswer)) throw error;
			const pending = await this.#pending(requester, error.sent as Sent<T>, describe);
			const outcome = await this.#outcomeAfterEpochClose(pending);
			if (outcome.kind === 'notRun' && rebuildsLeft > 0) {
				return this.#submit(requester, build, describe, rebuildsLeft - 1);
			}
			return this.#answerOrThrow(error as ClosedBeforeAnswer<T>, outcome, pending);
		}
	}

	/**
	 * Sign a request that consumes a presign, for the presign's epoch, and
	 * submit it (see {@link #signAndSend}). A presign expires with its epoch,
	 * so when the chain is already past it, nothing is sent: this throws
	 * {@link PresignExpiredWithTheEpoch}. It throws the same when the
	 * request's epoch closed before an answer and `lookup` finds that it never
	 * ran: its presign expired with the epoch, and nothing was charged.
	 */
	async #submitWithPresign<T = undefined>(
		requester: Requester,
		presignEpoch: bigint,
		sign: (signedData: any) => Promise<SignedGrpcRequest>,
		build: (sessionIdentifier: Uint8Array) => Promise<BuiltRequest<T>>,
		describe: Describe<T>,
	): Promise<{ response: TransactionResponseData; sent: Sent<T> }> {
		const chainEpoch = await this.#readChainEpoch();
		if (chainEpoch > presignEpoch) {
			throw new PresignExpiredWithTheEpoch(presignEpoch, chainEpoch);
		}
		try {
			return await this.#signAndSend(requester, presignEpoch, sign, (_, sessionIdentifier) =>
				build(sessionIdentifier),
			);
		} catch (error) {
			if (!(error instanceof ClosedBeforeAnswer)) throw error;
			const pending = await this.#pending(requester, error.sent as Sent<T>, describe);
			const outcome = await this.#outcomeAfterEpochClose(pending);
			if (outcome.kind === 'notRun') {
				throw new PresignExpiredWithTheEpoch(presignEpoch, this.#epoch);
			}
			return this.#answerOrThrow(error as ClosedBeforeAnswer<T>, outcome, pending);
		}
	}

	/**
	 * Build the request for `epoch` under a new session, sign it once, and
	 * send it until a validator answers.
	 *
	 * `build` is given the epoch the request names and the session identifier
	 * it opens. It runs once: the request is never signed again. While no
	 * validator answers, the same signed bytes are sent again
	 * (`#sendUntilAnswered`), so every copy opens the same session, and the
	 * network runs the request at most once.
	 *
	 * A validator may refuse the request because its epoch is closing, or
	 * because that epoch has already closed. Another copy of the request may
	 * still have run in that epoch, so this throws {@link ClosedBeforeAnswer},
	 * for the caller to look on the chain.
	 */
	async #signAndSend<T>(
		requester: Requester,
		epoch: bigint,
		sign: (signedData: any) => Promise<SignedGrpcRequest>,
		build: (epoch: bigint, sessionIdentifier: Uint8Array) => Promise<BuiltRequest<T>>,
	): Promise<{ response: TransactionResponseData; sent: Sent<T> }> {
		const depositIncarnation = await this.#readDepositIncarnation(requester);
		const preimage = freshPreimage();
		const sessionIdentifier = this.#sessionIdentifier(requester, epoch, preimage);
		const { request, kept } = await build(epoch, sessionIdentifier);
		const signed = await sign(
			signedData(
				requester,
				requestNetworkValue(this.network),
				depositIncarnation,
				epoch,
				preimage,
				request,
			),
		);
		const sent = { epoch, sessionIdentifier, kept };
		let answer: TransactionResponseData;
		try {
			answer = await this.#resendWhileDepositUnread(await this.#sendUntilAnswered(signed), signed);
		} catch (error) {
			if (!isEpochClosingRefusal(error)) throw error;
			throw new ClosedBeforeAnswer(sent, String((error as { details?: string }).details ?? ''));
		}
		if (staleEpochRefusal(answer, epoch) !== undefined) {
			throw new ClosedBeforeAnswer(sent, answer.Error!.message);
		}
		return { response: answer, sent };
	}

	/**
	 * The chain lookup of the dWallet a DKG or an import creates, from the
	 * user's own DKG output: its curve and public key.
	 */
	async #newDWallet(userPublicOutput: Uint8Array): Promise<DWalletLookup> {
		return {
			curve: this.curveNumber,
			publicKey: await this.cryptography.publicKeyFromCentralizedDKGOutput(
				this.curve,
				userPublicOutput,
			),
		};
	}

	/** `sent`, as the pending request its lookup and `resolveSession` take. */
	async #pending<T>(
		requester: Requester,
		sent: Sent<T>,
		describe: Describe<T>,
	): Promise<PendingRequest> {
		return {
			epoch: sent.epoch,
			sessionIdentifier: Uint8Array.from(sent.sessionIdentifier),
			transportKey: Uint8Array.from(requester.keypair.publicKey),
			curve: this.curveNumber,
			networkKeyId: Uint8Array.from(this.networkKeyId),
			...(await describe(sent.sessionIdentifier, sent.kept)),
		};
	}

	/**
	 * What became of a request whose epoch closed before an answer.
	 *
	 * This waits until the chain shows the epoch at which every session of
	 * the request's epoch is settled on it (`settledAtEpoch`), for up to
	 * {@link EPOCH_CLOSE_WAIT_MS}. A chain read that fails counts as "no
	 * later epoch yet". Then it looks on the chain for the session
	 * (`findSession`). Without the chain reads, a chain that did not get that
	 * far, or a read that fails, the outcome is unknown.
	 */
	async #outcomeAfterEpochClose(pending: PendingRequest): Promise<RequestOutcome> {
		const settledAt = settledAtEpoch(pending);
		const deadline = Date.now() + EPOCH_CLOSE_WAIT_MS;
		while (this.#epoch < settledAt && Date.now() < deadline) {
			try {
				await this.#readChainEpoch();
			} catch {
				// Read again at the next poll.
			}
			if (this.#epoch >= settledAt) break;
			await new Promise((resolve) => setTimeout(resolve, CHAIN_EPOCH_POLL_MS));
		}
		if (this.requestRecords === undefined || this.#epoch < settledAt) return { kind: 'unknown' };
		try {
			return await findSession(
				pending,
				this.requestRecords,
				this.shares?.(this.#trustedNetworkKeys),
			);
		} catch {
			return { kind: 'unknown' };
		}
	}

	/**
	 * The answer the chain gives for a request that ran: the signature its
	 * voucher holds, as the network's answer would carry it. Every other
	 * outcome is thrown.
	 */
	#answerOrThrow<T>(
		closed: ClosedBeforeAnswer<T>,
		outcome: RequestOutcome,
		pending: PendingRequest,
	): { response: TransactionResponseData; sent: Sent<T> } {
		const { sent, refusal } = closed;
		switch (outcome.kind) {
			case 'signature':
				return {
					response: {
						$kind: 'Signature',
						Signature: { signature: Array.from(outcome.signature) },
					} as TransactionResponseData,
					sent,
				};
			case 'ran':
				throw new RequestRanBeforeAnswer(sent.epoch, sent.sessionIdentifier, outcome.record);
			default:
				throw new EpochClosedBeforeAnswer(
					sent.epoch,
					sent.sessionIdentifier,
					this.#epoch,
					refusal,
					pending,
				);
		}
	}

	/**
	 * A validator refuses a request before consensus when it has not yet read
	 * the requester's gas deposit, as right after the deposit is created.
	 * Nothing was submitted or charged, so the identical signed bytes are sent
	 * again, once a second, for up to {@link DEPOSIT_READ_WAIT_MS}: the
	 * validators read a new deposit within seconds on Sui, and from finalized
	 * state on Solana. Any other answer is returned as it is.
	 */
	async #resendWhileDepositUnread(
		response: TransactionResponseData,
		signed: SignedGrpcRequest,
	): Promise<TransactionResponseData> {
		const deadline = Date.now() + DEPOSIT_READ_WAIT_MS;
		let answer = response;
		while (
			answer.$kind === 'Error' &&
			isRefusal(answer, [RefusalCode.NO_GAS_DEPOSIT], () =>
				answer.Error!.message.includes(NO_GAS_DEPOSIT_REFUSAL),
			) &&
			Date.now() < deadline
		) {
			await new Promise((resolve) => setTimeout(resolve, DEPOSIT_READ_RETRY_MS));
			answer = await this.client.submitTransaction(
				signed.userSignature,
				signed.signedRequestData,
				SUBMIT_TIMEOUT_MS,
			);
		}
		return answer;
	}

	/**
	 * Send the same signed bytes until a validator answers. A validator that
	 * has not entered the request's epoch yet, has no server up, or dropped
	 * the request at an epoch change answers `UNAVAILABLE` or `ABORTED`
	 * without running it, or asks for the same bytes again to answer from its
	 * record; the session is the same, so the network runs the request at most
	 * once. A closing refusal is thrown to the caller.
	 */
	async #sendUntilAnswered(signed: SignedGrpcRequest): Promise<TransactionResponseData> {
		const deadline = Date.now() + SUBMIT_TIMEOUT_MS;
		for (;;) {
			try {
				return await this.client.submitTransaction(
					signed.userSignature,
					signed.signedRequestData,
					Math.max(1, deadline - Date.now()),
				);
			} catch (error) {
				const retryable = isTransportFailure(error) || isDroppedRequest(error);
				if (isEpochClosingRefusal(error) || !retryable || Date.now() >= deadline) throw error;
				await new Promise((resolve) => setTimeout(resolve, RESEND_INTERVAL_MS));
			}
		}
	}

	/**
	 * The life of the requester's gas deposit a new request names, read
	 * through `depositIncarnation`: the deposit of the request key, which the
	 * network charges. A key with no deposit, and a connection with no
	 * reader, name {@link FIRST_DEPOSIT_INCARNATION}.
	 */
	async #readDepositIncarnation(requester: Requester): Promise<bigint> {
		if (this.depositIncarnation === undefined) return FIRST_DEPOSIT_INCARNATION;
		return (
			(await this.depositIncarnation(Uint8Array.from(requester.keypair.publicKey))) ??
			FIRST_DEPOSIT_INCARNATION
		);
	}

	/** Read the chain's epoch, keep it when it is later, and return the latest one seen. */
	async #readChainEpoch(): Promise<bigint> {
		const read = await this.chainEpoch();
		if (read > this.#epoch) this.#epoch = read;
		return this.#epoch;
	}

	#sessionIdentifier(requester: Requester, epoch: bigint, preimage: Uint8Array): Uint8Array {
		return grpcSessionIdentifier(epoch, 'Ed25519', requester.keypair.publicKey, preimage);
	}

	/**
	 * Unwrap an answer that should be an attestation of `kind`, and check it:
	 * signed by a trusted key, and naming this connection's key as the key
	 * that holds the dWallet.
	 */
	#expectAttestation(
		response: TransactionResponseData,
		kind: 'dwallet' | 'presign' | 'partial_user_signature' | 'encrypted_share' | 'public_share',
		publicShareCurve?: number,
	): HeldAttestation {
		if (response.$kind === 'Error') {
			throw new Error(`the network refused the request: ${response.Error!.message}`);
		}
		if (response.$kind !== 'Attestation') {
			throw new Error(`the network answered with ${response.$kind}, not an attestation`);
		}
		const attestation = response.Attestation!;
		verifyAttestation(
			{ answer: attestation },
			kind,
			this.networkKeyId,
			this.#trustedNetworkKeys,
			publicShareCurve,
		);
		return {
			attestation_data: Uint8Array.from(attestation.attestation_data),
			network_signature: Uint8Array.from(attestation.network_signature),
			network_pubkey: Uint8Array.from(attestation.network_pubkey),
			signer_noa_public_key: Uint8Array.from(attestation.signer_noa_public_key),
		};
	}

	#requireLatestNetworkKey(): void {
		if (!sameBytes(this.networkKeyId, this.latestNetworkKeyId)) {
			throw new Error(
				`the network creates a dWallet only under the epoch's latest key ${hex(this.latestNetworkKeyId)}, ` +
					`and this connection serves ${hex(this.networkKeyId)}; connect under the latest key`,
			);
		}
	}

	#requireServedDWallet(dwallet: DWallet): void {
		if (!sameBytes(dwallet.networkKeyId, this.networkKeyId)) {
			throw new Error(
				`the dWallet is under the network key ${hex(dwallet.networkKeyId)}, and this connection ` +
					`serves ${hex(this.networkKeyId)}; connect under the dWallet's key`,
			);
		}
		if (dwallet.curve !== this.curveNumber) {
			throw new Error(
				`the dWallet is on curve ${ATTESTATION_CURVES[dwallet.curve]}, and this connection ` +
					`serves ${ATTESTATION_CURVES[this.curveNumber]}`,
			);
		}
	}

	#verifiedDWallet(dwallet: DWallet): VerifiedDWalletAttestation {
		return verifyDWalletAttestationRecord(
			recordOfAttestation(dwallet.attestation),
			this.#trustedNetworkKeys,
			{
				curve: dwallet.curve,
				publicKey: dwallet.publicKey,
				importedSessionIdentifier: dwallet.importedSessionIdentifier,
			},
		);
	}

	// ── Creating a dWallet ─────────────────────────────────────────────────

	/**
	 * Run a distributed key generation, accept its share, and return the
	 * dWallet it created.
	 *
	 * The user's contribution is bound to the session the request opens, so
	 * it is computed for that session. The share is encrypted to
	 * `share.encryptionKey`, with a proof that the ciphertext is that share.
	 * The network commits the dWallet only after `share.holder` accepts the
	 * share, which this does before it returns.
	 */
	async createDWallet(requester: Requester, share: ShareEncryption): Promise<DWallet> {
		return (await this.#dkg(requester, share, undefined)).dwallet;
	}

	/**
	 * As {@link createDWallet}, and sign one message with the new dWallet in
	 * the same request (sign during DKG). The sign consumes `sign.presign`, a
	 * pool presign, so the request names the presign's epoch. When the chain
	 * is past that epoch, nothing is sent: this throws
	 * {@link PresignExpiredWithTheEpoch}. The signature is returned once it verifies under the new
	 * dWallet's checked output; the holder's acceptance checks it too.
	 */
	async createDWalletAndSign(
		requester: Requester,
		share: ShareEncryption,
		sign: SignDuringDkg,
	): Promise<{ dwallet: DWallet; signature: Uint8Array }> {
		const { dwallet, signature } = await this.#dkg(requester, share, numbered(sign));
		return { dwallet, signature: signature! };
	}

	/**
	 * Run a distributed key generation whose user share is public from the
	 * start, and return the dWallet it created. The dWallet is
	 * trust-minimized, not zero-trust: the network can sign with a signature
	 * voucher alone. No holder accepts anything, and the network commits the
	 * dWallet once the key generation completes.
	 *
	 * The answer must be a dWallet attestation signed by a trusted key that
	 * names this request's session, sender and curve, holds a public output
	 * that matches the user's own, a public key that is the one inside that
	 * output, and no holder, encryption key or encrypted share.
	 */
	async createDWalletWithPublicShare(requester: Requester): Promise<DWallet> {
		return (await this.#dkg(requester, undefined, undefined)).dwallet;
	}

	/** As {@link createDWalletWithPublicShare}, with a sign during DKG (see {@link createDWalletAndSign}). */
	async createDWalletWithPublicShareAndSign(
		requester: Requester,
		sign: SignDuringDkg,
	): Promise<{ dwallet: DWallet; signature: Uint8Array }> {
		const { dwallet, signature } = await this.#dkg(requester, undefined, numbered(sign));
		return { dwallet, signature: signature! };
	}

	/**
	 * The key generation behind the four public calls: an encrypted share when
	 * `share` is given, a public one otherwise, and a sign during it when
	 * `sign` is given.
	 */
	async #dkg(
		requester: Requester,
		share: ShareEncryption | undefined,
		sign: NumberedSignDuringDkg | undefined,
	): Promise<{ dwallet: DWallet; signature: Uint8Array | null }> {
		this.#requireLatestNetworkKey();
		const signDuringDkg =
			sign === undefined ? undefined : this.#signDuringDkgPresign(requester, sign);
		const build = async (sessionIdentifier: Uint8Array) => {
			const prepared = await this.cryptography.prepareDKGForSessionIdentifier(
				this.protocolPublicParameters,
				this.curve,
				sessionIdentifier,
			);
			const encryptedShareAndProof =
				share === undefined
					? undefined
					: await this.cryptography.encryptSecretShare(
							this.curve,
							prepared.userSecretKeyShare,
							share.encryptionKey,
							this.protocolPublicParameters,
						);
			const signRequest =
				sign === undefined
					? null
					: {
							presign_session_identifier: Array.from(sign.presign.reference),
							presign: Array.from(sign.presign.material),
							signature_scheme: schemeInput(sign.signatureScheme),
							message: Array.from(sign.message),
							message_metadata: Array.from(sign.messageMetadata ?? new Uint8Array(0)),
							message_centralized_signature: Array.from(
								await createUserSignMessageForSignDuringDkg({
									cryptography: this.cryptography,
									protocolPublicParameters: this.protocolPublicParameters,
									curve: this.curveNumber,
									signatureScheme: sign.signatureScheme,
									message: sign.message,
									messageMetadata: sign.messageMetadata ?? new Uint8Array(0),
									userPublicOutput: prepared.userPublicOutput,
									userSecretKeyShare: prepared.userSecretKeyShare,
									presign: sign.presign.material,
								}),
							),
						};
			return {
				request: {
					Dkg: {
						network_key_id: this.networkKeyId,
						curve: this.#curveInput(),
						centralized_public_key_share_and_proof: Array.from(prepared.userDKGMessage),
						user_secret_key_share:
							share === undefined
								? {
										Public: {
											public_user_secret_key_share: Array.from(prepared.userSecretKeyShare),
										},
									}
								: encryptedShareInput(share, encryptedShareAndProof!),
						user_public_output: Array.from(prepared.userPublicOutput),
						sign_during_dkg_request: signRequest,
					},
				},
				kept: { prepared, encryptedShareAndProof },
			};
		};
		// A sign during DKG consumes a presign, so the request names the
		// presign's epoch.
		const { response, sent } =
			signDuringDkg === undefined
				? await this.#submit(
						requester,
						(_, sessionIdentifier) => build(sessionIdentifier),
						async (_, kept) => ({
							kind: 'dkg',
							dwallet: await this.#newDWallet(kept.prepared.userPublicOutput),
						}),
					)
				: await this.#submitWithPresign(
						requester,
						BigInt(signDuringDkg.epoch),
						(data) => signFor(requester, (keypair) => signGrpcRequest(keypair, data)),
						build,
						async (_, kept) => ({
							kind: 'dkg',
							dwallet: await this.#newDWallet(kept.prepared.userPublicOutput),
						}),
					);
		const attestation = this.#expectAttestation(response, 'dwallet');
		const { prepared, encryptedShareAndProof } = sent.kept;
		const sentSign =
			sign === undefined
				? undefined
				: {
						message: sign.message,
						messageMetadata: sign.messageMetadata ?? new Uint8Array(0),
						signatureScheme: sign.signatureScheme,
					};

		let publicKey: Uint8Array;
		let publicOutput: Uint8Array;
		let signature: Uint8Array | null;
		let acceptance: ShareAcceptanceSignature | undefined;
		if (share !== undefined) {
			({ publicKey, publicOutput, acceptance } = await this.#signAcceptance(
				share.holder,
				attestation,
				{
					kind: 'Dkg',
					sessionIdentifier: sent.sessionIdentifier,
					intendedChainSender: requester.intendedChainSender,
					curve: this.curve,
					networkKeyId: this.networkKeyId,
					userPublicOutput: prepared.userPublicOutput,
					encryptionKey: share.encryptionKey,
					encryptedShareAndProof: encryptedShareAndProof!,
					signDuringDkg: sentSign,
				},
			));
			signature = signedDuringDkg(attestation);
		} else {
			// A public-share DKG has no acceptance, so its answer, with the
			// sign-during-DKG signature, is checked here.
			({ publicKey, publicOutput, signature } = await verifyPublicShareDkgAnswer(
				response,
				this.#trustedNetworkKeys,
				{
					sessionIdentifier: sent.sessionIdentifier,
					intendedChainSender: requester.intendedChainSender,
					curve: this.curve,
					networkKeyId: this.networkKeyId,
					userPublicOutput: prepared.userPublicOutput,
					signDuringDkg: sentSign,
				},
				this.cryptography,
			));
		}
		return {
			dwallet: {
				curve: this.curveNumber,
				publicKey,
				networkPublicOutput: publicOutput,
				userSecretKeyShare: prepared.userSecretKeyShare,
				attestation,
				networkKeyId: this.networkKeyId,
				share:
					share === undefined
						? { kind: 'public' }
						: { kind: 'encrypted', holder: Uint8Array.from(share.holder.publicKey) },
				acceptance,
			},
			signature,
		};
	}

	/**
	 * Check that `sign.presign` can carry a sign during DKG on this
	 * connection: a pool presign signed by a trusted key, served to this
	 * requester, of this connection's curve and the scheme's algorithm. Its
	 * epoch is checked against the chain when the request is sent.
	 */
	#signDuringDkgPresign(requester: Requester, sign: NumberedSignDuringDkg): PresignDataAttestation {
		const verified = verifyAttestation(
			{ answer: sign.presign.attestation },
			'presign',
			this.networkKeyId,
			this.#trustedNetworkKeys,
		);
		if (verified.kind !== 'presign') throw new Error('the presign attestation did not verify');
		const presign = verified.attestation;
		const algorithm = this.#algorithmOf(sign.signatureScheme);
		const problems = [
			[
				!sameBytes(presign.user_pubkey, requester.keypair.publicKey),
				'it was served to another requester',
			],
			[
				presign.dwallet_public_key != null,
				'it is bound to a dWallet; a sign during DKG takes a pool presign',
			],
			[
				presign.curve.$kind !== ATTESTATION_CURVES[this.curveNumber],
				`it is on curve ${presign.curve.$kind}`,
			],
			[
				presign.signature_algorithm.$kind !== algorithm,
				`it is for ${presign.signature_algorithm.$kind}, not ${algorithm}`,
			],
			[
				!sameBytes(presign.presign_session_identifier, sign.presign.reference) ||
					!sameBytes(presign.presign_data, sign.presign.material),
				'its reference or material is not the one its attestation holds',
			],
		] as const;
		const problem = problems.find(([holds]) => holds);
		if (problem !== undefined) {
			throw new Error(`the presign cannot carry a sign during DKG: ${problem[1]}`);
		}
		return presign;
	}

	/**
	 * Hand the network a key the user already holds, accept its share, and
	 * return a dWallet whose public key is that key's.
	 *
	 * The network verifies that the share it is given is a share of the
	 * public key claimed, so no one can bind a dWallet to a key they cannot
	 * sign for. The share is sent encrypted; making it public is a separate
	 * request on the dWallet once it exists.
	 *
	 * `secretKey` is the key as its curve's libraries hold it: 32 bytes,
	 * big-endian for secp256k1 and P-256. The BCS encoding the classic SDK
	 * takes (a 0x20 length byte before those 32) is accepted too.
	 *
	 * SECURITY WARNING: `secretKey` is the key being imported. It is used only
	 * in this process, to compute the user's share.
	 */
	async verifyImportedKey(
		requester: Requester,
		share: ShareEncryption,
		secretKey: Uint8Array,
	): Promise<DWallet> {
		this.#requireLatestNetworkKey();
		const { response, sent } = await this.#submit(
			requester,
			async (_, sessionIdentifier) => {
				const prepared = await this.cryptography.prepareImportedKeyVerificationForSessionIdentifier(
					this.protocolPublicParameters,
					this.curve,
					sessionIdentifier,
					importedSecretKeyEncoding(this.curveNumber, secretKey),
				);
				const encryptedShareAndProof = await this.cryptography.encryptSecretShare(
					this.curve,
					prepared.userSecretKeyShare,
					share.encryptionKey,
					this.protocolPublicParameters,
				);
				return {
					request: {
						ImportedKeyVerification: {
							network_key_id: this.networkKeyId,
							curve: this.#curveInput(),
							centralized_party_message: Array.from(prepared.userMessage),
							user_secret_key_share: encryptedShareInput(share, encryptedShareAndProof),
							user_public_output: Array.from(prepared.userPublicOutput),
						},
					},
					kept: { prepared, encryptedShareAndProof },
				};
			},
			async (sessionIdentifier, kept) => ({
				kind: 'importedKey',
				dwallet: {
					...(await this.#newDWallet(kept.prepared.userPublicOutput)),
					importedSessionIdentifier: Uint8Array.from(sessionIdentifier),
				},
			}),
		);
		const attestation = this.#expectAttestation(response, 'dwallet');
		const { publicKey, publicOutput, acceptance } = await this.#signAcceptance(
			share.holder,
			attestation,
			{
				kind: 'ImportedKeyVerification',
				sessionIdentifier: sent.sessionIdentifier,
				intendedChainSender: requester.intendedChainSender,
				curve: this.curve,
				networkKeyId: this.networkKeyId,
				userPublicOutput: sent.kept.prepared.userPublicOutput,
				encryptionKey: share.encryptionKey,
				encryptedShareAndProof: sent.kept.encryptedShareAndProof,
			},
		);
		return {
			curve: this.curveNumber,
			publicKey,
			networkPublicOutput: publicOutput,
			userSecretKeyShare: sent.kept.prepared.userSecretKeyShare,
			attestation,
			networkKeyId: this.networkKeyId,
			importedSessionIdentifier: sent.sessionIdentifier,
			share: { kind: 'encrypted', holder: Uint8Array.from(share.holder.publicKey) },
			acceptance,
		};
	}

	/**
	 * Sign the holder's acceptance of a new dWallet's encrypted share, and
	 * return it with the attested public key and public output.
	 *
	 * The holder signs only an attestation it has checked against what the
	 * user sent (`signDWalletShareAcceptance`). The network then writes the
	 * dWallet and its share to the chain, where the share waits for this
	 * acceptance.
	 */
	async #signAcceptance(
		holder: GrpcTransportKeypair,
		attestation: HeldAttestation,
		sent: SentDWalletRequest,
	): Promise<{
		publicKey: Uint8Array;
		publicOutput: Uint8Array;
		acceptance: ShareAcceptanceSignature;
	}> {
		const acceptance = await signDWalletShareAcceptance({
			cryptography: this.cryptography,
			holderSecretKey: holder.secretKey,
			attestation,
			trustedNetworkKeys: this.#trustedNetworkKeys,
			sent,
		});
		const data = VersionedDWalletDataAttestationBcs.parse(
			Uint8Array.from(attestation.attestation_data),
		).V1!;
		return {
			publicKey: Uint8Array.from(data.public_key),
			publicOutput: Uint8Array.from(data.public_output),
			acceptance,
		};
	}

	// ── Presigns ───────────────────────────────────────────────────────────

	/**
	 * Take one presign from the network's pool, for the scheme the sign that
	 * consumes it will use. It must be served to this requester, answer this
	 * very request, and be bound to no dWallet (`verifyPresignAnswer`).
	 *
	 * The pool is empty for a while at the start of each epoch, and the
	 * network then refuses the presign for free. By default that refusal is
	 * thrown. With `poolWaitMs`, the presign is asked for again, under a new
	 * session, every 3 seconds until the pool serves one or the time is up.
	 */
	async requestPresign(
		requester: Requester,
		signatureScheme: SignatureScheme,
		options: { poolWaitMs?: number } = {},
	): Promise<Presign> {
		const algorithm = this.#algorithmOf(signatureScheme);
		const request = {
			Presign: {
				network_key_id: this.networkKeyId,
				curve: this.#curveInput(),
				signature_algorithm: { [algorithm]: null },
			},
		};
		const deadline = Date.now() + (options.poolWaitMs ?? 0);
		for (;;) {
			try {
				return await this.#presign(requester, request, algorithm, null);
			} catch (error) {
				const poolEmpty = isRefusal(error, [RefusalCode.PRESIGN_POOL_EMPTY], () =>
					String((error as Error)?.message).includes(PRESIGN_POOL_EMPTY_REFUSAL),
				);
				if (!poolEmpty || Date.now() >= deadline) throw error;
				await new Promise((resolve) => setTimeout(resolve, POOL_RETRY_MS));
			}
		}
	}

	/**
	 * Take `count` pool presigns at once, for signs to come. The requests go
	 * out together, so this takes about as long as one presign. Presigns
	 * expire with the epoch they were made in, so take them close to the signs
	 * that consume them.
	 */
	requestPresigns(
		requester: Requester,
		signatureScheme: SignatureScheme,
		count: number,
		options: { poolWaitMs?: number } = {},
	): Promise<Presign[]> {
		return Promise.all(
			Array.from({ length: count }, () => this.requestPresign(requester, signatureScheme, options)),
		);
	}

	/**
	 * Take a presign bound to one imported dWallet. An imported ECDSA key's
	 * sign accepts only such a presign, computed against the key's own public
	 * output. It is slower than a pool presign.
	 */
	async requestPresignForDWallet(
		requester: Requester,
		dwallet: DWallet,
		signatureScheme: SignatureScheme,
	): Promise<Presign> {
		this.#requireServedDWallet(dwallet);
		const algorithm = this.#algorithmOf(signatureScheme);
		const request = {
			PresignForDWallet: {
				network_key_id: dwallet.networkKeyId,
				dwallet_public_key: Array.from(dwallet.publicKey),
				dwallet_attestation: requestAttestation(dwallet.attestation),
				curve: this.#curveInput(),
				signature_algorithm: { [algorithm]: null },
			},
		};
		return this.#presign(requester, request, algorithm, dwallet.publicKey);
	}

	async #presign(
		requester: Requester,
		request: any,
		algorithm: string,
		dwalletPublicKey: Uint8Array | null,
	): Promise<Presign> {
		const { response, sent } = await this.#submit(
			requester,
			async () => ({ request, kept: undefined }),
			() => ({ kind: 'presign' }),
		);
		const data: PresignDataAttestation = verifyPresignAnswer(response, this.#trustedNetworkKeys, {
			sessionIdentifier: sent.sessionIdentifier,
			epoch: sent.epoch,
			curve: this.#curveInput(),
			signatureAlgorithm: { [algorithm]: null } as any,
			dwalletPublicKey,
			networkKeyId: this.networkKeyId,
		});
		if (!sameBytes(data.user_pubkey, requester.keypair.publicKey)) {
			throw new Error('the presign was served to another requester than this one');
		}
		const attestation = response.Attestation!;
		return {
			reference: Uint8Array.from(data.presign_session_identifier),
			material: Uint8Array.from(data.presign_data),
			attestation: {
				attestation_data: Uint8Array.from(attestation.attestation_data),
				network_signature: Uint8Array.from(attestation.network_signature),
				network_pubkey: Uint8Array.from(attestation.network_pubkey),
				signer_noa_public_key: Uint8Array.from(attestation.signer_noa_public_key),
			},
			epoch: sent.epoch,
		};
	}

	// ── Signing ────────────────────────────────────────────────────────────

	/**
	 * Ask the network to finish a signature over `message`, authorized by the
	 * voucher at `signatureVoucher`, and return it once it verifies under the
	 * dWallet's checked public output.
	 *
	 * The request names the voucher and carries no proof of it: the
	 * validators read it on the requester's chain themselves. So the voucher
	 * must be on chain before this call.
	 *
	 * `usable` is the result of `assertDWalletUsable` for this dWallet on the
	 * requester's chain, at most `DWALLET_USABLE_MAX_AGE_MS` old. One for
	 * another attestation, network key or chain, or an older one, is refused
	 * before anything is computed or sent. `messageMetadata` is a BCS
	 * `Blake2bMessageMetadata` for `EcdsaBlake2b256`, a BCS
	 * `SchnorrkelMessageMetadata` for `SchnorrkelMerlin`, and empty for every
	 * other scheme.
	 */
	async requestSignature(
		requester: Requester,
		args: {
			dwallet: DWallet;
			usable: DWalletUsable;
			presign: Presign;
			message: Uint8Array;
			messageMetadata?: Uint8Array;
			signatureScheme: SignatureScheme;
			signatureVoucher: Uint8Array;
		},
	): Promise<Uint8Array> {
		const { dwallet, usable, presign, message } = args;
		const signatureScheme = signatureSchemeNumber(args.signatureScheme);
		const messageMetadata = args.messageMetadata ?? new Uint8Array(0);
		this.#requireServedDWallet(dwallet);
		this.#requireCheckedOutput(dwallet, usable);
		if (args.signatureVoucher.length !== 32) {
			throw new Error(
				`the signature voucher's address must be 32 bytes; got ${args.signatureVoucher.length}`,
			);
		}
		const messageCentralizedSignature = await this.#userSignMessage(
			dwallet,
			presign,
			message,
			messageMetadata,
			signatureScheme,
		);
		const fields = {
			message: Array.from(message),
			message_metadata: Array.from(messageMetadata),
			signature_scheme: schemeInput(signatureScheme),
			presign_session_identifier: Array.from(presign.reference),
			message_centralized_signature: Array.from(messageCentralizedSignature),
			dwallet_attestation: requestAttestation(dwallet.attestation),
			signature_voucher: Array.from(args.signatureVoucher),
		};
		const request = isImported(dwallet) ? { ImportedKeySign: fields } : { Sign: fields };
		const { response } = await this.#submitWithPresign(
			requester,
			presign.epoch,
			(data) =>
				signFor(requester, (keypair) =>
					signDWalletSignRequest(keypair, data, {
						userKeys: { getSigningPublicKeyBytes: () => usable.holder },
						usable,
					}),
				),
			async () => ({ request, kept: undefined }),
			() => ({ kind: 'sign', voucher: Uint8Array.from(args.signatureVoucher) }),
		);
		return signatureFromResponseVerified(response, {
			cryptography: this.cryptography,
			curve: dwallet.curve,
			signatureScheme: signatureScheme,
			message,
			messageMetadata,
			dWalletPublicOutput: dwallet.networkPublicOutput,
		});
	}

	/**
	 * Step 1 of a future sign: send the user's partial signature over
	 * `message` with `presign`, for the voucher at `futureSignatureVoucher`,
	 * and return what the completion needs.
	 *
	 * A presign lives only for its epoch and is never kept on chain, so take
	 * the presign and send this step in the same epoch. The completion needs
	 * no presign and may run in any later epoch. The requester must be the
	 * presign's own requester and the voucher's signing key.
	 */
	async requestFutureSignature(
		requester: Requester,
		args: {
			dwallet: DWallet;
			usable: DWalletUsable;
			presign: Presign;
			message: Uint8Array;
			messageMetadata?: Uint8Array;
			signatureScheme: SignatureScheme;
			futureSignatureVoucher: Uint8Array;
		},
	): Promise<PartialSignature> {
		const { dwallet, usable, presign, message } = args;
		const signatureScheme = signatureSchemeNumber(args.signatureScheme);
		const messageMetadata = args.messageMetadata ?? new Uint8Array(0);
		this.#requireServedDWallet(dwallet);
		this.#requireCheckedOutput(dwallet, usable);
		this.#verifiedDWallet(dwallet);
		const messageCentralizedSignature = await this.#userSignMessage(
			dwallet,
			presign,
			message,
			messageMetadata,
			signatureScheme,
		);
		const request = futureSignRequest({
			usable,
			presignAttestation: presign.attestation,
			message,
			messageMetadata,
			messageCentralizedSignature,
			signatureScheme: schemeInput(signatureScheme),
			futureSignatureVoucher: args.futureSignatureVoucher,
			requesterPublicKey: requester.keypair.publicKey,
			trustedNetworkKeys: this.#trustedNetworkKeys,
		});
		const { response, sent } = await this.#submitWithPresign(
			requester,
			presign.epoch,
			(data) => signFor(requester, (keypair) => signGrpcRequest(keypair, data)),
			async () => ({ request, kept: undefined }),
			() => ({ kind: 'futureSignStepOne', voucher: Uint8Array.from(args.futureSignatureVoucher) }),
		);
		const attested = verifyFutureSignAnswer(response, this.#trustedNetworkKeys, {
			sessionIdentifier: sent.sessionIdentifier,
			intendedChainSender: requester.intendedChainSender,
			dwalletAttestation: dwallet.attestation,
			presignAttestation: presign.attestation,
			message,
			messageMetadata,
			signatureScheme: schemeInput(signatureScheme),
			futureSignatureVoucher: args.futureSignatureVoucher,
		});
		const attestation = response.Attestation!;
		return {
			partialUserSignatureAttestation: {
				attestation_data: Uint8Array.from(attestation.attestation_data),
				network_signature: Uint8Array.from(attestation.network_signature),
				network_pubkey: Uint8Array.from(attestation.network_pubkey),
				signer_noa_public_key: Uint8Array.from(attestation.signer_noa_public_key),
			},
			dwalletAttestation: dwallet.attestation,
			message,
			messageMetadata,
			futureSignatureVoucher: Uint8Array.from(args.futureSignatureVoucher),
			attested,
		};
	}

	/**
	 * The completion of a future sign: ask the network to finish the
	 * signature step 1 prepared, and return it once it verifies under the
	 * dWallet's checked public output.
	 *
	 * The requester must be the key the voucher's controller set to complete
	 * it, and need not hold the dWallet's share. Both attestations are checked
	 * under the trusted keys before the request is sent, and the request
	 * passes the checks the network makes on its bytes
	 * (`completeFutureSignRequest`).
	 */
	async completeFutureSignature(
		requester: Requester,
		partial: PartialSignature,
	): Promise<Uint8Array> {
		verifyAttestation(
			{ answer: partial.partialUserSignatureAttestation },
			'partial_user_signature',
			this.networkKeyId,
			this.#trustedNetworkKeys,
		);
		const verified = verifyAttestation(
			{ answer: partial.dwalletAttestation },
			'dwallet',
			this.networkKeyId,
			this.#trustedNetworkKeys,
		);
		if (verified.kind !== 'dwallet') throw new Error('the dWallet attestation did not verify');
		const request = completeFutureSignRequest({
			partialUserSignatureAttestation: partial.partialUserSignatureAttestation,
			dwalletAttestation: partial.dwalletAttestation,
			message: partial.message,
			messageMetadata: partial.messageMetadata,
			futureSignatureVoucher: partial.futureSignatureVoucher,
		});
		const { response } = await this.#submit(
			requester,
			async () => ({ request, kept: undefined }),
			() => ({
				kind: 'futureSignCompletion',
				voucher: Uint8Array.from(partial.futureSignatureVoucher),
			}),
		);
		return signatureFromResponseVerified(response, {
			cryptography: this.cryptography,
			curve: ATTESTATION_CURVES.indexOf(verified.attestation.curve.$kind),
			signatureScheme: SIGNATURE_SCHEMES.indexOf(
				partial.attested.signature_scheme.$kind as (typeof SIGNATURE_SCHEMES)[number],
			),
			message: partial.message,
			messageMetadata: partial.messageMetadata,
			dWalletPublicOutput: Uint8Array.from(verified.attestation.public_output),
		});
	}

	// ── User shares ────────────────────────────────────────────────────────

	/**
	 * Reveal the dWallet's user share, so the network can sign with a
	 * signature voucher alone, and return the dWallet with a public share.
	 * Irreversible.
	 *
	 * The answer must be the public share's attestation, signed by a trusted
	 * key, naming this request's session, and holding the very share sent.
	 * Any requester may sign and pay for the request.
	 */
	async makeSharePublic(
		requester: Requester,
		dwallet: DWallet,
		usable: DWalletUsable,
	): Promise<MadePublic> {
		this.#requireServedDWallet(dwallet);
		this.#requireCheckedOutput(dwallet, usable);
		const verified = this.#verifiedDWallet(dwallet);
		const { response, sent } = await this.#submit(
			requester,
			async () => ({
				request: makeSharePublicRequest(usable, dwallet.userSecretKeyShare),
				kept: undefined,
			}),
			(sessionIdentifier) => ({
				kind: 'makeSharePublic',
				dwallet: lookupOf(dwallet),
				shareCommitItemId: keccak_256(
					publicShareAttestationBytes(
						sessionIdentifier,
						dwalletAttested(dwallet),
						dwallet.userSecretKeyShare,
					),
				),
			}),
		);
		const publicShareAttestation = verifyMakeSharePublicAnswer(
			response,
			this.#trustedNetworkKeys,
			verified,
			{
				sessionIdentifier: sent.sessionIdentifier,
				networkKeyId: this.networkKeyId,
				publicUserSecretKeyShare: dwallet.userSecretKeyShare,
			},
		);
		return { dwallet: { ...dwallet, share: { kind: 'public' } }, publicShareAttestation };
	}

	/**
	 * Re-encrypt the dWallet's user share to a new holder, and return what the
	 * sender gives that holder.
	 *
	 * `newHolderEntry` is the new holder's registry entry on the requester's
	 * chain, as the chain package read and verified it. The share is
	 * encrypted to exactly that entry's key here, so a share encrypted to the
	 * wrong key cannot be sent and charged. The network commits the new share
	 * only after the new holder accepts it (`acceptReEncryptedShare`).
	 */
	async reEncryptShare(
		requester: Requester,
		args: {
			dwallet: DWallet;
			usable: DWalletUsable;
			newHolderSignerPublicKey: Uint8Array;
			newHolderEntry: HolderEncryptionKeyEntry;
		},
	): Promise<ReEncryptedShare> {
		const { dwallet, usable } = args;
		this.#requireServedDWallet(dwallet);
		this.#requireCheckedOutput(dwallet, usable);
		const verified = this.#verifiedDWallet(dwallet);
		const build = (encryptedShareAndProof: Uint8Array) =>
			reEncryptShareRequest({
				usable,
				encryptedShareAndProof,
				newHolderSignerPublicKey: args.newHolderSignerPublicKey,
				newHolderEntry: args.newHolderEntry,
			});
		// Checked before anything is encrypted.
		build(new Uint8Array(0));
		const encryptedShareAndProof = await this.cryptography.encryptSecretShare(
			this.curve,
			dwallet.userSecretKeyShare,
			args.newHolderEntry.encryptionKey,
			this.protocolPublicParameters,
		);
		// At protocol versions 8 to 10 a re-encryption's commit can land in the
		// epoch after its own, and the chain does not say which version runs,
		// so the lookup waits two epochs.
		const { response, sent } = await this.#submit(
			requester,
			async () => ({ request: build(encryptedShareAndProof), kept: undefined }),
			(sessionIdentifier) => ({
				kind: 'reEncryptShare',
				dwallet: lookupOf(dwallet),
				newHolder: Uint8Array.from(args.newHolderSignerPublicKey),
				shareCommitItemId: keccak_256(
					encryptedShareAttestationBytes(
						sessionIdentifier,
						dwalletAttested(dwallet),
						encryptedShareAndProof,
						args.newHolderEntry.encryptionKey,
						args.newHolderSignerPublicKey,
					),
				),
			}),
		);
		verifyReEncryptShareAnswer(response, this.#trustedNetworkKeys, verified, {
			sessionIdentifier: sent.sessionIdentifier,
			networkKeyId: this.networkKeyId,
			encryptedShareAndProof,
			encryptionKey: args.newHolderEntry.encryptionKey,
			holderSignerPublicKey: args.newHolderSignerPublicKey,
		});
		const answer = response.Attestation!;
		return {
			dwalletAttestation: dwallet.attestation,
			shareAttestation: {
				attestation_data: Uint8Array.from(answer.attestation_data),
				network_signature: Uint8Array.from(answer.network_signature),
				network_pubkey: Uint8Array.from(answer.network_pubkey),
				signer_noa_public_key: Uint8Array.from(answer.signer_noa_public_key),
			},
			encryptedShareAndProof,
		};
	}

	/**
	 * As the new holder, check a share re-encrypted to `holder`, sign its
	 * acceptance, and return the dWallet with the share decrypted and the
	 * acceptance to send on the chain.
	 *
	 * `senderSignerPublicKey` is the previous holder's signer key. It must
	 * come from the sender, through a channel you trust, never from a
	 * validator: the check reads the sender's acceptance on the chain under
	 * this key (`signReEncryptedShareAcceptance`). `reader` is the chain
	 * package's share reader. Nothing is sent to the network.
	 */
	async acceptReEncryptedShare(args: {
		reader: DWalletShareReader;
		holder: GrpcTransportKeypair;
		encryptionKey: Uint8Array;
		decryptionKey: Uint8Array;
		senderSignerPublicKey: Uint8Array;
		received: ReEncryptedShare;
	}): Promise<DWallet> {
		const acceptance = await signReEncryptedShareAcceptance({
			reader: args.reader,
			holderSecretKey: args.holder.secretKey,
			decryptionKey: args.decryptionKey,
			encryptionKey: args.encryptionKey,
			senderSignerPublicKey: args.senderSignerPublicKey,
			dwalletAttestation: args.received.dwalletAttestation,
			shareAttestation: args.received.shareAttestation,
			encryptedShareAndProof: args.received.encryptedShareAndProof,
			protocolPublicParameters: this.protocolPublicParameters,
		});
		// The check above read the dWallet's record on the chain and found
		// these attestation bytes in it; the attestation is checked under the
		// trusted keys, and the share is decrypted against its public output.
		const dwalletAttestation = args.received.dwalletAttestation;
		const verified = verifyAttestation(
			{ answer: dwalletAttestation },
			'dwallet',
			this.networkKeyId,
			this.#trustedNetworkKeys,
		);
		if (verified.kind !== 'dwallet') throw new Error('the dWallet attestation did not verify');
		const data = verified.attestation;
		const networkPublicOutput = Uint8Array.from(data.public_output);
		const userSecretKeyShare = await this.cryptography.decryptUserShareOfOutput(
			this.curve,
			args.decryptionKey,
			networkPublicOutput,
			args.received.encryptedShareAndProof,
			this.protocolPublicParameters,
		);
		return {
			curve: ATTESTATION_CURVES.indexOf(data.curve.$kind),
			publicKey: Uint8Array.from(data.public_key),
			networkPublicOutput,
			userSecretKeyShare,
			attestation: {
				attestation_data: Uint8Array.from(dwalletAttestation.attestation_data),
				network_signature: Uint8Array.from(dwalletAttestation.network_signature),
				network_pubkey: Uint8Array.from(dwalletAttestation.network_pubkey),
				signer_noa_public_key: Uint8Array.from(dwalletAttestation.signer_noa_public_key),
			},
			networkKeyId: this.networkKeyId,
			importedSessionIdentifier: data.is_imported_key
				? Uint8Array.from(data.session_identifier)
				: undefined,
			share: { kind: 'encrypted', holder: Uint8Array.from(args.holder.publicKey) },
			acceptance,
		};
	}

	// ── Helpers ────────────────────────────────────────────────────────────

	#curveInput(): any {
		return { [ATTESTATION_CURVES[this.curveNumber]]: null };
	}

	#algorithmOf(signatureScheme: SignatureScheme): string {
		return signatureAlgorithmOnCurve(
			schemeName(signatureSchemeNumber(signatureScheme)),
			ATTESTATION_CURVES[this.curveNumber],
		);
	}

	/**
	 * The dWallet's public output must be the one the ownership check took
	 * from the verified attestation. Otherwise the user's half would be
	 * computed from, and the signature verified under, an output nothing
	 * checked.
	 */
	#requireCheckedOutput(dwallet: DWallet, usable: DWalletUsable): void {
		if (!sameBytes(dwallet.networkPublicOutput, usable.publicOutput)) {
			throw new Error(
				"the dWallet's public output is not the one its ownership check verified in the " +
					"attestation; take the dWallet's public output from the checked attestation",
			);
		}
	}

	async #userSignMessage(
		dwallet: DWallet,
		presign: Presign,
		message: Uint8Array,
		messageMetadata: Uint8Array,
		signatureScheme: SignatureSchemeNumber,
	): Promise<Uint8Array> {
		return createUserSignMessageWithScheme({
			cryptography: this.cryptography,
			protocolPublicParameters: this.protocolPublicParameters,
			curve: dwallet.curve,
			signatureScheme,
			message,
			messageMetadata,
			dWalletPublicOutput: dwallet.networkPublicOutput,
			userSecretKeyShare: dwallet.userSecretKeyShare,
			presign: presign.material,
		});
	}
}

/**
 * The protocol parameters derived from a network key's checked outputs, by
 * curve and by the digests of those outputs. Deriving them takes seconds to
 * tens of seconds of class-groups computation, and they are a pure function
 * of the outputs, so every connection in this process shares one
 * derivation per key, curve and reconfiguration: connections made at the
 * same time wait for the same one. A failed derivation is not kept.
 */
const protocolPublicParametersCache = new Map<string, Promise<Uint8Array>>();
/** Enough for every curve of a few network keys and their reconfigurations. */
const PROTOCOL_PUBLIC_PARAMETERS_CACHE_SIZE = 16;

function protocolPublicParametersOf(
	cryptography: UserCryptography,
	curve: Curve,
	networkDkgOutput: Uint8Array,
	reconfigurationOutput: Uint8Array | undefined,
): Promise<Uint8Array> {
	const reconfiguration =
		reconfigurationOutput !== undefined && reconfigurationOutput.length > 0
			? reconfigurationOutput
			: undefined;
	const key = [
		cryptography.mock ? 'mock' : 'real',
		curve,
		hex(networkOutputDigest(networkDkgOutput)),
		reconfiguration === undefined ? '' : hex(networkOutputDigest(reconfiguration)),
	].join(':');
	const cached = protocolPublicParametersCache.get(key);
	if (cached !== undefined) {
		// Most recently used last, so eviction drops the oldest.
		protocolPublicParametersCache.delete(key);
		protocolPublicParametersCache.set(key, cached);
		return cached;
	}
	const derived = (
		reconfiguration === undefined
			? cryptography.networkDkgPublicOutputToProtocolPublicParameters(curve, networkDkgOutput)
			: cryptography.reconfigurationPublicOutputToProtocolPublicParameters(
					curve,
					reconfiguration,
					networkDkgOutput,
				)
	).catch((error) => {
		protocolPublicParametersCache.delete(key);
		throw error;
	});
	protocolPublicParametersCache.set(key, derived);
	if (protocolPublicParametersCache.size > PROTOCOL_PUBLIC_PARAMETERS_CACHE_SIZE) {
		protocolPublicParametersCache.delete(protocolPublicParametersCache.keys().next().value!);
	}
	return derived;
}

/**
 * The secret key in the encoding the WASM import reads. A secp256k1 or P-256
 * scalar is BCS bytes, a length byte then the 32 big-endian bytes; a raw
 * 32-byte key gets the length byte. Ed25519 and Ristretto take 32 bytes as they
 * are.
 */
function importedSecretKeyEncoding(curveNumber: number, secretKey: Uint8Array): Uint8Array {
	const isEcdsaCurve = curveNumber === 0 || curveNumber === 1;
	return isEcdsaCurve && secretKey.length === 32 ? Uint8Array.of(32, ...secretKey) : secretKey;
}

/**
 * The validator's epoch, when `answer` is its refusal, before consensus, of a
 * request signed for the earlier epoch `sentEpoch`.
 */
function staleEpochRefusal(answer: TransactionResponseData, sentEpoch: bigint): bigint | undefined {
	if (answer.$kind !== 'Error') return undefined;
	// An answer whose code is another refusal is not this one. The epochs
	// come from the sentence either way: it names both.
	if (!isRefusal(answer, [RefusalCode.REQUEST_EPOCH_MISMATCH], () => true)) return undefined;
	const match = /request epoch (\d+) does not match current epoch (\d+)/.exec(
		answer.Error!.message,
	);
	if (match === null || BigInt(match[1]) !== sentEpoch) return undefined;
	const current = BigInt(match[2]);
	return current > sentEpoch ? current : undefined;
}

/** The `ABORTED` answer of a validator that dropped a request at an epoch change or a restart. */
function isDroppedRequest(error: unknown): boolean {
	return (error as { code?: number } | null)?.code === 10;
}

/** A gRPC status a validator's server restart or an epoch start gives: try again. */
function isTransportFailure(error: unknown): boolean {
	const { code } = (error ?? {}) as { code?: number };
	return code === 14 || code === 4;
}

/**
 * The network key's served outputs, read again every 2 seconds for up to 2
 * minutes while the read fails in transport: a validator answers
 * `UNAVAILABLE` while it starts an epoch. The Rust client follows the same
 * rule.
 */
async function networkKeyOutputRetried(
	client: DWalletGrpcClientBase,
	networkKeyId: Uint8Array,
): ReturnType<DWalletGrpcClientBase['getNetworkKeyOutput']> {
	const deadline = Date.now() + NETWORK_KEY_READ_WAIT_MS;
	for (;;) {
		try {
			return await client.getNetworkKeyOutput(networkKeyId);
		} catch (error) {
			if (!isTransportFailure(error) || Date.now() >= deadline) throw error;
			await new Promise((resolve) => setTimeout(resolve, NETWORK_KEY_READ_RETRY_MS));
		}
	}
}

function customOrListed(network: IkaNetwork, keys: readonly Uint8Array[]): TrustedNetworkKeys {
	return 'custom' in (network as object)
		? trustedNetworkKeys({ custom: { networkPublicKeys: keys } })
		: trustedNetworkKeys(network);
}

function signedData(
	requester: Requester,
	network: number,
	depositIncarnation: bigint,
	epoch: bigint,
	preimage: Uint8Array,
	request: any,
) {
	return {
		session_identifier_preimage: Array.from(preimage),
		epoch,
		chain_id: { [requester.chain]: null } as any,
		network,
		deposit_incarnation: depositIncarnation,
		intended_chain_sender: Array.from(requester.intendedChainSender),
		request,
	};
}

function encryptedShareInput(share: ShareEncryption, encryptedShareAndProof: Uint8Array) {
	return {
		Encrypted: {
			encrypted_centralized_secret_share_and_proof: Array.from(encryptedShareAndProof),
			encryption_key: Array.from(share.encryptionKey),
			signer_public_key: Array.from(share.holder.publicKey),
		},
	};
}

function requestAttestation(attestation: HeldAttestation) {
	return {
		attestation_data: Array.from(attestation.attestation_data),
		network_signature: Array.from(attestation.network_signature),
		network_pubkey: Array.from(attestation.network_pubkey),
		signer_noa_public_key: Array.from(attestation.signer_noa_public_key),
	};
}

function schemeName(signatureScheme: SignatureSchemeNumber): string {
	const name = SIGNATURE_SCHEMES[signatureScheme];
	if (name === undefined) {
		throw new Error(`the signature scheme ${signatureScheme} is not one the network knows`);
	}
	return name;
}

function schemeInput(signatureScheme: SignatureSchemeNumber): any {
	return { [schemeName(signatureScheme)]: null };
}

function numbered(sign: SignDuringDkg): NumberedSignDuringDkg {
	return { ...sign, signatureScheme: signatureSchemeNumber(sign.signatureScheme) };
}

/** Whether `dwallet` was made from an imported key, as its attestation records. */
export function isImported(dwallet: DWallet): boolean {
	return VersionedDWalletDataAttestationBcs.parse(
		Uint8Array.from(dwallet.attestation.attestation_data),
	).V1!.is_imported_key;
}

/** The sign-during-DKG signature a dWallet attestation holds, or `null`. */
function signedDuringDkg(attestation: HeldAttestation): Uint8Array | null {
	const signature = VersionedDWalletDataAttestationBcs.parse(
		Uint8Array.from(attestation.attestation_data),
	).V1!.sign_during_dkg_signature;
	return signature == null ? null : Uint8Array.from(signature);
}

function freshPreimage(): Uint8Array {
	return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

/** The lookup of `dwallet`'s records on the chain. */
function lookupOf(dwallet: DWallet) {
	return {
		curve: dwallet.curve,
		publicKey: Uint8Array.from(dwallet.publicKey),
		importedSessionIdentifier:
			dwallet.importedSessionIdentifier === undefined
				? undefined
				: Uint8Array.from(dwallet.importedSessionIdentifier),
	};
}

/** The fields of `dwallet`'s attestation a share attestation repeats. */
function dwalletAttested(dwallet: DWallet) {
	const attestationData = Uint8Array.from(dwallet.attestation.attestation_data);
	const data = VersionedDWalletDataAttestationBcs.parse(attestationData).V1!;
	return {
		attestationData,
		intendedChainSender: Uint8Array.from(data.intended_chain_sender),
		publicKey: Uint8Array.from(data.public_key),
	};
}

function sameBytes(first: ArrayLike<number>, second: ArrayLike<number>): boolean {
	return (
		first.length === second.length &&
		Array.from(first).every((byte, index) => byte === second[index])
	);
}

function hex(bytes: ArrayLike<number>): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
