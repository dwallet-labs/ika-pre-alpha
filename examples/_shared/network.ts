// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * What a demo asks the ika network, through the SDK, as an app asks it.
 *
 * `IkaClient` from `@ika.xyz/pre-alpha-solana/web3` sends the requests over gRPC
 * and reads the ika program's accounts. `IkaTransaction` adds the program's
 * instructions to a transaction the payer signs. `UserShareEncryptionKeys`
 * holds the user's keys: the key the user's share is encrypted to, and the
 * key that signs every request.
 *
 * The Solana devnet pre-alpha runs on a mock ika network. One backend holds
 * an ordinary key for each dWallet and signs with it alone, so the SDK runs
 * in mock mode (`withMockCryptography` from `@ika.xyz/pre-alpha-core/mock`). Mock
 * mode skips the user's half of the 2PC-MPC computation and keeps every
 * other check. Against the real network, build the client without
 * `withMockCryptography`; nothing else in the demos changes.
 *
 * Every request names the epoch the dWallet coordinator account shows. The
 * SDK reads it from the chain before each request.
 */
import { DWalletGrpcClient as NodeGrpcClient } from '@ika.xyz/pre-alpha-core/client';
import { withMockCryptography } from '@ika.xyz/pre-alpha-core/mock';
import { DWalletGrpcClient as WebGrpcClient } from '@ika.xyz/pre-alpha-core/web';
import { dwalletCoordinatorPda, readDWalletCoordinator } from '@ika.xyz/pre-alpha-solana';
import {
	Curve,
	Hash,
	IkaClient,
	IkaTransaction,
	PresignExpiredWithTheEpoch,
	SignatureAlgorithm,
	UserShareEncryptionKeys,
} from '@ika.xyz/pre-alpha-solana/web3';
import type { DWallet, Presign } from '@ika.xyz/pre-alpha-solana/web3';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';

import { confirmByPolling } from './helpers.ts';

/** How long to wait for anything the network writes on chain. */
export const NETWORK_WAIT = { timeout: 300_000, interval: 2_000 };

/** The scheme both demos sign with: EdDSA over SHA-512, on Curve25519. */
export const EDDSA = { signatureAlgorithm: SignatureAlgorithm.EdDSA, hashScheme: Hash.SHA512 };

/** A user: the wallet that pays and owns, and the keys that sign requests. */
export interface User {
	wallet: Keypair;
	keys: UserShareEncryptionKeys;
}

/** A connection to the ika network, and the gRPC client to close at the end. */
export interface Ika {
	ikaClient: IkaClient;
	close(): void;
}

/**
 * Connect to the ika network that holds `programId`, in mock mode.
 *
 * `grpcUrl` picks how the SDK talks to the network:
 *
 * - `https://host`: gRPC-Web, over `fetch`. The devnet pre-alpha serves
 *   this, at `https://solana-alpha-dev-1.ika-network.net`, and so does a
 *   browser app.
 * - `http://host:port`: plain gRPC without TLS.
 * - `host:port`: gRPC with TLS pinned to the committee the network signed,
 *   checked against the program, as an app connects to validators.
 *
 * The network key and the coordinator's chain values come from the network
 * and the chain, so the demo needs no other configuration. A real app
 * names its network's keys from its own configuration instead.
 */
export async function connectToIka(
	connection: Connection,
	programId: PublicKey,
	grpcUrl: string,
): Promise<Ika> {
	const grpc = grpcUrl.startsWith('https://')
		? new WebGrpcClient(grpcUrl)
		: new NodeGrpcClient(grpcUrl.replace(/^http:\/\//, ''), undefined, [], {
				insecure: grpcUrl.startsWith('http://'),
			});
	const coordinatorAccount = await connection.getAccountInfo(
		new PublicKey(dwalletCoordinatorPda(programId.toBytes()).address),
		'confirmed',
	);
	const coordinator =
		coordinatorAccount === null ? null : readDWalletCoordinator(coordinatorAccount.data);
	if (coordinator === null) {
		throw new Error(`the program ${programId.toBase58()} has no dWallet coordinator`);
	}
	const networkKey = Uint8Array.from(await grpc.latestNetworkKeyId());
	const ikaClient = new IkaClient(
		withMockCryptography({
			connection,
			grpc,
			config: {
				network: { custom: { networkPublicKeys: [networkKey] } },
				programId,
				chainNumber: coordinator.chainNumber,
				networkValue: coordinator.network,
			},
		}),
	);
	await ikaClient.initialize(Curve.ED25519);
	return { ikaClient, close: () => grpc.close() };
}

/**
 * Build a transaction with `build`, sign it with the user's wallet, and send
 * it at finalized commitment. Returns what `build` returned.
 *
 * Finalized, because the network reads the chain at finalized: a voucher or
 * an accepted share it cannot see yet is refused.
 */
