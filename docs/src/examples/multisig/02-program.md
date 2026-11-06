# Building the Multisig Program

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

## What You'll Learn

- How to design a multisig with fixed members and threshold approval, bound to one dWallet
- How to store transaction data on-chain for other signers to inspect
- How to implement both approval and rejection flows
- How to issue a future signature voucher, owned by the proposer, for a transaction proposed as a future sign

## Architecture

```
dWallet owner ──► CreateMultisig (members, threshold) ──► Multisig PDA ["multisig", dwallet]
                  ──► transfer ownership to CPI PDA
                │
Member 1 ──► CreateTransaction (message data stored on-chain)
                │
Member 1 ──► Approve ──┐
Member 2 ──► Approve ──┼──► threshold reached? ──► dwallet == multisig.dwallet? ──► future_sign == 0? ──► issue_signature_voucher CPI
Member 3 ──► Reject  ──┘                                                            future_sign == 1? ──► issue_future_signature_voucher CPI
                                                                                                                      │
                                                                                                             Transaction = Approved
```

## 1. Account Layouts

### Multisig PDA (`["multisig", dwallet]`) — 363 bytes

| Field | Offset | Size | Type |
|-------|--------|------|------|
| disc | 0 | 1 | always 1 |
| version | 1 | 1 | always 1 |
| dwallet | 2 | 32 | pubkey — the dWallet this multisig governs |
| threshold | 34 | 2 | u16 LE |
| member_count | 36 | 2 | u16 LE |
| tx_index | 38 | 4 | u32 LE (auto-increment) |
| bump | 42 | 1 | canonical PDA bump |
| members | 43 | 320 | 10 × 32-byte pubkeys |

### Transaction PDA (`["transaction", multisig, tx_index_le]`) — 402 bytes

| Field | Offset | Size | Type |
|-------|--------|------|------|
| disc | 0 | 1 | always 2 |
| version | 1 | 1 | always 1 |
| multisig | 2 | 32 | pubkey |
| tx_index | 34 | 4 | u32 LE |
| proposer | 38 | 32 | pubkey |
| message_hash | 70 | 32 | keccak256 |
| user_pubkey | 102 | 32 | key allowed to call gRPC Sign |
| signature_scheme | 134 | 2 | u16 LE (`DWalletSignatureScheme`) |
| approval_count | 136 | 2 | u16 LE |
| rejection_count | 138 | 2 | u16 LE |
| status | 140 | 1 | 0=Active, 1=Approved, 2=Rejected |
| signature_voucher_bump | 141 | 1 | u8 (bump of the voucher PDA `["signature_voucher", transaction]`) |
| future_sign | 142 | 1 | 0 = issue a signature voucher, 1 = issue a future signature voucher |
| bump | 143 | 1 | PDA bump |
| message_data_len | 144 | 2 | u16 LE |
| message_data | 146 | 256 | raw bytes |

### ApprovalRecord PDA (`["approval", transaction, member]`) — 68 bytes

Prevents double voting. One per member per transaction.

## 2. Instructions

| Disc | Name | Description |
|------|------|-------------|
| 0 | CreateMultisig | The dWallet's current owner sets members (up to 10) and threshold for that dWallet |
| 1 | CreateTransaction | A member proposes with message data stored on-chain |
| 2 | Approve | Vote yes; triggers CPI at threshold |
| 3 | Reject | Vote no; marks rejected when impossible to approve |

`CreateMultisig` takes the dWallet account and the dWallet program: the dWallet program account must be the ika program (`ID` of the CPI crate) and executable, the dWallet account must be owned by it, carry the `DWallet` discriminator (`97`), and its stored `owner` (offset 2) must be the signer. The multisig is created at the canonical `["multisig", dwallet]` PDA, so there is exactly one per dWallet and it can only be created while the dWallet is still controlled by its user — once the owner is the CPI PDA nobody can sign for it.

## 3. Rejection Threshold

A transaction is rejected when enough members reject that approval becomes impossible:

```
rejection_threshold = member_count - threshold + 1
```

Example: 2-of-3 multisig → `3 - 2 + 1 = 2` rejections needed.

## 4. CPI Flow on Approval

When `approval_count >= threshold`:

```rust
// 0. Bind the CPI target — before any CPI. The CPI authority PDA is shared by
//    every dWallet this program controls, so only the multisig's own dWallet
//    may get a voucher.
if dwallet.address().as_array() != &multisig_dwallet {
    return Err(MultisigError::DWalletMismatch.into());
}

// 1. Issue the voucher. It is this program's PDA for the transaction, so the
//    program signs its creation with the PDA's seeds.
let voucher_bump_byte = [signature_voucher_bump];
let voucher_seeds = [
    Seed::from(b"signature_voucher" as &[u8]),
    Seed::from(tx_account.address().as_array().as_ref()),
    Seed::from(voucher_bump_byte.as_ref()),
];
if future_sign {
    // A future signature voucher, owned by the proposer. The proposer later
    // sets the key that completes the future sign.
    ctx.issue_future_signature_voucher(
        coordinator, signature_voucher, dwallet, payer, system_program,
        message_hash, [0u8; 32] /* no metadata */, signature_scheme,
        Some(proposer_key) /* owner */,
        Some(user_pubkey) /* signing key */,
        Some(&voucher_seeds),
    )?;
} else {
    ctx.issue_signature_voucher(
        coordinator, signature_voucher, dwallet, payer, system_program,
        message_hash, [0u8; 32] /* no metadata */, signature_scheme,
        None /* owner: this program's CPI authority */,
        Some(user_pubkey) /* signing key */,
        Some(&voucher_seeds),
    )?;
}

// 2. Mark transaction as approved
tx_data[TX_STATUS] = STATUS_APPROVED;
```

`CreateTransaction` takes the `future_sign` flag as one byte after `signature_voucher_bump`. Only 0 and 1 are accepted; any other value fails with `InvalidInstructionData`.

The Anchor variant expresses the same binding as a constraint: `#[account(address = multisig.dwallet)]` on `dwallet`. Its `future_sign` field is a `bool`.

## Source Code

| Framework | Path |
|-----------|------|
| Pinocchio | `examples/multisig/pinocchio/src/lib.rs` |
| Native | `examples/multisig/native/src/lib.rs` |
| Anchor | `examples/multisig/anchor/src/lib.rs` |
