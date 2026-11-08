# Gas Deposits

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

The network serves a gRPC request only when the key that signed it has a gas deposit on the
chain the request names. The deposit is a `GasDeposit` account of the ika program. It holds IKA,
which pays the network's fees, and SOL, which pays for the transactions the network sends to
write results on Solana.

## One deposit per request key

A user signs every gRPC request with an Ed25519 key, the request key. The deposit pays for that
key's requests: it lives at `["gas_deposit", user_pubkey]`, where `user_pubkey` is the request
key.

The wallet that creates the deposit owns it (`owner`). Only the owner's signature requests a
withdrawal, and the network then pays it. The request key only pays for requests and cannot
withdraw. The owner can be a program's address that signs through `invoke_signed`.

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
same transaction. Anyone can pay the rent. The wallet that signs `CreateDeposit` becomes the
deposit's owner.

`CreateDeposit` also funds the deposit, with IKA, SOL, or both. The deposit it creates must reach
the minimum first deposit (`BelowMinimumDeposit`, 4075). See
[Deposit minimums](#deposit-minimums).

A paused coordinator refuses `CreateDeposit`. See [Pauses](./pauses.md).

In TypeScript, `createDepositInstructions` from `@ika.xyz/pre-alpha-solana/instructions` builds both
instructions, and `ikaTx.createGasDeposit()` on an `IkaTransaction` adds them to a transaction.

## Adding funds

`TopUp` adds IKA, SOL, or both. The IKA moves from a token account of the payer into the
coordinator's treasury vault. The SOL moves from the payer into the deposit account. Anyone can
top up any deposit. A top-up that moves nothing is refused (`EmptyTopUp`, 4038). Each coin's
amount must be zero, which adds nothing of that coin, or at least the minimum balance in that coin
(`BelowMinimumTopUp`, 4078). So a top-up of SOL alone checks only the SOL minimum. After a top-up,
the deposit's balance net of debt must reach the minimum first deposit in each coin
(`BelowMinimumDeposit`, 4075).

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

A withdrawal returns the whole deposit, less what the deposit owes and less the withdrawal's
charge. It takes two steps, and only the first is the owner's:

1. The owner sends `RequestWithdraw`, naming the token account the IKA is paid to. The request
   carries no amount. The token account must be an open, unfrozen token account of the IKA mint
   (`InvalidIkaDestination`, 4077).
2. The network sends `SettleGasWithdrawal` from its own address. There is no claim step.

The owner signs the request. Any other signer, the request key included, is refused with
`AuthorityMismatch`. A request is final: there is no cancel, and a second request while one is
pending is refused (`WithdrawalAlreadyPending`, 4076). The request names the deposit's incarnation,
its current life; a request for another one is refused (`GasDepositIncarnationMismatch`, 4081), and
so is a request on a closed deposit (`DepositClosed`, 4080).

The payout takes the charge first, through the same collection every charge uses, and only then
pays what is left: the SOL to the owner, the IKA to the token account the request named. So no
payout happens without its charge. It creates a `GasWithdrawalCharge` record at
`["gas_withdrawal_charge", user_pubkey, withdrawal_sequence_le]`, so one request is paid once.

A payout that pays everything ends the deposit's life: the deposit is closed in place. It keeps its
account and its rent, holds nothing, owes nothing, and its owner is zeroed. A closed deposit
refuses a top-up, a request and a transfer (`DepositClosed`, 4080). The same request key opens it
again with `CreateDeposit`, the same instruction that created it: the signer becomes the owner,
the deposit's `incarnation` goes up by one, and no rent is paid. The proof of possession names the
life it opens, the closed incarnation plus one, so the proof of a life that ended does not reopen
the deposit. A deposit that is open, or whose request is pending, is not reopened.

When the request is pending but the balance is below the debt plus the charge in one of the two
coins, the payout takes nothing and pays nothing, and creates no record. It emits
`WithdrawalShortOfCharge`. A coin whose debt exceeds its balance makes the payout short even when
that coin's charge is 0, so no payout leaves a debt unpaid. The request stays pending, and a top-up
lets a later payout pay it.

When no request is pending at its counter, the payout is still charged. Only a payout ends a
request, so the network sends such a payout only by mistake. It creates the record, takes the charge, pays nothing, and emits
`GasSettled` then `WithdrawalNotPaid`. A shortfall becomes debt. Every withdrawal the network
sends is charged.

What a destination cannot take stays in the deposit, and `GasWithdrawn` names it as kept. SOL is
kept when the owner's account is executable or would be left below its rent-exempt minimum. IKA is
kept when the destination is no longer an open token account of the IKA mint, or the vault is
frozen. The request still ends, the deposit stays open holding what was kept, and the owner can
request again.

A deposit whose request is pending still accepts a top-up, and the payout pays it out with the
rest. A top-up names no incarnation: it lands on whatever life is open when it executes.

Every network charge names the incarnation it is for. A charge that names another one, or reaches a
closed deposit, takes nothing and emits `GasChargeSkipped`. It never fails for that reason: the
delivery it rides still lands, a charge without delivery still creates its record, and a given-up
signature's voucher still closes. For now the network names the incarnation of the deposit state
its validators agreed when the charge is sent; it will name the incarnation the request was
admitted under.

The mock network sends no payout. On the devnet pre-alpha, funds put into a deposit stay there.
Put nothing into a pre-alpha deposit.

## Deposit minimums

The coordinator holds two minimums the network sets, each an (IKA, SOL) pair. Zero in a coin means
no minimum in that coin. Each coin is compared with its balance minus its debt.

- **The minimum first deposit** (`SetMinFirstDeposit`) is a minimum on the deposit's total.
  `CreateDeposit` and every `TopUp` must leave the balance net of debt at or above it. It is
  refundable: a withdrawal pays it back.
- **The minimum balance** (`SetMinBalance`) is the buffer for starting a new action. The network
  refuses a new request against a deposit below it. The program uses it for one check: each coin a
  `TopUp` adds must be zero or at least the minimum balance in that coin. `CreateDeposit` does not
  check it.

Anyone can top up any deposit, and each top-up changes the balance the validators read. With the
minimum balance on every top-up, each such change costs its sender at least that minimum, and the
amount stays in the deposit, to its owner's credit.

## The deposit fee

Every `CreateDeposit`, a reopen included, and every `TopUp` also pays the coordinator's deposit fee
in lamports. The fee pays for the network's work of agreeing the deposit's new state, and it is not
credited to the deposit. The network sets it with `SetDepositFee`, and the address that sent the
setting is the fee's recipient.

The `sol_amount` the call moves includes the fee. The program sends exactly the fee to the
recipient and credits the rest to the deposit. So an IKA-only top-up still carries the fee as its
`sol_amount`. A `sol_amount` below the fee is refused (`BelowDepositFee`, 4082). A top-up whose
`sol_amount` is only the fee credits nothing, so it is empty (`EmptyTopUp`). The minimum first
deposit and the minimum balance apply to the credited amount.

The call names the recipient as its last account. Another account is refused while a fee is set
(`InvalidDepositFeeRecipient`, 4083). With no fee set nothing is paid, the whole `sol_amount` is
credited, and any writable account stands in the slot.

## Deposit events

Every change of a deposit emits one event. Every one of them starts with the deposit's state after
the change. A reader that keeps the state of the highest `sequence` it has seen follows every
deposit without reading the accounts. The [Event Reference](../reference/events.md#gas-deposit-events)
lists each event's fields.

## Handing a deposit to a new owner

`TransferGasDeposit` names a new owner. The current owner signs it. A zero owner is refused with
`InvalidAuthority`, and any other signer with `AuthorityMismatch`. It is refused while a withdrawal
request is pending (`TransferWhileWithdrawalPending`, 4079): a request is final, and only the
network's payout ends it. It advances `sequence` and emits `GasDepositTransferred`. A pause does
not stop it.

## The account

The full layout is in the [Account Reference](../reference/accounts.md#gasdeposit-tag-99). The
fields a client reads most:

| Offset | Field | Meaning |
|---|---|---|
| 2 | `user_pubkey` | The request key |
| 34 | `ika_balance` | IKA available |
| 42 | `sol_balance` | Lamports available |
| 107 | `ika_debt` | IKA owed |
| 115 | `sol_debt` | Lamports owed |
| 131 | `owner` | The wallet that may withdraw: the signer of `CreateDeposit`, or the owner a `TransferGasDeposit` named since |
| 163 | `withdrawal_pending` | 1 while a withdrawal request waits for the network's payout |
