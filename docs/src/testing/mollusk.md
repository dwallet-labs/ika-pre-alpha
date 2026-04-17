# Mollusk Tests

> **Pre-Alpha Disclaimer:** This is a pre-alpha release for development and testing only. Signing uses a single mock signer, not real distributed MPC. All 11 protocol operations are implemented (DKG, Sign, Presign, FutureSign, ReEncryptShare, etc.) across all 4 curves and 7 signature schemes, but without real MPC security guarantees. The dWallet keys, trust model, and signing protocol are not final; do not rely on any key material until mainnet. All interfaces, APIs, and data formats are subject to change without notice. The Solana program and all on-chain data will be wiped periodically and everything will be deleted when we transition to Ika Alpha 1. This software is provided "as is" without warranty of any kind; use is entirely at your own risk and dWallet Labs assumes no liability for any damages arising from its use.

## Overview

Mollusk is the fastest way to test individual instructions in isolation. It runs a single instruction against pre-built account state -- no validator, no network, no startup cost.

Mollusk is best for:
- Verifying instruction data parsing
- Checking signer and account validation
- Testing discriminator handling
- Validating PDA creation and field writes
- Testing error conditions (double votes, closed proposals, missing signers)

Mollusk **cannot** test CPI calls (e.g., quorum triggering `approve_message`), because it runs a single program in isolation.

## Setup

```toml
[dev-dependencies]
mollusk-svm = "0.2"
solana-account = "2"
solana-instruction = "2"
solana-pubkey = "2"
```

```rust
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;

const PROGRAM_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/deploy/ika_example_voting"
);

fn setup() -> (Mollusk, Pubkey) {
    let program_id = Pubkey::new_unique();
    let mollusk = Mollusk::new(&program_id, PROGRAM_PATH);
    (mollusk, program_id)
}
```

## Account Helpers

Pre-build account state for test inputs:

```rust
fn funded_account() -> Account {
    Account {
        lamports: 10_000_000_000,
        data: vec![],
        owner: SYSTEM_PROGRAM_ID,
        executable: false,
        rent_epoch: 0,
    }
}

fn program_account(owner: &Pubkey, data: Vec<u8>) -> Account {
    Account {
        lamports: ((data.len() as u64 + 128) * 6960).max(1),
        data,
        owner: *owner,
        executable: false,
        rent_epoch: 0,
    }
}

fn empty_account() -> Account {
    Account {
        lamports: 0,
        data: vec![],
        owner: SYSTEM_PROGRAM_ID,
        executable: false,
        rent_epoch: 0,
    }
}
```

## Writing a Test

### 1. Build the Instruction

```rust
fn build_create_proposal_ix(
    program_id: &Pubkey,
    proposal: &Pubkey,
    dwallet: &Pubkey,
    creator: &Pubkey,
    payer: &Pubkey,
    proposal_id: [u8; 32],
    message_hash: [u8; 32],
    quorum: u32,
    bump: u8,
) -> Instruction {
    let mut ix_data = Vec::with_capacity(104);
    ix_data.push(0); // discriminator
    ix_data.extend_from_slice(&proposal_id);
    ix_data.extend_from_slice(&message_hash);
    ix_data.extend_from_slice(&[0u8; 32]); // user_pubkey
    ix_data.push(0); // signature_scheme
    ix_data.extend_from_slice(&quorum.to_le_bytes());
    ix_data.push(0); // message_approval_bump
    ix_data.push(bump);

    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*proposal, false),
            AccountMeta::new_readonly(*dwallet, false),
            AccountMeta::new_readonly(*creator, true),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        ],
        data: ix_data,
    }
}
```

### 2. Process and Assert

```rust
#[test]
fn test_create_proposal_success() {
    let (mollusk, program_id) = setup();
    let creator = Pubkey::new_unique();
    let payer = Pubkey::new_unique();
    let proposal_id = [0x01u8; 32];

    let (proposal_pda, bump) =
        Pubkey::find_program_address(&[b"proposal", &proposal_id], &program_id);

    let ix = build_create_proposal_ix(
        &program_id, &proposal_pda, &Pubkey::new_unique(),
        &creator, &payer, proposal_id, [0x42u8; 32], 3, bump,
    );

    let result = mollusk.process_instruction(
        &ix,
        &[
            (proposal_pda, empty_account()),
            (Pubkey::new_unique(), funded_account()),
            (creator, funded_account()),
            (payer, funded_account()),
            (SYSTEM_PROGRAM_ID, system_program_account()),
        ],
    );

    assert!(result.program_result.is_ok());

    let prop_data = &result.resulting_accounts[0].1.data;
    assert_eq!(prop_data[0], 1); // discriminator
    assert_eq!(prop_data[1], 1); // version
}
```

## Test Patterns

### Verify Error Conditions

```rust
#[test]
fn test_double_vote_fails() {
    let (mollusk, program_id) = setup();
    // Pre-populate VoteRecord (voter already voted)
    let existing_vr = build_vote_record_data(&voter, &proposal_id, 1, vr_bump);

    let result = mollusk.process_instruction(
        &ix,
        &[
            (proposal_pda, program_account(&program_id, proposal_data)),
            (vote_record_pda, program_account(&program_id, existing_vr)),
            // ...
        ],
    );

    assert!(result.program_result.is_err());
}
```

### Verify Field Values

```rust
let prop_data = &result.resulting_accounts[0].1.data;
assert_eq!(read_u32(prop_data, 163), 1, "yes_votes = 1");
assert_eq!(read_u32(prop_data, 167), 0, "no_votes = 0");
assert_eq!(prop_data[175], 0, "status = Open");
```

## Running Mollusk Tests

```bash
cargo test -p ika-example-voting
```

Tests run in milliseconds -- no validator startup required.
