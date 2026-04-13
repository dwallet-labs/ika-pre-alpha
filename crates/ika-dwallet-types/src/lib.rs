// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! BCS-serializable request/response types for gRPC dWallet operations.
//!
//! These types are BCS-compatible with the Ika network validators and the
//! `ika-dwallet-mock` development server. `SignedRequestData` contains the
//! `DWalletRequest` enum variant directly — the request type is part of the
//! signed payload so it cannot be tampered with.
//!
//! # Usage
//!
//! ```ignore
//! use ika_dwallet_types::*;
//!
//! let request = SignedRequestData {
//!     session_identifier_preimage: [0u8; 32],
//!     epoch: 1,
//!     chain_id: ChainId::Solana,
//!     intended_chain_sender: payer_pubkey.to_vec(),
//!     request: DWalletRequest::DKG {
//!         dwallet_network_encryption_public_key: vec![0u8; 32],
//!         curve: DWalletCurve::Curve25519,
//!         centralized_public_key_share_and_proof: vec![0u8; 32],
//!         user_secret_key_share: UserSecretKeyShare::Encrypted {
//!             encrypted_centralized_secret_share_and_proof: vec![0u8; 32],
//!             encryption_key: vec![0u8; 32],
//!             signer_public_key: payer_pubkey.to_vec(),
//!         },
//!         user_public_output: vec![0u8; 32],
//!         sign_during_dkg_request: None,
//!     },
//! };
//! let bytes = bcs::to_bytes(&request)?;
//! ```

use serde::{Deserialize, Serialize};

// ═══════════════════════════════════════════════════════════════════════
// User authentication types
// ═══════════════════════════════════════════════════════════════════════

/// Signature scheme identifier.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[repr(u8)]
pub enum SignatureScheme {
    Ed25519 = 0,
    Secp256k1 = 1,
    Secp256r1 = 2,
}

/// Self-contained user signature — carries both the signature and public key.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum UserSignature {
    Ed25519 {
        signature: Vec<u8>,  // 64 bytes
        public_key: Vec<u8>, // 32 bytes
    },
    Secp256k1 {
        signature: Vec<u8>,  // 64 bytes
        public_key: Vec<u8>, // 33 bytes (compressed)
    },
    Secp256r1 {
        signature: Vec<u8>,  // 64 bytes
        public_key: Vec<u8>, // 33 bytes (compressed)
    },
}

impl UserSignature {
    /// Returns the raw public key bytes.
    pub fn public_key_bytes(&self) -> &[u8] {
        match self {
            UserSignature::Ed25519 { public_key, .. }
            | UserSignature::Secp256k1 { public_key, .. }
            | UserSignature::Secp256r1 { public_key, .. } => public_key,
        }
    }

