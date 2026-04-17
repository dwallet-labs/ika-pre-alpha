# Request Types

> **Pre-Alpha Disclaimer:** This is a pre-alpha release for development and testing only. Signing uses a single mock signer, not real distributed MPC. All 11 protocol operations are implemented (DKG, Sign, Presign, FutureSign, ReEncryptShare, etc.) across all 4 curves and 7 signature schemes, but without real MPC security guarantees. The dWallet keys, trust model, and signing protocol are not final; do not rely on any key material until mainnet. All interfaces, APIs, and data formats are subject to change without notice. The Solana program and all on-chain data will be wiped periodically and everything will be deleted when we transition to Ika Alpha 1. This software is provided "as is" without warranty of any kind; use is entirely at your own risk and dWallet Labs assumes no liability for any damages arising from its use.

## DWalletRequest Enum

All operations are encoded as variants of the `DWalletRequest` enum, BCS-serialized inside `SignedRequestData.request`.

```rust
pub enum DWalletRequest {
    DKG { ... },
    Sign { ... },
    ImportedKeySign { ... },
    Presign { ... },
    PresignForDWallet { ... },
    ImportedKeyVerification { ... },
    ReEncryptShare { ... },
    MakeSharePublic { ... },
    FutureSign { ... },
    SignWithPartialUserSig { ... },
    ImportedKeySignWithPartialUserSig { ... },
}
```

### Mock Support

All request types are implemented and tested end-to-end (see `protocols-e2e` example).

| Request | Status | Notes |
|---------|--------|-------|
| `DKG` | Supported | All 4 curves (Secp256k1, Secp256r1, Curve25519, Ristretto). Encrypted or Public share mode. Auto-commits dWallet on-chain and transfers authority to `intended_chain_sender`. Ristretto DKG uses real Schnorrkel keypairs. |
| `Sign` | Supported | 7 signature schemes (ECDSA, Taproot, EdDSA, Schnorrkel, and scalar variants). Reads `signature_scheme` from on-chain `MessageApproval`. Supports `hash_scheme` for cross-chain digest computation (Keccak256 for EVM, DoubleSHA256 for Bitcoin BIP143, etc.). |
| `ImportedKeySign` | Supported | Same as Sign but for imported-key dWallets. |
| `Presign` | Supported | Returns attestation with presign data. Uses `signature_algorithm` (not `signature_scheme`). |
| `PresignForDWallet` | Supported | Same as Presign. Uses `dwallet_public_key` (not `dwallet_id`). Includes `dwallet_attestation` for verification. |
| `ImportedKeyVerification` | Supported | Creates an imported-key dWallet. Uses `UserSecretKeyShare` (Encrypted or Public). |
| `ReEncryptShare` | Supported | Re-encrypts the user's secret key share under a new encryption key. Returns `VersionedEncryptedUserKeyShareAttestation`. |
| `MakeSharePublic` | Supported | Converts an encrypted share to a public share. Returns `VersionedPublicUserKeyShareAttestation`. |
| `FutureSign` | Supported | Two-step conditional signing (step 1). Creates a partial user signature that can be completed later via `SignWithPartialUserSig`. Returns `VersionedPartialUserSignatureAttestation`. |
| `SignWithPartialUserSig` | Supported | Two-step conditional signing (step 2). Completes a partial signature created by `FutureSign`. |
| `ImportedKeySignWithPartialUserSig` | Supported | Same as `SignWithPartialUserSig` but for imported-key dWallets. |

### Supported Curves

| Curve | DKG | Presign | Notes |
|-------|-----|---------|-------|
| `Secp256k1` | Yes | Yes | Bitcoin, Ethereum |
| `Secp256r1` | Yes | Yes | WebAuthn, secure enclaves |
| `Curve25519` | Yes | Yes | Solana, Sui (Ed25519) |
| `Ristretto` | Yes | Yes | Substrate, Polkadot (Schnorrkel) |

## DKG

Create a new dWallet via Distributed Key Generation. The `user_secret_key_share` field selects between **zero-trust** mode (encrypted user share) and **trust-minimized** mode (public user share) -- mirrors Sui move `UserSecretKeyShareEventType`.

