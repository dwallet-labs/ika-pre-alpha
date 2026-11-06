// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * Readers for the ika-dwallet program's accounts.
 *
 * The program writes `#[repr(C)]` structs straight into account data, so
 * reading one is a matter of knowing where each field starts. Every
 * account opens with a two-byte header: a discriminator naming the type,
 * then a version.
 *
 * The offsets below mirror the readers the node reads these same accounts
 * with, where the layout is pinned to the program's structs. The discriminators and the total
 * lengths are not repeated here: they come from `wire-tables.json` through
 * `./wire-tables.js`, so a renumbered account fails to be found rather
 * than being mis-read.
 *
 * Every reader returns `null` for data that is not an account of that
 * type. A caller polling for an account it expects to appear can then
 * treat "not there yet" and "there but different" the same way, which is
 * what waiting for the network to write something looks like.
 */
import {
	decodeAttestationProof,
	rebuildDWalletAttestation,
	rebuildEncryptedShareAttestation,
	rebuildPublicShareAttestation,
	VersionedDWalletDataAttestationBcs,
	VersionedEncryptedUserKeyShareAttestationBcs,
	VersionedPartialUserSignatureAttestationBcs,
	VersionedPublicUserKeyShareAttestationBcs,
} from '@ika.xyz/sdk-core';
import type { PartialSignatureAttestationFields } from '@ika.xyz/sdk-core';

import { approvalMessageDigests } from './addresses.js';
import {
	accountDataLen,
	accountDiscriminator,
	accountEntry,
	accountHeader,
} from './wire-tables.js';

/** `DWallet.state`. */
export const DWALLET_STATE_DKG_IN_PROGRESS = 0;
export const DWALLET_STATE_ACTIVE = 1;
export const DWALLET_STATE_FROZEN = 2;
/**
 * A dWallet committed with its first encrypted share, waiting for the share's
 * holder to accept it (`AcceptEncryptedUserShare`). It is not used until then.
 */
export const DWALLET_STATE_AWAITING_KEY_HOLDER_SIGNATURE = 3;

/**
 * `SignatureVoucher.status`. `SIGNED` means the signature is stored.
 * `SETTLED_WITHOUT_DELIVERY` means the network charged for the sign and no
 * signature will ever be written, so waiting for one only runs out the clock.
 * `REVOKED` means the voucher's owner revoked it, so the network agrees to no
 * new sign request for it. A revoke is final. A sign agreed before the
 * revoke still writes its signature into the revoked voucher.
 */
export const SIGNATURE_VOUCHER_PENDING = 0;
export const SIGNATURE_VOUCHER_SIGNED = 1;
export const SIGNATURE_VOUCHER_SETTLED_WITHOUT_DELIVERY = 2;
export const SIGNATURE_VOUCHER_REVOKED = 3;

/**
 * `FutureSignatureVoucher.status`. `OPEN` holds no partial signature yet;
 * `PARTIALLY_SIGNED` holds the network's attestation of step 1 and waits for
 * the completion; `SIGNED` holds the signature. `SETTLED_WITHOUT_DELIVERY`
 * and `REVOKED` mean what they mean for a signature voucher. A revoked
 * future voucher may still hold step 1's attestation.
 */
export const FUTURE_SIGNATURE_VOUCHER_OPEN = 0;
export const FUTURE_SIGNATURE_VOUCHER_PARTIALLY_SIGNED = 1;
export const FUTURE_SIGNATURE_VOUCHER_SIGNED = 2;
export const FUTURE_SIGNATURE_VOUCHER_SETTLED_WITHOUT_DELIVERY = 3;
export const FUTURE_SIGNATURE_VOUCHER_REVOKED = 4;

/**
 * `DWallet.curve`, and the same number the address seeds carry.
 *
 * This one and the next are written out rather than read from the table,
 * because the table has no section for them: they are `DWalletCurve` and
 * `DWalletSignatureScheme`, two Rust enums, and the Rust clients take them
 * from the enum itself. A TypeScript client has nowhere to take them from.
 */
export const CURVE_CURVE25519 = 2;

/** `SignatureVoucher.signature_scheme`: the scheme a Curve25519 dWallet signs with. */
export const SIGNATURE_SCHEME_EDDSA_SHA512 = 5;

function readU16(data: Uint8Array, offset: number): number {
	return data[offset] | (data[offset + 1] << 8);
}

function readU64(data: Uint8Array, offset: number): bigint {
	let value = 0n;
	for (let index = 7; index >= 0; index--) {
		value = (value << 8n) | BigInt(data[offset + index]);
	}
	return value;
}

/** Whether `data` is an account of `name`, long enough to read in full. */
function isAccount(data: Uint8Array, name: string): boolean {
	return (
		data.length >= accountDataLen(name) &&
		data[accountHeader.discriminator_offset] === accountDiscriminator(name)
	);
}

