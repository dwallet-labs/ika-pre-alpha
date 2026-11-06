// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The addresses the ika-dwallet program stores its accounts at.
 *
 * Every derivation here walks the seed layout in
 * the program's wire table (`src/wire-tables-data.ts`) rather than listing seeds itself, so a
 * layout change reaches this code by being read, not by being copied.
 *
 * The order of the seeds is the part that goes wrong. Solana hashes the
 * components with nothing between them, so where one component ends and the
 * next begins does not exist in the derivation. A tag placed after a
 * variable-length value can be swallowed by a longer value, which lands one
 * kind of account on another kind's address; since these accounts are never
 * closed, the address is then taken forever and the victim's creation fails
 * as already-initialized. The program puts the tag in front of the
 * variable-length part for that reason, and so does this.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

import { seedSchema, type SeedComponent } from './wire-tables.js';

/** Solana's limits: at most 16 seeds, each at most 32 bytes. */
const MAX_SEEDS = 16;
const MAX_SEED_LEN = 32;

/** The suffix Solana hashes after the seeds, the bump and the program id. */
const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress');

/** A derived address and the bump byte that produced it. */
export interface DerivedAddress {
	address: Uint8Array;
	bump: number;
}

/**
 * Whether a 32-byte value decodes as an ed25519 point, which is what makes
 * it a possible public key rather than a program derived address.
 *
 * The network's own check decompresses the value with curve25519-dalek.
 * This decodes it with noble, which additionally rejects a y coordinate at
 * or above the field modulus. Those are 19 of 2^255 values, so a candidate
 * hash has never landed on one; if one ever did, this would take a bump the
 * network would not.
 */
function isOnCurve(candidate: Uint8Array): boolean {
	try {
		ed25519.Point.fromBytes(candidate);
		return true;
	} catch {
		return false;
	}
}

/**
 * Solana's `find_program_address`: the first bump from 255 downward whose
 * `sha256(seeds || bump || program_id || "ProgramDerivedAddress")` is not a
 * point on the ed25519 curve.
 */
export function findProgramAddress(seeds: Uint8Array[], programId: Uint8Array): DerivedAddress {
	if (seeds.length + 1 > MAX_SEEDS) {
		throw new Error(`${seeds.length} seeds plus the bump exceeds Solana's limit of ${MAX_SEEDS}`);
	}
	for (const seed of seeds) {
		if (seed.length > MAX_SEED_LEN) {
			throw new Error(`a seed of ${seed.length} bytes exceeds Solana's limit of ${MAX_SEED_LEN}`);
		}
	}
	if (programId.length !== 32) {
		throw new Error(`a program id is 32 bytes, got ${programId.length}`);
	}

	for (let bump = 255; bump >= 0; bump--) {
		const hasher = sha256.create();
		for (const seed of seeds) {
			hasher.update(seed);
		}
		hasher.update(Uint8Array.from([bump]));
		hasher.update(programId);
		hasher.update(PDA_MARKER);
		const candidate = hasher.digest();
		if (!isOnCurve(candidate)) {
			return { address: candidate, bump };
		}
	}
	throw new Error('no bump produced an off-curve address, which cannot happen');
}

/** A value a caller supplies for one seed component. */
export type SeedValue = number | bigint | Uint8Array;

function littleEndian(value: number | bigint, width: number): Uint8Array {
	const bytes = new Uint8Array(width);
	let rest = BigInt(value);
	if (rest < 0n) {
		throw new Error(`a seed number cannot be negative, got ${value}`);
	}
	for (let index = 0; index < width; index++) {
		bytes[index] = Number(rest & 0xffn);
		rest >>= 8n;
	}
	if (rest !== 0n) {
		throw new Error(`${value} does not fit in ${width} bytes`);
	}
	return bytes;
}

function asBytes(component: SeedComponent, value: SeedValue): Uint8Array {
	if (typeof value === 'number' || typeof value === 'bigint') {
		if (component.width === undefined) {
			throw new Error(`${component.name} is variable-length; pass its bytes, not a number`);
		}
		return littleEndian(value, component.width);
	}
	return value;
}

/**
 * The one condition the table states for leaving a component out. The string
 * is compared rather than interpreted, so a new condition fails here instead
 * of being silently treated as this one.
 */
const OMITTED_WHEN_ZERO = 'message_metadata_digest is zero';

function isAllZero(bytes: Uint8Array): boolean {
	return bytes.every((byte) => byte === 0);
}

/**
 * Build one account's seed list from its layout in the table, in the order
 * the program hashes it.
 *
 * `values` supplies every component the layout names that is not a literal.
 * A fixed-width component takes either its bytes or a number, which is
 * encoded little-endian at the stated width. A variable-length component
 * takes its bytes and is split into seeds of the stated size.
 *
 * This is separate from `deriveAddress` so that a test can assert the ORDER
 * rather than only an address. An address vector alone says "these bytes
 * came out", which agrees with whatever the code currently does once it is
 * regenerated; the order is the property that has to hold.
 */
