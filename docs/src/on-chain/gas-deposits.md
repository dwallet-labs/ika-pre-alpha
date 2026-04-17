# Gas Deposits

> **Pre-Alpha Disclaimer:** This is a pre-alpha release for development and testing only. Signing uses a single mock signer, not real distributed MPC. All 11 protocol operations are implemented (DKG, Sign, Presign, FutureSign, ReEncryptShare, etc.) across all 4 curves and 7 signature schemes, but without real MPC security guarantees. The dWallet keys, trust model, and signing protocol are not final; do not rely on any key material until mainnet. All interfaces, APIs, and data formats are subject to change without notice. The Solana program and all on-chain data will be wiped periodically and everything will be deleted when we transition to Ika Alpha 1. This software is provided "as is" without warranty of any kind; use is entirely at your own risk and dWallet Labs assumes no liability for any damages arising from its use.

## GasDeposit Account

Every user has a `GasDeposit` PDA that holds IKA balance (for dWallet operation fees) and SOL balance (for NOA write-back transaction costs).

```
GasDeposit PDA:
  Seeds: ["gas_deposit", user_pubkey]
  Program: DWALLET_PROGRAM_ID
  Total: 139 bytes (2 header + 137 data)
  Discriminator: 4
```

| Offset | Field | Size | Description |
|--------|-------|------|-------------|
| 0 | discriminator | 1 | `4` |
| 1 | version | 1 | `1` |
| 2 | user_pubkey | 32 | Ed25519 public key for gRPC authentication |
| 34 | ika_balance | 8 | Available IKA balance (LE u64) |
| 42 | sol_balance | 8 | Available SOL balance in lamports (LE u64) |
| 50 | total_ika_deposited | 8 | Lifetime IKA deposited (LE u64) |
| 58 | total_ika_consumed | 8 | Lifetime IKA consumed (LE u64) |
| 66 | total_sol_deposited | 8 | Lifetime SOL deposited (LE u64) |
| 74 | total_sol_consumed | 8 | Lifetime SOL consumed (LE u64) |
| 82 | pending_ika_withdrawal | 8 | Pending IKA withdrawal amount (LE u64) |
| 90 | pending_sol_withdrawal | 8 | Pending SOL withdrawal amount (LE u64) |
| 98 | withdrawal_epoch | 8 | Epoch when pending withdrawal becomes available (LE u64, 0=none) |
| 106 | last_settlement_epoch | 8 | Epoch of last gas settlement (LE u64) |
| 114 | created_at_epoch | 8 | Epoch when deposit was created (LE u64) |
| 122 | bump | 1 | PDA bump seed |
| 123 | _reserved | 16 | Reserved for future use |

## Gas Deposit Instructions

| Instruction | Discriminator | Description |
|-------------|---------------|-------------|
| `CreateDeposit` | 36 | Create a new GasDeposit PDA for a user |
| `TopUp` | 37 | Add IKA or SOL to an existing deposit |
| `SettleGas` | 38 | NOA settles consumed gas (periodic) |
| `RequestWithdraw` | 44 | Request withdrawal (sets pending amount + epoch) |
| `Withdraw` | 45 | Complete withdrawal after epoch delay |

## Rent Costs by Account Type

The dWallet program uses a simplified rent formula:

```rust
fn minimum_balance(data_len: usize) -> u64 {
    (data_len as u64 + 128) * 6960
}
```

This approximation of the Solana rent-exempt minimum is used for all PDA creation.

| Account | Size (bytes) | Approximate Rent (lamports) |
|---------|-------------|----------------------------|
| DWallet | 153 | ~1,955,280 |
| DWalletAttestation | 67 + data | varies |
| MessageApproval | 312 | ~3,062,400 |
| PartialUserSignature | 570 | ~4,858,080 |
| EncryptedUserSecretKeyShare | 148 | ~1,920,480 |
| GasDeposit | 139 | ~1,858,320 |
| DWalletCoordinator | 116 | ~1,698,240 |
| Proposal (voting example) | 195 | ~2,248,080 |
| VoteRecord (voting example) | 69 | ~1,371,480 |

## Payer Account

Every instruction that creates a PDA requires a `payer` account:
- Must be writable and signer
- Must have sufficient lamports to cover rent
- Is debited via `CreateAccount` system instruction

## Future: Production Gas Model

In production, the Ika network will have a gas model for signing operations. This may include:
- Presign allocation fees
- Signing operation fees
- Staking requirements for validators

The exact model is not finalized.
