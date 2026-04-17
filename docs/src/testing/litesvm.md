# LiteSVM Tests

> **Pre-Alpha Disclaimer:** This is a pre-alpha release for development and testing only. Signing uses a single mock signer, not real distributed MPC. All 11 protocol operations are implemented (DKG, Sign, Presign, FutureSign, ReEncryptShare, etc.) across all 4 curves and 7 signature schemes, but without real MPC security guarantees. The dWallet keys, trust model, and signing protocol are not final; do not rely on any key material until mainnet. All interfaces, APIs, and data formats are subject to change without notice. The Solana program and all on-chain data will be wiped periodically and everything will be deleted when we transition to Ika Alpha 1. This software is provided "as is" without warranty of any kind; use is entirely at your own risk and dWallet Labs assumes no liability for any damages arising from its use.

## Overview

LiteSVM provides in-process Solana runtime testing. Unlike Mollusk, LiteSVM can:
- Deploy multiple programs
- Test CPI calls (e.g., your program calling the dWallet program)
- Process multiple transactions in sequence
- Simulate the full transaction lifecycle

LiteSVM is ideal for testing the integration between your program and the dWallet program, including the CPI authority pattern and `approve_message` calls.

## Setup

```toml
[dev-dependencies]
litesvm = "0.4"
solana-sdk = "2"
```

## Basic Test Structure

```rust
use litesvm::LiteSVM;
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::Keypair,
    signer::Signer,
    transaction::Transaction,
};

#[test]
fn test_voting_with_cpi() {
    let mut svm = LiteSVM::new();

    // Deploy the dWallet program
    let dwallet_program_id = Pubkey::new_unique();
    svm.deploy_program(
        dwallet_program_id,
        include_bytes!("path/to/ika_dwallet_program.so"),
    );

    // Deploy the voting program
    let voting_program_id = Pubkey::new_unique();
    svm.deploy_program(
        voting_program_id,
        include_bytes!("path/to/ika_example_voting.so"),
    );

    // Fund accounts
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();

    // ... test transactions ...
}
```

## Testing the CPI Path

The key advantage of LiteSVM over Mollusk is testing the quorum -> `approve_message` CPI path:

```rust
// Step 1: Initialize dWallet program state (mock the NOA setup)
// Step 2: Create a dWallet
// Step 3: Transfer authority to voting program CPI PDA
// Step 4: Create a proposal
// Step 5: Cast votes until quorum triggers approve_message CPI

// After the final vote, verify MessageApproval was created
let ma_data = svm.get_account(&message_approval_pda).unwrap().data;
assert_eq!(ma_data[0], 14); // MessageApproval discriminator
assert_eq!(ma_data[139], 0); // status = Pending
```

## When to Use LiteSVM vs Mollusk

| Feature | Mollusk | LiteSVM |
|---------|---------|---------|
| Speed | Fastest | Fast |
| CPI testing | No | Yes |
| Multi-program | No | Yes |
| Account persistence | No | Yes |
| Transaction sequencing | No | Yes |
| Error granularity | Instruction level | Transaction level |

Use **Mollusk** for unit-testing individual instructions. Use **LiteSVM** when you need to test cross-program interactions or multi-step flows.

## Tips

- Pre-populate accounts via `svm.set_account()` to skip setup transactions
- Use `svm.get_account()` to read account data after transactions
- Deploy both the dWallet program and your program to test the full CPI flow
- The CPI authority PDA derivation must use `b"__ika_cpi_authority"` as the seed
