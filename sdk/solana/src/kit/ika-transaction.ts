// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * `IkaTransaction` on Solana, with `@solana/kit`: the dWallet instructions,
 * as kit `Instruction`s an app appends to its transaction message.
 *
 * ```ts
 * const ikaTx = new IkaTransaction({ ikaClient, owner: wallet });
 * const voucher = await ikaTx.approveMessage({ dWallet, message, ...scheme });
 * const message = pipe(
 *   createTransactionMessage({ version: 0 }),
 *   (m) => setTransactionMessageFeePayerSigner(wallet, m),
 *   (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
 *   (m) => appendTransactionMessageInstructions(ikaTx.instructions, m),
 * );
 * const signed = await signTransactionMessageWithSigners(message);
 * ```
 *
 * A voucher lives at a fresh address that signs its own creation. Its
 * keypair signer is attached to the instruction's account, so
 * `signTransactionMessageWithSigners` signs with it. Pass the owner, and a
 * payer of its own, as `TransactionSigner`s to have theirs attached too, or
 * as `Address`es to sign for them another way.
 *
 * The instructions are built by `@ika.xyz/sdk-solana`, as `@solana/web3.js`
 * instructions, and converted. So `@solana/web3.js` must be installed, though
 * the app's code never sees it. As with the web3.js `IkaTransaction`, each
 * method measures the whole transaction against Solana's 1,232 bytes, with
 * the lookup tables it was given, and throws `TransactionTooLargeError`,
 * adding nothing, when it would not fit. Add your own instructions with
 * `add`, so they are measured too.
 */
import { Buffer } from 'buffer';
import type { Curve } from '@ika.xyz/sdk-core';
import type { DWallet, UserShareEncryptionKeys } from '@ika.xyz/sdk-core/common';
import { AccountRole, address, createKeyPairSignerFromBytes, getAddressEncoder } from '@solana/kit';
import type {
	AccountMeta,
	Address,
	AddressesByLookupTableAddress,
	Instruction,
	KeyPairSigner,
	TransactionSigner,
} from '@solana/kit';
import { AddressLookupTableAccount, PublicKey, TransactionInstruction } from '@solana/web3.js';

import { IkaTransaction as Web3IkaTransaction } from '../web3/ika-transaction.js';
import type {
	IkaTransactionClient,
	ApproveMessageParams as Web3ApproveMessageParams,
} from '../web3/ika-transaction.js';
import type { IkaClient } from './ika-client.js';

export interface IkaTransactionParams {
	ikaClient: IkaClient;
	/**
	 * The wallet that owns the dWallets it approves messages for and the
	 * vouchers it issues. A `TransactionSigner` is attached to the
	 * instructions it signs.
	 */
	owner: Address | TransactionSigner;
	/**
	 * Pays every fee and every account's rent: the app's wallet, for an app
	 * that pays for its users. Make it the message's fee payer. Defaults to
	 * the owner.
	 */
	payer?: Address | TransactionSigner;
	/** The user's keys. Most instructions need them; see each method. */
	userShareEncryptionKeys?: UserShareEncryptionKeys;
	/** The lookup tables the transaction will be compressed with, for the size check. */
	addressesByLookupTableAddress?: AddressesByLookupTableAddress;
}

/** What a voucher approves: one message, signed once with one dWallet. */
export type ApproveMessageParams = Omit<Web3ApproveMessageParams, 'voucherOwner'> & {
	/** Who controls the voucher afterwards. Defaults to the owner. */
	voucherOwner?: Address;
};

export class IkaTransaction {
	readonly #inner: Web3IkaTransaction;
	/** The signers attached to the instructions' accounts, by address. */
	readonly #signers = new Map<string, TransactionSigner>();
	readonly #voucherSigners: KeyPairSigner[] = [];