    /// Returns the signature scheme.
    pub fn scheme(&self) -> SignatureScheme {
        match self {
            UserSignature::Ed25519 { .. } => SignatureScheme::Ed25519,
            UserSignature::Secp256k1 { .. } => SignatureScheme::Secp256k1,
            UserSignature::Secp256r1 { .. } => SignatureScheme::Secp256r1,
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Chain and approval types
// ═══════════════════════════════════════════════════════════════════════

/// Chain identifier.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ChainId {
    Solana,
    Sui,
}

/// Approval proof for sign operations.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ApprovalProof {
    Solana {
        transaction_signature: Vec<u8>,
        slot: u64,
    },
    Sui {
        effects_certificate: Vec<u8>,
    },
}

// ═══════════════════════════════════════════════════════════════════════
// Curve and algorithm types (copied from dwallet-mpc-types)
// ═══════════════════════════════════════════════════════════════════════

/// dWallet curve types.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[repr(u16)]
pub enum DWalletCurve {
    Secp256k1 = 0,
    Secp256r1 = 1,
    Curve25519 = 2,
    Ristretto = 3,
}

/// Signature algorithm variants.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[repr(u8)]
pub enum DWalletSignatureAlgorithm {
    ECDSASecp256k1 = 0,
    ECDSASecp256r1 = 1,
    Taproot = 2,
    EdDSA = 3,
    Schnorrkel = 4,
}

/// Hash scheme variants.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[repr(u8)]
pub enum DWalletHashScheme {
    Keccak256 = 0,
    SHA256 = 1,
    DoubleSHA256 = 2,
    SHA512 = 3,
    Merlin = 4,
    /// BLAKE2b-256 — used by `EcdsaBlake2b256`. Actual personal/salt
    /// parameters come from `Blake2bMessageMetadata` in `message_metadata`.
    Blake2b256 = 5,
}

/// Combined (algorithm, hash) pair used by every user-facing gRPC dWallet
/// operation that touches signing or presigning.
///
/// Internally the MPC stack still uses separate `DWalletSignatureAlgorithm`
/// and `DWalletHashScheme` enums; the boundary converter lives in the
/// network validator code. This enum is the canonical user-facing form --
/// it eliminates impossible algo+hash combinations at the type level.
///
/// The 7 valid pairs match the dev-branch NOA presign pool layout (one pool
/// per scheme).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[repr(u16)]
pub enum DWalletSignatureScheme {
    /// ECDSA + Keccak-256 -- Ethereum.
    EcdsaKeccak256 = 0,
    /// ECDSA + SHA-256 -- generic Bitcoin (legacy), or WebAuthn paired with
    /// `DWalletCurve::Secp256r1`.
    EcdsaSha256 = 1,
    /// ECDSA + double-SHA-256 -- Bitcoin BIP143.
    EcdsaDoubleSha256 = 2,
    /// Schnorr + SHA-256 -- Bitcoin Taproot. Secp256k1 only.
    TaprootSha256 = 3,
    /// ECDSA + BLAKE2b-256 -- Zcash (with chain-specific personal/salt in message_metadata).
    EcdsaBlake2b256 = 4,
    /// EdDSA + SHA-512 -- Ed25519. Curve25519 only (Solana, Sui).
    EddsaSha512 = 5,
    /// Schnorrkel + Merlin transcript -- Substrate. Ristretto only.
    SchnorrkelMerlin = 6,
}

/// BLAKE2b-256 configuration metadata. BCS-serialized and sent as
/// `message_metadata` in Sign requests with `EcdsaBlake2b256` scheme.
///
/// Example (Zcash): `Blake2bMessageMetadata { personal: b"ZcashSigHash\x00\x00\x00\x00".to_vec(), salt: vec![] }`
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Blake2bMessageMetadata {
    /// BLAKE2b personalization string (up to 16 bytes).
    pub personal: Vec<u8>,
    /// BLAKE2b salt (up to 16 bytes). Empty for most uses.
    pub salt: Vec<u8>,
}

/// Schnorrkel signing context metadata. BCS-serialized and sent as
/// `message_metadata` in Sign requests with `SchnorrkelMerlin` scheme.
///
/// Example (Substrate): `SchnorrkelMessageMetadata { context: b"substrate".to_vec() }`
/// If empty, validators default to `b"substrate"`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SchnorrkelMessageMetadata {
    /// Signing context bytes (domain separator for Merlin transcript).
    pub context: Vec<u8>,
}

// ═══════════════════════════════════════════════════════════════════════
// Signed request data
// ═══════════════════════════════════════════════════════════════════════

/// The signed payload — BCS-serialized, covered by user_signature.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignedRequestData {
    pub session_identifier_preimage: [u8; 32],
    pub epoch: u64,
    pub chain_id: ChainId,
    pub intended_chain_sender: Vec<u8>,
    pub request: DWalletRequest,
}

/// Network-signed attestation — response payload for state-creating operations.
///
/// `attestation_data` contains the BCS-serialized bytes of a **per-type
/// versioned struct** — the caller knows which type based on the request:
///   - DKG / ImportedKeyVerification -> `VersionedDWalletDataAttestation`
///   - FutureSign -> `VersionedPartialUserSignatureAttestation`
///   - ReEncryptShare -> `VersionedEncryptedUserKeyShareAttestation`
///   - MakeSharePublic -> `VersionedPublicUserKeyShareAttestation`
///   - Presign / PresignForDWallet -> `VersionedPresignDataAttestation`
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NetworkSignedAttestation {
    /// BCS-serialized per-type versioned attestation struct.
    pub attestation_data: Vec<u8>,
    /// Ed25519 signature from the network-owned address (NOA).
    pub network_signature: Vec<u8>,
    /// NOA public key (Ed25519).
    pub network_pubkey: Vec<u8>,
    /// Epoch this attestation was produced in.
    pub epoch: u64,
}

