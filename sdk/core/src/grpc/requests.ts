// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * Builders for user-signed gRPC dWallet requests.
 *
 * The transport public key doubles as the user identity: presigns are
 * bound to it and Sign requests must come from the same key. Ed25519
 * only for now (Secp256k1/r1 transport keys exist on the wire already).
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

import {
	attestationSigningMessage,
	PUBLIC_SHARE_LENGTHS,
	recordOfAttestation,
	verifyAttestationNetworkKey,
	verifyAttestationRecord,
} from './attestation-record.js';
import type { AttestationKind } from './attestation-record.js';
import {
	VersionedDWalletDataAttestationBcs,
	VersionedPartialUserSignatureAttestationBcs,
	VersionedPresignDataAttestationBcs,
} from './bcs.js';
import type { DWalletSignatureSchemeBcs, SignedRequestDataBcs } from './bcs.js';
import type { TrustedNetworkKeys } from './deployed-networks.js';
import { networkKeyIdFromBytes } from './network-key-id.js';
import type { NetworkKeyId } from './network-key-id.js';
import { DWALLET_USABLE_MAX_AGE_MS, DWalletUsabilityNotChecked } from './share-ownership.js';
import type { DWalletUsable } from './share-ownership.js';
import { signRequestBytes } from './sign-request-bytes.js';
import { requireMessageMetadataOfScheme } from './signature-verification.js';
import { issued, WAITING_RESULT_BUILDS_NO_SIGN, waitingRequestHolders } from './usable-state.js';
import type { IssuedState } from './usable-state.js';

export { REQUEST_SIGNING_PREFIX, requestSigningMessage } from './sign-request-bytes.js';

export interface GrpcTransportKeypair {
	/** 32-byte Ed25519 secret key. */
	secretKey: Uint8Array;
	publicKey: Uint8Array;
}

export function generateTransportKeypair(): GrpcTransportKeypair {
	const secretKey = ed25519.utils.randomSecretKey();
	return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}

/**
 * The request kinds that sign a message with a dWallet. `signGrpcRequest`
 * refuses them: they are signed with `signDWalletSignRequest`, which first
 * checks that the user's key holds the dWallet's share.
 */
export const DWALLET_SIGN_REQUEST_KINDS: readonly string[] = ['Sign', 'ImportedKeySign'];

/**
 * BCS-encode `signedData` (shape of `SignedRequestDataBcs.serialize`
 * input) and sign it with the transport key. Returns the two byte
 * payloads `SubmitTransaction` carries.
 *
 * Throws, and signs nothing, when the request is over one of the network's
 * size limits (`GRPC_REQUEST_SIZE_LIMITS`). The network would refuse
 * such a request and charge the signer for it. Each byte field is checked
 * before the request is encoded. The whole request is checked once it is
 * encoded, because its length exists only then.
 *
 * A `Sign` or `ImportedKeySign` request is refused with a `TypeError`. Sign
 * it with `signDWalletSignRequest`, which checks first that the dWallet's
 * share is held by the user's key (`assertDWalletUsable`).
 *
 * A make-public or a re-encryption built from a result that says `waiting` is
 * refused with an `Error` unless `keypair` is the result's holder. While a
 * dWallet waits, the network refuses such a request from any other signer and
 * charges for it. The check follows the very value the builder returned, so
 * pass that value as `signedData.request`: a copy of it is not checked here,
 * and the network then decides.
 */
export function signGrpcRequest(
	keypair: GrpcTransportKeypair,
	signedData: Parameters<typeof SignedRequestDataBcs.serialize>[0],
): { userSignature: Uint8Array; signedRequestData: Uint8Array } {
	const kind = DWALLET_SIGN_REQUEST_KINDS.find((name) => name in signedData.request);
	if (kind !== undefined) {
		throw new TypeError(
			`signGrpcRequest does not sign a ${kind} request. Use signDWalletSignRequest, which ` +
				"first checks that the dWallet's share is held by your key",
		);
	}
	const holder = waitingRequestHolders.get(signedData.request);
	if (holder !== undefined && !bytesEqual(Uint8Array.from(keypair.publicKey), holder)) {
		throw new Error(
			"the dWallet waits for its holder's acceptance, and only that holder may re-encrypt its " +
				'share or make it public while it waits: sign this request with the key ' +
				`${Array.from(holder, (byte) => byte.toString(16).padStart(2, '0')).join('')}`,
		);
	}
	return signRequestBytes(keypair, signedData);
}

