// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * BCS schemas for the dWallet gRPC transport.
 *
 * These MUST mirror the network's Rust request types exactly —
 * field order, enum variant order, and integer widths are the wire format.
 * Variants marked `not yet supported` keep their index for enum layout but
 * are not constructible from this SDK yet.
 */
import { bcs } from '@mysten/bcs';

import { NetworkKeyIdBcs } from './network-key-id.js';

export const UserSignatureBcs = bcs.enum('UserSignature', {
	Ed25519: bcs.struct('Ed25519', {
		signature: bcs.vector(bcs.u8()),
		public_key: bcs.vector(bcs.u8()),
	}),
	Secp256k1: bcs.struct('Secp256k1', {
		signature: bcs.vector(bcs.u8()),
		public_key: bcs.vector(bcs.u8()),
	}),
	Secp256r1: bcs.struct('Secp256r1', {
		signature: bcs.vector(bcs.u8()),
		public_key: bcs.vector(bcs.u8()),
	}),
});

/** Variant order: Solana = 0, Sui = 1. */
export const ChainIdBcs = bcs.enum('ChainId', {
	Solana: null,
	Sui: null,
});

/**
 * A network-signed attestation. Of these fields, the network's signature
 * covers only `attestation_data`. A dWallet attestation's epoch is inside
 * those bytes (`DWalletDataAttestationV1Bcs.epoch`), not beside them.
 *
 * `network_pubkey` is the network key that holds the dWallet's network
 * share. `signer_noa_public_key` is the network key that made
 * `network_signature`. The network's signing key can change from one epoch
 * to the next, so the two can differ for a dWallet made under an earlier
 * key. A check verifies the signature under the signer, once the signer is
 * one of the network keys the caller trusts.
 */
export const NetworkSignedAttestationBcs = bcs.struct('NetworkSignedAttestation', {
	attestation_data: bcs.vector(bcs.u8()),
	network_signature: bcs.vector(bcs.u8()),
	network_pubkey: bcs.vector(bcs.u8()),
	signer_noa_public_key: bcs.fixedArray(32, bcs.u8()),
});

export const UserSecretKeyShareBcs = bcs.enum('UserSecretKeyShare', {
	Encrypted: bcs.struct('Encrypted', {
		encrypted_centralized_secret_share_and_proof: bcs.vector(bcs.u8()),
		encryption_key: bcs.vector(bcs.u8()),
		// The holder's Ed25519 public key. The holder's registry entry on the
		// request's chain must hold `encryption_key`.
		signer_public_key: bcs.vector(bcs.u8()),
	}),
	Public: bcs.struct('Public', {
		public_user_secret_key_share: bcs.vector(bcs.u8()),
	}),
});

/**
 * `DWalletCurve` / `DWalletSignatureAlgorithm` / `DWalletSignatureScheme`
 * are `#[repr]`-style unit enums; BCS encodes the variant index.
 */
export const DWalletCurveBcs = bcs.enum('DWalletCurve', {
	Secp256k1: null,
	Secp256r1: null,
	Curve25519: null,
	Ristretto: null,
});

export const DWalletSignatureAlgorithmBcs = bcs.enum('DWalletSignatureAlgorithm', {
	ECDSASecp256k1: null,
	ECDSASecp256r1: null,
	Taproot: null,
	EdDSA: null,
	Schnorrkel: null,
	TaprootVSS: null,
	EdDSAVSS: null,
	SchnorrkelVSS: null,
});

export const DWalletSignatureSchemeBcs = bcs.enum('DWalletSignatureScheme', {
	EcdsaKeccak256: null,
	EcdsaSha256: null,
	EcdsaDoubleSha256: null,
	TaprootSha256: null,
	EcdsaBlake2b256: null,
	EddsaSha512: null,
	SchnorrkelMerlin: null,
});

/** Variant order: Ed25519 = 0, Secp256k1 = 1, Secp256r1 = 2. */
export const SignatureSchemeBcs = bcs.enum('SignatureScheme', {
	Ed25519: null,
	Secp256k1: null,
	Secp256r1: null,
});