```rust
DWalletRequest::DKG {
    dwallet_network_encryption_public_key: Vec<u8>,
    curve: DWalletCurve,
    centralized_public_key_share_and_proof: Vec<u8>,
    user_secret_key_share: UserSecretKeyShare,
    user_public_output: Vec<u8>,
    sign_during_dkg_request: Option<SignDuringDKGRequest>,
}

pub enum UserSecretKeyShare {
    /// Zero-trust mode.
    Encrypted {
        encrypted_centralized_secret_share_and_proof: Vec<u8>,
        encryption_key: Vec<u8>,
        signer_public_key: Vec<u8>,  // Ed25519, signs the public output to prove ownership
    },
    /// Trust-minimized mode -- secret share revealed.
    Public {
        public_user_secret_key_share: Vec<u8>,
    },
}
```

| Field | Description |
|-------|-------------|
| `dwallet_network_encryption_public_key` | Network encryption key (from on-chain NEK account) |
| `curve` | Target curve (Secp256k1, Secp256r1, Curve25519, Ristretto) |
| `centralized_public_key_share_and_proof` | User's public key share + ZK proof |
| `user_secret_key_share` | `Encrypted { ... }` for zero-trust, `Public { ... }` for trust-minimized |
| `user_public_output` | User's DKG public output |
| `sign_during_dkg_request` | Optional -- atomically sign a message during DKG (`None` for plain DKG) |

**Note:** `signer_public_key` lives inside the `Encrypted` variant only. Trust-minimized mode has no secret to prove possession of.

**Response:** `TransactionResponseData::Attestation(NetworkSignedAttestation)` with the DKG output and NOA attestation. The `attestation_data` decodes to `VersionedDWalletDataAttestation`.

## SignDuringDKGRequest

Optional payload attached to `DKG` to atomically sign a message during DKG.

```rust
pub struct SignDuringDKGRequest {
    pub presign_session_identifier: Vec<u8>,
    pub presign: Vec<u8>,
    pub signature_scheme: DWalletSignatureScheme,
    pub message: Vec<u8>,
    pub message_metadata: Vec<u8>,
    pub message_centralized_signature: Vec<u8>,
}
```

| Field | Description |
|-------|-------------|
| `presign_session_identifier` | Presign session identifier (from a prior `Presign` response) |
| `presign` | Presign material |
| `signature_scheme` | `DWalletSignatureScheme` enum |
| `message` | Raw message bytes to sign |
| `message_metadata` | BCS-serialized per-scheme metadata (empty for most schemes) |
| `message_centralized_signature` | User's centralized-party partial signature |

The curve is inherited from the parent DKG request.

## Sign

Sign a message using an existing dWallet.

```rust
DWalletRequest::Sign {
    message: Vec<u8>,
    message_metadata: Vec<u8>,
    presign_session_identifier: Vec<u8>,
    message_centralized_signature: Vec<u8>,
    dwallet_attestation: NetworkSignedAttestation,
    approval_proof: ApprovalProof,
}
```

| Field | Description |
|-------|-------------|
| `message` | Raw message bytes to sign |
| `message_metadata` | BCS-serialized per-scheme metadata (see `Blake2bMessageMetadata`, `SchnorrkelMessageMetadata`). Empty for most schemes. |
| `presign_session_identifier` | Session identifier of a previously allocated presign |
| `message_centralized_signature` | User's partial signature |
| `dwallet_attestation` | `NetworkSignedAttestation` from the DKG response (proves the dWallet exists) |
| `approval_proof` | On-chain proof of message approval |

Note: `curve` and `signature_scheme` are no longer fields on `Sign` -- validators derive the signature scheme from the on-chain `MessageApproval` and the curve from the `dwallet_attestation`.

**Response:** `TransactionResponseData::Signature` with the completed signature.

## ImportedKeySign

Same as `Sign` but for imported-key dWallets. Validators additionally verify `is_imported_key == true` on the referenced dWallet.

```rust
DWalletRequest::ImportedKeySign {
    message: Vec<u8>,
    message_metadata: Vec<u8>,
    presign_session_identifier: Vec<u8>,
    message_centralized_signature: Vec<u8>,
    dwallet_attestation: NetworkSignedAttestation,
    approval_proof: ApprovalProof,
}
```

## ApprovalProof

