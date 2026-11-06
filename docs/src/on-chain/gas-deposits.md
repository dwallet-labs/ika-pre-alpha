# Gas Deposits

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

The network serves a gRPC request only when the key that signed it has a gas deposit on the
chain the request names. The deposit is a `GasDeposit` account of the ika program. It holds IKA,
which pays the network's fees, and SOL, which pays for the transactions the network sends to
write results on Solana.

## One deposit per request key

A user signs every gRPC request with an Ed25519 key, the request key. The deposit belongs to that
key, not to a Solana wallet: it lives at `["gas_deposit", user_pubkey]`, where `user_pubkey` is
the request key.

So a user who makes a new request key needs a new deposit. A request signed by a key with no
deposit is refused with:

```text
this transport key has no gas deposit on the chain the request names
```

A voucher's signing key is a request key too. The key a program names as a voucher's signing key
must have its own deposit, or its sign request is refused.

## Creating a deposit

`CreateDeposit` creates the account. The request key must agree to it: it signs a message that
names this chain, this deployment's network, and the wallet that creates the deposit. That
signature is checked by the Ed25519 precompile, in an instruction before `CreateDeposit` in the
same transaction. Anyone can pay the rent.

A paused coordinator refuses `CreateDeposit`. See [Pauses](./pauses.md).

In TypeScript, `createDepositInstructions` from `@ika.xyz/sdk-solana/instructions` builds both
instructions, and `ikaTx.createGasDeposit()` on an `IkaTransaction` adds them to a transaction.

## Adding funds

`TopUp` adds IKA, SOL, or both. The IKA moves from a token account of the payer into the
coordinator's treasury vault. The SOL moves from the payer into the deposit account. Anyone can
top up any deposit. A top-up that moves nothing is refused (`EmptyTopUp`, 4038).

## What the network charges

The network charges a deposit for the work each request needs, and for the SOL its own
transactions spend. It charges in the same transaction that writes the result, with `SettleGas`.
It also charges for some work it delivered nothing for, such as a request it refused from its own
bytes, with `SettleGasCharge`.

A charge never makes the network's transaction fail. When the balance is too small, the rest of
the charge becomes debt (`ika_debt`, `sol_debt`). The next charge takes the debt first, before its
own amount. Funds that cover debt cannot be withdrawn.

**The mock network charges nothing.** On the devnet pre-alpha a deposit with no funds serves, and
its balance never changes.

## Taking funds back

The request key takes unspent funds back in two steps:

1. `RequestWithdraw` records the IKA and SOL amounts to take.
2. The network signs a release for that request. `Withdraw` sends it, after an Ed25519 precompile
   instruction with the network's signature, and pays out.

A new request or a successful claim makes an older release useless. The payout is at most the
balance minus the debt.

The mock network signs no release. On the devnet pre-alpha, funds put into a deposit stay there.
Put nothing into a pre-alpha deposit.

## The account

The full layout is in the [Account Reference](../reference/accounts.md#gasdeposit-tag-99). The
fields a client reads most:

| Offset | Field | Meaning |
|---|---|---|
| 2 | `user_pubkey` | The request key |
| 34 | `ika_balance` | IKA available |
| 42 | `sol_balance` | Lamports available |
| 123 | `ika_debt` | IKA owed |
| 131 | `sol_debt` | Lamports owed |