/**
 * The holder of an encrypted user share: the signing key whose registry
 * entry holds the encryption key. Only Ed25519 is accepted today. The key is a fixed
 * 32-byte array with no length prefix.
 */
export const ShareHolderBcs = bcs.struct('ShareHolder', {
	signature_scheme: SignatureSchemeBcs,
	signer_public_key: bcs.fixedArray(32, bcs.u8()),
});

/**
 * The proof envelope a chain record keeps beside an attestation's fields
 * (`VersionedAttestationProof` in `ika_types::attestation_proof`): the
 * attestation's version, the public key of the network key that signed,
 * and the network's Ed25519 signature over the attestation's signing
 * message. A record keeps no attestation bytes and no hash: a reader decodes
 * this envelope, rebuilds the bytes from the record's fields at
 * `attestation_version`, hashes them, and verifies `noa_signature` under
 * `signer_noa_public_key`. The envelope's variant index is its own version,
 * not the attestation's.
 */
export const VersionedAttestationProofBcs = bcs.enum('VersionedAttestationProof', {
	V1: bcs.struct('AttestationProofV1', {
		attestation_version: bcs.u8(),
		signer_noa_public_key: bcs.fixedArray(32, bcs.u8()),
		noa_signature: bcs.fixedArray(64, bcs.u8()),
	}),
});

/**
 * A sign run in the same session as a DKG (`SignDuringDKGRequest` in
 * `ika-types`). The presign reference must name a presign from the global
 * pool, and the centralized signature is computed from the user's own DKG
 * public output and secret share, since the network's DKG output does not
 * exist yet. The signature comes back in the dWallet attestation's
 * `sign_during_dkg_signature`.
 */
export const SignDuringDKGRequestBcs = bcs.struct('SignDuringDKGRequest', {
	presign_session_identifier: bcs.vector(bcs.u8()),
	presign: bcs.vector(bcs.u8()),
	signature_scheme: DWalletSignatureSchemeBcs,
	message: bcs.vector(bcs.u8()),
	message_metadata: bcs.vector(bcs.u8()),
	message_centralized_signature: bcs.vector(bcs.u8()),
});

