// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The ika-dwallet instructions a client sends, built as `@solana/web3.js`
 * transaction instructions.
 *
 * The rest of this package is transport-free and framework-free: it hands
 * back plain bytes. These builders are not, because an instruction is
 * a `TransactionInstruction` or it is nothing.
 *
 * That is why this module is a subpath —
 * `@ika.xyz/pre-alpha-solana/instructions` — and not part of the
 * root entry. `@solana/web3.js` is a peer dependency, and importing this
 * subpath is what requires it. A consumer that imports only the root entry
 * needs nothing installed, and `test/root-entry.test.ts` typechecks the
 * root with `@solana/web3.js` absent to keep that true.
 *
 * Every instruction byte here comes from the program's wire table (`src/wire-tables-data.ts`)
 * by name, and every account list is in the order the program reads the
 * instruction's accounts in. Three demos each wrote their own
 * copy of these before this module existed, and one of them sent
 * instruction byte 24, another instruction, to transfer a dWallet's
 * ownership.
 */
import { Buffer } from 'buffer';
import { crossCheckedRead } from '@ika.xyz/pre-alpha-core';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
	Ed25519Program,
	PublicKey,
	SystemProgram,
	TransactionInstruction,
} from '@solana/web3.js';

import {
	dwalletCoordinatorPda,
	dwalletPda,
	encryptedUserSecretKeySharePda,
	encryptionKeyPda,
	findProgramAddress,
	gasDepositPda,
	networkEncryptionKeyPda,
} from './addresses.js';
import { requireApprovalUsability, type ApprovalUsability, type ReadAccount } from './usability.js';
import {
	accountEntry,
	accountHeader,
	instructionByte,
} from './wire-tables.js';

/** The SPL token program, which moves the IKA a top-up deposits. */
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

/** The instructions sysvar, which a deposit's proof is read back out of. */
export const INSTRUCTIONS_SYSVAR_ID = new PublicKey('Sysvar1nstructions1111111111111111111111111');

/**
 * The key a client signs its gRPC requests with.
 *
 * `secretKey` is the 32-byte Ed25519 seed, which is what the SDK's
 * `generateTransportKeypair` returns. A `@solana/web3.js` keypair keeps the
 * seed followed by the public key in one 64-byte array, so a caller holding
 * one passes `keypair.secretKey.slice(0, 32)`.
 */
export interface RequestSigningKeypair {
	publicKey: Uint8Array;
	secretKey: Uint8Array;
}

/** The program's single coordinator account, which records the epoch. */
export function coordinatorAddress(programId: PublicKey): PublicKey {
	return new PublicKey(dwalletCoordinatorPda(programId.toBytes()).address);
}

/** One request-signing key's gas deposit, and the bump its address needs. */
export function gasDepositAddress(
	programId: PublicKey,
	requestPublicKey: Uint8Array,
): [PublicKey, number] {
	const derived = gasDepositPda(programId.toBytes(), requestPublicKey);
	return [new PublicKey(derived.address), derived.bump];
}

/** The domain of the gas-deposit proof of possession, the same on every chain. */
export const DEPOSIT_PROOF_DOMAIN = 'ika_protocol::gas::proof_of_possession';

/** The version of the proof of possession, its first two bytes as a little-endian u16. */
export const DEPOSIT_PROOF_MESSAGE_VERSION = 2;

/** The incarnation a first create opens. Each reopen of a closed deposit opens the next one. */
export const FIRST_GAS_DEPOSIT_INCARNATION = 1n;

/**
 * The bytes a request key signs to prove it consents to the life
 * `incarnation` of a gas deposit whose withdrawals `sender` controls, on the
 * chain numbered `chainNumber`, in the deployment whose network is
 * `network`:
 * - the message version 2 as a little-endian u16;
 * - `DEPOSIT_PROOF_DOMAIN`;
 * - the chain number as four little-endian bytes;
 * - the network as one byte;
 * - the sender's length, one byte;
 * - the sender's 32 bytes;
 * - the incarnation as eight little-endian bytes: 1 for a first create (the
 *   default), the deposit's incarnation plus one for a reopen. A proof opens
 *   exactly that life, so the proof of a life that ended never reopens the
 *   deposit.
 *
 * `chainNumber` and `network` are the ones the coordinator records
 * (`readDWalletCoordinator`); take them from your own configuration. The
 * chain number is the same on every network, so the network keeps a testnet
 * proof from opening a deposit on mainnet. The chain's ERC-7930 label is not
 * in the message, so a change of the label leaves a proof valid. This is
 * what the program rebuilds and compares against.
 */
export function depositProofMessage(
	chainNumber: number,
	network: number,
	sender: Uint8Array,
	incarnation: bigint = FIRST_GAS_DEPOSIT_INCARNATION,
): Uint8Array {
	const domain = new TextEncoder().encode(DEPOSIT_PROOF_DOMAIN);
	const message = new Uint8Array(2 + domain.length + 4 + 1 + 1 + sender.length + 8);
	const view = new DataView(message.buffer);
	view.setUint16(0, DEPOSIT_PROOF_MESSAGE_VERSION, true);
	let offset = 2;
	message.set(domain, offset);
	offset += domain.length;
	view.setUint32(offset, chainNumber, true);
	offset += 4;
	message[offset] = network;
	offset += 1;
	message[offset] = sender.length;
	message.set(sender, offset + 1);
	view.setBigUint64(offset + 1 + sender.length, incarnation, true);
	return message;
}

