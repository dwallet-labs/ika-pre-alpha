# Native

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

`ika-dwallet-native` lets a program written with plain `solana-program`, with no framework, call
the ika program.

## Dependencies

```toml
[dependencies]
ika-dwallet-native = { git = "https://github.com/dwallet-labs/ika-pre-alpha" }
solana-program = "2.2"

[lib]
crate-type = ["cdylib", "lib"]
```

## Build for one network

The crate names one ika program, the one deployed on the network you build for. It exports that
program's address as `ID`. Pick the network with a feature of the crate:

| Feature | Network |
|---|---|
| `devnet-pre-alpha` | the Solana devnet pre-alpha, ika program `CqGtQgrYFUhobuknomFNntwoxCgKGkBRUtemgdPuM9qT` |
| none | the test suites only, which load the ika program at a fixed development address |

Other network features exist for networks not deployed yet. Only one feature can be on.

Forward the features from your own crate, as the examples do, so that tests build without one:

```toml
[features]
devnet-pre-alpha = ["ika-dwallet-native/devnet-pre-alpha"]
```

Then build with the network's feature:

```bash
cargo build-sbf --tools-version v1.54 --arch v3 -- --features devnet-pre-alpha
```

A program built for one network refuses the dWallets of every other, because it calls only that
network's ika program. If a pre-alpha wipe moves the ika program to a new address, update the
crate, rebuild with the feature, and redeploy or upgrade your program.

## The context

```rust
use ika_dwallet_native::{CPI_AUTHORITY_SEED, DWalletContext, ID as IKA_PROGRAM_ID};

let ctx = DWalletContext {
    dwallet_program,     // &AccountInfo: the ika program
    cpi_authority,       // &AccountInfo: your program's CPI authority
    caller_program,      // &AccountInfo: your program's own account
    cpi_authority_bump,  // u8
};
```

Your program's CPI authority is `Pubkey::find_program_address(&[CPI_AUTHORITY_SEED], program_id)`.
`IKA_PROGRAM_ID` is a `Pubkey`. Every call refuses a `dwallet_program` at any other address with
`IncorrectProgramId`.

## The calls

The methods and their order of arguments are those of the
[Pinocchio crate](./pinocchio.md#the-calls). Two types differ:

- `voucher_seeds` is `Option<&[&[u8]]>`, the seeds as `solana-program` takes them.
- `transfer_dwallet` takes the new owner as `&Pubkey`.

Each call returns `Result<(), ProgramError>`.

## Example

From `examples/voting/native/src/lib.rs`, once the vote reaches the quorum and the
dWallet and voucher accounts are checked:

```rust
let ctx = DWalletContext { dwallet_program, cpi_authority, caller_program, cpi_authority_bump };

let voucher_seeds: &[&[u8]] = &[
    b"signature_voucher",
    proposal_id.as_ref(),
    &[signature_voucher_bump],
];

ctx.issue_signature_voucher(
    coordinator,
    signature_voucher,
    dwallet,
    payer,
    system_program,
    message_digest,
    [0u8; 32],
    signature_scheme,
    None,
    Some(user_pubkey),
    Some(voucher_seeds),
)?;
```

The native example creates its own accounts with `solana_program::system_instruction`, which
`solana-program` marks deprecated in favour of the `solana-system-interface` crate. It still works.
