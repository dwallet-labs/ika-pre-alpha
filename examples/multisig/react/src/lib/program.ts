import { Buffer } from 'buffer';
import { approvalMessageDigests } from '@ika.xyz/sdk-solana';
import { coordinatorAddress } from '@ika.xyz/sdk-solana/instructions';
import { Connection, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';

// This file is the MULTISIG program's own instructions and account layout.
// Everything about the dWallet program — its derived addresses, its
// instruction bytes, its account discriminators — comes from
// `@ika.xyz/sdk-solana`, which reads them from the program's own table. Before that package existed this file
// derived them itself, and one address it derived was wrong: it put the kind
// tag AFTER the variable-length root, so the page wrote an account at an
// address the validators never read.

// Byte layouts mirror the program (`examples/multisig/pinocchio/src/lib.rs`):
//   Multisig:    disc(1) ver(1) dwallet@2 threshold@34 member_count@36 tx_index@38 bump@42 members@43
//   Transaction: disc(1) ver(1) multisig@2 tx_index@34 proposer@38 message_hash@70 user_pubkey@102
//                signature_scheme@134 approval_count@136 rejection_count@138 status@140
//                signature_voucher_bump@141 future_sign@142 bump@143 message_data_len@144 message_data@146

export const MULTISIG_PROGRAM_ID = new PublicKey(
	import.meta.env.VITE_MULTISIG_PROGRAM_ID || 'BzDH6WHTaHMzmNHGezLYxTbVFPfSqGwY5o1BpLbwzbJ',
);
export const DWALLET_PROGRAM_ID = new PublicKey(
	import.meta.env.VITE_DWALLET_PROGRAM_ID || 'DWaL1c2nc3J3Eiduwq6EJovDfBPPH2gERKy1TqSkbRWq',
);

/**
 * The digest a message is authorized and signed under.
 *
 * The voucher stores it and the sign request carries the message it comes
 * from, so one function produces it for both — a page that authorized one
 * digest and asked the network to sign another would wait forever.
 */
export function messageDigest(message: Uint8Array): Uint8Array {
	return approvalMessageDigests(message).messageDigest;
}

/** Multisig PDA: `["multisig", dwallet]` — exactly one multisig per dWallet. */
export function findMultisigPda(dwallet: PublicKey): [PublicKey, number] {
	return PublicKey.findProgramAddressSync(
		[Buffer.from('multisig'), dwallet.toBuffer()],
		MULTISIG_PROGRAM_ID,
	);
}
export function findTransactionPda(multisig: PublicKey, txIndex: number): [PublicKey, number] {
	const buf = Buffer.alloc(4);
	buf.writeUInt32LE(txIndex);
	return PublicKey.findProgramAddressSync(
		[Buffer.from('transaction'), multisig.toBuffer(), buf],
		MULTISIG_PROGRAM_ID,
	);
}
export function findApprovalRecordPda(tx: PublicKey, member: PublicKey): [PublicKey, number] {
	return PublicKey.findProgramAddressSync(
		[Buffer.from('approval'), tx.toBuffer(), member.toBuffer()],
		MULTISIG_PROGRAM_ID,
	);
}
export function findCpiAuthority(): [PublicKey, number] {
	return PublicKey.findProgramAddressSync(
		[Buffer.from('__ika_cpi_authority')],
		MULTISIG_PROGRAM_ID,
	);
}
/**
 * The voucher the multisig program issues for a transaction, and its bump:
 * the program's PDA `["signature_voucher", transaction]`. The program signs
 * the voucher's creation with these seeds when the transaction reaches its
 * threshold, and the page names the address in the sign request.
 */
export function findSignatureVoucherPda(tx: PublicKey): [PublicKey, number] {
	return PublicKey.findProgramAddressSync(
		[Buffer.from('signature_voucher'), tx.toBuffer()],
		MULTISIG_PROGRAM_ID,
	);
}

/**
 * The little-endian numbers this program's accounts hold.
 *
 * Read through a `DataView` rather than through `Buffer`, because this page
 * runs in a browser where `Buffer` is a polyfill rather than a type the
 * platform has.
 */
function readU16(data: Uint8Array, offset: number): number {
	return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(offset, true);
}

function readU32(data: Uint8Array, offset: number): number {
	return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
}

export interface MultisigAccount {
	threshold: number;
	memberCount: number;
	txIndex: number;
	dwallet: PublicKey;
	members: PublicKey[];
}
export function parseMultisig(data: Uint8Array): MultisigAccount {
	const memberCount = readU16(data, 36);
	const members: PublicKey[] = [];
	for (let i = 0; i < memberCount; i++)
		members.push(new PublicKey(data.subarray(43 + i * 32, 75 + i * 32)));
	return {
		threshold: readU16(data, 34),
		memberCount,
		txIndex: readU32(data, 38),
		dwallet: new PublicKey(data.subarray(2, 34)),
		members,
	};
}

export interface TransactionAccount {
	txIndex: number;
	proposer: PublicKey;
	messageHash: Uint8Array;
	approvalCount: number;
	rejectionCount: number;
	status: number;
	signatureVoucherBump: number;
	messageDataLen: number;
	messageData: Uint8Array;
}
export function parseTransaction(data: Uint8Array): TransactionAccount {
	const mdl = readU16(data, 144);
	return {
		txIndex: readU32(data, 34),
		proposer: new PublicKey(data.subarray(38, 70)),
		messageHash: new Uint8Array(data.subarray(70, 102)),
		approvalCount: readU16(data, 136),
		rejectionCount: readU16(data, 138),
		status: data[140],
		signatureVoucherBump: data[141],
		messageDataLen: mdl,
		messageData: new Uint8Array(data.subarray(146, 146 + mdl)),
	};
}

/**
 * CreateMultisig: fix members and threshold for a dWallet. Must be signed by
 * the dWallet's CURRENT owner, before ownership is transferred to the
 * multisig program's CPI PDA (the CPI PDA is shared by every dWallet the
 * program controls; the per-dWallet multisig PDA is the binding).
 */
export function buildCreateMultisigIx(
	pda: PublicKey,
	dwallet: PublicKey,
	owner: PublicKey,
	payer: PublicKey,
	threshold: number,
	members: PublicKey[],
): TransactionInstruction {
	const data = Buffer.alloc(1 + 2 + 2 + members.length * 32);
	let o = 0;
	data[o++] = 0;
	data.writeUInt16LE(threshold, o);
	o += 2;
	data.writeUInt16LE(members.length, o);
	o += 2;
	for (const m of members) {
		m.toBuffer().copy(data, o);
		o += 32;
	}
	return new TransactionInstruction({
		programId: MULTISIG_PROGRAM_ID,
		keys: [
			{ pubkey: pda, isSigner: false, isWritable: true },
			{ pubkey: dwallet, isSigner: false, isWritable: false },
			{ pubkey: DWALLET_PROGRAM_ID, isSigner: false, isWritable: false },
			{ pubkey: owner, isSigner: true, isWritable: false },
			{ pubkey: payer, isSigner: true, isWritable: true },
			{ pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
		],
		data,
	});
}

export function buildCreateTransactionIx(
	multisigPda: PublicKey,
	txPda: PublicKey,
	proposer: PublicKey,
	payer: PublicKey,
	messageHash: Uint8Array,
	userPubkey: Uint8Array,
	sigScheme: number,
	voucherBump: number,
	txBump: number,
	messageData: Uint8Array,
): TransactionInstruction {
	const data = Buffer.alloc(1 + 32 + 32 + 2 + 1 + 1 + 1 + 2 + messageData.length);
	let o = 0;
	data[o++] = 1;
	Buffer.from(messageHash).copy(data, o);
	o += 32;
	Buffer.from(userPubkey).copy(data, o);
	o += 32;
	data.writeUInt16LE(sigScheme, o);
	o += 2;
	data[o++] = voucherBump;
	data[o++] = 0; // future_sign: this page signs in one step
	data[o++] = txBump;
	data.writeUInt16LE(messageData.length, o);
	o += 2;
	Buffer.from(messageData).copy(data, o);
	return new TransactionInstruction({
		programId: MULTISIG_PROGRAM_ID,
		keys: [
			{ pubkey: multisigPda, isSigner: false, isWritable: true },
			{ pubkey: txPda, isSigner: false, isWritable: true },
			{ pubkey: proposer, isSigner: true, isWritable: false },
			{ pubkey: payer, isSigner: true, isWritable: true },
			{ pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
		],
		data,
	});
}

export function buildApproveIx(
	multisigPda: PublicKey,
	txPda: PublicKey,
	arPda: PublicKey,
	member: PublicKey,
	payer: PublicKey,
	txIndex: number,
	arBump: number,
	cpiBump: number,
	cpi?: { signatureVoucher: PublicKey; dwallet: PublicKey; cpiAuthority: PublicKey },
): TransactionInstruction {
	const data = Buffer.alloc(7);
	data[0] = 2;
	data.writeUInt32LE(txIndex, 1);
	data[5] = arBump;
	data[6] = cpiBump;
	const keys = [
		{ pubkey: multisigPda, isSigner: false, isWritable: false },
		{ pubkey: txPda, isSigner: false, isWritable: true },
		{ pubkey: arPda, isSigner: false, isWritable: true },
		{ pubkey: member, isSigner: true, isWritable: false },
		{ pubkey: payer, isSigner: true, isWritable: true },
		{ pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
	];
	if (cpi)
		keys.push(
			{ pubkey: coordinatorAddress(DWALLET_PROGRAM_ID), isSigner: false, isWritable: false },
			{ pubkey: cpi.signatureVoucher, isSigner: false, isWritable: true },
			{ pubkey: cpi.dwallet, isSigner: false, isWritable: false },
			{ pubkey: MULTISIG_PROGRAM_ID, isSigner: false, isWritable: false },
			{ pubkey: cpi.cpiAuthority, isSigner: false, isWritable: false },
			{ pubkey: DWALLET_PROGRAM_ID, isSigner: false, isWritable: false },
		);
	return new TransactionInstruction({ programId: MULTISIG_PROGRAM_ID, keys, data });
}

export function buildRejectIx(
	multisigPda: PublicKey,
	txPda: PublicKey,
	arPda: PublicKey,
	member: PublicKey,
	payer: PublicKey,
	txIndex: number,
	arBump: number,
): TransactionInstruction {
	const data = Buffer.alloc(6);
	data[0] = 3;
	data.writeUInt32LE(txIndex, 1);
	data[5] = arBump;
	return new TransactionInstruction({
		programId: MULTISIG_PROGRAM_ID,
		keys: [
			{ pubkey: multisigPda, isSigner: false, isWritable: false },
			{ pubkey: txPda, isSigner: false, isWritable: true },
			{ pubkey: arPda, isSigner: false, isWritable: true },
			{ pubkey: member, isSigner: true, isWritable: false },
			{ pubkey: payer, isSigner: true, isWritable: true },
			{ pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
		],
		data,
	});
}

export async function fetchTransactions(
	connection: Connection,
	multisigPda: PublicKey,
	count: number,
) {
	const txs: { pda: PublicKey; account: TransactionAccount }[] = [];
	for (let i = 0; i < count; i++) {
		const [txPda] = findTransactionPda(multisigPda, i);
		try {
			const info = await connection.getAccountInfo(txPda);
			if (info?.data) txs.push({ pda: txPda, account: parseTransaction(Buffer.from(info.data)) });
		} catch {
			/* skip */
		}
	}
	return txs;
}
