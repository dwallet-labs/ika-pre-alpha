# Create the Program

> **Pre-Alpha Disclaimer:** This is a pre-alpha release for development and testing only. Signing uses a single mock signer, not real distributed MPC. All 11 protocol operations are implemented (DKG, Sign, Presign, FutureSign, ReEncryptShare, etc.) across all 4 curves and 7 signature schemes, but without real MPC security guarantees. The dWallet keys, trust model, and signing protocol are not final; do not rely on any key material until mainnet. All interfaces, APIs, and data formats are subject to change without notice. The Solana program and all on-chain data will be wiped periodically and everything will be deleted when we transition to Ika Alpha 1. This software is provided "as is" without warranty of any kind; use is entirely at your own risk and dWallet Labs assumes no liability for any damages arising from its use.

## Cargo.toml

```toml
[package]
name = "ika-example-voting"
version = "0.1.0"
edition = "2024"

[dependencies]
ika-dwallet-pinocchio = { git = "https://github.com/dwallet-labs/ika-pre-alpha" }
pinocchio = "0.10"
pinocchio-system = "0.5"

[dev-dependencies]
mollusk-svm = "0.2"
solana-account = "2"
solana-instruction = "2"
solana-pubkey = "2"

[lib]
crate-type = ["cdylib", "lib"]
```

Key crates:
- **`ika-dwallet-pinocchio`** -- `DWalletContext` CPI wrapper and `CPI_AUTHORITY_SEED`
- **`pinocchio`** -- zero-copy Solana program framework
- **`pinocchio-system`** -- `CreateAccount` CPI helper

## lib.rs Skeleton

```rust
#![no_std]
extern crate alloc;

use pinocchio::{
    cpi::Signer,
    entrypoint,
    error::ProgramError,
    AccountView, Address, ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;
use ika_dwallet_pinocchio::DWalletContext;

entrypoint!(process_instruction);
pinocchio::nostd_panic_handler!();

pub const ID: Address = Address::new_from_array([5u8; 32]);
```

## Account Discriminators

```rust
const PROPOSAL_DISCRIMINATOR: u8 = 1;
const VOTE_RECORD_DISCRIMINATOR: u8 = 2;

const STATUS_OPEN: u8 = 0;
const STATUS_APPROVED: u8 = 1;
```

## Proposal Account Layout

The Proposal PDA stores the dWallet reference, message hash, vote counts, and quorum:

```
Proposal PDA (seeds: ["proposal", proposal_id]):
  195 bytes total (2-byte header + 193 bytes data)
```

| Offset | Field | Size | Description |
|--------|-------|------|-------------|
| 0 | discriminator | 1 | `1` |
| 1 | version | 1 | `1` |
| 2 | proposal_id | 32 | Unique proposal identifier |
| 34 | dwallet | 32 | dWallet account pubkey |
| 66 | message_hash | 32 | Hash of the message to sign |
| 98 | user_pubkey | 32 | User public key for signing |
| 130 | signature_scheme | 1 | Ed25519(0), Secp256k1(1), Secp256r1(2) |
| 131 | creator | 32 | Proposal creator pubkey |
| 163 | yes_votes | 4 | Yes vote count (LE u32) |
| 167 | no_votes | 4 | No vote count (LE u32) |
| 171 | quorum | 4 | Required yes votes (LE u32) |
| 175 | status | 1 | Open(0) or Approved(1) |
| 176 | msg_approval_bump | 1 | MessageApproval PDA bump |
| 177 | bump | 1 | Proposal PDA bump |
| 178 | _reserved | 16 | Reserved for future use |

## VoteRecord Account Layout

The VoteRecord PDA prevents double voting. Its existence proves the voter has already voted.

```
VoteRecord PDA (seeds: ["vote", proposal_id, voter]):
  69 bytes total (2-byte header + 67 bytes data)
```

| Offset | Field | Size | Description |
|--------|-------|------|-------------|
| 0 | discriminator | 1 | `2` |
| 1 | version | 1 | `1` |
| 2 | voter | 32 | Voter pubkey |
| 34 | proposal_id | 32 | Associated proposal |
| 66 | vote | 1 | Yes(1) or No(0) |
| 67 | bump | 1 | VoteRecord PDA bump |

## Instruction Dispatch

```rust
pub fn process_instruction(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    let (discriminator, rest) = data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;

    match *discriminator {
        0 => create_proposal(program_id, accounts, rest),
        1 => cast_vote(program_id, accounts, rest),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
```

## Rent Calculation

The dWallet program uses a simple rent formula:

```rust
fn minimum_balance(data_len: usize) -> u64 {
    (data_len as u64 + 128) * 6960
}
```

## Next Step

With the program skeleton in place, the next chapter implements the `create_proposal` instruction and the [message approval flow](./approve-messages.md).
