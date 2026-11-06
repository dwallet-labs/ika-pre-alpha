// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The acceptance of a new dWallet's encrypted share, by the user who created
 * the dWallet.
 *
 * The network commits a new dWallet with an encrypted share on the chain,
 * where it waits for its holder. The holder's acceptance signature is the
 * user's statement that the dWallet is the one they asked for. Sent to the
 * chain, it makes the dWallet Active. Kept off the chain, it lets the holder
 * make the share public or re-encrypt it (`assertDWalletUsable`,
 * `acceptanceSignature`), and it is what the sender of such a re-encryption
 * gives the new holder (`signReEncryptedShareAcceptance`,
 * `senderAcceptanceSignature`). The attestation the holder
 * signs comes from one validator's answer, or from a chain record the network
 * wrote. So `signDWalletShareAcceptance` compares every field of the
 * attestation with what the user sent in the creating request and computed
 * for it, and signs only when every comparison holds. A user who built the
 * creating request holds every value the comparison needs.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

import { fromNumberToCurve } from '../client/hash-signature-validation.js';
import type { Curve } from '../client/types.js';
import { realCryptography } from '../client/user-cryptography.js';
import type { UserCryptography } from '../client/user-cryptography.js';
import {
	AttestationRecordError,
	attestationSigningMessage,
	verifyAttestationNetworkKey,
} from './attestation-record.js';
import type { AttestationRecordCheck, DWalletAttestation } from './attestation-record.js';
import { VersionedDWalletDataAttestationBcs } from './bcs.js';
import { copyTrustedNetworkKeys } from './deployed-networks.js';
import type { TrustedNetworkKeys } from './deployed-networks.js';
import type { NetworkKeyId } from './network-key-id.js';
import { signShareAcceptance } from './share-acceptance-signing.js';
import { dwalletAttestationDigest } from './share-acceptance.js';
import type { ShareAcceptanceSignature, SignedAttestation } from './share-acceptance.js';
import { verifySignatureWithScheme } from './signature-verification.js';

/** `DWalletCurve` in variant order, as the attestation numbers it. */
const CURVES = ['Secp256k1', 'Secp256r1', 'Curve25519', 'Ristretto'];

/** The sign a `Dkg` request asked the network to run in the same session. */
export interface SentSignDuringDkg {
	/** The message the request named. */
	message: Uint8Array;
	/** The request's `message_metadata`; empty for a scheme that takes none. */
	messageMetadata: Uint8Array;
	/** The scheme the request named, as `DWalletSignatureScheme` numbers it. */
	signatureScheme: number;
}

/**
 * What the user sent in the request that created the dWallet, and computed
 * for it. Every value is the user's own: none is read from the response.
 */
export interface SentDWalletRequest {
	/** The kind of the creating request. */
	kind: 'Dkg' | 'ImportedKeyVerification';
	/** The session identifier the request opened (`grpcSessionIdentifier`). */
	sessionIdentifier: Uint8Array;
	/** The request's `intended_chain_sender`. */
	intendedChainSender: Uint8Array;
	/** The curve the request named. */
	curve: Curve;
	/**
	 * The network key the request named (`network_key_id`). The attestation's
	 * dWallet key (`network_pubkey`) must be this key.
	 */
	networkKeyId: NetworkKeyId;
	/** The user's own public output, the request's `user_public_output`. */
	userPublicOutput: Uint8Array;
	/** The class-groups encryption key the share was encrypted to. */
	encryptionKey: Uint8Array;
	/** The encrypted share and its proof, as the request carried them. */
	encryptedShareAndProof: Uint8Array;
	/** The sign during DKG the request asked for; leave it out when it asked for none. */
	signDuringDkg?: SentSignDuringDkg;
}

/** What `signDWalletShareAcceptance` takes. */
export interface AcceptDWalletShareArguments {
	/**
	 * The holder's 32-byte Ed25519 secret key: the key that signed the
	 * registration message of the encryption key.
	 */
	holderSecretKey: Uint8Array;
	/**
	 * The signed dWallet attestation of the creating request: from the
	 * request's answer, or from the dWallet's record on the chain.
	 */
	attestation: SignedAttestation;
	/**
	 * The network keys the caller trusts (`trustedNetworkKeys`): on mainnet
	 * and testnet the keys this SDK lists, elsewhere the caller's own. Never a
	 * key the attestation states about itself. The attestation's signer and
	 * the key that holds the dWallet's network share must each be one of them.
	 */
	trustedNetworkKeys: TrustedNetworkKeys;
	/** What the user sent and computed. */
	sent: SentDWalletRequest;
	/**
	 * The client's cryptography. Absent means the 2PC-MPC protocol, which
	 * refuses a mock dWallet's output.
	 */
	cryptography?: UserCryptography;
}

function equalBytes(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
	return (
		left.length === right.length && Array.from(left).every((byte, index) => byte === right[index])
	);
}

/** Refuse the attestation, naming the field that is not what the user sent. */
function refuseUnless(
	field: string,
	holds: boolean,
	what: string,
	check: AttestationRecordCheck = 'binding',
): void {
	if (!holds) {
		throw new AttestationRecordError(check, `the attestation's ${field} is not ${what}`, field);
	}
}