The approval proof ties the gRPC signing request to an on-chain `MessageApproval`:

```rust
pub enum ApprovalProof {
    Solana {
        transaction_signature: Vec<u8>, // Solana tx signature
        slot: u64,                       // Slot of the transaction
    },
    Sui {
        effects_certificate: Vec<u8>,    // Sui effects certificate
    },
}
```

## Presign

Allocate a global presign (usable with any non-imported dWallet for the same `signature_algorithm`).

```rust
DWalletRequest::Presign {
    dwallet_network_encryption_public_key: Vec<u8>,
    curve: DWalletCurve,
    signature_algorithm: DWalletSignatureAlgorithm,
}
```

| Field | Description |
|-------|-------------|
| `dwallet_network_encryption_public_key` | Network encryption key |
| `curve` | Target curve |
| `signature_algorithm` | `DWalletSignatureAlgorithm` (ECDSASecp256k1, ECDSASecp256r1, Taproot, EdDSA, Schnorrkel) |

Note: uses `signature_algorithm` (not `signature_scheme`). Presigns are per-algorithm, not per-scheme, because the hash function is applied at signing time.

**Response:** `TransactionResponseData::Attestation(NetworkSignedAttestation)`. The `attestation_data` decodes to `VersionedPresignDataAttestation`.

## PresignForDWallet

Allocate a presign bound to a specific dWallet (required for imported ECDSA dWallets). Runs a full 2-round MPC presign protocol -- significantly slower than global presigns.

```rust
DWalletRequest::PresignForDWallet {
    dwallet_network_encryption_public_key: Vec<u8>,
    dwallet_public_key: Vec<u8>,
    curve: DWalletCurve,
    signature_algorithm: DWalletSignatureAlgorithm,
}
```

| Field | Description |
|-------|-------------|
| `dwallet_network_encryption_public_key` | Network encryption key |
| `dwallet_public_key` | Public key of the target dWallet (not a dWallet ID) |
| `curve` | Target curve |
| `signature_algorithm` | `DWalletSignatureAlgorithm` |

## NetworkSignedAttestation

Common response / request payload for state-creating operations -- carries a network-signed blob the user can either (a) submit on-chain to claim the result or (b) feed back to the network in a follow-up request (e.g. `SignWithPartialUserSig`).

```rust
pub struct NetworkSignedAttestation {
    pub attestation_data: Vec<u8>,      // BCS-serialized per-type versioned attestation struct
    pub network_signature: Vec<u8>,     // Ed25519 signature from the NOA
    pub network_pubkey: Vec<u8>,        // NOA public key (matches active NetworkEncryptionKey)
    pub epoch: u64,                     // Epoch this attestation was produced in
}
```

The `attestation_data` contains BCS-serialized bytes of a per-type versioned struct. The caller knows which type based on the originating request:

| Request | Attestation Type |
|---------|-----------------|
| DKG / ImportedKeyVerification | `VersionedDWalletDataAttestation` |
| Presign / PresignForDWallet | `VersionedPresignDataAttestation` |
| FutureSign | `VersionedPartialUserSignatureAttestation` |
| ReEncryptShare | `VersionedEncryptedUserKeyShareAttestation` |
| MakeSharePublic | `VersionedPublicUserKeyShareAttestation` |

## ImportedKeyVerification

Verify an externally-generated key as a new dWallet (no DKG). Uses `UserSecretKeyShare` to select zero-trust or trust-minimized mode, same as DKG.

```rust
DWalletRequest::ImportedKeyVerification {
    dwallet_network_encryption_public_key: Vec<u8>,
    curve: DWalletCurve,
    centralized_party_message: Vec<u8>,
    user_secret_key_share: UserSecretKeyShare,
    user_public_output: Vec<u8>,
}
```

| Field | Description |
|-------|-------------|
| `dwallet_network_encryption_public_key` | Network encryption key |
| `curve` | Target curve |
| `centralized_party_message` | Centralized party verification message |
| `user_secret_key_share` | `UserSecretKeyShare::Encrypted { ... }` or `Public { ... }` |
| `user_public_output` | User's public output |

**Response:** `TransactionResponseData::Attestation(NetworkSignedAttestation)`. User submits the attestation on-chain to create the imported-key dWallet.

