# Create the Council and the Proposal

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

This chapter covers the two instructions that come before any vote. `create_council` fixes who
governs a dWallet. `create_proposal` names a message to sign, and the address its voucher will
have.

## create_council (2)

The dWallet's current owner sends it, before giving the dWallet to the program. After the
transfer the owner is the program's CPI authority, which no user can sign for. So the council can
never be replaced once the dWallet is handed over.

Data: `quorum` (u32), `member_count` (u16, 1 to 10), then `member_count` keys of 32 bytes.

| # | Account | Writable | Signer |
|---|---|---|---|
| 0 | council, `["council", dwallet]` | yes | no |
| 1 | dwallet | no | no |
| 2 | dwallet_program, the ika program | no | no |
| 3 | owner, the dWallet's owner | no | yes |
| 4 | payer | yes | yes |
| 5 | system_program | no | no |

The checks, in the order the program makes them:

```rust
if quorum == 0 || quorum > member_count as u32 {
    return Err(VotingError::InvalidQuorum.into());
}
let has_duplicate = members.chunks(32).enumerate().any(|(index, member)| {
    members.chunks(32).skip(index).skip(1).any(|other| other == member)
});
if has_duplicate {
    return Err(VotingError::DuplicateMember.into());
}

// Only the dWallet's current owner may fix its governance.
if dwallet_owner(dwallet, dwallet_program)? != *owner.address().as_array() {
    return Err(VotingError::NotDWalletOwner.into());
}

// The council lives at the canonical bump, so there is exactly one per dWallet.
let dwallet_key = dwallet.address().as_array();
let (expected, bump) =
    Address::find_program_address(&[b"council", dwallet_key.as_ref()], program_id);
if council_account.address() != &expected {
    return Err(VotingError::InvalidCouncil.into());
}
```

The program then creates the council with `CreateAccount`, signed with the council's seeds, and
writes its fields.

Two choices here make the council unique. The address is derived from the dWallet. The bump is the
canonical one, found by the program itself, not taken from the caller. With a bump from the caller,
a second council could exist at another valid bump.

## Checking a council later

Every later instruction takes a council account and must prove it is the right one:

```rust
fn verify_council_member(
    program_id: &Address,
    council: &AccountView,
    dwallet: &[u8; 32],
    member: &[u8; 32],
) -> Result<u32, ProgramError> {
    if !council.owned_by(program_id) {
        return Err(VotingError::InvalidCouncil.into());
    }
    let data = council.try_borrow()?;
    if data.len() < COUNCIL_LEN || data[0] != COUNCIL_DISCRIMINATOR {
        return Err(VotingError::InvalidCouncil.into());
    }
    if data[CN_DWALLET..CN_DWALLET + 32] != *dwallet {
        return Err(VotingError::InvalidCouncil.into());
    }
    let bump = [data[CN_BUMP]];
    let expected =
        Address::create_program_address(&[b"council", dwallet.as_ref(), &bump], program_id)
            .map_err(|_| VotingError::InvalidCouncil)?;
    if council.address() != &expected {
        return Err(VotingError::InvalidCouncil.into());
    }
    let member_count = read_u16(&data, CN_MEMBER_COUNT)? as usize;
    let is_member = data[CN_MEMBERS..]
        .chunks(32)
        .take(member_count)
        .any(|candidate| candidate == member);
    if !is_member {
        return Err(VotingError::NotAMember.into());
    }
    read_u32(&data, CN_QUORUM)
}
```

It checks four things: the program owns the account, the tag is the council's, the council names
this dWallet, and the address is the council PDA of this dWallet. An account with council-like
data at any other address fails. Then it checks membership, and returns the quorum.

## create_proposal (0)

A council member sends it.

Data, 100 bytes:

| Field | Size | Meaning |
|---|---|---|
| `proposal_id` | 32 | The proposal's id, chosen by the client |
| `message_digest` | 32 | The Keccak-256 of the message to sign |
| `user_pubkey` | 32 | The request key that will send the sign request |
| `signature_scheme` | 2 | The scheme the sign request will use |
| `signature_voucher_bump` | 1 | The canonical bump of `["signature_voucher", proposal_id]` |
| `bump` | 1 | The proposal's canonical bump |

| # | Account | Writable | Signer |
|---|---|---|---|
| 0 | proposal, `["proposal", proposal_id]` | yes | no |
| 1 | council | no | no |
| 2 | dwallet, the council's dWallet | no | no |
| 3 | creator, a council member | no | yes |
| 4 | payer | yes | yes |
| 5 | system_program | no | no |

The proposal takes its quorum from the council, never from the caller:

```rust
let dwallet_key = dwallet.address().as_array();
let quorum = verify_council_member(program_id, council, dwallet_key, creator.address().as_array())?;
```

It accepts only the canonical voucher bump:

```rust
let (_, canonical_voucher_bump) =
    Address::find_program_address(&[b"signature_voucher", proposal_id.as_ref()], program_id);
if signature_voucher_bump != canonical_voucher_bump {
    return Err(VotingError::InvalidVoucherBump.into());
}
```

Another valid bump would put the voucher at an address no client computes. The proposal would pass
and issue its voucher where nobody looks for it, and no signature would ever be asked for.

It accepts only the canonical proposal bump too, so one proposal id has one proposal account:

```rust
let bump = data[99];
require_canonical_bump(&[b"proposal", proposal_id.as_ref()], bump, program_id)?;
```

`require_canonical_bump` refuses any other bump with `InvalidBump`. The next chapter shows it.

The program then creates the proposal and writes its fields, with `status` 0, open.

## Where the voucher will be

The voucher's address is known as soon as the proposal exists: the program's PDA
`["signature_voucher", proposal_id]`. The ika program does not choose it. It accepts any new
address that signs the voucher's creation, and the voting program signs for its own PDA. So a
client can name the voucher in a sign request without searching for it.

`user_pubkey` becomes the voucher's signing key. The network serves a sign request for the
voucher only when it is signed by that key. That key needs its own
[gas deposit](../on-chain/gas-deposits.md).

## Next

[Cast votes and issue the voucher](./cast-votes.md).