/**
 * Verify an attestation's network signature: Ed25519 over the attestation bytes
 * signed as `kind` (`attestationSigningMessage`). The kind is the one the
 * request is answered with: `'dwallet'` for a DKG, an imported-key
 * verification or an accepted share, and `'presign'` for a presign. A
 * signature over one kind never verifies as another kind.
 *
 * The signature is verified under the attestation's signer
 * (`signer_noa_public_key`), the network key that made it. Its
 * `network_pubkey` is the key that holds the dWallet's network share, which
 * can differ from the signer for a dWallet made under an earlier key.
 *
 * This proves only that the response is internally consistent — the
 * signature, the data and the signer all come from the same response
 * object. It does not prove Ika signed it: a relay or a compromised server
 * can serve its own key alongside its own signature and pass this check. Use
 * {@link verifyAttestationAgainstChain} to also check the signer against
 * chain state before trusting the result.
 */
export function verifyAttestationSignature(
	attestation: {
		attestation_data: number[] | Uint8Array;
		network_signature: number[] | Uint8Array;
		signer_noa_public_key: number[] | Uint8Array;
	},
	kind: AttestationKind,
): boolean {
	return ed25519.verify(
		Uint8Array.from(attestation.network_signature),
		attestationSigningMessage(kind, attestation.attestation_data),
		Uint8Array.from(attestation.signer_noa_public_key),
	);
}

/**
 * The on-chain field a served attestation is checked against: the network key's
 * public key a network encryption key record currently holds. Mirrors
 * `noa_public_key` of `ika_protocol::network_key::NetworkEncryptionKey` on
 * Sui and of the Solana `NetworkEncryptionKey` account of the same name.
 * A network key is never deactivated, so the record carries no active flag.
 */
export interface NetworkEncryptionKeyChainRecord {
	noaPublicKey: Uint8Array;
}

/**
 * Where the record {@link verifyAttestationAgainstChain} checks a served
 * key against comes from: the chain's record of one network key, looked up
 * by that key. The check asks for the record of the key that signed the
 * attestation, the one the attestation names. The network's signing key can
 * change from one epoch to the next, so this need not be the key the request
 * named. What makes the check meaningful is that the record comes from the
 * chain, where only a registered network key has one: a server that serves
 * its own key alongside its own signature finds no record for that key.
 *
 * The chain that record lives on is not fixed by this interface: today
 * it is a Sui object id derived from the key's public key; after the
 * dual-chain cutover (protocol version 10, `solana_authoritative`) the
 * authoritative record can move to Solana. A caller wires either chain's
 * reader in without this module or `verifyAttestationAgainstChain`
 * changing.
 */