## ReEncryptShare

Re-encrypt a dWallet's user secret share under a new encryption key (to transfer / grant access). Wire format defined; not yet implemented in mock.

```rust
DWalletRequest::ReEncryptShare {
    dwallet_network_encryption_public_key: Vec<u8>,
    dwallet_public_key: Vec<u8>,
    dwallet_attestation: NetworkSignedAttestation,
    encrypted_centralized_secret_share_and_proof: Vec<u8>,
    encryption_key: Vec<u8>,
}
```

| Field | Description |
|-------|-------------|
| `dwallet_network_encryption_public_key` | Network encryption key |
| `dwallet_public_key` | Public key of the target dWallet |
| `dwallet_attestation` | The dWallet's DKG attestation |
| `encrypted_centralized_secret_share_and_proof` | The re-encrypted share + proof |
| `encryption_key` | New encryption key |

The previous share (the source) and the dWallet's `public_output` are looked up by validators from local state using `dwallet_public_key`.

**Response:** `TransactionResponseData::Attestation(NetworkSignedAttestation)`. The `attestation_data` decodes to `VersionedEncryptedUserKeyShareAttestation`.

## MakeSharePublic

Transition a zero-trust dWallet to trust-minimized by revealing the user's secret key share. One-way. Wire format defined; not yet implemented in mock.

```rust
DWalletRequest::MakeSharePublic {
    dwallet_public_key: Vec<u8>,
    dwallet_attestation: NetworkSignedAttestation,
    public_user_secret_key_share: Vec<u8>,
}
```

| Field | Description |
|-------|-------------|
| `dwallet_public_key` | Public key of the target dWallet |
| `dwallet_attestation` | The dWallet's DKG attestation |
| `public_user_secret_key_share` | The revealed secret key share |

**Response:** `TransactionResponseData::Attestation(NetworkSignedAttestation)`. The `attestation_data` decodes to `VersionedPublicUserKeyShareAttestation`.

## FutureSign

Step 1 of two-step conditional signing -- produce a verified partial user signature without an approval proof. Consumes a presign. Wire format defined; not yet implemented in mock.

```rust
DWalletRequest::FutureSign {
    dwallet_public_key: Vec<u8>,
    presign_session_identifier: Vec<u8>,
    message: Vec<u8>,
    message_metadata: Vec<u8>,
    message_centralized_signature: Vec<u8>,
    signature_scheme: DWalletSignatureScheme,
}
```

| Field | Description |
|-------|-------------|
| `dwallet_public_key` | Public key of the target dWallet |
| `presign_session_identifier` | Presign session identifier |
| `message` | Raw message bytes to sign |
| `message_metadata` | BCS-serialized per-scheme metadata (empty for most schemes) |
| `message_centralized_signature` | User's partial signature |
| `signature_scheme` | `DWalletSignatureScheme` -- kept here since FutureSign has no approval proof to derive it from |

**Response:** `TransactionResponseData::Attestation(NetworkSignedAttestation)` (the verified partial signature, ready to feed into `SignWithPartialUserSig`). The `attestation_data` decodes to `VersionedPartialUserSignatureAttestation`.

## SignWithPartialUserSig

Step 2 of two-step conditional signing -- complete the signature using the attestation returned by `FutureSign`. Requires an on-chain approval proof, just like `Sign`. Wire format defined; not yet implemented in mock.

```rust
DWalletRequest::SignWithPartialUserSig {
    partial_user_signature_attestation: NetworkSignedAttestation,
    dwallet_attestation: NetworkSignedAttestation,
    approval_proof: ApprovalProof,
}
```

| Field | Description |
|-------|-------------|
| `partial_user_signature_attestation` | Attestation from `FutureSign` |
| `dwallet_attestation` | The dWallet's DKG attestation |
| `approval_proof` | On-chain proof of message approval |

**Response:** `TransactionResponseData::Signature`.

## ImportedKeySignWithPartialUserSig

Imported-key variant of `SignWithPartialUserSig`. Validators additionally verify the referenced dWallet was created from an imported key. Wire format defined; not yet implemented in mock.

```rust
DWalletRequest::ImportedKeySignWithPartialUserSig {
    partial_user_signature_attestation: NetworkSignedAttestation,
    dwallet_attestation: NetworkSignedAttestation,
    approval_proof: ApprovalProof,
}
```

