# Read and Verify the Signature

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

Once the voucher exists, the proposal's signer asks the network to sign. The network answers with
the signature, and also writes it into the voucher. Anyone can then read it from Solana.

## Asking for the signature

The signer is the key named as the proposal's `user_pubkey`. It must have a
[gas deposit](../on-chain/gas-deposits.md). It takes a presign, then sends a sign request that
names the voucher's address. In TypeScript, with the SDK in mock mode for the pre-alpha:

```typescript
const presign = await ikaClient.requestGlobalPresign({
  curve,
  signatureAlgorithm: SignatureAlgorithm.EdDSA,
  userShareEncryptionKeys,
});

const signature = await ikaClient.requestSign({
  dWallet,
  presign,
  signatureVoucherId: signatureVoucher, // ["signature_voucher", proposal_id] of the voting program
  message,
  signatureAlgorithm: SignatureAlgorithm.EdDSA,
  hashScheme: Hash.SHA512,
  userShareEncryptionKeys,
});
```

`requestSign` returns the signature once it verifies under the dWallet's public key. See the SDK
pages for the client's setup.

## Reading it from the voucher

A reader that did not send the request reads the voucher. In TypeScript, `waitForSignature` reads
it until the signature is there, and returns it only once it verifies:

```typescript
const signature = await ikaClient.waitForSignature({
  signatureVoucher,
  dWallet,
  message,
  signatureAlgorithm: SignatureAlgorithm.EdDSA,
  hashScheme: Hash.SHA512,
});
```

It throws when the voucher ends without a signature, at status 2.

From Rust, read the account and the fields yourself:

```rust
const STATUS: usize = 173;
const SIGNATURE_LEN: usize = 174;
const SIGNATURE: usize = 176;

fn signature_of(data: &[u8]) -> Option<Vec<u8>> {
    if data.len() != 304 || data[0] != 108 {
        return None; // not a SignatureVoucher
    }
    match data[STATUS] {
        1 => {
            let len = u16::from_le_bytes([data[SIGNATURE_LEN], data[SIGNATURE_LEN + 1]]) as usize;
            Some(data[SIGNATURE..SIGNATURE + len].to_vec())
        }
        _ => None,
    }
}
```

Read again while the status is 0, pending, or 3, revoked: a sign agreed before a revoke can still
be written. Stop at status 2, which means no signature will come. Check the account's owner is the ika
program before you trust its bytes.

## Verifying it

The bytes in the voucher are not checked by the ika program. Verify them under the dWallet's public
key before you use them.

An EdDSA signature, for a Curve25519 dWallet, is 64 bytes:

```rust
use ed25519_dalek::{Signature, VerifyingKey};

let key = VerifyingKey::from_bytes(&dwallet_public_key)?;
key.verify_strict(&message, &Signature::from_bytes(&signature.try_into()?))?;
```

An ECDSA signature is 65 bytes: a recovery byte, then `r` and `s`. Drop the first byte for a library
that takes 64. For secp256k1 with SHA-256:

```rust
use k256::ecdsa::{Signature, VerifyingKey, signature::hazmat::PrehashVerifier};
use sha2::{Digest, Sha256};

let key = VerifyingKey::from_sec1_bytes(&dwallet_public_key)?;
let digest = Sha256::digest(&message);
key.verify_prehash(&digest, &Signature::from_slice(&signature[1..])?)?;
```

The hash is the one the scheme names, not the Keccak-256 the voucher stores. The voucher's digest
only names the message.

## The whole run

```text
1. Create a dWallet                       the user's wallet owns it
2. create_council (quorum 3)              council at ["council", dwallet]
3. TransferOwnership to the CPI authority dWallet.owner = the program's CPI authority
4. create_proposal                        proposal open, quorum 3
5. cast_vote, member 1, yes               yes_votes = 1
6. cast_vote, member 2, yes               yes_votes = 2
7. cast_vote, member 3, yes               the voucher is created, pending; the proposal is approved
8. presign and sign request               the network signs
9. the network's CommitSignature          the voucher is signed, status 1
```

## Next

[Test the program](./testing.md).
