import { Connection, PublicKey, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

export const MULTISIG_PROGRAM_ID = new PublicKey(
  import.meta.env.VITE_MULTISIG_PROGRAM_ID || 'BzDH6WHTaHMzmNHGezLYxTbVFPfSqGwY5o1BpLbwzbJ'
);
export const DWALLET_PROGRAM_ID = new PublicKey(
  import.meta.env.VITE_DWALLET_PROGRAM_ID || 'DWaL1c2nc3J3Eiduwq6EJovDfBPPH2gERKy1TqSkbRWq'
);

export function keccak256(data: Uint8Array): Uint8Array { return keccak_256(data); }

export function findMultisigPda(createKey: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('multisig'), Buffer.from(createKey)], MULTISIG_PROGRAM_ID);
}
export function findTransactionPda(multisig: PublicKey, txIndex: number): [PublicKey, number] {
  const buf = Buffer.alloc(4); buf.writeUInt32LE(txIndex);
  return PublicKey.findProgramAddressSync([Buffer.from('transaction'), multisig.toBuffer(), buf], MULTISIG_PROGRAM_ID);
}
export function findApprovalRecordPda(tx: PublicKey, member: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('approval'), tx.toBuffer(), member.toBuffer()], MULTISIG_PROGRAM_ID);
}
export function findCpiAuthority(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('__ika_cpi_authority')], MULTISIG_PROGRAM_ID);
}
export function findMessageApprovalPda(curve: number, publicKey: Uint8Array, signatureScheme: number, messageHash: Uint8Array): [PublicKey, number] {
  const payload = Buffer.alloc(2 + publicKey.length);
  payload.writeUInt16LE(curve, 0);
  Buffer.from(publicKey).copy(payload, 2);
  const seeds: Buffer[] = [Buffer.from('dwallet')];
  for (let i = 0; i < payload.length; i += 32) {
    seeds.push(payload.subarray(i, Math.min(i + 32, payload.length)));
  }
  seeds.push(Buffer.from('message_approval'));
  const schemeBuf = Buffer.alloc(2);
  schemeBuf.writeUInt16LE(signatureScheme, 0);
  seeds.push(schemeBuf);
  seeds.push(Buffer.from(messageHash));
  return PublicKey.findProgramAddressSync(seeds, DWALLET_PROGRAM_ID);
}

export interface MultisigAccount {
  threshold: number; memberCount: number; txIndex: number; dwallet: PublicKey; members: PublicKey[];
}
export function parseMultisig(data: Buffer): MultisigAccount {
  const memberCount = data.readUInt16LE(36);
  const members: PublicKey[] = [];
  for (let i = 0; i < memberCount; i++) members.push(new PublicKey(data.subarray(75 + i * 32, 107 + i * 32)));
  return { threshold: data.readUInt16LE(34), memberCount, txIndex: data.readUInt32LE(38), dwallet: new PublicKey(data.subarray(42, 74)), members };
}

export interface TransactionAccount {
  txIndex: number; proposer: PublicKey; messageHash: Uint8Array; approvalCount: number;
  rejectionCount: number; status: number; msgApprovalBump: number; messageDataLen: number; messageData: Uint8Array;
}
export function parseTransaction(data: Buffer): TransactionAccount {
  const mdl = data.readUInt16LE(174);
  return {
    txIndex: data.readUInt32LE(34), proposer: new PublicKey(data.subarray(38, 70)),
    messageHash: new Uint8Array(data.subarray(70, 102)), approvalCount: data.readUInt16LE(135),
    rejectionCount: data.readUInt16LE(137), status: data[139], msgApprovalBump: data[140],
    messageDataLen: mdl, messageData: new Uint8Array(data.subarray(176, 176 + mdl)),
  };
}

