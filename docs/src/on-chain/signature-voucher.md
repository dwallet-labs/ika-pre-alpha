# Signature Vouchers

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

A signature voucher is the on-chain permission for one signature. It names a dWallet, the digest
of one message, and a signature scheme. The network signs that message once with that dWallet,
and only when a voucher allows it. It then writes the signature into the voucher, where anyone
can read it.

A voucher is a `SignatureVoucher` account of the ika program. The dWallet's owner creates it with
`IssueSignatureVoucher`, either directly or from a program through a CPI.

One voucher allows one signature. To sign the same message twice, issue two vouchers.

## The flow

1. The dWallet's owner issues a voucher at a new address. The voucher is pending.
2. The user sends a sign request over gRPC. The request names the voucher's address, and it is
   signed by the voucher's signing key.
3. Each validator reads the voucher at that address on Solana and checks that it matches the
   request. The request runs once enough validators agree on what they read.
4. The network answers the request with the signature.
5. The network writes the same signature into the voucher with `CommitSignature`. The voucher's
   status becomes 1, signed.

The sign request carries no copy of the voucher. The validators trust only what they read from
Solana themselves. On the devnet pre-alpha, the mock reads the voucher instead, and then signs.

## What the voucher holds

| Offset | Field | Meaning |
|---|---|---|
| 2 | `dwallet` | The dWallet's address |
| 34 | `message_digest` | The Keccak-256 of the message |
| 66 | `message_metadata_digest` | The Keccak-256 of the metadata, or 32 zeros for none |
| 98 | `owner` | Who controls the voucher |
| 130 | `signature_scheme` | The signature scheme, as a u16 |
| 132 | `has_signing_key` | 1 when `signing_key` is set |
| 133 | `signing_key` | The Ed25519 key a sign request must be signed by |
| 165 | `issued_epoch` | The epoch it was issued in |
| 173 | `status` | 0 pending, 1 signed, 2 closed by a charge, 3 revoked |
| 174 | `signature_len` | The signature's length. 0 until signed |
| 176 | `signature` | The signature, padded to 128 bytes |

The account is 304 bytes, tag 108.

`has_signing_key` exists because no key value can mean "no key". An all-zero Ed25519 key is
still a key.

## The message digest

`message_digest` is the Keccak-256 of the message to sign. It is always Keccak-256, whatever
the signature scheme hashes the message with. The network computes the same digest from the
message in the sign request, and compares the two.

```typescript
import { approvalMessageDigests } from '@ika.xyz/sdk-solana';

const { messageDigest, messageMetadataDigest } = approvalMessageDigests(message);
```

```rust
let message_digest = solana_keccak_hasher::hash(message).to_bytes();
```

Most schemes have no metadata. Then `message_metadata_digest` is 32 zeros, not the hash of an
empty input. ECDSA with BLAKE2b-256 and Schnorrkel carry metadata.

## Where a voucher lives

A voucher has no derived address. The issuer picks a new address, and that address must sign the
transaction that creates the voucher. Two choices work:

- A wallet that owns its dWallet makes a new keypair. The keypair signs the transaction, and the
  voucher is created at its address.
- A program uses a PDA of its own, and signs for it with `invoke_signed`. Derive the PDA from the
  record that asked for the signature, such as `["signature_voucher", proposal_id]`. Then the
  program and the client both know the address before the voucher exists.

The address must hold nothing when the voucher is created. Keep it: the sign request names it.

## Issuing a voucher

