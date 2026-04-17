# Tutorial: Voting dWallet

> **Pre-Alpha Disclaimer:** This is a pre-alpha release for development and testing only. Signing uses a single mock signer, not real distributed MPC. All 11 protocol operations are implemented (DKG, Sign, Presign, FutureSign, ReEncryptShare, etc.) across all 4 curves and 7 signature schemes, but without real MPC security guarantees. The dWallet keys, trust model, and signing protocol are not final; do not rely on any key material until mainnet. All interfaces, APIs, and data formats are subject to change without notice. The Solana program and all on-chain data will be wiped periodically and everything will be deleted when we transition to Ika Alpha 1. This software is provided "as is" without warranty of any kind; use is entirely at your own risk and dWallet Labs assumes no liability for any damages arising from its use.

This tutorial builds a complete **voting-controlled dWallet** program on Solana. A proposal specifies a message to sign; when enough "yes" votes reach quorum, the program automatically approves the message for signing via CPI.

## What You Will Build

A Solana program with two instructions:

| Instruction | Discriminator | Description |
|-------------|---------------|-------------|
| `create_proposal` | 0 | Creates a proposal PDA with a target dWallet, message hash, and quorum |
| `cast_vote` | 1 | Records a vote; when quorum is reached, CPI-calls `approve_message` |

## How It Works

1. A dWallet is created and its authority transferred to the voting program's CPI authority PDA
2. The creator submits a proposal referencing the dWallet, message hash, and required quorum
3. Voters cast yes/no votes -- each vote creates a `VoteRecord` PDA (prevents double voting)
4. When yes votes reach quorum, the program automatically CPI-calls `approve_message` on the dWallet program
5. The Ika network detects the `MessageApproval` and produces a signature
6. The proposal status changes to `Approved`

## Key Concepts Covered

- **CPI authority pattern** -- transferring dWallet control to a program
- **`DWalletContext`** -- the CPI wrapper for calling dWallet instructions
- **`approve_message`** -- creating a MessageApproval PDA to trigger signing
- **PDA-based vote records** -- preventing double voting via account existence
- **Mollusk tests** -- unit testing individual instructions
- **E2E tests** -- full lifecycle against Solana devnet and the pre-alpha gRPC service

## Source Code

The complete example is at `chains/solana/examples/voting/`.

```
voting/
  src/lib.rs          -- program logic (2 instructions)
  tests/mollusk.rs    -- Mollusk instruction-level tests
  e2e/src/main.rs     -- full E2E demo
  Cargo.toml
```

## Prerequisites

- [Installation](../getting-started/installation.md) complete
- Familiarity with [Core Concepts](../getting-started/concepts.md)
- Basic Solana program development experience
