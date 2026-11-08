// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The request bytes the SDK produces, against the bytes a validator decodes.
 *
 * This package used to define the request format itself, in
 * `src/bcs-types.ts`. That copy had drifted: it spelled the key-generation
 * variant `DKG` where the enum has `Dkg`, it carried an `approval_proof`
 * field the `Sign` variant no longer has, and it had no `signature_scheme`.
 * A request built through it serialized to bytes no validator accepts, and
 * nothing failed until the network refused the request for what looked like
 * an unrelated reason.
 *
 * The copy is gone and this package now has no request format of its own.
 * What it keeps is this test, which asserts that the one definition in
 * `@ika.xyz/pre-alpha-core` still produces the exact bytes the Rust type produces.
 * The network's Rust code asserts the same value from the other side, so the two cannot drift apart without one of them failing.
 *
 * The core is imported by name, the way anything outside this repository
 * would import it. It is a workspace dependency, so the name resolves to the
 * core's build in this repository: build it first
 * (`pnpm --filter @ika.xyz/pre-alpha-core build`).
 */
import {
	DWalletRequestBcs,
	SignedRequestDataBcs,
	VersionedDWalletDataAttestationBcs,
} from '@ika.xyz/pre-alpha-core';
import { describe, expect, it } from 'vitest';

const filled = (length: number, byte: number) => Array.from(new Uint8Array(length).fill(byte));

/** The request `sign_request_bytes_are_pinned` builds, field for field. */
const SIGN_REQUEST = {
	session_identifier_preimage: filled(32, 0xab),
	epoch: 7n,
	chain_id: { Solana: null },
	network: 3,
	deposit_incarnation: 2n,
	intended_chain_sender: filled(32, 0x55),
	request: {
		Sign: {
			message: Array.from(new TextEncoder().encode('ika grpc solana demo')),
			message_metadata: [],
			signature_scheme: { EddsaSha512: null },
			presign_session_identifier: filled(32, 0x01),
			message_centralized_signature: filled(64, 0x02),
			dwallet_attestation: {
				attestation_data: filled(16, 0x03),
				network_signature: filled(64, 0x04),
				network_pubkey: filled(32, 0x05),
				signer_noa_public_key: filled(32, 0x5d),
			},
			signature_voucher: filled(32, 0x06),
		},
	},
};

const VECTOR =
	'abababababababababababababababababababababababababababababababab' +
	'0700000000000000' + // epoch, little-endian
	'00' + // chain_id: Solana is variant 0
	'03' + // network: a local network
	'0200000000000000' + // deposit_incarnation: life 2, little-endian
	'20' +
	'5555555555555555555555555555555555555555555555555555555555555555' +
	'01' + // request: Sign is variant 1
	'14' +
	'696b61206772706320736f6c616e612064656d6f' +
	'00' + // message_metadata: empty
	'05' + // signature_scheme: EddsaSha512
	'20' +
	'0101010101010101010101010101010101010101010101010101010101010101' +
	'40' +
	'0202020202020202020202020202020202020202020202020202020202020202' +
	'0202020202020202020202020202020202020202020202020202020202020202' +
	'10' +
	'03030303030303030303030303030303' +
	'40' +
	'0404040404040404040404040404040404040404040404040404040404040404' +
	'0404040404040404040404040404040404040404040404040404040404040404' +
	'20' +
	'0505050505050505050505050505050505050505050505050505050505050505' +
	'5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d' + // signer_noa_public_key, no length prefix
	'0606060606060606060606060606060606060606060606060606060606060606'; // signature_voucher, no length prefix

const hex = (bytes: Uint8Array) =>
	Array.from(bytes)
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');

describe('a signing request', () => {
	it('serializes to the bytes the network decodes', () => {
		expect(hex(SignedRequestDataBcs.serialize(SIGN_REQUEST).toBytes())).toBe(VECTOR);
	});

	it('parses those bytes back to the same request', () => {
		const bytes = Uint8Array.from(Buffer.from(VECTOR, 'hex'));
		const parsed = SignedRequestDataBcs.parse(bytes);
		expect(parsed.epoch).toBe('7');
		expect(parsed.deposit_incarnation).toBe('2');
		expect(parsed.chain_id.$kind).toBe('Solana');
		expect(parsed.request.$kind).toBe('Sign');
		const sign = parsed.request.Sign!;
		expect(sign.signature_scheme.$kind).toBe('EddsaSha512');
		expect(new TextDecoder().decode(Uint8Array.from(sign.message))).toBe('ika grpc solana demo');
		expect(sign.message_metadata).toEqual([]);
		expect(sign.dwallet_attestation.network_pubkey).toEqual(filled(32, 0x05));
		expect(sign.dwallet_attestation.signer_noa_public_key).toEqual(filled(32, 0x5d));
		expect(sign.signature_voucher).toEqual(filled(32, 0x06));
	});
});

/**
 * The retired acceptance request, as the network's Rust code pins it. The holder now accepts its
 * share on the chain. Variant 12 stays as a unit placeholder of one byte, so
 * every later variant keeps its index.
 */
describe('the retired acceptance request', () => {
	it('serializes to its one variant byte', () => {
		expect(hex(DWalletRequestBcs.serialize({ RetiredAcceptShare: null }).toBytes())).toBe('0c');
	});
});

/**
 * The dWallet attestation, against `dwallet_attestation_bytes_are_pinned`: the
 * holder and the two hashes follow the sign-during-DKG signature, each an
 * option, and the epoch is last, a little-endian u64 inside the signed bytes.
 */
describe('a dWallet attestation', () => {
	it('parses the holder and the hashes of an encrypted share', () => {
		const bytes =
			'00' +
			'11'.repeat(32) +
			'20' +
			'22'.repeat(32) +
			'00' +
			'21' +
			'33'.repeat(33) +
			'04' +
			'44'.repeat(4) +
			'00' +
			'00' +
			'0100' +
			'55'.repeat(32) +
			'01' +
			'66'.repeat(32) +
			'01' +
			'77'.repeat(32) +
			'0201000000000000';
		const parsed = VersionedDWalletDataAttestationBcs.parse(
			Uint8Array.from(Buffer.from(bytes, 'hex')),
		);
		const attestation = parsed.V1!;
		expect(attestation.holder?.signature_scheme.$kind).toBe('Ed25519');
		expect(attestation.holder?.signer_public_key).toEqual(filled(32, 0x55));
		expect(attestation.encryption_key_hash).toEqual(filled(32, 0x66));
		expect(attestation.encrypted_share_hash).toEqual(filled(32, 0x77));
		expect(attestation.epoch).toBe('258');
	});
});
