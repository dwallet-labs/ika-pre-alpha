// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The `@solana/kit` entry point makes the same instructions as the
 * `@solana/web3.js` one, names the same addresses, and attaches each signer
 * it holds, so that `signTransactionMessageWithSigners` signs the whole
 * transaction, the voucher's own signature included.
 */
import { Curve, fromCurveToNumber, VersionedDWalletDataAttestationBcs } from '@ika.xyz/pre-alpha-core';
import type { DWallet } from '@ika.xyz/pre-alpha-core/common';
import {
	address,
	appendTransactionMessageInstructions,
	createSolanaRpc,
	createTransactionMessage,
	generateKeyPairSigner,
	pipe,
	setTransactionMessageFeePayerSigner,
	setTransactionMessageLifetimeUsingBlockhash,
	signTransactionMessageWithSigners,
} from '@solana/kit';
import type { Blockhash } from '@solana/kit';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import {
	Hash,
	IkaClient as KitIkaClient,
	IkaTransaction as KitIkaTransaction,
	RequestKey,
	SignatureAlgorithm,
	UserShareEncryptionKeys,
} from '../src/kit/index.js';
import {
	IkaClient as Web3IkaClient,
	IkaTransaction as Web3IkaTransaction,
} from '../src/web3/index.js';

const programId = Keypair.generate().publicKey;
const network = { custom: { networkPublicKeys: [new Uint8Array(32)] } };
const chainNumber = 9;
const networkValue = 3;
const requestKey = RequestKey.generate();
const keys = { curve: Curve.ED25519 } as UserShareEncryptionKeys;

/** A client whose ownership check passes for any dWallet, as the chain would for the holder's. */
class UsableKitClient extends KitIkaClient {
	async checkDWalletUsable(wallet: DWallet): Promise<never> {
		return {
			holder: new Uint8Array(32),
			dwallet: { chain: 'solana', address: this.addressBytes(this.getDWalletAddress(wallet)) },
		} as never;
	}
}

const kitClient = new UsableKitClient({
	rpc: createSolanaRpc('http://127.0.0.1:1'),
	grpc: {} as never,
	requestSigner: requestKey,
	config: { network, programId: address(programId.toBase58()), chainNumber, networkValue },
});
const web3Client = new Web3IkaClient({
	connection: new Connection('http://127.0.0.1:1'),
	grpc: {} as never,
	requestSigner: requestKey,
	config: { network, programId, chainNumber, networkValue },
});

function dWallet(): DWallet {
	return {
		curve: fromCurveToNumber(Curve.ED25519),
		publicKey: new Uint8Array(32).fill(3),
		attestation: {
			attestation_data: VersionedDWalletDataAttestationBcs.serialize({
				V1: {
					session_identifier: new Array(32).fill(1),
					intended_chain_sender: new Array(32).fill(2),
					curve: { Curve25519: null },
					public_key: new Array(32).fill(3),
					public_output: [4],
					is_imported_key: false,
					sign_during_dkg_signature: null,
					holder: {
						signature_scheme: { Ed25519: null },
						signer_public_key: new Array(32).fill(5),
					},
					encryption_key_hash: new Array(32).fill(6),
					encrypted_share_hash: new Array(32).fill(7),
					epoch: 1n,
				},
			}).toBytes(),
		},
	} as unknown as DWallet;
}

describe('@ika.xyz/pre-alpha-solana/kit', () => {
	it('names the same addresses as the web3.js client', () => {
		const wallet = dWallet();
		expect(kitClient.programId).toBe(programId.toBase58());
		expect(kitClient.getDWalletAddress(wallet)).toBe(
			web3Client.getDWalletAddress(wallet).toBase58(),
		);
	});

	it('makes the same instructions as the web3.js IkaTransaction', () => {
		const owner = Keypair.generate().publicKey;
		const newOwner = Keypair.generate().publicKey;
		const voucher = Keypair.generate().publicKey;
		const consent = kitClient.signGasDepositConsent({
			requestKey,
			depositOwner: address(owner.toBase58()),
		});

		const kit = new KitIkaTransaction({ ikaClient: kitClient, owner: address(owner.toBase58()) })
			.createGasDeposit(consent)
			.transferDWallet({ dWallet: dWallet(), newOwner: address(newOwner.toBase58()) })
			.revokeSignatureVoucher({ signatureVoucher: address(voucher.toBase58()) });
		const web3 = new Web3IkaTransaction({
			ikaClient: web3Client,
			owner,
			transaction: new Transaction(),
		})
			.createGasDeposit(web3Client.signGasDepositConsent({ requestKey, depositOwner: owner }))
			.transferDWallet({ dWallet: dWallet(), newOwner })
			.revokeSignatureVoucher({ signatureVoucher: voucher });

		expect(kit.instructions).toEqual(
			web3.instructions.map((instruction) => ({
				programAddress: instruction.programId.toBase58(),
				accounts: instruction.keys.map((key) => ({
					address: key.pubkey.toBase58(),
					role: (key.isSigner ? 2 : 0) + (key.isWritable ? 1 : 0),
				})),
				data: Uint8Array.from(instruction.data),
			})),
		);

		// An instruction of the caller's goes in and comes out unchanged.
		const own = kit.instructions[0];
		expect(
			new KitIkaTransaction({ ikaClient: kitClient, owner: address(owner.toBase58()) }).add(own)
				.instructions,
		).toEqual([own]);
	});

	it('signs a kit transaction with the voucher and the owner it holds', async () => {
		const owner = await generateKeyPairSigner();
		const ikaTx = new KitIkaTransaction({
			ikaClient: kitClient,
			owner,
			userShareEncryptionKeys: keys,
		});
		const voucher = await ikaTx.approveMessage({
			dWallet: dWallet(),
			message: new TextEncoder().encode('sign this'),
			signatureAlgorithm: SignatureAlgorithm.EdDSA,
			hashScheme: Hash.SHA512,
		});
		expect(ikaTx.signers.map((signer) => signer.address)).toEqual([voucher]);

		const message = pipe(
			createTransactionMessage({ version: 0 }),
			(m) => setTransactionMessageFeePayerSigner(owner, m),
			(m) =>
				setTransactionMessageLifetimeUsingBlockhash(
					{
						blockhash: new PublicKey(new Uint8Array(32).fill(8)).toBase58() as Blockhash,
						lastValidBlockHeight: 100n,
					},
					m,
				),
			(m) => appendTransactionMessageInstructions(ikaTx.instructions, m),
		);
		const signed = await signTransactionMessageWithSigners(message);
		expect(Object.keys(signed.signatures).sort()).toEqual([owner.address, voucher].sort());
		expect(Object.values(signed.signatures).every((signature) => signature !== null)).toBe(true);
	});
});
