// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * An app pays for its users on Solana: its wallet is the `payer` of every
 * account and the fee payer, it creates a user's gas deposit with the
 * consent the user's request key signed on the user's device, and with the
 * app's own `RequestKey` as the client's request signer, the requests and the
 * vouchers name the app's key.
 */
import { createDepositInstructions, depositProofMessage } from '@ika.xyz/pre-alpha-solana/instructions';
import { ed25519 } from '@noble/curves/ed25519.js';
import { Connection, Ed25519Program, Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import {
	Curve,
	IkaClient,
	IkaTransaction,
	RequestKey,
	UserShareEncryptionKeys,
} from '../src/web3/index.js';

const chainNumber = 9;
const networkValue = 3;
const config = {
	network: { custom: { networkPublicKeys: [] } },
	programId: Keypair.generate().publicKey,
	chainNumber,
	networkValue,
};
const clientOf = (requestSigner?: RequestKey) =>
	new IkaClient({
		connection: new Connection('http://127.0.0.1:1'),
		grpc: {} as never,
		config,
		requestSigner,
	});
const keys = UserShareEncryptionKeys.fromRootSeedKey(new Uint8Array(32).fill(1), Curve.ED25519);
const user = Keypair.generate().publicKey;
const app = Keypair.generate().publicKey;

describe('an app paying for its users on Solana', () => {
	it("creates a user's deposit from the user's consent, owned and paid by the app", async () => {
		const ikaClient = clientOf();
		// On the user's device: the request key consents to the app.
		const consented = ikaClient.signGasDepositConsent({
			requestKey: await keys,
			depositOwner: app,
		});
		expect(consented.requestPublicKey).toEqual((await keys).getRequestPublicKeyBytes());
		expect(
			ed25519.verify(
				consented.consent,
				depositProofMessage(chainNumber, networkValue, app.toBytes()),
				consented.requestPublicKey,
			),
		).toBe(true);

		// On the app's backend, without the user's keys.
		const ikaTx = new IkaTransaction({ ikaClient, version: 0, owner: app });
		ikaTx.createGasDeposit(consented);
		const [proof, create] = ikaTx.instructions;
		expect(proof.programId.equals(Ed25519Program.programId)).toBe(true);
		// The same instructions as a deposit the user's own secret created.
		const [ownProof, ownCreate] = createDepositInstructions({
			programId: config.programId,
			sender: app,
			requestKey: {
				publicKey: consented.requestPublicKey,
				proofOfPossession: consented.consent,
			},
			chainNumber,
			network: networkValue,
		});
		expect(proof.data).toEqual(ownProof.data);
		expect(create.data).toEqual(ownCreate.data);
	}, 120_000);

	it('makes the payer pay the rent and the fee, while the owner signs', async () => {
		const ikaClient = clientOf();
		const ikaTx = new IkaTransaction({
			ikaClient,
			version: 0,
			owner: user,
			payer: app,
			userShareEncryptionKeys: await keys,
		});
		ikaTx.createGasDeposit();
		const create = ikaTx.instructions[1];
		// Accounts: the deposit's owner (signer), the deposit, the coordinator, the payer.
		expect(create.keys[0].pubkey.equals(user)).toBe(true);
		expect(create.keys[3].pubkey.equals(app)).toBe(true);
		expect(create.keys[3].isWritable).toBe(true);
		const built = ikaTx.buildVersionedTransaction({
			recentBlockhash: PublicKey.default.toBase58(),
		});
		expect(built.message.staticAccountKeys[0].equals(app)).toBe(true);
	}, 120_000);

	it("names the app's request key when the client signs with it", async () => {
		const appKey = RequestKey.generate();
		const ikaClient = clientOf(appKey);
		expect(ikaClient.getRequestPublicKey(await keys)).toEqual(appKey.publicKey);
		expect(clientOf().getRequestPublicKey(await keys)).toEqual(
			(await keys).getRequestPublicKeyBytes(),
		);
		// The app's own deposit, consented by the app's key.
		const ikaTx = new IkaTransaction({ ikaClient, version: 0, owner: app });
		ikaTx.createGasDeposit(
			ikaClient.signGasDepositConsent({ requestKey: appKey, depositOwner: app }),
		);
		expect(ikaTx.instructions).toHaveLength(2);
	}, 120_000);
});