export interface NetworkKeyChainReader {
	/**
	 * The chain's record of the network key `noaPublicKey`. Resolves
	 * `undefined` when no record exists for that key. An implementation that
	 * cannot distinguish "no record" from another failure (e.g. a chain read
	 * that rejects for an unknown object id) may throw instead —
	 * `verifyAttestationAgainstChain` refuses the attestation either way.
	 */
	fetchNetworkEncryptionKey(
		noaPublicKey: Uint8Array,
	): Promise<NetworkEncryptionKeyChainRecord | undefined>;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * Verify an attestation both internally and against chain state: its
 * signature must verify as `kind` under its served signer
 * (`signer_noa_public_key`, {@link verifyAttestationSignature}), and the chain
 * must hold a network encryption key record for that signer (`reader`, asked
 * for the record of the signer). Passing the internal check alone proves
 * nothing about who signed — see that function's doc. Throws a descriptive
 * error on any failure; resolves on success.
 *
 * This function checks who signed the attestation and nothing about what it
 * says: not that it is of the dWallet the caller asked for, and not that the
 * caller's key holds the dWallet's share. `signDWalletShareAcceptance` and
 * `assertDWalletUsable` make those checks.
 */
export async function verifyAttestationAgainstChain(
	attestation: {
		attestation_data: number[] | Uint8Array;
		network_signature: number[] | Uint8Array;
		signer_noa_public_key: number[] | Uint8Array;
	},
	kind: AttestationKind,
	reader: NetworkKeyChainReader,
): Promise<void> {
	if (!verifyAttestationSignature(attestation, kind)) {
		throw new Error('attestation signature does not verify under its served signer');
	}
	const servedSigner = Uint8Array.from(attestation.signer_noa_public_key);
	const record = await reader.fetchNetworkEncryptionKey(Uint8Array.from(servedSigner));
	if (!record) {
		throw new Error(
			'no on-chain network encryption key record found for the served signer; refusing the attestation',
		);
	}
	if (!bytesEqual(record.noaPublicKey, servedSigner)) {
		throw new Error('served signer does not match the on-chain record; refusing the attestation');
	}
}

/**
 * What the ownership check verified for `usable`. Throws
 * `DWalletUsabilityNotChecked` for a result `assertDWalletUsable` did not
 * make: a copy of one, or an object built by hand. The builders below read
 * the dWallet from this private state only, never from the result's own
 * fields or from an attestation a caller holds.
 *
 * Also throws `DWalletUsabilityNotChecked` for a result older than
 * `DWALLET_USABLE_MAX_AGE_MS`, as a sign does: the dWallet's share may have
 * been made public or moved to another holder since the check, and the
 * network would refuse the request and charge for it.
 */
function checkedStateOf(usable: DWalletUsable): IssuedState {
	const state = issued.get(usable);
	if (state === undefined) {
		throw new DWalletUsabilityNotChecked(
			'the usability result was not made by assertDWalletUsable; run the check and pass its result',
		);
	}
	const age = Date.now() - state.verifiedAt;
	if (age > DWALLET_USABLE_MAX_AGE_MS) {
		throw new DWalletUsabilityNotChecked(
			`the usability result is ${age} ms old, over the ${DWALLET_USABLE_MAX_AGE_MS} ms a ` +
				'result may be reused; run assertDWalletUsable again',
		);
	}
	return state;
}

/**
 * `request`, built from a result in the state `state`, with the result's holder
 * kept for `signGrpcRequest` when the result says `waiting`.
 */
function requestOfResult<Request extends object>(state: IssuedState, request: Request): Request {
	if (state.waiting) {
		waitingRequestHolders.set(request, Uint8Array.from(state.holder));
	}
	return request;
}

/** The attestation the check verified, as a request carries it: every byte field a plain array. */
function requestAttestation(state: IssuedState): {
	attestation_data: number[];
	network_signature: number[];
	network_pubkey: number[];
	signer_noa_public_key: number[];
} {
	return {
		attestation_data: Array.from(state.attestation.attestation_data),
		network_signature: Array.from(state.attestation.network_signature),
		network_pubkey: Array.from(state.attestation.network_pubkey),
		signer_noa_public_key: Array.from(state.attestation.signer_noa_public_key),
	};
}

/**
 * The `MakeSharePublic` request that reveals the user share of the dWallet
 * `usable` was checked for: the value to put in `SignedRequestData.request`.
 * `usable` is the result of `assertDWalletUsable` for the dWallet, and
 * `publicUserSecretKeyShare` the user's secret key share, serialized as the
 * network's session verifies it.
 *
 * The request carries the dWallet's attestation and names the dWallet's
 * public key a second time. Both come from what the ownership check
 * verified against the chain, so the request cannot name a dWallet the
 * caller did not check. A result the SDK did not make is refused with
 * `DWalletUsabilityNotChecked`. A result of a dWallet whose share is already
 * public is refused with an `Error`: the check read the public share's record
 * from the chain, and the network would charge for the request and refuse it.
 * A share that is not exactly the length of a public share of the dWallet's
 * curve (`PUBLIC_SHARE_LENGTHS`) is refused with an `Error`: the network
 * admits no other, and would charge for the refusal.
 * A result of a dWallet migrated from the classic contracts is built, and the
 * network decides it. The network refuses a request whose copy of
 * the key differs, and charges for it. The network waits for the dWallet's
 * record on the chain the request names, verifies the share against the
 * dWallet's public output, and answers with the public share's attestation
 * (kind `public_share`), which it commits as the dWallet's public share
 * record. Check that answer with `verifyMakeSharePublicAnswer`. That commit
 * makes a waiting dWallet Active.
 *
 * On an Active dWallet the request may be signed and paid for by any transport
 * key. While the dWallet waits, only the holder the attestation names may sign
 * it: a result that says `waiting` builds it, and `signGrpcRequest` refuses any
 * other key.
 */
export function makeSharePublicRequest(
	usable: DWalletUsable,
	publicUserSecretKeyShare: Uint8Array,
): {
	MakeSharePublic: {
		dwallet_public_key: number[];
		dwallet_attestation: ReturnType<typeof requestAttestation>;
		public_user_secret_key_share: number[];
	};
} {
	const state = checkedStateOf(usable);
	const alreadyPublic = state.share === 'public';
	if (alreadyPublic) {
		throw new Error(
			"the dWallet's share is already public: its public share record is on the chain, so " +
				'there is nothing to make public',
		);
	}
	const expectedLength = PUBLIC_SHARE_LENGTHS[state.curve];
	if (publicUserSecretKeyShare.length !== expectedLength) {
		throw new Error(
			`the user's secret share is ${publicUserSecretKeyShare.length} bytes, and a public share ` +
				`of curve ${state.curve} is exactly ${expectedLength} bytes`,
		);
	}
	return requestOfResult(state, {
		MakeSharePublic: {
			dwallet_public_key: Array.from(state.publicKey),
			dwallet_attestation: requestAttestation(state),
			public_user_secret_key_share: Array.from(publicUserSecretKeyShare),
		},
	});
}

/**
 * A holder's entry in the encryption-key registry of one chain, as far as
 * `reEncryptShareRequest` reads it. Declared by its shape, because this
 * package does not depend on the chain clients. The entries that
 * `readEncryptionKey` of `@ika.xyz/sdk-sui` and `readEncryptionKey` of the
 * Solana client return have these fields, and both readers verify the
 * holder's signature over the entry before they return it.
 */
export interface HolderEncryptionKeyEntry {
	/** The holder: the Ed25519 public key that signed the entry's registration message. */
	signerPublicKey: Uint8Array;
	/** The curve the encryption key is for, in the network's numbering. */
	curve: number;
	/** The class-groups encryption key's exact bytes. */
	encryptionKey: Uint8Array;
}

/**
 * The `ReEncryptShare` request that re-encrypts the user share of the dWallet
 * `usable` was checked for to a new holder: the value to put in
 * `SignedRequestData.request`.
 *
 * - `usable` is the result of `assertDWalletUsable` for the dWallet, run for
 *   the key that holds the share now. That key is the request's source
 *   holder: the share both chains read the re-encryption from.
 * - `newHolderSignerPublicKey` is the new holder's 32-byte Ed25519 public
 *   key. The request needs nothing signed by the new holder.
 * - `newHolderEntry` is the new holder's registry entry on the request's
 *   chain, for the dWallet's curve, as a reader that verified the holder's
 *   signature over it returned it: `readEncryptionKey` of `@ika.xyz/sdk-sui`
 *   on Sui, `readEncryptionKey` of the Solana client on Solana. This function
 *   does not read the chain and cannot verify the entry itself. It refuses,
 *   with an `Error`, an entry of another holder than
 *   `newHolderSignerPublicKey`, and an entry for another curve than the
 *   dWallet's. The request names the entry's key as its encryption key.
 * - `encryptedShareAndProof` is the share encrypted to
 *   `newHolderEntry.encryptionKey`, with its proof, as the centralized party
 *   builds it. This function does not encrypt: the caller must encrypt to
 *   the entry's key. The function puts the entry's key in the request, so a
 *   ciphertext made for another key is refused by the network's check of the
 *   proof, not by this function, and the request is charged.
 *
 * The network runs the request only when the new holder's registry entry on
 * the request's chain holds the request's encryption key, as the validators
 * agree it. A request that carries another key is refused, and charged.
 *
 * The dWallet's attestation, its public key, the network key and the source
 * holder all come from what the ownership check verified against the chain.
 * A result the SDK did not make is refused with `DWalletUsabilityNotChecked`.
 * Two results are refused with an `Error`: one of a dWallet whose share is
 * public, which has no encrypted share to re-encrypt, and one of a dWallet
 * migrated from the classic contracts, whose share has no record in the new
 * contracts for the network to read. A `newHolderSignerPublicKey` that is
 * not 32 bytes is refused with an `Error` too.
 *
 * The network answers with the new share's attestation (kind
 * `encrypted_share`). Check that answer with `verifyReEncryptShareAnswer`.
 * The network commits the share on the chain, where it waits for the new
 * holder to accept it. The new holder accepts it on the chain with its
 * signature over the digest of that share attestation
 * (`shareAttestationDigest`), which `signReEncryptedShareAcceptance`
 * computes and signs after it checks the share. The sender gives the new
 * holder the share attestation and its own signer key. The ciphertext is in
 * the share's chain record, and the sender can give it too. A sender whose
 * result says `waiting` also gives the signature it passed to
 * `assertDWalletUsable`, because the new holder checks it in place of an
 * acceptance on the chain (`senderAcceptanceSignature`). The new holder's
 * accept makes a waiting dWallet Active.
 *
 * On an Active dWallet the request itself may be signed and paid for by any
 * transport key. While the dWallet waits, only the holder the attestation names
 * may sign it: a result that says `waiting` builds it, and `signGrpcRequest`
 * refuses any other key.
 */
export function reEncryptShareRequest(args: {
	usable: DWalletUsable;
	encryptedShareAndProof: Uint8Array;
	newHolderSignerPublicKey: Uint8Array;
	newHolderEntry: HolderEncryptionKeyEntry;
}): {
	ReEncryptShare: {
		network_key_id: NetworkKeyId;
		dwallet_public_key: number[];
		dwallet_attestation: ReturnType<typeof requestAttestation>;
		encrypted_centralized_secret_share_and_proof: number[];
		encryption_key: number[];
		holder: { signature_scheme: { Ed25519: null }; signer_public_key: number[] };
		source_holder: { signature_scheme: { Ed25519: null }; signer_public_key: number[] };
	};
} {
	const { usable, encryptedShareAndProof, newHolderSignerPublicKey, newHolderEntry } = args;
	if (newHolderSignerPublicKey.length !== 32) {
		throw new Error(
			`the new holder's signer public key must be 32 bytes, an Ed25519 public key; got ${newHolderSignerPublicKey.length}`,
		);
	}
	const state = checkedStateOf(usable);
	if (state.share === 'public') {
		throw new Error(
			"the dWallet's share is public, so it has no encrypted share to re-encrypt to a new holder",
		);
	}
	if (state.migrated) {
		throw new Error(
			'the dWallet was migrated from the classic contracts, and its share has no record in the ' +
				'new contracts, so the network cannot read a share to re-encrypt',
		);
	}
	if (!bytesEqual(newHolderEntry.signerPublicKey, newHolderSignerPublicKey)) {
		throw new Error("the registry entry is another holder's, not the new holder's");
	}
	if (newHolderEntry.curve !== state.curve) {
		throw new Error(
			`the registry entry is for curve ${newHolderEntry.curve}, not the dWallet's curve ${state.curve}`,
		);
	}
	return requestOfResult(state, {
		ReEncryptShare: {
			network_key_id: networkKeyIdFromBytes(state.attestation.network_pubkey),
			dwallet_public_key: Array.from(state.publicKey),
			dwallet_attestation: requestAttestation(state),
			encrypted_centralized_secret_share_and_proof: Array.from(encryptedShareAndProof),
			encryption_key: Array.from(newHolderEntry.encryptionKey),
			holder: {
				signature_scheme: { Ed25519: null },
				signer_public_key: Array.from(newHolderSignerPublicKey),
			},
			source_holder: {
				signature_scheme: { Ed25519: null },
				signer_public_key: Array.from(state.holder),
			},
		},
	});
}

/** A network-signed attestation as a request carries it: every byte field a plain array. */
interface RequestAttestation {
	attestation_data: number[];
	network_signature: number[];
	network_pubkey: number[];
	signer_noa_public_key: number[];
}

/**
 * An attestation as a response or a caller holds it. `network_pubkey` is the
 * network key that holds the dWallet's network share; `signer_noa_public_key`
 * is the network key that made `network_signature`.
 */
export interface HeldAttestation {
	attestation_data: number[] | Uint8Array;
	network_signature: number[] | Uint8Array;
	network_pubkey: number[] | Uint8Array;
	signer_noa_public_key: number[] | Uint8Array;
}

function asRequestAttestation(attestation: HeldAttestation): RequestAttestation {
	return {
		attestation_data: Array.from(attestation.attestation_data),
		network_signature: Array.from(attestation.network_signature),
		network_pubkey: Array.from(attestation.network_pubkey),
		signer_noa_public_key: Array.from(attestation.signer_noa_public_key),
	};
}

/** `DWalletCurve` in variant order, as the attestations and the chains number it. */
const CURVE_NAMES = ['Secp256k1', 'Secp256r1', 'Curve25519', 'Ristretto'] as const;

/**
 * The digests a voucher records for a message and its metadata, as the
 * network computes them (`grpc_approval_message_digests` in `ika-types`): the
 * keccak256 of the message, and for the metadata zero when it is empty and
 * its keccak256 otherwise.
 */
export function futureSignMessageDigests(
	message: Uint8Array,
	messageMetadata: Uint8Array,
): { messageDigest: Uint8Array; messageMetadataDigest: Uint8Array } {
	return {
		messageDigest: keccak_256(message),
		messageMetadataDigest:
			messageMetadata.length === 0 ? new Uint8Array(32) : keccak_256(messageMetadata),
	};
}

type PresignAttestationFields = (typeof VersionedPresignDataAttestationBcs.$inferType)['V1'];
type DWalletAttestationFields = (typeof VersionedDWalletDataAttestationBcs.$inferType)['V1'];

function decodePresignAttestation(presignAttestation: HeldAttestation): PresignAttestationFields {
	const decoded = VersionedPresignDataAttestationBcs.parse(
		Uint8Array.from(presignAttestation.attestation_data),
	);
	if (decoded.V1 === undefined) {
		throw new Error('the presign attestation is not a V1 presign attestation');
	}
	return decoded.V1;
}

function decodeDWalletAttestation(dwalletAttestation: HeldAttestation): DWalletAttestationFields {
	const decoded = VersionedDWalletDataAttestationBcs.parse(
		Uint8Array.from(dwalletAttestation.attestation_data),
	);
	if (decoded.V1 === undefined) {
		throw new Error('the dWallet attestation is not a V1 dWallet attestation');
	}
	return decoded.V1;
}

/**
 * The presign `presignAttestation` holds, once the attestation names the
 * dWallet's network key `dwalletNetworkPublicKey`
 * (`verifyAttestationNetworkKey`, field `network_pubkey`), and its signer is one of
 * `trustedNetworkKeys` and verifies it as a presign attestation
 * (`verifyAttestationRecord`, which also decodes it exactly). The network
 * refuses a step 1 whose presign was made under another key than the
 * dWallet, and one whose presign attestation does not verify under its
 * signer. The signer is the signing key of the epoch that answered the
 * presign, so for a dWallet made under an earlier key it is another key than
 * the one the presign names.
 */
function trustedPresign(
	presignAttestation: HeldAttestation,
	dwalletNetworkPublicKey: Uint8Array,
	trustedNetworkKeys: TrustedNetworkKeys,
): PresignAttestationFields {
	verifyAttestationNetworkKey(
		presignAttestation.network_pubkey,
		dwalletNetworkPublicKey,
		trustedNetworkKeys.network,
	);
	verifyAttestationRecord(recordOfAttestation(presignAttestation), trustedNetworkKeys, 'presign');
	return decodePresignAttestation(presignAttestation);
}

/** Refuse a presign served to another transport key than `requesterPublicKey`. */
function requirePresignOfRequester(
	presign: PresignAttestationFields,
	requesterPublicKey: Uint8Array,
	what: string,
): void {
	if (!bytesEqual(Uint8Array.from(presign.user_pubkey), requesterPublicKey)) {
		throw new Error(
			`only the presign's own requester may ${what}, and this requester is another key`,
		);
	}
}

/**
 * The base algorithm each scheme runs on each curve it signs on, as the
 * network maps them (`DWalletSignatureScheme::to_internal_for_curve` in
 * `ika-types`). A pair that is not listed is one the network refuses.
 */
const BASE_ALGORITHMS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	EcdsaKeccak256: { Secp256k1: 'ECDSASecp256k1' },
	EcdsaSha256: { Secp256k1: 'ECDSASecp256k1', Secp256r1: 'ECDSASecp256r1' },
	EcdsaDoubleSha256: { Secp256k1: 'ECDSASecp256k1' },
	TaprootSha256: { Secp256k1: 'Taproot' },
	EcdsaBlake2b256: { Secp256k1: 'ECDSASecp256k1' },
	EddsaSha512: { Curve25519: 'EdDSA' },
	SchnorrkelMerlin: { Ristretto: 'Schnorrkel' },
};

