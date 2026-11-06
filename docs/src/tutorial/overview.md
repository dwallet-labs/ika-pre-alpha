# Tutorial: A Voting dWallet

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

This tutorial walks through a Solana program that puts a dWallet under the control of a council.
The council is a fixed list of members and a quorum. A member proposes a message. When enough
members vote yes, the program issues a signature voucher for the message, and the ika network
signs it with the dWallet.

The program is `examples/voting/pinocchio/src/lib.rs`. The tutorial quotes it as it
is, so you can read the two side by side. The same program exists for `solana-program` and for
Anchor, in `examples/voting/native` and `examples/voting/anchor`.

## What the program does

| Number | Instruction | Who sends it | What it does |
|---|---|---|---|
| 2 | `create_council` | the dWallet's owner | Fixes the members and the quorum for one dWallet |
| 0 | `create_proposal` | a council member | Creates a proposal: a message to sign with the council's dWallet |
| 1 | `cast_vote` | a council member | Records a vote. The vote that reaches the quorum issues the voucher |

The life of one dWallet in this program:

1. A user creates a dWallet. The user's wallet is its owner.
2. The user creates the council for the dWallet, at the address `["council", dwallet]`.
3. The user transfers the dWallet to the program's CPI authority. From now on only the program can
   issue vouchers for it.
4. A member creates a proposal with the message's digest. The proposal takes the council's
   quorum.
5. Members vote. Each vote creates a vote record, `["vote", proposal_id, voter]`.
6. The vote that reaches the quorum makes the program call `issue_signature_voucher`. The voucher
   is at the program's own address `["signature_voucher", proposal_id]`.
7. The proposal's signer sends a sign request that names the voucher. The network signs and
   writes the signature into the voucher.

## Why the council exists

The ika program knows a program by one address: its CPI authority. Every dWallet owned by that
address belongs to the program as a whole. So the program must decide, for each dWallet it holds,
who may ask for a signature. Without that decision, anybody could create a proposal of their own,
with their own quorum, for a dWallet someone else gave the program, and get any message signed.

The program closes that with two rules:

1. The rules are fixed per dWallet, by the dWallet's owner, before the transfer. The council's
   address is derived from the dWallet's, so there is one per dWallet. Only the dWallet's current
   owner can create it.
2. Everything after is bound to that council. Only its members propose and vote. The quorum comes
   from the council. The vote that issues the voucher must pass the proposal's own dWallet.

Copy both rules when you build your own program. The full list is in
[Integrator Invariants](../on-chain/integrator-invariants.md).

## The chapters

1. [Create the program](./create-program.md): the accounts, the errors and the dispatch.
2. [Create the council and the proposal](./issue-signature-vouchers.md).
3. [Cast votes and issue the voucher](./cast-votes.md).
4. [Read and verify the signature](./verify-signature.md).
5. [Test the program](./testing.md).

## Source layout

```text
examples/voting/
  pinocchio/src/lib.rs        the program
  pinocchio/tests/mollusk.rs  one instruction at a time
  pinocchio/tests/litesvm.rs  the CPI into the real ika program
  native/, anchor/            the same program in the other frameworks
  e2e/                        a TypeScript demo against the devnet pre-alpha
```

## Before you start

- Complete the [installation](../getting-started/installation.md).
- Know Solana programs: accounts, PDAs and CPIs. This tutorial explains only what is specific to
  dWallets.
