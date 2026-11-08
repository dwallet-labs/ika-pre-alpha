// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * `IkaTransaction` on Solana: adds the dWallet instructions to a Solana
 * transaction the app's wallet signs and sends, as `IkaTransaction` of
 * `@ika.xyz/sdk` does on Sui.
 *
 * The instructions are the ones the chain holds: the user's encryption key,
 * the request key's gas deposit, and the signature vouchers through which a
 * dWallet's owner approves a message. The network's requests themselves
 * (create, presign, sign, ...) go through `IkaClient`.
 *
 * A voucher lives at a fresh address that signs its own creation. Each
 * approval adds that address's keypair to `signers`: sign the transaction
 * with them too (`transaction.partialSign(...ikaTransaction.signers)`)
 * before the wallet signs it.
 *
 * It builds either kind of Solana transaction. Given a legacy `transaction`,
 * it adds its instructions to it. Given `version: 0`, it keeps the
 * instructions itself, and `buildVersionedTransaction` compiles them into a
 * versioned transaction, with the address lookup tables it was given, and
 * signs it with `signers`.
 *
 * A Solana transaction holds at most 1,232 bytes (`PACKET_DATA_SIZE`), its
 * signatures included. Each method measures the whole transaction after it
 * adds its instructions, the caller's own included, and with the lookup
 * tables of a versioned one. When the transaction would be over the limit,
 * the method takes its instructions out again and throws
 * `TransactionTooLargeError`: send what is there, and add the rest to a new
 * transaction. Add your own instructions with `add`, so they are measured
 * too.
 */
import { fromCurveToNumber } from '@ika.xyz/pre-alpha-core';
import type { Curve, Hash, SignatureAlgorithm } from '@ika.xyz/pre-alpha-core';
import type { DWallet, UserShareEncryptionKeys } from '@ika.xyz/pre-alpha-core/common';
import {
	holderKeypair,
	requestKeypair,
	signatureSchemeNumber,
	signatureSchemeOf,
} from '@ika.xyz/pre-alpha-core/common';
import {
	Keypair,
	PACKET_DATA_SIZE,
	PublicKey,
	Transaction,
	TransactionMessage,
	VersionedTransaction,
} from '@solana/web3.js';
import type { AddressLookupTableAccount, TransactionInstruction } from '@solana/web3.js';

import { approvalMessageDigests, gasDepositPda } from '../addresses.js';
import {
	checkDepositLife,
	checkMinFirstDeposit,
	checkMinTopUp,
	checkTransferAllowed,
	GasDepositAlreadyOpenError,
} from '../gas-deposits.js';
import {
	acceptEncryptedUserShareInstructions,
	createDepositInstructions,
	issueFutureSignatureVoucherInstruction,
	issueSignatureVoucherInstruction,
	registerEncryptionKeyInstructions,
	requestWithdrawInstruction,
	revokeSignatureVoucherInstruction,
	setVoucherSigningKeyInstruction,
	signEncryptionKeyRegistration,
	topUpInstruction,
	transferGasDepositInstruction,
	transferOwnershipInstruction,
} from '../instructions.js';
import type { IkaClient } from './ika-client.js';

/**
 * What `IkaTransaction` reads from its client: an `IkaClient`, or anything
 * that answers the same reads with `PublicKey` addresses.
 */
export type IkaTransactionClient = Pick<
	IkaClient,
	| 'programId'
	| 'chainNumber'
	| 'networkValue'
	| 'getDWalletCoordinator'
	| 'getGasDeposit'
	| 'getRequestPublicKey'
	| 'checkDWalletUsable'
	| 'getDWalletAddress'
>;

export type IkaTransactionParams = {
	ikaClient: IkaTransactionClient;
	/**
	 * The wallet that signs the transaction: it pays, owns the dWallets it
	 * approves messages for, and owns the vouchers it issues.
	 */
	owner: PublicKey;
	/**
	 * Pays every fee and every account's rent, and is the fee payer: the app's
	 * wallet, for an app that pays for its users. It signs the transaction as
	 * well as the owner. Defaults to `owner`.
	 */
	payer?: PublicKey;
	/** The user's keys. Most instructions need them; see each method. */
	userShareEncryptionKeys?: UserShareEncryptionKeys;
} & (
	| {
			/** The legacy Solana transaction the instructions are added to. */
			transaction: Transaction;
	  }
	| {
			/** Build a versioned (v0) transaction: see `buildVersionedTransaction`. */
			version: 0;
			/** The lookup tables the transaction compiles against, which shorten it. */
			addressLookupTableAccounts?: AddressLookupTableAccount[];
	  }
);

