#!/usr/bin/env bun
// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * dWallet Multisig E2E Demo (TypeScript)
 *
 * Two of three members approve a message, and the ika network signs it
 * with a dWallet the multisig controls. The demo talks to the network
 * through the SDK, as an app does.
 *
 * On the Solana devnet pre-alpha the network is a mock: one backend holds
 * an ordinary key for each dWallet and signs with it alone. The SDK runs in
 * mock mode against it (`_shared/network.ts`). The program, the
 * transactions and the SDK's calls are the ones the real network uses.
 *
 * The story, in order:
 *
 *  1. Make the payer a user of the network: new keys, the encryption key
 *     registered on chain, and a gas deposit for the key that signs the
 *     requests.
 *  2. Run a distributed key generation over gRPC.
 *  3. Accept the user's share on chain, and wait for the network to
 *     activate the dWallet.
 *  4. Create the 2-of-3 multisig, while the payer is still the dWallet's
 *     owner.
 *  5. Hand the dWallet to the multisig program's signing address.
 *  6. A member proposes a message.
 *  7. Two members approve. The second approval crosses the threshold, and
 *     the program issues a signature voucher for the message on the dWallet
 *     in the same transaction.
 *  8. Take a presign from the network, then ask it to sign, naming the
 *     voucher. The network reads the voucher on chain for itself, returns
 *     the signature over gRPC, and writes it into the voucher account.
 *  9. Propose a second message and have two members reject it, which shows
 *     the path where nothing is ever sent to the network.
 *
 * Usage: bun main.ts <DWALLET_PROGRAM_ID> <MULTISIG_PROGRAM_ID>
 *
 * Environment variables:
 *   GRPC_URL       the ika network's gRPC endpoint (default: the devnet
 *                  pre-alpha, https://solana-alpha-dev-1.ika-network.net).
 *                  An `https://` URL is gRPC-Web, `http://host:port` is
 *                  plaintext gRPC, and `host:port` is gRPC with TLS pinned
 *                  to the committee.
 *   RPC_URL        Solana RPC (default: https://api.devnet.solana.com)
 *   PAYER_KEYPAIR  the funded key that pays for every transaction and owns
 *                  the dWallet (default: ~/.config/solana/id.json)
 */
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SIGNATURE_SCHEME_EDDSA_SHA512 } from '@ika.xyz/sdk-solana';
import { coordinatorAddress } from '@ika.xyz/sdk-solana/instructions';
import { ed25519 } from '@noble/curves/ed25519.js';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';

import {
	cpiAuthority,
	messageDigest,
	signatureVoucherPda,
	waitForVoucher,
} from '../../_shared/chain.ts';
import {
	log,
	ok,
	pda,
	pollUntil,
	readText,
	readU16LE,
	sendTx,
	val,
} from '../../_shared/helpers.ts';
import {
	connectToIka,
	createDWallet,
	execute,
	newUser,
	signWithVoucher,
	takePresign,
} from '../../_shared/network.ts';
import {
	buildApproveIx,
	buildCreateMultisigIx,
	buildCreateTransactionIx,
	buildRejectIx,
	findMultisigPda,
} from './instructions.ts';

// ── The multisig program's own account layout ──
// From `examples/multisig/pinocchio/src/lib.rs`.

const TX_DISCRIMINATOR = 2;
const TX_STATUS = 140;
const TX_MESSAGE_DATA_LEN = 144;
const TX_MESSAGE_DATA = 146;
const TRANSACTION_APPROVED = 1;
const TRANSACTION_REJECTED = 2;

const [dwalletArg, multisigArg] = process.argv.slice(2);
if (!dwalletArg || !multisigArg) {
	console.error('Usage: bun main.ts <DWALLET_PROGRAM_ID> <MULTISIG_PROGRAM_ID>');
	process.exit(1);
}
const grpcUrl = process.env.GRPC_URL ?? 'https://solana-alpha-dev-1.ika-network.net';

const dwalletProgramId = new PublicKey(dwalletArg);
const multisigProgramId = new PublicKey(multisigArg);
const connection = new Connection(
	process.env.RPC_URL ?? 'https://api.devnet.solana.com',
	'confirmed',
);
const payer = loadPayer();

console.log('\n\x1b[1m═══ dWallet Multisig E2E Demo (TypeScript) ═══\x1b[0m\n');
val('dWallet program', dwalletProgramId.toBase58());
val('Multisig program', multisigProgramId.toBase58());
val('ika network', grpcUrl);
val('Payer', payer.publicKey.toBase58());

