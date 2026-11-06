# Multisig dWallet: Overview

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

## Overview

An M-of-N multisig program controlling a dWallet. The multisig is created **for one dWallet by that dWallet's owner** (before the dWallet is handed to the program) with a fixed member list and threshold. Any member can propose transactions with message data stored on-chain for other members to inspect. Members approve or reject. When threshold approvals are reached, the program CPI-calls `issue_signature_voucher` on the multisig's dWallet. A transaction proposed as a future sign gets `issue_future_signature_voucher` instead. When enough rejections accumulate (making approval impossible), the transaction is marked rejected.

**Use case:** Multi-party custody, organizational signing policies, timelocked operations.

The per-dWallet binding is what makes this a multisig *for a dWallet* rather than a multisig for the program: the dWallet program authenticates a program by one CPI authority PDA per program, so without the binding any multisig instance could reach any dWallet the program controls. See [Integrator Invariants](../../on-chain/integrator-invariants.md).

## Program Design

### Accounts

| Account | Seeds | Size | Description |
|---------|-------|------|-------------|
| Multisig | `["multisig", dwallet]` | 363 bytes | Members list, threshold, tx counter — exactly one per dWallet |
| Transaction | `["transaction", multisig, tx_index_le]` | 402 bytes | Message data, approval/rejection counts, status, future-sign flag |
| ApprovalRecord | `["approval", transaction, member]` | 68 bytes | Prevents double voting — one per member per transaction |

### Instructions

| Disc | Instruction | Description |
|------|-------------|-------------|
| `0` | CreateMultisig | The dWallet's owner creates the multisig for that dWallet with members (up to 10) and threshold |
| `1` | CreateTransaction | A member proposes a transaction with message data stored on-chain |
| `2` | Approve | Approve; when threshold reached, CPI `issue_signature_voucher` on the multisig's dWallet, or `issue_future_signature_voucher` for a future-sign transaction |
| `3` | Reject | Reject; when enough rejections, mark transaction as rejected |

### Multisig Layout (363 bytes)

```
disc(1) + version(1) + dwallet(32) + threshold(u16) + member_count(u16) +
tx_index(u32) + bump(1) + members(32 * 10)
```

### Transaction Layout (402 bytes)

```
disc(1) + version(1) + multisig(32) + tx_index(u32) + proposer(32) +
message_hash(32) + user_pubkey(32) + signature_scheme(u16) +
approval_count(u16) + rejection_count(u16) + status(1) +
signature_voucher_bump(1) + future_sign(1) + bump(1) +
message_data_len(u16) + message_data(256)
```

### Key Offsets

| Account | Field | Offset | Size | Type |
|---------|-------|--------|------|------|
| Multisig | dwallet | 2 | 32 | pubkey |
| Multisig | threshold | 34 | 2 | u16 LE |
| Multisig | member_count | 36 | 2 | u16 LE |
| Multisig | tx_index | 38 | 4 | u32 LE |
| Multisig | bump | 42 | 1 | u8 |
| Multisig | members | 43 | 320 | 10 x pubkey |
| Transaction | signature_scheme | 134 | 2 | u16 LE (`5` = EdDSA/SHA-512) |
| Transaction | approval_count | 136 | 2 | u16 LE |
| Transaction | rejection_count | 138 | 2 | u16 LE |
| Transaction | status | 140 | 1 | 0=Active, 1=Approved, 2=Rejected |
| Transaction | signature_voucher_bump | 141 | 1 | u8 |
| Transaction | future_sign | 142 | 1 | 0 = signature voucher, 1 = future signature voucher |
| Transaction | bump | 143 | 1 | u8 |
| Transaction | message_data_len | 144 | 2 | u16 LE |
| Transaction | message_data | 146 | 256 | raw bytes |

## Rejection Logic

A transaction is rejected when enough members reject that approval becomes impossible:

```
rejection_threshold = member_count - threshold + 1
```

For a 2-of-3 multisig: `3 - 2 + 1 = 2` rejections needed to reject.

## CPI Flow

When `approval_count >= threshold`, the program:

1. Checks that the dWallet account passed for the CPI is the multisig's dWallet, before any CPI
2. If `future_sign` is 0, calls `ctx.issue_signature_voucher(...)`. This creates the `SignatureVoucher` at the program's PDA `["signature_voucher", transaction]`, and the program signs for it with those seeds. The voucher's signing key is the transaction's `user_pubkey`, and its owner is the program's CPI authority
3. If `future_sign` is 1, calls `ctx.issue_future_signature_voucher(...)` instead. This creates a `FutureSignatureVoucher` at the same PDA. Its signing key is the transaction's `user_pubkey`, and its owner is the proposer. The proposer later sets the key that completes the future sign, with the dWallet program's `SetVoucherSigningKey` instruction
4. Sets transaction status to Approved

## E2E Flow

```
1.  Make a user         → new keys, encryption key registered, gas deposit opened
2.  gRPC DKG            → dWallet created; the user accepts the share; owner = the payer
3.  Create multisig     → 2-of-3 with 3 member pubkeys, for this dWallet (signed by the payer)
4.  Transfer ownership  → the program's CPI authority owns the dWallet
5.  Propose transaction → message stored on-chain; user_pubkey = the user's request key
6.  Member 1 approves   → approval_count = 1
7.  Member 2 approves   → approval_count = 2 = threshold → the CPI issues the voucher
8.  gRPC presign        → take a presign
9.  gRPC sign           → the 64-byte Ed25519 signature, also written into the voucher
10. Rejection           → propose a 2nd transaction, 2 rejections → status = Rejected
```

## React Frontend

A React frontend at `examples/multisig/react/` does the same
thing from a browser: the user's half of the protocol runs in the tab, the
dWallet is owned by the connected wallet, and every approval is a wallet
signature.

The page talks gRPC-Web to the devnet pre-alpha directly, through `fetch`, so it needs no proxy.
The [E2E Demo](./04-e2e.md#running-the-react-page) page shows how to run it.

The page holds two kinds of key. The connected wallet owns the dWallet, pays for every transaction,
and signs the multisig's instructions. The user's keys, made from a root seed in the tab, sign the
gRPC requests. Their request key owns the gas deposit those requests are charged to.

## Testing

```bash
# from the repository root
# Mollusk + LiteSVM (all 3 framework variants)
cargo test -p ika-example-multisig          # pinocchio
cargo test -p ika-example-multisig-native   # native
cargo test -p ika-example-multisig-anchor   # anchor (LiteSVM)

# TypeScript E2E, against the devnet pre-alpha (see the E2E Demo page)
cd examples && bun install
PAYER_KEYPAIR=<your-keypair.json> bun multisig/e2e/main.ts CqGtQgrYFUhobuknomFNntwoxCgKGkBRUtemgdPuM9qT <MULTISIG_ID>
```

## Source Files

- Pinocchio: `examples/multisig/pinocchio/src/lib.rs`
- Native: `examples/multisig/native/src/lib.rs`
- Anchor: `examples/multisig/anchor/src/lib.rs`
- TypeScript E2E: `examples/multisig/e2e/main.ts`
- React: `examples/multisig/react/`
