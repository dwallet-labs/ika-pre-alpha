# Testing the Multisig Program

> **Pre-Alpha Disclaimer:** This is a pre-alpha release for development and testing only. Signing uses a single mock signer, not real distributed MPC. All 11 protocol operations are implemented (DKG, Sign, Presign, FutureSign, ReEncryptShare, etc.) across all 4 curves and 7 signature schemes, but without real MPC security guarantees. The dWallet keys, trust model, and signing protocol are not final; do not rely on any key material until mainnet. All interfaces, APIs, and data formats are subject to change without notice. The Solana program and all on-chain data will be wiped periodically and everything will be deleted when we transition to Ika Alpha 1. This software is provided "as is" without warranty of any kind; use is entirely at your own risk and dWallet Labs assumes no liability for any damages arising from its use.

## Test Matrix

| Test | Instruction | Expected Result |
|------|-------------|-----------------|
| `test_create_multisig_success` | CreateMultisig | 2-of-3 with correct fields |
| `test_create_multisig_zero_threshold_fails` | CreateMultisig | Rejects threshold=0 |
| `test_create_multisig_threshold_exceeds_members_fails` | CreateMultisig | Rejects threshold > members |
| `test_create_transaction_success` | CreateTransaction | Message data stored, tx_index incremented |
| `test_create_transaction_non_member_fails` | CreateTransaction | Non-member cannot propose |
| `test_approve_success` | Approve | approval_count incremented, still Active |
| `test_approve_double_vote_fails` | Approve | ApprovalRecord already exists |
| `test_approve_non_member_fails` | Approve | Non-member cannot approve |
| `test_reject_success` | Reject | rejection_count incremented, still Active |
| `test_reject_threshold_marks_rejected` | Reject | 2nd rejection → status=Rejected |
| `test_vote_on_closed_transaction_fails` | Approve | Cannot vote on Approved transaction |

All 11 tests pass for both Pinocchio and Native variants.

## Running Tests

```bash
# Pinocchio
cargo build-sbf --manifest-path chains/solana/examples/multisig/pinocchio/Cargo.toml
cargo test -p ika-example-multisig --test mollusk

# Native
cargo build-sbf --manifest-path chains/solana/examples/multisig/native/Cargo.toml
cargo test -p ika-example-multisig-native --test mollusk
```

## Source

- Pinocchio: `chains/solana/examples/multisig/pinocchio/tests/mollusk.rs`
- Native: `chains/solana/examples/multisig/native/tests/mollusk.rs`