/**
 * The base signature algorithm `signatureScheme` runs on `curve`, both named
 * as their `DWalletSignatureScheme` and `DWalletCurve` variants (for example
 * `'EcdsaSha256'` and `'Secp256r1'`), as the network maps them. Throws for a
 * pair the network refuses, so a presign or sign for it is never sent.
 */
export function signatureAlgorithmOnCurve(signatureScheme: string, curve: string): string {
	const algorithm = BASE_ALGORITHMS[signatureScheme]?.[curve];
	if (algorithm === undefined) {
		throw new Error(`the scheme ${signatureScheme} does not sign on the curve ${curve}`);
	}
	return algorithm;
}

/** The variant a scheme input names: its one key other than `$kind`. */
function schemeName(signatureScheme: DWalletSignatureSchemeInput): string {
	const name = Object.keys(signatureScheme).find((key) => key !== '$kind');
	if (name === undefined || BASE_ALGORITHMS[name] === undefined) {
		throw new Error(`the signature scheme ${String(name)} is not one the network knows`);
	}
	return name;
}

function requireVoucherAddress(futureSignatureVoucher: Uint8Array): void {
	if (futureSignatureVoucher.length !== 32) {
		throw new Error(
			`the future signature voucher's address must be 32 bytes; got ${futureSignatureVoucher.length}`,
		);
	}
}