/**
 * Adding an instruction would make the transaction larger than Solana takes.
 * Nothing was added: the transaction is as it was before the call.
 */
export class TransactionTooLargeError extends Error {
	constructor(
		/** The size the transaction would have had, signatures included. */
		readonly size: number,
		/** The most Solana takes: `PACKET_DATA_SIZE`, 1,232 bytes. */
		readonly limit: number = PACKET_DATA_SIZE,
	) {
		super(
			`the transaction would be ${size} bytes, and Solana takes at most ${limit}: ` +
				'send what it holds, and add this to a new transaction',
		);
		this.name = 'TransactionTooLargeError';
	}
}

/** What a voucher approves: one message, signed once with one dWallet. */
export interface ApproveMessageParams {
	dWallet: DWallet;
	message: Uint8Array;
	signatureAlgorithm: SignatureAlgorithm;
	hashScheme: Hash;
	/** The scheme's metadata; omit it for a scheme that takes none. */
	messageMetadata?: Uint8Array;
	/** Who controls the voucher afterwards. Defaults to the owner. */
	voucherOwner?: PublicKey;
}

export class IkaTransaction {
	readonly #ikaClient: IkaTransactionClient;
	readonly #owner: PublicKey;
	readonly #payer: PublicKey;
	readonly #keys: UserShareEncryptionKeys | undefined;
	readonly #signers: Keypair[] = [];
	/** The legacy transaction, or `undefined` for a versioned one. */
	readonly #transaction: Transaction | undefined;
	/** A versioned transaction's instructions; a legacy one keeps its own. */
	readonly #instructions: TransactionInstruction[] = [];
	readonly #lookupTables: AddressLookupTableAccount[];

	constructor(params: IkaTransactionParams) {
		this.#ikaClient = params.ikaClient;
		this.#owner = params.owner;
		this.#payer = params.payer ?? params.owner;
		this.#keys = params.userShareEncryptionKeys;
		this.#transaction = 'transaction' in params ? params.transaction : undefined;
		this.#lookupTables = 'version' in params ? (params.addressLookupTableAccounts ?? []) : [];
	}

	/** Every instruction of the transaction so far, the caller's own included. */
	get instructions(): readonly TransactionInstruction[] {
		return this.#transaction?.instructions ?? this.#instructions;
	}

	/**
	 * Add the caller's own `instructions`, measured like the SDK's: this
	 * throws `TransactionTooLargeError`, and adds nothing, when they do not
	 * fit.
	 */
	add(...instructions: TransactionInstruction[]): IkaTransaction {
		this.#add(...instructions);
		return this;
	}

