# Event Reference

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

The ika program emits an event by calling itself. The call is the program's `EmitEvent`
instruction (number 228), signed by the program's event authority, `["__event_authority"]`.
The event's bytes are that instruction's data. So an event appears in a transaction as an inner
instruction of the ika program, and it cannot be lost to a truncated log. Only the program can
emit one, because `EmitEvent` refuses any call its event authority did not sign.

## The bytes of an event

An event's data has three parts:

```text
tag (8) || event number (1) || the event's fields
```

The tag is the eight bytes `e4 45 a5 2e 51 cb 9a 1d`. They are the tag Anchor uses for its own
events, so a reader that parses Anchor events finds these too. The event number names the event.
The fields follow in the order the tables below give. Integers are little-endian.

To read the events of a transaction:

1. Fetch the transaction with its inner instructions.
2. Keep the inner instructions whose program is the ika program.
3. Keep those whose data starts with the eight tag bytes.
4. Read the event number, then the fields.

Check that the transaction succeeded before you act on an event. A failed transaction can still
show inner instructions that ran before the failure.

## No event for a voucher or a signature

Issuing a voucher emits no event, and neither does writing its signature. To learn that a
signature is ready, read the voucher account. Its `status` at offset 173 becomes 1, and its
signature is at offset 176. See [Signature Vouchers](../on-chain/signature-voucher.md#reading-the-signature).

## dWallet events

| Number | Event | Emitted by |
|---|---|---|
| 113 | `DWalletCommitted` | `CommitDWallet` |
| 114 | `EncryptedShareCommitted` | `CommitEncryptedUserSecretKeyShare` |
| 115 | `PublicShareCommitted` | `CommitPublicUserSecretKeyShare` |
| 118 | `EncryptionKeyRegistered` | `RegisterEncryptionKey` |
| 123 | `EncryptedShareAccepted` | `AcceptEncryptedUserShare` |
| 124 | `GasChargedWithoutDelivery` | `SettleGasCharge` |
| 125 | `DWalletActivated` | `AcceptEncryptedUserShare` or `CommitPublicUserSecretKeyShare` |
| 126 | `GasDepositTransferred` | `TransferGasDeposit` |

The gas deposit events, 106 to 108 and 126 to 132, are listed in
[Gas deposit events](#gas-deposit-events).

### DWalletCommitted (113)

The network created a dWallet.

| Field | Size | Meaning |
|---|---|---|
| `dwallet` | 32 | The new dWallet's address |
| `attestation_proof` | 98 | The network's proof over the dWallet's attestation |
| `attestation_fields` | rest | The attestation's fields, as the attestation account stores them |

### EncryptedShareCommitted (114)

The network stored a holder's encrypted share.

| Field | Size | Meaning |
|---|---|---|
| `encrypted_share` | 32 | The share account's address |
| `dwallet` | 32 | The dWallet |
| `encryption_key_owner` | 32 | The holder |
| `source_share` | 32 | The share it was re-encrypted from. Zero for a first share |
| `is_re_encrypted` | 1 | 0 or 1 |
| `created_epoch` | 8 | The epoch |
| `acceptance_digest` | 32 | The digest the holder signs to accept |
| `attestation_proof` | 98 | The network's proof over the share's attestation |
| `encrypted_share_len` | 2 | The length of the next field |
| `encrypted_share` | varies | The encrypted share |
| `attestation_fields` | rest | The share attestation's fields |

### PublicShareCommitted (115)

The network stored a dWallet's public share. If the dWallet waited for its holder,
`DWalletActivated` comes first.

| Field | Size | Meaning |
|---|---|---|
| `dwallet` | 32 | The dWallet |
| `attestation_proof` | 98 | The network's proof over the public share's attestation |
| `attestation_fields` | rest | The attestation's fields, the public share included |

### EncryptionKeyRegistered (118)

| Field | Size | Meaning |
|---|---|---|
| `encryption_key_entry` | 32 | The `EncryptionKey` account's address |
| `signer_public_key` | 32 | The holder |
| `signature_scheme` | 1 | 0, Ed25519 |
| `curve` | 2 | The curve |
| `epoch` | 8 | The epoch |
| `signature` | 64 | The holder's signature over the registration message |
| `encryption_key_len` | 2 | The length of the next field |
| `encryption_key` | varies | The registered encryption key |

### EncryptedShareAccepted (123)

| Field | Size | Meaning |
|---|---|---|
| `encrypted_share` | 32 | The share account's address |
| `dwallet` | 32 | The dWallet |
| `encryption_key_owner` | 32 | The holder |
| `acceptance_digest` | 32 | The digest the holder signed |
| `acceptance_signature` | 64 | The holder's signature |
| `dwallet_state` | 1 | The dWallet's state afterwards: always 1, Active |

### DWalletActivated (125)

A dWallet moved from waiting for its holder to Active. A dWallet emits it at most once. A
dWallet created Active never emits it.

| Field | Size | Meaning |
|---|---|---|
| `dwallet` | 32 | The dWallet |

### GasChargedWithoutDelivery (124)

The network charged a deposit for work it delivered nothing for. With reason 1 or 2, it also
says that a dWallet or share commit ended without being written. Then no dWallet or share was
created for that session, and there is nothing to accept.

| Field | Size | Meaning |
|---|---|---|
| `charge_id` | 32 | The charge's id |
| `user_pubkey` | 32 | The deposit charged |
| `ika_amount` | 8 | The IKA charged |
| `sol_amount` | 8 | The lamports charged |
| `epoch` | 8 | The epoch |
| `reason` | 1 | 0 a plain charge, 1 a dWallet commit ended, 2 a share commit ended |
| `ended_session_identifier` | 32 | The ended commit's session. Zeros for reason 0 |

## Gas deposit events

Every instruction that changes a gas deposit emits one event. Each one starts with the deposit's
state after the change, 90 bytes:

| Field | Size | Meaning |
|---|---|---|
| `user_pubkey` | 32 | The deposit's request key |
| `sequence` | 8 | The deposit's `sequence` after the change. It grows by one on every change, so a reader applies a state only when its `sequence` is above the one it holds |
| `withdrawal_sequence` | 8 | The withdrawal counter |
| `ika_balance` | 8 | The IKA balance |
| `sol_balance` | 8 | The lamport balance |
| `ika_debt` | 8 | The IKA debt |
| `sol_debt` | 8 | The lamport debt |
| `withdrawal_pending` | 1 | 1 while a withdrawal request waits for the network's payout |
| `incarnation` | 8 | The deposit's life: 1 at the first create, one more at each reopen |
| `closed` | 1 | 1 once a payout that paid everything ended the deposit's life |

The fields that follow the state, per event:

| Number | Event | Emitted by | Fields after the state |
|---|---|---|---|
| 127 | `GasDepositCreated` | `CreateDeposit` | owner (32), IKA added (8), lamports added (8), epoch (8) |
| 106 | `GasDeposited` | `TopUp` | IKA added (8), lamports added (8), epoch (8) |
| 128 | `GasWithdrawalRequested` | `RequestWithdraw` | owner (32), IKA destination (32), epoch (8) |
| 108 | `GasSettled` | every charge: `SettleGas`, `SettleGasWithoutDelivery`, `SettleGasCharge` (after its `GasChargedWithoutDelivery`) and `SettleGasWithdrawal` | IKA charged (8), lamports charged (8), IKA collected (8), lamports collected (8), epoch (8). The charge collects the debt first, then the new amounts, up to the balance. What it cannot collect becomes debt, which the state shows |
| 107 | `GasWithdrawn` | a `SettleGasWithdrawal` that pays | owner (32), IKA destination (32), IKA paid (8), lamports paid (8), IKA kept (8), lamports kept (8), epoch (8). Kept is what a destination could not take. It stays in the deposit |
| 129 | `WithdrawalShortOfCharge` | a `SettleGasWithdrawal` for a pending request whose balance is below its debt plus the charge, in either coin. It takes and pays nothing, and the request stays pending | the message's withdrawal counter (8), IKA charge (8), lamport charge (8), epoch (8) |
| 133 | `GasChargeSkipped` | a charge (`SettleGas`, `SettleGasCharge`, `SettleGasWithoutDelivery` or `SettleGasWithdrawal`) that names another incarnation than the deposit's, or reaches a closed deposit. It took nothing | incarnation named (8), IKA asked for (8), lamports asked for (8), epoch (8) |
| 132 | `WithdrawalNotPaid` | a `SettleGasWithdrawal` that names a counter with no pending request. Only a payout ends a request, so the network sends such a payout only by mistake. The withdrawal was charged, after its `GasSettled`, and nothing was paid | the message's withdrawal counter (8), epoch (8) |
| 126 | `GasDepositTransferred` | `TransferGasDeposit` | the deposit's address (32), the previous owner (32), the new owner (32) |

## Network and coordinator events

These record what the network and the pauser changed. An integrator rarely needs them.

| Number | Event | Fields |
|---|---|---|
| 110 | `NetworkKeyRegistered` | `noa_public_key` (32), `dkg_output_digest` (32), `created_epoch` (8) |
| 111 | `SigningParameterPaused` | kind (1: 0 curve, 1 algorithm, 2 hash), value (u32), revision (u64) |
| 112 | `SigningParameterUnpaused` | the same fields |
| 116 | `DWalletPauserSet` | `pauser` (32, zeros for none), `protocol_version` (8) |
| 117 | `NetworkKeyReconfigurationCommitted` | `noa_public_key` (32), `epoch` (8), `reconfig_output_digest` (32), proof length (1), proof (98) |
| 119 | `NetworkKeyDkgSigned` | `noa_public_key` (32), `dkg_output_digest` (32), proof length (1), proof (98) |
| 120 | `EpochAdvanced` | `epoch` (8) |
| 121 | `ChainIdentifierStaged` | length (1), the identifier, the epoch it applies at (8), `protocol_version` (8) |
| 122 | `ChainIdentifierApplied` | length (1), the identifier, the epoch it applied at (8) |
| 130 | `MinFirstDepositSet` | IKA minimum (8, zero for none), lamport minimum (8, zero for none), `protocol_version` (8). Emitted by `SetMinFirstDeposit` |
| 131 | `MinBalanceSet` | the same fields. Emitted by `SetMinBalance` |
| 134 | `DepositFeeSet` | the fee in lamports (8, zero for none), the recipient (32), `protocol_version` (8). Emitted by `SetDepositFee` |

The program emits other events for the network's own operation. They are not listed here.