export const DWalletRequestBcs = bcs.enum('DWalletRequest', {
	Dkg: bcs.struct('Dkg', {
		// The key's NetworkKeyId (see `network-key-id.ts`); the classic
		// coordinator's object id is not accepted here.
		network_key_id: NetworkKeyIdBcs,
		curve: DWalletCurveBcs,
		centralized_public_key_share_and_proof: bcs.vector(bcs.u8()),
		user_secret_key_share: UserSecretKeyShareBcs,
		user_public_output: bcs.vector(bcs.u8()),
		// A sign run in the same session as the DKG; `null` for a plain DKG.
		sign_during_dkg_request: bcs.option(SignDuringDKGRequestBcs),
	}),
	Sign: bcs.struct('Sign', {
		message: bcs.vector(bcs.u8()),
		message_metadata: bcs.vector(bcs.u8()),
		signature_scheme: DWalletSignatureSchemeBcs,
		presign_session_identifier: bcs.vector(bcs.u8()),
		message_centralized_signature: bcs.vector(bcs.u8()),
		dwallet_attestation: NetworkSignedAttestationBcs,
		// The address of the signature voucher that authorizes this sign: its
		// object id on Sui, its account address on Solana. A fixed 32-byte
		// array with no length prefix.
		signature_voucher: bcs.fixedArray(32, bcs.u8()),
	}),
	ImportedKeySign: bcs.struct('ImportedKeySign', {
		message: bcs.vector(bcs.u8()),
		message_metadata: bcs.vector(bcs.u8()),
		signature_scheme: DWalletSignatureSchemeBcs,
		presign_session_identifier: bcs.vector(bcs.u8()),
		message_centralized_signature: bcs.vector(bcs.u8()),
		dwallet_attestation: NetworkSignedAttestationBcs,
		// The signature voucher's address, as in `Sign`.
		signature_voucher: bcs.fixedArray(32, bcs.u8()),
	}),
	Presign: bcs.struct('Presign', {
		network_key_id: NetworkKeyIdBcs,
		curve: DWalletCurveBcs,
		signature_algorithm: DWalletSignatureAlgorithmBcs,
	}),
	PresignForDWallet: bcs.struct('PresignForDWallet', {
		network_key_id: NetworkKeyIdBcs,
		dwallet_public_key: bcs.vector(bcs.u8()),
		dwallet_attestation: NetworkSignedAttestationBcs,
		curve: DWalletCurveBcs,
		signature_algorithm: DWalletSignatureAlgorithmBcs,
	}),
	// Create a dWallet from a key the user already holds. The user proves the
	// share it sends is a share of that key; the dWallet is committed once the
	// share's holder accepts it, as for a DKG.
	ImportedKeyVerification: bcs.struct('ImportedKeyVerification', {
		network_key_id: NetworkKeyIdBcs,
		curve: DWalletCurveBcs,
		centralized_party_message: bcs.vector(bcs.u8()),
		user_secret_key_share: UserSecretKeyShareBcs,
		user_public_output: bcs.vector(bcs.u8()),
	}),
	// Re-encrypt an existing dWallet's user share to a new holder. The new
	// holder then accepts it on the chain with a signature over the new share
	// attestation's digest. `source_holder` names the share it is
	// re-encrypted from.
	ReEncryptShare: bcs.struct('ReEncryptShare', {
		network_key_id: NetworkKeyIdBcs,
		dwallet_public_key: bcs.vector(bcs.u8()),
		dwallet_attestation: NetworkSignedAttestationBcs,
		encrypted_centralized_secret_share_and_proof: bcs.vector(bcs.u8()),
		encryption_key: bcs.vector(bcs.u8()),
		holder: ShareHolderBcs,
		source_holder: ShareHolderBcs,
	}),
	// Reveal an existing dWallet's user share.
	MakeSharePublic: bcs.struct('MakeSharePublic', {
		dwallet_public_key: bcs.vector(bcs.u8()),
		dwallet_attestation: NetworkSignedAttestationBcs,
		public_user_secret_key_share: bcs.vector(bcs.u8()),
	}),
	// Step 1 of a future sign. It carries a presign of the current epoch by
	// its attestation, and ends with the address of the future signature
	// voucher that authorizes it, a fixed 32-byte array with no length prefix.
	FutureSign: bcs.struct('FutureSign', {
		dwallet_public_key: bcs.vector(bcs.u8()),
		dwallet_attestation: NetworkSignedAttestationBcs,
		presign_attestation: NetworkSignedAttestationBcs,
		message: bcs.vector(bcs.u8()),
		message_metadata: bcs.vector(bcs.u8()),
		message_centralized_signature: bcs.vector(bcs.u8()),
		signature_scheme: DWalletSignatureSchemeBcs,
		future_signature_voucher: bcs.fixedArray(32, bcs.u8()),
	}),
	// Step 2 of a future sign. The network signs with the verified sign data
	// its step-1 attestation holds, so the request carries no partial
	// signature and no presign. The network checks the message and its
	// metadata against the digests that attestation holds.
	SignWithPartialUserSig: bcs.struct('SignWithPartialUserSig', {
		partial_user_signature_attestation: NetworkSignedAttestationBcs,
		dwallet_attestation: NetworkSignedAttestationBcs,
		message: bcs.vector(bcs.u8()),
		message_metadata: bcs.vector(bcs.u8()),
		future_signature_voucher: bcs.fixedArray(32, bcs.u8()),
	}),
	ImportedKeySignWithPartialUserSig: bcs.struct('ImportedKeySignWithPartialUserSig', {
		partial_user_signature_attestation: NetworkSignedAttestationBcs,
		dwallet_attestation: NetworkSignedAttestationBcs,
		message: bcs.vector(bcs.u8()),
		message_metadata: bcs.vector(bcs.u8()),
		future_signature_voucher: bcs.fixedArray(32, bcs.u8()),
	}),
	// Index 11 held `ReleaseGas`, a request for the network's signature over
	// a gas release. The network now pays a requested withdrawal itself. The
	// unit variant keeps the index, so the variants after it keep theirs, and
	// every reader refuses it.
	RetiredReleaseGas: null,
	// Index 12 held `AcceptShare`, the holder's acceptance of an encrypted
	// share. The holder now accepts its share on the chain. The unit variant
	// keeps the index, so the variants after it keep theirs, and every reader
	// refuses it.
	RetiredAcceptShare: null,
	// Index 13 held `StorePresign`, which wrote a presign to the chain. No
	// presign is kept on chain any more. The unit variant keeps the index, so
	// the variants after it keep theirs, and every reader refuses it.
	RetiredStorePresign: null,
	// Attach a new encrypted share to a dWallet migrated from the classic
	// contracts: `ReEncryptShare`'s fields without `source_holder`.
	AttachEncryptedShare: bcs.struct('AttachEncryptedShare', {
		network_key_id: NetworkKeyIdBcs,
		dwallet_public_key: bcs.vector(bcs.u8()),
		dwallet_attestation: NetworkSignedAttestationBcs,
		encrypted_centralized_secret_share_and_proof: bcs.vector(bcs.u8()),
		encryption_key: bcs.vector(bcs.u8()),
		holder: ShareHolderBcs,
	}),
});

