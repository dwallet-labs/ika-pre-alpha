# Testing the Voting Program

> **Pre-Alpha Disclaimer:** This is a pre-alpha release for development and testing only. Signing uses a single mock signer, not real distributed MPC. All 11 protocol operations are implemented (DKG, Sign, Presign, FutureSign, ReEncryptShare, etc.) across all 4 curves and 7 signature schemes, but without real MPC security guarantees. The dWallet keys, trust model, and signing protocol are not final; do not rely on any key material until mainnet. All interfaces, APIs, and data formats are subject to change without notice. The Solana program and all on-chain data will be wiped periodically and everything will be deleted when we transition to Ika Alpha 1. This software is provided "as is" without warranty of any kind; use is entirely at your own risk and dWallet Labs assumes no liability for any damages arising from its use.

## What You'll Learn

- How to write Mollusk instruction-level tests for dWallet programs
- How to build and verify account data at specific byte offsets
- Testing error conditions (double vote, closed proposals)

## Test Matrix

| Test | Instruction | Expected Result |
|------|-------------|-----------------|
| `test_create_proposal_success` | CreateProposal | PDA created with correct fields |
| `test_create_proposal_already_exists` | CreateProposal | Fails (account in use) |
| `test_cast_vote_yes_success` | CastVote (yes) | yes_votes incremented, status=Open |
| `test_cast_vote_no_success` | CastVote (no) | no_votes incremented, status=Open |
| `test_cast_vote_double_vote_fails` | CastVote | Fails (VoteRecord exists) |
| `test_cast_vote_closed_proposal_fails` | CastVote | Fails (status=Approved) |

## Running Tests

```bash
# Pinocchio (requires SBF build first)
cargo build-sbf --manifest-path chains/solana/examples/voting/pinocchio/Cargo.toml
cargo test -p ika-example-voting-pinocchio --test mollusk

# Native
cargo build-sbf --manifest-path chains/solana/examples/voting/native/Cargo.toml
cargo test -p ika-example-voting-native --test mollusk
```

## Key Patterns

### Building Test Account Data

Tests pre-populate account data with exact byte layouts:

```rust
fn build_proposal_data(
    proposal_id: &[u8; 32], dwallet: &Pubkey,
    message_hash: &[u8; 32], authority: &Pubkey,
    yes_votes: u32, no_votes: u32, quorum: u32,
    status: u8, bump: u8,
) -> Vec<u8> {
    let mut data = vec![0u8; PROPOSAL_LEN]; // 195 bytes
    data[0] = PROPOSAL_DISCRIMINATOR;       // 1
    data[1] = 1;                            // version
    data[PROP_PROPOSAL_ID..PROP_PROPOSAL_ID + 32].copy_from_slice(proposal_id);
    // ... set all fields at correct offsets
    data
}
```

### Verifying Results

After processing an instruction, read the resulting account data:

```rust
let result = mollusk.process_instruction(&ix, &accounts);
assert!(result.program_result.is_ok());

let prop_data = &result.resulting_accounts[0].1.data;
assert_eq!(read_u32(prop_data, PROP_YES_VOTES), 1);
assert_eq!(prop_data[PROP_STATUS], STATUS_OPEN);
```

### Testing Double Vote Prevention

The VoteRecord PDA prevents double voting. If the PDA already exists, `CreateAccount` fails:

```rust
// Pre-populate VoteRecord (voter already voted)
let existing_vr = build_vote_record_data(&voter, &proposal_id, 1, vr_bump);

let result = mollusk.process_instruction(&ix, &[
    (proposal_pda, program_account(&program_id, proposal_data)),
    (vote_record_pda, program_account(&program_id, existing_vr)), // exists!
    // ...
]);
assert!(result.program_result.is_err());
```

## Source

- Pinocchio tests: `chains/solana/examples/voting/pinocchio/tests/mollusk.rs`
- Native tests: `chains/solana/examples/voting/native/tests/mollusk.rs`
