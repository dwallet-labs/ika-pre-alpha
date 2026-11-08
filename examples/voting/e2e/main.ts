#!/usr/bin/env bun
// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * dWallet Voting E2E Demo (TypeScript)
 *
 * A council of three votes on a message, and the ika network signs it with
 * a dWallet the council controls. The demo talks to the network through the
 * SDK, as an app does.
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
 *  4. Create the council, while the payer is still the dWallet's owner.
 *  5. Hand the dWallet to the voting program's signing address.
 *  6. A council member proposes a message.
 *  7. Three members vote yes. The third vote crosses the quorum, and the
 *     program issues a signature voucher for the message on the dWallet in
 *     the same transaction.
 *  8. Take a presign from the network.
 *  9. Ask the network to sign, naming the voucher. The network reads the
 *     voucher on chain for itself, returns the signature over gRPC, and
 *     writes it into the voucher account, where anyone can read it.
 *
 * Usage: bun main.ts <DWALLET_PROGRAM_ID> <VOTING_PROGRAM_ID>
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
import { SIGNATURE_SCHEME_EDDSA_SHA512 } from '@ika.xyz/pre-alpha-solana';
import { coordinatorAddress } from '@ika.xyz/pre-alpha-solana/instructions';
import { ed25519 } from '@noble/curves/ed25519.js';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';

import {
	cpiAuthority,
	messageDigest,
	signatureVoucherPda,
	waitForVoucher,
} from '../../_shared/chain.ts';
import { log, ok, pda, pollUntil, readU32LE, sendTx, val } from '../../_shared/helpers.ts';
import {
	connectToIka,
	createDWallet,
	execute,
	newUser,
	signWithVoucher,
	takePresign,
} from '../../_shared/network.ts';
import {
	buildCastVoteIx,
	buildCreateCouncilIx,
	buildCreateProposalIx,
	findCouncilPda,
} from './instructions.ts';

// ── The voting program's own account layout ──
// From `examples/voting/pinocchio/src/lib.rs`.

/** `Proposal.yes_votes`, a little-endian `u32`. */
const PROP_YES_VOTES = 164;

/** `Proposal.status`. */
const PROP_STATUS = 176;

/** `Proposal.status` once the quorum has been reached. */
const PROPOSAL_APPROVED = 1;

const [dwalletArg, votingArg] = process.argv.slice(2);
if (!dwalletArg || !votingArg) {
	console.error('Usage: bun main.ts <DWALLET_PROGRAM_ID> <VOTING_PROGRAM_ID>');
	process.exit(1);
}
const grpcUrl = process.env.GRPC_URL ?? 'https://solana-alpha-dev-1.ika-network.net';

const dwalletProgramId = new PublicKey(dwalletArg);
const votingProgramId = new PublicKey(votingArg);
const connection = new Connection(
	process.env.RPC_URL ?? 'https://api.devnet.solana.com',
	'confirmed',
);
const payer = loadPayer();

console.log('\n\x1b[1m═══ dWallet Voting E2E Demo (TypeScript) ═══\x1b[0m\n');
val('dWallet program', dwalletProgramId.toBase58());
val('Voting program', votingProgramId.toBase58());
val('ika network', grpcUrl);
val('Payer', payer.publicKey.toBase58());

// The council is fixed by the dWallet's owner BEFORE the dWallet is handed
// to the voting program: the program's signing address is shared by every
// dWallet it controls, so the council is what binds this dWallet to these
// three voters.
const voterNames = ['Alice', 'Bob', 'Charlie'];
// The voters sign their own votes but pay for nothing, so they are never
// funded. The payer pays for every transaction in the run.
const voters = voterNames.map(() => Keypair.generate());
voterNames.forEach((name, index) => val(name, voters[index].publicKey.toBase58()));
const quorum = 3;
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

// ── Step 4: the council ──

log('4/9', `Creating the council (quorum ${quorum})...`);
const [councilPda] = findCouncilPda(votingProgramId, dwalletAccount);
await sendTx(connection, payer, [
	buildCreateCouncilIx(
		votingProgramId,
		councilPda,
		dwalletAccount,
		dwalletProgramId,
		payer.publicKey,
		payer.publicKey,
		quorum,
		voters.map((voter) => voter.publicKey),
	),
]);
ok(`Council: ${councilPda.toBase58()}`);

