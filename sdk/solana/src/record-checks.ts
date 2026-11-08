// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The check of a Solana encrypted share: its account and its attestation
 * account.
 *
 * The check verifies the attestation with the chain-neutral check of
 * `@ika.xyz/pre-alpha-core`, under the network key the caller trusts, and then
 * every value the account stores beside it, the holder's acceptance signature
 * included. A failure is an `AttestationRecordError` of check `record`,
 * naming the stored field.
 *
 * `dwalletShareReader` runs this check on every share it returns. A reader
 * built by hand for the core's ownership check must run it too.
 *
 * The check moved here from the core unchanged, so that the core needs no
 * Solana code.
 */
import {
	AttestationRecordError,
	decodeAttestationProof,
	isShareOfTheCreatingRequest,
	requireStoredField as requireStored,
	verifyEncryptedShareAttestationRecord,
	verifyPartialSignatureVoucherRecord,
	verifyRegisteredEncryptionKey,
	verifyStoredEncryptedShare,
} from '@ika.xyz/pre-alpha-core';
import type {
	AttestationRecord,
	EncryptedShareAttestation,
	TrustedNetworkKeys,
	VerifiedDWalletAttestation,
} from '@ika.xyz/pre-alpha-core';
import { ed25519 } from '@noble/curves/ed25519.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

import { partialSignatureAttestationFields } from './accounts.js';
import type { FutureSignatureVoucherAccount } from './accounts.js';

function equalBytes(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
	return (
		left.length === right.length && Array.from(left).every((byte, index) => byte === right[index])
	);
}

/**
 * A Solana encrypted share account as the Solana client's
 * `readEncryptedUserSecretKeyShare` returns it: stored values, none of them
 * verified. The share's attestation is in its own account, which the Solana
 * client's `readEncryptedShareAttestation` reads.
 */
export interface SolanaEncryptedShareAccountInput {
	dwallet: Uint8Array;
	encryptionKeyOwner: Uint8Array;
	sourceShare: Uint8Array;
	isReEncrypted: boolean;
	createdEpoch: bigint;
	bump: number;
	accepted: boolean;
	reserved: Uint8Array;
	acceptanceSignature: Uint8Array;
	acceptanceDigest: Uint8Array;
	encryptedShare: Uint8Array;
}

/**
 * A Solana encrypted share whose account and attestation were checked: a
 * dWallet's first share, or a share re-encrypted to the holder. Every field
 * outside `notCoveredBySignature` is the
 * signed attestation's, or a stored value checked against it.
 */
export interface VerifiedSolanaEncryptedShare {
	/** The decoded share attestation: the hashes and the holder. */
	attestation: EncryptedShareAttestation;
	/** The encrypted share and its proof; its keccak256 is the attestation's hash. */
	encryptedShare: Uint8Array;
	/**
	 * The holder's encryption key as its `EncryptionKey` account registers it;
	 * its keccak256 is the attestation's `encryption_key_hash`.
	 */
	registeredEncryptionKey: Uint8Array;
	/**
	 * The holder's acceptance, checked: it verifies with the attestation's
	 * holder key over the digest of the dWallet's signed attestation for a
	 * first share, and of the share's own signed attestation for a
	 * re-encrypted share.
	 */
	acceptanceSignature: Uint8Array;
	/** Whether the account holds no acceptance, and the signature given stood in for it. */
	acceptanceGiven: boolean;
	/**
	 * Stored values the network's signature does not cover, returned as the
	 * account stores them. The program writes them at the commit:
	 * - `createdEpoch`: the coordinator's epoch at the commit;
	 * - `bump`: the bump of the account's address, which a reader recomputes
	 *   from the address;
	 * - `reserved`: seven bytes the program writes as zero.
	 */
	notCoveredBySignature: { createdEpoch: bigint; bump: number; reserved: Uint8Array };
}

/**
 * Check a Solana encrypted share of the verified `dwallet`, for the holder
 * that was asked for. `account` is the share's account and `attestation` its
 * attestation account, both read by the caller at the addresses derived from
 * the dWallet and the holder (`encryptedUserSecretKeySharePda` and
 * `encryptedShareAttestationPda` in the Solana client), from accounts owned by
 * the program. `dwalletAddress` is the dWallet record's address
 * (`dwalletPda`).
 *
 * The attestation is checked as `verifyEncryptedShareAttestationRecord` does,
 * so it must be the dWallet's first share or a share re-encrypted to the
 * holder. Then every value the account stores: it must name the dWallet
 * (`dwallet`) and the attestation's holder (`encryption_key_owner`); it must
 * name a source share and be marked re-encrypted exactly when its
 * attestation names another session than the dWallet's (`source_share`,
 * `is_re_encrypted`: a first share has neither); the keccak256 of the stored
 * encrypted share must be the attestation's `encrypted_share_hash`
 * (`encrypted_share`, the core's `verifyStoredEncryptedShare`); the keccak256
 * of `registeredEncryptionKey`, the holder's encryption key as its
 * `EncryptionKey` account for the dWallet's curve registers it, must be the
 * attestation's `encryption_key_hash` (`encryption_key_hash`, the core's
 * `verifyRegisteredEncryptionKey`). The holder must have accepted the share
 * (`accepted`), unless `givenAcceptanceSignature` is given: a caller that holds
 * such a signature has what the program would store, and it is checked below
 * in place of the stored one. The digest the account stores as the one the holder signs
 * must be the digest this check computes (`acceptance_digest`): the
 * keccak256 of the dWallet's signed attestation for a first share, and of the
 * share's own signed attestation for a re-encrypted share. The acceptance
 * signature must verify with the holder's key over that computed digest
 * (`acceptance_signature`). The program checks that
 * signature when the holder accepts the share
 * (`acceptEncryptedUserShareInstructions`): the Ed25519 instruction placed
 * before the accept verifies it, and the program refuses the accept unless
 * that instruction's signer, message and signature are the holder, the digest
 * and the signature it stores. The signature is verified again here because the
 * account is read through an RPC the caller does not trust. The program no
 * longer compares the attestation's hashes with the stored share or the
 * registered key when it commits the share, so only this check does. A
 * failure is check `record`, naming the stored field. The
 * account keeps no holder scheme: the program takes only Ed25519 holders, and
 * the attestation's holder scheme is checked as asked for. Returns the
 * verified share.
 */
