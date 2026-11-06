// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

import { describe, expect, it } from 'vitest';

import { DWalletRequestBcs } from '../../src/grpc/bcs';
import {
	NetworkKeyIdBcs,
	networkKeyIdFromBytes,
	networkKeyIdFromHex,
	networkKeyIdToHex,
} from '../../src/grpc/network-key-id';

/**
 * The identity a signed request names its network key by.
 *
 * The wire form is pinned to the bytes the field carried before it was
 * typed: a one-byte length (32) followed by the key's 32 bytes. The Rust
 * side pins the same bytes, so a change to either
 * encoding fails one of the two tests.
 */
describe('NetworkKeyId', () => {
	const hex = (bytes: Uint8Array) =>
		Array.from(bytes)
			.map((byte) => byte.toString(16).padStart(2, '0'))
			.join('');

	it('encodes as a length-prefixed 32-byte vector', () => {
		const id = networkKeyIdFromBytes(new Uint8Array(32).fill(0x05));
		expect(hex(NetworkKeyIdBcs.serialize(id).toBytes())).toBe(`20${'05'.repeat(32)}`);
	});

	it('is what a Presign request carries', () => {
		const id = networkKeyIdFromBytes(new Uint8Array(32).fill(0x05));
		const bytes = DWalletRequestBcs.serialize({
			Presign: {
				network_key_id: id,
				curve: { Secp256k1: null },
				signature_algorithm: { ECDSASecp256k1: null },
			},
		}).toBytes();
		// Variant 3, then the id, then the two zero-index enums.
		expect(hex(bytes)).toBe(`0320${'05'.repeat(32)}0000`);
	});

	it('round-trips through BCS to the same branded value', () => {
		const id = networkKeyIdFromBytes(new Uint8Array(32).fill(0xab));
		const decoded = NetworkKeyIdBcs.parse(NetworkKeyIdBcs.serialize(id).toBytes());
		expect(hex(decoded)).toBe(hex(id));
	});

	it('refuses any length but thirty-two', () => {
		expect(() => networkKeyIdFromBytes(new Uint8Array(31))).toThrow();
		expect(() => networkKeyIdFromBytes(new Uint8Array(33))).toThrow();
		expect(() => networkKeyIdFromHex(`0x${'05'.repeat(31)}`)).toThrow();
		expect(() => networkKeyIdFromHex('0xzz')).toThrow();
	});

	it('reads and prints the prefixed hex the node uses', () => {
		const text = `0xab${'00'.repeat(30)}01`;
		expect(networkKeyIdToHex(networkKeyIdFromHex(text))).toBe(text);
		expect(networkKeyIdToHex(networkKeyIdFromHex(text.slice(2)))).toBe(text);
	});
});
