# Test the Program

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

The voting example is tested at three levels. Each catches what the one before cannot.

| Level | Tool | What runs | What it proves |
|---|---|---|---|
| One instruction | Mollusk | your program alone | Every check and every error code |
| The CPI | LiteSVM | your program and the real ika program | The vote at the quorum creates the right voucher |
| The whole run | the SDK, against the pre-alpha or a local mock | Solana and an ika network | The network signs, and the signature is written into the voucher |

## Mollusk: one instruction at a time

`examples/voting/pinocchio/tests/mollusk.rs` builds each account by hand, runs one instruction,
and checks the result. A negative test asserts the exact error code:

```rust
#[test]
fn test_create_proposal_rejects_non_member() {
    // A council around a dWallet, and a creator who is not on it.
    // ...
    let result = mollusk.process_instruction(&ix, &accounts);
    assert_custom_error(&result, ERR_NOT_A_MEMBER);
}
```

A test that only asserts failure also passes when the instruction fails for another reason, such as
a wrong system program. Then the membership check could be gone and the test would not notice.

The dWallet is an account the test writes: 185 bytes, tag 97, owner at offset 2, owned by
`ika_dwallet_pinocchio::ID`, which a test build sets to the development address. See [Mollusk Tests](../testing/mollusk.md) for the
helpers and the full list of tests.

## LiteSVM: the CPI into the real ika program

`examples/voting/pinocchio/tests/litesvm.rs` loads the built ika program and the voting program into
one runtime. `DWalletTestContext` writes a coordinator, a network key and a dWallet into it. The
test then runs the real instructions: the council, the real `TransferOwnership`, the proposal, and
three votes.

After the third vote it reads the voucher at `["signature_voucher", proposal_id]`:

- it exists, with tag 108;
- it names the proposal's dWallet and digest;
- its owner is the voting program's CPI authority;
- its status is 0, pending.

These tests check the attacks the program exists to stop:

- `test_outsider_cannot_vote_or_recreate_council`: a key that is not a member cannot vote, and
  cannot create a second council for the dWallet.
- `test_quorum_cannot_be_redirected_to_another_councils_dwallet`: a council that reaches its
  quorum cannot pass another council's dWallet to the CPI.
- `test_a_member_cannot_vote_twice_with_a_second_bump`: a second vote record at another valid bump
  is refused with `InvalidBump`.
- `test_create_proposal_refuses_a_non_canonical_proposal_bump`: one proposal id has one proposal.
- `test_dwallet_context_refuses_a_program_that_is_not_ika`: a fake ika program passed for the CPI
  is refused with `IncorrectProgramId`, so it never receives the CPI authority's signature.

See [LiteSVM Tests](../testing/litesvm.md).

## Prove the tests matter

A test of a security check is worth something only if it fails when the check is gone. Try it once
for each check that matters:

1. Remove the check from the program, for example the `DWalletMismatch` comparison in `cast_vote`.
2. Build and run the test that guards it.
3. Confirm that the test fails, and that the attack now succeeds.
4. Put the check back.

## Running the tests

From the repository root, with no network feature, since the tests load the ika program from `bin/`
at its development address:

```bash
cargo build-sbf --tools-version v1.54 --arch v3 --manifest-path examples/voting/pinocchio/Cargo.toml
cargo test -p ika-example-voting-pinocchio
```


## The whole run

The end-to-end demo in `examples/voting/e2e` runs the full path against the devnet pre-alpha: the dWallet, the council, the votes, the voucher, the presign and the
signature. See [End-to-End Tests](../testing/e2e.md) and
[Examples](../examples/overview.md) for how to run it.
