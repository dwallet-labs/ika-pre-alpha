# Multisig Example

> **Pre-Alpha Disclaimer:** This is a pre-alpha release for development and testing only. Signing uses a single mock signer, not real distributed MPC. All 11 protocol operations are implemented (DKG, Sign, Presign, FutureSign, ReEncryptShare, etc.) across all 4 curves and 7 signature schemes, but without real MPC security guarantees. The dWallet keys, trust model, and signing protocol are not final; do not rely on any key material until mainnet. All interfaces, APIs, and data formats are subject to change without notice. The Solana program and all on-chain data will be wiped periodically and everything will be deleted when we transition to Ika Alpha 1. This software is provided "as is" without warranty of any kind; use is entirely at your own risk and dWallet Labs assumes no liability for any damages arising from its use.

## Overview

An M-of-N multisig program controlling a dWallet. Fixed members are set at creation. Any member can propose transactions with message data stored on-chain for other members to inspect. Members approve or reject. When threshold approvals are reached, the program CPI-calls `approve_message` and optionally `transfer_future_sign`. When enough rejections accumulate (making approval impossible), the transaction is marked rejected.

**Use case:** Multi-party custody, organizational signing policies, timelocked operations.

## Program Design

### Accounts

| Account | Seeds | Size | Description |
|---------|-------|------|-------------|
| Multisig | `["multisig", create_key]` | 395 bytes | Members list, threshold, dWallet reference, tx counter |
| Transaction | `["transaction", multisig, tx_index_le]` | 432 bytes | Message data, approval/rejection counts, status |
| ApprovalRecord | `["approval", transaction, member]` | 68 bytes | Prevents double voting — one per member per transaction |

### Instructions

| Disc | Instruction | Description |
|------|-------------|-------------|
| `0` | CreateMultisig | Create multisig with members (up to 10), threshold, dWallet |
| `1` | CreateTransaction | Propose a transaction with message data stored on-chain |
| `2` | Approve | Approve; when threshold reached, CPI `approve_message` + optional `transfer_future_sign` |
| `3` | Reject | Reject; when enough rejections, mark transaction as rejected |

### Multisig Layout (395 bytes)

```
disc(1) + version(1) + create_key(32) + threshold(u16) + member_count(u16) +
tx_index(u32) + dwallet(32) + bump(1) + members(32 * 10)
```

### Transaction Layout (432 bytes)

```
disc(1) + version(1) + multisig(32) + tx_index(u32) + proposer(32) +
message_hash(32) + user_pubkey(32) + signature_scheme(1) +
approval_count(u16) + rejection_count(u16) + status(1) +
message_approval_bump(1) + partial_user_sig(32) + bump(1) +
message_data_len(u16) + message_data(256)
```

### Key Offsets

| Field | Offset | Size | Type |
|-------|--------|------|------|
| approval_count | 135 | 2 | u16 LE |
| rejection_count | 137 | 2 | u16 LE |
| status | 139 | 1 | 0=Active, 1=Approved, 2=Rejected |
| message_data_len | 174 | 2 | u16 LE |
| message_data | 176 | 256 | raw bytes |

## Rejection Logic

A transaction is rejected when enough members reject that approval becomes impossible:

```
rejection_threshold = member_count - threshold + 1
```

For a 2-of-3 multisig: `3 - 2 + 1 = 2` rejections needed to reject.

## CPI Flow

When `approval_count >= threshold`, the program:

1. Calls `ctx.approve_message(...)` — creates `MessageApproval` PDA
2. If `partial_user_sig` is set (non-zero), calls `ctx.transfer_future_sign(...)` — transfers the partial signature completion authority to the proposer
3. Sets transaction status to Approved

## E2E Flow

```
1.  gRPC DKG           → dWallet created, authority = caller
2.  Transfer authority  → CPI PDA owns the dWallet
3.  Create multisig     → 2-of-3 with 3 member pubkeys
4.  Propose transaction → message data stored on-chain
5.  Member1 approves    → approval_count = 1
6.  Member2 approves    → approval_count = 2 = threshold → CPI!
7.  Verify approval     → MessageApproval exists
8.  gRPC presign        → allocate presign
9.  gRPC sign           → 64-byte signature
10. Rejection test      → propose 2nd tx, 2 rejections → status=Rejected
```

## React Frontend

A React frontend is included at `chains/solana/examples/multisig/react/` with:

- Create dWallet + Multisig (via gRPC-web client)
- Propose transactions
- Approve/reject as a member
- View transaction status and message data
- Airdrop button for local testing

```bash
cd chains/solana/examples/multisig/react && bun install && bun dev
```

## Testing

```bash
# Mollusk (all 3 framework variants)
cargo test -p ika-example-multisig --test mollusk         # pinocchio (11 tests)
cargo test -p ika-example-multisig-native --test mollusk  # native (11 tests)

# TypeScript E2E
cd chains/solana/examples/multisig/e2e && bun main.ts <DWALLET_ID> <MULTISIG_ID>
```

## Source Files

- Pinocchio: `chains/solana/examples/multisig/pinocchio/src/lib.rs`
- Native: `chains/solana/examples/multisig/native/src/lib.rs`
- Anchor: `chains/solana/examples/multisig/anchor/src/lib.rs`
- TypeScript E2E: `chains/solana/examples/multisig/e2e/main.ts`
- React: `chains/solana/examples/multisig/react/`
