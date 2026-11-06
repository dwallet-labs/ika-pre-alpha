// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

// Shared helpers for the Ika dWallet demos: printing, sending a
// transaction, deriving an address, and waiting for an account.

import {
	Connection,
	Keypair,
	PublicKey,
	Transaction,
	TransactionInstruction,
	type Commitment,
	type Signer,
} from '@solana/web3.js';

// ── Printing ──

const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';

export function log(step: string, message: string) {
	console.log(`${CYAN}[${step}]${RESET} ${message}`);
}

export function ok(message: string) {
	console.log(`${GREEN}  ✓${RESET} ${message}`);
}

export function val(label: string, value: string | number | PublicKey) {
	console.log(`${YELLOW}  →${RESET} ${label}: ${value}`);
}

// ── Transactions ──

export async function sendTx(
	connection: Connection,
	payer: Keypair,
	instructions: TransactionInstruction[],
	extraSigners: Signer[] = [],
): Promise<string> {
	const transaction = new Transaction().add(...instructions);
	transaction.feePayer = payer.publicKey;
	transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
	transaction.sign(payer, ...extraSigners);
	const signature = await connection.sendRawTransaction(transaction.serialize());
	await confirmByPolling(connection, signature, 'confirmed');
	return signature;
}

/**
 * Wait until `signature` reaches `commitment`, by asking the RPC over HTTP.
 *
 * `Connection.confirmTransaction` listens on the RPC's WebSocket, and public
 * RPC endpoints often refuse that connection. Polling works with any RPC.
 * Throws when the transaction failed, or when its blockhash expired first.
 */
export async function confirmByPolling(
	connection: Connection,
	signature: string,
	commitment: 'confirmed' | 'finalized',
	lastValidBlockHeight?: number,
): Promise<void> {
	for (;;) {
		const { value } = await connection.getSignatureStatuses([signature]);
		const status = value[0];
		if (status?.err) {
			throw new Error(`the transaction ${signature} failed: ${JSON.stringify(status.err)}`);
		}
		const reached =
			status?.confirmationStatus === 'finalized' ||
			(commitment === 'confirmed' && status?.confirmationStatus === 'confirmed');
		if (reached) return;
		if (
			lastValidBlockHeight !== undefined &&
			status === null &&
			(await connection.getBlockHeight('confirmed')) > lastValidBlockHeight
		) {
			throw new Error(`the transaction ${signature} expired before it landed`);
		}
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
}

// ── Addresses ──

export function pda(seeds: Uint8Array[], programId: PublicKey): [PublicKey, number] {
	return PublicKey.findProgramAddressSync(seeds, programId);
}

// ── Waiting ──

/**
 * Poll one account until `check` accepts its data, and return that data.
 *
 * Most of what a demo waits for is written by the network rather than by
 * the demo, so "not there yet" is the normal case and the loop swallows a
 * read that fails.
 */
export async function pollUntil(
	connection: Connection,
	account: PublicKey,
	check: (data: Uint8Array) => boolean,
	timeoutMs = 30_000,
	intervalMs = 500,
	commitment: Commitment = 'confirmed',
): Promise<Uint8Array> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const info = await connection.getAccountInfo(account, commitment);
			const data = info?.data ? Uint8Array.from(info.data) : undefined;
			if (data && check(data)) {
				return data;
			}
		} catch {
			// The account may not exist yet, or the node may be behind. Retry.
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(`timed out waiting for the account ${account.toBase58()}`);
}

// ── Reading numbers out of account data ──

export function readU16LE(data: Uint8Array, offset: number): number {
	return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(offset, true);
}

export function readU32LE(data: Uint8Array, offset: number): number {
	return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
}

/** Text an account holds, decoded as UTF-8. */
export function readText(data: Uint8Array, offset: number, length: number): string {
	return new TextDecoder().decode(data.subarray(offset, offset + length));
}