export const SignedRequestDataBcs = bcs.struct('SignedRequestData', {
	session_identifier_preimage: bcs.fixedArray(32, bcs.u8()),
	epoch: bcs.u64(),
	chain_id: ChainIdBcs,
	// The network the request is for: 1 mainnet, 2 testnet, 3 a local
	// network (`requestNetworkValue`). A validator refuses another network's.
	network: bcs.u8(),
	// The life of the signer's gas deposit the request may be charged to:
	// the deposit's `incarnation` as the signer read it, 1 when it has none
	// yet. A validator refuses, for free, a life the deposit has left, and
	// holds a later life until it has read it.
	deposit_incarnation: bcs.u64(),
	intended_chain_sender: bcs.vector(bcs.u8()),
	request: DWalletRequestBcs,
});

export const TransactionResponseDataBcs = bcs.enum('TransactionResponseData', {
	Signature: bcs.struct('Signature', {
		signature: bcs.vector(bcs.u8()),
	}),
	Attestation: NetworkSignedAttestationBcs,
	Error: bcs.struct('Error', {
		message: bcs.string(),
	}),
});

/**
 * BCS mirrors of the network's attestation payloads. `attestation_data` in a
 * `NetworkSignedAttestation` decodes with one of these: a DKG /
 * imported-key result carries `VersionedDWalletDataAttestation` (the
 * dWallet's public key and full public output — the inputs user-side
 * signing needs), a presign result carries
 * `VersionedPresignDataAttestation` (the opaque presign reference that
 * round-trips into `Sign.presign_session_identifier`, plus the presign
 * material ready for the centralized sign WASM).
 */
export const DWalletDataAttestationV1Bcs = bcs.struct('DWalletDataAttestationV1', {
	session_identifier: bcs.fixedArray(32, bcs.u8()),
	intended_chain_sender: bcs.vector(bcs.u8()),
	curve: DWalletCurveBcs,
	public_key: bcs.vector(bcs.u8()),
	public_output: bcs.vector(bcs.u8()),
	is_imported_key: bcs.bool(),
	sign_during_dkg_signature: bcs.option(bcs.vector(bcs.u8())),
	// The holder of the encrypted share and the keccak256 of the encryption
	// key's and of the encrypted share's exact bytes. All three are absent
	// for a dWallet whose share is public.
	holder: bcs.option(ShareHolderBcs),
	encryption_key_hash: bcs.option(bcs.fixedArray(32, bcs.u8())),
	encrypted_share_hash: bcs.option(bcs.fixedArray(32, bcs.u8())),
	// The epoch the network made the attestation in, inside the signed
	// bytes. A migrated dWallet carries u64::MAX ("migrated, no epoch").
	epoch: bcs.u64(),
});

export const VersionedDWalletDataAttestationBcs = bcs.enum('VersionedDWalletDataAttestation', {
	V1: DWalletDataAttestationV1Bcs,
});

