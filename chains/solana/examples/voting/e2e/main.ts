#!/usr/bin/env bun
// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

// dWallet Voting E2E Demo (TypeScript)
//
// Runs against Solana devnet and the pre-alpha dWallet gRPC service.
//
// Usage: bun main.ts <DWALLET_ID> <VOTING_ID>
//
// Environment variables:
//   RPC_URL  — Solana RPC (default: https://api.devnet.solana.com)
//   GRPC_URL — dWallet gRPC (default: pre-alpha-dev-1.ika.ika-network.net:443)

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  log, ok, val, sendTx, pda, pollUntil, createAndFundKeypair, readU32LE, readU16LE,
} from "../../_shared/helpers.ts";
import {
  setupDWallet, requestPresign, requestSign, findMessageApprovalPda,
} from "../../_shared/ika-setup.ts";
import { buildCreateProposalIx, buildCastVoteIx } from "./instructions.ts";

const [dwalletArg, votingArg] = process.argv.slice(2);
if (!dwalletArg || !votingArg) {
  console.error("Usage: bun main.ts <DWALLET_PROGRAM_ID> <VOTING_PROGRAM_ID>");
  process.exit(1);
}

const dwalletProgramId = new PublicKey(dwalletArg);
const votingProgramId = new PublicKey(votingArg);
const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const GRPC_URL = process.env.GRPC_URL || "pre-alpha-dev-1.ika.ika-network.net:443";

const connection = new Connection(RPC_URL, "confirmed");

console.log("\n\x1b[1m\u2550\u2550\u2550 dWallet Voting E2E Demo (TypeScript) \u2550\u2550\u2550\x1b[0m\n");
val("dWallet program", dwalletProgramId.toBase58());
val("Voting program", votingProgramId.toBase58());
console.log();

// ── Setup ──

log("Setup", "Funding payer...");
const payer = await createAndFundKeypair(connection, 100_000_000_000);
ok(`Payer: ${payer.publicKey.toBase58()}`);

log("Setup", "Waiting for mock + creating dWallet via gRPC...");
const dwallet = await setupDWallet(connection, payer, dwalletProgramId, votingProgramId, GRPC_URL);
console.log();

// ── Step 1: Create proposal (quorum=3) ──

log("1/5", "Creating voting proposal (quorum=3)...");

const proposalId = Keypair.generate().publicKey.toBytes();
const message = Buffer.from("Transfer 100 USDC to treasury");
const messageHash = Buffer.from(keccak_256(message));
const userPubkey = new Uint8Array(32).fill(0xcc);
const quorum = 3;

const [proposalPda, proposalBump] = pda(
  [Buffer.from("proposal"), Buffer.from(proposalId)],
  votingProgramId,
);

const [messageApprovalPda, messageApprovalBump] = findMessageApprovalPda(
  dwalletProgramId, 2, dwallet.publicKey, 5, messageHash,
);

await sendTx(connection, payer, [
  buildCreateProposalIx(
    votingProgramId, proposalPda, dwallet.dwalletPda, payer.publicKey, payer.publicKey,
    proposalId, messageHash, userPubkey, 0, quorum, messageApprovalBump, proposalBump,
  ),
]);
ok(`Proposal: ${proposalPda.toBase58()}`);
val("Message", message.toString());
val("Quorum", quorum);

// ── Step 2: Cast 3 yes votes ──

const voterNames = ["Alice", "Bob", "Charlie"];
let quorumTxSig = "";

for (let i = 0; i < voterNames.length; i++) {
  const voteNum = i + 1;
  log("2/5", `Vote ${voteNum}/3: ${voterNames[i]} casts YES...`);

  const voter = await createAndFundKeypair(connection, 1_000_000_000);

  const [voteRecordPda, vrBump] = pda(
    [Buffer.from("vote"), Buffer.from(proposalId), voter.publicKey.toBuffer()],
    votingProgramId,
  );

  const cpiAccounts = voteNum >= quorum ? {
    messageApproval: messageApprovalPda,
    dwallet: dwallet.dwalletPda,
    cpiAuthority: dwallet.cpiAuthority,
    dwalletProgramId,
  } : undefined;

  const sig = await sendTx(
    connection, payer,
    [buildCastVoteIx(
      votingProgramId, proposalPda, voteRecordPda, voter.publicKey, payer.publicKey,
      proposalId, 1, vrBump, dwallet.cpiAuthorityBump, cpiAccounts,
    )],
    [voter],
  );

  if (voteNum >= quorum) quorumTxSig = sig;
  ok(`${voterNames[i]} voted YES`);
}

const propData = await pollUntil(connection, proposalPda, (d) => d[175] === 1, 5000);
ok(`Proposal approved (${readU32LE(propData, 163)}/3 yes)`);

// ── Step 3: Verify MessageApproval ──

log("3/6", "Verifying MessageApproval on-chain...");
await pollUntil(connection, messageApprovalPda, (d) => d.length > 139 && d[0] === 14, 10_000);
ok(`MessageApproval: ${messageApprovalPda.toBase58()}`);
val("Status", "Pending");

// ── Step 4: Presign + Sign via gRPC ──

log("4/6", "Allocating presign via gRPC...");
const presignId = await requestPresign(dwallet.grpcClient, payer, dwallet.dwalletAddr);
ok("Presign allocated!");
val("Presign ID", Buffer.from(presignId).toString("hex"));

log("5/6", "Sending Sign request via gRPC...");
const grpcSignature = await requestSign(
  dwallet.grpcClient, payer, dwallet.dwalletAddr,
  message, presignId, quorumTxSig,
);
ok("Signature received from gRPC!");
val("Signature", Buffer.from(grpcSignature).toString("hex"));

// ── Step 6: Verify signature on-chain ──

log("6/6", "Verifying signature on-chain...");
const maSigned = await pollUntil(
  connection, messageApprovalPda,
  (d) => d.length > 139 && d[139] === 1, // status = Signed
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
val("dWallet", dwallet.dwalletPda.toBase58());

console.log("\n\x1b[1m\x1b[32m\u2550\u2550\u2550 E2E Test Passed! \u2550\u2550\u2550\x1b[0m\n");
