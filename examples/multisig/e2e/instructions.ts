// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

// Instruction builders for the Pinocchio/native multisig example. Byte
// layouts mirror the program's instruction docs
// (`examples/multisig/pinocchio/src/lib.rs`).

import { Buffer } from 'node:buffer';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';

/** Multisig PDA: `["multisig", dwallet]` — exactly one multisig per dWallet. */
export function findMultisigPda(programId: PublicKey, dwallet: PublicKey): [PublicKey, number] {
	return PublicKey.findProgramAddressSync([Buffer.from('multisig'), dwallet.toBuffer()], programId);
}

/**
 * CreateMultisig (disc=0): fix members and threshold for a dWallet. Must be
 * signed by the dWallet's CURRENT owner, before ownership is
 * transferred to the multisig program's CPI PDA.
 *
 * Data: threshold(2) + member_count(2) + members(32 * n)
 * Accounts: [multisig(w), dwallet(r), dwallet_program(r), owner(s), payer(ws), system_program(r)]
 */
export function buildCreateMultisigIx(
	programId: PublicKey,
	multisigPda: PublicKey,
	dwallet: PublicKey,
	dwalletProgramId: PublicKey,
	owner: PublicKey,
	payer: PublicKey,
	threshold: number,
	members: PublicKey[],
): TransactionInstruction {
	const data = Buffer.alloc(1 + 2 + 2 + members.length * 32);
	let offset = 0;
	data[offset++] = 0; // disc
	data.writeUInt16LE(threshold, offset);
	offset += 2;
	data.writeUInt16LE(members.length, offset);
	offset += 2;
	for (const m of members) {
		m.toBuffer().copy(data, offset);
		offset += 32;
	}

	return new TransactionInstruction({
		programId,
		keys: [
			{ pubkey: multisigPda, isSigner: false, isWritable: true },
			{ pubkey: dwallet, isSigner: false, isWritable: false },
			{ pubkey: dwalletProgramId, isSigner: false, isWritable: false },
			{ pubkey: owner, isSigner: true, isWritable: false },
			{ pubkey: payer, isSigner: true, isWritable: true },
			{ pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
		],
		data,
	});
}

/**
 * CreateTransaction (disc=1).
 *
 * Data: message_hash(32) + user_pubkey(32) + signature_scheme(2 LE) + signature_voucher_bump(1) +
 *       future_sign(1) + tx_bump(1) + message_data_len(2 LE) + message_data
 *
 * `signatureVoucherBump` is the bump of the program's PDA
 * `["signature_voucher", transaction]`, where the voucher is issued once the
 * transaction reaches its threshold. With `futureSign`, the voucher issued
 * there is a future signature voucher owned by the proposer.
 * Accounts: [multisig(w), transaction(w), proposer(s), payer(ws), system_program(r)]
 */
export function buildCreateTransactionIx(
	programId: PublicKey,
	multisigPda: PublicKey,
	txPda: PublicKey,
	proposer: PublicKey,
	payer: PublicKey,
	messageHash: Uint8Array,
	userPubkey: Uint8Array,
	signatureScheme: number,
	signatureVoucherBump: number,
	txBump: number,
	messageData: Uint8Array,
	futureSign = false,
): TransactionInstruction {
	const data = Buffer.alloc(1 + 32 + 32 + 2 + 1 + 1 + 1 + 2 + messageData.length);
	let offset = 0;
	data[offset++] = 1; // disc
	Buffer.from(messageHash).copy(data, offset);
	offset += 32;
	Buffer.from(userPubkey).copy(data, offset);
	offset += 32;
	data.writeUInt16LE(signatureScheme, offset);
	offset += 2;
	data[offset++] = signatureVoucherBump;
	data[offset++] = futureSign ? 1 : 0;
	data[offset++] = txBump;
	data.writeUInt16LE(messageData.length, offset);
	offset += 2;
	Buffer.from(messageData).copy(data, offset);

	return new TransactionInstruction({
		programId,
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

/**
 * Approve (disc=2). At threshold the program CPI-issues a signature voucher, or
 * a future signature voucher for a future-sign transaction, on the multisig's
 * dWallet, which needs the extra CPI accounts (indices 6-11).
 *
 * Data: tx_index(4) + approval_record_bump(1) + cpi_authority_bump(1)
 * Accounts: [multisig(r), transaction(w), approval_record(w), member(s), payer(ws), system_program(r),
 *            coordinator(r), signature_voucher(w), dwallet(r), multisig_program(r),
 *            cpi_authority(r), dwallet_program(r)]
 */
export function buildApproveIx(
	programId: PublicKey,
	multisigPda: PublicKey,
	txPda: PublicKey,
	approvalRecordPda: PublicKey,
	member: PublicKey,
	payer: PublicKey,
	txIndex: number,
	arBump: number,
	cpiAuthorityBump: number,
	cpiAccounts?: {
		coordinator: PublicKey;
		signatureVoucher: PublicKey;
		dwallet: PublicKey;
		cpiAuthority: PublicKey;
		dwalletProgramId: PublicKey;
	},
): TransactionInstruction {
	const data = Buffer.alloc(7);
	data[0] = 2; // disc
	data.writeUInt32LE(txIndex, 1);
	data[5] = arBump;
	data[6] = cpiAuthorityBump;

	const keys = [
		{ pubkey: multisigPda, isSigner: false, isWritable: false },
		{ pubkey: txPda, isSigner: false, isWritable: true },
		{ pubkey: approvalRecordPda, isSigner: false, isWritable: true },
		{ pubkey: member, isSigner: true, isWritable: false },
		{ pubkey: payer, isSigner: true, isWritable: true },
		{ pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
	];

	if (cpiAccounts) {
		keys.push(
			{ pubkey: cpiAccounts.coordinator, isSigner: false, isWritable: false },
			{ pubkey: cpiAccounts.signatureVoucher, isSigner: false, isWritable: true },
			{ pubkey: cpiAccounts.dwallet, isSigner: false, isWritable: false },
			{ pubkey: programId, isSigner: false, isWritable: false },
			{ pubkey: cpiAccounts.cpiAuthority, isSigner: false, isWritable: false },
			{ pubkey: cpiAccounts.dwalletProgramId, isSigner: false, isWritable: false },
		);
	}

	return new TransactionInstruction({ programId, keys, data });
}

/**
 * Reject (disc=3).
 *
 * Data: tx_index(4) + approval_record_bump(1)
 * Accounts: [multisig(r), transaction(w), approval_record(w), member(s), payer(ws), system_program(r)]
 */
export function buildRejectIx(
	programId: PublicKey,
	multisigPda: PublicKey,
	txPda: PublicKey,
	approvalRecordPda: PublicKey,
	member: PublicKey,
	payer: PublicKey,
	txIndex: number,
	arBump: number,
): TransactionInstruction {
	const data = Buffer.alloc(6);
	data[0] = 3; // disc
	data.writeUInt32LE(txIndex, 1);
	data[5] = arBump;

	return new TransactionInstruction({
		programId,
		keys: [
			{ pubkey: multisigPda, isSigner: false, isWritable: false },
			{ pubkey: txPda, isSigner: false, isWritable: true },
			{ pubkey: approvalRecordPda, isSigner: false, isWritable: true },
			{ pubkey: member, isSigner: true, isWritable: false },
			{ pubkey: payer, isSigner: true, isWritable: true },
			{ pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
		],
		data,
	});
}
