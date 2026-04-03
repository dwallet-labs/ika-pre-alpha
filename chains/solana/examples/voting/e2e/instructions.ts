// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

import { PublicKey, TransactionInstruction, SystemProgram } from "@solana/web3.js";

export function buildCreateProposalIx(
  programId: PublicKey,
  proposalPda: PublicKey,
  dwallet: PublicKey,
  creator: PublicKey,
  payer: PublicKey,
  proposalId: Uint8Array,
  messageHash: Uint8Array,
  userPubkey: Uint8Array,
  signatureScheme: number,
  quorum: number,
  messageApprovalBump: number,
  proposalBump: number,
): TransactionInstruction {
  const data = Buffer.alloc(1 + 103);
  let offset = 0;
  data[offset++] = 0; // disc
  Buffer.from(proposalId).copy(data, offset); offset += 32;
  Buffer.from(messageHash).copy(data, offset); offset += 32;
  Buffer.from(userPubkey).copy(data, offset); offset += 32;
  data[offset++] = signatureScheme;
  data.writeUInt32LE(quorum, offset); offset += 4;
  data[offset++] = messageApprovalBump;
  data[offset++] = proposalBump;

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: proposalPda, isSigner: false, isWritable: true },
      { pubkey: dwallet, isSigner: false, isWritable: false },
      { pubkey: creator, isSigner: true, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildCastVoteIx(
  programId: PublicKey,
  proposalPda: PublicKey,
  voteRecordPda: PublicKey,
  voter: PublicKey,
  payer: PublicKey,
  proposalId: Uint8Array,
  vote: number,
  voteRecordBump: number,
  cpiAuthorityBump: number,
  cpiAccounts?: {
    messageApproval: PublicKey;
    dwallet: PublicKey;
    cpiAuthority: PublicKey;
    dwalletProgramId: PublicKey;
  },
): TransactionInstruction {
  const data = Buffer.alloc(1 + 35);
  let offset = 0;
  data[offset++] = 1; // disc
  Buffer.from(proposalId).copy(data, offset); offset += 32;
  data[offset++] = vote;
  data[offset++] = voteRecordBump;
  data[offset++] = cpiAuthorityBump;

  const keys = [
    { pubkey: proposalPda, isSigner: false, isWritable: true },
    { pubkey: voteRecordPda, isSigner: false, isWritable: true },
    { pubkey: voter, isSigner: true, isWritable: false },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  if (cpiAccounts) {
    keys.push(
      { pubkey: cpiAccounts.messageApproval, isSigner: false, isWritable: true },
      { pubkey: cpiAccounts.dwallet, isSigner: false, isWritable: false },
      { pubkey: programId, isSigner: false, isWritable: false },
      { pubkey: cpiAccounts.cpiAuthority, isSigner: false, isWritable: false },
      { pubkey: cpiAccounts.dwalletProgramId, isSigner: false, isWritable: false },
    );
  }

  return new TransactionInstruction({ programId, keys, data });
}
