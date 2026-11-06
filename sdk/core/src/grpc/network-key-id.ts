// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The identity of a network encryption key on the dWallet gRPC transport.
 *
 * A `NetworkKeyId` is the key's Ed25519 public key on
 * curve25519: 32 bytes that every validator derives from the key's own DKG
 * output, that do not change across reconfiguration, and that the ika
 * protocol package on Sui derives the key's object address from. Signed
 * requests name a network key by this value and by nothing else; the
 * classic coordinator's object id for the key is a different 32 bytes and
 * names no key on the transport. A client that holds only that object id
 * resolves it with `DWalletGrpcClient.networkKeyIdOf` from
 * `@ika.xyz/sdk/grpc`, which reads the key's public key from a
 * validator.
 *
 * The brand keeps a raw `Uint8Array` (an object id, a public key of another
 * kind) from being passed where a key id is expected; the constructors below
 * are the only way to make one.
 */
import { bcs } from '@mysten/bcs';

declare const networkKeyIdBrand: unique symbol;

export type NetworkKeyId = Uint8Array & { readonly [networkKeyIdBrand]: true };

export const NETWORK_KEY_ID_LENGTH = 32;

/** Wrap 32 bytes as a key id. Any other length is refused. */
export function networkKeyIdFromBytes(bytes: Uint8Array): NetworkKeyId {
	if (bytes.length !== NETWORK_KEY_ID_LENGTH) {
		throw new Error(`a NetworkKeyId is ${NETWORK_KEY_ID_LENGTH} bytes, got ${bytes.length}`);
	}
	return Uint8Array.from(bytes) as NetworkKeyId;
}

/** Parse the `0x`-prefixed (or bare) lower-case hex the node prints. */
export function networkKeyIdFromHex(hex: string): NetworkKeyId {
	const digits = hex.startsWith('0x') ? hex.slice(2) : hex;
	if (digits.length !== NETWORK_KEY_ID_LENGTH * 2 || !/^[0-9a-fA-F]*$/.test(digits)) {
		throw new Error(`a NetworkKeyId is ${NETWORK_KEY_ID_LENGTH * 2} hex digits, got '${hex}'`);
	}
	const bytes = new Uint8Array(NETWORK_KEY_ID_LENGTH);
	for (let i = 0; i < NETWORK_KEY_ID_LENGTH; i++) {
		bytes[i] = parseInt(digits.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes as NetworkKeyId;
}

/** The `0x`-prefixed lower-case hex the node prints for a key id. */
export function networkKeyIdToHex(id: NetworkKeyId): string {
	return `0x${Array.from(id)
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')}`;
}

/**
 * The last entry of the epoch's network keys by age, which lists the keys
 * oldest first. It is the key a new dWallet is created under only while no
 * key is held. While the newest key waits for its registration on every
 * chain, the network refuses a DKG or an imported-key verification under it,
 * and accepts only an older key. `DWalletGrpcClient.latestNetworkKeyId` reads
 * that key from the validator, and uses this function only for a validator
 * that does not send it. An empty list means the epoch has no network key for
 * new dWallets.
 */
export function latestNetworkKeyIdOf(networkKeysByAge: readonly NetworkKeyId[]): NetworkKeyId {
	const latest = networkKeysByAge[networkKeysByAge.length - 1];
	if (latest === undefined) {
		throw new Error('this epoch has no network key for new dWallets');
	}
	return latest;
}

/**
 * The wire form inside a signed request: a length-prefixed 32-byte vector,
 * byte for byte what the field carried when it was a plain `vector<u8>`
 * named `dwallet_network_encryption_public_key`. Nothing a client signed
 * under that name has moved.
 */
export const NetworkKeyIdBcs = bcs.vector(bcs.u8()).transform({
	input: (id: NetworkKeyId) => Array.from(id),
	output: (bytes: number[]) => networkKeyIdFromBytes(Uint8Array.from(bytes)),
});
