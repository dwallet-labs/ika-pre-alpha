// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * What the ownership check (`assertDWalletUsable` in `share-ownership.ts`)
 * verified, kept for each result it made. The package does not export this
 * module: only the SDK's own modules read the state of a result, so a caller
 * can neither make a result nor change what one was checked for.
 */

/**
 * What a check verified, kept apart from the result the caller holds. A
 * result's byte arrays can be changed in place even though the result is
 * frozen, so reuse is checked against these private copies only.
 */
export interface IssuedState {
	chain: 'sui' | 'solana';
	address: Uint8Array;
	curve: number;
	publicKey: Uint8Array;
	importedSessionIdentifier?: Uint8Array;
	holder: Uint8Array;
	share: 'encrypted' | 'public';
	migrated: boolean;
	/**
	 * `true` means no acceptance is on the chain for this share, and the
	 * caller's signature stood in for one. It does not mean the dWallet's state
	 * was read. The holder may then send only a make-public or a re-encryption,
	 * and must sign it itself.
	 */
	waiting: boolean;
	/** The dWallet's public output, from the attestation the check verified. */
	publicOutput: Uint8Array;
	/**
	 * The dWallet's attestation as the check verified it: the bytes the chain
	 * record holds, the record's network signature, the reader's trusted
	 * network key as the key that holds the dWallet's network share, and the
	 * record's signer, under which that signature verified.
	 */
	attestation: {
		attestation_data: Uint8Array;
		network_signature: Uint8Array;
		network_pubkey: Uint8Array;
		signer_noa_public_key: Uint8Array;
	};
	/** When the check ended, in milliseconds since the Unix epoch (`Date.now()`). */
	verifiedAt: number;
}

/**
 * The results `assertDWalletUsable` made, each with what its check verified,
 * so a builder can tell them from a copy and is not misled by a changed one.
 */
export const issued = new WeakMap<object, IssuedState>();

/**
 * The holder each make-public or re-encryption request built from a `waiting`
 * result must be signed by, kept for the request value the builder returned.
 * `signGrpcRequest` reads it, because a signed request carries no result.
 */
export const waitingRequestHolders = new WeakMap<object, Uint8Array>();

/**
 * Why a result that says `waiting` builds no sign: the chain issues no voucher,
 * and the network refuses a sign and charges for it, until the dWallet is
 * Active.
 */
export const WAITING_RESULT_BUILDS_NO_SIGN =
	'the usability result says the dWallet waits for its holder: accept a share on the chain, or ' +
	'make the share public, and run assertDWalletUsable again before you sign';
