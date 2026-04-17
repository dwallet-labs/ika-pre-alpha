# Event Reference

> **Pre-Alpha Disclaimer:** This is a pre-alpha release for development and testing only. Signing uses a single mock signer, not real distributed MPC. All 11 protocol operations are implemented (DKG, Sign, Presign, FutureSign, ReEncryptShare, etc.) across all 4 curves and 7 signature schemes, but without real MPC security guarantees. The dWallet keys, trust model, and signing protocol are not final; do not rely on any key material until mainnet. All interfaces, APIs, and data formats are subject to change without notice. The Solana program and all on-chain data will be wiped periodically and everything will be deleted when we transition to Ika Alpha 1. This software is provided "as is" without warranty of any kind; use is entirely at your own risk and dWallet Labs assumes no liability for any damages arising from its use.

## Overview

The dWallet program emits events via Anchor-compatible self-CPI. Events are emitted as inner instructions and can be parsed from transaction metadata.

## Anchor-Compatible Event Format

Events use the same wire format as Anchor events:

```
EVENT_IX_TAG_LE(8) | event_discriminator(1) | event_data(N)
```

The `EVENT_IX_TAG_LE` is 8 bytes (`0xe4a545ea51cb9a1d` in little-endian). The event discriminator follows, then the event-specific data.

## Key Events

### MessageApprovalCreated

Emitted when `approve_message` creates a new `MessageApproval` PDA.

| Field | Size | Description |
|-------|------|-------------|
| dwallet | 32 | dWallet pubkey |
| message_hash | 32 | Hash of the message to sign |
| caller_program | 32 | Program that approved |

The Ika network listens for this event to initiate the signing protocol.

### SignatureCommitted

Emitted when the NOA calls `commit_signature` to write a signature.

| Field | Size | Description |
|-------|------|-------------|
| message_approval | 32 | MessageApproval account pubkey |
| signature_len | 2 | Length of the signature |

Off-chain clients can listen for this to know when a signature is ready.

### DWalletCreated

Emitted when `commit_dwallet` creates a new dWallet.

| Field | Size | Description |
|-------|------|-------------|
| dwallet | 32 | New dWallet pubkey |
| authority | 32 | Initial authority |
| curve | 1 | Curve identifier |

### AuthorityTransferred

Emitted when `transfer_ownership` changes a dWallet's authority.

| Field | Size | Description |
|-------|------|-------------|
| dwallet | 32 | dWallet pubkey |
| old_authority | 32 | Previous authority |
| new_authority | 32 | New authority |

## Parsing Events

Events appear as inner instructions in the transaction metadata. To parse them:

1. Find inner instructions targeting the dWallet program
2. Match the first 8 bytes against `EVENT_IX_TAG_LE`
3. Read the 1-byte event discriminator
4. Deserialize the remaining bytes according to the event schema

### Example: Detecting Signatures

```rust
use solana_transaction_status::UiTransactionEncoding;

let tx = client.get_transaction_with_config(
    &tx_signature,
    RpcTransactionConfig {
        encoding: Some(UiTransactionEncoding::Base64),
        commitment: Some(CommitmentConfig::confirmed()),
        max_supported_transaction_version: Some(0),
    },
)?;

// Parse inner instructions for SignatureCommitted events
if let Some(meta) = tx.transaction.meta {
    for inner_ix in meta.inner_instructions.unwrap_or_default() {
        for ix in inner_ix.instructions {
            // Check EVENT_IX_TAG_LE prefix and parse event data
        }
    }
}
```

### Example: Polling for MessageApproval Status

Rather than parsing events, you can poll the `MessageApproval` account directly:

```rust
loop {
    let data = client.get_account(&message_approval_pda)?.data;
    if data[139] == 1 { // status == Signed
        let sig_len = u16::from_le_bytes(data[140..142].try_into().unwrap()) as usize;
        let signature = data[142..142 + sig_len].to_vec();
        break;
    }
    std::thread::sleep(Duration::from_millis(500));
}
```

## Event vs Polling

| Approach | Pros | Cons |
|----------|------|------|
| **Event parsing** | Immediate notification, no polling | Requires transaction metadata, more complex |
| **Account polling** | Simple, works everywhere | Latency, wasted RPC calls |

For production use, event-based detection is recommended. For testing and simple scripts, polling is sufficient.