export function deriveSeeds(
	accountName: string,
	values: Record<string, SeedValue | undefined> = {},
): Uint8Array[] {
	const schema = seedSchema(accountName);
	const seeds: Uint8Array[] = [];

	for (const component of schema.components) {
		if (component.literal !== undefined) {
			seeds.push(new TextEncoder().encode(component.literal));
			continue;
		}

		const supplied = values[component.name];
		if (component.omitted_when !== undefined) {
			if (component.omitted_when !== OMITTED_WHEN_ZERO) {
				throw new Error(
					`${accountName}.${component.name} is omitted when "${component.omitted_when}", ` +
						'a condition this code does not implement',
				);
			}
			if (supplied === undefined) {
				continue;
			}
			const bytes = asBytes(component, supplied);
			if (isAllZero(bytes)) {
				continue;
			}
			seeds.push(bytes);
			continue;
		}

		if (supplied === undefined) {
			throw new Error(`${accountName} needs a value for its ${component.name} seed`);
		}
		const bytes = asBytes(component, supplied);

		if (component.width !== undefined) {
			if (bytes.length !== component.width) {
				throw new Error(
					`${accountName}.${component.name} is ${component.width} bytes, got ${bytes.length}`,
				);
			}
			seeds.push(bytes);
			continue;
		}

		const chunk = component.chunks_of;
		if (chunk === undefined) {
			throw new Error(`${accountName}.${component.name} has no width and no chunk size`);
		}
		if (component.min_len !== undefined && bytes.length < component.min_len) {
			throw new Error(
				`${accountName}.${component.name} is at least ${component.min_len} bytes, got ${bytes.length}`,
			);
		}
		if (component.max_len !== undefined && bytes.length > component.max_len) {
			throw new Error(
				`${accountName}.${component.name} is at most ${component.max_len} bytes, got ${bytes.length}`,
			);
		}
		for (let offset = 0; offset < bytes.length; offset += chunk) {
			seeds.push(bytes.subarray(offset, Math.min(offset + chunk, bytes.length)));
		}
	}

	return seeds;
}

/** Derive one account's address from its seed layout in the table. */
export function deriveAddress(
	accountName: string,
	programId: Uint8Array,
	values: Record<string, SeedValue | undefined> = {},
): DerivedAddress {
	return findProgramAddress(deriveSeeds(accountName, values), programId);
}

/**
 * The value every dWallet-family address is derived from: the curve as a
 * little-endian `u16`, then the dWallet's public key.
 *
 * The length varies with the curve — 34 bytes for a 32-byte Ed25519 or
 * Ristretto key, 35 for a compressed secp key, 67 for an uncompressed one —
 * which is why the program chunks it rather than taking it as one seed.
 */
export function dwalletSeedRoot(curve: number, dwalletPublicKey: Uint8Array): Uint8Array {
	const root = new Uint8Array(2 + dwalletPublicKey.length);
	root.set(littleEndian(curve, 2), 0);
	root.set(dwalletPublicKey, 2);
	return root;
}

/**
 * The dWallet record the network writes when a key generation or an import
 * finishes.
 *
 * Pass `importedSessionIdentifier` for an imported dWallet: every import
 * request creates its own dWallet, so its address also holds the request's
 * session identifier (the `session_identifier` of the dWallet's
 * attestation). A DKG dWallet's address holds none.
 */
export function dwalletPda(
	programId: Uint8Array,
	curve: number,
	dwalletPublicKey: Uint8Array,
	importedSessionIdentifier?: Uint8Array,
): DerivedAddress {
	const dwallet_root = dwalletSeedRoot(curve, dwalletPublicKey);
	return importedSessionIdentifier === undefined
		? deriveAddress('DWallet', programId, { dwallet_root })
		: deriveAddress('ImportedDWallet', programId, {
				dwallet_root,
				session_identifier: importedSessionIdentifier,
			});
}

/** The attestation the network writes alongside a new dWallet. */
export function dwalletAttestationPda(
	programId: Uint8Array,
	curve: number,
	dwalletPublicKey: Uint8Array,
	importedSessionIdentifier?: Uint8Array,
): DerivedAddress {
	const dwallet_root = dwalletSeedRoot(curve, dwalletPublicKey);
	return importedSessionIdentifier === undefined
		? deriveAddress('DWalletAttestation', programId, { dwallet_root })
		: deriveAddress('ImportedDWalletAttestation', programId, {
				dwallet_root,
				session_identifier: importedSessionIdentifier,
			});
}

/**
 * One holder's encrypted share of a dWallet. `holder` is the holder's
 * Ed25519 signer key, which the address ends in, so each holder of a
 * dWallet's share has its own.
 *
 * Pass `importedSessionIdentifier` for a share of an imported dWallet, as for
 * `dwalletPda`.
 */
