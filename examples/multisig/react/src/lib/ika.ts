// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * What the page asks the ika network, through the SDK, as a browser app
 * asks it.
 *
 * `IkaClient` from `@ika.xyz/pre-alpha-solana/web3` sends the requests and reads
 * the ika program's accounts. In a browser it talks gRPC-Web, through
 * `fetch`, to the network's gRPC-Web endpoint. `IkaTransaction` adds the
 * program's instructions to a transaction the connected wallet signs.
 *
 * The Solana devnet pre-alpha runs on a mock ika network, so the client is
 * in mock mode (`withMockCryptography` from `@ika.xyz/pre-alpha-core/mock`). Mock
 * mode skips the user's half of the 2PC-MPC computation and keeps every
 * other check. Against the real network, build the client without it.
 *
 * **Two keys, and which is which matters.** The connected wallet owns the
 * dWallet and pays for every transaction. The user's keys
 * (`UserShareEncryptionKeys`) hold the key the user's share is encrypted to
 * and the request key that signs every gRPC request. The network charges
 * the request key's gas deposit, so the deposit belongs to the request key,
 * and the wallet only pays to open it. The two are bound together when the
 * deposit is created: the request key signs a message naming the wallet's
 * address, and the program checks that signature.
 *
 * The page makes the keys from a new random root seed, held in memory for
 * as long as the tab is open. Reloading the page loses them, and with them
 * the user's share of every dWallet made with them. That is fine for a demo.
 * A real app keeps the root seed, encrypted, or derives it from something
 * the user holds.
 */
import { withMockCryptography } from '@ika.xyz/pre-alpha-core/mock';
import { DWalletGrpcClient } from '@ika.xyz/pre-alpha-core/web';
import { dwalletCoordinatorPda, readDWalletCoordinator } from '@ika.xyz/pre-alpha-solana';
import {
	Curve,
	Hash,
	IkaClient,
	SignatureAlgorithm,
	UserShareEncryptionKeys,
} from '@ika.xyz/pre-alpha-solana/web3';
import { Connection, PublicKey } from '@solana/web3.js';

/** The curve this demo uses. */
export const CURVE = Curve.ED25519;

/** The scheme the demo signs with: EdDSA over SHA-512. */
export const EDDSA = { signatureAlgorithm: SignatureAlgorithm.EdDSA, hashScheme: Hash.SHA512 };

/** How long to wait for anything the network writes on chain. */
export const NETWORK_WAIT = { timeout: 300_000, interval: 2_000 };

/**
 * Connect to the ika network that holds `programId`, in mock mode, over
 * gRPC-Web at `grpcWebUrl`.
 *
 * The network key and the coordinator's chain values come from the network
 * and the chain, so the page needs no other configuration. A real app names
 * its network's keys from its own configuration instead.
 */
export async function connectToIka(
	connection: Connection,
	grpcWebUrl: string,
	programId: PublicKey,
): Promise<IkaClient> {
	const grpc = new DWalletGrpcClient(grpcWebUrl, undefined, [], {
		insecure: grpcWebUrl.startsWith('http://'),
	});
	const account = await connection.getAccountInfo(
		new PublicKey(dwalletCoordinatorPda(programId.toBytes()).address),
		'confirmed',
	);
	const coordinator = account === null ? null : readDWalletCoordinator(account.data);
	if (coordinator === null) {
		throw new Error(`the program ${programId.toBase58()} has no dWallet coordinator`);
	}
	const ikaClient = new IkaClient(
		withMockCryptography({
			connection,
			grpc,
			config: {
				network: {
					custom: { networkPublicKeys: [Uint8Array.from(await grpc.latestNetworkKeyId())] },
				},
				programId,
				chainNumber: coordinator.chainNumber,
				networkValue: coordinator.network,
			},
		}),
	);
	await ikaClient.initialize(CURVE);
	return ikaClient;
}

/** New user keys, from a new random root seed held only in this tab. */
export function newKeys(): Promise<UserShareEncryptionKeys> {
	return UserShareEncryptionKeys.fromRootSeedKey(crypto.getRandomValues(new Uint8Array(32)), CURVE);
}

/**
 * Wait until `account` exists at finalized commitment.
 *
 * The network reads a voucher at finalized. A sign request sent while the
 * voucher is only confirmed is refused with "signature voucher not observed
 * within the wait window".
 */
export async function waitForFinalized(
	connection: Connection,
	account: PublicKey,
	timeoutMs = 120_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if ((await connection.getAccountInfo(account, 'finalized')) !== null) return;
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	throw new Error(`timed out waiting for the account ${account.toBase58()} at finalized`);
}

export function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
