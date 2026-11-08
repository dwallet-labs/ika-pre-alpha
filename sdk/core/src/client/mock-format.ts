// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The byte format of a mock value: the values a mock ika network and a
 * client in mock mode exchange in place of the
 * 2PC-MPC protocol's values.
 *
 * This module only names the bytes. The real path imports it to recognize a
 * mock value and refuse it ({@link refuseMockValues}). The mock cryptography
 * that accepts mock values is the separate entry `@ika.xyz/pre-alpha-core/mock`,
 * which the main entry never imports.
 *
 * Every mock value starts with {@link MOCK_MAGIC}, then a kind byte
 * ({@link MockKind}). No output of the real protocol starts with the marker:
 * every one is BCS, whose first byte is a small enum variant or a length,
 * never `0xff` followed by `ika-mock`.
 *
 * The mock network writes the same formats. The conformance vectors in
 * `test/unit/mock-mode.test.ts` pin them.
 */

/** The marker every mock value starts with: `0xff`, then `ika-mock` in ASCII. */
export const MOCK_MAGIC: Uint8Array = Uint8Array.from([
	0xff,
	...new TextEncoder().encode('ika-mock'),
]);

/** What a mock value is: the byte after {@link MOCK_MAGIC}. */
export const MockKind = {
	/** The network key's DKG output a mock network serves. No payload. */
	NetworkKeyOutput: 0,
	/** The protocol parameters of one curve. Payload: the curve number. */
	ProtocolPublicParameters: 1,
	/**
	 * The user's DKG or import message. Payload: the curve number only. No
	 * key is ever sent: the backend makes every dWallet's key.
	 */
	KeyMessage: 2,
	/** A dWallet's public output, as the network attests it. Payload: the curve number, then the public key. */
	DWalletOutput: 3,
	/** A user share encrypted to a holder. Payload: the share. */
	EncryptedShare: 4,
	/** The user's sign message. No payload: the backend signs with the dWallet's key. */
	SignMessage: 5,
	/** A presign. Payload: 32 random bytes the backend chose. */
	Presign: 6,
	/** The user's own DKG output, before the network's answer. Payload: the curve number. */
	UserOutput: 7,
} as const;

export type MockKind = (typeof MockKind)[keyof typeof MockKind];

/** Whether `bytes` is a mock value: it starts with {@link MOCK_MAGIC} and has a kind byte. */
export function isMockValue(bytes: ArrayLike<number>): boolean {
	if (bytes.length <= MOCK_MAGIC.length) return false;
	return MOCK_MAGIC.every((byte, index) => bytes[index] === byte);
}

/** `kind` with `payload`, as a mock value. */
export function mockValue(kind: MockKind, payload: ArrayLike<number> = []): Uint8Array {
	return Uint8Array.from([...MOCK_MAGIC, kind, ...Array.from(payload)]);
}

/** The refusal of a mock value by a client of the real protocol. */
export const MOCK_VALUE_REFUSED =
	"a mock value was given to a client of the real protocol: mock values need the SDK's mock " +
	'feature, a client created with `withMockCryptography` from `@ika.xyz/pre-alpha-core/mock`';

/** Throw {@link MOCK_VALUE_REFUSED} when any of `values` is a mock value. */
export function refuseMockValues(...values: ArrayLike<number>[]): void {
	if (values.some(isMockValue)) throw new Error(MOCK_VALUE_REFUSED);
}