The issuer must be the dWallet's owner. The dWallet must be Active, and the coordinator must not
be paused. See the full layout of [IssueSignatureVoucher](../reference/instructions.md#issuesignaturevoucher-156).

The issuer can set two things at issue time:

- **The owner.** Who controls the voucher afterwards. Without one, the owner is the issuer: the
  wallet, or the program's CPI authority.
- **The signing key.** The Ed25519 key whose signed sign request the voucher accepts. Without
  one, the voucher waits until its owner sets a key.

The signing key is the user's request key: the key that signs gRPC requests and pays for them
from its [gas deposit](./gas-deposits.md). A program that issues a voucher for a user names that
user's request key here.

From a Pinocchio program:

```rust
ctx.issue_signature_voucher(
    coordinator,             // the DWalletCoordinator
    signature_voucher,       // the new voucher's address
    dwallet,                 // the dWallet
    payer,                   // pays the voucher's rent
    system_program,
    message_digest,          // Keccak-256 of the message
    [0u8; 32],               // no metadata
    5,                       // EdDSA with SHA-512, for a Curve25519 dWallet
    None,                    // owner: this program's CPI authority
    Some(user_request_key),  // the key the sign request must be signed by
    Some(&voucher_seeds),    // the voucher PDA's seeds, bump included
)?;
```

See [The CPI Framework](./cpi-framework.md) for the context `ctx` and the other frameworks.

## The owner's controls

After issue, only the voucher's owner can change it. The dWallet's owner has no say over a
voucher it did not keep.

| Instruction | What it does | When |
|---|---|---|
| `SetVoucherSigningKey` | Sets or replaces the signing key | While pending |
| `RevokeSignatureVoucher` | Revokes the voucher for good | While pending |
| `TransferSignatureVoucher` | Gives the voucher to a new owner | Always |

None of the three checks the pause.

## The statuses

| Status | Name | What it means |
|---|---|---|
| 0 | Pending | Waiting for a sign request |
| 1 | Signed | The signature is stored |
| 2 | Closed by a charge | The network charged for the signature and gave up delivering it. No signature will come |
| 3 | Revoked | The owner revoked it. No new sign request is served |

A revoke stops new requests, not work already agreed. When enough validators agreed on a sign
before the revoke was written, that sign still runs. The network then writes its signature into the
revoked voucher, which becomes Signed.

A voucher that is already signed keeps its first signature. A second write is accepted and
changes nothing.

## What the network checks

On the real network, a sign request is served only when the voucher:

- exists, is owned by the ika program and is a `SignatureVoucher`;
- is pending;
- names the dWallet of the request;
- holds the digests of the request's message and metadata;
- holds the request's signature scheme;
- has a signing key, equal to the key that signed the request.

A request whose voucher is missing, or has no key yet, or has another key, waits. The voucher can
still appear, or its key can still be set. A request whose voucher is signed, revoked, closed, or
for another dWallet, message or scheme is refused.

The mock network checks the same values. It differs in one way: it signs for a voucher that has
no signing key, where the real network waits for the key.

## Reading the signature

Read the account and look at `status`:

```rust
let data = rpc.get_account_data(&signature_voucher)?;
match data[173] {
    1 => {
        let len = u16::from_le_bytes([data[174], data[175]]) as usize;
        let signature = &data[176..176 + len];
        // use the signature
    }
    0 | 3 => { /* not signed yet: read again later */ }
    _ => { /* 2: no signature will come */ }
}
```

Keep reading a revoked voucher, because a sign agreed before the revoke can still be written. Stop at
status 2.

The stored signature is the same bytes the gRPC answer carried. An ECDSA signature is 65 bytes:
a recovery byte, then `r` and `s`. Taproot, EdDSA and Schnorrkel signatures are 64 bytes.

Nothing in the account proves the signature is correct. Verify it under the dWallet's public key
before you use it. In TypeScript, `readSignatureVoucherVerified` from `@ika.xyz/sdk-solana` reads
the voucher and verifies its signature.

## Checks for a program that reads a voucher

A program that acts on a voucher should check:

- the account is the ika program's, with tag 108 and 304 bytes;
- `dwallet` is the dWallet you expect;
- `owner` is the owner you expect, usually your own CPI authority;
- `message_digest` is the digest you expect.

A voucher with the right digest for another dWallet is not yours.
