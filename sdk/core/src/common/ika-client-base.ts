// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * What `IkaClient` does the same way on every chain: it sends the dWallet
 * requests to the network's validators and checks their answers.
 *
 * Every request is signed by the request key of the caller's
 * `UserShareEncryptionKeys` and paid for through that key's gas deposit. A
 * request that creates a dWallet names its owner, the chain address that will
 * hold it. Each chain's `IkaClient` adds the chain's reads, and its
 * `IkaTransaction` the chain transactions the app's wallet signs.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

import { AttestationRecordError } from '../grpc/attestation-record.js';
import type { DWalletGrpcClient } from '../grpc/client.js';
import {
	assertDWalletUsable,
	ATTESTATION_CURVES,
	fromCurveToNumber,
	networkKeyIdFromBytes,
	readDWalletVerified,
	readerWithCryptography,
	realCryptography,
	trustedNetworkKeys,
	useWasmWorker,
	VersionedDWalletDataAttestationBcs,
} from '../index.js';
import type {
	CommitteeChainReader,
	Curve,
	DWalletGrpcClientBase,
	DWalletLookup,
	DWalletShareReader,
	DWalletUsable,
	Hash,
	HolderEncryptionKeyEntry,
	IkaNetwork,
	NetworkKeyId,
	NetworkKeyOutputRecordReader,
	SignatureAlgorithm,
	TrustedNetworkKeys,
	UserCryptography,
	WasmWorker,
} from '../index.js';
import { isImported, Network, PresignExpiredWithTheEpoch, SIGNATURE_SCHEMES } from './engine.js';
import type {
	DWallet,
	PartialSignature,
	Presign,
	ReEncryptedShare,
	Requester,
	RequestSigner,
	SignatureSchemeName,
} from './engine.js';
import { RequestKey } from './request-key.js';
import { findSession, settledAtEpoch } from './request-records.js';
import type { PendingRequest, RequestRecordReader } from './request-records.js';
import { presignSchemeOf, signatureSchemeOf } from './schemes.js';
import { holderKeypair, requestKeypair } from './user-share-encryption-keys.js';
import type { UserShareEncryptionKeys } from './user-share-encryption-keys.js';
import { poll } from './wait.js';

/** How long a presign request waits for an empty pool, as at the start of an epoch, by default. */
const DEFAULT_POOL_WAIT_MS = 180_000;

/**
 * How long a sign waits for its voucher to be readable. An RPC endpoint can
 * serve a transaction's effects before it serves the objects the transaction
 * created.
 */
const VOUCHER_READ_WAIT_MS = 30_000;

/**
 * How many presigns a sign that takes its own presign tries before it gives
 * up. Each try after the first follows an epoch close, so two closes in a row
 * would have to fall inside one sign.
 */
const OWN_PRESIGN_ATTEMPTS = 3;

/** The schemes whose sign on an imported-key dWallet takes a presign made for that dWallet. */
const ECDSA_SCHEMES: readonly SignatureSchemeName[] = [
	'EcdsaKeccak256',
	'EcdsaSha256',
	'EcdsaDoubleSha256',
	'EcdsaBlake2b256',
];

/** What a voucher approves, as the chain holds it. */
export interface VoucherApproval {
	/** The address of the dWallet the voucher is for. */
	dwallet: Uint8Array;
	/** `keccak256(message)`. */
	messageDigest: Uint8Array;
	/** `keccak256(metadata)`, or 32 zero bytes for a scheme that takes none. */
	messageMetadataDigest: Uint8Array;
	/** The scheme, as `DWalletSignatureScheme` numbers it. */
	signatureScheme: number;
}

/** What a sign or a future sign sends, besides its dWallet, voucher and presign. */
interface SignTerms {
	message: Uint8Array;
	messageMetadata?: Uint8Array;
	signatureScheme: SignatureSchemeName;
}

/**
 * The scheme fields a sign takes. Both may be left out: the sign then uses
 * the voucher's scheme. Given, they must be the voucher's.
 */
interface SchemeParams {
	hashScheme?: Hash;
	signatureAlgorithm?: SignatureAlgorithm;
}

/** A sign carried by the request that creates a dWallet. */
export interface SignDuringDKGRequest {
	/** A global presign of this epoch, for `signatureAlgorithm`. */
	presign: Presign;
	message: Uint8Array;
	hashScheme: Hash;
	signatureAlgorithm: SignatureAlgorithm;
	/** The scheme's metadata; omit it for a scheme that takes none. */
	messageMetadata?: Uint8Array;
}

/** What a request that creates a dWallet returns. */
export interface CreatedDWallet {
	dWallet: DWallet;
	/** The signature of `signDuringDKGRequest`, verified; absent without one. */
	signature?: Uint8Array;
}

/**
 * A validator's gRPC endpoint: its URL, and `insecure: true` for a localnet
 * node that serves plaintext. In Node the URL is `host:port`, and in a
 * browser the `https://` URL of the validator's gRPC-Web listener.
 */
export type GrpcEndpoint = string | { url: string; insecure?: boolean };

