# Message Approval

> **Pre-Alpha Disclaimer:** This is a pre-alpha release for development and testing only. Signing uses a single mock signer, not real distributed MPC. All 11 protocol operations are implemented (DKG, Sign, Presign, FutureSign, ReEncryptShare, etc.) across all 4 curves and 7 signature schemes, but without real MPC security guarantees. The dWallet keys, trust model, and signing protocol are not final; do not rely on any key material until mainnet. All interfaces, APIs, and data formats are subject to change without notice. The Solana program and all on-chain data will be wiped periodically and everything will be deleted when we transition to Ika Alpha 1. This software is provided "as is" without warranty of any kind; use is entirely at your own risk and dWallet Labs assumes no liability for any damages arising from its use.

## Overview

Message approval is the core mechanism for requesting signatures from the Ika network. When you call `approve_message`, it creates a `MessageApproval` PDA on-chain. The network detects this account and produces a signature.

## MessageApproval Account

```
MessageApproval PDA:
  Seeds: ["dwallet", chunks..., "message_approval", &scheme_u16_le, &message_digest, [&message_metadata_digest]]
  Program: DWALLET_PROGRAM_ID
  Total: 312 bytes (2 header + 310 data)
```

The PDA is rooted from the parent dWallet's `curve_u16_le || public_key` chunks (same hierarchy as all dWallet-derived PDAs). The `message_metadata_digest` seed is only included when non-zero.

The `message_digest` must be the **keccak256** hash of the message you want signed:

```rust
let message_digest = solana_sdk::keccak::hash(message).to_bytes();
```

```typescript
import { keccak_256 } from "@noble/hashes/sha3.js";
const messageDigest = keccak_256(message);
```

This is consistent across all examples, the mock, and the gRPC service. Using any other hash function will result in a PDA mismatch when the network tries to commit the signature on-chain.

| Offset | Field | Size | Description |
|--------|-------|------|-------------|
| 0 | discriminator | 1 | `14` |
| 1 | version | 1 | `1` |
| 2 | dwallet | 32 | dWallet account pubkey |
| 34 | message_digest | 32 | Keccak-256 digest of the message to sign |
| 66 | message_metadata_digest | 32 | Keccak-256 digest of message metadata (zero if none) |
| 98 | approver | 32 | dWallet authority who authorized the signing |
| 130 | user_pubkey | 32 | Public key authorized to call gRPC Sign |
| 162 | signature_scheme | 2 | `DWalletSignatureScheme` (u16 LE) |
| 164 | epoch | 8 | Epoch when the approval was created (LE u64) |
| 172 | status | 1 | Pending(0) or Signed(1) |
| 173 | signature_len | 2 | Length of the signature (LE u16) |
| 175 | signature | 128 | Signature bytes (padded) |
| 303 | bump | 1 | PDA bump seed |
| 304 | _reserved | 8 | Reserved for future use |

**Note:** `signature_scheme` is now `[u8; 2]` (u16 LE) encoding a `DWalletSignatureScheme` value (0-6), not a single-byte `SignatureScheme`. The field `message_hash` has been renamed to `message_digest`, and `message_metadata_digest` is new.

## Approval Flow

### Direct Approval (User Signer)

When the dWallet's authority is a user wallet:

```
User signs approve_message instruction
  -> dWallet program verifies user == dwallet.authority
  -> Creates MessageApproval PDA (status = Pending)
```

### CPI Approval (Program Signer)

When the dWallet's authority is a CPI authority PDA:

```
Your program calls DWalletContext::approve_message
  -> invoke_signed with CPI authority seeds
  -> dWallet program verifies:
      - caller_program is executable
      - cpi_authority == PDA(["__ika_cpi_authority"], caller_program)
      - dwallet.authority == cpi_authority
  -> Creates MessageApproval PDA (status = Pending)
```

## approve_message Instruction

**Discriminator:** `8`

The first account is the `DWalletCoordinator` PDA (used to read the current epoch).

**Instruction Data:**

| Offset | Field | Size |
|--------|-------|------|
| 0 | discriminator | 1 |
| 1 | bump | 1 |
| 2 | message_digest | 32 |
| 34 | message_metadata_digest | 32 |
| 66 | user_pubkey | 32 |
| 98 | signature_scheme | 2 |

**Accounts (CPI path):**

| # | Account | W | S | Description |
|---|---------|---|---|-------------|
| 0 | coordinator | no | no | DWalletCoordinator PDA (for epoch) |
| 1 | message_approval | yes | no | MessageApproval PDA (must be empty) |
| 2 | dwallet | no | no | dWallet account |
| 3 | caller_program | no | no | Calling program (executable) |
| 4 | cpi_authority | no | yes | CPI authority PDA (signed via invoke_signed) |
| 5 | payer | yes | yes | Rent payer |
| 6 | system_program | no | no | System program |

## Signature Lifecycle

1. **Pending**: Your program calls `approve_message` -> MessageApproval created, `status = 0`, `signature_len = 0`
2. **gRPC Sign**: You send a `Sign` request via gRPC with `ApprovalProof` referencing the on-chain approval. The network returns the 64-byte signature directly and commits it on-chain via `CommitSignature`.
3. **Signed**: `status = 1`, signature bytes written, readable by anyone.

```
Your program calls approve_message (CPI)
  -> MessageApproval PDA created (status = Pending)
  -> You send gRPC Sign request with ApprovalProof
  -> Network signs and returns signature via gRPC
  -> Network calls CommitSignature on-chain
  -> status = Signed, signature available
```

The signature is available both from the gRPC response and on-chain in the MessageApproval account.

## CommitSignature Instruction

Called by the NOA to write the signature into the MessageApproval account (or a PartialUserSignature account -- dispatches by the target account's discriminator).

**Discriminator:** `43`

**Instruction Data:**

| Offset | Field | Size |
|--------|-------|------|
| 0 | discriminator | 1 |
| 1 | signature_len | 2 |
| 3 | signature | 128 |

**Accounts:**

| # | Account | W | S | Description |
|---|---------|---|---|-------------|
| 0 | target_account | yes | no | MessageApproval or PartialUserSignature PDA |
| 1 | nek | no | no | NetworkEncryptionKey PDA |
| 2 | noa | no | yes | NOA signer |

## Reading the Signature

```rust
let data = client.get_account(&message_approval_pda)?.data;

let status = data[172];
if status == 1 {
    let sig_len = u16::from_le_bytes(data[173..175].try_into().unwrap()) as usize;
    let signature = &data[175..175 + sig_len];
    // Use the signature
}
```

## Idempotency

The same `(dwallet_root, scheme, message_digest, message_metadata_digest)` tuple always derives the same MessageApproval PDA. Attempting to create a MessageApproval that already exists will fail (the account is non-empty). This prevents duplicate signing requests.
