# Mollusk Tests

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

[Mollusk](https://github.com/anza-xyz/mollusk) runs one instruction of one program against
accounts you build by hand. It starts no validator and takes milliseconds. Use it to test each of
your program's instructions alone: its data parsing, its account checks, and every error it
returns.

Mollusk runs a single program, so it cannot run your CPI into the ika program. Test the CPI with
[LiteSVM](./litesvm.md).

## Setup

```toml
[dev-dependencies]
mollusk-svm = "0.15"
solana-account = "4.3"
solana-instruction = "3.4"
solana-program-error = "3"
solana-pubkey = "4.1"
```

These are the versions the examples use. Build your program first with
`cargo build-sbf --tools-version v1.54 --arch v3`, with no network feature, then load it:

```rust
use mollusk_svm::Mollusk;
use solana_pubkey::Pubkey;

const PROGRAM_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/target/deploy/my_program");

fn setup() -> (Mollusk, Pubkey) {
    let program_id = Pubkey::new_unique();
    (Mollusk::new(&program_id, PROGRAM_PATH), program_id)
}
```

`--arch v3` builds for SBPF version 3. A cluster with SIMD-0500 active refuses to deploy a build
for an older version. `--tools-version v1.54` names platform tools that have the version 3 target.

## Building a dWallet account by hand

Your program reads `DWallet` accounts of the ika program. In a Mollusk test you build one: 185
bytes, tag 97 at byte 0, version 1 at byte 1, the owner at offset 2. The account's owner must be
`ID` of the CPI crate. A test build has no network feature, so `ID` is the development address,
and your program accepts only dWallets owned by it. Pass the same address as the ika program
account wherever your instruction takes one.

```rust
let ika_program = Pubkey::new_from_array(*ika_dwallet_pinocchio::ID.as_array());
```

```rust
fn dwallet_account(ika_program: &Pubkey, dwallet_owner: &Pubkey) -> Account {
    let mut data = vec![0u8; 185];
    data[0] = 97; // DWallet
    data[1] = 1;  // version
    data[2..34].copy_from_slice(dwallet_owner.as_ref());
    Account {
        lamports: 1_000_000_000,
        data,
        owner: *ika_program,
        executable: false,
        rent_epoch: 0,
    }
}
```

Set `state` at offset 36 to 1 when your program checks that the dWallet is Active. The full
layout is in the [Account Reference](../reference/accounts.md#dwallet-tag-97).

## Asserting the exact error

Assert the error code a test expects, never only that the instruction failed. A test that only
checks for failure also passes when the instruction fails for another reason, and then the check
you meant to test may no longer run at all.

```rust
use mollusk_svm::result::{InstructionResult, ProgramResult};
use solana_program_error::ProgramError;

fn assert_custom_error(result: &InstructionResult, code: u32) {
    match &result.program_result {
        ProgramResult::Failure(error) => assert_eq!(*error, ProgramError::Custom(code)),
        other => panic!("expected Custom({code}), got {other:?}"),
    }
}
```

## What the voting example tests with Mollusk

`examples/voting/pinocchio/tests/mollusk.rs` tests each instruction, and each
binding the program relies on:

| Test | What it shows |
|---|---|
| `test_create_council_success` | The council is created at its canonical address with its fields |
| `test_create_council_rejects_non_owner` | Only the dWallet's owner can create the council |
| `test_create_council_rejects_dwallet_not_owned_by_dwallet_program` | A look-alike dWallet account is refused |
| `test_create_council_rejects_quorum_above_member_count` | The quorum is checked |
| `test_create_council_rejects_duplicate_member` | A member listed twice is refused |
| `test_create_council_rejects_non_canonical_address` | The council must be at its canonical address |
| `test_create_proposal_success` | The proposal takes its quorum from the council |
| `test_create_proposal_rejects_non_member` | Only members propose |
| `test_create_proposal_rejects_council_of_another_dwallet` | The council must be the dWallet's own |
| `test_create_proposal_rejects_forged_council_account` | Council-like data at another address is refused |
| `test_create_proposal_already_exists` | A proposal id is used once |
| `test_cast_vote_yes_success`, `test_cast_vote_no_success` | Votes are counted |
| `test_cast_vote_rejects_non_member`, `test_cast_vote_rejects_council_of_another_dwallet` | Membership is checked on every vote |
| `test_cast_vote_at_quorum_rejects_wrong_dwallet` | The vote that reaches the quorum refuses another dWallet |
| `test_cast_vote_double_vote_fails` | A second vote at the same vote record fails |
| `test_cast_vote_closed_proposal_fails` | A passed proposal takes no more votes |

## Running the tests

From the repository root:

```bash
cargo build-sbf --tools-version v1.54 --arch v3 --manifest-path examples/voting/pinocchio/Cargo.toml
cargo test -p ika-example-voting-pinocchio --test mollusk
```