	constructor(params: IkaTransactionParams) {
		const owner = addressOf(params.owner);
		[params.owner, params.payer].forEach((signer) => {
			if (signer !== undefined && typeof signer !== 'string') {
				this.#signers.set(signer.address, signer);
			}
		});
		this.#inner = new Web3IkaTransaction({
			ikaClient: web3Client(params.ikaClient),
			owner: publicKey(owner),
			payer: params.payer === undefined ? undefined : publicKey(addressOf(params.payer)),
			userShareEncryptionKeys: params.userShareEncryptionKeys,
			version: 0,
			addressLookupTableAccounts: Object.entries(params.addressesByLookupTableAddress ?? {}).map(
				([table, addresses]) => lookupTable(table as Address, addresses),
			),
		});
	}

	/** Every instruction of the transaction so far, the caller's own included. */
	get instructions(): Instruction[] {
		return this.#inner.instructions.map((instruction) => this.#toKit(instruction));
	}

	/** The keypair signers of the vouchers this transaction creates; each is also attached. */
	get signers(): readonly KeyPairSigner[] {
		return this.#voucherSigners;
	}

	/** Add the caller's own `instructions`, measured like the SDK's. */
	add(...instructions: Instruction[]): IkaTransaction {
		this.#inner.add(...instructions.map(fromKit));
		return this;
	}

	/** As the web3.js `IkaTransaction.registerEncryptionKey`. */
	registerEncryptionKey(params: { curve?: Curve } = {}): IkaTransaction {
		this.#inner.registerEncryptionKey(params);
		return this;
	}

	/** As the web3.js `IkaTransaction.createGasDeposit`. */
	createGasDeposit(consented?: {
		requestPublicKey: Uint8Array;
		consent: Uint8Array;
	}): IkaTransaction {
		this.#inner.createGasDeposit(consented);
		return this;
	}

	/** As the web3.js `IkaTransaction.topUpGasDeposit`, from the payer's token account `ikaTokenAccount`. */
	async topUpGasDeposit(params: {
		ikaTokenAccount: Address;
		ikaAmount: bigint;
		solAmount: bigint;
		requestPublicKey?: Uint8Array;
	}): Promise<IkaTransaction> {
		await this.#inner.topUpGasDeposit({
			...params,
			ikaTokenAccount: publicKey(params.ikaTokenAccount),
		});
		return this;
	}

	/**
	 * As the web3.js `IkaTransaction.approveMessage`: issue a signature
	 * voucher, and return its address, which `IkaClient.requestSign` takes.
	 */
	approveMessage(params: ApproveMessageParams): Promise<Address> {
		return this.#issueVoucher(() => this.#inner.approveMessage(web3Approval(params)));
	}

	/** As the web3.js `IkaTransaction.approveFutureSign`. */
	approveFutureSign(params: ApproveMessageParams): Promise<Address> {
		return this.#issueVoucher(() => this.#inner.approveFutureSign(web3Approval(params)));
	}

	/** As the web3.js `IkaTransaction.setFutureSignatureVoucherSigningKey`. */
	setFutureSignatureVoucherSigningKey(params: { futureSignatureVoucher: Address }): IkaTransaction {
		this.#inner.setFutureSignatureVoucherSigningKey({
			futureSignatureVoucher: publicKey(params.futureSignatureVoucher),
		});
		return this;
	}

	/** As the web3.js `IkaTransaction.setSignatureVoucherSigningKey`. */
	setSignatureVoucherSigningKey(params: { signatureVoucher: Address }): IkaTransaction {
		this.#inner.setSignatureVoucherSigningKey({
			signatureVoucher: publicKey(params.signatureVoucher),
		});
		return this;
	}

	/** As the web3.js `IkaTransaction.revokeSignatureVoucher`. */
	revokeSignatureVoucher(params: { signatureVoucher: Address }): IkaTransaction {
		this.#inner.revokeSignatureVoucher({ signatureVoucher: publicKey(params.signatureVoucher) });
		return this;
	}

	/** As the web3.js `IkaTransaction.acceptEncryptedUserShare`. */
	acceptEncryptedUserShare(params: { dWallet: DWallet }): IkaTransaction {
		this.#inner.acceptEncryptedUserShare(params);
		return this;
	}

	/** As the web3.js `IkaTransaction.transferDWallet`. */
	transferDWallet(params: { dWallet: DWallet; newOwner: Address }): IkaTransaction {
		this.#inner.transferDWallet({ dWallet: params.dWallet, newOwner: publicKey(params.newOwner) });
		return this;
	}

	/** Run `issue`, and attach the keypair of the voucher it created as a kit signer. */
	async #issueVoucher(issue: () => Promise<PublicKey>): Promise<Address> {
		const voucher = await issue();
		const keypair = this.#inner.signers[this.#inner.signers.length - 1]!;
		const signer = await createKeyPairSignerFromBytes(keypair.secretKey);
		this.#voucherSigners.push(signer);
		this.#signers.set(signer.address, signer);
		return address(voucher.toBase58());
	}

	#toKit(instruction: TransactionInstruction): Instruction {
		return {
			programAddress: address(instruction.programId.toBase58()),
			accounts: instruction.keys.map(({ pubkey, isSigner, isWritable }) => {
				const account = address(pubkey.toBase58());
				const role = isSigner
					? isWritable
						? AccountRole.WRITABLE_SIGNER
						: AccountRole.READONLY_SIGNER
					: isWritable
						? AccountRole.WRITABLE
						: AccountRole.READONLY;
				const signer = isSigner ? this.#signers.get(account) : undefined;
				return signer === undefined
					? { address: account, role }
					: { address: account, role, signer };
			}),
			data: Uint8Array.from(instruction.data),
		};
	}
}

