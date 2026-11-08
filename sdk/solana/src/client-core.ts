// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * What `IkaClient` does on Solana whichever library names its addresses:
 * the network's requests (from `IkaClientBase`) and the reads of the ika
 * program's accounts. `IkaClient` of `@ika.xyz/pre-alpha-solana/web3` names an
 * address by a `@solana/web3.js` `PublicKey`, and that of
 * `@ika.xyz/pre-alpha-solana/kit` by a `@solana/kit` `Address`.
 *
 * Reads that a network signature covers are checked against it. The other
 * reads go through `getAccount`: pass `crossCheck` with a second endpoint,
 * run by another provider, to have each one checked against it.
 */
import {
	deployedNetworkValue,
	deployedSolanaChainNumber,
	fromCurveToNumber,
	fromNumberToCurve,
	verifySignatureWithScheme,
} from '@ika.xyz/pre-alpha-core';
import type {
	CommitteeChainReader,
	Curve,
	DWalletShareReader,
	Hash,
	HolderEncryptionKeyEntry,
	IkaNetwork,
	NetworkKeyOutputRecordReader,
	SignatureAlgorithm,
	TrustedNetworkKeys,
} from '@ika.xyz/pre-alpha-core';
import { DWalletGrpcClient } from '@ika.xyz/pre-alpha-core/auto';
import type {
	DWallet,
	IkaClientBaseOptions,
	VoucherApproval,
	WaitOptions,
} from '@ika.xyz/pre-alpha-core/common';
import {
	IkaClientBase,
	poll,
	RequestRecordReader,
	signatureSchemeNumber,
	signatureSchemeOf,
} from '@ika.xyz/pre-alpha-core/common';
import { PublicKey } from '@solana/web3.js';

import {
	DWALLET_STATE_ACTIVE,
	FUTURE_SIGNATURE_VOUCHER_OPEN,
	FUTURE_SIGNATURE_VOUCHER_PARTIALLY_SIGNED,
	readDWallet,
	readDWalletCoordinator,
	readFutureSignatureVoucherUnverified,
	readGasDeposit,
	readSignatureVoucherUnverified,
	readSignatureVoucherVerified,
	SIGNATURE_VOUCHER_PENDING,
	SIGNATURE_VOUCHER_SIGNED,
} from './accounts.js';
import type { GasDepositAccount } from './accounts.js';
import { dwalletCoordinatorPda, dwalletPda, gasDepositPda } from './addresses.js';
import { solanaCommitteeReader } from './committee-reader.js';
import {
	depositProofMessage,
	FIRST_GAS_DEPOSIT_INCARNATION,
	readEncryptionKey,
} from './instructions.js';
import type { EncryptionKeyEntry } from './instructions.js';
import { solanaNetworkKeyOutputRecordReader } from './network-key-output.js';
import { crossCheckedAccountRead } from './read-cross-check.js';
import type { GetAccount, SolanaReadCrossCheck } from './read-cross-check.js';
import { solanaRequestRecordReader } from './request-records.js';
import { dwalletShareReader } from './usability.js';

/** What the Solana `IkaClient`s take besides the base options, with the program's address as bytes. */
export interface SolanaIkaClientCoreOptions extends Omit<IkaClientBaseOptions, 'network'> {
	/** `'mainnet'`, `'testnet'`, or a custom network with its trusted network keys. */
	network: IkaNetwork;
	/** The ika program's id on this cluster. */
	programId: Uint8Array;
	/** The chain number the coordinator records; required on a custom network. */
	chainNumber?: number;
	/** The network the coordinator records (1 mainnet, 2 testnet, 3 local); required on a custom network. */
	networkValue?: number;
	/** Reads one account, or `null`. */
	getAccount: GetAccount;
	/** A second endpoint for the reads no network signature covers. */
	crossCheck?: SolanaReadCrossCheck;
}