/// Optional sign-during-DKG request attached to a `DKG` request --
/// atomically produces a signature using the newly-generated dWallet
/// without a separate round-trip.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SignDuringDKGRequest {
    /// Presign session identifier previously obtained via `Presign` / `PresignForDWallet`.
    pub presign_session_identifier: Vec<u8>,
    /// Presign material.
    pub presign: Vec<u8>,
    /// Combined signature scheme (algorithm + hash).
    pub signature_scheme: DWalletSignatureScheme,
    /// Raw message bytes to sign.
    pub message: Vec<u8>,
    /// BCS-serialized per-scheme metadata. Empty for most schemes.
    pub message_metadata: Vec<u8>,
    /// User's centralized-party partial signature over the message.
    pub message_centralized_signature: Vec<u8>,
}

/// User's contribution to DKG, in either zero-trust or trust-minimized mode.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum UserSecretKeyShare {
    /// Zero-trust mode: secret share encrypted to a recipient encryption key.
    Encrypted {
        encrypted_centralized_secret_share_and_proof: Vec<u8>,
        encryption_key: Vec<u8>,
        signer_public_key: Vec<u8>,
    },
    /// Trust-minimized mode: secret share revealed in the clear.
    Public {
        public_user_secret_key_share: Vec<u8>,
    },
}

/// All dWallet request types as a single enum.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DWalletRequest {
    /// Create a new dWallet via DKG.
    DKG {
        dwallet_network_encryption_public_key: Vec<u8>,
        curve: DWalletCurve,
        centralized_public_key_share_and_proof: Vec<u8>,
        user_secret_key_share: UserSecretKeyShare,
        user_public_output: Vec<u8>,
        sign_during_dkg_request: Option<SignDuringDKGRequest>,
    },
    /// Sign a message using an existing dWallet.
    Sign {
        message: Vec<u8>,
        /// BCS-serialized per-scheme metadata. Empty for most schemes.
        message_metadata: Vec<u8>,
        presign_session_identifier: Vec<u8>,
        message_centralized_signature: Vec<u8>,
        dwallet_attestation: NetworkSignedAttestation,
        approval_proof: ApprovalProof,
    },
    /// Sign with an imported key.
    ImportedKeySign {
        message: Vec<u8>,
        /// BCS-serialized per-scheme metadata. Empty for most schemes.
        message_metadata: Vec<u8>,
        presign_session_identifier: Vec<u8>,
        message_centralized_signature: Vec<u8>,
        dwallet_attestation: NetworkSignedAttestation,
        approval_proof: ApprovalProof,
    },
    /// Allocate a global presign (usable with any non-imported dWallet).
    Presign {
        dwallet_network_encryption_public_key: Vec<u8>,
        curve: DWalletCurve,
        signature_algorithm: DWalletSignatureAlgorithm,
    },
    /// Allocate a dWallet-specific presign (for imported ECDSA keys).
    PresignForDWallet {
        dwallet_network_encryption_public_key: Vec<u8>,
        dwallet_public_key: Vec<u8>,
        curve: DWalletCurve,
        signature_algorithm: DWalletSignatureAlgorithm,
    },
    /// Imported-key dWallet verification.
    ImportedKeyVerification {
        dwallet_network_encryption_public_key: Vec<u8>,
        curve: DWalletCurve,
        centralized_party_message: Vec<u8>,
        user_secret_key_share: UserSecretKeyShare,
        user_public_output: Vec<u8>,
    },
    /// Re-encrypt a dWallet's user secret share under a new encryption key.
    ReEncryptShare {
        dwallet_network_encryption_public_key: Vec<u8>,
        dwallet_public_key: Vec<u8>,
        dwallet_attestation: NetworkSignedAttestation,
        encrypted_centralized_secret_share_and_proof: Vec<u8>,
        encryption_key: Vec<u8>,
    },
    /// Make a user secret share public (zero-trust -> trust-minimized).
    MakeSharePublic {
        dwallet_public_key: Vec<u8>,
        dwallet_attestation: NetworkSignedAttestation,
        public_user_secret_key_share: Vec<u8>,
    },
    /// Step 1 of two-step conditional signing: create a verified partial
    /// user signature without an approval proof.
    FutureSign {
        dwallet_public_key: Vec<u8>,
        presign_session_identifier: Vec<u8>,
        message: Vec<u8>,
        /// BCS-serialized per-scheme metadata. Empty for most schemes.
        message_metadata: Vec<u8>,
        message_centralized_signature: Vec<u8>,
        signature_scheme: DWalletSignatureScheme,
    },
    /// Step 2 of two-step conditional signing.
    SignWithPartialUserSig {
        partial_user_signature_attestation: NetworkSignedAttestation,
        dwallet_attestation: NetworkSignedAttestation,
        approval_proof: ApprovalProof,
    },
    /// Step 2 of two-step conditional signing, imported-key variant.
    ImportedKeySignWithPartialUserSig {
        partial_user_signature_attestation: NetworkSignedAttestation,
        dwallet_attestation: NetworkSignedAttestation,
        approval_proof: ApprovalProof,
    },
}

