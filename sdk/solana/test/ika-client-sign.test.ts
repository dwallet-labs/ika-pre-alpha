// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * `requestSign` reads the voucher before it computes anything: it refuses a
 * sign for another dWallet, message or scheme than the voucher's, and takes
 * the voucher's scheme when the caller names none. Without a presign it takes
 * its own, and takes a new one when that presign expires before the sign is
 * sent. A sign whose epoch closes before an answer is never sent again.
 */
import { Curve, fromCurveToNumber, VersionedDWalletDataAttestationBcs } from '@ika.xyz/pre-alpha-core';
import { EpochClosedBeforeAnswer, PresignExpiredWithTheEpoch } from '@ika.xyz/pre-alpha-core/common';
import type { DWallet, Network, Presign, VoucherApproval } from '@ika.xyz/pre-alpha-core/common';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { Connection, Keypair } from '@solana/web3.js';
import type { PublicKey } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	Hash,
	IkaClient,
	RequestKey,
	SignatureAlgorithm,
	UserShareEncryptionKeys,
} from '../src/web3/index.js';

const MESSAGE = new TextEncoder().encode('sign this');
const SIGNATURE = new Uint8Array(64).fill(7);
const EDDSA_SHA512 = 5;

function dWallet(isImportedKey = false): DWallet {
	const attestationData = VersionedDWalletDataAttestationBcs.serialize({
		V1: {
			session_identifier: new Array(32).fill(1),
			intended_chain_sender: new Array(32).fill(2),
			curve: { Curve25519: null },
			public_key: new Array(32).fill(3),
			public_output: [4],
			is_imported_key: isImportedKey,
			sign_during_dkg_signature: null,
			holder: { signature_scheme: { Ed25519: null }, signer_public_key: new Array(32).fill(5) },
			encryption_key_hash: new Array(32).fill(6),
			encrypted_share_hash: new Array(32).fill(7),
			epoch: 1n,
		},
	}).toBytes();
	return {
		curve: fromCurveToNumber(Curve.ED25519),
		publicKey: new Uint8Array(32).fill(3),
		networkPublicOutput: new Uint8Array([4]),
		userSecretKeyShare: new Uint8Array(32),
		attestation: {
			attestation_data: attestationData,
			network_signature: new Uint8Array(64),
			network_pubkey: new Uint8Array(32),
			signer_noa_public_key: new Uint8Array(32),
		},
		networkKeyId: new Uint8Array(32) as DWallet['networkKeyId'],
		share: {} as DWallet['share'],
	};
}

function presign(tag: number): Presign {
	return { reference: new Uint8Array([tag]) } as unknown as Presign;
}

class FakeEngine {
	presignsTaken = 0;
	signs: { presign: Presign; signatureScheme: string }[] = [];
	/** How many signs throw an expired presign before one succeeds. */
	closes = 0;
	/** Whether the first sign's epoch closes before an answer. */
	closedBeforeAnswer = false;

	async requestPresign(): Promise<Presign> {
		this.presignsTaken += 1;
		return presign(this.presignsTaken);
	}

	async requestPresignForDWallet(): Promise<Presign> {
		this.presignsTaken += 1;
		return presign(100 + this.presignsTaken);
	}

	async requestSignature(
		_requester: unknown,
		args: { presign: Presign; signatureScheme: string },
	): Promise<Uint8Array> {
		this.signs.push(args);
		if (this.closedBeforeAnswer) {
			this.closedBeforeAnswer = false;
			throw new EpochClosedBeforeAnswer(1n, new Uint8Array(32), 2n, 'epoch closing', {
				epoch: 1n,
				sessionIdentifier: new Uint8Array(32),
				transportKey: new Uint8Array(32),
				curve: 0,
				networkKeyId: new Uint8Array(32),
				kind: 'sign',
				voucher: new Uint8Array(32),
			});
		}
		if (this.closes > 0) {
			this.closes -= 1;
			throw new PresignExpiredWithTheEpoch(1n, 2n);
		}
		return SIGNATURE;
	}
}

class StubbedClient extends IkaClient {
	readonly fake = new FakeEngine();
	approval: VoucherApproval | null = null;

	protected async engine(): Promise<Network> {
		return this.fake as unknown as Network;
	}

	protected async readVoucherApproval(_voucher: PublicKey): Promise<VoucherApproval | null> {
		return this.approval;
	}

	async checkDWalletUsable(): Promise<never> {
		return {} as never;
	}
}

function client(): StubbedClient {
	return new StubbedClient({
		connection: new Connection('http://127.0.0.1:1'),
		grpc: {} as never,
		requestSigner: RequestKey.generate(),
		config: {
			network: { custom: { networkPublicKeys: [new Uint8Array(32)] } },
			programId: Keypair.generate().publicKey,
			chainNumber: 9,
			networkValue: 3,
		},
	});
}