export abstract class SolanaIkaClientCore<Address> extends IkaClientBase<Address, Address> {
	readonly getAccount: GetAccount;
	readonly crossCheck: SolanaReadCrossCheck;
	/** The chain number the registration and the gas deposit sign over. */
	readonly chainNumber: number;
	/** The network the registration and the gas deposit sign after the chain number. */
	readonly networkValue: number;
	readonly #programId: Uint8Array;

	protected constructor(options: SolanaIkaClientCoreOptions) {
		super(options, 'Solana', DWalletGrpcClient);
		this.#programId = Uint8Array.from(options.programId);
		this.getAccount = options.getAccount;
		this.crossCheck = options.crossCheck ?? 'not-cross-checked';
		({ chainNumber: this.chainNumber, network: this.networkValue } = chainNumberOf(
			options.network,
			options.chainNumber,
			options.networkValue,
		));
	}

	/** The ika program's id on this cluster. */
	get programId(): Address {
		return this.address(this.#programId);
	}

	/** `bytes`, a 32-byte address, as this client names an address. */
	protected abstract address(bytes: Uint8Array): Address;

	protected networkKeyRecords(): NetworkKeyOutputRecordReader {
		return solanaNetworkKeyOutputRecordReader(
			this.#programId,
			this.getAccount,
			this.crossCheck,
			this.network,
		);
	}

	protected committeeReader(): CommitteeChainReader {
		return solanaCommitteeReader(this.#programId, this.getAccount, this.crossCheck, this.network);
	}

	/**
	 * The dWallet coordinator's epoch, cross-checked when a second endpoint
	 * is set. The program's `SystemState` epoch, which the committee check
	 * reads, follows the network's epoch only from protocol version 10.
	 */
	protected async chainEpoch(): Promise<bigint> {
		const address = dwalletCoordinatorPda(this.#programId).address;
		const epoch = await crossCheckedAccountRead({
			getAccount: this.getAccount,
			crossCheck: this.crossCheck,
			what: "the dWallet coordinator's epoch",
			read: async (get) => {
				const account = await get(address);
				return account === null ? undefined : readDWalletCoordinator(account.data)?.epoch;
			},
			equal: (first, second) => first === second,
			position: (value) => value,
		});
		if (epoch === undefined) {
			throw new Error(`the program ${String(this.programId)} has no coordinator account`);
		}
		return epoch;
	}

	/**
	 * The `incarnation` of the request key's `GasDeposit` account, or
	 * `undefined` when the key has none. Every request names it.
	 */
	protected async depositIncarnation(requestKey: Uint8Array): Promise<bigint | undefined> {
		return (await this.getGasDeposit(requestKey))?.incarnation;
	}

	protected requestRecords(): RequestRecordReader {
		return solanaRequestRecordReader(this.#programId, this.getAccount, this.crossCheck);
	}

	protected shareReader(trustedNetworkKeys: TrustedNetworkKeys): DWalletShareReader {
		return dwalletShareReader(
			this.#programId,
			this.getAccount,
			this.crossCheck,
			trustedNetworkKeys,
		);
	}

	/**
	 * The incarnation the next consent names: 1, the first life, except while
	 * `signGasDepositReopenConsent` signs.
	 */
	#consentIncarnation: bigint = FIRST_GAS_DEPOSIT_INCARNATION;

	protected gasDepositConsentMessage(depositOwner: Address): Uint8Array {
		return depositProofMessage(
			this.chainNumber,
			this.networkValue,
			this.addressBytes(depositOwner),
			this.#consentIncarnation,
		);
	}

	/**
	 * The request key's consent to reopen its closed gas deposit as life
	 * `incarnation`, the deposit's incarnation plus one, owned by
	 * `depositOwner`: what `IkaTransaction.createFundedGasDeposit` takes as
	 * `consented` for a reopen. A consent opens exactly one life, so the
	 * consent of a life that ended does not reopen the deposit.
	 * `signGasDepositConsent` signs the first life's.
	 */
	signGasDepositReopenConsent(
		params: Parameters<IkaClientBase<Address, Address>['signGasDepositConsent']>[0] & {
			incarnation: bigint;
		},
	): { requestPublicKey: Uint8Array; consent: Uint8Array } {
		this.#consentIncarnation = params.incarnation;
		try {
			return this.signGasDepositConsent({
				requestKey: params.requestKey,
				depositOwner: params.depositOwner,
			});
		} finally {
			this.#consentIncarnation = FIRST_GAS_DEPOSIT_INCARNATION;
		}
	}

	protected voucherBytes(voucher: Address): Uint8Array {
		return this.addressBytes(voucher);
	}

	protected async readVoucherApproval(voucher: Address): Promise<VoucherApproval | null> {
		const account = await this.getAccount(this.addressBytes(voucher));
		if (account === null) return null;
		const read =
			readSignatureVoucherUnverified(account.data) ??
			readFutureSignatureVoucherUnverified(account.data);
		return read === null
			? null
			: {
					dwallet: Uint8Array.from(read.dwallet),
					messageDigest: Uint8Array.from(read.messageDigest),
					messageMetadataDigest: Uint8Array.from(read.messageMetadataDigest),
					signatureScheme: read.signatureScheme,
				};
	}

	protected dWalletAddressBytes(dWallet: DWallet): Uint8Array {
		return this.addressBytes(this.getDWalletAddress(dWallet));
	}

	protected async readEncryptionKeyEntry(
		holderSignerPublicKey: Uint8Array,
		curve: Curve,
	): Promise<HolderEncryptionKeyEntry> {
		return this.getEncryptionKey(holderSignerPublicKey, curve);
	}

	// ── dWallets ───────────────────────────────────────────────────────────

	/** The dWallet's account on Solana. */
	getDWalletAddress(
		dWallet: Pick<DWallet, 'curve' | 'publicKey' | 'importedSessionIdentifier'>,
	): Address {
		return this.address(
			dwalletPda(
				this.#programId,
				dWallet.curve,
				dWallet.publicKey,
				dWallet.importedSessionIdentifier,
			).address,
		);
	}

	/**
	 * Wait until `dWallet`'s account on Solana is active, and return its
	 * address. A dWallet with an encrypted share is active once the chain
	 * shows its holder's acceptance (`IkaTransaction.acceptEncryptedUserShare`),
	 * so this waits for the acceptance too.
	 */
	async waitForDWallet(dWallet: DWallet, options: WaitOptions = {}): Promise<Address> {
		const address = this.getDWalletAddress(dWallet);
		await poll(
			async () => {
				const account = await this.getAccount(this.addressBytes(address));
				if (account === null) return null;
				return readDWallet(Uint8Array.from(account.data))?.state === DWALLET_STATE_ACTIVE
					? true
					: null;
			},
			`the dWallet account ${String(address)} to be active`,
			options,
		);
		return address;
	}

	/**
	 * The encryption key `holderSignerPublicKey` registered for `curve`, with
	 * its registration signature verified. A re-encryption takes the new
	 * holder's.
	 */
	getEncryptionKey(holderSignerPublicKey: Uint8Array, curve: Curve): Promise<EncryptionKeyEntry> {
		return readEncryptionKey({
			programId: new PublicKey(this.#programId),
			getAccount: this.getAccount,
			crossCheck: this.crossCheck,
			chainNumber: this.chainNumber,
			network: this.networkValue,
			holderPublicKey: holderSignerPublicKey,
			curve: fromCurveToNumber(curve),
		});
	}

	/** The program's coordinator: its epoch, the IKA mint, and the treasury vault a top-up names. */
	async getDWalletCoordinator(): Promise<NonNullable<ReturnType<typeof readDWalletCoordinator>>> {
		const account = await this.getAccount(dwalletCoordinatorPda(this.#programId).address);
		const coordinator = account === null ? null : readDWalletCoordinator(account.data);
		if (coordinator === null) {
			throw new Error(`the program ${String(this.programId)} has no coordinator account`);
		}
		return coordinator;
	}

	/**
	 * The gas deposit of `requestPublicKey`, or `null` when it has none: its
	 * balances, debts, counters, owner, and whether a withdrawal is pending.
	 * The two minimums the network sets for every deposit are on the
	 * coordinator (`getDWalletCoordinator`).
	 */
	async getGasDeposit(requestPublicKey: Uint8Array): Promise<GasDepositAccount | null> {
		const account = await this.getAccount(gasDepositPda(this.#programId, requestPublicKey).address);
		return account === null ? null : readGasDeposit(account.data);
	}

	// ── Vouchers ───────────────────────────────────────────────────────────

	/**
	 * Wait until step 1 of a future sign is on Solana: the network wrote its
	 * partial signature into the voucher. Then the owner sets the voucher's
	 * signing key again (`IkaTransaction.setFutureSignatureVoucherSigningKey`)
	 * before `futureSign`.
	 */
	async waitForPartialUserSignature(
		futureSignatureVoucher: Address,
		options: WaitOptions = {},
	): Promise<void> {
		await poll(
			async () => {
				const account = await this.getAccount(this.addressBytes(futureSignatureVoucher));
				const state = account === null ? null : readFutureSignatureVoucherUnverified(account.data);
				if (state === null || state.status === FUTURE_SIGNATURE_VOUCHER_OPEN) return null;
				if (state.status !== FUTURE_SIGNATURE_VOUCHER_PARTIALLY_SIGNED) {
					throw new Error(
						`the future signature voucher ${String(futureSignatureVoucher)} has status ${state.status}, not partially signed`,
					);
				}
				return true;
			},
			`the partial signature in the future signature voucher ${String(futureSignatureVoucher)}`,
			options,
		);
	}

	/**
	 * Wait until the network writes the signature of a sign into its voucher
	 * on Solana, and return it once it verifies under the dWallet's public
	 * key. `requestSign` already returns the signature; this is for a reader
	 * that did not send the request. Throws once the voucher ends without one.
	 */
	waitForSignature(
		params: {
			signatureVoucher: Address;
			dWallet: DWallet;
			message: Uint8Array;
			hashScheme: Hash;
			signatureAlgorithm: SignatureAlgorithm;
			messageMetadata?: Uint8Array;
		},
		options: WaitOptions = {},
	): Promise<Uint8Array> {
		const signatureScheme = signatureSchemeNumber(
			signatureSchemeOf(
				fromNumberToCurve(params.dWallet.curve),
				params.signatureAlgorithm,
				params.hashScheme,
			),
		);
		const messageMetadata = params.messageMetadata ?? new Uint8Array(0);
		const voucherName = String(params.signatureVoucher);
		return poll(
			async () => {
				const account = await this.getAccount(this.addressBytes(params.signatureVoucher));
				if (account === null) return null;
				const voucher = await readSignatureVoucherVerified(
					account.data,
					{
						dwalletAddress: this.addressBytes(this.getDWalletAddress(params.dWallet)),
						message: params.message,
						messageMetadata,
						signatureScheme,
					},
					(signature) =>
						verifySignatureWithScheme({
							curve: params.dWallet.curve,
							signatureScheme,
							message: params.message,
							messageMetadata,
							dWalletPublicOutput: params.dWallet.networkPublicOutput,
							signature,
							cryptography: this.cryptography,
						}),
				);
				if (voucher === null || voucher.status === SIGNATURE_VOUCHER_PENDING) return null;
				if (voucher.status !== SIGNATURE_VOUCHER_SIGNED) {
					throw new Error(
						`the signature voucher ${voucherName} ended with status ${voucher.status} and no signature`,
					);
				}
				return voucher.signature;
			},
			`a signature in the voucher ${voucherName}`,
			options,
		);
	}
}

function chainNumberOf(
	network: IkaNetwork,
	chainNumber: number | undefined,
	networkValue: number | undefined,
): { chainNumber: number; network: number } {
	if (typeof network === 'string') {
		return {
			chainNumber: deployedSolanaChainNumber(network),
			network: deployedNetworkValue(network),
		};
	}
	if (chainNumber === undefined || networkValue === undefined) {
		throw new Error(
			'a custom network needs the Solana chain number and network from your configuration: set config.chainNumber and config.networkValue',
		);
	}
	return { chainNumber, network: networkValue };
}
