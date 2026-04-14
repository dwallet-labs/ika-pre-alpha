#!/usr/bin/env bun
// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

// dWallet Multisig E2E Demo (TypeScript)
//
// Runs against Solana devnet and the pre-alpha dWallet gRPC service.
//
// Usage: bun main.ts <DWALLET_ID> <MULTISIG_ID>
//
// Environment variables:
//   RPC_URL  — Solana RPC (default: https://api.devnet.solana.com)
//   GRPC_URL — dWallet gRPC (default: pre-alpha-dev-1.ika.ika-network.net:443)

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  log, ok, val, sendTx, pda, pollUntil, createAndFundKeypair, readU16LE,
} from "../../_shared/helpers.ts";
import {
  setupDWallet, requestPresign, requestSign, findMessageApprovalPda,
} from "../../_shared/ika-setup.ts";
import {
  buildCreateMultisigIx, buildCreateTransactionIx, buildApproveIx, buildRejectIx,
} from "./instructions.ts";

const [dwalletArg, multisigArg] = process.argv.slice(2);
if (!dwalletArg || !multisigArg) {
  console.error("Usage: bun main.ts <DWALLET_PROGRAM_ID> <MULTISIG_PROGRAM_ID>");
  process.exit(1);
}

const dwalletProgramId = new PublicKey(dwalletArg);
const multisigProgramId = new PublicKey(multisigArg);
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const GRPC_URL = process.env.GRPC_URL || "pre-alpha-dev-1.ika.ika-network.net:443";

const connection = new Connection(RPC_URL, "confirmed");

console.log("\n\x1b[1m\u2550\u2550\u2550 dWallet Multisig E2E Demo (TypeScript) \u2550\u2550\u2550\x1b[0m\n");
val("dWallet program", dwalletProgramId.toBase58());
val("Multisig program", multisigProgramId.toBase58());
console.log();

// ── Setup ──

log("Setup", "Funding payer...");
const payer = await createAndFundKeypair(connection, 100_000_000_000);
ok(`Payer: ${payer.publicKey.toBase58()}`);

log("Setup", "Waiting for mock + creating dWallet via gRPC...");
const dwallet = await setupDWallet(connection, payer, dwalletProgramId, multisigProgramId, GRPC_URL);
console.log();

// ── Step 1: Create 2-of-3 multisig ──

log("1/7", "Creating 2-of-3 multisig...");

const member1 = await createAndFundKeypair(connection, 1_000_000_000);
const member2 = await createAndFundKeypair(connection, 1_000_000_000);
const member3 = await createAndFundKeypair(connection, 1_000_000_000);

const createKey = Keypair.generate().publicKey.toBytes();
const [multisigPda, multisigBump] = pda(
  [Buffer.from("multisig"), Buffer.from(createKey)],
  multisigProgramId,
);

await sendTx(connection, payer, [
  buildCreateMultisigIx(
    multisigProgramId, multisigPda, payer.publicKey, payer.publicKey,
    createKey, dwallet.dwalletPda, 2,
    [member1.publicKey, member2.publicKey, member3.publicKey],
    multisigBump,
  ),
]);
ok(`Multisig: ${multisigPda.toBase58()}`);
val("Threshold", "2-of-3");

// ── Step 2: Propose transaction ──

log("2/7", "Proposing transaction...");

const message = Buffer.from("Transfer 100 USDC to treasury");
const messageHash = Buffer.from(keccak_256(message));
const userPubkey = new Uint8Array(32).fill(0xcc);
const txIndex = 0;

const [messageApprovalPda, messageApprovalBump] = findMessageApprovalPda(
  dwalletProgramId, 2, dwallet.publicKey, 5, messageHash,
);

const txIndexBuf = Buffer.alloc(4);
txIndexBuf.writeUInt32LE(txIndex);
const [txPda, txBump] = pda(
  [Buffer.from("transaction"), multisigPda.toBuffer(), txIndexBuf],
  multisigProgramId,
);

await sendTx(connection, payer, [
  buildCreateTransactionIx(
    multisigProgramId, multisigPda, txPda, member1.publicKey, payer.publicKey,
    messageHash, userPubkey, 0, messageApprovalBump, txBump, message,
  ),
], [member1]);
ok(`Transaction: ${txPda.toBase58()}`);
val("Message", message.toString());

// Verify message data on-chain
const stored = await pollUntil(connection, txPda, (d) => d[0] === 2, 5000);
const storedLen = readU16LE(stored, 174);
const storedMsg = stored.subarray(176, 176 + storedLen).toString();
ok(`Message data on-chain: "${storedMsg}"`);

// ── Step 3: Member1 approves (1/2) ──

log("3/7", "Member1 approves (1/2)...");

const [ar1Pda, ar1Bump] = pda(
  [Buffer.from("approval"), txPda.toBuffer(), member1.publicKey.toBuffer()],
  multisigProgramId,
);

