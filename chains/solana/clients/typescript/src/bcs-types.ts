// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

// BCS type definitions matching crates/ika-dwallet-types/src/lib.rs.
// Used by both grpc.ts (Node) and grpc-web.ts (browser).

import { bcs } from '@mysten/bcs';

export function defineBcsTypes() {
  const ChainId = bcs.enum('ChainId', { Solana: null, Sui: null });
  const DWalletCurve = bcs.enum('DWalletCurve', { Secp256k1: null, Secp256r1: null, Curve25519: null, Ristretto: null });
  // Internal granular enums kept for legacy / debugging — not used on the wire
  // by current request types. The user-facing wire format uses
  // `DWalletSignatureScheme` which combines algorithm + hash.
  const DWalletSignatureAlgorithm = bcs.enum('DWalletSignatureAlgorithm', {
    ECDSASecp256k1: null, ECDSASecp256r1: null, Taproot: null, EdDSA: null, SchnorrkelSubstrate: null,
  });
  const DWalletHashScheme = bcs.enum('DWalletHashScheme', {
    Keccak256: null, SHA256: null, DoubleSHA256: null, SHA512: null, Merlin: null,
  });
  // Combined (algorithm, hash) pair — the on-wire signature scheme.
  // Order matches Rust enum discriminants.
  const DWalletSignatureScheme = bcs.enum('DWalletSignatureScheme', {
    EcdsaKeccak256: null,
    EcdsaSha256: null,
    EcdsaDoubleSha256: null,
    TaprootSha256: null,
    EcdsaBlake2b256: null,
    EddsaSha512: null,
    SchnorrkelMerlin: null,
  });

  const ApprovalProof = bcs.enum('ApprovalProof', {
    Solana: bcs.struct('APS', { transaction_signature: bcs.vector(bcs.u8()), slot: bcs.u64() }),
    Sui: bcs.struct('APSui', { effects_certificate: bcs.vector(bcs.u8()) }),
  });

  const UserSignature = bcs.enum('UserSignature', {
    Ed25519: bcs.struct('USE', { signature: bcs.vector(bcs.u8()), public_key: bcs.vector(bcs.u8()) }),
    Secp256k1: bcs.struct('USS', { signature: bcs.vector(bcs.u8()), public_key: bcs.vector(bcs.u8()) }),
    Secp256r1: bcs.struct('USR', { signature: bcs.vector(bcs.u8()), public_key: bcs.vector(bcs.u8()) }),
  });

  const NetworkSignedAttestation = bcs.struct('NetworkSignedAttestation', {
    attestation_data: bcs.vector(bcs.u8()),
    network_signature: bcs.vector(bcs.u8()),
    network_pubkey: bcs.vector(bcs.u8()),
    epoch: bcs.u64(),
  });

  const SignDuringDKGRequest = bcs.struct('SignDuringDKGRequest', {
    presign_session_identifier: bcs.vector(bcs.u8()),
    presign: bcs.vector(bcs.u8()),
    signature_scheme: DWalletSignatureScheme,
    message: bcs.vector(bcs.u8()),
    message_metadata: bcs.vector(bcs.u8()),
    message_centralized_signature: bcs.vector(bcs.u8()),
  });

  const UserSecretKeyShare = bcs.enum('UserSecretKeyShare', {
    Encrypted: bcs.struct('USKSEnc', {
      encrypted_centralized_secret_share_and_proof: bcs.vector(bcs.u8()),
      encryption_key: bcs.vector(bcs.u8()),
      signer_public_key: bcs.vector(bcs.u8()),
    }),
    Public: bcs.struct('USKSPub', {
      public_user_secret_key_share: bcs.vector(bcs.u8()),
    }),
  });

  const DWalletRequest = bcs.enum('DWalletRequest', {
    DKG: bcs.struct('DKG', {
      dwallet_network_encryption_public_key: bcs.vector(bcs.u8()), curve: DWalletCurve,
      centralized_public_key_share_and_proof: bcs.vector(bcs.u8()),
      user_secret_key_share: UserSecretKeyShare,
      user_public_output: bcs.vector(bcs.u8()),
      sign_during_dkg_request: bcs.option(SignDuringDKGRequest),
    }),
    Sign: bcs.struct('Sign', {
      message: bcs.vector(bcs.u8()), message_metadata: bcs.vector(bcs.u8()),
      presign_session_identifier: bcs.vector(bcs.u8()), message_centralized_signature: bcs.vector(bcs.u8()),
      dwallet_attestation: NetworkSignedAttestation,
      approval_proof: ApprovalProof,
    }),
    ImportedKeySign: bcs.struct('IKS', {
      message: bcs.vector(bcs.u8()), message_metadata: bcs.vector(bcs.u8()),
      presign_session_identifier: bcs.vector(bcs.u8()), message_centralized_signature: bcs.vector(bcs.u8()),
      dwallet_attestation: NetworkSignedAttestation,
      approval_proof: ApprovalProof,
    }),
    Presign: bcs.struct('Presign', { dwallet_network_encryption_public_key: bcs.vector(bcs.u8()), curve: DWalletCurve, signature_algorithm: DWalletSignatureAlgorithm }),
    PresignForDWallet: bcs.struct('PFD', {
      dwallet_network_encryption_public_key: bcs.vector(bcs.u8()), dwallet_public_key: bcs.vector(bcs.u8()), dwallet_attestation: NetworkSignedAttestation, curve: DWalletCurve, signature_algorithm: DWalletSignatureAlgorithm,
    }),
    ImportedKeyVerification: bcs.struct('IKV', {
      dwallet_network_encryption_public_key: bcs.vector(bcs.u8()),
      curve: DWalletCurve,
      centralized_party_message: bcs.vector(bcs.u8()),
      user_secret_key_share: UserSecretKeyShare,
      user_public_output: bcs.vector(bcs.u8()),
    }),
    ReEncryptShare: bcs.struct('ReEncryptShare', {
      dwallet_network_encryption_public_key: bcs.vector(bcs.u8()),
      dwallet_public_key: bcs.vector(bcs.u8()),
      dwallet_attestation: NetworkSignedAttestation,
      encrypted_centralized_secret_share_and_proof: bcs.vector(bcs.u8()),
      encryption_key: bcs.vector(bcs.u8()),
    }),
    MakeSharePublic: bcs.struct('MakeSharePublic', {
      dwallet_public_key: bcs.vector(bcs.u8()),
      dwallet_attestation: NetworkSignedAttestation,
      public_user_secret_key_share: bcs.vector(bcs.u8()),
    }),
    FutureSign: bcs.struct('FutureSign', {
      dwallet_public_key: bcs.vector(bcs.u8()),
      dwallet_attestation: NetworkSignedAttestation,
      presign_session_identifier: bcs.vector(bcs.u8()),
      message: bcs.vector(bcs.u8()),
      message_metadata: bcs.vector(bcs.u8()),
      message_centralized_signature: bcs.vector(bcs.u8()),
      signature_scheme: DWalletSignatureScheme,
    }),
    SignWithPartialUserSig: bcs.struct('SWPUS', {
      partial_user_signature_attestation: NetworkSignedAttestation,
      dwallet_attestation: NetworkSignedAttestation,
      approval_proof: ApprovalProof,
    }),
    ImportedKeySignWithPartialUserSig: bcs.struct('IKSWPUS', {
      partial_user_signature_attestation: NetworkSignedAttestation,
      dwallet_attestation: NetworkSignedAttestation,
      approval_proof: ApprovalProof,
    }),
  });

  const SignedRequestData = bcs.struct('SignedRequestData', {
    session_identifier_preimage: bcs.fixedArray(32, bcs.u8()),
    epoch: bcs.u64(), chain_id: ChainId,
    intended_chain_sender: bcs.vector(bcs.u8()),
    request: DWalletRequest,
  });

  // Three response variants: Signature (self-verifying), Attestation
  // (NOA-signed wrapper covering DKG / FutureSign / ReEncrypt /
  // MakeSharePublic / ImportedKeyVerification AND presigns), Error.
  // The bytes inside `attestation_data` decode to a per-type versioned attestation enum
  // (e.g. `VersionedDWalletDataAttestation` for DKG, `VersionedPresignDataAttestation` for presign).
  //
  // BCS tuple variants serialize the inner type directly (no field name),
  // so `Attestation` here references `NetworkSignedAttestation` as a
  // payload type, not a struct wrapper.
  const TransactionResponseData = bcs.enum('TransactionResponseData', {
    Signature: bcs.struct('SigResp', { signature: bcs.vector(bcs.u8()) }),
    Attestation: NetworkSignedAttestation,
    Error: bcs.struct('ErrResp', { message: bcs.string() }),
  });

  // ──────────────────────────────────────────────────────────────────
  // Per-type versioned attestation enums for NetworkSignedAttestation.attestation_data
  // ──────────────────────────────────────────────────────────────────
  // DKG results: decode with `VersionedDWalletDataAttestation.parse(...)`.
  const VersionedDWalletDataAttestation = bcs.enum('VersionedDWalletDataAttestation', {
    V1: bcs.struct('DWalletDataAttestationV1', {
      session_identifier: bcs.fixedArray(32, bcs.u8()),
      intended_chain_sender: bcs.vector(bcs.u8()),
      curve: DWalletCurve,
      public_key: bcs.vector(bcs.u8()),
      public_output: bcs.vector(bcs.u8()),
      is_imported_key: bcs.bool(),
      sign_during_dkg_signature: bcs.option(bcs.vector(bcs.u8())),
    }),
  });

  // Presign results: decode with `VersionedPresignDataAttestation.parse(...)`.
  const VersionedPresignDataAttestation = bcs.enum('VersionedPresignDataAttestation', {
    V1: bcs.struct('PresignDataAttestationV1', {
      session_identifier: bcs.fixedArray(32, bcs.u8()),
      epoch: bcs.u64(),
      presign_session_identifier: bcs.vector(bcs.u8()),
      presign_data: bcs.vector(bcs.u8()),
      curve: DWalletCurve,
      signature_algorithm: DWalletSignatureAlgorithm,
      dwallet_public_key: bcs.option(bcs.vector(bcs.u8())),
      user_pubkey: bcs.vector(bcs.u8()),
    }),
  });

  // ──────────────────────────────────────────────────────────────────
  // Per-scheme message metadata structs
  // ──────────────────────────────────────────────────────────────────
  const Blake2bMessageMetadata = bcs.struct('Blake2bMessageMetadata', {
    personal: bcs.vector(bcs.u8()),
    salt: bcs.vector(bcs.u8()),
  });

  const SchnorrkelMessageMetadata = bcs.struct('SchnorrkelMessageMetadata', {
    context: bcs.vector(bcs.u8()),
  });

  return { ChainId, DWalletCurve, DWalletSignatureAlgorithm, DWalletHashScheme, DWalletSignatureScheme, ApprovalProof, UserSignature, NetworkSignedAttestation, SignDuringDKGRequest, UserSecretKeyShare, DWalletRequest, SignedRequestData, TransactionResponseData, VersionedDWalletDataAttestation, VersionedPresignDataAttestation, Blake2bMessageMetadata, SchnorrkelMessageMetadata };
}