/** The web3.js reads `IkaTransaction` makes, answered by the kit client. */
function web3Client(ikaClient: IkaClient): IkaTransactionClient {
	return {
		get programId() {
			return publicKey(ikaClient.programId);
		},
		chainNumber: ikaClient.chainNumber,
		networkValue: ikaClient.networkValue,
		getDWalletCoordinator: () => ikaClient.getDWalletCoordinator(),
		getRequestPublicKey: (keys) => ikaClient.getRequestPublicKey(keys),
		checkDWalletUsable: (dWallet, keys) => ikaClient.checkDWalletUsable(dWallet, keys),
		getDWalletAddress: (dWallet) => publicKey(ikaClient.getDWalletAddress(dWallet)),
	};
}

function web3Approval(params: ApproveMessageParams): Web3ApproveMessageParams {
	return {
		...params,
		voucherOwner: params.voucherOwner === undefined ? undefined : publicKey(params.voucherOwner),
	};
}

function fromKit(instruction: Instruction): TransactionInstruction {
	return new TransactionInstruction({
		programId: publicKey(instruction.programAddress),
		keys: (instruction.accounts ?? []).map((account) => {
			if (!('address' in account)) {
				throw new Error('add instructions with their accounts by address, not by lookup table');
			}
			const { role } = account as AccountMeta;
			return {
				pubkey: publicKey(account.address),
				isSigner: role === AccountRole.READONLY_SIGNER || role === AccountRole.WRITABLE_SIGNER,
				isWritable: role === AccountRole.WRITABLE || role === AccountRole.WRITABLE_SIGNER,
			};
		}),
		data: Buffer.from(instruction.data ?? new Uint8Array(0)),
	});
}

/** A lookup table, as web3.js measures a transaction compiled against it. */
function lookupTable(table: Address, addresses: readonly Address[]): AddressLookupTableAccount {
	return new AddressLookupTableAccount({
		key: publicKey(table),
		state: {
			deactivationSlot: BigInt('0xffffffffffffffff'),
			lastExtendedSlot: 0,
			lastExtendedSlotStartIndex: 0,
			addresses: addresses.map(publicKey),
		},
	});
}

function addressOf(signer: Address | TransactionSigner): Address {
	return typeof signer === 'string' ? signer : signer.address;
}

function publicKey(account: Address): PublicKey {
	return new PublicKey(getAddressEncoder().encode(account));
}
