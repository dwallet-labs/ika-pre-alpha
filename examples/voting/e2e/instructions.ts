// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

// Instruction builders for the Pinocchio/native voting example. Byte layouts
// mirror the program's instruction docs (`examples/voting/pinocchio/src/lib.rs`).

import { Buffer } from 'node:buffer';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';

/** Council PDA: `["council", dwallet]`. */
export function findCouncilPda(programId: PublicKey, dwallet: PublicKey): [PublicKey, number] {
	return PublicKey.findProgramAddressSync([Buffer.from('council'), dwallet.toBuffer()], programId);
}

/**
 * CreateCouncil (disc=2): fix the member list and quorum for a dWallet.
 * Must be signed by the dWallet's CURRENT owner, before ownership
 * is transferred to the voting program's CPI PDA.
 *
 * Data: quorum(4) + member_count(2) + members(32 * n)
 * Accounts: [council(w), dwallet(r), dwallet_program(r), owner(s), payer(ws), system_program(r)]
 */
export function buildCreateCouncilIx(
	programId: PublicKey,
	councilPda: PublicKey,
	dwallet: PublicKey,
	dwalletProgramId: PublicKey,
	owner: PublicKey,
	payer: PublicKey,
	quorum: number,
	members: PublicKey[],
): TransactionInstruction {
	const data = Buffer.alloc(1 + 4 + 2 + members.length * 32);
	let offset = 0;
	data[offset++] = 2; // disc
	data.writeUInt32LE(quorum, offset);
	offset += 4;
	data.writeUInt16LE(members.length, offset);
	offset += 2;
	for (const member of members) {
		member.toBuffer().copy(data, offset);
		offset += 32;
	}

	return new TransactionInstruction({
		programId,
		keys: [
			{ pubkey: councilPda, isSigner: false, isWritable: true },
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
 * CreateProposal (disc=0): a council member proposes a message for the
 * council's dWallet. The quorum comes from the council.
 *
 * Data: proposal_id(32) + message_digest(32) + user_pubkey(32) + signature_scheme(2 LE) +
 *       signature_voucher_bump(1) + bump(1) = 100
 *
 * `signatureVoucherBump` is the bump of the program's PDA
 * `["signature_voucher", proposal_id]`, where the voucher is issued once the
 * proposal passes.
 * Accounts: [proposal(w), council(r), dwallet(r), creator(s), payer(ws), system_program(r)]
 */
export function buildCreateProposalIx(
	programId: PublicKey,
	proposalPda: PublicKey,
	councilPda: PublicKey,
	dwallet: PublicKey,
	creator: PublicKey,
	payer: PublicKey,
	proposalId: Uint8Array,
	messageHash: Uint8Array,
	userPubkey: Uint8Array,
	signatureScheme: number,
	signatureVoucherBump: number,
	proposalBump: number,
): TransactionInstruction {
	const data = Buffer.alloc(1 + 100);
	let offset = 0;
	data[offset++] = 0; // disc
	Buffer.from(proposalId).copy(data, offset);
	offset += 32;
	Buffer.from(messageHash).copy(data, offset);
	offset += 32;
	Buffer.from(userPubkey).copy(data, offset);
	offset += 32;
	data.writeUInt16LE(signatureScheme, offset);
	offset += 2;
	data[offset++] = signatureVoucherBump;
	data[offset] = proposalBump;

	return new TransactionInstruction({
		programId,
		keys: [
			{ pubkey: proposalPda, isSigner: false, isWritable: true },
			{ pubkey: councilPda, isSigner: false, isWritable: false },
			{ pubkey: dwallet, isSigner: false, isWritable: false },
			{ pubkey: creator, isSigner: true, isWritable: false },
			{ pubkey: payer, isSigner: true, isWritable: true },
			{ pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
		],
		data,
	});
}

/**
 * CastVote (disc=1): a council member votes; at quorum the program
 * CPI-issues a signature voucher on the proposal's dWallet, which needs the
 * extra CPI accounts (indices 6-11).
 *
 * Data: proposal_id(32) + vote(1) + vote_record_bump(1) + cpi_authority_bump(1) = 35
 * Accounts: [proposal(w), vote_record(w), council(r), voter(s), payer(ws), system_program(r),
 *            coordinator(r), signature_voucher(w), dwallet(r), voting_program(r),
 *            cpi_authority(r), dwallet_program(r)]
 */
export function buildCastVoteIx(
	programId: PublicKey,
	proposalPda: PublicKey,
	voteRecordPda: PublicKey,
	councilPda: PublicKey,
	voter: PublicKey,
	payer: PublicKey,
	proposalId: Uint8Array,
	vote: number,
	voteRecordBump: number,
	cpiAuthorityBump: number,
	cpiAccounts?: {
		coordinator: PublicKey;
		signatureVoucher: PublicKey;
		dwallet: PublicKey;
		cpiAuthority: PublicKey;
		dwalletProgramId: PublicKey;
	},
): TransactionInstruction {
	const data = Buffer.alloc(1 + 35);
	let offset = 0;
	data[offset++] = 1; // disc
	Buffer.from(proposalId).copy(data, offset);
	offset += 32;
	data[offset++] = vote;
	data[offset++] = voteRecordBump;
	data[offset] = cpiAuthorityBump;

	const keys = [
		{ pubkey: proposalPda, isSigner: false, isWritable: true },
		{ pubkey: voteRecordPda, isSigner: false, isWritable: true },
		{ pubkey: councilPda, isSigner: false, isWritable: false },
		{ pubkey: voter, isSigner: true, isWritable: false },
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