/** A voucher for `wallet` and `MESSAGE` under `client`, with EdDSA over SHA-512. */
function approvalFor(stubbed: StubbedClient, wallet: DWallet): VoucherApproval {
	return {
		dwallet: stubbed.getDWalletAddress(wallet).toBytes(),
		messageDigest: keccak_256(MESSAGE),
		messageMetadataDigest: new Uint8Array(32),
		signatureScheme: EDDSA_SHA512,
	};
}

const keys = { curve: Curve.ED25519 } as UserShareEncryptionKeys;
const voucher = Keypair.generate().publicKey;

describe('requestSign', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("signs with the voucher's scheme when the caller names none", async () => {
		const stubbed = client();
		const wallet = dWallet();
		stubbed.approval = approvalFor(stubbed, wallet);
		const signature = await stubbed.requestSign({
			dWallet: wallet,
			presign: presign(9),
			signatureVoucherId: voucher,
			message: MESSAGE,
			userShareEncryptionKeys: keys,
		});
		expect(signature).toEqual(SIGNATURE);
		expect(stubbed.fake.signs.map((sign) => sign.signatureScheme)).toEqual(['EddsaSha512']);
		expect(stubbed.fake.presignsTaken, 'a given presign is used, not a new one').toBe(0);
	});

	it('refuses, before computing, a message the voucher does not approve', async () => {
		const stubbed = client();
		const wallet = dWallet();
		stubbed.approval = approvalFor(stubbed, wallet);
		await expect(
			stubbed.requestSign({
				dWallet: wallet,
				signatureVoucherId: voucher,
				message: new TextEncoder().encode('another message'),
				userShareEncryptionKeys: keys,
			}),
		).rejects.toThrow('approves another message');
		expect(stubbed.fake.presignsTaken).toBe(0);
		expect(stubbed.fake.signs).toHaveLength(0);
	});

	it("refuses a voucher for another dWallet, and a scheme other than the voucher's", async () => {
		const stubbed = client();
		const wallet = dWallet();
		stubbed.approval = { ...approvalFor(stubbed, wallet), dwallet: new Uint8Array(32).fill(9) };
		await expect(
			stubbed.requestSign({
				dWallet: wallet,
				signatureVoucherId: voucher,
				message: MESSAGE,
				userShareEncryptionKeys: keys,
			}),
		).rejects.toThrow('another dWallet');

		stubbed.approval = { ...approvalFor(stubbed, wallet), signatureScheme: 0 };
		await expect(
			stubbed.requestSign({
				dWallet: wallet,
				signatureVoucherId: voucher,
				message: MESSAGE,
				signatureAlgorithm: SignatureAlgorithm.EdDSA,
				hashScheme: Hash.SHA512,
				userShareEncryptionKeys: keys,
			}),
		).rejects.toThrow('approves the scheme EcdsaKeccak256');
		expect(stubbed.fake.signs).toHaveLength(0);
	});

	it('never signs again with a new presign when the epoch closes before an answer', async () => {
		const stubbed = client();
		const wallet = dWallet();
		stubbed.approval = approvalFor(stubbed, wallet);
		stubbed.fake.closedBeforeAnswer = true;
		await expect(
			stubbed.requestSign({
				dWallet: wallet,
				signatureVoucherId: voucher,
				message: MESSAGE,
				userShareEncryptionKeys: keys,
			}),
		).rejects.toBeInstanceOf(EpochClosedBeforeAnswer);
		expect(stubbed.fake.presignsTaken).toBe(1);
		expect(stubbed.fake.signs).toHaveLength(1);
	});

	it('takes its own presign, and a new one when it expired before the sign was sent', async () => {
		const stubbed = client();
		const wallet = dWallet();
		stubbed.approval = approvalFor(stubbed, wallet);
		stubbed.fake.closes = 1;
		const signature = await stubbed.requestSign({
			dWallet: wallet,
			signatureVoucherId: voucher,
			message: MESSAGE,
			userShareEncryptionKeys: keys,
		});
		expect(signature).toEqual(SIGNATURE);
		expect(stubbed.fake.presignsTaken).toBe(2);
		expect(stubbed.fake.signs.map((sign) => sign.presign.reference[0])).toEqual([1, 2]);
	});

	it('throws the expired presign to a caller that gave its own presign', async () => {
		const stubbed = client();
		const wallet = dWallet();
		stubbed.approval = approvalFor(stubbed, wallet);
		stubbed.fake.closes = 1;
		await expect(
			stubbed.requestSign({
				dWallet: wallet,
				presign: presign(9),
				signatureVoucherId: voucher,
				message: MESSAGE,
				userShareEncryptionKeys: keys,
			}),
		).rejects.toBeInstanceOf(PresignExpiredWithTheEpoch);
		expect(stubbed.fake.presignsTaken).toBe(0);
	});

	it('says the voucher is missing once it stays unreadable', async () => {
		vi.useFakeTimers();
		const stubbed = client();
		const signing = stubbed.requestSign({
			dWallet: dWallet(),
			signatureVoucherId: voucher,
			message: MESSAGE,
			userShareEncryptionKeys: keys,
		});
		const checked = expect(signing).rejects.toThrow('the chain holds no voucher');
		await vi.advanceTimersByTimeAsync(31_000);
		await checked;
	});
});
