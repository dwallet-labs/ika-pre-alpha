// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

import { describe, expect, it } from 'vitest';

import { networkKeyIdFromBytes } from '../../src/grpc/network-key-id';
import { GRPC_REQUEST_SIZE_LIMITS } from '../../src/grpc/request-size-limits';
import { generateTransportKeypair } from '../../src/grpc/requests';
import { signRequestBytes } from '../../src/grpc/sign-request-bytes';

/**
 * The network refuses a gRPC request over one of its size limits, from the
 * request's bytes, and charges the signer for it. The SDK refuses to sign
 * such a request, with the same numbers and the same sentence, so a caller
 * never pays for a request the SDK could have caught.
 */

const keypair = generateTransportKeypair();

const attestation = (networkSignature: number) => ({
	attestation_data: new Uint8Array(100),
	network_signature: new Uint8Array(networkSignature),
	network_pubkey: new Uint8Array(32),
	signer_noa_public_key: new Uint8Array(32),
});

/** A sign request whose byte fields have the given lengths. */
function sign(lengths: {
	message?: number;
	messageMetadata?: number;
	messageCentralizedSignature?: number;
	networkSignature?: number;
	presignSessionIdentifier?: number;
}) {
	return {
		session_identifier_preimage: new Uint8Array(32),
		epoch: 1n,
		chain_id: { Sui: null },
		network: 3,
		intended_chain_sender: new Uint8Array(32),
		request: {
			Sign: {
				message: new Uint8Array(lengths.message ?? 32),
				message_metadata: new Uint8Array(lengths.messageMetadata ?? 0),
				signature_scheme: { EcdsaKeccak256: null },
				presign_session_identifier: new Uint8Array(lengths.presignSessionIdentifier ?? 42),
				message_centralized_signature: new Uint8Array(lengths.messageCentralizedSignature ?? 64),
				dwallet_attestation: attestation(lengths.networkSignature ?? 64),
				signature_voucher: new Uint8Array(32),
			},
		},
	} as Parameters<typeof signRequestBytes>[1];
}

describe('signRequestBytes size limits', () => {
	const { fieldBytes, messageBytes, messageMetadataBytes, signedRequestDataBytes } =
		GRPC_REQUEST_SIZE_LIMITS;

	it('signs a byte field at exactly its limit and refuses one byte over', () => {
		expect(() =>
			signRequestBytes(keypair, sign({ messageCentralizedSignature: fieldBytes })),
		).not.toThrow();
		expect(() =>
			signRequestBytes(keypair, sign({ messageCentralizedSignature: fieldBytes + 1 })),
		).toThrow(
			`the request's message_centralized_signature is ${fieldBytes + 1} bytes, over the limit of ${fieldBytes} bytes`,
		);
	});

	it('signs a message at exactly its limit and refuses one byte over', () => {
		expect(() => signRequestBytes(keypair, sign({ message: messageBytes }))).not.toThrow();
		expect(() => signRequestBytes(keypair, sign({ message: messageBytes + 1 }))).toThrow(
			`the request's message is ${messageBytes + 1} bytes, over the limit of ${messageBytes} bytes`,
		);
	});

	it('signs message metadata at exactly its limit and refuses one byte over', () => {
		expect(() =>
			signRequestBytes(keypair, sign({ messageMetadata: messageMetadataBytes })),
		).not.toThrow();
		expect(() =>
			signRequestBytes(keypair, sign({ messageMetadata: messageMetadataBytes + 1 })),
		).toThrow(
			`the request's message_metadata is ${messageMetadataBytes + 1} bytes, over the limit of ${messageMetadataBytes} bytes`,
		);
	});

	it('signs a whole request at exactly its limit and refuses one byte over', () => {
		// Three fields at their limits, and the presign reference as the
		// filler that brings the whole request to its limit. A filler of 128
		// to 16,383 bytes has a two-byte length prefix, so it adds its own
		// length plus one byte over an empty one.
		const withFiller = (presignSessionIdentifier: number) =>
			sign({
				message: messageBytes,
				messageCentralizedSignature: fieldBytes,
				networkSignature: fieldBytes,
				presignSessionIdentifier,
			});
		const withoutFiller = signRequestBytes(keypair, withFiller(0)).signedRequestData.length;
		const filler = signedRequestDataBytes - withoutFiller - 1;
		expect(filler).toBeGreaterThanOrEqual(128);
		expect(filler + 1).toBeLessThan(16_384);

		const atTheLimit = signRequestBytes(keypair, withFiller(filler));
		expect(atTheLimit.signedRequestData.length).toBe(signedRequestDataBytes);
		expect(() => signRequestBytes(keypair, withFiller(filler + 1))).toThrow(
			`the signed request is ${signedRequestDataBytes + 1} bytes, over the limit of ${signedRequestDataBytes} bytes`,
		);
	});
});

/** A DKG with a sign whose sign's message has `messageLength` bytes. */
function dkgWithASign(messageLength: number) {
	return {
		session_identifier_preimage: new Uint8Array(32),
		epoch: 1n,
		chain_id: { Sui: null },
		network: 3,
		intended_chain_sender: new Uint8Array(32),
		request: {
			Dkg: {
				network_key_id: networkKeyIdFromBytes(new Uint8Array(32)),
				curve: { Secp256k1: null },
				centralized_public_key_share_and_proof: new Uint8Array(8),
				user_secret_key_share: {
					Public: { public_user_secret_key_share: new Uint8Array(8) },
				},
				user_public_output: new Uint8Array(8),
				sign_during_dkg_request: {
					presign_session_identifier: new Uint8Array(42),
					presign: new Uint8Array(16),
					signature_scheme: { EcdsaKeccak256: null },
					message: new Uint8Array(messageLength),
					message_metadata: new Uint8Array(0),
					message_centralized_signature: new Uint8Array(64),
				},
			},
		},
	} as Parameters<typeof signRequestBytes>[1];
}

/**
 * A DKG's sign holds its message to the message limit, as the network does
 * (`sign_during_dkg_byte_fields` in `ika-types`), and names it by its path in
 * the request.
 */
describe('signRequestBytes size limits of a DKG with a sign', () => {
	const { messageBytes } = GRPC_REQUEST_SIZE_LIMITS;

	it("signs a DKG's sign message at exactly its limit and refuses one byte over", () => {
		expect(() => signRequestBytes(keypair, dkgWithASign(messageBytes))).not.toThrow();
		expect(() => signRequestBytes(keypair, dkgWithASign(messageBytes + 1))).toThrow(
			`the request's sign_during_dkg_request.message is ${messageBytes + 1} bytes, over the limit of ${messageBytes} bytes`,
		);
	});
});
