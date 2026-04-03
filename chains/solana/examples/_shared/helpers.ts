// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

// Shared helpers for Ika dWallet e2e demos and examples.

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  TransactionInstruction,
  type Signer,
} from "@solana/web3.js";

// ── ANSI color logging ──

const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";

export function log(step: string, msg: string) {
  console.log(`${CYAN}[${step}]${RESET} ${msg}`);
}

export function ok(msg: string) {
  console.log(`${GREEN}  \u2713${RESET} ${msg}`);
}

export function val(label: string, v: string | number | PublicKey) {
  console.log(`${YELLOW}  \u2192${RESET} ${label}: ${v}`);
}

// ── Transaction helpers ──

export async function sendTx(
  connection: Connection,
  payer: Keypair,
  ixs: TransactionInstruction[],
  extraSigners: Signer[] = [],
): Promise<string> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(payer, ...extraSigners);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

// ── PDA helpers ──

export function pda(
  seeds: (Buffer | Uint8Array)[],
  programId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

// ── Polling ──

export async function pollUntil(
  connection: Connection,
  account: PublicKey,
  check: (data: Buffer) => boolean,
  timeoutMs = 30_000,
  intervalMs = 500,
): Promise<Buffer> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const info = await connection.getAccountInfo(account);
      if (info?.data && check(Buffer.from(info.data))) {
        return Buffer.from(info.data);
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timeout waiting for account ${account.toBase58()}`);
}

// ── Keypair helpers ──

export async function createAndFundKeypair(
  connection: Connection,
  lamports: number,
): Promise<Keypair> {
  const kp = Keypair.generate();
  const sig = await connection.requestAirdrop(kp.publicKey, lamports);
  await connection.confirmTransaction(sig, "confirmed");
  return kp;
}

// ── Buffer read helpers ──

export function readU16LE(data: Buffer, offset: number): number {
  return data.readUInt16LE(offset);
}

export function readU32LE(data: Buffer, offset: number): number {
  return data.readUInt32LE(offset);
}
