# LiteSVM Tests

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

[LiteSVM](https://github.com/LiteSVM/litesvm) runs a Solana runtime inside your test. It loads
several programs and runs whole transactions, so your program's CPI into the real ika program
runs as it does on chain. Use it to test the path that ends in `issue_signature_voucher`.

LiteSVM runs no ika network. Nothing signs a voucher in a LiteSVM test. You check that the
voucher was created with the right fields, and stop there. The full path with a signature is an
[end-to-end test](./e2e.md).

## What a test needs

1. **The compiled ika program.** This repository ships it in `bin/`, with a build for the fixed
   development address the tests use. A program binary works only at the address it was built for,
   because it derives its own accounts' addresses from that id. So load it at that id.

2. **The ika program's state.** No network runs in the test to create the coordinator, a network
   key or a dWallet. Write them into the runtime directly with `set_account`: a
   `DWalletCoordinator` that is not paused, an active `NetworkEncryptionKey`, and an Active
   `DWallet` owned by a key of the test.

3. **Your program**, built with no network feature, and loaded at an id of your choosing. With no
   feature, the CPI crate's `ID` is the same development address the ika program is loaded at, so
   your program's calls reach it. A program built with `devnet-pre-alpha` refuses that address with
   `IncorrectProgramId`.

## The harness in this repository

`crates/ika-dwallet-litesvm-test` (crate `ika-dwallet-litesvm-test`) does steps 1 and 2. It loads
the compiled ika program from `bin/`. Its `DWalletTestContext` loads the ika program, funds a payer, and writes an unpaused coordinator and
an active network key:

```rust
use ika_dwallet_litesvm_test::*;

let mut ctx = DWalletTestContext::new();
let my_program = ctx.deploy_program(MY_PROGRAM_SO);
let (cpi_authority, cpi_authority_bump) = ctx.cpi_authority_for(&my_program);

// An Active dWallet, owned by a test key.
let user = ctx.new_funded_keypair();
let public_key = [7u8; 32];
let dwallet = ctx.create_dwallet(&keypair_pubkey(&user), 2, 32, &public_key);

// Give it to the program, through the real TransferOwnership.
ctx.transfer_dwallet(&dwallet, &user, &cpi_authority);
```

It also offers `send_tx`, which panics on failure, `try_send_tx`, which returns the result, and
`get_account_data`. It depends on `litesvm` 0.16.

## Checking the voucher

After the instruction that should issue a voucher, read the voucher's address:

```rust
let voucher = ctx.get_account_data(&voucher_pda).expect("the voucher exists");
assert_eq!(voucher.len(), 304);
assert_eq!(voucher[0], 108);                         // SignatureVoucher
assert_eq!(&voucher[2..34], dwallet.as_ref());       // its dWallet
assert_eq!(&voucher[34..66], &message_digest);       // its message
assert_eq!(&voucher[98..130], cpi_authority.as_ref()); // owned by the program
assert_eq!(voucher[173], 0);                         // pending
```

## What the voting example tests with LiteSVM

`examples/voting/pinocchio/tests/litesvm.rs`:

| Test | What it shows |
|---|---|
| `test_voting_full_lifecycle` | Council, transfer, proposal and three votes. The third vote issues the voucher |
| `test_voting_below_quorum_no_voucher` | No voucher before the quorum |
| `test_no_votes_dont_trigger_quorum` | No votes do not count toward the quorum |
| `test_outsider_cannot_vote_or_recreate_council` | A stranger cannot vote, or replace the council |
| `test_quorum_cannot_be_redirected_to_another_councils_dwallet` | A quorum cannot issue a voucher for another council's dWallet |
| `test_create_proposal_refuses_a_non_canonical_voucher_bump` | The voucher's bump must be the canonical one |
| `test_quorum_vote_refuses_a_substituted_voucher_account` | The voucher must be at the program's PDA |
| `test_a_member_cannot_vote_twice_with_a_second_bump` | A vote record at a second valid bump is refused (`InvalidBump`) |
| `test_create_proposal_refuses_a_non_canonical_proposal_bump` | The proposal's bump must be the canonical one |
| `test_dwallet_context_refuses_a_program_that_is_not_ika` | A fake ika program is refused with `IncorrectProgramId`, before any call |

The native and Anchor versions, and the three multisig programs, have the same kind of tests. The
multisig programs also test `test_a_member_cannot_approve_twice_with_a_second_bump`,
`test_a_member_cannot_reject_twice_with_a_second_bump` and
`test_create_transaction_refuses_a_non_canonical_transaction_bump`.

## Running the tests

From the repository root, build the example, then run its tests:

```bash
cargo build-sbf --tools-version v1.54 --arch v3 --manifest-path examples/voting/pinocchio/Cargo.toml
cargo test -p ika-example-voting-pinocchio --test litesvm
```

## Mollusk or LiteSVM

| | Mollusk | LiteSVM |
|---|---|---|
| Runs | one instruction | whole transactions |
| CPI into the ika program | no | yes |
| Several programs | no | yes |
| State kept between steps | no | yes |
| Speed | fastest | fast |

Test each instruction and each error with Mollusk. Test the CPI and multi-step flows with
LiteSVM.