/** A partial-signature attestation, decoded. */
export type PartialUserSignatureAttestation =
	(typeof VersionedPartialUserSignatureAttestationBcs.$inferType)['V1'];

/**
 * Decode the attestation that answers step 1 of a future sign: the bytes of
 * a `VersionedPartialUserSignatureAttestation`. Throws for bytes that do not
 * decode as one.
 *
 * Decoding checks nothing about who signed the bytes. Check the signature
 * with {@link verifyAttestationAgainstChain}, as kind
 * `'partial_user_signature'`, before relying on the fields.
 */
export function decodePartialUserSignatureAttestation(
	attestationData: number[] | Uint8Array,
): PartialUserSignatureAttestation {
	const decoded = VersionedPartialUserSignatureAttestationBcs.parse(
		Uint8Array.from(attestationData),
	);
	if (decoded.V1 === undefined) {
		throw new Error('the attestation is not a V1 partial-signature attestation');
	}
	return decoded.V1;
}

/** The signature scheme of a request, in the shape `SignedRequestDataBcs` takes it. */
export type DWalletSignatureSchemeInput = Parameters<typeof DWalletSignatureSchemeBcs.serialize>[0];

/**
 * The `FutureSign` request, step 1 of a future sign, for the dWallet that
 * `usable` was checked for: the value to put in `SignedRequestData.request`.
 *
 * - `usable` is the result of `assertDWalletUsable` for the dWallet. The
 *   request's dWallet attestation and its copy of the public key come from
 *   what that check verified.
 * - `presignAttestation` is the presign's attestation, as the presign
 *   request's response returned it. A presign lives only for the epoch it
 *   was made in, and is never kept on chain: get it and send this request in
 *   the same epoch. The network refuses a presign of another epoch, and a
 *   presign already used in its epoch.
 * - `messageCentralizedSignature` is the user's partial signature over
 *   `message` with that presign, as the centralized party makes it.
 * - `futureSignatureVoucher` is the 32-byte address of the
 *   `FutureSignatureVoucher` that authorizes the step: its object id on Sui,
 *   its account address on Solana.
 *
 * - `requesterPublicKey` is the transport key that will sign the request. It
 *   must be the presign's requester (`user_pubkey`), and the voucher's
 *   signing key.
 * - `trustedNetworkKeys` are the network keys the caller trusts
 *   (`trustedNetworkKeys`): on mainnet and testnet the keys this SDK lists.
 *   The presign attestation's signer must be one of them. The
 *   signer is the signing key of the epoch that answered the presign, which
 *   differs from the dWallet's key for a dWallet made under an earlier key.
 *
 * The network checks the partial signature and
 * answers with a partial-signature attestation, which it also writes into the
 * voucher. Check that answer with `verifyFutureSignAnswer`, then keep the
 * attestation for the completion; it decodes with
 * {@link decodePartialUserSignatureAttestation}.
 *
 * This function refuses with an `Error` what the network would refuse from
 * the request's bytes and charge for: a voucher address that is not 32
 * bytes; an empty partial signature; a presign attestation that names another
 * network key than the dWallet attestation, whose signer is not one of
 * `trustedNetworkKeys`, that does not verify under its signer, or that
 * does not decode; a requester that is not the
 * presign's; a scheme that does not sign on the dWallet's curve; a presign on
 * another curve, or for another algorithm than the scheme's base algorithm on
 * that curve; a presign whose binding breaks the rule (an imported dWallet's
 * ECDSA step 1 needs a presign made for that dWallet, and every other step 1
 * a global presign); and metadata that does not decode for the scheme
 * (`requireMessageMetadataOfScheme`). A result the SDK did not make is
 * refused with `DWalletUsabilityNotChecked`.
 */
