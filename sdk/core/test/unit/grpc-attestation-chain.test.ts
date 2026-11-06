// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';

import { attestationSigningMessage } from '../../src/grpc/attestation-record';
import {
	verifyAttestationAgainstChain,
	verifyAttestationSignature,
	type NetworkEncryptionKeyChainRecord,
	type NetworkKeyChainReader,
} from '../../src/grpc/requests';

/**
 * `verifyAttestationSignature` proves only that a `NetworkSignedAttestation`
 * is internally consistent: its signature, its data and its public key all
 * come from the same response object. A relay or a compromised server can
 * mint one wholesale under a key of its own choosing and pass that check.
 * `verifyAttestationAgainstChain` is the check that also ties the served
 * key to chain state, through a caller-supplied `NetworkKeyChainReader`.
 */
describe('verifyAttestationAgainstChain', () => {
	const data = new Uint8Array([1, 2, 3, 4, 5]);
	const signedMessage = attestationSigningMessage('dwallet', data);

	const noaSecretKey = ed25519.utils.randomSecretKey();
	const noaPublicKey = ed25519.getPublicKey(noaSecretKey);
	const genuineAttestation = {
		attestation_data: data,
		network_signature: ed25519.sign(signedMessage, noaSecretKey),
		network_pubkey: noaPublicKey,
		signer_noa_public_key: noaPublicKey,
	};

	// An unrelated keypair: not signed by the chain-recorded network key, but
	// capable of producing an internally-consistent attestation under
	// itself — exactly what a relay serving its own key can do.
	const foreignSecretKey = ed25519.utils.randomSecretKey();
	const foreignPublicKey = ed25519.getPublicKey(foreignSecretKey);
	const forgedAttestation = {
		attestation_data: data,
		network_signature: ed25519.sign(signedMessage, foreignSecretKey),
		network_pubkey: foreignPublicKey,
		signer_noa_public_key: foreignPublicKey,
	};

	function readerReturning(
		record: NetworkEncryptionKeyChainRecord | undefined,
	): NetworkKeyChainReader {
		return { fetchNetworkEncryptionKey: async () => record };
	}

	it('accepts a served key that matches the chain record', async () => {
		await expect(
			verifyAttestationAgainstChain(
				genuineAttestation,
				'dwallet',
				readerReturning({ noaPublicKey }),
			),
		).resolves.toBeUndefined();
	});

	it('refuses a served key that differs from the chain record', async () => {
		await expect(
			verifyAttestationAgainstChain(
				genuineAttestation,
				'dwallet',
				readerReturning({ noaPublicKey: foreignPublicKey }),
			),
		).rejects.toThrow(/does not match the on-chain record/);
	});

	it('refuses when no chain record exists for the expected key', async () => {
		await expect(
			verifyAttestationAgainstChain(genuineAttestation, 'dwallet', readerReturning(undefined)),
		).rejects.toThrow(/no on-chain network encryption key record/);
	});

	it('refuses an attestation checked as another kind than the one the network signed', async () => {
		expect(verifyAttestationSignature(genuineAttestation, 'dwallet')).toBe(true);
		expect(verifyAttestationSignature(genuineAttestation, 'presign')).toBe(false);
		await expect(
			verifyAttestationAgainstChain(
				genuineAttestation,
				'presign',
				readerReturning({ noaPublicKey }),
			),
		).rejects.toThrow(/does not verify/);
	});

	it('refuses a response that is consistent with itself but signed under a key not on chain', async () => {
		// The forged attestation passes the self-consistency check on its
		// own...
		expect(verifyAttestationSignature(forgedAttestation, 'dwallet')).toBe(true);
		// ...but the chain only knows the genuine network key, so the combined
		// check must still refuse it.
		await expect(
			verifyAttestationAgainstChain(
				forgedAttestation,
				'dwallet',
				readerReturning({ noaPublicKey }),
			),
		).rejects.toThrow(/does not match the on-chain record/);
	});
});