/**
 * The attestation of an encrypted share: of a new dWallet's first share, or
 * of a re-encryption. It holds the hashes of the encrypted share and of its
 * encryption key, the holder, and the digest of the dWallet's attestation
 * (`dwalletAttestationDigest`), which tells two dWallets of one key and one
 * sender apart.
 */
export const EncryptedUserKeyShareAttestationV1Bcs = bcs.struct(
	'EncryptedUserKeyShareAttestationV1',
	{
		session_identifier: bcs.fixedArray(32, bcs.u8()),
		intended_chain_sender: bcs.vector(bcs.u8()),
		dwallet_public_key: bcs.vector(bcs.u8()),
		encrypted_share_hash: bcs.fixedArray(32, bcs.u8()),
		encryption_key_hash: bcs.fixedArray(32, bcs.u8()),
		holder: ShareHolderBcs,
		dwallet_attestation_digest: bcs.fixedArray(32, bcs.u8()),
	},
);

export const VersionedEncryptedUserKeyShareAttestationBcs = bcs.enum(
	'VersionedEncryptedUserKeyShareAttestation',
	{ V1: EncryptedUserKeyShareAttestationV1Bcs },
);

/**
 * The attestation of a public share, with the share in the clear, and the
 * digest of the dWallet's attestation (`dwalletAttestationDigest`).
 */
export const PublicUserKeyShareAttestationV1Bcs = bcs.struct('PublicUserKeyShareAttestationV1', {
	session_identifier: bcs.fixedArray(32, bcs.u8()),
	intended_chain_sender: bcs.vector(bcs.u8()),
	dwallet_public_key: bcs.vector(bcs.u8()),
	public_user_secret_key_share: bcs.vector(bcs.u8()),
	dwallet_attestation_digest: bcs.fixedArray(32, bcs.u8()),
});

export const VersionedPublicUserKeyShareAttestationBcs = bcs.enum(
	'VersionedPublicUserKeyShareAttestation',
	{ V1: PublicUserKeyShareAttestationV1Bcs },
);

export const PresignDataAttestationV1Bcs = bcs.struct('PresignDataAttestationV1', {
	session_identifier: bcs.fixedArray(32, bcs.u8()),
	epoch: bcs.u64(),
	presign_session_identifier: bcs.vector(bcs.u8()),
	presign_data: bcs.vector(bcs.u8()),
	curve: DWalletCurveBcs,
	signature_algorithm: DWalletSignatureAlgorithmBcs,
	dwallet_public_key: bcs.option(bcs.vector(bcs.u8())),
	user_pubkey: bcs.vector(bcs.u8()),
});

export const VersionedPresignDataAttestationBcs = bcs.enum('VersionedPresignDataAttestation', {
	V1: PresignDataAttestationV1Bcs,
});

/**
 * The attestation step 1 of a future sign is answered with
 * (`PartialUserSignatureAttestationV1`). It holds
 * the digests of the message and of the presign attestation step 1 used, the
 * keccak256 of the dWallet attestation step 1 used, the voucher, the scheme,
 * and the verified sign data the completion signs with. The completion
 * request carries it back unchanged.
 */
export const PartialUserSignatureAttestationV1Bcs = bcs.struct(
	'PartialUserSignatureAttestationV1',
	{
		session_identifier: bcs.fixedArray(32, bcs.u8()),
		intended_chain_sender: bcs.vector(bcs.u8()),
		dwallet_public_key: bcs.vector(bcs.u8()),
		dwallet_attestation_hash: bcs.fixedArray(32, bcs.u8()),
		future_signature_voucher: bcs.fixedArray(32, bcs.u8()),
		presign_session_identifier: bcs.vector(bcs.u8()),
		presign_attestation_hash: bcs.fixedArray(32, bcs.u8()),
		message_digest: bcs.fixedArray(32, bcs.u8()),
		message_metadata_digest: bcs.fixedArray(32, bcs.u8()),
		signature_scheme: DWalletSignatureSchemeBcs,
		verified_sign_data: bcs.vector(bcs.u8()),
	},
);

export const VersionedPartialUserSignatureAttestationBcs = bcs.enum(
	'VersionedPartialUserSignatureAttestation',
	{ V1: PartialUserSignatureAttestationV1Bcs },
);
