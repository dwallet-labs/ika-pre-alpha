// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The holder's acceptance of an encrypted share: the digests it signs, and
 * the signature it sends to the chain.
 *
 * A `Dkg` or `ImportedKeyVerification` request with an encrypted share ends
 * with the network committing the dWallet and its share on the chain. The
 * dWallet then waits for its holder, and the chain issues no voucher for it.
 * Three things make it Active: its holder accepts the share, the new holder of
 * a share re-encrypted from it accepts that share, or the share is made public.
 * While it waits, only the holder its attestation names may send a make-public
 * or a re-encryption. A holder (the key whose registry entry
 * holds the encryption key, `signer_public_key` in the request) accepts with
 * a chain transaction that carries its Ed25519 signature over the digest the
 * share record stores. The chain clients build that transaction:
 * `acceptEncryptedUserShareTx` in `@ika.xyz/sdk-sui` and
 * `acceptEncryptedUserShareInstructions` in `@ika.xyz/sdk-solana`. Anyone may
 * send it and pay for it: the holder's signature is the only authority.
 *
 * The holder must not sign an attestation it has not checked. Each function
 * that signs an acceptance checks first, and signs only when every check
 * holds:
 * - `signDWalletShareAcceptance` (`dwallet-share-acceptance.ts`), for a new
 *   dWallet's first share, compares the attestation with what the user sent
 *   in the creating request and computed for it.
 * - `signReEncryptedShareAcceptance` (`share-ownership.ts`), for a share
 *   re-encrypted to the holder, verifies the previous holder's acceptance, on
 *   the chain or given by the sender, under the key the sender gave, compares the share attestation
 *   with the dWallet and with the holder's own key and ciphertext, and
 *   decrypts the share.
 *
 * The package exports no function that signs an attestation without checking
 * it.
 *
 * The two digests differ. A new dWallet's first share is accepted over the
 * digest of the dWallet attestation (`dwalletAttestationDigest`). A share
 * re-encrypted to a new holder (`reEncryptShareRequest`) is accepted over the
 * digest of the share's own attestation (`shareAttestationDigest`), which the
 * re-encryption's response returned. The dWallet's attestation is the same
 * for every re-encryption of its share, so a signature over it would accept
 * any of them.
 */
import { keccak_256 } from '@noble/hashes/sha3.js';

/**
 * A network-signed attestation as a response carries it. Of the response's
 * fields, the network's signature covers only `attestation_data`.
 */
export interface SignedAttestation {
	attestation_data: number[] | Uint8Array;
	network_signature: number[] | Uint8Array;
	/** The network key that holds the dWallet's network share. */
	network_pubkey: number[] | Uint8Array;
	/** The network key that made `network_signature`. */
	signer_noa_public_key: number[] | Uint8Array;
}

/**
 * The digest a holder signs to accept a dWallet's share: the keccak256 of
 * the attestation's exact bytes. It must match `dwallet_attestation_digest`
 * in `ika-types`.
 */
export function dwalletAttestationDigest(attestationData: number[] | Uint8Array): Uint8Array {
	return keccak_256(Uint8Array.from(attestationData));
}

/**
 * The digest a holder signs to accept a re-encrypted share: the keccak256 of
 * the exact bytes of the share's own attestation, the one the re-encryption's
 * response returned. It must match `share_attestation_digest` in `ika-types`.
 */
export function shareAttestationDigest(shareAttestationData: number[] | Uint8Array): Uint8Array {
	return keccak_256(Uint8Array.from(shareAttestationData));
}

/**
 * A holder's signed acceptance of its encrypted share: what the chain
 * clients' accept builders take. Sui's `acceptEncryptedUserShareTx` takes
 * `holderPublicKey` and `signature`. Solana's
 * `acceptEncryptedUserShareInstructions` takes all three.
 */
export interface ShareAcceptanceSignature {
	/** The holder's Ed25519 public key, 32 bytes. */
	holderPublicKey: Uint8Array;
	/**
	 * The digest the holder signed, 32 bytes. It is the digest the share
	 * record on the chain stores, and the chain checks the signature against
	 * it.
	 */
	acceptanceDigest: Uint8Array;
	/** The holder's Ed25519 signature over `acceptanceDigest`, 64 bytes. */
	signature: Uint8Array;
}