export async function execute<T>(
	ikaClient: IkaClient,
	connection: Connection,
	user: User,
	build: (ikaTx: IkaTransaction) => Promise<T> | T,
): Promise<T> {
	const transaction = new Transaction();
	const ikaTx = new IkaTransaction({
		ikaClient,
		transaction,
		owner: user.wallet.publicKey,
		userShareEncryptionKeys: user.keys,
	});
	const built = await build(ikaTx);
	const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
	transaction.recentBlockhash = blockhash;
	transaction.feePayer = user.wallet.publicKey;
	// The vouchers an instruction creates sign their own creation.
	transaction.sign(user.wallet, ...ikaTx.signers);
	const signature = await connection.sendRawTransaction(transaction.serialize(), {
		preflightCommitment: 'confirmed',
	});
	await confirmByPolling(connection, signature, 'finalized', lastValidBlockHeight);
	return built;
}

/**
 * A user whose wallet is `wallet`, with new keys: their encryption key is
 * registered on chain, and their request key has a gas deposit.
 *
 * The keys come from a new random root seed. An app keeps the root seed,
 * because the keys decrypt the user's share of every dWallet made with
 * them. The demo makes a new dWallet each run, so it does not keep it.
 *
 * The network charges every request to the gas deposit of the key that
 * signed it. The mock charges nothing, so an empty deposit serves. On a
 * network that charges, fund the deposit with `IkaTransaction.topUpGasDeposit`.
 */
export async function newUser(
	ikaClient: IkaClient,
	connection: Connection,
	wallet: Keypair,
): Promise<User> {
	const keys = await UserShareEncryptionKeys.fromRootSeedKey(
		crypto.getRandomValues(new Uint8Array(32)),
		Curve.ED25519,
	);
	const user = { wallet, keys };
	// The registration carries the whole encryption key, so it goes in a
	// transaction of its own.
	await execute(ikaClient, connection, user, (ikaTx) =>
		ikaTx.registerEncryptionKey({ curve: Curve.ED25519 }),
	);
	await execute(ikaClient, connection, user, (ikaTx) => ikaTx.createGasDeposit());
	return user;
}

/**
 * Create a zero-trust Ed25519 dWallet owned by the user's wallet, accept the
 * user's share of it on chain, and wait for the network to activate it.
 * Returns the dWallet and its account's address.
 *
 * The DKG runs over gRPC. The SDK checks the network's answer, signs the
 * user's acceptance of the share, and the acceptance goes on chain. The
 * program refuses every use of a dWallet before its first share is
 * accepted.
 */
export async function createDWallet(
	ikaClient: IkaClient,
	connection: Connection,
	user: User,
): Promise<{ dWallet: DWallet; address: PublicKey }> {
	const { dWallet } = await ikaClient.requestDWalletDKG({
		curve: Curve.ED25519,
		userShareEncryptionKeys: user.keys,
		owner: user.wallet.publicKey,
	});
	await execute(ikaClient, connection, user, (ikaTx) => ikaTx.acceptEncryptedUserShare({ dWallet }));
	const address = await ikaClient.waitForDWallet(dWallet, NETWORK_WAIT);
	return { dWallet, address };
}

/** Take a presign from the network, for the demos' scheme. */
export function takePresign(ikaClient: IkaClient, user: User): Promise<Presign> {
	return ikaClient.requestGlobalPresign({
		curve: Curve.ED25519,
		signatureAlgorithm: EDDSA.signatureAlgorithm,
		userShareEncryptionKeys: user.keys,
	});
}

/**
 * Ask the network to sign `message` with `dWallet`, under the voucher at
 * `signatureVoucher`, and wait for the network to write the signature into
 * the voucher account. Returns the signature, which the SDK has checked
 * against the dWallet's public key.
 *
 * The network reads the voucher on chain for itself: the program that owns
 * the dWallet issued it, for this dWallet, this message and this scheme,
 * and named the user's request key as the only key that may ask.
 *
 * A presign belongs to its epoch. When the chain moves to a new epoch
 * before the sign is sent, the SDK refuses the old presign
 * (`PresignExpiredWithTheEpoch`) without sending anything, and the demo
 * takes a new one.
 */
export async function signWithVoucher(
	ikaClient: IkaClient,
	user: User,
	dWallet: DWallet,
	signatureVoucher: PublicKey,
	message: Uint8Array,
	presign: Presign,
): Promise<{ signature: Uint8Array; committed: Uint8Array }> {
	const sign = (withPresign: Presign) =>
		ikaClient.requestSign({
			dWallet,
			presign: withPresign,
			signatureVoucherId: signatureVoucher,
			message,
			...EDDSA,
			userShareEncryptionKeys: user.keys,
		});
	const signature = await sign(presign).catch(async (error: unknown) => {
		if (!(error instanceof PresignExpiredWithTheEpoch)) throw error;
		return sign(await takePresign(ikaClient, user));
	});
	const committed = await ikaClient.waitForSignature(
		{ signatureVoucher, dWallet, message, ...EDDSA },
		NETWORK_WAIT,
	);
	return { signature, committed };
}
