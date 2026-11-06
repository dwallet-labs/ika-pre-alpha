# A Solana program that controls dWallets

A program controls a dWallet when the dWallet's owner is the program's CPI authority. The program
then decides which messages the dWallet signs, by issuing signature vouchers through a CPI to the
ika program. The app sends the sign request, naming the voucher.

## Dependencies

```toml
[dependencies]
# Pick one framework.
ika-dwallet-pinocchio = { git = "https://github.com/dwallet-labs/ika-pre-alpha" }
pinocchio = { version = "0.11", features = ["cpi"] }
pinocchio-system = "0.6"
# ika-dwallet-anchor = { git = "https://github.com/dwallet-labs/ika-pre-alpha" }
# anchor-lang = "1.2"
# ika-dwallet-native = { git = "https://github.com/dwallet-labs/ika-pre-alpha" }
# solana-program = "2.2"

[features]
devnet-pre-alpha = ["ika-dwallet-pinocchio/devnet-pre-alpha"]

[lib]
crate-type = ["cdylib", "lib"]
```

## Build for one network

Each CPI crate exports `ID`, the ika program's address on the network it was built for.

| Feature | Network |
| --- | --- |
| `devnet-pre-alpha` | the Solana devnet pre-alpha, ika program `CqGtQgrYFUhobuknomFNntwoxCgKGkBRUtemgdPuM9qT` |
| none | the test suites only, which load the ika program at a fixed development address |

```bash
cargo build-sbf --tools-version v1.54 --arch v3 -- --features devnet-pre-alpha
```

Build for SBPF v3: Solana refuses to deploy a program built for an earlier version. A program built
for one network refuses the dWallets of every other. After a wipe that moves the ika program,
update the crate, rebuild with the feature, and upgrade the program.

## The CPI authority

The CPI authority is the PDA of the seed `__ika_cpi_authority` under your program's id. The ika
program cannot see which program called it, only which accounts signed. When your program calls it,
your program signs for its CPI authority with `invoke_signed`. The ika program checks that:

1. the calling program's account is executable;
2. the CPI authority is the PDA of `__ika_cpi_authority` under that program, and it signed;
3. the CPI authority equals the dWallet's owner, or for a voucher control, the voucher's owner.

That is all it checks. Your program has one CPI authority for every dWallet it holds, so it must
decide itself which dWallet a call is for.

## DWalletContext

```rust
use ika_dwallet_pinocchio::{DWalletContext, ID as IKA_PROGRAM_ID};

let ctx = DWalletContext {
    dwallet_program,       // the ika program's account: must be IKA_PROGRAM_ID
    cpi_authority,         // your program's CPI authority account
    caller_program,        // your program's own account; executable
    cpi_authority_bump,
};
```

Every call first compares `dwallet_program` with `ID`, and refuses any other with
`ProgramError::IncorrectProgramId`. Without that check, a caller could pass a fake ika program. The
fake would receive your CPI authority's signature and could pass it on to the real ika program, to
get a voucher on any dWallet your program holds.

| Method | Instruction | What it does |
| --- | --- | --- |
| `issue_signature_voucher` | 156 | Creates a voucher for one signature |
| `issue_future_signature_voucher` | 161 | Creates a voucher for one future sign |
| `set_voucher_signing_key` | 157 | Sets the key a sign request must be signed by |
| `revoke_signature_voucher` | 158 | Revokes a voucher |
| `transfer_signature_voucher` | 159 | Gives a voucher to a new owner |
| `transfer_dwallet` | 129 | Gives the dWallet to a new owner; it must be Active |

```rust
ctx.issue_signature_voucher(
    coordinator,              // the DWalletCoordinator, read only
    signature_voucher,        // the new voucher's address: writable, empty, a signer
    dwallet,                  // the dWallet, read only
    payer,                    // writable signer, pays the voucher's rent
    system_program,
    message_digest,           // [u8; 32]: the Keccak-256 of the message
    message_metadata_digest,  // [u8; 32]: zeros for no metadata
    signature_scheme,         // u16: 0 EcdsaKeccak256, 1 EcdsaSha256, 2 EcdsaDoubleSha256,
                              // 3 TaprootSha256, 4 EcdsaBlake2b256, 5 EddsaSha512, 6 SchnorrkelMerlin
    owner,                    // Option<[u8; 32]>: None makes your CPI authority the owner
    signing_key,              // Option<[u8; 32]>: the user's request key, which sends the sign
    voucher_seeds,            // Option<&[Seed]>: the voucher PDA's seeds, bump included
)?;
```

Prefer a voucher at your program's own PDA, derived from your record, with its seeds passed. A
voucher at a keypair's address can be put anywhere the transaction's sender likes.

The instruction must receive every account the CPI sends, and the ika program's account:
coordinator, signature voucher, dWallet, your program, the CPI authority, the payer, the system
program.

## The rules a program must follow

The main rules are below. The full list of fourteen is the "Integrator Invariants" page of the book
in `docs/src/on-chain/integrator-invariants.md`.

1. **Bind every voucher to the dWallet it was approved for.** Store the dWallet in the approval
   record, and refuse any other dWallet account before the CPI.
2. **Let the dWallet's owner set the rules, once, before the transfer.** Derive the rules' account
   from the dWallet's address. Check the dWallet account's owner against `ID`, never against a
   program account the caller passed, and check that its stored owner signed.
3. **Close the set of actors.** The quorum comes from the rules, and duplicate members are refused.
4. **Bind every account the CPI touches**, such as the voucher address your record names.
5. **Check your own accounts by address**, not only by their tag.
6. **Use the canonical bump** for every account whose existence means "done once", such as a vote
   record. Derive it with `find_program_address` and refuse any other: a second valid bump gives a
   second address, and a second vote. Anchor's `seeds` with `bump` does this.
7. **Read the ika program's accounts at the current offsets**: a voucher's `status` is at 173, a
   dWallet's `curve` is a u16 at 34.
8. **Pass the coordinator, and the scheme the sign request will use.**
9. **Issue each voucher once**, at an address your program can find again.
10. **Give every check its own error code, and test it.**
11. **Plan how a dWallet leaves your program**, under the same rules.

## The order a client follows

1. Create the dWallet with the SDK. The creator's wallet owns it.
2. Create your program's rules account for it, signed by that wallet, before the transfer.
3. Transfer the dWallet to your program's CPI authority (`IkaTransaction.transferDWallet`).
4. Your program issues the voucher when its rules allow, naming the user's request key as the
   signing key.
5. Wait until the voucher's transaction is finalized, then sign with the SDK, naming the voucher:
   `ikaClient.requestSign({ signatureVoucherId, ... })`.

## Testing

- **Mollusk** runs one instruction at a time. Hand-build the dWallet account, owned by
  `ika_dwallet_pinocchio::ID`.
- **LiteSVM** loads the real ika program, at the development address. Build your program with no
  network feature for these tests, so its `ID` matches.
- **End to end**, deploy to devnet with `--features devnet-pre-alpha` and run a client in mock mode
  against the pre-alpha.

The examples in `examples/voting` and `examples/multisig` follow every
rule above, in Pinocchio, native and Anchor, with tests for each check.