export function buildCreateMultisigIx(
  pda: PublicKey, creator: PublicKey, payer: PublicKey, createKey: Uint8Array,
  dwallet: PublicKey, threshold: number, members: PublicKey[], bump: number,
): TransactionInstruction {
  const data = Buffer.alloc(1 + 32 + 32 + 2 + 2 + 1 + members.length * 32);
  let o = 0; data[o++] = 0;
  Buffer.from(createKey).copy(data, o); o += 32;
  dwallet.toBuffer().copy(data, o); o += 32;
  data.writeUInt16LE(threshold, o); o += 2;
  data.writeUInt16LE(members.length, o); o += 2;
  data[o++] = bump;
  for (const m of members) { m.toBuffer().copy(data, o); o += 32; }
  return new TransactionInstruction({ programId: MULTISIG_PROGRAM_ID, keys: [
    { pubkey: pda, isSigner: false, isWritable: true },
    { pubkey: creator, isSigner: true, isWritable: false },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ], data });
}

export function buildCreateTransactionIx(
  multisigPda: PublicKey, txPda: PublicKey, proposer: PublicKey, payer: PublicKey,
  messageHash: Uint8Array, userPubkey: Uint8Array, sigScheme: number,
  maBump: number, txBump: number, messageData: Uint8Array,
): TransactionInstruction {
  const data = Buffer.alloc(1 + 32 + 32 + 1 + 1 + 32 + 1 + 2 + messageData.length);
  let o = 0; data[o++] = 1;
  Buffer.from(messageHash).copy(data, o); o += 32;
  Buffer.from(userPubkey).copy(data, o); o += 32;
  data[o++] = sigScheme; data[o++] = maBump; o += 32; data[o++] = txBump;
  data.writeUInt16LE(messageData.length, o); o += 2;
  Buffer.from(messageData).copy(data, o);
  return new TransactionInstruction({ programId: MULTISIG_PROGRAM_ID, keys: [
    { pubkey: multisigPda, isSigner: false, isWritable: true },
    { pubkey: txPda, isSigner: false, isWritable: true },
    { pubkey: proposer, isSigner: true, isWritable: false },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ], data });
}

export function buildApproveIx(
  multisigPda: PublicKey, txPda: PublicKey, arPda: PublicKey, member: PublicKey, payer: PublicKey,
  txIndex: number, arBump: number, cpiBump: number,
  cpi?: { messageApproval: PublicKey; dwallet: PublicKey; cpiAuthority: PublicKey },
): TransactionInstruction {
  const data = Buffer.alloc(7); data[0] = 2; data.writeUInt32LE(txIndex, 1); data[5] = arBump; data[6] = cpiBump;
  const keys = [
    { pubkey: multisigPda, isSigner: false, isWritable: false },
    { pubkey: txPda, isSigner: false, isWritable: true },
    { pubkey: arPda, isSigner: false, isWritable: true },
    { pubkey: member, isSigner: true, isWritable: false },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  if (cpi) keys.push(
    { pubkey: cpi.messageApproval, isSigner: false, isWritable: true },
    { pubkey: cpi.dwallet, isSigner: false, isWritable: false },
    { pubkey: MULTISIG_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: cpi.cpiAuthority, isSigner: false, isWritable: false },
    { pubkey: DWALLET_PROGRAM_ID, isSigner: false, isWritable: false },
  );
  return new TransactionInstruction({ programId: MULTISIG_PROGRAM_ID, keys, data });
}

export function buildRejectIx(
  multisigPda: PublicKey, txPda: PublicKey, arPda: PublicKey, member: PublicKey, payer: PublicKey,
  txIndex: number, arBump: number,
): TransactionInstruction {
  const data = Buffer.alloc(6); data[0] = 3; data.writeUInt32LE(txIndex, 1); data[5] = arBump;
  return new TransactionInstruction({ programId: MULTISIG_PROGRAM_ID, keys: [
    { pubkey: multisigPda, isSigner: false, isWritable: false },
    { pubkey: txPda, isSigner: false, isWritable: true },
    { pubkey: arPda, isSigner: false, isWritable: true },
    { pubkey: member, isSigner: true, isWritable: false },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ], data });
}

export async function fetchTransactions(connection: Connection, multisigPda: PublicKey, count: number) {
  const txs: { pda: PublicKey; account: TransactionAccount }[] = [];
  for (let i = 0; i < count; i++) {
    const [txPda] = findTransactionPda(multisigPda, i);
    try {
      const info = await connection.getAccountInfo(txPda);
      if (info?.data) txs.push({ pda: txPda, account: parseTransaction(Buffer.from(info.data)) });
    } catch { /* skip */ }
  }
  return txs;
}