// ── Step 5: hand the dWallet over ──

const [votingAuthority, votingAuthorityBump] = cpiAuthority(votingProgramId);
log('5/9', 'Handing the dWallet to the voting program...');
await execute(ikaClient, connection, user, (ikaTx) =>
	ikaTx.transferDWallet({ dWallet, newOwner: votingAuthority }),
);
ok(`Owner is now the voting program's signing address: ${votingAuthority.toBase58()}`);

// ── Step 6: the proposal ──

// A fresh nonce keeps each run's signature distinct, so a signature left on
// chain by an earlier run is never mistaken for this run's.
const message = Buffer.from(`Transfer 100 USDC to treasury (${Keypair.generate().publicKey})`);
const digest = messageDigest(message);
const proposalId = Keypair.generate().publicKey.toBytes();
const [proposalPda, proposalBump] = pda(
	[Buffer.from('proposal'), Buffer.from(proposalId)],
	votingProgramId,
);
// The voucher the program issues when the vote passes: its own PDA for this
// proposal.
const [voucherAccount, voucherBump] = signatureVoucherPda(votingProgramId, proposalId);

log('6/9', 'A council member proposes the message...');
await sendTx(
	connection,
	payer,
	[
		buildCreateProposalIx(
			votingProgramId,
			proposalPda,
			councilPda,
			dwalletAccount,
			voters[0].publicKey,
			payer.publicKey,
			proposalId,
			digest,
			// The key that will sign the gRPC request: the user's request
			// key. The program writes it into the voucher as its signing key,
			// and the network refuses a sign request from any other key.
			requestKey,
			SIGNATURE_SCHEME_EDDSA_SHA512,
			voucherBump,
			proposalBump,
		),
	],
	[voters[0]],
);
ok(`Proposal: ${proposalPda.toBase58()}`);
val('Message', message.toString());

// ── Step 7: the votes ──

for (const [index, voter] of voters.entries()) {
	const voteNumber = index + 1;
	log('7/9', `Vote ${voteNumber}/${quorum}: ${voterNames[index]} votes yes...`);
	const [voteRecordPda, voteRecordBump] = pda(
		[Buffer.from('vote'), Buffer.from(proposalId), voter.publicKey.toBuffer()],
		votingProgramId,
	);
	// The vote that crosses the quorum also issues the voucher, in the same
	// transaction, which is why it carries the dWallet accounts.
	const cpiAccounts =
		voteNumber >= quorum
			? {
					coordinator: coordinatorAddress(dwalletProgramId),
					signatureVoucher: voucherAccount,
					dwallet: dwalletAccount,
					cpiAuthority: votingAuthority,
					dwalletProgramId,
				}
			: undefined;

	await sendTx(
		connection,
		payer,
		[
			buildCastVoteIx(
				votingProgramId,
				proposalPda,
				voteRecordPda,
				councilPda,
				voter.publicKey,
				payer.publicKey,
				proposalId,
				1,
				voteRecordBump,
				votingAuthorityBump,
				cpiAccounts,
			),
		],
		[voter],
	);
	ok(`${voterNames[index]} voted yes`);
}

const proposal = await pollUntil(
	connection,
	proposalPda,
	(data) => data[PROP_STATUS] === PROPOSAL_APPROVED,
	10_000,
);
ok(`Proposal approved (${readU32LE(proposal, PROP_YES_VOTES)}/${quorum} yes)`);

await waitForVoucher(connection, voucherAccount);
ok(`Voucher issued on chain: ${voucherAccount.toBase58()}`);

// ── Step 8: the presign ──

log('8/9', 'Taking a presign from the network...');
const presign = await takePresign(ikaClient, user);
ok('Presign allocated');

// ── Step 9: the signature ──

log('9/9', 'Asking the network to sign...');
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
		`the signature on chain is not the one the network returned:\n` +
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

console.log('\n\x1b[1m\x1b[32m═══ The demo ran to the end ═══\x1b[0m\n');

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