export function futureSignRequest(args: {
	usable: DWalletUsable;
	presignAttestation: HeldAttestation;
	message: Uint8Array;
	messageMetadata: Uint8Array;
	messageCentralizedSignature: Uint8Array;
	signatureScheme: DWalletSignatureSchemeInput;
	futureSignatureVoucher: Uint8Array;
	requesterPublicKey: Uint8Array;
	trustedNetworkKeys: TrustedNetworkKeys;
}): {
	FutureSign: {
		dwallet_public_key: number[];
		dwallet_attestation: RequestAttestation;
		presign_attestation: RequestAttestation;
		message: number[];
		message_metadata: number[];
		message_centralized_signature: number[];
		signature_scheme: DWalletSignatureSchemeInput;
		future_signature_voucher: number[];
	};
} {
	requireVoucherAddress(args.futureSignatureVoucher);
	if (args.messageCentralizedSignature.length === 0) {
		throw new Error('the partial signature (message_centralized_signature) must not be empty');
	}
	const state = checkedStateOf(args.usable);
	if (state.waiting) {
		throw new DWalletUsabilityNotChecked(WAITING_RESULT_BUILDS_NO_SIGN);
	}
	const presign = trustedPresign(
		args.presignAttestation,
		state.attestation.network_pubkey,
		args.trustedNetworkKeys,
	);
	requirePresignOfRequester(
		presign,
		Uint8Array.from(args.requesterPublicKey),
		'use it for step 1 of a future sign',
	);
	const scheme = schemeName(args.signatureScheme);
	const curve = CURVE_NAMES[state.curve];
	const algorithm = BASE_ALGORITHMS[scheme][curve];
	if (algorithm === undefined) {
		throw new Error(`the scheme ${scheme} does not sign on the dWallet's curve ${curve}`);
	}
	if (presign.curve.$kind !== curve) {
		throw new Error(
			`the presign is on curve ${presign.curve.$kind}, not the dWallet's curve ${curve}`,
		);
	}
	if (presign.signature_algorithm.$kind !== algorithm) {
		throw new Error(
			`the presign is for ${presign.signature_algorithm.$kind}, not the scheme's ` +
				`algorithm ${algorithm}`,
		);
	}
	const dwallet = decodeDWalletAttestation(state.attestation);
	const requiresBoundPresign =
		dwallet.is_imported_key && (algorithm === 'ECDSASecp256k1' || algorithm === 'ECDSASecp256r1');
	const boundTo = presign.dwallet_public_key;
	const bindingFits = requiresBoundPresign
		? boundTo !== null &&
			boundTo !== undefined &&
			bytesEqual(Uint8Array.from(boundTo), state.publicKey)
		: boundTo === null || boundTo === undefined;
	if (!bindingFits) {
		throw new Error(
			"an imported dWallet's ECDSA future sign needs a presign made for that dWallet, and " +
				'every other future sign a global presign',
		);
	}
	requireMessageMetadataOfScheme(scheme, args.messageMetadata);
	return {
		FutureSign: {
			dwallet_public_key: Array.from(state.publicKey),
			dwallet_attestation: requestAttestation(state),
			presign_attestation: asRequestAttestation(args.presignAttestation),
			message: Array.from(args.message),
			message_metadata: Array.from(args.messageMetadata),
			message_centralized_signature: Array.from(args.messageCentralizedSignature),
			signature_scheme: args.signatureScheme,
			future_signature_voucher: Array.from(args.futureSignatureVoucher),
		},
	};
}