// The members are fixed by the dWallet's owner BEFORE the dWallet is handed
// to the multisig program: the program's signing address is shared by every
// dWallet it controls, so the per-dWallet multisig account is what binds
// this dWallet to these three.
//
// The members sign their own approvals but pay for nothing, so they are
// never funded. The payer pays for every transaction in the run.
const members = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
members.forEach((member, index) => val(`Member ${index + 1}`, member.publicKey.toBase58()));
const threshold = 2;

console.log();

const { ikaClient, close } = await connectToIka(connection, dwalletProgramId, grpcUrl);

// ── Step 1: the user ──

log('1/9', 'Registering new keys and a gas deposit for the payer...');
const user = await newUser(ikaClient, connection, payer);
const requestKey = ikaClient.getRequestPublicKey(user.keys);
ok('Encryption key registered, gas deposit created');
val('Request key', Buffer.from(requestKey).toString('hex'));

// ── Step 2 and 3: the dWallet ──

log('2/9', 'Running a distributed key generation over gRPC...');
log('3/9', "Accepting the user's share and waiting for the dWallet...");
const { dWallet, address: dwalletAccount } = await createDWallet(ikaClient, connection, user);
ok(`dWallet account: ${dwalletAccount.toBase58()}`);
val('dWallet public key', Buffer.from(dWallet.publicKey).toString('hex'));

// ── Step 4: the multisig ──

log('4/9', `Creating the ${threshold}-of-${members.length} multisig...`);
const [multisigPda] = findMultisigPda(multisigProgramId, dwalletAccount);
await sendTx(connection, payer, [
	buildCreateMultisigIx(
		multisigProgramId,
		multisigPda,
		dwalletAccount,
		dwalletProgramId,
		payer.publicKey,
		payer.publicKey,
		threshold,
		members.map((member) => member.publicKey),
	),
]);
ok(`Multisig: ${multisigPda.toBase58()}`);

// ── Step 5: hand the dWallet over ──

const [multisigAuthority, multisigAuthorityBump] = cpiAuthority(multisigProgramId);
log('5/9', 'Handing the dWallet to the multisig program...');
await execute(ikaClient, connection, user, (ikaTx) =>
	ikaTx.transferDWallet({ dWallet, newOwner: multisigAuthority }),
);
ok(`Owner is now the multisig program's signing address: ${multisigAuthority.toBase58()}`);

// ── Step 6: the proposal ──

// A fresh nonce keeps each run's signature distinct, so a signature left on
// chain by an earlier run is never mistaken for this run's.
const message = Buffer.from(`Transfer 100 USDC to treasury (${Keypair.generate().publicKey})`);
const digest = messageDigest(message);
const transactionIndex = 0;
const [transactionPda, transactionBump] = transactionAddress(transactionIndex);
// The voucher the program issues at the threshold: its own PDA for this
// transaction.
const [voucherAccount, voucherBump] = signatureVoucherPda(
	multisigProgramId,
	transactionPda.toBytes(),
);

log('6/9', 'A member proposes the message...');
await sendTx(
	connection,
	payer,
	[
		buildCreateTransactionIx(
			multisigProgramId,
			multisigPda,
			transactionPda,
			members[0].publicKey,
			payer.publicKey,
			digest,
			// The key that will sign the gRPC request: the user's request
			// key. The program writes it into the voucher as its signing key,
			// and the network refuses a sign request from any other key.
			requestKey,
			SIGNATURE_SCHEME_EDDSA_SHA512,
			voucherBump,
			transactionBump,
			message,
		),
	],
	[members[0]],
);
ok(`Transaction: ${transactionPda.toBase58()}`);
const stored = await pollUntil(
	connection,
	transactionPda,
	(data) => data[0] === TX_DISCRIMINATOR,
	10_000,
);
const storedLength = readU16LE(stored, TX_MESSAGE_DATA_LEN);
val('Message on chain', readText(stored, TX_MESSAGE_DATA, storedLength));

// ── Step 7: the approvals ──

for (const [index, member] of members.slice(0, threshold).entries()) {
	const approvalNumber = index + 1;
	log('7/9', `Approval ${approvalNumber}/${threshold}: member ${approvalNumber} approves...`);
	const [record, recordBump] = pda(
		[Buffer.from('approval'), transactionPda.toBuffer(), member.publicKey.toBuffer()],
		multisigProgramId,
	);
	// The approval that crosses the threshold also issues the voucher, in the
	// same transaction, which is why it carries the dWallet accounts.
	const cpiAccounts =
		approvalNumber >= threshold
			? {
					coordinator: coordinatorAddress(dwalletProgramId),
					signatureVoucher: voucherAccount,
					dwallet: dwalletAccount,
					cpiAuthority: multisigAuthority,
					dwalletProgramId,
				}
			: undefined;

	await sendTx(
		connection,
		payer,
		[
			buildApproveIx(
				multisigProgramId,
				multisigPda,
				transactionPda,
				record,
				member.publicKey,
				payer.publicKey,
				transactionIndex,
				recordBump,
				multisigAuthorityBump,
				cpiAccounts,
			),
		],
		[member],
	);
	ok(`Member ${approvalNumber} approved`);
}

