# Testing the Voting Program

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

## What You'll Learn

- How to write Mollusk instruction-level tests for dWallet programs
- How to build and verify account data at specific byte offsets
- Testing error conditions with exact error codes (non-member, wrong council, wrong dWallet, double vote, closed proposal)
- Testing the CPI path — and the confused-deputy attack — with LiteSVM against the real dWallet program

## Test Matrix (Mollusk)

| Test | Instruction | Expected Result |
|------|-------------|-----------------|
| `test_create_council_success` | CreateCouncil | PDA created at the canonical address with dwallet, quorum, members |
| `test_create_council_rejects_non_owner` | CreateCouncil | `Custom(2)` NotDWalletOwner |
| `test_create_council_rejects_dwallet_not_owned_by_dwallet_program` | CreateCouncil | `Custom(4)` InvalidDWalletAccount |
| `test_create_council_rejects_quorum_above_member_count` | CreateCouncil | `Custom(5)` InvalidQuorum |
| `test_create_council_rejects_duplicate_member` | CreateCouncil | `Custom(6)` DuplicateMember |
| `test_create_council_rejects_non_canonical_address` | CreateCouncil | `Custom(3)` InvalidCouncil |
| `test_create_proposal_success` | CreateProposal | PDA created; quorum copied from the council |
| `test_create_proposal_rejects_non_member` | CreateProposal | `Custom(1)` NotAMember |
| `test_create_proposal_rejects_council_of_another_dwallet` | CreateProposal | `Custom(3)` InvalidCouncil |
| `test_create_proposal_rejects_forged_council_account` | CreateProposal | `Custom(3)` InvalidCouncil |
| `test_create_proposal_already_exists` | CreateProposal | Fails (account in use) |
| `test_cast_vote_yes_success` / `_no_success` | CastVote | counters incremented, status=Open |
| `test_cast_vote_rejects_non_member` | CastVote | `Custom(1)` NotAMember |
| `test_cast_vote_rejects_council_of_another_dwallet` | CastVote | `Custom(3)` InvalidCouncil |
| `test_cast_vote_at_quorum_rejects_wrong_dwallet` | CastVote | `Custom(0)` DWalletMismatch, before any CPI |
| `test_cast_vote_double_vote_fails` | CastVote | Fails (VoteRecord exists) |
| `test_cast_vote_closed_proposal_fails` | CastVote | `Custom(7)` ProposalClosed |

The Anchor variant reports the same conditions as Anchor errors (`6003` NotAMember, `6004` DWalletMismatch, `6005` NotDWalletOwner, ...; a council at the wrong PDA fails Anchor's `ConstraintSeeds`, `2006`).

## Test Matrix (LiteSVM)

| Test | Expected Result |
|------|-----------------|
| `test_voting_full_lifecycle` | council → transfer → proposal → 3 votes → SignatureVoucher created with the right fields |
| `test_voting_below_quorum_no_voucher` | no SignatureVoucher before quorum |
| `test_no_votes_dont_trigger_quorum` | "no" votes never issue a voucher |
| `test_outsider_cannot_vote_or_recreate_council` | outsider vote / proposal `NotAMember`; council (re)creation `NotDWalletOwner` |
| `test_quorum_cannot_be_redirected_to_another_councils_dwallet` | attacker's own council reaching quorum with the victim's dWallet as CPI target fails `DWalletMismatch`; no voucher for the victim |
| `test_create_proposal_refuses_a_non_canonical_voucher_bump` | a proposal naming a voucher bump other than the canonical one is refused |
| `test_quorum_vote_refuses_a_substituted_voucher_account` | the quorum vote refuses a voucher account other than the proposal's PDA |
| `test_a_member_cannot_vote_twice_with_a_second_bump` | a second vote with another valid vote-record bump fails `InvalidBump` (11); no second record, the count stays 1 |
| `test_create_proposal_refuses_a_non_canonical_proposal_bump` | a proposal at a non-canonical bump fails `InvalidBump`; nothing is written there |
| `test_dwallet_context_refuses_a_program_that_is_not_ika` | at quorum, a program other than the ika program in the dWallet-program slot fails `IncorrectProgramId`; no voucher |

Three tests guard attacks that would otherwise work:

- The redirect test: with the dWallet check removed from the program, the attacker's transaction succeeds and issues a voucher on the victim's dWallet.
- The second-bump test: with the canonical-bump check removed, the member's second vote succeeds and counts twice.
- The ika-program test: with `DWalletContext`'s program check removed, the call goes to whatever program the caller named.

Each of them was run against the program with its check removed, and failed there.

The Pinocchio and native variants run all ten. The Anchor variant runs five: the full lifecycle, below quorum, outsider, redirect and ika-program tests. It needs no bump tests, because Anchor derives every canonical bump itself.

## Running Tests

```bash
# from the repository root
# SBF builds the tests load (the ika program itself is shipped in bin/)
cargo build-sbf --tools-version v1.54 --arch v3 --manifest-path examples/voting/pinocchio/Cargo.toml
cargo build-sbf --tools-version v1.54 --arch v3 --manifest-path examples/voting/native/Cargo.toml
cargo build-sbf --tools-version v1.54 --arch v3 --manifest-path examples/voting/anchor/Cargo.toml

# Mollusk + LiteSVM
cargo test -p ika-example-voting-pinocchio
cargo test -p ika-example-voting-native
cargo test -p ika-example-voting-anchor
```

## Key Patterns

### Building Test Account Data

Tests pre-populate account data with exact byte layouts:

```rust
fn build_council_data(dwallet: &Pubkey, quorum: u32, members: &[Pubkey], bump: u8) -> Vec<u8> {
    let mut data = vec![0u8; COUNCIL_LEN]; // 361 bytes
    data[0] = COUNCIL_DISCRIMINATOR;       // 3
    data[1] = 1;                           // version
    data[CN_DWALLET..CN_DWALLET + 32].copy_from_slice(dwallet.as_ref());
    data[CN_QUORUM..CN_QUORUM + 4].copy_from_slice(&quorum.to_le_bytes());
    // ... member_count, bump, members
    data
}
```

A `fixture()` helper builds a dWallet address, a stand-in dWallet program, an owner and a 3-member council around them so each test states only what it changes.

### Asserting Exact Error Codes

```rust
fn assert_custom_error(result: &InstructionResult, code: u32) {
    match &result.program_result {
        ProgramResult::Failure(err) => assert_eq!(*err, ProgramError::Custom(code)),
        other => panic!("expected Custom({code}) failure, got {other:?}"),
    }
}
```

`assert!(result.program_result.is_err())` is not enough for a negative test: the instruction may fail for an unrelated reason (a fake token program, a wrong bump) while the check you meant to test no longer fires.

### Testing Double Vote Prevention

The VoteRecord PDA prevents double voting. If the PDA already exists, `CreateAccount` fails:

```rust
// Pre-populate VoteRecord (voter already voted)
let existing_vr = build_vote_record_data(&voter, &proposal_id, 1, vr_bump);

let result = mollusk.process_instruction(&ix, &[
    (proposal_pda, program_account(&program_id, proposal_data)),
    (vote_record_pda, program_account(&program_id, existing_vr)), // exists!
    // ...
]);
assert!(matches!(result.program_result, ProgramResult::Failure(_)));
```

## Source

- Pinocchio tests: `examples/voting/pinocchio/tests/{mollusk,litesvm}.rs`
- Native tests: `examples/voting/native/tests/{mollusk,litesvm}.rs`
- Anchor tests: `examples/voting/anchor/tests/{mollusk,litesvm}.rs`
