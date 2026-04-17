# Building the Multisig Program

> **Pre-Alpha Disclaimer:** This is a pre-alpha release for development and testing only. Signing uses a single mock signer, not real distributed MPC. All 11 protocol operations are implemented (DKG, Sign, Presign, FutureSign, ReEncryptShare, etc.) across all 4 curves and 7 signature schemes, but without real MPC security guarantees. The dWallet keys, trust model, and signing protocol are not final; do not rely on any key material until mainnet. All interfaces, APIs, and data formats are subject to change without notice. The Solana program and all on-chain data will be wiped periodically and everything will be deleted when we transition to Ika Alpha 1. This software is provided "as is" without warranty of any kind; use is entirely at your own risk and dWallet Labs assumes no liability for any damages arising from its use.

## What You'll Learn

- How to design a multisig with fixed members and threshold approval
- How to store transaction data on-chain for other signers to inspect
- How to implement both approval and rejection flows
- How to use `transfer_future_sign` for partial signature management

## Architecture

```
Creator ──► CreateMultisig (members, threshold, dWallet)
                │
Member 1 ──► CreateTransaction (message data stored on-chain)
                │
Member 1 ──► Approve ──┐
Member 2 ──► Approve ──┼──► threshold reached? ──► approve_message CPI
Member 3 ──► Reject  ──┘                                    │
                                                   transfer_future_sign CPI
                                                            │
                                                   Transaction = Approved
```

## 1. Account Layouts

### Multisig PDA (`["multisig", create_key]`) — 395 bytes

| Field | Offset | Size | Type |
|-------|--------|------|------|
| disc | 0 | 1 | always 1 |
| version | 1 | 1 | always 1 |
| create_key | 2 | 32 | unique key |
| threshold | 34 | 2 | u16 LE |
| member_count | 36 | 2 | u16 LE |
| tx_index | 38 | 4 | u32 LE (auto-increment) |
| dwallet | 42 | 32 | pubkey |
| bump | 74 | 1 | PDA bump |
| members | 75 | 320 | 10 × 32-byte pubkeys |

### Transaction PDA (`["transaction", multisig, tx_index_le]`) — 432 bytes

| Field | Offset | Size | Type |
|-------|--------|------|------|
| disc | 0 | 1 | always 2 |
| multisig | 2 | 32 | pubkey |
| tx_index | 34 | 4 | u32 LE |
| proposer | 38 | 32 | pubkey |
| message_hash | 70 | 32 | keccak256 |
| approval_count | 135 | 2 | u16 LE |
| rejection_count | 137 | 2 | u16 LE |
| status | 139 | 1 | 0=Active, 1=Approved, 2=Rejected |
| message_data_len | 174 | 2 | u16 LE |
| message_data | 176 | 256 | raw bytes |

### ApprovalRecord PDA (`["approval", transaction, member]`) — 68 bytes

Prevents double voting. One per member per transaction.

## 2. Instructions

| Disc | Name | Description |
|------|------|-------------|
| 0 | CreateMultisig | Set members (up to 10), threshold, dWallet reference |
| 1 | CreateTransaction | Propose with message data stored on-chain |
| 2 | Approve | Vote yes; triggers CPI at threshold |
| 3 | Reject | Vote no; marks rejected when impossible to approve |

## 3. Rejection Threshold

A transaction is rejected when enough members reject that approval becomes impossible:

```
rejection_threshold = member_count - threshold + 1
```

Example: 2-of-3 multisig → `3 - 2 + 1 = 2` rejections needed.

## 4. CPI Flow on Approval

When `approval_count >= threshold`:

```rust
// 1. Approve the message (creates MessageApproval PDA)
ctx.approve_message(
    message_approval, dwallet, payer, system_program,
    message_hash, user_pubkey, signature_scheme,
    message_approval_bump,
)?;

// 2. Optionally transfer future sign authority
if partial_user_sig != [0u8; 32] {
    ctx.transfer_future_sign(partial_user_sig_account, proposer_key)?;
}

// 3. Mark transaction as approved
tx_data[TX_STATUS] = STATUS_APPROVED;
```

## Source Code

| Framework | Path |
|-----------|------|
| Pinocchio | `chains/solana/examples/multisig/pinocchio/src/lib.rs` |
| Native | `chains/solana/examples/multisig/native/src/lib.rs` |
| Anchor | `chains/solana/examples/multisig/anchor/src/lib.rs` |
