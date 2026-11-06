# Cast Votes and Issue the Voucher

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

`cast_vote` records one member's vote. The vote that brings the yes votes to the quorum also issues
the signature voucher, through a CPI into the ika program.

## cast_vote (1)

Data, 35 bytes: `proposal_id` (32), `vote` (1: 1 yes, 0 no), `vote_record_bump` (1),
`cpi_authority_bump` (1).

Every vote takes six accounts:

| # | Account | Writable | Signer |
|---|---|---|---|
| 0 | proposal | yes | no |
| 1 | vote_record, `["vote", proposal_id, voter]` | yes | no |
| 2 | council, of the proposal's dWallet | no | no |
| 3 | voter, a council member | no | yes |
| 4 | payer | yes | yes |
| 5 | system_program | no | no |

The vote that reaches the quorum takes six more, for the CPI:

| # | Account | Writable | Signer |
|---|---|---|---|
| 6 | coordinator, the ika program's `DWalletCoordinator` | no | no |
| 7 | signature_voucher, `["signature_voucher", proposal_id]` | yes | no |
| 8 | dwallet, the proposal's dWallet | no | no |
| 9 | caller_program, this program | no | no |
| 10 | cpi_authority, this program's CPI authority | no | no |
| 11 | dwallet_program, the ika program | no | no |

The client decides whether to add them. It reads the proposal first: when `yes_votes + 1` reaches
`quorum` and the vote is yes, it adds the six.

## Recording the vote

The program checks that the proposal is open and is the one named, then checks the voter against
the proposal's council:

```rust
let proposal_dwallet = {
    let prop_data = proposal_account.try_borrow()?;
    if prop_data.len() < PROPOSAL_LEN || prop_data[0] != PROPOSAL_DISCRIMINATOR {
        return Err(ProgramError::InvalidAccountData);
    }
    if prop_data[PROP_STATUS] != STATUS_OPEN {
        return Err(VotingError::ProposalClosed.into());
    }
    if prop_data[PROP_PROPOSAL_ID..PROP_PROPOSAL_ID + 32] != proposal_id {
        return Err(VotingError::ProposalMismatch.into());
    }
    read_key(&prop_data, PROP_DWALLET)?
};
verify_council_member(program_id, council, &proposal_dwallet, voter.address().as_array())?;
```

It then creates the vote record with `CreateAccount`, signed with the seeds
`["vote", proposal_id, voter, vote_record_bump]`, and adds one to the yes or the no count.

### Make the vote record unique

The vote record is what stops a member voting twice: creating it a second time fails, because the
account exists. That holds only if the record has one possible address. A seed list has many valid
bumps, and each bump gives another address. So the program must accept only the canonical bump, the
one `find_program_address` returns. Otherwise a member who passes a second valid bump creates a
second record, and votes twice.

The example checks the bump the client passes before it creates the record:

```rust
fn require_canonical_bump(
    seeds: &[&[u8]],
    bump: u8,
    program_id: &Address,
) -> Result<(), ProgramError> {
    let (_, canonical) = Address::find_program_address(seeds, program_id);
    if bump != canonical {
        return Err(VotingError::InvalidBump.into());
    }
    Ok(())
}

require_canonical_bump(
    &[b"vote", proposal_id.as_ref(), voter.address().as_array().as_ref()],
    vote_record_bump,
    program_id,
)?;
```

The proposal gets the same check, with its seeds `["proposal", proposal_id]`. The Anchor version
needs no such code: `seeds` with `bump` makes Anchor derive the canonical bump and refuse any other.
The rule holds for any account whose existence means "done once". See
[invariant 6](../on-chain/integrator-invariants.md#6-use-the-canonical-bump-for-every-account-whose-existence-enforces-once).

## Issuing the voucher

When the yes votes reach the quorum, the program reads the six extra accounts and checks two of
them itself, before the CPI:

```rust
if yes_votes >= quorum {
    let [coordinator, signature_voucher, dwallet, caller_program, cpi_authority, dwallet_program, ..] =
        &*tail
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // The CPI must target the dWallet this proposal was created for.
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
```

The dWallet check is the one the whole design rests on. The ika program accepts a voucher for any
dWallet this program owns. Only this check makes it the proposal's dWallet.

The voucher check is needed because the ika program accepts any new address that signed. A keypair
that signed the outer transaction is still a signer inside the CPI. Without the check, the caller
could pass such a keypair, and the voucher would be created where no client looks for it.

Then the CPI:

```rust
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
        [0u8; 32],          // no message metadata
        signature_scheme,
        None,               // the voucher's owner: this program's CPI authority
        Some(user_pubkey),  // the voucher's signing key
        Some(&voucher_seeds),
    )?;

    let mut prop_data = proposal_account.try_borrow_mut()?;
    prop_data[PROP_STATUS] = STATUS_APPROVED;
}
```

The helper first checks that `dwallet_program` is the ika program, `ID` of the crate. Any other
account is refused with `IncorrectProgramId`, so the CPI authority's signature never reaches a
program that only claims to be ika's. It then signs for two addresses with `invoke_signed`: the CPI authority, with
`["__ika_cpi_authority", bump]`, and the voucher, with the seeds passed. The ika program then
checks:

- this program's account is executable;
- the CPI authority is this program's, and it signed;
- the CPI authority is the dWallet's owner;
- the dWallet is Active and the coordinator is not paused;
- the voucher's address signed, holds nothing, and belongs to the system program.

It creates the voucher, pending, with the proposal's digest and scheme, owned by this program's CPI
authority, with `user_pubkey` as its signing key.

If any check fails, the whole transaction fails. The vote record and the count are undone with it,
so the deciding vote can be sent again later, for example after a pause.

## Next

[Read and verify the signature](./verify-signature.md).