/**
 * The two instructions that open a gas deposit.
 *
 * The network charges the key that SIGNED a request rather than the
 * transaction's fee payer, so the deposit pays for `requestKey`'s requests.
 * The `sender` signs the transaction and OWNS the deposit: only the
 * sender's signature requests a withdrawal, and the network's payout sends
 * the SOL to the sender. The request key cannot withdraw. A browser page
 * may hold a request key in memory while the connected wallet opens the
 * deposit; losing the request key loses no funds, because the wallet owns
 * them. The owner may be a program's address that signs through
 * `invoke_signed`, and `transferGasDepositInstruction` hands the deposit
 * to a new owner.
 *
 * That is what the proof of possession is for. The request key signs a
 * message naming the SENDER's address, and the program does not take that
 * proof from its own instruction data — it looks back at the instruction
 * immediately before, which the Solana runtime has already verified, and
 * checks the key, the signature and the message are the ones it requires.
 * So the Ed25519 instruction has to be first, and these two have to go into
 * the same transaction in this order.
 *
 * The proof can be signed elsewhere: pass the request key's public key and
 * its signature of `depositProofMessage` as `requestKey`. That is how an app
 * creates a deposit for a user's key, as `sender`, without the user's secret.
 */
export function createDepositInstructions(params: {
	programId: PublicKey;
	/** Signs the transaction and owns the deposit. The proof of possession names it. */
	sender: PublicKey;
	/** Pays for the deposit's account. Defaults to `sender`. */
	payer?: PublicKey;
	/**
	 * The key the deposit is for, and the key every request is charged to:
	 * its secret key, or its public key and its proof already signed.
	 */
	requestKey: RequestSigningKeypair | { publicKey: Uint8Array; proofOfPossession: Uint8Array };
	/**
	 * This chain's chain number, as the coordinator records it
	 * (`readDWalletCoordinator`).
	 */
	chainNumber: number;
	/**
	 * This deployment's network, as the coordinator records it: 1 mainnet, 2
	 * testnet, 3 a local network.
	 */
	network: number;
	/**
	 * What the deposit is funded with as it is created: IKA (in base units,
	 * 10^-8 IKA: one IKA is 100,000,000) from `ikaTokenAccount` into the
	 * coordinator's `treasuryVault`, and SOL from the payer. `solAmount` is
	 * all the SOL the instruction moves: it includes the coordinator's
	 * deposit fee, which the program sends to the fee recipient, and the
	 * deposit is credited the rest. The program refuses a `solAmount` below
	 * the fee (`BelowDepositFee`), and a creation that leaves the credited
	 * deposit below the coordinator's minimum first deposit in either coin.
	 * `IkaTransaction.createFundedGasDeposit` takes the amount to credit and
	 * adds the fee itself.
	 * Omitted, the deposit is opened empty, which only a coordinator with no
	 * minimum accepts. The vault is checked only when IKA moves.
	 */
	funding?: {
		ikaTokenAccount: PublicKey;
		treasuryVault: PublicKey;
		ikaAmount: bigint;
		solAmount: bigint;
	};
	/**
	 * The coordinator's deposit fee recipient (`readDWalletCoordinator`'s
	 * `depositFee.recipient`): the payer pays it the deposit fee out of
	 * `funding.solAmount`. Defaults to the payer, which only a coordinator
	 * with no fee accepts.
	 */
	feeRecipient?: PublicKey;
	/**
	 * The life the create opens, which the proof of possession names: 1
	 * (the default) for a request key with no deposit, and the closed
	 * deposit's incarnation plus one for a reopen. The program refuses a
	 * proof of any other life.
	 */
	incarnation?: bigint;
}): TransactionInstruction[] {
	const { programId, sender, requestKey, chainNumber, network } = params;
	const payer = params.payer ?? sender;
	const feeRecipient = params.feeRecipient ?? payer;
	const funding = params.funding ?? {
		ikaTokenAccount: payer,
		treasuryVault: payer,
		ikaAmount: 0n,
		solAmount: 0n,
	};
	const [deposit, bump] = gasDepositAddress(programId, requestKey.publicKey);

	const message = depositProofMessage(
		chainNumber,
		network,
		sender.toBytes(),
		params.incarnation ?? FIRST_GAS_DEPOSIT_INCARNATION,
	);
	const signature =
		'secretKey' in requestKey
			? ed25519.sign(message, requestKey.secretKey)
			: requestKey.proofOfPossession;

	const data = new Uint8Array(114);
	data[0] = instructionByte('DWalletCreateDeposit');
	data.set(requestKey.publicKey, 1);
	data.set(signature, 33);
	data[97] = bump;
	const amounts = new DataView(data.buffer, data.byteOffset, data.byteLength);
	amounts.setBigUint64(98, funding.ikaAmount, true);
	amounts.setBigUint64(106, funding.solAmount, true);

	return [
		Ed25519Program.createInstructionWithPublicKey({
			publicKey: requestKey.publicKey,
			message,
			signature,
		}),
		new TransactionInstruction({
			programId,
			keys: [
				{ pubkey: sender, isSigner: true, isWritable: false },
				{ pubkey: deposit, isSigner: false, isWritable: true },
				{ pubkey: coordinatorAddress(programId), isSigner: false, isWritable: false },
				{ pubkey: payer, isSigner: true, isWritable: true },
				{ pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
				{ pubkey: INSTRUCTIONS_SYSVAR_ID, isSigner: false, isWritable: false },
				{ pubkey: funding.ikaTokenAccount, isSigner: false, isWritable: true },
				{ pubkey: funding.treasuryVault, isSigner: false, isWritable: true },
				{ pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
				{ pubkey: eventAuthorityAddress(programId), isSigner: false, isWritable: false },
				{ pubkey: programId, isSigner: false, isWritable: false },
				{ pubkey: feeRecipient, isSigner: false, isWritable: true },
			],
			data: Buffer.from(data),
		}),
	];
}

/**
 * Add IKA and SOL to a deposit that already exists.
 *
 * The program checks the treasury vault against the coordinator's own
 * record whatever the amounts are, so even a top-up of pure SOL has to name
 * the real one. Only a transfer of IKA reads the token account, so a
 * SOL-only top-up may name any account the payer owns and leave it
 * untouched. The program refuses a top-up that leaves the deposit's balance
 * net of debt below the coordinator's minimum first deposit in either coin.
 */
export function topUpInstruction(params: {
	programId: PublicKey;
	deposit: PublicKey;
	/** Signs and pays, and the SOL comes out of it. */
	payer: PublicKey;
	ikaTokenAccount: PublicKey;
	treasuryVault: PublicKey;
	/**
	 * IKA in the base units of the Solana IKA mint. The mint has eight
	 * decimals, so one unit is 10^-8 IKA and one IKA is `100_000_000n`.
	 */
	ikaAmount: bigint;
	/**
	 * All the SOL the instruction moves, the coordinator's deposit fee
	 * included: the program sends the fee to the fee recipient and credits
	 * the rest. So an IKA-only top-up passes exactly the fee here.
	 * `IkaTransaction.topUpGasDeposit` takes the amount to credit and adds
	 * the fee itself.
	 */
	solAmount: bigint;
	/**
	 * The coordinator's deposit fee recipient, which the payer pays the
	 * deposit fee. Defaults to the payer, which only a coordinator with no
	 * fee accepts.
	 */
	feeRecipient?: PublicKey;
}): TransactionInstruction {
	const { programId, deposit, payer, ikaTokenAccount, treasuryVault, ikaAmount, solAmount } =
		params;
	const feeRecipient = params.feeRecipient ?? payer;

	const data = new Uint8Array(17);
	data[0] = instructionByte('DWalletTopUp');
	const amounts = new DataView(data.buffer, data.byteOffset, data.byteLength);
	amounts.setBigUint64(1, ikaAmount, true);
	amounts.setBigUint64(9, solAmount, true);

	return new TransactionInstruction({
		programId,
		keys: [
			{ pubkey: deposit, isSigner: false, isWritable: true },
			{ pubkey: coordinatorAddress(programId), isSigner: false, isWritable: false },
			{ pubkey: ikaTokenAccount, isSigner: false, isWritable: true },
			{ pubkey: treasuryVault, isSigner: false, isWritable: true },
			{ pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
			{ pubkey: payer, isSigner: true, isWritable: true },
			{ pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
			{ pubkey: eventAuthorityAddress(programId), isSigner: false, isWritable: false },
			{ pubkey: programId, isSigner: false, isWritable: false },
			{ pubkey: feeRecipient, isSigner: false, isWritable: true },
		],
		data: Buffer.from(data),
	});
}

/**
 * Request the withdrawal of the whole gas deposit.
 *
 * Only the deposit's owner signs it: the wallet that opened the deposit, or
 * the owner a `TransferGasDeposit` named since. The request key cannot. The
 * request carries no amount. The network then pays it itself: it takes the
 * withdrawal's charge first, then sends everything left after debt and the
 * charge, the SOL to the owner and the IKA to `ikaDestination`. There is no
 * claim step. A request is final: there is no cancel, and a second request
 * while one is pending is refused. A payout that pays everything closes the
 * deposit, and an owner who wants to keep spending reopens it with a create.
 */
export function requestWithdrawInstruction(params: {
	programId: PublicKey;
	/** The deposit's owner, which has to sign. It receives the SOL. */
	owner: PublicKey;
	deposit: PublicKey;
	/** An open token account of the IKA mint, which receives the IKA. */
	ikaDestination: PublicKey;
	/**
	 * The deposit's life the request is for. The program refuses another one
	 * (`GasDepositIncarnationMismatch`) and a closed deposit (`DepositClosed`).
	 */
	incarnation: bigint;
}): TransactionInstruction {
	const { programId, owner, deposit, ikaDestination, incarnation } = params;

	const data = new Uint8Array(9);
	data[0] = instructionByte('DWalletRequestWithdraw');
	new DataView(data.buffer).setBigUint64(1, incarnation, true);

	return new TransactionInstruction({
		programId,
		keys: [
			{ pubkey: owner, isSigner: true, isWritable: false },
			{ pubkey: deposit, isSigner: false, isWritable: true },
			{ pubkey: coordinatorAddress(programId), isSigner: false, isWritable: false },
			{ pubkey: ikaDestination, isSigner: false, isWritable: false },
			{ pubkey: eventAuthorityAddress(programId), isSigner: false, isWritable: false },
			{ pubkey: programId, isSigner: false, isWritable: false },
		],
		data: Buffer.from(data),
	});
}

/**
 * Hand a gas deposit to a new owner.
 *
 * The current owner signs and names the new owner, who alone requests the
 * deposit's withdrawals from then on. The request key the deposit pays for
 * does not change. The program refuses a transfer while a withdrawal request
 * is pending (`TransferWhileWithdrawalPending`): a request is final, and only
 * the network's payout ends it.
 */
export function transferGasDepositInstruction(params: {
	programId: PublicKey;
	/** The current owner, which has to sign. */
	owner: PublicKey;
	deposit: PublicKey;
	newOwner: PublicKey;
	/** The deposit's life the transfer is for, as for a request. */
	incarnation: bigint;
}): TransactionInstruction {
	const { programId, owner, deposit, newOwner, incarnation } = params;

	const data = new Uint8Array(41);
	data[0] = instructionByte('DWalletTransferGasDeposit');
	data.set(newOwner.toBytes(), 1);
	new DataView(data.buffer).setBigUint64(33, incarnation, true);

	return new TransactionInstruction({
		programId,
		keys: [
			{ pubkey: owner, isSigner: true, isWritable: false },
			{ pubkey: deposit, isSigner: false, isWritable: true },
			{ pubkey: eventAuthorityAddress(programId), isSigner: false, isWritable: false },
			{ pubkey: programId, isSigner: false, isWritable: false },
		],
		data: Buffer.from(data),
	});
}

/**
 * Hand a dWallet to a new owner.
 *
 * A client creates its dWallet as itself and then usually gives it to a
 * program, because that program's governance is what should decide what
 * gets signed from then on. After this the old owner can no longer issue
 * vouchers on it. A voucher it issued before keeps its own owner and still
 * authorizes its signature.
 */
export function transferOwnershipInstruction(params: {
	programId: PublicKey;
	/** The current owner, which has to sign. */
	owner: PublicKey;
	dwallet: PublicKey;
	/** Usually a program's signing address. */
	newOwner: PublicKey;
}): TransactionInstruction {
	const { programId, owner, dwallet, newOwner } = params;

	const data = new Uint8Array(33);
	data[0] = instructionByte('DWalletTransferOwnership');
	data.set(newOwner.toBytes(), 1);

	return new TransactionInstruction({
		programId,
		keys: [
			{ pubkey: owner, isSigner: true, isWritable: false },
			{ pubkey: dwallet, isSigner: false, isWritable: true },
		],
		data: Buffer.from(data),
	});
}

/** `IssueSignatureVoucher`'s flag that says the data names an owner. */
const ISSUE_VOUCHER_HAS_OWNER = 1;
/** `IssueSignatureVoucher`'s flag that says the data names a signing key. */
const ISSUE_VOUCHER_HAS_SIGNING_KEY = 2;

/**
 * Issue a signature voucher for one message on a dWallet the caller owns.
 *
 * This is the on-chain half of a signature and the network will not produce
 * one without it. The sign request names the voucher's address, and
 * validators read the account there themselves and vote on what each of
 * them sees; the request carries no proof of it at all.
 *
 * `voucher` is a fresh address, usually a new keypair's. It must sign the
 * transaction: that signature is what lets the program create the account
 * there. One voucher authorizes one signature, so a second signature of the
 * same message needs a second voucher.
 *
 * `requestPublicKey` is the key that will sign the gRPC sign request. The
 * program stores it and validators refuse a request from any other key, so
 * issuing for one key and signing with another fails at the network rather
 * than on chain. Leave it out to issue a voucher with no key; the network
 * signs nothing for it until its owner sets one
 * (`setVoucherSigningKeyInstruction`).
 *
 * `voucherOwner` controls the voucher afterwards. It defaults to `owner`,
 * the dWallet's owner that issues it.
 *
 * `usability` proves that the user's key holds the dWallet's share
 * (`ApprovalUsability`): the result of the SDK's `assertDWalletUsable` for
 * this dWallet, or a function that runs it. Without it, or with a result for
 * another dWallet or key, the builder refuses and builds nothing.
 */
export async function issueSignatureVoucherInstruction(params: {
	programId: PublicKey;
	/** The dWallet's owner, which has to sign. It pays unless `payer` is given. */
	owner: PublicKey;
	dwallet: PublicKey;
	/** The fresh address the voucher is created at. It has to sign. */
	voucher: PublicKey;
	messageDigest: Uint8Array;
	/** All zero when the scheme carries no metadata, which is the default. */
	messageMetadataDigest?: Uint8Array;
	signatureScheme: number;
	requestPublicKey?: Uint8Array;
	voucherOwner?: PublicKey;
	/** Pays for the voucher's account. Defaults to `owner`. */
	payer?: PublicKey;
	usability: ApprovalUsability;
}): Promise<TransactionInstruction> {
	const {
		programId,
		owner,
		dwallet,
		voucher,
		messageDigest,
		messageMetadataDigest = new Uint8Array(32),
		signatureScheme,
		requestPublicKey,
		voucherOwner,
		usability,
	} = params;
	await requireApprovalUsability(usability, dwallet.toBytes());

	const flags =
		(voucherOwner === undefined ? 0 : ISSUE_VOUCHER_HAS_OWNER) |
		(requestPublicKey === undefined ? 0 : ISSUE_VOUCHER_HAS_SIGNING_KEY);
	const optional = [voucherOwner?.toBytes(), requestPublicKey].filter(
		(field): field is Uint8Array => field !== undefined,
	);
	const data = new Uint8Array(68 + 32 * optional.length);
	data[0] = instructionByte('DWalletIssueSignatureVoucher');
	data.set(messageDigest, 1);
	data.set(messageMetadataDigest, 33);
	new DataView(data.buffer, data.byteOffset, data.byteLength).setUint16(65, signatureScheme, true);
	data[67] = flags;
	optional.forEach((field, index) => data.set(field, 68 + 32 * index));

	return new TransactionInstruction({
		programId,
		keys: [
			{ pubkey: coordinatorAddress(programId), isSigner: false, isWritable: false },
			{ pubkey: voucher, isSigner: true, isWritable: true },
			{ pubkey: dwallet, isSigner: false, isWritable: false },
			{ pubkey: owner, isSigner: true, isWritable: false },
			{ pubkey: params.payer ?? owner, isSigner: true, isWritable: true },
			{ pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
		],
		data: Buffer.from(data),
	});
}

/**
 * Issue a future signature voucher: the right to have the network sign one
 * message once, in two steps, with one dWallet the caller owns.
 *
 * The parameters and the accounts are `issueSignatureVoucherInstruction`'s;
 * only the instruction byte differs. `requestPublicKey` is the key the
 * step-1 request must come from. Step 1 clears it, so the voucher's owner
 * sets the completion's key afterwards with
 * `setVoucherSigningKeyInstruction`. The owner's controls
 * (`setVoucherSigningKeyInstruction`, `revokeSignatureVoucherInstruction`,
 * `transferSignatureVoucherInstruction`) act on a future voucher too.
 */
export async function issueFutureSignatureVoucherInstruction(
	params: Parameters<typeof issueSignatureVoucherInstruction>[0],
): Promise<TransactionInstruction> {
	const instruction = await issueSignatureVoucherInstruction(params);
	instruction.data[0] = instructionByte('DWalletIssueFutureSignatureVoucher');
	return instruction;
}

/**
 * The kind byte of a signing parameter: which of the coordinator's three
 * lists of paused signing parameters a value belongs to. The value itself is
 * the node's own index: the BCS variant index of its `DWalletCurve`,
 * `DWalletSignatureAlgorithm` or `DWalletHashScheme`.
 */
export const SIGNING_PARAMETER_CURVE = 0;
export const SIGNING_PARAMETER_SIGNATURE_ALGORITHM = 1;
export const SIGNING_PARAMETER_HASH_SCHEME = 2;

/** The program's event authority, which signs the event every change emits. */
function eventAuthorityAddress(programId: PublicKey): PublicKey {
	const seed = new TextEncoder().encode('__event_authority');
	return new PublicKey(findProgramAddress([seed], programId.toBytes()).address);
}

/**
 * `PauseSigningParameter` or `UnpauseSigningParameter`, by name.
 *
 * The accounts are in the order the program reads them: the coordinator, the signer, the event authority and the
 * program, and the signing network key's own record last when the signer is
 * a network key. The pauser passes no record.
 */
function signingParameterInstruction(
	name: 'DWalletPauseSigningParameter' | 'DWalletUnpauseSigningParameter',
	params: {
		programId: PublicKey;
		/** The coordinator's pauser, or a network key. */
		signer: PublicKey;
		/** True when `signer` is a network key rather than the pauser. */
		signerIsNetworkKey?: boolean;
		/** `SIGNING_PARAMETER_CURVE`, `_SIGNATURE_ALGORITHM` or `_HASH_SCHEME`. */
		kind: number;
		value: number;
	},
): TransactionInstruction {
	const { programId, signer, signerIsNetworkKey = false, kind, value } = params;

	const data = new Uint8Array(6);
	data[0] = instructionByte(name);
	data[1] = kind;
	new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(2, value, true);

	const keys = [
		{ pubkey: coordinatorAddress(programId), isSigner: false, isWritable: true },
		{ pubkey: signer, isSigner: true, isWritable: false },
		{ pubkey: eventAuthorityAddress(programId), isSigner: false, isWritable: false },
		{ pubkey: programId, isSigner: false, isWritable: false },
	];
	if (signerIsNetworkKey) {
		keys.push({
			pubkey: new PublicKey(networkEncryptionKeyPda(programId.toBytes(), signer.toBytes()).address),
			isSigner: false,
			isWritable: false,
		});
	}
	return new TransactionInstruction({ programId, keys, data: Buffer.from(data) });
}

/**
 * Pause one curve, signature algorithm or hash scheme for every dWallet
 * request. The pauser or the network signs.
 *
 * The program only records the value. The validators read the coordinator,
 * agree its lists and refuse a request that names a paused value, whichever
 * chain the request names. Pausing a value that is already paused changes
 * nothing.
 */
export function pauseSigningParameterInstruction(
	params: Parameters<typeof signingParameterInstruction>[1],
): TransactionInstruction {
	return signingParameterInstruction('DWalletPauseSigningParameter', params);
}

/**
 * Unpause one curve, signature algorithm or hash scheme, whoever paused it.
 * The pauser or the network signs. A value paused on the Sui coordinator as
 * well stays paused until it is unpaused there too.
 */
export function unpauseSigningParameterInstruction(
	params: Parameters<typeof signingParameterInstruction>[1],
): TransactionInstruction {
	return signingParameterInstruction('DWalletUnpauseSigningParameter', params);
}

/** The only holder signature scheme a registration accepts: Ed25519, 0. */
export const ENCRYPTION_KEY_ED25519_SIGNATURE_SCHEME = 0;

/** The domain that starts every registration message, the same on Sui. */
export const ENCRYPTION_KEY_REGISTRATION_DOMAIN = 'ika_encryption_key';

/** `value` as ULEB128, the length prefix of a BCS byte vector. */
function uleb128(value: number): number[] {
	const bytes: number[] = [];
	let rest = value;
	do {
		const low = rest & 0x7f;
		rest = Math.floor(rest / 128);
		bytes.push(rest === 0 ? low : low | 0x80);
	} while (rest !== 0);
	return bytes;
}

/** The version of the registration message, its first two bytes as a little-endian u16. */
export const ENCRYPTION_KEY_REGISTRATION_MESSAGE_VERSION = 1;

/** `value` as four little-endian bytes, the BCS of a u32. */
function u32LittleEndian(value: number): number[] {
	return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/**
 * The message a holder signs to make `encryptionKey` its key for `curve` on
 * the chain numbered `chainNumber`, the one the Sui package builds
 * (`encryption_key::registration_message`) with this chain's number, and the
 * one the program expects. It is the BCS of:
 * - the message version 1 as a little-endian u16;
 * - the domain as a byte vector;
 * - the chain number as four little-endian bytes;
 * - the network as one byte;
 * - the curve as a little-endian u16;
 * - the key as a byte vector.
 *
 * `chainNumber` and `network` are the ones the coordinator records
 * (`readDWalletCoordinator`). The chain number is the same on every network,
 * so the network keeps a registration signed for testnet from being sent on
 * mainnet. The chain's ERC-7930 label is not in the message, so a
 * registration signed before the network changes the label still verifies
 * after it.
 */
export function encryptionKeyRegistrationMessage(
	chainNumber: number,
	network: number,
	curve: number,
	encryptionKey: Uint8Array,
): Uint8Array {
	const domain = new TextEncoder().encode(ENCRYPTION_KEY_REGISTRATION_DOMAIN);
	return Uint8Array.from([
		ENCRYPTION_KEY_REGISTRATION_MESSAGE_VERSION & 0xff,
		(ENCRYPTION_KEY_REGISTRATION_MESSAGE_VERSION >> 8) & 0xff,
		...uleb128(domain.length),
		...domain,
		...u32LittleEndian(chainNumber),
		network & 0xff,
		curve & 0xff,
		(curve >> 8) & 0xff,
		...uleb128(encryptionKey.length),
		...encryptionKey,
	]);
}

/**
 * The signature a registration carries, made with the holder's Ed25519 seed
 * (`holder.secretKey`, 32 bytes) over the registration message.
 */
export function signEncryptionKeyRegistration(
	holder: RequestSigningKeypair,
	chainNumber: number,
	network: number,
	curve: number,
	encryptionKey: Uint8Array,
): Uint8Array {
	return ed25519.sign(
		encryptionKeyRegistrationMessage(chainNumber, network, curve, encryptionKey),
		holder.secretKey,
	);
}

/**
 * The Ed25519 precompile instruction a registration or a share's accept
 * needs: one signature by the holder over the registration message or the
 * share's acceptance digest. Every pointer
 * names this instruction's own data (instruction index `0xffff`), which is
 * the only form the program accepts.
 */
function registrationPrecompileInstruction(
	holderPublicKey: Uint8Array,
	message: Uint8Array,
	signature: Uint8Array,
): TransactionInstruction {
	const publicKeyOffset = 2 + 14;
	const signatureOffset = publicKeyOffset + 32;
	const messageOffset = signatureOffset + 64;

	const data = new Uint8Array(messageOffset + message.length);
	const view = new DataView(data.buffer);
	data[0] = 1;
	const fields = [
		signatureOffset,
		0xffff,
		publicKeyOffset,
		0xffff,
		messageOffset,
		message.length,
		0xffff,
	];
	fields.forEach((value, index) => view.setUint16(2 + index * 2, value, true));
	data.set(holderPublicKey, publicKeyOffset);
	data.set(signature, signatureOffset);
	data.set(message, messageOffset);

	return new TransactionInstruction({
		programId: Ed25519Program.programId,
		keys: [],
		data: Buffer.from(data),
	});
}

/**
 * The two instructions that register a holder's encryption key for one curve
 * in the registry: the Ed25519 precompile with the holder's signature over
 * the registration message, then `RegisterEncryptionKey`.
 *
 * Anyone may send them and pay, so the signature is taken as an argument: the
 * holder makes it with `signEncryptionKeyRegistration`, and a relayer can
 * submit it. The program reads the key and the signature from the
 * precompile, which must be the instruction immediately before, so these two
 * go into one transaction in this order. One entry exists per holder and
 * curve, and a second registration is refused. To change keys, a holder
 * registers a new key under a new signing key and re-encrypts its shares to
 * that new holder.
 */
export function registerEncryptionKeyInstructions(params: {
	programId: PublicKey;
	/** Signs and pays the transaction. */
	payer: PublicKey;
	/** The holder's Ed25519 public key, 32 bytes. */
	holderPublicKey: Uint8Array;
	/** The chain number the coordinator records. */
	chainNumber: number;
	/** The network the coordinator records: 1 mainnet, 2 testnet, 3 a local network. */
	network: number;
	/**
	 * The node's curve number: 0 secp256k1, 1 secp256r1, 2 Curve25519, 3 Ristretto.
	 * A class-groups encryption key encrypts integers modulo one group order, the
	 * order of the curve it was registered for. Curve25519 and Ristretto share one
	 * order, so a key's bytes do not say which of the two it is for. The registry
	 * keeps one entry per holder and curve, and the entry, not the key, says which
	 * curve it serves.
	 */
	curve: number;
	/** The class-groups encryption key's exact bytes. */
	encryptionKey: Uint8Array;
	/** The holder's signature over the registration message. */
	signature: Uint8Array;
}): TransactionInstruction[] {
	const {
		programId,
		payer,
		holderPublicKey,
		chainNumber,
		network,
		curve,
		encryptionKey,
		signature,
	} = params;
	const entry = encryptionKeyPda(programId.toBytes(), holderPublicKey, curve);

	const data = new Uint8Array(37);
	data[0] = instructionByte('DWalletRegisterEncryptionKey');
	data.set(holderPublicKey, 1);
	data[33] = ENCRYPTION_KEY_ED25519_SIGNATURE_SCHEME;
	new DataView(data.buffer, data.byteOffset, data.byteLength).setUint16(34, curve, true);
	data[36] = entry.bump;

	return [
		registrationPrecompileInstruction(
			holderPublicKey,
			encryptionKeyRegistrationMessage(chainNumber, network, curve, encryptionKey),
			signature,
		),
		new TransactionInstruction({
			programId,
			keys: [
				{ pubkey: new PublicKey(holderPublicKey), isSigner: false, isWritable: false },
				{ pubkey: new PublicKey(entry.address), isSigner: false, isWritable: true },
				{ pubkey: coordinatorAddress(programId), isSigner: false, isWritable: false },
				{ pubkey: payer, isSigner: true, isWritable: true },
				{ pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
				{ pubkey: INSTRUCTIONS_SYSVAR_ID, isSigner: false, isWritable: false },
				{ pubkey: eventAuthorityAddress(programId), isSigner: false, isWritable: false },
				{ pubkey: programId, isSigner: false, isWritable: false },
			],
			data: Buffer.from(data),
		}),
	];
}

/**
 * The two instructions that accept a holder's encrypted share of a dWallet:
 * the Ed25519 precompile with the holder's signature over the digest the
 * share stores, then `AcceptEncryptedUserShare`.
 *
 * The digest is the keccak256 of the dWallet's attestation for a dWallet's
 * first share, and of the share's own attestation for a re-encrypted share;
 * `sdk/core`'s share-acceptance helpers compute and sign it. Anyone may send
 * these and pay, so the signature is taken as an argument. The program reads
 * the holder's key, the message and the signature from the precompile, which
 * must be the instruction immediately before, so the two go into one
 * transaction in this order. Accepting any share of a waiting dWallet makes it
 * Active, as a make-public does; the program refuses a voucher until then.
 */
export function acceptEncryptedUserShareInstructions(params: {
	programId: PublicKey;
	/** The dWallet's curve, in the node's numbering. */
	curve: number;
	/** The dWallet's public key. */
	dwalletPublicKey: Uint8Array;
	/** The import request's session identifier, for an imported dWallet only. */
	importedSessionIdentifier?: Uint8Array;
	/** The holder's Ed25519 public key, 32 bytes: the share's address ends in it. */
	holderPublicKey: Uint8Array;
	/** The digest the share stores, which the holder signed. */
	acceptanceDigest: Uint8Array;
	/** The holder's Ed25519 signature over `acceptanceDigest`. */
	signature: Uint8Array;
}): TransactionInstruction[] {
	const {
		programId,
		curve,
		dwalletPublicKey,
		importedSessionIdentifier,
		holderPublicKey,
		acceptanceDigest,
		signature,
	} = params;
	const program = programId.toBytes();
	const dwallet = dwalletPda(program, curve, dwalletPublicKey, importedSessionIdentifier);
	const share = encryptedUserSecretKeySharePda(
		program,
		curve,
		dwalletPublicKey,
		holderPublicKey,
		importedSessionIdentifier,
	);
	return [
		registrationPrecompileInstruction(holderPublicKey, acceptanceDigest, signature),
		new TransactionInstruction({
			programId,
			keys: [
				{ pubkey: coordinatorAddress(programId), isSigner: false, isWritable: false },
				{ pubkey: new PublicKey(dwallet.address), isSigner: false, isWritable: true },
				{ pubkey: new PublicKey(share.address), isSigner: false, isWritable: true },
				{ pubkey: INSTRUCTIONS_SYSVAR_ID, isSigner: false, isWritable: false },
				{ pubkey: eventAuthorityAddress(programId), isSigner: false, isWritable: false },
				{ pubkey: programId, isSigner: false, isWritable: false },
			],
			data: Buffer.from([instructionByte('DWalletAcceptEncryptedUserShare')]),
		}),
	];
}

/** A holder's registry entry, as `readEncryptionKey` returns it. */
export interface EncryptionKeyEntry {
	/** The entry account's address. */
	address: Uint8Array;
	/** The holder: the Ed25519 public key that made `signature`. */
	signerPublicKey: Uint8Array;
	/** The curve the encryption key is for, in the node's numbering. */
	curve: number;
	/**
	 * The holder's signature over the registration message of `encryptionKey`.
	 * `readEncryptionKey` verified it.
	 */
	signature: Uint8Array;
	/** The holder's signature scheme; 0 is Ed25519, the only one the reader returns. */
	signatureScheme: number;
	/** The class-groups encryption key's exact bytes. */
	encryptionKey: Uint8Array;
}

// The entry account (tag 107), as `EncryptionKeyData` in `ika-solana-accounts`
// reads it: the two-byte header, the holder's signer key (32 bytes), the
// signature scheme (1), the curve (2, little-endian), the key's length (2,
// little-endian), the signature (64), the creation epoch (8), the bump (1),
// eight reserved bytes, then the key, which ends the account. The fixed part
// is the table's `header_len`.

/**
 * Read the registry entry of the holder `holderPublicKey` for `curve`, at its
 * derived address, and verify the holder's signature over it. `getAccount`
 * reads one account by its 32-byte address and resolves `null` when none
 * exists (for example a wrapper around `Connection.getAccountInfo`).
 *
 * Rejects when the holder has no entry for that curve, when the account is
 * not owned by `programId`, when it does not carry the `EncryptionKey` tag or
 * is not exactly its fixed part followed by the key its length field names,
 * and when it names another holder or another curve.
 *
 * It then verifies the entry's stored signature, with Ed25519, under
 * `holderPublicKey`, the holder key the caller asked for. The signed message
 * is the registration message (`encryptionKeyRegistrationMessage`) of
 * `chainNumber`, `network`, the curve and the entry's key. It
 * rejects with "registry entry X is not signed by the holder" when the
 * signature does not verify, and when the entry's signature scheme is not
 * Ed25519. `chainNumber` and `network` are the chain number and the network
 * the program's coordinator records. Take them from your own configuration
 * of the chain, never from the RPC that serves the entry: an RPC that chose
 * them could serve an entry the holder signed for another chain or another
 * network. No entry is returned unverified.
 *
 * What the check proves: the returned key is a key the holder signed for this
 * chain and this curve. The RPC that serves the entry cannot forge that
 * signature. A holder has one entry per curve on chain, but the check does not
 * prove the RPC served that entry: it passes for any key the holder signed for
 * this chain and curve.
 *
 * So `crossCheck` names a second endpoint's `getAccount`, run by another
 * provider: the entry is then read and checked through both, and the read is
 * refused unless both serve the same key and signature. `'not-cross-checked'`
 * reads it through `getAccount` alone, which then decides what it says.
 * `crossCheck` is required.
 */
export async function readEncryptionKey(params: {
	programId: PublicKey;
	getAccount: (address: Uint8Array) => Promise<ReadAccount | null>;
	/**
	 * A second endpoint's `getAccount`, run by another provider, that the
	 * entry is cross-checked against, or `'not-cross-checked'`.
	 */
	crossCheck:
		{ getAccount: (address: Uint8Array) => Promise<ReadAccount | null> } | 'not-cross-checked';
	/** The chain number the coordinator records, from the caller's own configuration. */
	chainNumber: number;
	/** The network the coordinator records, from the caller's own configuration. */
	network: number;
	/** The holder's Ed25519 public key, 32 bytes. */
	holderPublicKey: Uint8Array;
	/** The dWallet curve the key is for: 0 secp256k1, 1 secp256r1, 2 Curve25519, 3 Ristretto. */
	curve: number;
}): Promise<EncryptionKeyEntry> {
	const { programId, getAccount, crossCheck, holderPublicKey, curve } = params;
	const address = encryptionKeyPda(programId.toBytes(), holderPublicKey, curve).address;
	const entryName = new PublicKey(address).toBase58();
	const checkedThrough = async (
		read: (address: Uint8Array) => Promise<ReadAccount | null>,
	): Promise<EncryptionKeyEntry | undefined> => {
		const account = await read(address);
		return account === null
			? undefined
			: checkedEncryptionKeyEntry(account, address, entryName, programId, params);
	};
	let entry: EncryptionKeyEntry | undefined;
	if (crossCheck === 'not-cross-checked') {
		entry = await checkedThrough(getAccount);
	} else if (typeof crossCheck?.getAccount === 'function') {
		// `getAccount` reports no slot, so the slot rule the Rust reader
		// applies (re-read the lagging endpoint at the other's slot, with
		// `minContextSlot`) cannot run here: every answer is at position 0.
		// An endpoint that has no entry yet is still read again until the
		// window ends, since a fresh entry may not have reached it. Two
		// different entries are refused at once: an entry never changes once
		// registered, so two honest endpoints never serve two of them.
		entry = await crossCheckedRead({
			endpoints: [
				'the first Solana endpoint (getAccount)',
				'the second Solana endpoint (crossCheck.getAccount)',
			],
			what: 'encryption key entry',
			read: async (endpoint) => ({
				position: 0n,
				value: await checkedThrough(endpoint === 0 ? getAccount : crossCheck.getAccount),
			}),
			equal: (first, second) =>
				bytesEqual(first.encryptionKey, second.encryptionKey) &&
				bytesEqual(first.signature, second.signature),
		});
	} else {
		throw new Error(
			"readEncryptionKey needs crossCheck: a second endpoint's { getAccount }, or " +
				"'not-cross-checked' to read the entry through one endpoint",
		);
	}
	if (entry === undefined) {
		throw new Error(
			`the holder has no registry entry for curve ${curve}: no account at ${entryName}`,
		);
	}
	return entry;
}

/** Whether two byte arrays hold the same bytes. */
function bytesEqual(first: Uint8Array, second: Uint8Array): boolean {
	return first.length === second.length && first.every((byte, index) => byte === second[index]);
}

/**
 * The registry entry `account`, read at `address`, after the checks
 * `readEncryptionKey` lists.
 */
function checkedEncryptionKeyEntry(
	account: ReadAccount,
	address: Uint8Array,
	entryName: string,
	programId: PublicKey,
	params: { chainNumber: number; network: number; holderPublicKey: Uint8Array; curve: number },
): EncryptionKeyEntry {
	const { chainNumber, network, holderPublicKey, curve } = params;
	if (!new PublicKey(account.owner).equals(programId)) {
		throw new Error(`account ${entryName} is not owned by the ika-dwallet program`);
	}
	const { data } = account;
	const table = accountEntry('EncryptionKey');
	const fixed = table.header_len ?? 0;
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	if (
		fixed === 0 ||
		data.length < fixed ||
		data[accountHeader.discriminator_offset] !== table.discriminator ||
		data.length !== fixed + view.getUint16(37, true)
	) {
		throw new Error(`account ${entryName} does not read as an EncryptionKey entry`);
	}
	const signerPublicKey = data.slice(2, 34);
	if (!new PublicKey(signerPublicKey).equals(new PublicKey(holderPublicKey))) {
		throw new Error(`registry entry ${entryName} names another holder`);
	}
	const storedCurve = view.getUint16(35, true);
	if (storedCurve !== curve) {
		throw new Error(`registry entry ${entryName} is for curve ${storedCurve}, not ${curve}`);
	}
	const signatureScheme = data[34];
	if (signatureScheme !== ENCRYPTION_KEY_ED25519_SIGNATURE_SCHEME) {
		throw new Error(`registry entry ${entryName} is not signed by the holder`);
	}
	const signature = data.slice(39, 103);
	const encryptionKey = data.slice(fixed);
	const signedMessage = encryptionKeyRegistrationMessage(
		chainNumber,
		network,
		curve,
		encryptionKey,
	);
	if (!ed25519.verify(signature, signedMessage, holderPublicKey)) {
		throw new Error(`registry entry ${entryName} is not signed by the holder`);
	}
	return {
		address,
		signerPublicKey,
		curve,
		signature,
		signatureScheme,
		encryptionKey,
	};
}

/**
 * A voucher control: the voucher, then its owner, which has to sign. The
 * order is the one the program reads a voucher control's accounts in.
 */
function voucherControlInstruction(
	programId: PublicKey,
	voucherOwner: PublicKey,
	voucher: PublicKey,
	data: Uint8Array,
): TransactionInstruction {
	return new TransactionInstruction({
		programId,
		keys: [
			{ pubkey: voucher, isSigner: false, isWritable: true },
			{ pubkey: voucherOwner, isSigner: true, isWritable: false },
		],
		data: Buffer.from(data),
	});
}

/**
 * Set which key may send the voucher's sign request. Only a pending voucher
 * takes a key.
 *
 * The network reads the voucher at finalized commitment, so a sign request
 * sent before this change is finalized can still be refused for the old
 * key, or for having none.
 */
export function setVoucherSigningKeyInstruction(params: {
	programId: PublicKey;
	/** The voucher's owner, which has to sign. */
	voucherOwner: PublicKey;
	voucher: PublicKey;
	/** The key a sign request must now come from. */
	requestPublicKey: Uint8Array;
}): TransactionInstruction {
	const { programId, voucherOwner, voucher, requestPublicKey } = params;
	const data = new Uint8Array(33);
	data[0] = instructionByte('DWalletSetVoucherSigningKey');
	data.set(requestPublicKey, 1);
	return voucherControlInstruction(programId, voucherOwner, voucher, data);
}

/**
 * Revoke a voucher, so the network agrees to no new sign request for it.
 * Only a pending voucher can be revoked, and a revoke is final. A sign the
 * network already agreed to before the revoke still runs, and its signature
 * is still written into the voucher.
 */
export function revokeSignatureVoucherInstruction(params: {
	programId: PublicKey;
	/** The voucher's owner, which has to sign. */
	voucherOwner: PublicKey;
	voucher: PublicKey;
}): TransactionInstruction {
	const { programId, voucherOwner, voucher } = params;
	return voucherControlInstruction(
		programId,
		voucherOwner,
		voucher,
		new Uint8Array([instructionByte('DWalletRevokeSignatureVoucher')]),
	);
}

/** Give a voucher to a new owner, in any state. */
export function transferSignatureVoucherInstruction(params: {
	programId: PublicKey;
	/** The voucher's current owner, which has to sign. */
	voucherOwner: PublicKey;
	voucher: PublicKey;
	newOwner: PublicKey;
}): TransactionInstruction {
	const { programId, voucherOwner, voucher, newOwner } = params;
	const data = new Uint8Array(33);
	data[0] = instructionByte('DWalletTransferSignatureVoucher');
	data.set(newOwner.toBytes(), 1);
	return voucherControlInstruction(programId, voucherOwner, voucher, data);
}
