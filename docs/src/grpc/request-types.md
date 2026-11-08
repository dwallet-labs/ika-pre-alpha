# Request Types

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

The `request` field of a signed request is a `DWalletRequest`. Its variant names the operation.
This page lists the variants, what each needs first, and what comes back. The SDK defines their BCS
encoding in `sdk/core/src/grpc/bcs.ts`.

## The variants

The variant's position is its BCS index, so the order is part of the wire format.

| # | Variant | What it does | Answer |
|---|---|---|---|
| 0 | `Dkg` | Creates a dWallet by key generation | dWallet attestation |
| 1 | `Sign` | Signs a message with a dWallet, under a voucher | signature |
| 2 | `ImportedKeySign` | Signs with an imported dWallet, under a voucher | signature |
| 3 | `Presign` | Makes a presign from the global pool | presign attestation |
| 4 | `PresignForDWallet` | Makes a presign bound to one imported dWallet. ECDSA only | presign attestation |
| 5 | `ImportedKeyVerification` | Creates a dWallet from an existing key | dWallet attestation |
| 6 | `ReEncryptShare` | Encrypts a copy of the user's share to another holder | encrypted share attestation |
| 7 | `MakeSharePublic` | Reveals the user's share to the network | public share attestation |
| 8 | `FutureSign` | Step 1 of a future sign | partial signature attestation |
| 9 | `SignWithPartialUserSig` | Step 2 of a future sign | signature |
| 10 | `ImportedKeySignWithPartialUserSig` | Step 2 for an imported dWallet | signature |
| 11 | `RetiredReleaseGas` | Removed. Refused from its bytes | |
| 12 | `RetiredAcceptShare` | Removed. Refused | |
| 13 | `RetiredStorePresign` | Removed. Refused | |
| 14 | `AttachEncryptedShare` | Not used on Solana | encrypted share attestation |

A holder accepts an encrypted share on chain, with its own transaction. That is why variant 12 is
gone. See [Encrypted Shares](../on-chain/encrypted-shares.md).

The network pays a gas withdrawal with its own transaction, once the deposit's owner sends
`RequestWithdraw` on chain. No user asks the network for anything to withdraw, so variant 11 is
gone too. See [Gas Deposits](../on-chain/gas-deposits.md).

## What the real network serves

The real network serves every variant except the three removed ones, with one more exception: an
`ImportedKeyVerification` with a public share. It refuses that one with
`gRPC request type not yet supported for session conversion`.

## What the mock network serves

The devnet pre-alpha's mock network serves variants 0 to 10. It refuses the three removed variants
as the real network does, and `AttachEncryptedShare`.

The mock makes every dWallet's key itself, an imported one included. An import request on the
pre-alpha names a curve and nothing else, and no private key is ever sent. So an imported
pre-alpha dWallet does not hold the key you imported, and has a different address. Never import a
real key on the pre-alpha.

## Signature schemes

Every request that signs names a `DWalletSignatureScheme`, a u16:

| Number | Scheme | Curve |
|---|---|---|
| 0 | ECDSA with Keccak-256 | secp256k1 |
| 1 | ECDSA with SHA-256 | secp256k1 or secp256r1 |
| 2 | ECDSA with double SHA-256 | secp256k1 |
| 3 | Taproot, Schnorr with SHA-256 | secp256k1 |
| 4 | ECDSA with BLAKE2b-256 | secp256k1 |
| 5 | EdDSA with SHA-512 | Curve25519 |
| 6 | Schnorrkel | Ristretto |

A scheme on a curve not listed with it is refused from the request's bytes.

## Dkg

```rust
Dkg {
    network_key_id: NetworkKeyId,          // the network key's 32-byte public key
    curve: DWalletCurve,
    centralized_public_key_share_and_proof: Vec<u8>,
    user_secret_key_share: UserSecretKeyShare,
    user_public_output: Vec<u8>,
    sign_during_dkg_request: Option<SignDuringDKGRequest>,
}

enum UserSecretKeyShare {
    Encrypted {
        encrypted_centralized_secret_share_and_proof: Vec<u8>,
        encryption_key: Vec<u8>,
        signer_public_key: Vec<u8>,        // the holder's 32-byte Ed25519 key
    },
    Public { public_user_secret_key_share: Vec<u8> },
}
```

**Needs first:** for an encrypted share, the holder's `EncryptionKey` on chain must hold exactly
`encryption_key`. A request for a holder with no registered key waits about a minute, then is
refused.

`network_key_id` must be the epoch's newest usable network key: `latest_usable_network_key_id` of
`GetNetworkKeysByAge`. A new dWallet under any other key is refused.

