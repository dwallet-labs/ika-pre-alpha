# Response Types

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

`SubmitTransaction` answers with the BCS bytes of a `TransactionResponseData`:

```rust
pub enum TransactionResponseData {
    Signature { signature: Vec<u8> },
    Attestation(NetworkSignedAttestation),
    Error { message: String },
}
```

Check for `Error` first. An error message explains the refusal in plain text.

## Signature

A sign request, of any of the three sign kinds, is answered with the signature. The bytes are the
ones the network also writes into the voucher.

| Algorithm | Length | Bytes |
|---|---|---|
| ECDSA, secp256k1 or secp256r1 | 65 | a recovery byte, then `r` (32) and `s` (32) |
| Taproot | 64 | a BIP-340 signature |
| EdDSA | 64 | an Ed25519 signature |
| Schnorrkel | 64 | an sr25519 signature |

To verify an ECDSA signature with a library that takes 64 bytes, drop the first byte. The SDKs also
check that the recovery byte recovers the dWallet's public key.

## Attestation

Every other served request is answered with an attestation: a record of the result, signed by
the network.

```rust
pub struct NetworkSignedAttestation {
    pub attestation_data: Vec<u8>,       // BCS of the attestation
    pub network_signature: Vec<u8>,      // the network's Ed25519 signature
    pub network_pubkey: Vec<u8>,         // the network key the dWallet was made under
    pub signer_noa_public_key: [u8; 32], // the network key that made the signature
}
```

`network_pubkey` and `signer_noa_public_key` can differ. A dWallet stays under the network key it
was made under, while each epoch signs with its own newest key. Verify the signature under
`signer_noa_public_key`, after you have checked that it is a network key you trust.

The network's signature covers only `attestation_data`. The attestation names its own session and
sender inside those bytes, so nobody who passes it on can change them.

The same attestation, proof and fields are what the network writes to Solana. A client can check
an answer it got over gRPC against the copy on chain, or the other way round.

## What the network signs

The network does not sign `attestation_data` alone. It signs a message that names the kind:

```text
0xFE || "ika-attestation" || kind tag (1) || attestation_data
```

| Attestation | Kind tag | Answer to |
|---|---|---|
| `VersionedDWalletDataAttestation` | 0 | `Dkg`, `ImportedKeyVerification` |
| `VersionedPresignDataAttestation` | 1 | `Presign`, `PresignForDWallet` |
| `VersionedPartialUserSignatureAttestation` | 2 | `FutureSign` |
| `VersionedEncryptedUserKeyShareAttestation` | 3 | `ReEncryptShare`, a dWallet's first encrypted share |
| `VersionedPublicUserKeyShareAttestation` | 4 | `MakeSharePublic`, a dWallet's public share at creation |

Verify with the kind you expect. A check that ignores the kind can be fooled: the bytes of one
kind can also decode as another.

A signature proves only that the key it names made it. The answer names its own signer, so a
faulty server can sign with a key of its own and name that key. Check the signer against the
network keys you trust. In TypeScript, use the checks that take your trusted keys, such as
`verifyAttestation` from `@ika.xyz/sdk-core`. `verifyAttestationSignature` checks only the
signature, under the key the answer names. Use it only after you checked that key yourself.

## The attestations

Each is a versioned enum with one version today, `V1`.

### DWallet

```rust
pub struct DWalletDataAttestationV1 {
    pub session_identifier: [u8; 32],
    pub intended_chain_sender: Vec<u8>,          // the dWallet's owner on Solana
    pub curve: DWalletCurve,
    pub public_key: Vec<u8>,
    pub public_output: Vec<u8>,
    pub is_imported_key: bool,
    pub sign_during_dkg_signature: Option<Vec<u8>>,
    pub holder: Option<ShareHolder>,             // the encrypted share's holder
    pub encryption_key_hash: Option<[u8; 32]>,
    pub encrypted_share_hash: Option<[u8; 32]>,
    pub epoch: u64,                              // the epoch it was made in
}
```

A later request on the dWallet carries this attestation back. An imported dWallet's session
identifier is this `session_identifier`.

### Presign

```rust
pub struct PresignDataAttestationV1 {
    pub session_identifier: [u8; 32],
    pub epoch: u64,                              // the presign expires with it
    pub presign_session_identifier: Vec<u8>,     // pass it in a sign request
    pub presign_data: Vec<u8>,
    pub curve: DWalletCurve,
    pub signature_algorithm: DWalletSignatureAlgorithm,
    pub dwallet_public_key: Option<Vec<u8>>,     // None for the global pool
    pub user_pubkey: Vec<u8>,                    // the request key it was served to
}
```

### Partial user signature

The answer to step 1 of a future sign. Step 2 carries it back.

```rust
pub struct PartialUserSignatureAttestationV1 {
    pub session_identifier: [u8; 32],
    pub intended_chain_sender: Vec<u8>,
    pub dwallet_public_key: Vec<u8>,
    pub dwallet_attestation_hash: [u8; 32],      // Keccak-256 of the dWallet attestation's bytes
    pub future_signature_voucher: [u8; 32],
    pub presign_session_identifier: Vec<u8>,
    pub presign_attestation_hash: [u8; 32],
    pub message_digest: [u8; 32],
    pub message_metadata_digest: [u8; 32],
    pub signature_scheme: DWalletSignatureScheme,
    pub verified_sign_data: Vec<u8>,
}
```

It holds digests, not the message. Step 2 carries the message, and the network checks it against
the digest.

### Encrypted share

```rust
pub struct EncryptedUserKeyShareAttestationV1 {
    pub session_identifier: [u8; 32],
    pub intended_chain_sender: Vec<u8>,
    pub dwallet_public_key: Vec<u8>,
    pub encrypted_share_hash: [u8; 32],
    pub encryption_key_hash: [u8; 32],
    pub holder: ShareHolder,
    pub dwallet_attestation_digest: [u8; 32],    // Keccak-256 of the dWallet attestation's bytes
}
```

`dwallet_attestation_digest` names the one dWallet the share belongs to. Two imports of one key
have the same public key, so compare this digest with the digest of the dWallet attestation you
hold.

### Public share

```rust
pub struct PublicUserKeyShareAttestationV1 {
    pub session_identifier: [u8; 32],
    pub intended_chain_sender: Vec<u8>,
    pub dwallet_public_key: Vec<u8>,
    pub public_user_secret_key_share: Vec<u8>,
    pub dwallet_attestation_digest: [u8; 32],
}
```

`ShareHolder` is a signature scheme and a 32-byte signer key. Only Ed25519 holders are accepted.

## On the devnet pre-alpha

The mock network answers in the same formats and signs with its one network key. The
cryptographic outputs it serves, such as the network key's output and each dWallet's public
output, are mock values: they start with the byte `0xFF` and the text `ika-mock`. An SDK that is not in mock
mode refuses them with "mock values need the SDK's mock feature". This is what stops a real app
from trusting the pre-alpha by mistake.