await sendTx(connection, payer, [
  buildApproveIx(
    multisigProgramId, multisigPda, txPda, ar1Pda,
    member1.publicKey, payer.publicKey, txIndex, ar1Bump, dwallet.cpiAuthorityBump,
  ),
], [member1]);
ok("Member1 approved");

// ── Step 4: Member2 approves (2/2 = quorum) ──

log("4/7", "Member2 approves (2/2 = quorum)...");

const [ar2Pda, ar2Bump] = pda(
  [Buffer.from("approval"), txPda.toBuffer(), member2.publicKey.toBuffer()],
  multisigProgramId,
);

const quorumTxSig = await sendTx(connection, payer, [
  buildApproveIx(
    multisigProgramId, multisigPda, txPda, ar2Pda,
    member2.publicKey, payer.publicKey, txIndex, ar2Bump, dwallet.cpiAuthorityBump,
    {
      messageApproval: messageApprovalPda,
      dwallet: dwallet.dwalletPda,
      cpiAuthority: dwallet.cpiAuthority,
      dwalletProgramId,
    },
  ),
], [member2]);
ok("Quorum reached! approve_message CPI executed.");

const txData = await pollUntil(connection, txPda, (d) => d[139] === 1, 5000);
ok("Transaction status: Approved");

// ── Step 5: Verify MessageApproval ──

log("5/8", "Verifying MessageApproval on-chain...");
await pollUntil(connection, messageApprovalPda, (d) => d.length > 139 && d[0] === 14, 10_000);
ok(`MessageApproval: ${messageApprovalPda.toBase58()}`);

// ── Step 6: Presign + Sign via gRPC ──

log("6/8", "Allocating presign + signing via gRPC...");
const presignId = await requestPresign(dwallet.grpcClient, payer, dwallet.dwalletAddr);
ok("Presign allocated!");

const grpcSignature = await requestSign(
  dwallet.grpcClient, payer, dwallet.dwalletAddr,
  message, presignId, quorumTxSig,
);
ok("Signature received from gRPC!");
val("Signature", Buffer.from(grpcSignature).toString("hex"));

// ── Step 7: Verify signature on-chain ──

log("7/8", "Verifying signature on-chain...");
const maSigned = await pollUntil(
  connection, messageApprovalPda,
  (d) => d.length > 139 && d[139] === 1,
  15_000,
);
const onchainSigLen = readU16LE(maSigned, 140);
const onchainSig = maSigned.subarray(142, 142 + onchainSigLen);
const grpcSigHex = Buffer.from(grpcSignature).toString("hex");
const onchainSigHex = Buffer.from(onchainSig).toString("hex");

if (grpcSigHex !== onchainSigHex) {
  throw new Error(`Signature mismatch!\n  gRPC:     ${grpcSigHex}\n  on-chain: ${onchainSigHex}`);
}
ok("Signature committed on-chain!");
val("On-chain sig", onchainSigHex);
val("Status", "Signed (1)");

// ── Step 8: Test rejection flow ──

log("8/8", "Testing rejection flow...");

const message2 = Buffer.from("Bad tx - reject this");
const messageHash2 = Buffer.from(keccak_256(message2));
const txIndex2 = 1;
const txIndexBuf2 = Buffer.alloc(4);
txIndexBuf2.writeUInt32LE(txIndex2);

const [txPda2, txBump2] = pda(
  [Buffer.from("transaction"), multisigPda.toBuffer(), txIndexBuf2],
  multisigProgramId,
);
const [, maBump2] = findMessageApprovalPda(dwalletProgramId, 2, dwallet.publicKey, 5, messageHash2);

await sendTx(connection, payer, [
  buildCreateTransactionIx(
    multisigProgramId, multisigPda, txPda2, member1.publicKey, payer.publicKey,
    messageHash2, userPubkey, 0, maBump2, txBump2, message2,
  ),
], [member1]);
ok(`Transaction 2: ${txPda2.toBase58()}`);

// Member2 rejects
const [ar2r, ar2rBump] = pda(
  [Buffer.from("approval"), txPda2.toBuffer(), member2.publicKey.toBuffer()],
  multisigProgramId,
);
await sendTx(connection, payer, [
  buildRejectIx(multisigProgramId, multisigPda, txPda2, ar2r, member2.publicKey, payer.publicKey, txIndex2, ar2rBump),
], [member2]);
ok("Member2 rejected");

// Member3 rejects
const [ar3r, ar3rBump] = pda(
  [Buffer.from("approval"), txPda2.toBuffer(), member3.publicKey.toBuffer()],
  multisigProgramId,
);
await sendTx(connection, payer, [
  buildRejectIx(multisigProgramId, multisigPda, txPda2, ar3r, member3.publicKey, payer.publicKey, txIndex2, ar3rBump),
], [member3]);

const tx2Data = await pollUntil(connection, txPda2, (d) => d[139] === 2, 5000);
ok("Transaction 2 rejected!");

console.log("\n\x1b[1m\x1b[32m\u2550\u2550\u2550 E2E Test Passed! \u2550\u2550\u2550\x1b[0m\n");
