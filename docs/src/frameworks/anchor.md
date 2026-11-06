# Anchor

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

`ika-dwallet-anchor` lets an [Anchor](https://www.anchor-lang.com) 1.x program call the ika
program. Anchor checks accounts from constraints declared on the accounts struct, so most of the
checks a dWallet program needs fit in a few attributes.

## Dependencies

```toml
[dependencies]
ika-dwallet-anchor = { git = "https://github.com/dwallet-labs/ika-pre-alpha" }
anchor-lang = "1.2"

[lib]
crate-type = ["cdylib", "lib"]
```

Build with the Anchor CLI 1.x, with the network's feature, for example
`anchor build -- --features devnet-pre-alpha`, or with `cargo build-sbf` as below. The ika program has no Anchor IDL, so its accounts reach your
program as `UncheckedAccount`, and your program checks them.

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
devnet-pre-alpha = ["ika-dwallet-anchor/devnet-pre-alpha"]
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
use ika_dwallet_anchor::{CPI_AUTHORITY_SEED, DWalletContext, ID as IKA_PROGRAM_ID};

let dwallet_ctx = DWalletContext {
    dwallet_program: ctx.accounts.dwallet_program.to_account_info(),
    cpi_authority: ctx.accounts.cpi_authority.to_account_info(),
    caller_program: ctx.accounts.program.to_account_info(),
    cpi_authority_bump,
};
```

The methods and their order of arguments are those of the
[Pinocchio crate](./pinocchio.md#the-calls). The accounts are `&AccountInfo<'info>`,
`voucher_seeds` is `Option<&[&[u8]]>`, `transfer_dwallet` takes `&Pubkey`, and each call returns
Anchor's `Result<()>`. Every call refuses a `dwallet_program` that is not at `IKA_PROGRAM_ID` with
`IncorrectProgramId`.

## Example: the voting program in Anchor

`examples/voting/anchor/src/lib.rs` is the voting program written with Anchor. Its
accounts struct for a vote states most of the bindings from
[Integrator Invariants](../on-chain/integrator-invariants.md) as constraints:

```rust
#[derive(Accounts)]
#[instruction(proposal_id: [u8; 32], vote: bool, cpi_authority_bump: u8)]
pub struct CastVote<'info> {
    #[account(mut, seeds = [b"proposal", proposal_id.as_ref()], bump)]
    pub proposal: Account<'info, Proposal>,

    // One vote record per voter, at the canonical bump.
    #[account(
        init,
        payer = payer,
        space = 8 + VoteRecord::INIT_SPACE,
        seeds = [b"vote", proposal_id.as_ref(), voter.key().as_ref()],
        bump,
    )]
    pub vote_record: Account<'info, VoteRecord>,

    // The council of the proposal's dWallet. The voter must be a member.
    #[account(
        seeds = [b"council", proposal.dwallet.as_ref()],
        bump = council.bump,
        constraint = council.members.contains(&voter.key()) @ VotingError::NotAMember,
    )]
    pub council: Account<'info, Council>,

    pub voter: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,

    /// CHECK: the DWalletCoordinator of the ika program.
    pub coordinator: UncheckedAccount<'info>,

    /// CHECK: the voucher to create, at this program's PDA for the proposal.
    #[account(mut, seeds = [b"signature_voucher", proposal_id.as_ref()], bump = proposal.signature_voucher_bump)]
    pub signature_voucher: UncheckedAccount<'info>,

    /// CHECK: must be the proposal's dWallet.
    #[account(address = proposal.dwallet @ VotingError::DWalletMismatch)]
    pub dwallet: UncheckedAccount<'info>,

    /// CHECK: this program's account.
    pub program: UncheckedAccount<'info>,
    /// CHECK: this program's CPI authority.
    pub cpi_authority: UncheckedAccount<'info>,
    /// CHECK: the ika program.
    pub dwallet_program: UncheckedAccount<'info>,
}
```

When the quorum is reached, the handler issues the voucher:

```rust
let voucher_seeds: &[&[u8]] = &[
    b"signature_voucher",
    proposal_id.as_ref(),
    &[proposal.signature_voucher_bump],
];

dwallet_ctx.issue_signature_voucher(
    &ctx.accounts.coordinator.to_account_info(),
    &ctx.accounts.signature_voucher.to_account_info(),
    &ctx.accounts.dwallet.to_account_info(),
    &ctx.accounts.payer.to_account_info(),
    &ctx.accounts.system_program.to_account_info(),
    proposal.message_digest,
    [0u8; 32],
    proposal.signature_scheme,
    None,
    Some(proposal.user_pubkey),
    Some(voucher_seeds),
)?;
```

Anchor needs every account of an instruction on every call. So, unlike the Pinocchio version,
the Anchor `cast_vote` takes the six accounts of the CPI on every vote, not only on the vote that
reaches the quorum.

## Reading the dWallet's owner

The ika program's accounts are not Anchor accounts: they have a two-byte header, not Anchor's
eight-byte discriminator. Read them by hand. The example's `create_council` checks the owner
like this:

```rust
#[account(owner = IKA_PROGRAM_ID @ VotingError::InvalidDWalletAccount)]
pub dwallet: UncheckedAccount<'info>,
```

```rust
let dwallet_data = ctx.accounts.dwallet.try_borrow_data()?;
require!(dwallet_data.first() == Some(&97), VotingError::InvalidDWalletAccount);
let stored_owner = dwallet_data
    .get(2..)
    .and_then(|tail| tail.first_chunk::<32>())
    .ok_or(VotingError::InvalidDWalletAccount)?;
require!(*stored_owner == ctx.accounts.owner.key().to_bytes(), VotingError::NotDWalletOwner);
```

The constraint compares the account's owner with `IKA_PROGRAM_ID`, the ika program of the network
the program was built for, never with a program account the caller passed. See
[invariant 2](../on-chain/integrator-invariants.md#2-let-the-dwallets-owner-set-its-rules-once-before-the-transfer).
