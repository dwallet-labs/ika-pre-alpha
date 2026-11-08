# Pauses

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

The dWallet part of the ika program can be paused. A pause stops users from starting new things
on chain. It never stops the network from writing results. Your program needs to know this
because a CPI it makes can fail while the program is paused.

## The coordinator pause

The `DWalletCoordinator` holds a pause flag at offset 18. While it is 1, the program refuses five
instructions with `Paused` (4030):

- `CreateDeposit`
- `RegisterEncryptionKey`
- `AcceptEncryptedUserShare`
- `IssueSignatureVoucher`
- `IssueFutureSignatureVoucher`

Every other instruction ignores the flag. These keep working while paused:

- every instruction the network signs, so results already started are still written;
- `TopUp`, `RequestWithdraw` and `TransferGasDeposit`, so users can always fund, empty or hand
  over a deposit;
- `TransferOwnership` and the voucher owner's controls, so an owner can always move a dWallet or
  narrow a voucher.

A program whose instruction ends in an `issue_signature_voucher` CPI fails with 4030 while
paused. The whole transaction fails, so your program's own writes in it are undone. A
proposal that reaches its quorum during a pause stays open, and the deciding vote can be sent
again after the unpause.

Two keys can pause and unpause: the coordinator's pauser (offset 84), and the network. The flag
does not record who set it, so either can lift the other's pause. Only the network can change
who the pauser is, with `SetPauser`. An all-zero pauser means the network alone can pause.

The program starts paused. `Initialize` sets the flag, and the deployment lifts it once the
network's setup is done. The devnet pre-alpha is unpaused.

## Paused signing parameters

The coordinator also lists curves, signature algorithms and hash schemes that the network refuses
requests for (offsets 165 to 559). The pauser and the network add and remove entries with
`PauseSigningParameter` and `UnpauseSigningParameter`.

The program itself refuses nothing for these lists. The validators read them and refuse a request
that names a paused value. A voucher can still be issued for a paused scheme. It stays pending,
and a sign request sent after the scheme is unpaused can use it.
