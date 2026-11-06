// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The network names a signature by one scheme (`DWalletSignatureScheme`):
 * an algorithm and its hash together. This SDK takes them apart, as
 * `@ika.xyz/sdk` does: a `SignatureAlgorithm` and a `Hash`.
 */
import {
	Hash,
	SignatureAlgorithm,
	validateCurveSignatureAlgorithm,
	validateHashSignatureCombination,
} from '../index.js';
import type { Curve } from '../index.js';
import type { SignatureSchemeName } from './engine.js';

const SCHEMES: Record<SignatureAlgorithm, Partial<Record<Hash, SignatureSchemeName>>> = {
	[SignatureAlgorithm.ECDSASecp256k1]: {
		[Hash.KECCAK256]: 'EcdsaKeccak256',
		[Hash.SHA256]: 'EcdsaSha256',
		[Hash.DoubleSHA256]: 'EcdsaDoubleSha256',
	},
	[SignatureAlgorithm.ECDSASecp256r1]: {
		[Hash.SHA256]: 'EcdsaSha256',
	},
	[SignatureAlgorithm.Taproot]: { [Hash.SHA256]: 'TaprootSha256' },
	[SignatureAlgorithm.EdDSA]: { [Hash.SHA512]: 'EddsaSha512' },
	[SignatureAlgorithm.Schnorrkel]: { [Hash.Merlin]: 'SchnorrkelMerlin' },
};

/**
 * The network's scheme for `signatureAlgorithm` with `hash`. Throws for an
 * algorithm that does not sign on `curve`, or a hash it does not take, before
 * anything is sent.
 */
export function signatureSchemeOf(
	curve: Curve,
	signatureAlgorithm: SignatureAlgorithm,
	hash: Hash,
): SignatureSchemeName {
	validateCurveSignatureAlgorithm(curve, signatureAlgorithm);
	validateHashSignatureCombination(hash, signatureAlgorithm);
	const scheme = SCHEMES[signatureAlgorithm][hash];
	if (scheme === undefined) {
		throw new Error(`the network has no scheme for ${signatureAlgorithm} with ${hash}`);
	}
	return scheme;
}

/**
 * A scheme of `signatureAlgorithm`, for a presign: a presign serves every
 * hash of its algorithm, so any of the algorithm's schemes names it.
 */
export function presignSchemeOf(
	curve: Curve,
	signatureAlgorithm: SignatureAlgorithm,
): SignatureSchemeName {
	validateCurveSignatureAlgorithm(curve, signatureAlgorithm);
	return Object.values(SCHEMES[signatureAlgorithm])[0]!;
}