export interface IkaClientBaseOptions {
	/**
	 * The connection to the validators: a validator's endpoint, or a
	 * `DWalletGrpcClient` the app made itself, for example with further
	 * validators. From an endpoint the client makes a `DWalletGrpcClient`:
	 * in Node one whose TLS is pinned to the network key of a member of the
	 * committee the network signed, checked against the chain this client
	 * reads, and in a browser one that speaks gRPC-Web.
	 */
	grpc: DWalletGrpcClientBase | GrpcEndpoint;
	/** The ika network: `'mainnet'`, `'testnet'`, or a custom network with its trusted keys. */
	network: IkaNetwork;
	/** How long a presign request waits while the pool is empty. Defaults to 3 minutes. */
	presignPoolWaitMs?: number;
	/**
	 * Who signs every request and pays for it through its gas deposit. By
	 * default, the request key of the user's `UserShareEncryptionKeys`, whose
	 * deposit the user or the app funds. Pass the app's signer (a
	 * `RequestKey`, or a client of the app's backend that holds one) for the
	 * app to pay for all its users from one deposit; the vouchers its users
	 * issue then name the app's key.
	 */
	requestSigner?: RequestSigner;
	/**
	 * Run the SDK's slow computations in a worker, so that they do not freeze
	 * a browser page: `true` for the SDK's own worker, or a worker you made
	 * from `@ika.xyz/sdk-core/wasm-worker`. The setting is for the whole page
	 * or process, as `useWasmWorker`, which it calls, and it takes effect from
	 * this constructor on. Keys derived before it was set were computed on the
	 * calling thread: call `useWasmWorker()` at startup to move those too.
	 */
	computeInWorker?: boolean | WasmWorker;
	/**
	 * The user's half of each protocol step. Leave it out for the 2PC-MPC
	 * protocol ({@link realCryptography}), which refuses every mock value.
	 *
	 * For a mock ika network, one backend that holds an ordinary key for each
	 * dWallet as the Solana devnet pre-alpha runs,
	 * create the client with `withMockCryptography` from
	 * `@ika.xyz/sdk-core/mock`. The client then skips its 2PC-MPC
	 * computations, and keeps every other check.
	 *
	 * NOT SECURE. The backend holds the whole key of every dWallet, so it can
	 * sign anything with it. Use it only with funds you can lose.
	 *
	 * No private key is sent to the backend: it makes every dWallet's key
	 * itself. An import does not read the key it is given, and the imported
	 * dWallet holds a new key of the backend's, with another public key and
	 * address than the imported key's.
	 *
	 * The mock is allowed only with a custom network. The network must serve
	 * the mock network key, and a client without the mock refuses a network
	 * that does. Only this client runs the mock: other clients in the same
	 * process still refuse mock values.
	 */
	cryptography?: UserCryptography;
}

export abstract class IkaClientBase<Address, VoucherId> {
	readonly network: IkaNetwork;
	readonly #grpcOption: DWalletGrpcClientBase | GrpcEndpoint;
	#grpc: DWalletGrpcClientBase | undefined;
	readonly #poolWaitMs: number;
	readonly #requestSigner: RequestSigner | undefined;
	readonly #engines = new Map<string, Promise<Network>>();
	/** The client's cryptography ({@link IkaClientBaseOptions.cryptography}). */
	protected readonly cryptography: UserCryptography;

	/**
	 * `grpcClient` is the class that makes the connection from an endpoint:
	 * `DWalletGrpcClient` from `@ika.xyz/sdk-core/auto`, which a chain's
	 * package imports, so that a browser bundle gets the gRPC-Web client and
	 * Node the Node client.
	 */
	protected constructor(
		options: IkaClientBaseOptions,
		private readonly chain: Requester['chain'],
		private readonly grpcClient: GrpcClientClass,
	) {
		this.#grpcOption = options.grpc;
		this.network = options.network;
		if (options.computeInWorker) {
			useWasmWorker(options.computeInWorker === true ? undefined : options.computeInWorker);
		}
		this.#poolWaitMs = options.presignPoolWaitMs ?? DEFAULT_POOL_WAIT_MS;
		this.#requestSigner = options.requestSigner;
		this.cryptography = options.cryptography ?? realCryptography;
		if (this.cryptography.mock && !('custom' in (options.network as object))) {
			throw new Error(
				'mock mode is allowed only with a custom network, never on mainnet or testnet',
			);
		}
	}

	/**
	 * The connection to the validators. Made from the endpoint on first use,
	 * because the chain's reader it needs is set up after this class's
	 * constructor.
	 */
	get grpc(): DWalletGrpcClientBase {
		this.#grpc ??= grpcClientOf(this.grpcClient, this.#grpcOption, () => this.committeeReader());
		return this.#grpc;
	}

	/** The chain's records of the network keys' outputs. */
	protected abstract networkKeyRecords(): NetworkKeyOutputRecordReader;

	/** The chain's reader of its epoch and network keys, which the committee is checked against. */
	protected abstract committeeReader(): CommitteeChainReader;

	/**
	 * The epoch the chain's dWallet coordinator records, which every request
	 * names. The network moves it only once it has entered the new epoch,
	 * after every session of the old one is settled on the chain.
	 */
	protected abstract chainEpoch(): Promise<bigint>;

	/**
	 * The chain's reads that find a request's session once its epoch closed
	 * before an answer: its charge records and its vouchers.
	 */
	protected abstract requestRecords(): RequestRecordReader;

	/** The chain's reader of a dWallet's records, for the ownership check. */
	protected abstract shareReader(trustedNetworkKeys: TrustedNetworkKeys): DWalletShareReader;

