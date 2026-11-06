# Pinocchio

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

`ika-dwallet-pinocchio` lets a [Pinocchio](https://github.com/anza-xyz/pinocchio) program call
the ika program. Pinocchio programs are `no_std` and copy nothing they do not need to, so they
cost the fewest compute units. The ika program itself is written in Pinocchio.

## Dependencies

```toml
[dependencies]
ika-dwallet-pinocchio = { git = "https://github.com/dwallet-labs/ika-pre-alpha" }
pinocchio = { version = "0.11", features = ["cpi"] }
pinocchio-system = "0.6"

[lib]
crate-type = ["cdylib", "lib"]
```

`pinocchio-system` creates your program's own accounts. A program that derives PDAs in host
tests also needs `solana-address` with its `curve25519` feature, as the examples do.

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
devnet-pre-alpha = ["ika-dwallet-pinocchio/devnet-pre-alpha"]
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
use ika_dwallet_pinocchio::{CPI_AUTHORITY_SEED, DWalletContext, ID as IKA_PROGRAM_ID};

let ctx = DWalletContext {
    dwallet_program,     // &AccountView: the ika program
    cpi_authority,       // &AccountView: your program's CPI authority
    caller_program,      // &AccountView: your program's own account
    cpi_authority_bump,  // u8
};
```

Your program's CPI authority is `Address::find_program_address(&[CPI_AUTHORITY_SEED], program_id)`.
A client can compute the bump and pass it in your instruction's data. A wrong bump makes the CPI
fail, so a caller cannot misuse it.

`dwallet_program` must be the account at `IKA_PROGRAM_ID`. Every call refuses any other account
with `IncorrectProgramId`, before it calls anything. [The CPI Framework](../on-chain/cpi-framework.md#the-context-calls-only-the-real-ika-program)
explains why.

## The calls

| Method | Arguments after the context |
|---|---|
| `issue_signature_voucher` | `coordinator, signature_voucher, dwallet, payer, system_program, message_digest, message_metadata_digest, signature_scheme, owner, signing_key, voucher_seeds` |
| `issue_future_signature_voucher` | the same |
| `set_voucher_signing_key` | `signature_voucher, signing_key: [u8; 32]` |
| `revoke_signature_voucher` | `signature_voucher` |
| `transfer_signature_voucher` | `signature_voucher, new_owner: [u8; 32]` |
| `transfer_dwallet` | `dwallet, new_owner: [u8; 32]` |

`owner` and `signing_key` are `Option<[u8; 32]>`. `voucher_seeds` is `Option<&[Seed]>`: the
seeds of the voucher's PDA, bump included, or `None` when a keypair at the voucher's address signs
the transaction. Each call returns a `ProgramResult`. See [The CPI Framework](../on-chain/cpi-framework.md)
for what each call checks and sends.

## Example: issue a voucher when a proposal passes

This is the core of `examples/voting/pinocchio/src/lib.rs`. When the yes votes reach
the quorum, the program checks the accounts the client passed, and issues a voucher at its own PDA
`["signature_voucher", proposal_id]`:

```rust
if yes_votes >= quorum {
    let [coordinator, signature_voucher, dwallet, caller_program, cpi_authority, dwallet_program, ..] =
        &*tail
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // The dWallet must be the proposal's own, not one the caller chose.
    if dwallet.address().as_array() != &proposal_dwallet {
        return Err(VotingError::DWalletMismatch.into());
    }
    // The voucher must be this program's PDA for the proposal.
    let expected_voucher = Address::create_program_address(
        &[b"signature_voucher", proposal_id.as_ref(), &[signature_voucher_bump]],
        program_id,
    )
    .map_err(|_| VotingError::VoucherMismatch)?;
    if signature_voucher.address() != &expected_voucher {
        return Err(VotingError::VoucherMismatch.into());
    }

    let ctx = DWalletContext { dwallet_program, cpi_authority, caller_program, cpi_authority_bump };
    let voucher_bump_byte = [signature_voucher_bump];
    let voucher_seeds = [
        Seed::from(b"signature_voucher" as &[u8]),
        Seed::from(proposal_id.as_ref()),
        Seed::from(voucher_bump_byte.as_ref()),
    ];
    ctx.issue_signature_voucher(
        coordinator,
        signature_voucher,
        dwallet,
        payer,
        system_program,
        message_digest,
        [0u8; 32],         // no metadata
        signature_scheme,
        None,              // owner: this program's CPI authority
        Some(user_pubkey), // the key the sign request must be signed by
        Some(&voucher_seeds),
    )?;
}
```

The whole program, with its council and its tests, is walked through in the
[voting tutorial](../tutorial/overview.md).

## Choosing a framework

| | Pinocchio | Native | Anchor |
|---|---|---|---|
| Compute cost | lowest | middle | highest |
| Program size | smallest | middle | largest |
| `no_std` | yes | no | no |
| Account checks | by hand | by hand | declared on the accounts struct |

All three call the same ika instructions, so the choice does not change what the network sees.