/** The fields both completions of a future sign carry. */
export interface FutureSignCompletionFields {
	partial_user_signature_attestation: RequestAttestation;
	dwallet_attestation: RequestAttestation;
	message: number[];
	message_metadata: number[];
	future_signature_voucher: number[];
}

/**
 * The completion of a future sign: a `SignWithPartialUserSig`, or an
 * `ImportedKeySignWithPartialUserSig` for an imported-key dWallet. It is the
 * value to put in `SignedRequestData.request`. The variant is the one the
 * dWallet attestation's `is_imported_key` names.
 *
 * - `partialUserSignatureAttestation` is step 1's response, unchanged.
 * - `dwalletAttestation` is the exact dWallet attestation step 1 carried.
 *   The completion carries no presign, so it may run in any later epoch.
 * - `message` and `messageMetadata` are the ones step 1 signed.
 * - `futureSignatureVoucher` is the voucher's 32-byte address.
 *
 * The completing key need not hold the dWallet's share. The voucher's
 * controller sets the key that may complete it, and that key must sign the
 * request. The network signs with the verified sign data the attestation
 * holds, answers with the signature, and writes it into the voucher.
 *
 * This function makes the checks the network makes against the request's own
 * bytes (`completion_verified_sign_data` in `ika-types`). So a request the
 * network would refuse and charge for is refused here with an `Error`: an
 * attestation that does not decode, one of another dWallet or another
 * voucher, a dWallet attestation whose bytes do not hash to the one step 1
 * used, and another message or metadata. It does not
 * verify the attestations' signatures, because that needs the network key the
 * caller trusts.
 */