	/**
	 * Compile a `version: 0` transaction for `recentBlockhash`, with the payer
	 * as its fee payer and the lookup tables it was given, and sign it with
	 * `signers`. The owner, and a payer of its own, sign it next.
	 */
	buildVersionedTransaction({
		recentBlockhash,
	}: {
		recentBlockhash: string;
	}): VersionedTransaction {
		if (this.#transaction !== undefined) {
			throw new Error(
				'this IkaTransaction adds to a legacy transaction: pass `version: 0` instead',
			);
		}
		const transaction = new VersionedTransaction(this.#compileV0(recentBlockhash));
		transaction.sign(this.#signers);
		return transaction;
	}

	/**
	 * The keypairs of the vouchers this transaction creates. Each signs its
	 * own creation: sign the transaction with them as well as the wallet.
	 */
	get signers(): readonly Keypair[] {
		return this.#signers;
	}

	/**
	 * Register the keys' encryption key for `curve`, signed by their holder
	 * key. The registry keeps one key per holder and curve, so a second
	 * registration is refused. The validators read Solana at finalized
	 * commitment: wait for that before a request that encrypts to the key.
	 * The instructions carry the whole encryption key, so send them in a
	 * transaction of their own.
	 */
	registerEncryptionKey({ curve }: { curve?: Curve } = {}): IkaTransaction {
		const keys = this.#requireKeys();
		const curveNumber = fromCurveToNumber(curve ?? keys.curve);
		const holder = holderKeypair(keys);
		const { chainNumber, networkValue, programId } = this.#ikaClient;
		this.#add(
			...registerEncryptionKeyInstructions({
				programId,
				payer: this.#payer,
				holderPublicKey: holder.publicKey,
				chainNumber,
				network: networkValue,
				curve: curveNumber,
				encryptionKey: keys.encryptionKey,
				signature: signEncryptionKeyRegistration(
					holder,
					chainNumber,
					networkValue,
					curveNumber,
					keys.encryptionKey,
				),
			}),
		);
		return this;
	}

	/**
	 * Create an empty gas deposit owned by the owner, who alone asks for its
	 * withdrawal. Every request its request key signs is charged to it.
	 *
	 * The program refuses an empty deposit while the network's minimum first
	 * deposit is above zero in either coin, or while the deposit fee is above
	 * zero: this method sends no SOL, so it pays no fee.
	 * `createFundedGasDeposit` funds the deposit as it creates it, pays the
	 * fee, and checks the minimum first.
	 *
	 * The request key must consent to the owner. With no arguments it is the
	 * keys' request key, which consents here. For another key, such as a
	 * user's key an app pays for, pass its public key and its consent, signed
	 * where the key is (`IkaClient.signGasDepositConsent`).
	 */
	createGasDeposit(
		consented: { requestPublicKey: Uint8Array; consent: Uint8Array } | undefined = undefined,
	): IkaTransaction {
		this.#add(...this.#createDeposit(consented));
		return this;
	}

	/**
	 * Create a gas deposit owned by the owner, funded as it is created with
	 * IKA from the payer's token account `ikaTokenAccount` and SOL from the
	 * payer. Amounts are in IKA base units (10^-8 IKA) and lamports, and they
	 * are what the deposit is CREDITED: the network's deposit fee is read
	 * from the coordinator and added to the SOL the payer sends, so the payer
	 * pays `solAmount` plus the fee.
	 *
	 * The same call reopens a closed deposit as its next life. This reads the
	 * deposit first: with none it opens incarnation 1, with a closed one the
	 * closed deposit's incarnation plus one, and it throws
	 * `GasDepositAlreadyOpenError` for an open or pending one. A `consented`
	 * proof must name that life: `IkaClient.signGasDepositConsent` signs the
	 * first, `IkaClient.signGasDepositReopenConsent` a later one. With no
	 * `consented`, the keys' request key signs the right one here.
	 *
	 * The network sets a minimum first deposit on the coordinator. This reads
	 * it first, and throws `GasDepositBelowMinimumError`, which names the
	 * minimum, for credited amounts the program would refuse in either coin.
	 */
	async createFundedGasDeposit(params: {
		ikaTokenAccount: PublicKey;
		ikaAmount: bigint;
		solAmount: bigint;
		consented?: { requestPublicKey: Uint8Array; consent: Uint8Array };
	}): Promise<IkaTransaction> {
		const requestPublicKey =
			params.consented?.requestPublicKey ??
			this.#ikaClient.getRequestPublicKey(this.#requireKeys());
		const deposit = await this.#ikaClient.getGasDeposit(requestPublicKey);
		if (deposit !== null && !deposit.closed) {
			throw new GasDepositAlreadyOpenError(deposit.incarnation, deposit.withdrawalPending);
		}
		const incarnation = deposit === null ? 1n : deposit.incarnation + 1n;
		const { treasuryVault, minFirstDeposit, depositFee } =
			await this.#ikaClient.getDWalletCoordinator();
		checkMinFirstDeposit({ ika: params.ikaAmount, sol: params.solAmount }, minFirstDeposit);
		this.#add(
			...this.#createDeposit(
				params.consented,
				{
					ikaTokenAccount: params.ikaTokenAccount,
					treasuryVault: new PublicKey(treasuryVault),
					ikaAmount: params.ikaAmount,
					solAmount: params.solAmount + depositFee.sol,
				},
				depositFee.sol > 0n ? new PublicKey(depositFee.recipient) : undefined,
				incarnation,
			),
		);
		return this;
	}

	#createDeposit(
		consented: { requestPublicKey: Uint8Array; consent: Uint8Array } | undefined,
		funding?: {
			ikaTokenAccount: PublicKey;
			treasuryVault: PublicKey;
			ikaAmount: bigint;
			solAmount: bigint;
		},
		feeRecipient?: PublicKey,
		incarnation?: bigint,
	): TransactionInstruction[] {
		return createDepositInstructions({
			programId: this.#ikaClient.programId,
			sender: this.#owner,
			payer: this.#payer,
			requestKey:
				consented === undefined
					? requestKeypair(this.#requireKeys())
					: { publicKey: consented.requestPublicKey, proofOfPossession: consented.consent },
			chainNumber: this.#ikaClient.chainNumber,
			network: this.#ikaClient.networkValue,
			funding,
			feeRecipient,
			incarnation,
		});
	}

	/**
	 * Add IKA, from the payer's token account `ikaTokenAccount`, and SOL, from
	 * the payer, to the gas deposit of `requestPublicKey`: any key's, so an
	 * app can fund its users' deposits. It defaults to the key that signs
	 * this client's requests for the keys. Amounts are in IKA base units
	 * (10^-8 IKA) and lamports, and they are what the deposit is CREDITED:
	 * the network's deposit fee is read from the coordinator and added to the
	 * SOL the payer sends, so an IKA-only top-up sends exactly the fee.
	 *
	 * The network's minimum first deposit is a total: the deposit after the
	 * top-up, net of its debt, must reach it in each coin. This reads the
	 * deposit and the minimum first, and throws `GasDepositBelowMinimumError`,
	 * which names the minimum, for a top-up the program would refuse. It
	 * throws for a key with no deposit: create one with
	 * `createFundedGasDeposit`. It throws `GasDepositClosedError` for a closed
	 * deposit, which only a create reopens. A top-up names no life: it lands
	 * on whatever life is open when it executes. A top-up while a withdrawal
	 * is pending is paid out with the rest of the deposit.
	 */
	async topUpGasDeposit(params: {
		ikaTokenAccount: PublicKey;
		ikaAmount: bigint;
		solAmount: bigint;
		requestPublicKey?: Uint8Array;
	}): Promise<IkaTransaction> {
		const requestPublicKey =
			params.requestPublicKey ?? this.#ikaClient.getRequestPublicKey(this.#requireKeys());
		const deposit = await this.#ikaClient.getGasDeposit(requestPublicKey);
		if (deposit === null) {
			throw new Error(
				'the request key has no gas deposit; create one with createFundedGasDeposit first',
			);
		}
		checkDepositLife(deposit, 'top up');
		const { treasuryVault, minFirstDeposit, minBalance, depositFee } =
			await this.#ikaClient.getDWalletCoordinator();
		checkMinTopUp({ ika: params.ikaAmount, sol: params.solAmount }, minBalance);
		checkMinFirstDeposit(
			{
				ika: deposit.ikaBalance + params.ikaAmount - deposit.ikaDebt,
				sol: deposit.solBalance + params.solAmount - deposit.solDebt,
			},
			minFirstDeposit,
		);
		this.#add(
			topUpInstruction({
				programId: this.#ikaClient.programId,
				deposit: this.#depositOf(requestPublicKey),
				payer: this.#payer,
				ikaTokenAccount: params.ikaTokenAccount,
				treasuryVault: new PublicKey(treasuryVault),
				ikaAmount: params.ikaAmount,
				solAmount: params.solAmount + depositFee.sol,
				feeRecipient: depositFee.sol > 0n ? new PublicKey(depositFee.recipient) : undefined,
			}),
		);
		return this;
	}

	/**
	 * Ask for the whole gas deposit of `requestPublicKey`, as its owner. It
	 * defaults to the key that signs this client's requests for the keys.
	 *
	 * The request takes no amount. The network pays the deposit out with its
	 * own transaction, once every request it accepted on the deposit is
	 * charged. It takes its charge first, then sends what is left after
	 * debt: the SOL to the owner, and the IKA to `ikaDestination`, an open
	 * token account of the IKA mint. There is no claim step. The request is
	 * final: there is no cancel, and a second request while one is pending
	 * is refused. A payout that pays everything closes the deposit, and an
	 * owner who wants to keep spending reopens it with a create.
	 *
	 * `incarnation` is the deposit's life the request is for; the program
	 * refuses another one. This reads the deposit first. Omitted, the
	 * request names the open life it reads. It throws for a key with no
	 * deposit, `GasDepositClosedError` for a closed deposit, and
	 * `GasDepositIncarnationMismatchError` when `incarnation` is not the open
	 * life.
	 */
	async requestGasWithdrawal(params: {
		ikaDestination: PublicKey;
		incarnation?: bigint;
		requestPublicKey?: Uint8Array;
	}): Promise<IkaTransaction> {
		const requestPublicKey =
			params.requestPublicKey ?? this.#ikaClient.getRequestPublicKey(this.#requireKeys());
		const deposit = await this.#ikaClient.getGasDeposit(requestPublicKey);
		if (deposit === null) {
			throw new Error('the request key has no gas deposit');
		}
		checkDepositLife(deposit, 'request', params.incarnation);
		this.#add(
			requestWithdrawInstruction({
				programId: this.#ikaClient.programId,
				owner: this.#owner,
				deposit: this.#depositOf(requestPublicKey),
				ikaDestination: params.ikaDestination,
				incarnation: deposit.incarnation,
			}),
		);
		return this;
	}

	/**
	 * Hand the gas deposit of `requestPublicKey` to `newOwner`, as its owner.
	 * It defaults to the key that signs this client's requests for the keys.
	 * The new owner alone asks for its withdrawal from then on.
	 *
	 * A withdrawal request is final, and the program refuses a transfer while
	 * one is pending. The client reads the deposit first and throws
	 * `TransferWhileWithdrawalPendingError` for such a transfer. It throws
	 * for a key with no deposit, and `GasDepositClosedError` for a closed
	 * one. `incarnation`, the life the transfer is for, defaults to the open
	 * life it reads; another one throws `GasDepositIncarnationMismatchError`.
	 */
	async transferGasDeposit(params: {
		newOwner: PublicKey;
		incarnation?: bigint;
		requestPublicKey?: Uint8Array;
	}): Promise<IkaTransaction> {
		const requestPublicKey =
			params.requestPublicKey ?? this.#ikaClient.getRequestPublicKey(this.#requireKeys());
		const deposit = await this.#ikaClient.getGasDeposit(requestPublicKey);
		if (deposit === null) {
			throw new Error('the request key has no gas deposit');
		}
		checkDepositLife(deposit, 'transfer', params.incarnation);
		checkTransferAllowed(deposit);
		this.#add(
			transferGasDepositInstruction({
				programId: this.#ikaClient.programId,
				owner: this.#owner,
				deposit: this.#depositOf(requestPublicKey),
				newOwner: params.newOwner,
				incarnation: deposit.incarnation,
			}),
		);
		return this;
	}

	/** The gas deposit of `requestPublicKey`, or of the keys' request key. */
	#depositOf(requestPublicKey: Uint8Array | undefined): PublicKey {
		const { programId } = this.#ikaClient;
		return new PublicKey(
			gasDepositPda(
				programId.toBytes(),
				requestPublicKey ?? this.#ikaClient.getRequestPublicKey(this.#requireKeys()),
			).address,
		);
	}

	/**
	 * Approve `message` for one sign with `dWallet`: issue a signature voucher,
	 * as the dWallet's owner. Only the key that signs this client's requests
	 * may sign with it: the keys' request key, or the app's request signer.
	 * Returns the voucher's address, which `IkaClient.requestSign` takes.
	 *
	 * The keys' holder must hold the dWallet's share, which is checked on the
	 * chain first: a voucher for a dWallet the user cannot sign for would be
	 * charged and never signed.
	 */
	approveMessage(params: ApproveMessageParams): Promise<PublicKey> {
		return this.#issueVoucher(params, issueSignatureVoucherInstruction);
	}

	/**
	 * Approve `message` for a future sign: issue a future signature voucher.
	 * `IkaClient.requestFutureSign` writes the user's half of the signature
	 * into it now, and `IkaClient.futureSign` finishes the sign later.
	 */
	approveFutureSign(params: ApproveMessageParams): Promise<PublicKey> {
		return this.#issueVoucher(params, issueFutureSignatureVoucherInstruction);
	}

	/**
	 * Let the keys' request key sign with a future signature voucher again, as
	 * its owner. Step 1 of a future sign clears the voucher's signing key when
	 * it lands, so add this after `IkaClient.waitForPartialUserSignature` and
	 * before `IkaClient.futureSign`.
	 */
	setFutureSignatureVoucherSigningKey(params: {
		futureSignatureVoucher: PublicKey;
	}): IkaTransaction {
		return this.setSignatureVoucherSigningKey({ signatureVoucher: params.futureSignatureVoucher });
	}

	/** Let the keys' request key sign with a signature voucher, as its owner. */
	setSignatureVoucherSigningKey(params: { signatureVoucher: PublicKey }): IkaTransaction {
		this.#add(
			setVoucherSigningKeyInstruction({
				programId: this.#ikaClient.programId,
				voucherOwner: this.#owner,
				voucher: params.signatureVoucher,
				requestPublicKey: this.#ikaClient.getRequestPublicKey(this.#requireKeys()),
			}),
		);
		return this;
	}

	/** Revoke a signature voucher for good, as its owner. */
	revokeSignatureVoucher(params: { signatureVoucher: PublicKey }): IkaTransaction {
		this.#add(
			revokeSignatureVoucherInstruction({
				programId: this.#ikaClient.programId,
				voucherOwner: this.#owner,
				voucher: params.signatureVoucher,
			}),
		);
		return this;
	}

	/**
	 * Accept the holder's encrypted share of `dWallet`, with the acceptance
	 * the SDK signed when it checked the network's answer
	 * (`dWallet.acceptance`, from `requestDWalletDKG`,
	 * `requestImportedKeyDWalletVerification` or `receiveEncryptedUserShare`).
	 * The holder's signature is the only authority, so anyone may send and
	 * pay for it. Accepting a new dWallet's first share makes the dWallet
	 * usable; the program refuses every use of it before. The two
	 * instructions must stay next to each other, in this order.
	 */
	acceptEncryptedUserShare({ dWallet }: { dWallet: DWallet }): IkaTransaction {
		const { acceptance } = dWallet;
		if (acceptance === undefined) {
			throw new Error(
				'the dWallet carries no acceptance: it comes from requestDWalletDKG, requestImportedKeyDWalletVerification or receiveEncryptedUserShare',
			);
		}
		this.#add(
			...acceptEncryptedUserShareInstructions({
				programId: this.#ikaClient.programId,
				curve: dWallet.curve,
				dwalletPublicKey: dWallet.publicKey,
				importedSessionIdentifier: dWallet.importedSessionIdentifier,
				holderPublicKey: acceptance.holderPublicKey,
				acceptanceDigest: acceptance.acceptanceDigest,
				signature: acceptance.signature,
			}),
		);
		return this;
	}

	/**
	 * Hand `dWallet` to `newOwner`: a wallet, or a program's signing address,
	 * whose governance then decides what gets signed. After this the owner
	 * issues no more vouchers on it.
	 */
	transferDWallet(params: { dWallet: DWallet; newOwner: PublicKey }): IkaTransaction {
		this.#add(
			transferOwnershipInstruction({
				programId: this.#ikaClient.programId,
				owner: this.#owner,
				dwallet: this.#ikaClient.getDWalletAddress(params.dWallet),
				newOwner: params.newOwner,
			}),
		);
		return this;
	}

	async #issueVoucher(
		params: ApproveMessageParams,
		issue: typeof issueSignatureVoucherInstruction,
	): Promise<PublicKey> {
		const keys = this.#requireKeys();
		const usable = await this.#ikaClient.checkDWalletUsable(params.dWallet, keys);
		const voucher = Keypair.generate();
		const { messageDigest, messageMetadataDigest } = approvalMessageDigests(
			params.message,
			params.messageMetadata,
		);
		this.#add(
			await issue({
				programId: this.#ikaClient.programId,
				owner: this.#owner,
				dwallet: this.#ikaClient.getDWalletAddress(params.dWallet),
				voucher: voucher.publicKey,
				messageDigest,
				messageMetadataDigest,
				signatureScheme: signatureSchemeNumber(
					signatureSchemeOf(keys.curve, params.signatureAlgorithm, params.hashScheme),
				),
				requestPublicKey: this.#ikaClient.getRequestPublicKey(keys),
				payer: this.#payer,
				voucherOwner: params.voucherOwner,
				usability: { holderSignerPublicKey: usable.holder, usable },
			}),
		);
		this.#signers.push(voucher);
		return voucher.publicKey;
	}

	/**
	 * Add `instructions`, unless the transaction would then be over Solana's
	 * size limit: then they are taken out again, and this throws.
	 */
	#add(...instructions: TransactionInstruction[]): void {
		const list = this.#transaction?.instructions ?? this.#instructions;
		const before = list.length;
		list.push(...instructions);
		const size = this.#size();
		if (size > PACKET_DATA_SIZE) {
			list.splice(before);
			throw new TransactionTooLargeError(size);
		}
	}

	/**
	 * The transaction's size once signed, counted field by field from its
	 * compiled message rather than serialized, since `@solana/web3.js`
	 * refuses to serialize a message over the limit. A transaction with no
	 * fee payer or blockhash yet is measured with the owner as its payer and
	 * a placeholder blockhash, which have the same size.
	 */
	#size(): number {
		const placeholder = PublicKey.default.toBase58();
		if (this.#transaction === undefined) {
			const message = this.#compileV0(placeholder);
			const lookups = message.addressTableLookups.reduce(
				(total, lookup) =>
					total +
					32 +
					vecLength(lookup.writableIndexes.length) +
					vecLength(lookup.readonlyIndexes.length),
				0,
			);
			return (
				signaturesLength(message.header.numRequiredSignatures) +
				// The version prefix, then the legacy message's fields.
				1 +
				messageLength(
					message.staticAccountKeys.length,
					message.compiledInstructions.map((instruction) => ({
						accounts: instruction.accountKeyIndexes.length,
						data: instruction.data.length,
					})),
				) +
				shortVecLength(message.addressTableLookups.length) +
				lookups
			);
		}
		const message = new Transaction({
			feePayer: this.#transaction.feePayer ?? this.#payer,
			recentBlockhash: this.#transaction.recentBlockhash ?? placeholder,
		})
			.add(...this.#transaction.instructions)
			.compileMessage();
		return (
			signaturesLength(message.header.numRequiredSignatures) +
			messageLength(
				message.accountKeys.length,
				message.instructions.map((instruction, index) => ({
					accounts: instruction.accounts.length,
					data: this.#transaction!.instructions[index].data.length,
				})),
			)
		);
	}

	#compileV0(recentBlockhash: string) {
		return new TransactionMessage({
			payerKey: this.#payer,
			recentBlockhash,
			instructions: this.#instructions,
		}).compileToV0Message(this.#lookupTables);
	}

	#requireKeys(): UserShareEncryptionKeys {
		if (this.#keys === undefined) {
			throw new Error('User share encryption keys are not set');
		}
		return this.#keys;
	}
}

/** The bytes Solana's compact-u16 length prefix takes for `length`. */
function shortVecLength(length: number): number {
	return length < 0x80 ? 1 : length < 0x4000 ? 2 : 3;
}

/** A compact-u16 length and `length` one-byte entries after it. */
function vecLength(length: number): number {
	return shortVecLength(length) + length;
}

/** The signature count, then one 64-byte signature per required signer. */
function signaturesLength(signers: number): number {
	return shortVecLength(signers) + 64 * signers;
}

/**
 * A legacy message's size: its three header bytes, its account keys, its
 * blockhash, and per instruction the program's index, the account indexes
 * and the data.
 */
function messageLength(keys: number, instructions: { accounts: number; data: number }[]): number {
	return (
		3 +
		shortVecLength(keys) +
		32 * keys +
		32 +
		shortVecLength(instructions.length) +
		instructions.reduce(
			(total, instruction) =>
				total + 1 + vecLength(instruction.accounts) + vecLength(instruction.data),
			0,
		)
	);
}