`sign_during_dkg_request` asks the network to sign one message with the new dWallet in the same
session. It names a presign from the global pool served to the same request key. No voucher is
needed: the request that creates the dWallet asks for it. The signature comes back inside the
dWallet attestation, in `sign_during_dkg_signature`.

**After it:** the network writes the dWallet to Solana. With an encrypted share, the dWallet waits
for its holder to accept the share.

## Presign

```rust
Presign { network_key_id: NetworkKeyId, curve: DWalletCurve, signature_algorithm: DWalletSignatureAlgorithm }
```

**Needs first:** nothing. The presign belongs to the request key, and expires with the epoch it
was made in.

## Sign

```rust
Sign {
    message: Vec<u8>,
    message_metadata: Vec<u8>,                 // empty for most schemes
    signature_scheme: DWalletSignatureScheme,
    presign_session_identifier: Vec<u8>,       // the presign to use
    message_centralized_signature: Vec<u8>,    // the user's half of the signature
    dwallet_attestation: NetworkSignedAttestation,
    signature_voucher: [u8; 32],               // the voucher's address on Solana
}
```

**Needs first:**

- an Active dWallet, whose attestation the request carries;
- a presign of this epoch, served to the request key and not used before;
- a pending `SignatureVoucher` at `signature_voucher`, for this dWallet, message, metadata and
  scheme, whose signing key is the request key.

The network reads the voucher on Solana itself. A request whose voucher is missing, or has no
signing key yet, waits for it. See [Signature Vouchers](../on-chain/signature-voucher.md#what-the-network-checks).

`message_metadata` is BCS bytes of the scheme's metadata. Most schemes have none, and a non-empty
value for such a scheme is refused.

## ImportedKeyVerification, PresignForDWallet, ImportedKeySign

An imported dWallet holds a key the user already had. `ImportedKeyVerification` creates it. Its
fields are those of `Dkg`, with `centralized_party_message` in place of the public key share, and
no sign during creation.

For ECDSA, an imported dWallet signs only with a presign bound to it, which
`PresignForDWallet` makes. Schnorr-family presigns are always from the global pool.
`ImportedKeySign` has the fields of `Sign`.

## ReEncryptShare

```rust
ReEncryptShare {
    network_key_id: NetworkKeyId,
    dwallet_public_key: Vec<u8>,
    dwallet_attestation: NetworkSignedAttestation,
    encrypted_centralized_secret_share_and_proof: Vec<u8>,
    encryption_key: Vec<u8>,
    holder: ShareHolder,         // the new holder
    source_holder: ShareHolder,  // the holder of the share it is made from
}
```

**Needs first:** the dWallet Active on chain, and the new holder's `EncryptionKey` registered.
The network writes the new share to Solana, and the new holder accepts it there.

## MakeSharePublic

```rust
MakeSharePublic {
    dwallet_public_key: Vec<u8>,
    dwallet_attestation: NetworkSignedAttestation,
    public_user_secret_key_share: Vec<u8>,
}
```

**Needs first:** the dWallet Active on chain. The network writes the public share to Solana. From
then on the network can sign with the dWallet alone.

## FutureSign and its completions

```rust
FutureSign {
    dwallet_public_key: Vec<u8>,
    dwallet_attestation: NetworkSignedAttestation,
    presign_attestation: NetworkSignedAttestation,
    message: Vec<u8>,
    message_metadata: Vec<u8>,
    message_centralized_signature: Vec<u8>,
    signature_scheme: DWalletSignatureScheme,
    future_signature_voucher: [u8; 32],
}

SignWithPartialUserSig {
    partial_user_signature_attestation: NetworkSignedAttestation,  // step 1's answer
    dwallet_attestation: NetworkSignedAttestation,
    message: Vec<u8>,
    message_metadata: Vec<u8>,
    future_signature_voucher: [u8; 32],
}
```

**Step 1 needs:** a presign of this epoch, served to the request key and not used before, and an
open `FutureSignatureVoucher` whose signing key is the request key.

**Step 2 needs:** the voucher holding step 1's result, with its signing key set again by its owner
to the request key. Step 2 uses no presign, so it can run in any later epoch.

`ImportedKeySignWithPartialUserSig` has the fields of `SignWithPartialUserSig`, for an imported
dWallet. See [Future Signature Vouchers](../on-chain/future-signature-voucher.md).

## A dWallet that waits for its holder

A dWallet created with an encrypted share is unusable until its holder accepts the share. The
network starts no sign, presign for the dWallet, future sign, re-encryption or reveal on it until
then. Such a request is not refused at once. It waits, and runs once the network reads the
dWallet as Active. It is refused only if its usual wait ends first.