await pollUntil(
	connection,
	transactionPda,
	(data) => data[TX_STATUS] === TRANSACTION_APPROVED,
	10_000,
);
ok('The multisig approved the transaction');

await waitForVoucher(connection, voucherAccount);
ok(`Voucher issued on chain: ${voucherAccount.toBase58()}`);

// ── Step 8: the presign and the signature ──

log('8/9', 'Taking a presign from the network, then asking it to sign...');
const presign = await takePresign(ikaClient, user);
ok('Presign allocated');
const { signature, committed } = await signWithVoucher(
	ikaClient,
	user,
	dWallet,
	voucherAccount,
	message,
	presign,
);
ok('The network returned a signature');
val('Signature', Buffer.from(signature).toString('hex'));
if (Buffer.from(committed).toString('hex') !== Buffer.from(signature).toString('hex')) {
	throw new Error(
		'the signature on chain is not the one the network returned:\n' +
			`  over gRPC: ${Buffer.from(signature).toString('hex')}\n` +
			`  on chain:  ${Buffer.from(committed).toString('hex')}`,
	);
}
ok('The same signature is committed in the voucher account');
// The SDK already checked it. Checking it here too shows what anyone who
// reads the voucher can do with no SDK at all.
if (!ed25519.verify(signature, message, dWallet.publicKey)) {
	throw new Error("the signature does not verify under the dWallet's public key");
}
ok("The signature verifies under the dWallet's public key");
close();

// ── Step 9: the rejection ──

log('9/9', 'Proposing a second message and rejecting it...');
const rejectedMessage = Buffer.from(`Drain the treasury (${Keypair.generate().publicKey})`);
const rejectedIndex = 1;
const [rejectedPda, rejectedBump] = transactionAddress(rejectedIndex);
const [, rejectedVoucherBump] = signatureVoucherPda(multisigProgramId, rejectedPda.toBytes());

await sendTx(
	connection,
	payer,
	[
		buildCreateTransactionIx(
			multisigProgramId,
			multisigPda,
			rejectedPda,
			members[0].publicKey,
			payer.publicKey,
			messageDigest(rejectedMessage),
			requestKey,
			SIGNATURE_SCHEME_EDDSA_SHA512,
			rejectedVoucherBump,
			rejectedBump,
			rejectedMessage,
		),
	],
	[members[0]],
);

for (const member of members.slice(1)) {
	const [record, recordBump] = pda(
		[Buffer.from('approval'), rejectedPda.toBuffer(), member.publicKey.toBuffer()],
		multisigProgramId,
	);
	await sendTx(
		connection,
		payer,
		[
			buildRejectIx(
				multisigProgramId,
				multisigPda,
				rejectedPda,
				record,
				member.publicKey,
				payer.publicKey,
				rejectedIndex,
				recordBump,
			),
		],
		[member],
	);
}
await pollUntil(
	connection,
	rejectedPda,
	(data) => data[TX_STATUS] === TRANSACTION_REJECTED,
	10_000,
);
// Nothing was sent to the network for this message, and no voucher exists
// for it, so a sign request on it would never resume.
ok('The second message was rejected and never reached the network');

console.log('\n\x1b[1m\x1b[32m═══ The demo ran to the end ═══\x1b[0m\n');

/** One transaction account of the multisig, by its index. */
function transactionAddress(index: number): [PublicKey, number] {
	const indexBytes = Buffer.alloc(4);
	indexBytes.writeUInt32LE(index);
	return pda([Buffer.from('transaction'), multisigPda.toBuffer(), indexBytes], multisigProgramId);
}

/**
 * The key that pays for every transaction.
 *
 * A demo cannot mint SOL, so this has to be a key that already holds
 * some — the same file the `solana` command-line tool uses by default.
 */
function loadPayer(): Keypair {
	const path = process.env.PAYER_KEYPAIR ?? join(homedir(), '.config', 'solana', 'id.json');
	try {
		return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
	} catch (error) {
		throw new Error(`read the payer keypair from ${path}`, { cause: error });
	}
}