/**
 * The program's coordinator account, which records the network epoch, this
 * chain's fixed chain number, this deployment's network and its ERC-7930
 * chain identifier.
 *
 * Every gRPC request carries an epoch and validators refuse one that is not
 * current, so a client has to read it rather than assume it. The chain
 * number and the network are what the gas-deposit proof of possession and
 * the encryption-key registration message name (`depositProofMessage`,
 * `encryptionKeyRegistrationMessage`). The chain identifier is only a label
 * beside the number, which the network can change; no signed message names
 * it. A top-up names the treasury vault, which the program checks against
 * this record. The account holds more, and the node's reader
 * (`DWalletCoordinatorData` in the `ika-solana-accounts` crate) pins the
 * whole account, but nothing else in it is of any use to a client.
 */
export function readDWalletCoordinator(data: Uint8Array): {
	epoch: bigint;
	chainNumber: number;
	network: number;
	chainIdentifier: Uint8Array;
	/** The IKA token's mint. */
	ikaMint: Uint8Array;
	/** The token account a gas deposit's IKA goes to; a top-up names it. */
	treasuryVault: Uint8Array;
} | null {
	if (!isAccount(data, 'DWalletCoordinator')) {
		return null;
	}
	// The chain identifier's length byte at 116, then up to 40 bytes.
	const length = Math.min(data[116], 40);
	return {
		epoch: readU64(data, 2),
		// The chain number at 569, four little-endian bytes, after every
		// field the account held before it.
		chainNumber: new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(569, true),
		// The network at 630, the account's last byte.
		network: data[630],
		chainIdentifier: data.slice(117, 117 + length),
		ikaMint: data.slice(20, 52),
		treasuryVault: data.slice(52, 84),
	};
}

export interface DWalletAccount {
	/** The wallet or program that owns this dWallet and controls it. */
	owner: Uint8Array;
	curve: number;
	state: number;
	/** The key the network generated. It is this dWallet's identity. */
	publicKey: Uint8Array;
	createdEpoch: bigint;
	/** The public key of the network key the dWallet was committed under. */
	noaPublicKey: Uint8Array;
	isImported: boolean;
	bump: number;
	/**
	 * The import request's session identifier, part of an imported dWallet's
	 * address. `null` for a DKG dWallet.
	 */
	importedSessionIdentifier: Uint8Array | null;
}

/** The dWallet record the network's own address writes once a DKG finishes. */
export function readDWallet(data: Uint8Array): DWalletAccount | null {
	if (!isAccount(data, 'DWallet')) {
		return null;
	}
	const publicKeyLength = Math.min(data[37], 65);
	return {
		owner: data.subarray(2, 34),
		curve: readU16(data, 34),
		state: data[36],
		publicKey: data.subarray(38, 38 + publicKeyLength),
		createdEpoch: readU64(data, 103),
		noaPublicKey: data.subarray(111, 143),
		isImported: data[143] === 1,
		bump: data[144],
		importedSessionIdentifier: data[143] === 1 ? data.subarray(153, 185) : null,
	};
}

export interface NetworkEncryptionKeyAccount {
	/** The public key this key signs under, which is also its identifier. */
	noaPublicKey: Uint8Array;
	state: number;
	createdEpoch: bigint;
	lastReconfigurationEpoch: bigint;
	/** The Blake2b-256 digest of the key's network DKG output. */
	dkgOutputDigest: Uint8Array;
	/**
	 * The DKG record's proof, the BCS of `VersionedAttestationProof`, as the
	 * account stores it: the stored bytes cut to the stored length. Empty
	 * while the record is unsigned, and `null` when the stored length is above
	 * the proof slot.
	 */
	proof: Uint8Array | null;
}

/** The length of a record's proof slot: the length of a V1 proof. */
const RECORD_PROOF_SLOT_LEN = 98;

/**
 * The proof stored in the slot at `offset`: a length byte, then the bytes,
 * cut to the length. `null` when the length is above the slot.
 */
function readRecordProof(data: Uint8Array, offset: number): Uint8Array | null {
	const length = data[offset];
	if (length > RECORD_PROOF_SLOT_LEN) {
		return null;
	}
	return data.subarray(offset + 1, offset + 1 + length);
}

/**
 * One network encryption key.
 *
 * A client finds this account by scanning the program's accounts for the
 * discriminator, because the address is derived from the key's own public
 * key, which the client does not know beforehand.
 */
export function readNetworkEncryptionKey(data: Uint8Array): NetworkEncryptionKeyAccount | null {
	if (!isAccount(data, 'NetworkEncryptionKey')) {
		return null;
	}
	// After the 2-byte header: the digest at 49 and the proof slot at 98.
	return {
		noaPublicKey: data.subarray(2, 34),
		state: data[34],
		createdEpoch: readU64(data, 35),
		lastReconfigurationEpoch: readU64(data, 43),
		dkgOutputDigest: data.subarray(51, 83),
		proof: readRecordProof(data, 100),
	};
}

export interface NetworkReconfigurationOutputAccount {
	/** The reshared network key. */
	noaPublicKey: Uint8Array;
	/** The epoch whose committee holds the reshared shares. */
	epoch: bigint;
	/** The Blake2b-256 digest of the reshare output. */
	digest: Uint8Array;
	/**
	 * The record's proof, the BCS of `VersionedAttestationProof`, as the
	 * account stores it: the stored bytes cut to the stored length. Empty
	 * while unsigned, and `null` when the stored length is above the proof
	 * slot.
	 */
	proof: Uint8Array | null;
}