## Cryptographic Parameter Enums

### DWalletCurve

| Variant | Value | Description |
|---------|-------|-------------|
| `Secp256k1` | 0 | Bitcoin, Ethereum |
| `Secp256r1` | 1 | WebAuthn, secure enclaves |
| `Curve25519` | 2 | Solana, Sui, Ed25519 |
| `Ristretto` | 3 | Substrate, Polkadot |

On-wire encoding: `u16` (LE in on-chain accounts, BCS-serialized for gRPC).

### DWalletSignatureScheme

Combined (algorithm, hash) pair. Eliminates impossible combinations like `ECDSA + Merlin` at the type level. The on-wire encoding is `u16` (`#[repr(u16)]`).

| Variant | Index | Curve | Use For |
|---------|-------|-------|---------|
| `EcdsaKeccak256` | 0 | Secp256k1 | Ethereum |
| `EcdsaSha256` | 1 | Secp256k1 / Secp256r1 | Bitcoin (legacy) / WebAuthn |
| `EcdsaDoubleSha256` | 2 | Secp256k1 | Bitcoin BIP143 |
| `TaprootSha256` | 3 | Secp256k1 | Bitcoin Taproot (BIP340) |
| `EcdsaBlake2b256` | 4 | Secp256k1 | Zcash (personal/salt via `message_metadata`) |
| `EddsaSha512` | 5 | Curve25519 | Ed25519 (Solana, Sui) |
| `SchnorrkelMerlin` | 6 | Ristretto | Substrate, Polkadot (sr25519) |

Not every (curve, scheme) combination is valid. Validators reject invalid pairs (e.g. `Curve25519 + EcdsaKeccak256`, `Secp256r1 + Taproot`). Ordering: variants 0-4 are Secp256k1 (with 1 also usable on Secp256r1), variant 5 is Curve25519, variant 6 is Ristretto.

### DWalletSignatureAlgorithm

Used by `Presign` and `PresignForDWallet` requests (presigns are per-algorithm, not per-scheme):

| Variant | Value | Description |
|---------|-------|-------------|
| `ECDSASecp256k1` | 0 | ECDSA on Secp256k1 |
| `ECDSASecp256r1` | 1 | ECDSA on Secp256r1 |
| `Taproot` | 2 | Schnorr on Secp256k1 |
| `EdDSA` | 3 | Ed25519 on Curve25519 |
| `Schnorrkel` | 4 | sr25519 on Ristretto |

### Message Metadata

Some signature schemes require additional metadata, BCS-serialized and passed in the `message_metadata` field:

**`Blake2bMessageMetadata`** (for `EcdsaBlake2b256`):
```rust
pub struct Blake2bMessageMetadata {
    pub personal: Vec<u8>,  // BLAKE2b personalization (up to 16 bytes)
    pub salt: Vec<u8>,      // BLAKE2b salt (up to 16 bytes, empty for most uses)
}
```
Example (Zcash): `personal: b"ZcashSigHash\x00\x00\x00\x00"`, `salt: vec![]`.

**`SchnorrkelMessageMetadata`** (for `SchnorrkelMerlin`):
```rust
pub struct SchnorrkelMessageMetadata {
    pub context: Vec<u8>,  // Signing context (domain separator for Merlin transcript)
}
```
Example (Substrate): `context: b"substrate"`. If empty, validators default to `b"substrate"`.

### DWalletSignatureAlgorithm / DWalletHashScheme (internal)

The internal MPC stack still uses these granular enums. They are not on the wire -- the gRPC adapter converts `DWalletSignatureScheme` to/from these at the validator boundary via `to_internal()` / `from_internal()`.

### ChainId

| Variant | Description |
|---------|-------------|
| `Solana` | Solana blockchain |
| `Sui` | Sui blockchain |

### SignatureScheme (User Authentication)

Used in `UserSignature` for gRPC request authentication (not for dWallet signing):

| Variant | Value | Key Size |
|---------|-------|----------|
| `Ed25519` | 0 | 32 bytes |
| `Secp256k1` | 1 | 33 bytes |
| `Secp256r1` | 2 | 33 bytes |
