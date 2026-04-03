// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

import { PublicKey, TransactionInstruction, SystemProgram } from "@solana/web3.js";

export function buildCreateMultisigIx(
  programId: PublicKey,
  multisigPda: PublicKey,
  creator: PublicKey,
  payer: PublicKey,
  createKey: Uint8Array,
  dwallet: PublicKey,
  threshold: number,
  members: PublicKey[],
  bump: number,
): TransactionInstruction {
  const data = Buffer.alloc(1 + 32 + 32 + 2 + 2 + 1 + members.length * 32);
  let offset = 0;
  data[offset++] = 0; // disc
  Buffer.from(createKey).copy(data, offset); offset += 32;
  dwallet.toBuffer().copy(data, offset); offset += 32;
  data.writeUInt16LE(threshold, offset); offset += 2;
  data.writeUInt16LE(members.length, offset); offset += 2;
  data[offset++] = bump;
  for (const m of members) {
    m.toBuffer().copy(data, offset); offset += 32;
  }

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: multisigPda, isSigner: false, isWritable: true },
      { pubkey: creator, isSigner: true, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildCreateTransactionIx(
  programId: PublicKey,
  multisigPda: PublicKey,
  txPda: PublicKey,
  proposer: PublicKey,
  payer: PublicKey,
  messageHash: Uint8Array,
  userPubkey: Uint8Array,
  signatureScheme: number,
  msgApprovalBump: number,
  txBump: number,
  messageData: Uint8Array,
): TransactionInstruction {
  const data = Buffer.alloc(1 + 32 + 32 + 1 + 1 + 32 + 1 + 2 + messageData.length);
  let offset = 0;
  data[offset++] = 1; // disc
  Buffer.from(messageHash).copy(data, offset); offset += 32;
  Buffer.from(userPubkey).copy(data, offset); offset += 32;
  data[offset++] = signatureScheme;
  data[offset++] = msgApprovalBump;
  offset += 32; // partial_user_sig = zeros
  data[offset++] = txBump;
  data.writeUInt16LE(messageData.length, offset); offset += 2;
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
    messageApproval: PublicKey;
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
      { pubkey: cpiAccounts.messageApproval, isSigner: false, isWritable: true },
      { pubkey: cpiAccounts.dwallet, isSigner: false, isWritable: false },
      { pubkey: programId, isSigner: false, isWritable: false },
      { pubkey: cpiAccounts.cpiAuthority, isSigner: false, isWritable: false },
      { pubkey: cpiAccounts.dwalletProgramId, isSigner: false, isWritable: false },
    );
  }

  return new TransactionInstruction({ programId, keys, data });
}

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