/**
 * The record of one network key's reshare for one epoch, at
 * `networkReconfigurationOutputPda`. After the 2-byte header it holds the key
 * (32 bytes), the epoch (8), the digest (32), the proof slot (its length,
 * 1 byte at header+72, then 98 bytes), the bump and 8 reserved bytes.
 */
export function readNetworkReconfigurationOutput(
	data: Uint8Array,
): NetworkReconfigurationOutputAccount | null {
	if (!isAccount(data, 'NetworkReconfigurationOutput')) {
		return null;
	}
	return {
		noaPublicKey: data.subarray(2, 34),
		epoch: readU64(data, 34),
		digest: data.subarray(42, 74),
		proof: readRecordProof(data, 74),
	};
}

export interface GasDepositAccount {
	userPublicKey: Uint8Array;
	ikaBalance: bigint;
	solBalance: bigint;
	pendingIkaWithdrawal: bigint;
	pendingSolWithdrawal: bigint;
	/**
	 * Release counter advanced by withdrawal requests and successful claims.
	 * Top-ups and settlements leave it unchanged.
	 */
	withdrawalSequence: bigint;
	ikaDebt: bigint;
	solDebt: bigint;
	sequence: bigint;
}

/**
 * One transport key's gas deposit.
 *
 * Every priced request is charged to this account. A request from a key
 * with no deposit is held rather than answered, and one whose balance is
 * short is refused immediately, so a client that means to send requests
 * funds this first.
 */
export function readGasDeposit(data: Uint8Array): GasDepositAccount | null {
	if (!isAccount(data, 'GasDeposit')) {
		return null;
	}
	return {
		userPublicKey: data.subarray(2, 34),
		ikaBalance: readU64(data, 34),
		solBalance: readU64(data, 42),
		pendingIkaWithdrawal: readU64(data, 82),
		pendingSolWithdrawal: readU64(data, 90),
		withdrawalSequence: readU64(data, 98),
		ikaDebt: readU64(data, 123),
		solDebt: readU64(data, 131),
		sequence: readU64(data, 139),
	};
}

export interface SignatureVoucherAccount {
	/** The dWallet the voucher was issued for. */
	dwallet: Uint8Array;
	messageDigest: Uint8Array;
	messageMetadataDigest: Uint8Array;
	/** Who controls the voucher: sets its key, revokes it, transfers it. */
	owner: Uint8Array;
	signatureScheme: number;
	/**
	 * The transport key a sign request must come from, or `null` while the
	 * voucher has none. The network signs nothing for a voucher with no key.
	 */
	signingKey: Uint8Array | null;
	issuedEpoch: bigint;
	status: number;
	/** Empty until the network writes the signature back. */
	signature: Uint8Array;
}

/**
 * The voucher that authorizes one signature of one message, and later holds
 * that signature.
 *
 * This account is both halves of the loop. Its issuer creates it at a fresh
 * address to authorize the signature; a sign request names that address,
 * and validators read the account there themselves and vote on what each of
 * them sees; and when the signature is finished the network's own address
 * writes it back here. So a demo watches this one account to see the whole
 * thing happen.
 *
 * The `signature` is as the account stores it, and is not verified, and
 * nothing ties it to a dWallet or a message. Use
 * `readSignatureVoucherVerified` unless you verify the signature yourself.
 * This read is for uses that need no signature, such as waiting for the
 * status or reading the signing key.
 */
export function readSignatureVoucherUnverified(data: Uint8Array): SignatureVoucherAccount | null {
	if (!isAccount(data, 'SignatureVoucher')) {
		return null;
	}
	const signatureLength = Math.min(readU16(data, 174), 128);
	return {
		dwallet: data.subarray(2, 34),
		messageDigest: data.subarray(34, 66),
		messageMetadataDigest: data.subarray(66, 98),
		owner: data.subarray(98, 130),
		signatureScheme: readU16(data, 130),
		// The presence byte decides, not the key's value: an all-zero key is
		// a key.
		signingKey: data[132] !== 0 ? data.subarray(133, 165) : null,
		issuedEpoch: readU64(data, 165),
		status: data[173],
		signature: data.subarray(176, 176 + signatureLength),
	};
}

export interface FutureSignatureVoucherAccount {
	/** The dWallet the voucher was issued for. */
	dwallet: Uint8Array;
	messageDigest: Uint8Array;
	messageMetadataDigest: Uint8Array;
	/** Who controls the voucher: sets its key, revokes it, transfers it. */
	owner: Uint8Array;
	signatureScheme: number;
	/**
	 * The transport key the next request must come from, or `null` while the
	 * voucher has none. Step 1 clears it, so the completion needs a key set
	 * after step 1.
	 */
	signingKey: Uint8Array | null;
	issuedEpoch: bigint;
	status: number;
	/**
	 * The partial-signature attestation's proof envelope, the 98 BCS bytes of
	 * `VersionedAttestationProof` as step 1 stored them, unopened: the
	 * attestation version, the public key of the network key that signed,
	 * and the network's signature over the attestation's signing message (tag
	 * byte 2). All zero before step 1. The core's `decodeAttestationProof`
	 * decodes it.
	 */
	attestationProof: Uint8Array;
	/**
	 * Whether step 1 stored its attestation. The flag decides, not the
	 * status: a revoked voucher may hold one.
	 */
	hasPartialSignature: boolean;
	/**
	 * Step 1's partial-signature attestation's fields, as the program stores
	 * them; empty before step 1. `partialSignatureAttestationFields` decodes
	 * them. No hash is stored.
	 */
	attestation: Uint8Array;
	/** Empty until the network writes the signature back. */
	signature: Uint8Array;
}