	/** The chain's share reader, under this client's cryptography. */
	#shareReader(trustedNetworkKeys: TrustedNetworkKeys): DWalletShareReader {
		return readerWithCryptography(this.shareReader(trustedNetworkKeys), this.cryptography);
	}

	/** The bytes of `address`, a chain address, as the network records it. */
	protected abstract addressBytes(address: Address): Uint8Array;

	/** The bytes a request names a voucher by: its object id, or its account's address. */
	protected abstract voucherBytes(voucher: VoucherId): Uint8Array;

	/** What the voucher approves, or `null` while the chain holds no voucher there. */
	protected abstract readVoucherApproval(voucher: VoucherId): Promise<VoucherApproval | null>;

	/** The bytes of `dWallet`'s address on the chain, as a voucher names it. */
	protected abstract dWalletAddressBytes(dWallet: DWallet): Uint8Array;

	/**
	 * Connect to the network under its latest network key, and check the key
	 * against the chain's records. Every request does this when it needs to,
	 * so calling it only moves that wait earlier.
	 */
	async initialize(curve: Curve): Promise<void> {
		await this.engine(curve);
	}

	/** The epoch's latest network key, as the validators name it. */
	async getLatestNetworkEncryptionKeyId(): Promise<NetworkKeyId> {
		return networkKeyIdFromBytes(await this.grpc.latestNetworkKeyId());
	}

	/**
	 * The connection for `curve` under `networkKeyId`, or under the latest
	 * network key; made once per curve and key, and checked against the
	 * chain's records. A request named by the latest key and one named by
	 * that key's id share one connection: a connection keeps the epoch it
	 * last saw, so two for one key would disagree about it after an epoch
	 * change.
	 */
	protected async engine(curve: Curve, networkKeyId?: Uint8Array): Promise<Network> {
		const id = networkKeyId ?? (await this.#latestNetworkKeyId());
		const key = `${curve}:${hex(id)}`;
		let engine = this.#engines.get(key);
		if (engine === undefined) {
			engine = this.#connect(curve, id);
			engine.catch(() => this.#engines.delete(key));
			this.#engines.set(key, engine);
		}
		return engine;
	}

	/** The latest network key, as the validators first named it to this client. */
	#latestNetworkKeyId(): Promise<Uint8Array> {
		this.#latestKey ??= this.grpc.latestNetworkKeyId().catch((error) => {
			this.#latestKey = undefined;
			throw error;
		});
		return this.#latestKey;
	}

	#latestKey: Promise<Uint8Array> | undefined;

	async #connect(curve: Curve, networkKeyId: Uint8Array): Promise<Network> {
		const records = this.networkKeyRecords();
		if (!(await records.isRegisteredNetworkKey(networkKeyId))) {
			throw new Error(`the ${this.chain} records hold no network key ${hex(networkKeyId)}`);
		}
		return Network.connect({
			client: this.grpc,
			curve,
			networkKeyId,
			network: this.network,
			records,
			chainEpoch: () => this.chainEpoch(),
			requestRecords: this.requestRecords(),
			shares: (trusted) => this.#shareReader(trusted),
			cryptography: this.cryptography,
		});
	}

	/**
	 * The connection a request on `dWallet` goes through: the keys' curve,
	 * which must be the dWallet's, under the dWallet's own network key.
	 */
	protected engineOf(dWallet: DWallet, keys: UserShareEncryptionKeys): Promise<Network> {
		if (fromCurveToNumber(keys.curve) !== dWallet.curve) {
			throw new Error(
				`the keys are for ${keys.curve}, and the dWallet is on another curve: derive the keys for the dWallet's curve`,
			);
		}
		return this.engine(keys.curve, dWallet.networkKeyId);
	}

	/**
	 * Who signs a request and what it names: the client's request signer, or
	 * else the keys' request key; and `owner`.
	 */
	protected requester(keys: UserShareEncryptionKeys, owner: Address | undefined): Requester {
		const signer = this.#requestSigner;
		return {
			keypair:
				signer === undefined
					? requestKeypair(keys)
					: { publicKey: Uint8Array.from(signer.publicKey), secretKey: new Uint8Array(0) },
			signer,
			chain: this.chain,
			intendedChainSender: owner === undefined ? new Uint8Array(32) : this.addressBytes(owner),
		};
	}

	/**
	 * The key that signs this client's requests for `keys`: the client's
	 * request signer, or else the keys' request key. A voucher names it as the
	 * key allowed to sign with it, and its gas deposit pays.
	 */
	getRequestPublicKey(keys: UserShareEncryptionKeys): Uint8Array {
		return Uint8Array.from(this.#requestSigner?.publicKey ?? requestKeypair(keys).publicKey);
	}

	/** The message a request key signs to consent to a gas deposit owned by `depositOwner`. */
	protected abstract gasDepositConsentMessage(depositOwner: Address): Uint8Array;

	/**
	 * The request key's consent to a gas deposit owned by `depositOwner`: the
	 * signature a deposit's creation carries. A user's device signs it with
	 * the keys' request key, and the app, as `depositOwner`, creates and funds
	 * the deposit with it (`IkaTransaction.createGasDeposit`), so the user
	 * never holds IKA. The app's own `RequestKey` signs it the same way.
	 */
	signGasDepositConsent(params: {
		requestKey: UserShareEncryptionKeys | RequestKey;
		depositOwner: Address;
	}): { requestPublicKey: Uint8Array; consent: Uint8Array } {
		const message = this.gasDepositConsentMessage(params.depositOwner);
		if (params.requestKey instanceof RequestKey) {
			return {
				requestPublicKey: params.requestKey.publicKey,
				consent: params.requestKey.sign(message),
			};
		}
		const keypair = requestKeypair(params.requestKey);
		return {
			requestPublicKey: Uint8Array.from(keypair.publicKey),
			consent: ed25519.sign(message, keypair.secretKey),
		};
	}

	/**
	 * Check on the chain that the keys' holder holds `dWallet`'s share, or
	 * that the share is public. A sign, a future sign, a make-public and a
	 * re-encryption each run it first, and `IkaTransaction.approveMessage`
	 * issues a voucher only for a dWallet it passed.
	 */
	async checkDWalletUsable(
		dWallet: DWallet,
		userShareEncryptionKeys: UserShareEncryptionKeys,
	): Promise<DWalletUsable> {
		const engine = await this.engineOf(dWallet, userShareEncryptionKeys);
		return assertDWalletUsable(
			this.#shareReader(engine.trustedNetworkKeys),
			{ getSigningPublicKeyBytes: () => holderKeypair(userShareEncryptionKeys).publicKey },
			dWallet.attestation,
		);
	}

	/**
	 * Read the dWallet at `dWalletId` on the chain, checked for the keys'
	 * holder: its public key, its public output, its attestation, and whether
	 * the share is the holder's encrypted share or public. A user who kept
	 * nothing about a dWallet, for example on a new device, takes its values
	 * only from here.
	 */
	async getDWallet(
		dWalletId: Address,
		userShareEncryptionKeys: UserShareEncryptionKeys,
	): Promise<DWalletUsable> {
		const engine = await this.engine(userShareEncryptionKeys.curve);
		return readDWalletVerified(
			this.#shareReader(engine.trustedNetworkKeys),
			{ getSigningPublicKeyBytes: () => holderKeypair(userShareEncryptionKeys).publicKey },
			{ address: this.addressBytes(dWalletId) },
		);
	}

	// ── Creating a dWallet ─────────────────────────────────────────────────

	/** Wait until the chain holds `dWallet`'s share, when the share waits for its acceptance. */
	async #waitForEncryptedShare(engine: Network, dWallet: DWallet): Promise<void> {
		if (dWallet.share.kind !== 'encrypted' || dWallet.acceptance === undefined) return;
		await waitForEncryptedShareRecord(this.#shareReader(engine.trustedNetworkKeys), {
			curve: dWallet.curve,
			publicKey: dWallet.publicKey,
			importedSessionIdentifier: dWallet.importedSessionIdentifier,
			holder: dWallet.share.holder,
		});
	}

	/**
	 * Create a zero-trust dWallet owned by `owner`, with its user share
	 * encrypted to the keys' encryption key, which must be registered on the
	 * chain first (`IkaTransaction.registerEncryptionKey`). With
	 * `signDuringDKGRequest`, one message is signed with the new dWallet as
	 * well.
	 *
	 * This returns once the network has written the dWallet and its share to
	 * the chain. The share then waits for its holder's acceptance, which this
	 * call signed after checking the network's answer (`dWallet.acceptance`).
	 * The chain refuses every use of the dWallet until the acceptance is sent
	 * (`IkaTransaction.acceptEncryptedUserShare`).
	 */
	async requestDWalletDKG(params: {
		curve: Curve;
		userShareEncryptionKeys: UserShareEncryptionKeys;
		owner: Address;
		signDuringDKGRequest?: SignDuringDKGRequest;
	}): Promise<CreatedDWallet> {
		const { curve, userShareEncryptionKeys: keys } = params;
		const engine = await this.engine(curve);
		const requester = this.requester(keys, params.owner);
		const share = { holder: holderKeypair(keys), encryptionKey: keys.encryptionKey };
		if (params.signDuringDKGRequest === undefined) {
			const dWallet = await engine.createDWallet(requester, share);
			await this.#waitForEncryptedShare(engine, dWallet);
			return { dWallet };
		}
		const { dwallet, signature } = await engine.createDWalletAndSign(
			requester,
			share,
			signDuringDkg(curve, params.signDuringDKGRequest),
		);
		await this.#waitForEncryptedShare(engine, dwallet);
		return { dWallet: dwallet, signature };
	}

	/**
	 * Create a dWallet whose user share is public from the start. The network
	 * can then sign with a voucher alone, so the dWallet is trust-minimized,
	 * not zero-trust.
	 */
	async requestDWalletDKGWithPublicUserShare(params: {
		curve: Curve;
		userShareEncryptionKeys: UserShareEncryptionKeys;
		owner: Address;
		signDuringDKGRequest?: SignDuringDKGRequest;
	}): Promise<CreatedDWallet> {
		const { curve } = params;
		const engine = await this.engine(curve);
		const requester = this.requester(params.userShareEncryptionKeys, params.owner);
		if (params.signDuringDKGRequest === undefined) {
			return { dWallet: await engine.createDWalletWithPublicShare(requester) };
		}
		const { dwallet, signature } = await engine.createDWalletWithPublicShareAndSign(
			requester,
			signDuringDkg(curve, params.signDuringDKGRequest),
		);
		return { dWallet: dwallet, signature };
	}

	/**
	 * Create a dWallet from a key the user already holds: `secretKey`, as its
	 * curve's libraries hold it. Its user share is encrypted to the keys'
	 * encryption key. The secret key is used only to make the user's share,
	 * and is never sent. As with {@link requestDWalletDKG}, send
	 * `dWallet.acceptance` before the dWallet can be used.
	 */
	async requestImportedKeyDWalletVerification(params: {
		curve: Curve;
		secretKey: Uint8Array;
		userShareEncryptionKeys: UserShareEncryptionKeys;
		owner: Address;
	}): Promise<DWallet> {
		const { curve, userShareEncryptionKeys: keys } = params;
		const engine = await this.engine(curve);
		const dWallet = await engine.verifyImportedKey(
			this.requester(keys, params.owner),
			{ holder: holderKeypair(keys), encryptionKey: keys.encryptionKey },
			params.secretKey,
		);
		await this.#waitForEncryptedShare(engine, dWallet);
		return dWallet;
	}

	// ── Presigns ───────────────────────────────────────────────────────────

	/**
	 * Take a presign from the network's pool for `signatureAlgorithm`, served
	 * to the keys' request key only. A presign expires with its epoch: take it
	 * close to the sign that uses it. While the pool is empty, as at the start
	 * of an epoch, it asks again until the client's pool wait ends.
	 */
	async requestGlobalPresign(params: {
		curve: Curve;
		signatureAlgorithm: SignatureAlgorithm;
		userShareEncryptionKeys: UserShareEncryptionKeys;
	}): Promise<Presign> {
		const engine = await this.engine(params.curve);
		return engine.requestPresign(
			this.requester(params.userShareEncryptionKeys, undefined),
			presignSchemeOf(params.curve, params.signatureAlgorithm),
			{ poolWaitMs: this.#poolWaitMs },
		);
	}

	/** As `requestGlobalPresign`, `count` presigns at once, in about the time of one. */
	async requestGlobalPresigns(params: {
		curve: Curve;
		signatureAlgorithm: SignatureAlgorithm;
		userShareEncryptionKeys: UserShareEncryptionKeys;
		count: number;
	}): Promise<Presign[]> {
		const engine = await this.engine(params.curve);
		return engine.requestPresigns(
			this.requester(params.userShareEncryptionKeys, undefined),
			presignSchemeOf(params.curve, params.signatureAlgorithm),
			params.count,
			{ poolWaitMs: this.#poolWaitMs },
		);
	}

	/**
	 * Take a presign made for one dWallet. Only an imported-key dWallet's
	 * ECDSA signs need one; every other sign takes a global presign.
	 */
	async requestPresign(params: {
		dWallet: DWallet;
		signatureAlgorithm: SignatureAlgorithm;
		userShareEncryptionKeys: UserShareEncryptionKeys;
	}): Promise<Presign> {
		const { dWallet, userShareEncryptionKeys: keys } = params;
		const engine = await this.engineOf(dWallet, keys);
		return engine.requestPresignForDWallet(
			this.requester(keys, undefined),
			dWallet,
			presignSchemeOf(keys.curve, params.signatureAlgorithm),
		);
	}

	// ── Signing ────────────────────────────────────────────────────────────

	/**
	 * Sign `message` with `dWallet`, under the signature voucher the owner
	 * issued for it (`IkaTransaction.approveMessage`). The keys' holder must
	 * hold the share, which is checked on the chain first. Returns the
	 * signature once it verifies under the dWallet's public key.
	 *
	 * The voucher is read first, and the sign throws before it computes
	 * anything when the voucher is for another dWallet, message or scheme.
	 * `signatureAlgorithm` and `hashScheme` may be left out: the sign then
	 * uses the voucher's scheme.
	 *
	 * Without `presign`, the sign takes its own presign. When the chain moves
	 * past that presign's epoch before the sign is sent, it takes a new
	 * presign and signs with the same voucher. With `presign`, a sign whose
	 * presign's epoch the chain is past throws `PresignExpiredWithTheEpoch`:
	 * nothing was sent, so take a new presign and sign again. A sign whose
	 * epoch closes before the network answers throws `EpochClosedBeforeAnswer`,
	 * and is not sent again.
	 */
	async requestSign(
		params: {
			dWallet: DWallet;
			presign?: Presign;
			signatureVoucherId: VoucherId;
			message: Uint8Array;
			userShareEncryptionKeys: UserShareEncryptionKeys;
			messageMetadata?: Uint8Array;
		} & SchemeParams,
	): Promise<Uint8Array> {
		const { dWallet, userShareEncryptionKeys: keys } = params;
		const engine = await this.engineOf(dWallet, keys);
		const terms = await this.#signTerms(params.signatureVoucherId, params);
		const usable = await this.checkDWalletUsable(dWallet, keys);
		return this.#withPresign(engine, dWallet, keys, terms, params.presign, (presign) =>
			engine.requestSignature(this.requester(keys, undefined), {
				dwallet: dWallet,
				usable,
				presign,
				...terms,
				signatureVoucher: this.voucherBytes(params.signatureVoucherId),
			}),
		);
	}

	/**
	 * Step 1 of a future sign: the user's half of the signature now, written
	 * into the future signature voucher the owner issued
	 * (`IkaTransaction.approveFutureSign`). Finish it with `futureSign`, in
	 * this epoch or a later one; that step takes no presign.
	 *
	 * The voucher, the scheme and the presign are handled as in `requestSign`.
	 */
	async requestFutureSign(
		params: {
			dWallet: DWallet;
			presign?: Presign;
			futureSignatureVoucherId: VoucherId;
			message: Uint8Array;
			userShareEncryptionKeys: UserShareEncryptionKeys;
			messageMetadata?: Uint8Array;
		} & SchemeParams,
	): Promise<PartialSignature> {
		const { dWallet, userShareEncryptionKeys: keys } = params;
		const engine = await this.engineOf(dWallet, keys);
		const terms = await this.#signTerms(params.futureSignatureVoucherId, params);
		const usable = await this.checkDWalletUsable(dWallet, keys);
		return this.#withPresign(engine, dWallet, keys, terms, params.presign, (presign) =>
			engine.requestFutureSignature(this.requester(keys, undefined), {
				dwallet: dWallet,
				usable,
				presign,
				...terms,
				futureSignatureVoucher: this.voucherBytes(params.futureSignatureVoucherId),
			}),
		);
	}

	/**
	 * Read the voucher, and return what a sign under it sends: the caller's
	 * message, and the voucher's scheme. Throws when the voucher is for
	 * another dWallet, message, metadata or scheme than the caller's, so that
	 * nothing is computed for a request the network would refuse.
	 */
	async #signTerms(
		voucher: VoucherId,
		params: {
			dWallet: DWallet;
			message: Uint8Array;
			messageMetadata?: Uint8Array;
			userShareEncryptionKeys: UserShareEncryptionKeys;
		} & SchemeParams,
	): Promise<SignTerms> {
		const { hashScheme, signatureAlgorithm } = params;
		if ((hashScheme === undefined) !== (signatureAlgorithm === undefined)) {
			throw new Error(
				"pass both signatureAlgorithm and hashScheme, or neither to use the voucher's scheme",
			);
		}
		const name = String(voucher);
		const approval = await poll(() => this.readVoucherApproval(voucher), `the voucher ${name}`, {
			timeout: VOUCHER_READ_WAIT_MS,
		}).catch(() => {
			throw new Error(
				`the chain holds no voucher at ${name}: issue it (IkaTransaction.approveMessage) and send that transaction before the sign`,
			);
		});
		if (!sameBytes(approval.dwallet, this.dWalletAddressBytes(params.dWallet))) {
			throw new Error(`the voucher ${name} is for another dWallet than this one`);
		}
		const metadata = params.messageMetadata ?? new Uint8Array(0);
		if (!sameBytes(approval.messageDigest, keccak_256(params.message))) {
			throw new Error(`the voucher ${name} approves another message than this one`);
		}
		const metadataDigest = metadata.length === 0 ? new Uint8Array(32) : keccak_256(metadata);
		if (!sameBytes(approval.messageMetadataDigest, metadataDigest)) {
			throw new Error(`the voucher ${name} approves other message metadata than this sign's`);
		}
		const voucherScheme = SIGNATURE_SCHEMES[approval.signatureScheme];
		if (voucherScheme === undefined) {
			throw new Error(
				`the voucher ${name} names signature scheme ${approval.signatureScheme}, which this SDK does not know`,
			);
		}
		if (hashScheme !== undefined && signatureAlgorithm !== undefined) {
			const asked = signatureSchemeOf(
				params.userShareEncryptionKeys.curve,
				signatureAlgorithm,
				hashScheme,
			);
			if (asked !== voucherScheme) {
				throw new Error(
					`the voucher ${name} approves the scheme ${voucherScheme}, and this sign asks for ${asked}`,
				);
			}
		}
		return {
			message: params.message,
			messageMetadata: params.messageMetadata,
			signatureScheme: voucherScheme,
		};
	}

	/**
	 * Run `step` with `presign`, or else with a presign this call takes. A
	 * presign this call took is replaced when it expires before the sign is
	 * sent, up to
	 * `OWN_PRESIGN_ATTEMPTS` times. An imported-key dWallet's ECDSA sign
	 * takes a presign made for the dWallet, and every other sign a pool
	 * presign.
	 */
	async #withPresign<T>(
		engine: Network,
		dWallet: DWallet,
		keys: UserShareEncryptionKeys,
		terms: SignTerms,
		presign: Presign | undefined,
		step: (presign: Presign) => Promise<T>,
	): Promise<T> {
		if (presign !== undefined) {
			return step(presign);
		}
		const requester = this.requester(keys, undefined);
		const takePresign = () =>
			isImported(dWallet) && ECDSA_SCHEMES.includes(terms.signatureScheme)
				? engine.requestPresignForDWallet(requester, dWallet, terms.signatureScheme)
				: engine.requestPresign(requester, terms.signatureScheme, { poolWaitMs: this.#poolWaitMs });
		for (let attempt = 1; ; attempt++) {
			try {
				return await step(await takePresign());
			} catch (error) {
				if (!(error instanceof PresignExpiredWithTheEpoch) || attempt >= OWN_PRESIGN_ATTEMPTS) {
					throw error;
				}
			}
		}
	}

	/**
	 * Finish a future sign. Step 1's commit clears the voucher's signing key,
	 * so the owner sets it again first
	 * (`IkaTransaction.setFutureSignatureVoucherSigningKey`), after the
	 * voucher shows step 1's partial signature.
	 */
	async futureSign(params: {
		dWallet: DWallet;
		partialUserSignature: PartialSignature;
		userShareEncryptionKeys: UserShareEncryptionKeys;
	}): Promise<Uint8Array> {
		const engine = await this.engineOf(params.dWallet, params.userShareEncryptionKeys);
		return engine.completeFutureSignature(
			this.requester(params.userShareEncryptionKeys, undefined),
			params.partialUserSignature,
		);
	}

	// ── The user share ─────────────────────────────────────────────────────

	/**
	 * Make `dWallet`'s user share public. From then on the network can sign
	 * with a voucher alone: the dWallet is no longer zero-trust.
	 */
	async makeDWalletUserSecretKeySharesPublic(params: {
		dWallet: DWallet;
		userShareEncryptionKeys: UserShareEncryptionKeys;
	}): Promise<DWallet> {
		const { dWallet, userShareEncryptionKeys: keys } = params;
		const engine = await this.engineOf(dWallet, keys);
		const { dwallet } = await engine.makeSharePublic(
			this.requester(keys, undefined),
			dWallet,
			await this.checkDWalletUsable(dWallet, keys),
		);
		return dwallet;
	}

	/** Read `holderSignerPublicKey`'s encryption key entry for `curve`, checked. */
	protected abstract readEncryptionKeyEntry(
		holderSignerPublicKey: Uint8Array,
		curve: Curve,
	): Promise<HolderEncryptionKeyEntry>;

	/**
	 * Re-encrypt `dWallet`'s user share to another holder, whose encryption
	 * key is registered on the chain under `destinationSignerPublicKey`. Give
	 * the result to that holder, who checks it with
	 * `receiveEncryptedUserShare`.
	 */
	async requestReEncryptUserShareFor(params: {
		dWallet: DWallet;
		destinationSignerPublicKey: Uint8Array;
		userShareEncryptionKeys: UserShareEncryptionKeys;
	}): Promise<ReEncryptedShare> {
		const { dWallet, userShareEncryptionKeys: keys } = params;
		const engine = await this.engineOf(dWallet, keys);
		return engine.reEncryptShare(this.requester(keys, undefined), {
			dwallet: dWallet,
			usable: await this.checkDWalletUsable(dWallet, keys),
			newHolderSignerPublicKey: params.destinationSignerPublicKey,
			newHolderEntry: await this.readEncryptionKeyEntry(
				params.destinationSignerPublicKey,
				keys.curve,
			),
		});
	}

	/**
	 * What became of a request whose epoch closed before the network
	 * answered it: `pending` is `EpochClosedBeforeAnswer.pending`, as the app
	 * kept it. Call this any time later; epochs last about a day.
	 *
	 * It reads only the chain. While the chain has not reached the epoch at
	 * which every session of the request's epoch is settled
	 * (`settledAtEpoch`), the answer is `waiting`. Then it looks for the
	 * request's session (`findSession`):
	 * - `ran`: the chain holds `record` for it. Do not send it again. A sign's
	 *   signature is in its voucher: read it with the voucher's verified read.
	 * - `neverRan`: nothing on the chain names it. It never ran and was never
	 *   charged, so it is safe to send again, as a new request.
	 * - `unknown`: what a DKG, an imported-key verification, or a step 1 the
	 *   network closed leaves cannot be found from the session yet.
	 */
	async resolveSession(pending: PendingRequest): Promise<SessionResolution> {
		const chainEpoch = await this.chainEpoch();
		const settledAt = settledAtEpoch(pending);
		if (chainEpoch < settledAt) {
			return { status: 'waiting', chainEpoch, settledAt };
		}
		const trusted =
			'custom' in (this.network as object)
				? trustedNetworkKeys({ custom: { networkPublicKeys: [pending.networkKeyId] } })
				: trustedNetworkKeys(this.network);
		const outcome = await findSession(pending, this.requestRecords(), this.#shareReader(trusted));
		switch (outcome.kind) {
			case 'notRun':
				return { status: 'neverRan' };
			case 'ran':
				return { status: 'ran', record: outcome.record };
			case 'signature':
				return { status: 'ran', record: 'a signature in the voucher' };
			default:
				return { status: 'unknown' };
		}
	}

	/**
	 * Check a share re-encrypted to the keys' holder, once the network has
	 * written it to the chain, and sign its acceptance.
	 * `sourceSignerPublicKey` is the sender's holder key: get it from the
	 * sender, not from the network. Returns the dWallet with its share
	 * decrypted. The share is the holder's once the acceptance is sent
	 * (`IkaTransaction.acceptEncryptedUserShare`).
	 */
	async receiveEncryptedUserShare(params: {
		reEncryptedShare: ReEncryptedShare;
		sourceSignerPublicKey: Uint8Array;
		userShareEncryptionKeys: UserShareEncryptionKeys;
	}): Promise<DWallet> {
		const { userShareEncryptionKeys: keys, reEncryptedShare } = params;
		const engine = await this.engine(
			keys.curve,
			Uint8Array.from(reEncryptedShare.dwalletAttestation.network_pubkey),
		);
		const reader = this.#shareReader(engine.trustedNetworkKeys);
		const attested = VersionedDWalletDataAttestationBcs.parse(
			Uint8Array.from(reEncryptedShare.dwalletAttestation.attestation_data),
		).V1!;
		await waitForEncryptedShareRecord(reader, {
			curve: ATTESTATION_CURVES.indexOf(attested.curve.$kind),
			publicKey: Uint8Array.from(attested.public_key),
			importedSessionIdentifier: attested.is_imported_key
				? Uint8Array.from(attested.session_identifier)
				: undefined,
			holder: holderKeypair(keys).publicKey,
		});
		return engine.acceptReEncryptedShare({
			reader,
			holder: holderKeypair(keys),
			encryptionKey: keys.encryptionKey,
			decryptionKey: keys.decryptionKey,
			senderSignerPublicKey: params.sourceSignerPublicKey,
			received: params.reEncryptedShare,
		});
	}
}

/** What `resolveSession` found for a pending request. */
export type SessionResolution =
	/** The chain has not reached `settledAt` yet: ask again later. */
	| { status: 'waiting'; chainEpoch: bigint; settledAt: bigint }
	/** The request ran: the chain holds `record` for it. */
	| { status: 'ran'; record: string }
	/** The request never ran, and may be sent again as a new request. */
	| { status: 'neverRan' }
	/** The chain cannot tell yet, for this kind of request. */
	| { status: 'unknown' };

/** How long a new share is waited for on the chain, after the network answered. */
const SHARE_RECORD_WAIT_MS = 300_000;
const SHARE_RECORD_POLL_MS = 2_000;

/**
 * The stored fields a share's record check refuses while the share waits for
 * its holder's acceptance: on Solana the share is not marked accepted, and on
 * Sui it stores no acceptance signature yet. Each chain's check compares these
 * last, after every other field of the share.
 */
const UNACCEPTED_SHARE_FIELDS = ['accepted', 'acceptance_signature'];

/**
 * Wait until the chain holds the encrypted share of `holder` for the dWallet
 * `lookup` names. The network writes it at the end of the session that
 * answered, a little after the answer. The share is not accepted yet, so the
 * record check refuses it only on its acceptance: that refusal means the share
 * is there, and every other field of it checked.
 */
async function waitForEncryptedShareRecord(
	reader: DWalletShareReader,
	lookup: DWalletLookup & { holder: Uint8Array },
): Promise<void> {
	const deadline = Date.now() + SHARE_RECORD_WAIT_MS;
	for (;;) {
		const record = await reader.readDWallet(lookup);
		if (record !== undefined && (await shareIsOnChain(record, lookup.holder))) {
			return;
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`the network answered, and the chain still holds no share of the dWallet ${hex(lookup.publicKey)} for its holder after ${SHARE_RECORD_WAIT_MS} ms`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, SHARE_RECORD_POLL_MS));
	}
}

/**
 * Whether `record` holds `holder`'s share, accepted or waiting for its
 * acceptance. Exported for its unit test; the package entry does not export it.
 */
export async function shareIsOnChain(
	record: NonNullable<Awaited<ReturnType<DWalletShareReader['readDWallet']>>>,
	holder: Uint8Array,
): Promise<boolean> {
	try {
		return (await record.readEncryptedShare(holder)) !== undefined;
	} catch (error) {
		if (
			error instanceof AttestationRecordError &&
			error.check === 'record' &&
			error.field !== undefined &&
			UNACCEPTED_SHARE_FIELDS.includes(error.field)
		) {
			return true;
		}
		throw error;
	}
}

function signDuringDkg(curve: Curve, sign: SignDuringDKGRequest) {
	return {
		presign: sign.presign,
		message: sign.message,
		messageMetadata: sign.messageMetadata,
		signatureScheme: signatureSchemeOf(curve, sign.signatureAlgorithm, sign.hashScheme),
	};
}

/** Whether this runs in Node, where the client can pin TLS to the committee. */
const IN_NODE =
	typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node ===
	'string';

/** The `DWalletGrpcClient` class of `@ika.xyz/sdk-core/auto`. */
export type GrpcClientClass = typeof DWalletGrpcClient;

/**
 * `grpc` as a client: itself when it is one, or else a `GrpcClient` for the
 * endpoint. `@ika.xyz/sdk-core/auto` is the Node client in Node and the
 * gRPC-Web client in a browser bundle. Only the Node client takes the
 * committee reader.
 */
function grpcClientOf(
	GrpcClient: GrpcClientClass,
	grpc: DWalletGrpcClientBase | GrpcEndpoint,
	committeeReader: () => CommitteeChainReader,
): DWalletGrpcClientBase {
	if (typeof grpc !== 'string' && !isEndpoint(grpc)) {
		return grpc;
	}
	const { url, insecure } = typeof grpc === 'string' ? { url: grpc, insecure: undefined } : grpc;
	return new GrpcClient(url, undefined, [], {
		insecure,
		committeeReader: IN_NODE ? committeeReader() : undefined,
	});
}

function isEndpoint(grpc: object): grpc is { url: string; insecure?: boolean } {
	return typeof (grpc as { url?: unknown }).url === 'string';
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
