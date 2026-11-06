// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The Solana reader checks what an account stores beside its attestation.
 *
 * `checkedSolanaShareReader`, which `dwalletShareReader` is built on, checks
 * every encrypted share account it returns with
 * `verifySolanaEncryptedShareRecord`: each stored field against the signed
 * share attestation, and the holder's acceptance signature. The core checks
 * only the attestation, so these refusals are the reader's alone.
 */
import {
	AttestationRecordError,
	attestationSigningMessage,
	trustedNetworkKeys,
	VersionedDWalletDataAttestationBcs,
	VersionedEncryptedUserKeyShareAttestationBcs,
	type AttestationKind,
	type AttestationRecord,
} from '@ika.xyz/sdk-core';
import { ed25519 } from '@noble/curves/ed25519.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { describe, expect, it } from 'vitest';

import type { SolanaEncryptedShareAccountInput } from '../src/record-checks.js';
import { checkedSolanaShareReader } from '../src/usability.js';

/** The trusted network keys of a custom network: `keys`. */
const trust = (...keys: Uint8Array[]) =>
	trustedNetworkKeys({ custom: { networkPublicKeys: keys } });

const NETWORK_SECRET = new Uint8Array(32).fill(0x21);
const NETWORK_KEY = ed25519.getPublicKey(NETWORK_SECRET);
const HOLDER_SECRET = new Uint8Array(32).fill(0x31);
const HOLDER_KEY = ed25519.getPublicKey(HOLDER_SECRET);
const OTHER_SECRET = new Uint8Array(32).fill(0x32);
const PUBLIC_KEY = new Uint8Array(32).fill(0x13);
const SESSION = new Uint8Array(32).fill(0x11);
const SENDER = new Uint8Array(32).fill(0x12);
const CIPHERTEXT = Uint8Array.from([1, 2, 3, 4, 5]);
const ENCRYPTION_KEY = Uint8Array.from([9, 8, 7, 6]);
const ENCRYPTION_KEY_HASH = keccak_256(ENCRYPTION_KEY);
const DWALLET_ADDRESS = new Uint8Array(32).fill(0xd1);
const CURVE = 2;

const holder = {
	signature_scheme: { Ed25519: null },
	signer_public_key: Array.from(HOLDER_KEY),
};

const DWALLET = VersionedDWalletDataAttestationBcs.serialize({
	V1: {
		session_identifier: Array.from(SESSION),
		intended_chain_sender: Array.from(SENDER),
		curve: { Curve25519: null },
		public_key: Array.from(PUBLIC_KEY),
		public_output: [1, 2, 3],
		is_imported_key: false,
		sign_during_dkg_signature: null,
		holder,
		encryption_key_hash: Array.from(ENCRYPTION_KEY_HASH),
		encrypted_share_hash: Array.from(keccak_256(CIPHERTEXT)),
		epoch: 3n,
	},
}).toBytes();

const SHARE = VersionedEncryptedUserKeyShareAttestationBcs.serialize({
	V1: {
		session_identifier: Array.from(SESSION),
		intended_chain_sender: Array.from(SENDER),
		dwallet_public_key: Array.from(PUBLIC_KEY),
		encrypted_share_hash: Array.from(keccak_256(CIPHERTEXT)),
		encryption_key_hash: Array.from(ENCRYPTION_KEY_HASH),
		holder,
		dwallet_attestation_digest: Array.from(keccak_256(DWALLET)),
	},
}).toBytes();

function signed(attestationData: Uint8Array, kind: AttestationKind): AttestationRecord {
	return {
		attestationData,
		attestationVersion: 0,
		networkSignature: ed25519.sign(
			attestationSigningMessage(kind, attestationData),
			NETWORK_SECRET,
		),
		signerNoaPublicKey: NETWORK_KEY,
	};
}

/**
 * The share account the program writes for the holder's first share, once
 * the holder accepted it. The network passed the dWallet attestation's digest
 * at the commit, and the holder signed it.
 */
const ACCOUNT: SolanaEncryptedShareAccountInput = {
	dwallet: DWALLET_ADDRESS,
	encryptionKeyOwner: HOLDER_KEY,
	sourceShare: new Uint8Array(32),
	isReEncrypted: false,
	createdEpoch: 3n,
	bump: 0xfd,
	accepted: true,
	reserved: new Uint8Array(7),
	acceptanceSignature: ed25519.sign(keccak_256(DWALLET), HOLDER_SECRET),
	acceptanceDigest: keccak_256(DWALLET),
	encryptedShare: CIPHERTEXT,
};