/**
 * The voucher that authorizes one future sign of one message, in two
 * steps, and later holds the signature.
 *
 * Step 1 stores the network's attestation of the user's partial signature,
 * which holds the verified sign data and the message's digest. No presign is
 * kept on chain. The completion writes the signature. The voucher never
 * holds the message or the partial signature.
 *
 * The `signature` is as the account stores it, and is not verified, and
 * nothing ties it to a dWallet or a message. Use
 * `readFutureSignatureVoucherVerified` unless you verify the signature
 * yourself. This read is for uses that need no signature, such as waiting
 * for the status or reading the signing key or the attestation.
 */
export function readFutureSignatureVoucherUnverified(
	data: Uint8Array,
): FutureSignatureVoucherAccount | null {
	if (!isAccount(data, 'FutureSignatureVoucher')) {
		return null;
	}
	// The proof envelope is 98 bytes at 174 and the step-1 flag at 272. The
	// fields' length is at 273 and their 1,536-byte slot at 275; the
	// signature's length follows it at 1811 and the 128-byte signature at
	// 1813.
	const attestationLength = Math.min(readU16(data, 273), 1536);
	const signatureLength = Math.min(readU16(data, 1811), 128);
	return {
		dwallet: data.subarray(2, 34),
		messageDigest: data.subarray(34, 66),
		messageMetadataDigest: data.subarray(66, 98),
		owner: data.subarray(98, 130),
		signatureScheme: readU16(data, 130),
		signingKey: data[132] !== 0 ? data.subarray(133, 165) : null,
		issuedEpoch: readU64(data, 165),
		status: data[173],
		attestationProof: data.subarray(174, 272),
		hasPartialSignature: data[272] !== 0,
		attestation: data.subarray(275, 275 + attestationLength),
		signature: data.subarray(1813, 1813 + signatureLength),
	};
}

/** What a verified voucher read requires the voucher to hold. */
export interface ExpectedVoucherSignature {
	/** The dWallet the voucher was issued for: its account address, 32 bytes. */
	dwalletAddress: Uint8Array;
	/** The message the voucher authorizes a signature of. */
	message: Uint8Array;
	/** The sign's `message_metadata`; empty for a scheme that takes none. */
	messageMetadata: Uint8Array;
	/** The scheme, as `DWalletSignatureScheme` numbers it. */
	signatureScheme: number;
}

/**
 * Verifies a signature a voucher holds. It resolves when the signature
 * verifies and throws when it does not. The caller binds what the signature
 * is verified against: the dWallet's public output it already checked, the
 * curve, the scheme, the message and the metadata. A caller of
 * `@ika.xyz/sdk-core` passes a function that calls `verifySignatureWithScheme`.
 */
export type VoucherSignatureVerifier = (signature: Uint8Array) => Promise<void>;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/**
 * The signature a voucher holds, after it verifies, or the empty signature
 * when the voucher holds none. Throws when the voucher is not for the
 * expected dWallet, message, metadata or scheme, and when the signature does
 * not verify.
 */
async function voucherSignatureVerified(
	voucher: SignatureVoucherAccount | FutureSignatureVoucherAccount,
	expected: ExpectedVoucherSignature,
	verifySignature: VoucherSignatureVerifier,
): Promise<Uint8Array> {
	const { messageDigest, messageMetadataDigest } = approvalMessageDigests(
		expected.message,
		expected.messageMetadata,
	);
	if (!sameBytes(voucher.dwallet, expected.dwalletAddress)) {
		throw new Error('the voucher is for another dWallet than the expected one');
	}
	if (!sameBytes(voucher.messageDigest, messageDigest)) {
		throw new Error('the voucher is for another message than the expected one');
	}
	if (!sameBytes(voucher.messageMetadataDigest, messageMetadataDigest)) {
		throw new Error('the voucher is for other message metadata than the expected');
	}
	if (voucher.signatureScheme !== expected.signatureScheme) {
		throw new Error('the voucher is for another signature scheme than the expected one');
	}
	if (voucher.signature.length === 0) {
		return voucher.signature;
	}
	await verifySignature(voucher.signature);
	return voucher.signature;
}

/**
 * Read a `SignatureVoucher`, and return its `signature` only after it
 * verifies.
 *
 * One RPC serves the account, so its fields are not trusted. The read
 * requires the voucher's `dwallet`, `messageDigest`, `messageMetadataDigest`
 * and `signatureScheme` to be the expected ones, with the digests computed
 * from the expected message and metadata by `approvalMessageDigests`, and
 * throws otherwise. It returns `null` for data that is not a voucher. The
 * account's `signature` is empty while the voucher holds none. Otherwise the
 * read calls `verifySignature` and returns the account only when that
 * resolves; it throws what that throws. The other fields are as the RPC
 * served them.
 *
 * The read copies `data` once on entry and decodes the copy. So every field
 * it returns is detached from the caller's buffer, and a change to that
 * buffer while `verifySignature` runs does not change the signature returned.
 *
 * The check proves what `verifySignature` proves. Bind it to a dWallet
 * public output you already checked.
 */
