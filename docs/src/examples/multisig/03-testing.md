# Testing the Multisig Program

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

## Test Matrix (Mollusk)

Every negative test asserts the exact `MultisigError` code.

| Test | Instruction | Expected Result |
|------|-------------|-----------------|
| `test_create_multisig_success` | CreateMultisig | 2-of-3 with correct fields at the canonical PDA |
| `test_create_multisig_rejects_non_owner` | CreateMultisig | `Custom(3)` NotDWalletOwner |
| `test_create_multisig_rejects_dwallet_not_owned_by_dwallet_program` | CreateMultisig | `Custom(4)` InvalidDWalletAccount |
| `test_create_multisig_zero_threshold_fails` | CreateMultisig | `Custom(5)` InvalidThreshold |
| `test_create_multisig_threshold_exceeds_members_fails` | CreateMultisig | `Custom(5)` InvalidThreshold |
| `test_create_multisig_rejects_duplicate_member` | CreateMultisig | `Custom(6)` DuplicateMember |
| `test_create_multisig_rejects_non_canonical_address` | CreateMultisig | `Custom(9)` InvalidMultisig |
| `test_create_transaction_success` | CreateTransaction | Message data stored, tx_index incremented |
| `test_create_transaction_rejects_a_future_sign_flag_other_than_0_or_1` | CreateTransaction | `InvalidInstructionData` |
| `test_create_transaction_non_member_fails` | CreateTransaction | `Custom(0)` NotAMember |
| `test_create_transaction_rejects_forged_multisig_account` | CreateTransaction | `Custom(9)` InvalidMultisig |
| `test_approve_success` | Approve | approval_count incremented, still Active |
| `test_approve_double_vote_fails` | Approve | ApprovalRecord already exists |
| `test_approve_non_member_fails` | Approve | `Custom(0)` NotAMember |
| `test_approve_rejects_transaction_of_another_multisig` | Approve | `Custom(8)` TransactionMismatch |
| `test_approve_at_threshold_rejects_wrong_dwallet` | Approve | `Custom(1)` DWalletMismatch, before any CPI |
| `test_reject_success` | Reject | rejection_count incremented, still Active |
| `test_reject_threshold_marks_rejected` | Reject | 2nd rejection → status=Rejected |
| `test_reject_non_member_fails` | Reject | `Custom(0)` NotAMember |
| `test_vote_on_closed_transaction_fails` | Approve | `Custom(7)` TransactionNotActive |

All 20 tests run for both Pinocchio and Native variants.

## Test Matrix (LiteSVM, real dWallet program)

| Test | Expected Result |
|------|-----------------|
| `test_multisig_full_lifecycle` | multisig → transfer → propose → 2 approvals → SignatureVoucher created |
| `test_multisig_issues_a_future_signature_voucher_owned_by_the_proposer` | a transaction proposed as a future sign gets a `FutureSignatureVoucher` at the voucher PDA; its owner is the proposer and its signing key is the transaction's `user_pubkey` |
| `test_outsider_cannot_approve_or_recreate_multisig` | outsider approval `NotAMember`; multisig (re)creation `NotDWalletOwner` |
| `test_threshold_cannot_be_redirected_to_another_multisigs_dwallet` | attacker's own 1-of-1 multisig reaching threshold with the victim's dWallet as CPI target fails `DWalletMismatch`; no voucher for the victim |
| `test_a_member_cannot_approve_twice_with_a_second_bump` | a second approval with another valid approval-record bump fails `InvalidBump` (12); the count stays 1 |
| `test_a_member_cannot_reject_twice_with_a_second_bump` | the same for a rejection |
| `test_create_transaction_refuses_a_non_canonical_transaction_bump` | a transaction at a non-canonical bump fails `InvalidBump`; nothing is written there |

The three bump tests failed against the program without the canonical-bump check, and pass with it. The Pinocchio and native variants run all seven. The Anchor variant runs the first four: Anchor derives every canonical bump itself.
## Running Tests

```bash
# from the repository root
# SBF builds the tests load (the ika program itself is shipped in bin/)
cargo build-sbf --tools-version v1.54 --arch v3 --manifest-path examples/multisig/pinocchio/Cargo.toml
cargo build-sbf --tools-version v1.54 --arch v3 --manifest-path examples/multisig/native/Cargo.toml
cargo build-sbf --tools-version v1.54 --arch v3 --manifest-path examples/multisig/anchor/Cargo.toml

# Mollusk + LiteSVM
cargo test -p ika-example-multisig
cargo test -p ika-example-multisig-native
cargo test -p ika-example-multisig-anchor
```

## Source

- Pinocchio: `examples/multisig/pinocchio/tests/{mollusk,litesvm}.rs`
- Native: `examples/multisig/native/tests/{mollusk,litesvm}.rs`
- Anchor: `examples/multisig/anchor/tests/litesvm.rs`