/** Decode the attestation's bytes as exactly one V1 dWallet attestation. */
function decodeExactly(attestationData: Uint8Array): DWalletAttestation {
	let decoded;
	try {
		decoded = VersionedDWalletDataAttestationBcs.parse(attestationData);
	} catch (error) {
		throw new AttestationRecordError(
			'decode',
			'the attestation is not a dWallet attestation: ' +
				`${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (decoded.$kind !== 'V1') {
		throw new AttestationRecordError('decode', `the dWallet attestation is ${decoded.$kind}`);
	}
	const encoded = VersionedDWalletDataAttestationBcs.serialize(decoded).toBytes();
	if (!equalBytes(encoded, attestationData)) {
		throw new AttestationRecordError(
			'decode',
			'the attestation bytes are not exactly a dWallet attestation: bytes remain after it',
		);
	}
	return decoded.V1;
}

/** Whether the network's signature verifies over the attestation, signed as a dWallet's. */
function networkSignatureVerifies(
	attestationData: Uint8Array,
	networkSignature: Uint8Array,
	networkPublicKey: Uint8Array,
): boolean {
	try {
		return ed25519.verify(
			networkSignature,
			attestationSigningMessage('dwallet', attestationData),
			networkPublicKey,
		);
	} catch {
		return false;
	}
}

/**
 * Whether the attested sign-during-DKG signature verifies under the key in
 * `dWalletPublicOutput`, for the message, metadata and scheme the user sent.
 */
async function signDuringDkgSignatureVerifies(
	cryptography: UserCryptography,
	curve: number,
	sent: SentSignDuringDkg,
	dWalletPublicOutput: Uint8Array,
	signature: Uint8Array,
): Promise<boolean> {
	try {
		await verifySignatureWithScheme({
			curve,
			signatureScheme: sent.signatureScheme,
			message: sent.message,
			messageMetadata: sent.messageMetadata,
			dWalletPublicOutput,
			signature,
			cryptography,
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * The holder's acceptance of a new dWallet's first share, signed only after
 * the attestation is compared with what the user sent. The holder's key
 * signs the digest of the attestation (`dwalletAttestationDigest`), which is
 * the digest the first share's chain record stores. Pass the result to the
 * chain client's accept builder: `acceptEncryptedUserShareTx` in
 * `@ika.xyz/sdk-sui`, or `acceptEncryptedUserShareInstructions` in
 * `@ika.xyz/sdk-solana`. Any key may send that transaction and pay for it.
 *
 * The checks, in order. The first that fails throws an
 * `AttestationRecordError`, and nothing is signed:
 * 1. The bytes decode as exactly one V1 dWallet attestation (check `decode`).
 * 2. The attestation's signer is one of `trustedNetworkKeys` (check
 *    `signer`, field `signer_noa_public_key`), the network's signature
 *    verifies as a dWallet attestation under that signer (check `signature`,
 *    field `network_signature`). The network's signing key can change
 *    between epochs, so the signer can differ from the dWallet's key.
 * 3. The key that holds the dWallet's network share is one of
 *    `trustedNetworkKeys` and is `sent.networkKeyId`, the network key the
 *    creating request named (`verifyAttestationNetworkKey` with the trusted
 *    keys, check `binding`, field `network_pubkey`). The network signs only
 *    the attestation's bytes, and the bytes do not name this key. Without
 *    this check one faulty validator could answer with another trusted key,
 *    and the holder would record the dWallet under a network key it is not
 *    under.
 * 4. The attestation's holder is the Ed25519 key of `holderSecretKey` (field
 *    `holder`).
 * 5. The session identifier, the chain sender and the curve are the ones
 *    sent (fields `session_identifier`, `intended_chain_sender`, `curve`).
 * 6. The dWallet is imported exactly when the request was an
 *    `ImportedKeyVerification` (field `is_imported_key`).
 * 7. The attested public output matches the user's own public output
 *    (`userAndNetworkDKGOutputMatch`, field `public_output`). That comparison
 *    also refuses an output whose `public_key_bytes` is not the key inside
 *    its `dkg_output`, and one whose user public key share is the identity.
 * 8. The attested public key is the key inside the attested public output
 *    (field `public_key`).
 * 9. The attested hashes are the keccak256 of the encryption key and of the
 *    encrypted share sent (fields `encryption_key_hash`,
 *    `encrypted_share_hash`).
 * 10. When no sign during DKG was sent, the attestation carries no signature
 *    (field `sign_during_dkg_signature_unasked`). When one was sent, the
 *    attestation carries a signature that verifies under the dWallet's key
 *    for the message, metadata and scheme sent (field
 *    `sign_during_dkg_signature`).
 *
 * Every check after the second has `check` `binding`.
 *
 * Every input is copied before the first wait, so a caller that changes one
 * meanwhile changes nothing this function compares or signs.
 */
export async function signDWalletShareAcceptance(
	args: AcceptDWalletShareArguments,
): Promise<ShareAcceptanceSignature> {
	const cryptography = args.cryptography ?? realCryptography;
	const holderSecretKey = Uint8Array.from(args.holderSecretKey);
	const attestationData = Uint8Array.from(args.attestation.attestation_data);
	const networkSignature = Uint8Array.from(args.attestation.network_signature);
	const networkPublicKey = Uint8Array.from(args.attestation.network_pubkey);
	const signerNoaPublicKey = Uint8Array.from(args.attestation.signer_noa_public_key);
	const trustedNetworkKeys = copyTrustedNetworkKeys(args.trustedNetworkKeys);
	const trustedKeys = trustedNetworkKeys.publicKeys;
	const { kind, curve } = args.sent;
	const networkKeyId = Uint8Array.from(args.sent.networkKeyId);
	const sessionIdentifier = Uint8Array.from(args.sent.sessionIdentifier);
	const intendedChainSender = Uint8Array.from(args.sent.intendedChainSender);
	const userPublicOutput = Uint8Array.from(args.sent.userPublicOutput);
	const encryptionKey = Uint8Array.from(args.sent.encryptionKey);
	const encryptedShareAndProof = Uint8Array.from(args.sent.encryptedShareAndProof);
	const sentSign =
		args.sent.signDuringDkg === undefined
			? undefined
			: {
					message: Uint8Array.from(args.sent.signDuringDkg.message),
					messageMetadata: Uint8Array.from(args.sent.signDuringDkg.messageMetadata),
					signatureScheme: args.sent.signDuringDkg.signatureScheme,
				};

	const attestation = decodeExactly(attestationData);

	const signerTrusted = trustedKeys.some((key) => equalBytes(key, signerNoaPublicKey));
	refuseUnless('signer_noa_public_key', signerTrusted, 'a trusted network key', 'signer');
	const signed = networkSignatureVerifies(attestationData, networkSignature, signerNoaPublicKey);
	refuseUnless('network_signature', signed, 'a signature of its signer', 'signature');
	verifyAttestationNetworkKey(
		networkPublicKey,
		networkKeyId,
		trustedNetworkKeys.network,
		trustedNetworkKeys,
	);

	const holder = attestation.holder;
	const holderIsOwn =
		holder !== null &&
		holder !== undefined &&
		holder.signature_scheme.$kind === 'Ed25519' &&
		equalBytes(holder.signer_public_key, ed25519.getPublicKey(holderSecretKey));
	refuseUnless('holder', holderIsOwn, "the Ed25519 key of the holder's secret key");

	const sameSession = equalBytes(attestation.session_identifier, sessionIdentifier);
	refuseUnless('session_identifier', sameSession, "the creating request's session identifier");
	const sameSender = equalBytes(attestation.intended_chain_sender, intendedChainSender);
	refuseUnless('intended_chain_sender', sameSender, 'the chain sender the request named');
	const curveNumber = CURVES.indexOf(attestation.curve.$kind);
	const attestedCurve = fromNumberToCurve(curveNumber);
	refuseUnless('curve', attestedCurve === curve, 'the curve the request named');

	const imported = kind === 'ImportedKeyVerification';
	refuseUnless('is_imported_key', attestation.is_imported_key === imported, `that of a ${kind}`);

	const publicOutput = Uint8Array.from(attestation.public_output);
	const outputsMatch = await cryptography.userAndNetworkDKGOutputMatch(
		curve,
		userPublicOutput,
		publicOutput,
	);
	refuseUnless('public_output', outputsMatch, "an output that matches the user's public output");
	const keyOfOutput = await cryptography.publicKeyFromDWalletOutput(curve, publicOutput);
	const keyIsOfOutput = equalBytes(attestation.public_key, keyOfOutput);
	refuseUnless('public_key', keyIsOfOutput, 'the public key inside its public output');

	const keyHash = attestation.encryption_key_hash;
	const keyHashHolds = keyHash != null && equalBytes(keyHash, keccak_256(encryptionKey));
	refuseUnless('encryption_key_hash', keyHashHolds, 'the hash of the encryption key sent');
	const shareHash = attestation.encrypted_share_hash;
	const shareHashHolds =
		shareHash != null && equalBytes(shareHash, keccak_256(encryptedShareAndProof));
	refuseUnless('encrypted_share_hash', shareHashHolds, 'the hash of the encrypted share sent');

	const attestedSignature = attestation.sign_during_dkg_signature;
	if (sentSign === undefined) {
		const unasked = attestedSignature == null;
		refuseUnless('sign_during_dkg_signature_unasked', unasked, 'absent, and no sign was sent');
	} else {
		const verifies =
			attestedSignature != null &&
			(await signDuringDkgSignatureVerifies(
				cryptography,
				curveNumber,
				sentSign,
				publicOutput,
				Uint8Array.from(attestedSignature),
			));
		refuseUnless('sign_during_dkg_signature', verifies, "a signature of the dWallet's key");
	}

	return signShareAcceptance(holderSecretKey, dwalletAttestationDigest(attestationData));
}