export async function readSignatureVoucherVerified(
	data: Uint8Array,
	expected: ExpectedVoucherSignature,
	verifySignature: VoucherSignatureVerifier,
): Promise<SignatureVoucherAccount | null> {
	const voucher = readSignatureVoucherUnverified(Uint8Array.from(data));
	if (voucher === null) {
		return null;
	}
	return {
		...voucher,
		signature: await voucherSignatureVerified(voucher, expected, verifySignature),
	};
}

/**
 * Read a `FutureSignatureVoucher`, and return its `signature` only after it
 * verifies.
 *
 * The read makes the checks of `readSignatureVoucherVerified` on the future
 * voucher's fields of the same names. It throws when the voucher is not for
 * the expected dWallet, message, metadata or scheme, and when the signature
 * does not verify. It returns `null` for data that is not a future voucher.
 * The account's `signature` is empty while the voucher holds none. The other
 * fields, the attestation among them, are as the RPC served them. Like
 * `readSignatureVoucherVerified`, the read decodes a copy of `data` made on
 * entry, so every field it returns is detached from the caller's buffer.
 */
export async function readFutureSignatureVoucherVerified(
	data: Uint8Array,
	expected: ExpectedVoucherSignature,
	verifySignature: VoucherSignatureVerifier,
): Promise<FutureSignatureVoucherAccount | null> {
	const voucher = readFutureSignatureVoucherUnverified(Uint8Array.from(data));
	if (voucher === null) {
		return null;
	}
	return {
		...voucher,
		signature: await voucherSignatureVerified(voucher, expected, verifySignature),
	};
}

/**
 * One holder's encrypted share of a dWallet, as the program stores it. The
 * share's attestation is in its own account
 * (`readEncryptedShareAttestationUnverified`). The SDK's
 * `verifySolanaEncryptedShareRecord` checks every field here against it.
 */
export interface EncryptedUserSecretKeyShareAccount {
	/** The address of the dWallet record the share belongs to. */
	dwallet: Uint8Array;
	/** The holder's signer key, which the share's address ends in. */
	encryptionKeyOwner: Uint8Array;
	/** The share this one was re-encrypted from; all zero for a dWallet's first share. */
	sourceShare: Uint8Array;
	isReEncrypted: boolean;
	createdEpoch: bigint;
	bump: number;
	/** Whether the holder accepted the share (`AcceptEncryptedUserShare`). */
	accepted: boolean;
	/** Seven reserved bytes, which the program writes as zero. */
	reserved: Uint8Array;
	/**
	 * The holder's Ed25519 signature accepting the share, over
	 * `acceptanceDigest`, which the Ed25519 instruction before the accept
	 * verified. All zero until the holder accepts.
	 */
	acceptanceSignature: Uint8Array;
	/**
	 * The digest the holder signs to accept the share, as the network passed it
	 * at the commit: the dWallet attestation's keccak256 for a dWallet's first
	 * share, the share attestation's for a re-encrypted share.
	 */
	acceptanceDigest: Uint8Array;
	/** The encrypted share and its proof. */
	encryptedShare: Uint8Array;
}

// The encrypted share account (tag 101), as `EncryptedUserSecretKeyShareData`
// in `ika-solana-accounts` reads it: the two-byte header, the dWallet (32
// bytes), the holder's signer key (32), the source share (32), the
// re-encryption flag (1), the creation epoch (8, little-endian), the bump
// (1), the accepted flag (1), seven reserved bytes, the encrypted share's
// length (2, little-endian), the acceptance signature (64), the acceptance
// digest (32), then the encrypted share, which ends the account. The fixed
// part is the table's `header_len`.

/**
 * One holder's encrypted share. `null` unless the account is exactly its
 * fixed part followed by the share its length field names, as the Rust
 * reader requires. A layout that drifted from the program's moves the length
 * field or the end of the account, so it is refused rather than read at the
 * wrong offsets.
 */
export function readEncryptedUserSecretKeyShareUnverified(
	data: Uint8Array,
): EncryptedUserSecretKeyShareAccount | null {
	const entry = accountEntry('EncryptedUserSecretKeyShare');
	const fixed = entry.header_len ?? 0;
	if (
		fixed === 0 ||
		data.length < fixed ||
		data[accountHeader.discriminator_offset] !== entry.discriminator ||
		data.length !== fixed + readU16(data, 116)
	) {
		return null;
	}
	return {
		dwallet: data.slice(2, 34),
		encryptionKeyOwner: data.slice(34, 66),
		sourceShare: data.slice(66, 98),
		isReEncrypted: data[98] === 1,
		createdEpoch: readU64(data, 99),
		bump: data[107],
		accepted: data[108] === 1,
		reserved: data.slice(109, 116),
		acceptanceSignature: data.slice(118, 182),
		acceptanceDigest: data.slice(182, 214),
		encryptedShare: data.slice(fixed),
	};
}