export function encryptedUserSecretKeySharePda(
	programId: Uint8Array,
	curve: number,
	dwalletPublicKey: Uint8Array,
	holder: Uint8Array,
	importedSessionIdentifier?: Uint8Array,
): DerivedAddress {
	const values = {
		dwallet_root: dwalletSeedRoot(curve, dwalletPublicKey),
		encryption_key_owner: holder,
	};
	return importedSessionIdentifier === undefined
		? deriveAddress('EncryptedUserSecretKeyShare', programId, values)
		: deriveAddress('ImportedEncryptedUserSecretKeyShare', programId, {
				...values,
				session_identifier: importedSessionIdentifier,
			});
}

/**
 * The attestation of one holder's encrypted share, beside the share. Its
 * address ends in the holder's signer key, as the share's does.
 *
 * Pass `importedSessionIdentifier` for a share of an imported dWallet, as for
 * `dwalletPda`.
 */
export function encryptedShareAttestationPda(
	programId: Uint8Array,
	curve: number,
	dwalletPublicKey: Uint8Array,
	holder: Uint8Array,
	importedSessionIdentifier?: Uint8Array,
): DerivedAddress {
	const values = {
		dwallet_root: dwalletSeedRoot(curve, dwalletPublicKey),
		encryption_key_owner: holder,
	};
	return importedSessionIdentifier === undefined
		? deriveAddress('EncryptedShareAttestation', programId, values)
		: deriveAddress('ImportedEncryptedShareAttestation', programId, {
				...values,
				session_identifier: importedSessionIdentifier,
			});
}

/**
 * The attestation of a dWallet's public share, which holds the share.
 *
 * Pass `importedSessionIdentifier` for an imported dWallet, as for
 * `dwalletPda`.
 */
export function publicUserShareAttestationPda(
	programId: Uint8Array,
	curve: number,
	dwalletPublicKey: Uint8Array,
	importedSessionIdentifier?: Uint8Array,
): DerivedAddress {
	const dwallet_root = dwalletSeedRoot(curve, dwalletPublicKey);
	return importedSessionIdentifier === undefined
		? deriveAddress('PublicUserShareAttestation', programId, { dwallet_root })
		: deriveAddress('ImportedPublicUserShareAttestation', programId, {
				dwallet_root,
				session_identifier: importedSessionIdentifier,
			});
}

/** The program's single coordinator account. */
export function dwalletCoordinatorPda(programId: Uint8Array): DerivedAddress {
	return deriveAddress('DWalletCoordinator', programId);
}

/** One transport key's gas deposit, which every priced request is charged to. */
export function gasDepositPda(programId: Uint8Array, userPublicKey: Uint8Array): DerivedAddress {
	return deriveAddress('GasDeposit', programId, { user_pubkey: userPublicKey });
}

/**
 * The record of one charge without delivery, keyed by its 32-byte charge id.
 * Its existence means the network's charge for that work landed.
 */
export function gasChargePda(programId: Uint8Array, chargeId: Uint8Array): DerivedAddress {
	return deriveAddress('GasCharge', programId, { charge_id: chargeId });
}

/**
 * One holder's entry in the encryption-key registry, for one curve. The
 * holder is the Ed25519 key that signed the registration message of the
 * encryption key; the curve is the node's number for it (0 secp256k1, 1
 * secp256r1, 2 Curve25519, 3 Ristretto). One entry exists per holder and
 * curve.
 */
export function encryptionKeyPda(
	programId: Uint8Array,
	signerPublicKey: Uint8Array,
	curve: number,
): DerivedAddress {
	return deriveAddress('EncryptionKey', programId, {
		signer_public_key: signerPublicKey,
		curve_le: curve,
	});
}

/** One network encryption key, keyed by the network key's public key. */
export function networkEncryptionKeyPda(
	programId: Uint8Array,
	noaPublicKey: Uint8Array,
): DerivedAddress {
	return deriveAddress('NetworkEncryptionKey', programId, { noa_public_key: noaPublicKey });
}

/**
 * The record of one network key's reshare for `epoch`, the epoch whose
 * committee holds the reshared shares: `["network_reconfig", noa_public_key,
 * epoch as u64 LE]`.
 */
export function networkReconfigurationOutputPda(
	programId: Uint8Array,
	noaPublicKey: Uint8Array,
	epoch: bigint,
): DerivedAddress {
	return deriveAddress('NetworkReconfigurationOutput', programId, {
		noa_public_key: noaPublicKey,
		epoch_le: epoch,
	});
}

/**
 * The two digests a signature voucher stores, computed from the raw message
 * and metadata a sign request carries. The network signs for a voucher only
 * when both are the request's.
 *
 * Empty metadata becomes the all-zero digest rather than the hash of nothing,
 * which is how both chains represent "this scheme carries no metadata".
 */
export function approvalMessageDigests(
	message: Uint8Array,
	messageMetadata: Uint8Array = new Uint8Array(0),
): { messageDigest: Uint8Array; messageMetadataDigest: Uint8Array } {
	return {
		messageDigest: keccak_256(message),
		messageMetadataDigest:
			messageMetadata.length === 0 ? new Uint8Array(32) : keccak_256(messageMetadata),
	};
}