export function verifySolanaEncryptedShareRecord(
	account: SolanaEncryptedShareAccountInput,
	attestationRecord: AttestationRecord,
	trustedNetworkKeys: TrustedNetworkKeys,
	dwallet: VerifiedDWalletAttestation,
	dwalletAddress: Uint8Array,
	holder: { holderSignerPublicKey: Uint8Array; holderSignatureScheme?: number },
	registeredEncryptionKey: Uint8Array,
	givenAcceptanceSignature?: Uint8Array,
): VerifiedSolanaEncryptedShare {
	requireStored('dwallet', equalBytes(account.dwallet, dwalletAddress));
	const attestation = verifyEncryptedShareAttestationRecord(
		attestationRecord,
		trustedNetworkKeys,
		dwallet,
		holder,
	);
	requireStored(
		'encryption_key_owner',
		equalBytes(attestation.holder.signer_public_key, account.encryptionKeyOwner),
	);
	// A first share names no source share and is not re-encrypted; a
	// re-encrypted share names the share it was re-encrypted from. The program
	// derives that source share's address under the same dWallet.
	const firstShare = isShareOfTheCreatingRequest(attestation, dwallet.attestation);
	const noSourceShare =
		account.sourceShare.length === 32 && account.sourceShare.every((byte) => byte === 0);
	requireStored(
		'source_share',
		account.sourceShare.length === 32 && (firstShare ? noSourceShare : !noSourceShare),
	);
	requireStored('is_re_encrypted', account.isReEncrypted === !firstShare);
	verifyStoredEncryptedShare(attestation, account.encryptedShare);
	verifyRegisteredEncryptionKey(attestation, registeredEncryptionKey);
	// A first share's holder signs the dWallet attestation's digest. A
	// re-encrypted share's holder signs the share attestation's digest: the
	// dWallet's attestation is the same for every re-encryption of the share.
	const solanaAcceptedDigest = firstShare
		? keccak_256(dwallet.attestationData)
		: keccak_256(attestationRecord.attestationData);
	// A share the holder has not accepted stores no signature. The signature
	// the caller holds then stands in for it, and is checked the same way.
	const acceptanceGiven = !account.accepted && givenAcceptanceSignature !== undefined;
	const acceptanceSignature = acceptanceGiven
		? givenAcceptanceSignature
		: account.acceptanceSignature;
	requireStored('accepted', account.accepted || acceptanceGiven);
	requireStored('acceptance_digest', equalBytes(account.acceptanceDigest, solanaAcceptedDigest));
	let signatureVerifies: boolean;
	try {
		signatureVerifies = ed25519.verify(
			acceptanceSignature,
			solanaAcceptedDigest,
			Uint8Array.from(attestation.holder.signer_public_key),
		);
	} catch {
		signatureVerifies = false;
	}
	requireStored('acceptance_signature', signatureVerifies);
	return {
		attestation,
		encryptedShare: account.encryptedShare,
		registeredEncryptionKey,
		acceptanceSignature,
		acceptanceGiven,
		notCoveredBySignature: {
			createdEpoch: account.createdEpoch,
			bump: account.bump,
			reserved: account.reserved,
		},
	};
}

/**
 * Check the partial-signature attestation a future signature voucher stores,
 * as `readFutureSignatureVoucherUnverified` read it from `voucherAddress`.
 *
 * The voucher stores the attestation's fields and its proof envelope, and no
 * hash, and the program checks neither when step 1 commits them. So the
 * check is the core's `verifyPartialSignatureVoucherRecord`: the proof is
 * decoded (`decodeAttestationProof`), the bytes are rebuilt from the fields
 * at the proof's version, the signer must be one of `trustedNetworkKeys` and
 * the signature must verify over the rebuilt bytes, and the attestation must
 * name this voucher: its address, its message digest, its metadata digest
 * and its signature scheme, each refused as check `binding` on that field. A
 * voucher that holds no attestation, or whose fields do not have the
 * attestation's layout, is refused as check `record`, field `attestation`.
 * Returns the decoded attestation.
 */
export function verifySolanaPartialSignatureVoucher(
	voucher: FutureSignatureVoucherAccount,
	voucherAddress: Uint8Array,
	trustedNetworkKeys: TrustedNetworkKeys,
): ReturnType<typeof verifyPartialSignatureVoucherRecord> {
	if (!voucher.hasPartialSignature) {
		throw new AttestationRecordError(
			'record',
			'the voucher holds no partial-signature attestation',
			'attestation',
		);
	}
	const proof = decodeAttestationProof(voucher.attestationProof);
	const fields = partialSignatureAttestationFields(voucher, proof);
	if (fields === null) {
		throw new AttestationRecordError(
			'record',
			"the voucher's stored fields are not a partial-signature attestation's",
			'attestation',
		);
	}
	return verifyPartialSignatureVoucherRecord(proof, fields, trustedNetworkKeys, {
		address: voucherAddress,
		messageDigest: voucher.messageDigest,
		messageMetadataDigest: voucher.messageMetadataDigest,
		signatureScheme: voucher.signatureScheme,
	});
}