/**
 * A holder's registered encryption key for one curve, as the program stores
 * it at `encryptionKeyPda`.
 */
export interface EncryptionKeyAccount {
	/** The holder: the Ed25519 key that signed the registration. */
	signerPublicKey: Uint8Array;
	/** The holder's signature scheme; 0 is Ed25519. */
	signatureScheme: number;
	/** The curve the key is for: 0 secp256k1, 1 secp256r1, 2 Curve25519, 3 Ristretto. */
	curve: number;
	/** The holder's signature over the registration message. This read does not verify it. */
	signature: Uint8Array;
	createdEpoch: bigint;
	bump: number;
	/** The class-groups encryption key. */
	encryptionKey: Uint8Array;
}

// The encryption key account (tag 107), as `EncryptionKeyData` in
// `ika-solana-accounts` reads it: the two-byte header, the holder's signer
// key (32), its signature scheme (1), the curve (2, little-endian), the key's
// length (2, little-endian), the holder's signature (64), the creation epoch
// (8, little-endian), the bump (1), eight reserved bytes, then the key, which
// ends the account. The fixed part is the table's `header_len`.

/**
 * A holder's `EncryptionKey` account. `null` unless the account is exactly
 * its fixed part followed by the key its length field names, as the Rust
 * reader requires.
 */
export function readEncryptionKeyUnverified(data: Uint8Array): EncryptionKeyAccount | null {
	const entry = accountEntry('EncryptionKey');
	const fixed = entry.header_len ?? 0;
	if (
		fixed === 0 ||
		data.length < fixed ||
		data[accountHeader.discriminator_offset] !== entry.discriminator ||
		data.length !== fixed + readU16(data, 37)
	) {
		return null;
	}
	return {
		signerPublicKey: data.slice(2, 34),
		signatureScheme: data[34],
		curve: readU16(data, 35),
		signature: data.slice(39, 103),
		createdEpoch: readU64(data, 103),
		bump: data[111],
		encryptionKey: data.slice(fixed),
	};
}

/** One field of an attestation, with the bytes BCS writes for it. */
export interface AttestationField {
	/** The field's name in the Rust attestation type, or `version`. */
	name: string;
	/** The field's own BCS bytes. */
	bcs: Uint8Array;
}

/**
 * An attestation account, with the attestation's exact BCS bytes rebuilt
 * from the fields it stores by the core's rebuild, at the version its proof
 * envelope names. `attestationData`, `attestationVersion`,
 * `networkSignature` and `signerNoaPublicKey` are the core's
 * `AttestationRecord`, what its record checks take. No hash is stored: a
 * check that needs one hashes `attestationData`.
 */
export interface AttestationAccount {
	/**
	 * The attestation's exact BCS bytes, rebuilt by the core
	 * (`rebuildDWalletAttestation` and the other rebuild functions) from the
	 * `fields` at the proof's version.
	 */
	attestationData: Uint8Array;
	/** The proof's version: the BCS variant index, 0 for `V1`. */
	attestationVersion: number;
	/**
	 * The proof's Ed25519 signature of the network over the attestation's
	 * signing message (the SDK's `attestationSigningMessage`).
	 */
	networkSignature: Uint8Array;
	/**
	 * The public key of the network key that made `networkSignature`, as
	 * the proof names it. The SDK's check requires it to be one of the
	 * network keys the caller trusts, then verifies under it.
	 */
	signerNoaPublicKey: Uint8Array;
	/** The proof envelope as the account stores it: 98 bytes, never opened by the program. */
	attestationProof: Uint8Array;
	/**
	 * Every field of the attestation in its BCS order, the version first. They
	 * are the attestation's bytes, so the network's signature covers them once
	 * the SDK's check for the record's kind has passed, and not before.
	 */
	fields: AttestationField[];
	/**
	 * The account's address bump. It is not a field of the attestation, so the
	 * network's signature over the attestation's signing message does not cover
	 * it. A reader that needs it recomputes it from the address.
	 */
	bump: number;
}

// The attestation account (tag 104), as `DWalletAttestationData` in
// `ika-solana-accounts` reads it: the two-byte header, the bump, the proof
// envelope (the 98 BCS bytes of `VersionedAttestationProof`), then every
// field of the attestation in BCS order. The version is the proof's, and no
// hash is stored. A field whose length varies keeps a fixed-width length:
// one byte for the requester and the public key, two little-endian bytes for
// the public output, the signature made during the DKG and the public share.
// Flags and option tags are one byte, as in BCS, and the curve and the
// holder's scheme are their one-byte variant index.
const ATTESTATION_BUMP = 2;
const ATTESTATION_PROOF = 3;
const ATTESTATION_FIELDS = 101;

/** A byte vector as BCS writes it: the length as ULEB128, then the bytes. */
function bcsByteVector(bytes: Uint8Array): Uint8Array {
	const length: number[] = [];
	let remaining = bytes.length;
	while (remaining >= 0x80) {
		length.push((remaining & 0x7f) | 0x80);
		remaining >>= 7;
	}
	length.push(remaining);
	return Uint8Array.from([...length, ...bytes]);
}

