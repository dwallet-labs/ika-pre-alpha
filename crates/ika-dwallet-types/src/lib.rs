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
//!     session_identifier_preimage: dwallet_address,
//!     epoch: 1,
//!     chain_id: ChainId::Solana,
//!     intended_chain_sender: payer_pubkey.to_vec(),
//!     request: DWalletRequest::Sign {
//!         message: msg.to_vec(),
//!         curve: DWalletCurve::Curve25519,
//!         signature_algorithm: DWalletSignatureAlgorithm::Schnorr,
//!         hash_scheme: DWalletHashScheme::SHA256,
//!         presign_id: vec![0u8; 32],
//!         message_centralized_signature: vec![0u8; 64],
//!         approval_proof: ApprovalProof::Solana {
//!             transaction_signature: tx_sig.to_vec(),
//!             slot: 0,
//!         },
//!     },
//! };
//! let bytes = bcs::to_bytes(&request)?;
//! ```

use serde::{Deserialize, Serialize};

// ===================================================================
// User authentication types
// ===================================================================

/// Signature scheme identifier.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[repr(u8)]
pub enum SignatureScheme {
    Ed25519 = 0,
    Secp256k1 = 1,
    Secp256r1 = 2,
}

/// Self-contained user signature — carries both the signature and public key.
///
/// Following Sui's pattern: each variant contains the signature bytes and
/// the public key bytes together, so they can't be mismatched. The variant
/// determines the scheme.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum UserSignature {
    Ed25519 {
        signature: Vec<u8>,   // 64 bytes
        public_key: Vec<u8>,  // 32 bytes
    },
    Secp256k1 {
        signature: Vec<u8>,   // 64 bytes
        public_key: Vec<u8>,  // 33 bytes (compressed)
    },
    Secp256r1 {
        signature: Vec<u8>,   // 64 bytes
        public_key: Vec<u8>,  // 33 bytes (compressed)
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

// ===================================================================
// Chain and approval types
// ===================================================================

/// Chain identifier.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ChainId {
    Solana,
    Sui,
}

/// Approval proof for sign operations.
///
/// Links an on-chain `MessageApproval` to the gRPC `Sign` request.
/// Validators verify this proof to confirm the approval exists on-chain.
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

// ===================================================================
// Cryptographic parameter enums
// ===================================================================

/// Supported elliptic curves for dWallet key generation.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum DWalletCurve {
    Secp256k1 = 0,
    Secp256r1 = 1,
    Curve25519 = 2,
    Ristretto = 3,
}

/// Signature algorithm to use when signing.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum DWalletSignatureAlgorithm {
    ECDSASecp256k1 = 0,
    ECDSASecp256r1 = 1,
    Taproot = 2,
    EdDSA = 3,
    SchnorrkelSubstrate = 4,
}

/// Hash scheme to apply to the message before signing.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum DWalletHashScheme {
    Keccak256,
    SHA256,
    DoubleSHA256,
    SHA512,
    Merlin,
    Blake2b256Personal { personalization: [u8; 16] },
}

// ===================================================================
// Signed request data
// ===================================================================

/// The signed payload — BCS-serialized, covered by `user_signature`.
///
/// The request type (`DWalletRequest` enum variant) IS part of the signed data
/// so it cannot be tampered with. The epoch prevents cross-epoch replay attacks.
///
/// **Important**: For `Sign` requests, `session_identifier_preimage` must be set
/// to the dWallet address (the 32-byte address from the DKG attestation). The
/// network uses this to look up the signing key.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignedRequestData {
    pub session_identifier_preimage: [u8; 32],
    pub epoch: u64,
    pub chain_id: ChainId,
    pub intended_chain_sender: Vec<u8>,
    pub request: DWalletRequest,
}

/// All dWallet request types as a single enum.
///
/// The variant determines what operation the network performs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DWalletRequest {
    /// Standard distributed key generation.
    DKG {
        dwallet_network_encryption_public_key: Vec<u8>,
        curve: DWalletCurve,
        centralized_public_key_share_and_proof: Vec<u8>,
        encrypted_centralized_secret_share_and_proof: Vec<u8>,
        encryption_key: Vec<u8>,
        user_public_output: Vec<u8>,
        signer_public_key: Vec<u8>,
    },
    /// DKG with public share (no encryption).
    DKGWithPublicShare {
        dwallet_network_encryption_public_key: Vec<u8>,
        curve: DWalletCurve,
        centralized_public_key_share_and_proof: Vec<u8>,
        public_user_secret_key_share: Vec<u8>,
        signer_public_key: Vec<u8>,
    },
    /// Sign a message using an existing dWallet.
    ///
    /// Requires an `ApprovalProof` linking to an on-chain `MessageApproval`.
    /// Set `session_identifier_preimage` in `SignedRequestData` to the dWallet
    /// address for key lookup.
    Sign {
        message: Vec<u8>,
        curve: DWalletCurve,
        signature_algorithm: DWalletSignatureAlgorithm,
        hash_scheme: DWalletHashScheme,
        presign_id: Vec<u8>,
        message_centralized_signature: Vec<u8>,
        approval_proof: ApprovalProof,
    },
    /// Sign with an imported key.
    ImportedKeySign {
        message: Vec<u8>,
        curve: DWalletCurve,
        signature_algorithm: DWalletSignatureAlgorithm,
        hash_scheme: DWalletHashScheme,
        presign_id: Vec<u8>,
        message_centralized_signature: Vec<u8>,
        approval_proof: ApprovalProof,
    },
    /// Allocate a global presign (usable with any dWallet).
    Presign {
        curve: DWalletCurve,
        signature_algorithm: DWalletSignatureAlgorithm,
    },
    /// Allocate a presign bound to a specific dWallet.
    PresignForDWallet {
        dwallet_id: Vec<u8>,
        curve: DWalletCurve,
        signature_algorithm: DWalletSignatureAlgorithm,
    },
    /// Imported key verification (not yet implemented).
    ImportedKeyVerification {},
    /// Re-encrypt a share (not yet implemented).
    ReEncryptShare {},
    /// Make a share public (not yet implemented).
    MakeSharePublic {},
    /// Future sign (not yet implemented).
    FutureSign {},
    /// Sign with partial user signature (not yet implemented).
    SignWithPartialUserSig {},
    /// Imported key sign with partial user signature (not yet implemented).
    ImportedKeySignWithPartialUserSig {},
}

// ===================================================================
// Response types
// ===================================================================

/// Response to a `SubmitTransaction` RPC.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TransactionResponseData {
    /// Sign result — the signature bytes.
    Signature { signature: Vec<u8> },
    /// State-creating operation result — output + NOA attestation.
    ///
    /// For DKG: `attestation_data` contains
    /// `[dwallet_addr(32) | pk_len(1) | pk_bytes | public_output]`.
    Attestation {
        attestation_data: Vec<u8>,
        network_signature: Vec<u8>,
        network_pubkey: Vec<u8>,
        epoch: u64,
    },
    /// Presign allocation result.
    Presign {
        presign_id: Vec<u8>,
        presign_data: Vec<u8>,
        epoch: u64,
    },
    /// Error.
    Error { message: String },
}