// ═══════════════════════════════════════════════════════════════════════
// Per-type versioned attestation structs
// ═══════════════════════════════════════════════════════════════════════

/// Attestation for DKG result and imported-key verification.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum VersionedDWalletDataAttestation {
    V1(DWalletDataAttestationV1),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DWalletDataAttestationV1 {
    pub session_identifier: [u8; 32],
    pub intended_chain_sender: Vec<u8>,
    pub curve: DWalletCurve,
    pub public_key: Vec<u8>,
    pub public_output: Vec<u8>,
    pub is_imported_key: bool,
    pub sign_during_dkg_signature: Option<Vec<u8>>,
}

/// Attestation for presign allocation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum VersionedPresignDataAttestation {
    V1(PresignDataAttestationV1),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PresignDataAttestationV1 {
    pub session_identifier: [u8; 32],
    pub epoch: u64,
    pub presign_session_identifier: Vec<u8>,
    pub presign_data: Vec<u8>,
    pub curve: DWalletCurve,
    pub signature_algorithm: DWalletSignatureAlgorithm,
    pub dwallet_public_key: Option<Vec<u8>>,
    pub user_pubkey: Vec<u8>,
}

/// Attestation for FutureSign step 1 — a verified partial user signature.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum VersionedPartialUserSignatureAttestation {
    V1(PartialUserSignatureAttestationV1),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PartialUserSignatureAttestationV1 {
    pub session_identifier: [u8; 32],
    pub intended_chain_sender: Vec<u8>,
    pub dwallet_public_key: Vec<u8>,
    pub presign_session_identifier: Vec<u8>,
    pub message: Vec<u8>,
    pub signature_scheme: DWalletSignatureScheme,
}

/// Attestation for re-encryption of a user secret share.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum VersionedEncryptedUserKeyShareAttestation {
    V1(EncryptedUserKeyShareAttestationV1),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EncryptedUserKeyShareAttestationV1 {
    pub session_identifier: [u8; 32],
    pub intended_chain_sender: Vec<u8>,
    pub dwallet_public_key: Vec<u8>,
    pub encrypted_centralized_secret_share_and_proof: Vec<u8>,
}

/// Attestation for making a user secret share public.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum VersionedPublicUserKeyShareAttestation {
    V1(PublicUserKeyShareAttestationV1),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PublicUserKeyShareAttestationV1 {
    pub session_identifier: [u8; 32],
    pub intended_chain_sender: Vec<u8>,
    pub dwallet_public_key: Vec<u8>,
    pub public_user_secret_key_share: Vec<u8>,
}

// ═══════════════════════════════════════════════════════════════════════
// Response types
// ═══════════════════════════════════════════════════════════════════════

/// Response to a SubmitTransaction RPC.
///
/// Three variants: `Signature` (self-verifying), `Attestation` (NOA-signed,
/// covers all state-creating ops AND presigns), `Error`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TransactionResponseData {
    Signature { signature: Vec<u8> },
    Attestation(NetworkSignedAttestation),
    Error { message: String },
}