/**
 * Reads an attestation's stored fields one at a time, from `at`, and keeps
 * each field's BCS bytes under its name. Every read fails past the end of
 * the data. The fields must end exactly at the last one, as the Rust
 * reader's `finish` requires.
 */
class AttestationRecordReader {
	readonly fields: AttestationField[] = [];

	constructor(
		private readonly data: Uint8Array,
		private at: number,
	) {}

	take(length: number): Uint8Array | null {
		if (this.at + length > this.data.length) {
			return null;
		}
		const bytes = this.data.slice(this.at, this.at + length);
		this.at += length;
		return bytes;
	}

	/** A one-byte flag: a `bool` or an option's tag, 0 or 1. */
	flag(): Uint8Array | null {
		const bytes = this.take(1);
		return bytes === null || bytes[0] > 1 ? null : bytes;
	}

	/** A byte vector stored with a one-byte length, as BCS writes it. */
	shortValue(): Uint8Array | null {
		const length = this.take(1);
		const bytes = length === null ? null : this.take(length[0]);
		return bytes === null ? null : bcsByteVector(bytes);
	}

	/** A byte vector stored with a two-byte little-endian length, as BCS writes it. */
	longValue(): Uint8Array | null {
		const length = this.take(2);
		const bytes = length === null ? null : this.take(length[0] | (length[1] << 8));
		return bytes === null ? null : bcsByteVector(bytes);
	}

	/** An option: its tag, then its value when the tag is 1. */
	optionValue(readValue: () => Uint8Array | null): Uint8Array | null {
		const tag = this.flag();
		if (tag === null || tag[0] === 0) {
			return tag;
		}
		const value = readValue();
		return value === null ? null : Uint8Array.from([1, ...value]);
	}

	/** Keep `bcs` as the field `name`. False when the read failed. */
	field(name: string, bcs: Uint8Array | null): boolean {
		if (bcs === null) {
			return false;
		}
		this.fields.push({ name, bcs });
		return true;
	}

	finished(): boolean {
		return this.at === this.data.length;
	}

	/** The kept fields' BCS bytes, concatenated in order. */
	bytes(): Uint8Array {
		const bytes = new Uint8Array(this.fields.reduce((total, field) => total + field.bcs.length, 0));
		this.fields.reduce((offset, field) => {
			bytes.set(field.bcs, offset);
			return offset + field.bcs.length;
		}, 0);
		return bytes;
	}
}

/**
 * The V1 fields `parse` decodes from `bytes`, the versioned attestation's
 * BCS laid out from the stored fields. `null` when they do not decode, or
 * are not a `V1`.
 */
function decodedFields<Fields>(parse: () => { V1?: Fields | null }): Fields | null {
	try {
		return parse().V1 ?? null;
	} catch {
		return null;
	}
}

/**
 * Read an attestation account's header, proof and fields. The proof is
 * decoded by the core's `decodeAttestationProof`, which throws an
 * `AttestationRecordError` for bytes that are not one V1 envelope and for a
 * version this SDK cannot rebuild. `readFields` reads the kind's fields after
 * the version, which is the proof's. `rebuild` decodes the laid-out bytes as
 * the kind's attestation and rebuilds them with the core's rebuild at the
 * proof's version; it returns `null` when they do not decode. `null` when
 * the data is not an attestation account, or the fields do not have the
 * kind's layout to their last byte.
 */
function readAttestationAccount(
	data: Uint8Array,
	readFields: (record: AttestationRecordReader) => boolean,
	rebuild: (attestationVersion: number, laidOut: Uint8Array) => Uint8Array | null,
): AttestationAccount | null {
	const entry = accountEntry('DWalletAttestation');
	if (
		data.length < (entry.header_len ?? ATTESTATION_FIELDS) ||
		data[accountHeader.discriminator_offset] !== entry.discriminator
	) {
		return null;
	}
	const attestationProof = data.slice(ATTESTATION_PROOF, ATTESTATION_FIELDS);
	const proof = decodeAttestationProof(attestationProof);
	const record = new AttestationRecordReader(data, ATTESTATION_FIELDS);
	if (
		!record.field('version', Uint8Array.of(proof.attestationVersion)) ||
		!readFields(record) ||
		!record.finished()
	) {
		return null;
	}
	const attestationData = rebuild(proof.attestationVersion, record.bytes());
	if (attestationData === null) {
		return null;
	}
	return {
		attestationData,
		attestationVersion: proof.attestationVersion,
		networkSignature: proof.networkSignature,
		signerNoaPublicKey: proof.signerNoaPublicKey,
		attestationProof,
		fields: record.fields,
		bump: data[ATTESTATION_BUMP],
	};
}

/**
 * A dWallet's attestation account, with the bytes of its
 * `VersionedDWalletDataAttestation` rebuilt by the core's
 * `rebuildDWalletAttestation`. Lays the fields out as
 * `DWalletAttestationData::dwallet_attestation_bytes` does.
 */
