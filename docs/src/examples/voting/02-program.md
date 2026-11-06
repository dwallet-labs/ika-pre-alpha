# Building the Voting Program

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

## What You'll Learn

- How to define on-chain account layouts for councils, proposals and vote records
- How to implement the CPI authority pattern for dWallet control — and bind each dWallet to its own governance
- How quorum detection issues a signature voucher via CPI
- How to prevent double voting using PDA-based vote records

## Architecture

```
dWallet owner ──► CreateCouncil (members, quorum) ──► Council PDA ["council", dwallet]
                  ──► transfer ownership to CPI PDA

Member 1 ──► CastVote ──┐
Member 2 ──► CastVote ──┤
Member 3 ──► CastVote ──┼──► Quorum? ──► dwallet == proposal.dwallet? ──► issue_signature_voucher CPI ──► SignatureVoucher
                        │                                                                              │
                        └── VoteRecord PDAs (prevent double vote)                                      ▼
                                                                                              gRPC Sign request
                                                                                                       │
                                                                                                       ▼
                                                                                              64-byte signature
```

## 1. Account Layouts

### Council PDA (`["council", dwallet]`) — 361 bytes

```rust
// Header
discriminator: u8,     // offset 0, always 3
version: u8,           // offset 1, always 1

// Fields
dwallet: [u8; 32],     // offset 2 — the dWallet this council governs
quorum: u32,           // offset 34 (LE)
member_count: u16,     // offset 38 (LE), 1..=10
bump: u8,              // offset 40 — canonical bump of this PDA
members: [[u8; 32]; 10], // offset 41 — first `member_count` entries valid
```

### Proposal PDA (`["proposal", proposal_id]`) — 196 bytes

```rust
// Header
discriminator: u8,     // offset 0, always 1
version: u8,           // offset 1, always 1

// Fields
proposal_id: [u8; 32], // offset 2
dwallet: [u8; 32],     // offset 34 — the council's dWallet
message_digest: [u8; 32], // offset 66 — keccak256 of the message to sign
user_pubkey: [u8; 32], // offset 98 — key allowed to call gRPC Sign
signature_scheme: u16, // offset 130 (LE) — DWalletSignatureScheme, 5 = EdDSA/SHA-512
creator: [u8; 32],     // offset 132
yes_votes: u32,        // offset 164 (LE)
no_votes: u32,         // offset 168 (LE)
quorum: u32,           // offset 172 (LE) — copied from the council
status: u8,            // offset 176 — 0=Open, 1=Approved
signature_voucher_bump: u8, // offset 177
bump: u8,              // offset 178
_reserved: [u8; 16],   // offset 179
```

### VoteRecord PDA (`["vote", proposal_id, voter]`) — 69 bytes

```rust
discriminator: u8,     // offset 0, always 2
version: u8,           // offset 1

voter: [u8; 32],       // offset 2
proposal_id: [u8; 32], // offset 34
vote: u8,              // offset 66 — 1=yes, 0=no
bump: u8,              // offset 67
```

## 2. CreateCouncil Instruction (disc = 2)

Signed by the dWallet's **current** owner, before the ownership is transferred to the CPI PDA. The program reads the `DWallet` account (owner = dWallet program, discriminator `97`, `owner` at offset 2) and requires the signer to be that owner; the council is created at the canonical `["council", dwallet]` PDA, so there is exactly one per dWallet.

**Data:** `[quorum(4), member_count(2), members(32 * member_count)]`

**Accounts:**

| # | Account | Flags | Description |
|---|---------|-------|-------------|
| 0 | Council PDA | writable | Created via `invoke_signed` |
| 1 | dWallet | readonly | The dWallet account on the dWallet program |
| 2 | dWallet Program | readonly | Must be the ika program (`ID` of the CPI crate), executable, and the dWallet account's owner |
| 3 | Owner | signer | The dWallet's current owner |
| 4 | Payer | writable, signer | Pays rent |
| 5 | System Program | readonly | For PDA creation |