/**
 * A checked reader over unverified reads that serve the dWallet, `account`,
 * and `registeredEncryptionKey` as the holder's registered key.
 */
function readerServing(
	account: SolanaEncryptedShareAccountInput,
	registeredEncryptionKey = ENCRYPTION_KEY,
) {
	return checkedSolanaShareReader({
		trustedNetworkKeys: trust(NETWORK_KEY),
		dwalletAddress: () => DWALLET_ADDRESS,
		readDWalletAttestation: async () => signed(DWALLET, 'dwallet'),
		readDWalletAccount: async () => ({
			curve: CURVE,
			publicKey: PUBLIC_KEY,
			isImported: false,
			importedSessionIdentifier: null,
			noaPublicKey: NETWORK_KEY,
		}),
		readEncryptedShare: async () => ({
			account,
			attestation: signed(SHARE, 'encrypted_share'),
			registeredEncryptionKey,
		}),
		readPublicShareAttestation: async () => undefined,
	});
}

async function shareRefusal(
	account: SolanaEncryptedShareAccountInput,
	registeredEncryptionKey = ENCRYPTION_KEY,
): Promise<unknown> {
	const record = await readerServing(account, registeredEncryptionKey).readDWallet({
		curve: CURVE,
		publicKey: PUBLIC_KEY,
	});
	try {
		await record!.readEncryptedShare(HOLDER_KEY);
	} catch (error) {
		return error;
	}
	return null;
}

describe('the Solana reader refuses a stored field or an acceptance its attestation does not back', () => {
	it('passes the account the program writes', async () => {
		expect(await shareRefusal(ACCOUNT)).toBeNull();
	});

	it('refuses a share account that names another dWallet', async () => {
		const error = await shareRefusal({ ...ACCOUNT, dwallet: new Uint8Array(32).fill(0xd2) });
		expect(error).toBeInstanceOf(AttestationRecordError);
		expect(error).toMatchObject({ check: 'record', field: 'dwallet' });
	});

	it('refuses a share account whose encrypted share is not the one its attestation names', async () => {
		const error = await shareRefusal({ ...ACCOUNT, encryptedShare: Uint8Array.from([1, 2, 3]) });
		expect(error).toBeInstanceOf(AttestationRecordError);
		expect(error).toMatchObject({ check: 'record', field: 'encrypted_share' });
	});

	it('refuses a share whose holder registered another encryption key than its attestation names', async () => {
		const error = await shareRefusal(ACCOUNT, Uint8Array.from([9, 8, 7, 5]));
		expect(error).toBeInstanceOf(AttestationRecordError);
		expect(error).toMatchObject({ check: 'record', field: 'encryption_key_hash' });
	});

	it("refuses a share account whose acceptance signature is another key's", async () => {
		const error = await shareRefusal({
			...ACCOUNT,
			acceptanceSignature: ed25519.sign(keccak_256(DWALLET), OTHER_SECRET),
		});
		expect(error).toBeInstanceOf(AttestationRecordError);
		expect(error).toMatchObject({ check: 'record', field: 'acceptance_signature' });
	});

	// The signature and the digest are the accepted share's, so only the
	// accepted flag tells this share apart from it.
	it('refuses a share account its holder has not accepted', async () => {
		const error = await shareRefusal({ ...ACCOUNT, accepted: false });
		expect(error).toBeInstanceOf(AttestationRecordError);
		expect(error).toMatchObject({ check: 'record', field: 'accepted' });
	});

	// A first share's holder signs the dWallet attestation's digest. This
	// account stores the share attestation's digest instead, and keeps the
	// signature over the right digest, so only the digest check refuses it.
	it('refuses a first share account that stores another digest than the one its holder signs', async () => {
		const error = await shareRefusal({ ...ACCOUNT, acceptanceDigest: keccak_256(SHARE) });
		expect(error).toBeInstanceOf(AttestationRecordError);
		expect(error).toMatchObject({ check: 'record', field: 'acceptance_digest' });
	});
});