export function completeFutureSignRequest(args: {
	partialUserSignatureAttestation: HeldAttestation;
	dwalletAttestation: HeldAttestation;
	message: Uint8Array;
	messageMetadata: Uint8Array;
	futureSignatureVoucher: Uint8Array;
}):
	| { SignWithPartialUserSig: FutureSignCompletionFields }
	| { ImportedKeySignWithPartialUserSig: FutureSignCompletionFields } {
	requireVoucherAddress(args.futureSignatureVoucher);
	const partial = decodePartialUserSignatureAttestation(
		args.partialUserSignatureAttestation.attestation_data,
	);
	const dwallet = decodeDWalletAttestation(args.dwalletAttestation);
	if (
		!bytesEqual(Uint8Array.from(partial.dwallet_public_key), Uint8Array.from(dwallet.public_key)) ||
		!bytesEqual(
			Uint8Array.from(partial.future_signature_voucher),
			Uint8Array.from(args.futureSignatureVoucher),
		)
	) {
		throw new Error('the partial-signature attestation names another dWallet or another voucher');
	}
	if (
		!bytesEqual(
			Uint8Array.from(partial.dwallet_attestation_hash),
			keccak_256(Uint8Array.from(args.dwalletAttestation.attestation_data)),
		)
	) {
		throw new Error('the dWallet attestation is not the one the partial signature was made with');
	}
	const { messageDigest, messageMetadataDigest } = futureSignMessageDigests(
		args.message,
		args.messageMetadata,
	);
	if (
		!bytesEqual(Uint8Array.from(partial.message_digest), messageDigest) ||
		!bytesEqual(Uint8Array.from(partial.message_metadata_digest), messageMetadataDigest)
	) {
		throw new Error(
			'the message or its metadata is not the one the partial signature was made for',
		);
	}
	const fields: FutureSignCompletionFields = {
		partial_user_signature_attestation: asRequestAttestation(args.partialUserSignatureAttestation),
		dwallet_attestation: asRequestAttestation(args.dwalletAttestation),
		message: Array.from(args.message),
		message_metadata: Array.from(args.messageMetadata),
		future_signature_voucher: Array.from(args.futureSignatureVoucher),
	};
	return dwallet.is_imported_key
		? { ImportedKeySignWithPartialUserSig: fields }
		: { SignWithPartialUserSig: fields };
}
