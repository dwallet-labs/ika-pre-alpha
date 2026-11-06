# The CPI Framework

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

A Solana program controls a dWallet by being its owner. It then calls the ika program through a
cross-program invocation (CPI) to issue vouchers and to move the dWallet. Three crates build these
calls, one for each common way to write a program:

| Crate | Framework | Account type it takes |
|---|---|---|
| `ika-dwallet-pinocchio` | Pinocchio | `&AccountView` |
| `ika-dwallet-native` | `solana-program` | `&AccountInfo<'info>` |
| `ika-dwallet-anchor` | Anchor | `AccountInfo<'info>` |

The three send the same instruction bytes and the same accounts. Only the account types differ.
The pages for each framework show the dependencies and a full example:
[Pinocchio](../frameworks/pinocchio.md), [Native](../frameworks/native.md),
[Anchor](../frameworks/anchor.md).

## The CPI authority

The ika program cannot see which program called it. It sees only which accounts signed. So each
program has one address that it alone can sign for: its CPI authority. It is the PDA of the seed
`__ika_cpi_authority` under the program's id.

```rust
use ika_dwallet_pinocchio::CPI_AUTHORITY_SEED; // b"__ika_cpi_authority"

let (cpi_authority, bump) =
    pinocchio::Address::find_program_address(&[CPI_AUTHORITY_SEED], program_id);
```

A dWallet whose owner is this address belongs to the program. When the program calls the ika
program, it signs for its CPI authority with `invoke_signed`. The ika program then checks three
things:

1. The calling program's account is executable.
2. The CPI authority is the PDA of `__ika_cpi_authority` under that program, and it signed.
3. The CPI authority equals the dWallet's owner. For a voucher control, it must equal the
   voucher's owner instead.

That is all the ika program checks. Your program has one CPI authority for every dWallet it
holds. So the ika program cannot tell which of your users, proposals or vaults a call is for.
Your program must make that check itself. See [Integrator Invariants](./integrator-invariants.md).

## DWalletContext

Each crate provides a `DWalletContext`. It holds the four values every call needs:

```rust
use ika_dwallet_pinocchio::DWalletContext;

let ctx = DWalletContext {
    dwallet_program,       // the ika program's account
    cpi_authority,         // your program's CPI authority account
    caller_program,        // your program's own account. It must be executable
    cpi_authority_bump,    // the CPI authority's bump
};
```

Pass a bump that is wrong and the signature for the CPI authority fails, so the call fails.

## The context calls only the real ika program

Each crate exports `ID`, the address of the ika program on the network the crate was built for.
Every call of `DWalletContext` first compares `dwallet_program` with `ID`. Any other account is
refused with `ProgramError::IncorrectProgramId`, and nothing is called.

The check exists because of how Solana passes signatures on. Every call the context makes is
signed by your program's CPI authority. A program that receives a signed account can pass that
signature on in the calls it makes in turn. So suppose a caller passes a program of its own as
`dwallet_program`, and the context called it. That fake program would receive your CPI authority's
signature. It could then call the real ika program with it, and issue a voucher for any dWallet
your program holds, or give one away. Refusing every program but `ID` means your CPI authority's
signature only ever reaches the real ika program.

`ID` comes from a network feature of the crate: `devnet-pre-alpha` for the devnet pre-alpha,
and none for the test suites, which load the ika program at a
fixed development address. Build your program with the feature of the network you deploy it to.
A program built for one network calls only that network's ika program, so it refuses the dWallets
of every other. See [Pinocchio](../frameworks/pinocchio.md#build-for-one-network) for the build
lines.

## The calls

| Method | Instruction | What it does |
|---|---|---|
| `issue_signature_voucher` | 156 | Creates a voucher for one signature |
| `issue_future_signature_voucher` | 161 | Creates a voucher for one future sign |
| `set_voucher_signing_key` | 157 | Sets the key a sign request must be signed by |
| `revoke_signature_voucher` | 158 | Revokes a voucher |
| `transfer_signature_voucher` | 159 | Gives a voucher to a new owner |
| `transfer_dwallet` | 129 | Gives the dWallet to a new owner |

The three voucher controls act on either kind of voucher.

### issue_signature_voucher

```rust
ctx.issue_signature_voucher(
    coordinator,              // the DWalletCoordinator, read only
    signature_voucher,        // the new voucher's address: writable, empty, a signer
    dwallet,                  // the dWallet, read only
    payer,                    // writable signer, pays the voucher's rent
    system_program,
    message_digest,           // [u8; 32]: the Keccak-256 of the message
    message_metadata_digest,  // [u8; 32]: zeros for no metadata
    signature_scheme,         // u16: the scheme number
    owner,                    // Option<[u8; 32]>: None makes your CPI authority the owner
    signing_key,              // Option<[u8; 32]>: the key a sign request must be signed by
    voucher_seeds,            // Option<&[Seed]>: the voucher PDA's seeds, bump included
)?;
```

The voucher's address must sign its own creation. There are two ways:

- Pass your program's PDA as the voucher, and its seeds as `voucher_seeds`. The helper signs for
  it with `invoke_signed`.
- Pass `None` for `voucher_seeds`. The outer transaction must then carry the signature of a new
  keypair at the voucher's address.

Prefer a PDA derived from your own record. A voucher at a keypair's address can be put anywhere
the transaction's sender likes, so your program cannot know where it went.

The accounts the CPI sends:

| # | Account | Writable | Signer |
|---|---|---|---|
| 0 | coordinator | no | no |
| 1 | signature_voucher | yes | yes |
| 2 | dwallet | no | no |
| 3 | caller_program | no | no |
| 4 | cpi_authority | no | yes |
| 5 | payer | yes | yes |
| 6 | system_program | no | no |

Your instruction must receive all of these accounts, and the ika program's account too, so it can
pass them on.

### issue_future_signature_voucher

The same arguments and accounts as `issue_signature_voucher`. The signing key is the key step 1
must be signed by. See [Future Signature Vouchers](./future-signature-voucher.md).

### The voucher controls

```rust
ctx.set_voucher_signing_key(signature_voucher, new_signing_key)?;  // [u8; 32]
ctx.revoke_signature_voucher(signature_voucher)?;
ctx.transfer_signature_voucher(signature_voucher, new_owner)?;    // [u8; 32]
```

Each sends three accounts: the voucher (writable), the calling program, and the CPI authority
(signer). The voucher's owner must be your CPI authority.

### transfer_dwallet

```rust
ctx.transfer_dwallet(dwallet, new_owner)?;
```

It sends three accounts: the calling program, the CPI authority (signer), and the dWallet
(writable). The dWallet must be Active. In `ika-dwallet-pinocchio` the new owner is a
`[u8; 32]`. In the native and Anchor crates it is a `&Pubkey`.

## When a call fails

A failed CPI fails the whole transaction, with the ika program's error code. The codes a program
meets most:

| Code | Cause |
|---|---|
| `IncorrectProgramId` | `dwallet_program` is not the ika program the crate was built for. Refused before any call |
| 4005 | The dWallet is not Active |
| 4030 | The coordinator is paused |
| `MissingRequiredSignature` | The CPI authority is not the dWallet's or the voucher's owner |
| `AccountAlreadyInitialized` | The voucher address already holds an account |
| 4059 | The voucher is not pending any more |

All codes are in the [Error Reference](../reference/errors.md).