Rejects: quorum outside `1..=member_count`, more than 10 members, duplicate members, a signer that is not the owner, a dWallet program account that is not the ika program, a dWallet account the ika program does not own, a council address other than the canonical PDA.

## 3. CreateProposal Instruction (disc = 0)

**Data:** `[proposal_id(32), message_digest(32), user_pubkey(32), signature_scheme(2), signature_voucher_bump(1), bump(1)]` = 100 bytes

**Accounts:**

| # | Account | Flags | Description |
|---|---------|-------|-------------|
| 0 | Proposal PDA | writable | Created via `invoke_signed` |
| 1 | Council PDA | readonly | The council of the dWallet |
| 2 | dWallet | readonly | The dWallet account on the dWallet program |
| 3 | Creator | signer | Must be a council member |
| 4 | Payer | writable, signer | Pays rent |
| 5 | System Program | readonly | For PDA creation |

The council is verified (program-owned, council discriminator, `dwallet` field equals the passed dWallet, address equals `["council", dwallet, bump]`) and the creator must be one of its members. The proposal's quorum is the council's.

## 4. CastVote Instruction (disc = 1)

**Data:** `[proposal_id(32), vote(1), vote_record_bump(1), cpi_authority_bump(1)]` = 35 bytes

**Base accounts (always required):**

| # | Account | Flags |
|---|---------|-------|
| 0 | Proposal PDA | writable |
| 1 | VoteRecord PDA | writable |
| 2 | Council PDA | readonly |
| 3 | Voter | signer (must be a council member) |
| 4 | Payer | writable, signer |
| 5 | System Program | readonly |

**CPI accounts (when quorum will be reached):**

| # | Account | Flags |
|---|---------|-------|
| 6 | DWalletCoordinator PDA | readonly |
| 7 | SignatureVoucher PDA (`["signature_voucher", proposal_id]`, this program's) | writable |
| 8 | dWallet | readonly — must be the proposal's dWallet |
| 9 | Voting Program | readonly |
| 10 | CPI Authority PDA | readonly |
| 11 | dWallet Program | readonly |

## 5. The CPI Call

When `yes_votes >= quorum`, the program:

```rust
// The CPI authority PDA is shared by every dWallet this program controls:
// only the proposal's own dWallet may get a voucher.
if dwallet.address().as_array() != &proposal_dwallet {
    return Err(VotingError::DWalletMismatch.into());
}

let ctx = DWalletContext {
    dwallet_program,
    cpi_authority,
    caller_program,
    cpi_authority_bump,
};

// The voucher is this program's PDA for the proposal, so the program signs
// its creation with the PDA's seeds.
let voucher_bump_byte = [signature_voucher_bump];
let voucher_seeds = [
    Seed::from(b"signature_voucher" as &[u8]),
    Seed::from(proposal_id.as_ref()),
    Seed::from(voucher_bump_byte.as_ref()),
];

ctx.issue_signature_voucher(
    coordinator, signature_voucher, dwallet, payer, system_program,
    message_digest, [0u8; 32] /* no metadata */, signature_scheme,
    None /* owner: this program's CPI authority */,
    Some(user_pubkey) /* signing key */,
    Some(&voucher_seeds),
)?;

prop_data[PROP_STATUS] = STATUS_APPROVED;
```

The `DWalletContext` signs via `invoke_signed` with seeds `["__ika_cpi_authority", &[bump]]`, proving the voting program authorized this signing request. The dWallet program checks that the program controls the dWallet; the program itself checks that it is the *right* dWallet.

## Source Code

| Framework | Path |
|-----------|------|
| Pinocchio | `examples/voting/pinocchio/src/lib.rs` |
| Native | `examples/voting/native/src/lib.rs` |
| Anchor | `examples/voting/anchor/src/lib.rs` (`address = proposal.dwallet` and council `seeds` constraints do the binding; the voucher account is unchecked, and the program signs for `["signature_voucher", proposal_id]` with the stored bump, so the dWallet program refuses any other account in that slot as unsigned) |