export function readDWalletAttestationUnverified(data: Uint8Array): AttestationAccount | null {
	return readAttestationAccount(
		data,
		(record) =>
			record.field('session_identifier', record.take(32)) &&
			record.field('intended_chain_sender', record.shortValue()) &&
			record.field('curve', record.take(1)) &&
			record.field('public_key', record.shortValue()) &&
			record.field('public_output', record.longValue()) &&
			record.field('is_imported_key', record.flag()) &&
			record.field(
				'sign_during_dkg_signature',
				record.optionValue(() => record.longValue()),
			) &&
			// The holder: its scheme's variant index, then its signer key.
			record.field(
				'holder',
				record.optionValue(() => record.take(33)),
			) &&
			record.field(
				'encryption_key_hash',
				record.optionValue(() => record.take(32)),
			) &&
			record.field(
				'encrypted_share_hash',
				record.optionValue(() => record.take(32)),
			) &&
			// The epoch the network made the attestation in: eight
			// little-endian bytes, which BCS writes as they are.
			record.field('epoch', record.take(8)),
		(version, laidOut) => {
			const fields = decodedFields(() => VersionedDWalletDataAttestationBcs.parse(laidOut));
			return fields === null ? null : rebuildDWalletAttestation(version, fields);
		},
	);
}

/**
 * An encrypted share's attestation account, with the bytes of its
 * `VersionedEncryptedUserKeyShareAttestation` rebuilt by the core's
 * `rebuildEncryptedShareAttestation`. Lays the fields out as
 * `DWalletAttestationData::encrypted_share_attestation_bytes` does.
 */
export function readEncryptedShareAttestationUnverified(
	data: Uint8Array,
): AttestationAccount | null {
	return readAttestationAccount(
		data,
		(record) =>
			record.field('session_identifier', record.take(32)) &&
			record.field('intended_chain_sender', record.shortValue()) &&
			record.field('dwallet_public_key', record.shortValue()) &&
			record.field('encrypted_share_hash', record.take(32)) &&
			record.field('encryption_key_hash', record.take(32)) &&
			// The holder: its scheme's variant index, then its signer key.
			record.field('holder', record.take(33)) &&
			record.field('dwallet_attestation_digest', record.take(32)),
		(version, laidOut) => {
			const fields = decodedFields(() =>
				VersionedEncryptedUserKeyShareAttestationBcs.parse(laidOut),
			);
			return fields === null ? null : rebuildEncryptedShareAttestation(version, fields);
		},
	);
}

/**
 * A public share's attestation account, with the bytes of its
 * `VersionedPublicUserKeyShareAttestation` rebuilt by the core's
 * `rebuildPublicShareAttestation`. The share is the
 * `public_user_secret_key_share` field. Lays the fields out as
 * `DWalletAttestationData::public_share_attestation_bytes` does.
 */
export function readPublicShareAttestationUnverified(data: Uint8Array): AttestationAccount | null {
	return readAttestationAccount(
		data,
		(record) =>
			record.field('session_identifier', record.take(32)) &&
			record.field('intended_chain_sender', record.shortValue()) &&
			record.field('dwallet_public_key', record.shortValue()) &&
			record.field('public_user_secret_key_share', record.longValue()) &&
			record.field('dwallet_attestation_digest', record.take(32)),
		(version, laidOut) => {
			const fields = decodedFields(() => VersionedPublicUserKeyShareAttestationBcs.parse(laidOut));
			return fields === null ? null : rebuildPublicShareAttestation(version, fields);
		},
	);
}

/**
 * The partial-signature attestation's fields a future signature voucher
 * stores (`FutureSignatureVoucherAccount.attestation`), decoded for the
 * core's `verifyPartialSignatureVoucherRecord`, at the version `proof`
 * names (the voucher's decoded `attestationProof`). Lays the fields out as
 * `FutureSignatureVoucherData::partial_signature_attestation_bytes` does:
 * one-byte lengths for the requester, the dWallet's public key and the
 * presign's session identifier, a two-byte little-endian length for the
 * verified sign data, and the scheme as its one-byte variant index. `null`
 * when the voucher holds no attestation, or the fields do not have that
 * layout to their last byte.
 */
export function partialSignatureAttestationFields(
	voucher: FutureSignatureVoucherAccount,
	proof: { attestationVersion: number },
): PartialSignatureAttestationFields | null {
	if (!voucher.hasPartialSignature) {
		return null;
	}
	const record = new AttestationRecordReader(voucher.attestation, 0);
	const laidOut =
		record.field('version', Uint8Array.of(proof.attestationVersion)) &&
		record.field('session_identifier', record.take(32)) &&
		record.field('intended_chain_sender', record.shortValue()) &&
		record.field('dwallet_public_key', record.shortValue()) &&
		record.field('dwallet_attestation_hash', record.take(32)) &&
		record.field('future_signature_voucher', record.take(32)) &&
		record.field('presign_session_identifier', record.shortValue()) &&
		record.field('presign_attestation_hash', record.take(32)) &&
		record.field('message_digest', record.take(32)) &&
		record.field('message_metadata_digest', record.take(32)) &&
		record.field('signature_scheme', record.take(1)) &&
		record.field('verified_sign_data', record.longValue()) &&
		record.finished();
	if (!laidOut) {
		return null;
	}
	return decodedFields(() => VersionedPartialUserSignatureAttestationBcs.parse(record.bytes()));
}
