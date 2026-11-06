// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The signer of a share acceptance. It checks nothing about what it signs, so
 * the package does not export it. The exported functions that accept a share
 * call it after their checks: `signDWalletShareAcceptance` for a new
 * dWallet's first share, and `signReEncryptedShareAcceptance` for a share
 * re-encrypted to the holder.
 */
import { ed25519 } from '@noble/curves/ed25519.js';

import type { ShareAcceptanceSignature } from './share-acceptance.js';

/**
 * Sign `acceptanceDigest` with the holder's 32-byte Ed25519 secret key. The
 * digest is the keccak256 of the dWallet attestation's exact bytes for a new
 * dWallet's first share (`dwalletAttestationDigest`), and of the share
 * attestation's exact bytes for a re-encrypted share
 * (`shareAttestationDigest`). The result is what the chain clients' accept
 * builders take.
 */
export function signShareAcceptance(
	holderSecretKey: Uint8Array,
	acceptanceDigest: Uint8Array,
): ShareAcceptanceSignature {
	return {
		holderPublicKey: ed25519.getPublicKey(holderSecretKey),
		acceptanceDigest: Uint8Array.from(acceptanceDigest),
		signature: ed25519.sign(acceptanceDigest, holderSecretKey),
	};
}
