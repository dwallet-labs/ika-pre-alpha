// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The addresses and digests the demos' own programs need, beside the SDK.
 *
 * The SDK builds every instruction of the ika program and reads its
 * accounts. What it cannot know is the demos' programs: the address each
 * one signs its dWallet calls with, the voucher address each one picks for a
 * proposal, and the digest of a message, which a demo writes into its own
 * program's proposal before the program issues the voucher.
 *
 * Nothing here writes an instruction byte, an account discriminator or a
 * derived address of the ika program out by hand. Those come from
 * `@ika.xyz/sdk-solana`, which reads them from the program's own table.
 */
import { Buffer } from 'node:buffer';
import { approvalMessageDigests, readSignatureVoucherUnverified } from '@ika.xyz/sdk-solana';
import { Connection, PublicKey } from '@solana/web3.js';

import { pollUntil } from './helpers.ts';

/** How long to wait for a voucher a demo's program issued. */
export const VOUCHER_WAIT_MS = 120_000;

/**
 * The address a demo's program signs its dWallet calls with, and its bump:
 * the program's PDA `["__ika_cpi_authority"]`. A dWallet handed to the
 * program is owned by this address, and the program signs as it when it
 * issues a voucher.
 */
export function cpiAuthority(exampleProgramId: PublicKey): [PublicKey, number] {
	return PublicKey.findProgramAddressSync([Buffer.from('__ika_cpi_authority')], exampleProgramId);
}

/**
 * The digest of a message, as the voucher account stores it.
 *
 * It is the digest the SDK computes for the same message
 * (`approvalMessageDigests`), so the voucher the program issues and the sign
 * request the SDK sends name the same digest.
 */
export function messageDigest(message: Uint8Array): Uint8Array {
	return approvalMessageDigests(message).messageDigest;
}

/**
 * The voucher an example program issues for one of its proposals, and its
 * bump: the program's PDA `["signature_voucher", seed]`. The voting
 * program's seed is the proposal's id; the multisig program's is the
 * transaction account's address.
 *
 * The program signs the voucher's creation with these seeds, so the address
 * is fixed before the vote, and the demo names it in the sign request.
 */
export function signatureVoucherPda(
	exampleProgramId: PublicKey,
	seed: Uint8Array,
): [PublicKey, number] {
	return PublicKey.findProgramAddressSync(
		[Buffer.from('signature_voucher'), Buffer.from(seed)],
		exampleProgramId,
	);
}

/**
 * Wait for a voucher account to exist at finalized commitment, whether or
 * not it is signed yet.
 *
 * Finalized, because the network reads the voucher at finalized: a sign
 * request sent while the voucher is only confirmed is refused with
 * "signature voucher not observed within the wait window".
 */
export async function waitForVoucher(
	connection: Connection,
	voucher: PublicKey,
	timeoutMs = VOUCHER_WAIT_MS,
): Promise<void> {
	await pollUntil(
		connection,
		voucher,
		(bytes) => readSignatureVoucherUnverified(bytes) !== null,
		timeoutMs,
		500,
		'finalized',
	);
}
