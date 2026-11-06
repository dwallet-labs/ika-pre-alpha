# Instruction Reference

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

This page lists the ika program's dWallet instructions. The first byte of an instruction's data
is the instruction's number. The rest is the instruction's own data, and it must be exactly the
length its layout gives. A shorter or longer instruction is refused with
`InvalidInstructionData`.

The SDKs build every instruction a user sends. The CPI crates build the ones a program sends.
You need this page to build an instruction yourself, or to read one in a transaction.

## Who sends what

Three kinds of signer send dWallet instructions.

- **A user or a program.** These are the instructions an integrator sends: vouchers, ownership,
  deposits, encryption keys and accepts. They are described in full below.
- **The network.** The network writes every result to the chain with its own transactions,
  signed by a network key (`NetworkEncryptionKey.noa_public_key`). They are listed in
  [Network instructions](#network-instructions).
- **The pauser.** One key may pause and unpause. See [Pauses](../on-chain/pauses.md).

| Number | Instruction | Sent by |
|---|---|---|
| 129 | `TransferOwnership` | the dWallet's owner |
| 130 | `CommitNetworkDkg` | the network |
| 131 | `CommitNetworkKeyReconfiguration` | the network |
| 132 | `CommitDWallet` | the network |
| 134 | `CommitEncryptedUserSecretKeyShare` | the network |
| 135 | `CommitPublicUserSecretKeyShare` | the network |
| 136 | `CreateDeposit` | anyone, with a proof from the request key |
| 137 | `TopUp` | anyone |
| 138 | `SettleGas` | the network |
| 140 | `CommitSignature` | the network |
| 141 | `RequestWithdraw` | the deposit's request key |
| 142 | `Withdraw` | the deposit's request key, with a release the network signed |
| 143 | `Initialize` | the program's upgrade authority, once at deployment |
| 144 | `AdvanceEpoch` | the network |
| 145 | `SettleGasWithoutDelivery` | the network |
| 147 | `Pause` | the pauser or the network |
| 148 | `Unpause` | the pauser or the network |
| 149 | `SetPauser` | the network |
| 150 | `SettleGasCharge` | the network |
| 151 | `PauseSigningParameter` | the pauser or the network |
| 152 | `UnpauseSigningParameter` | the pauser or the network |
| 153 | `RegisterEncryptionKey` | anyone, with a signature from the holder |
| 156 | `IssueSignatureVoucher` | the dWallet's owner |
| 157 | `SetVoucherSigningKey` | the voucher's owner |
| 158 | `RevokeSignatureVoucher` | the voucher's owner |
| 159 | `TransferSignatureVoucher` | the voucher's owner |
| 161 | `IssueFutureSignatureVoucher` | the dWallet's owner |
| 163 | `CommitPartialUserSignature` | the network |
| 164 | `SetChainIdentifier` | the network |
| 165 | `AcceptEncryptedUserShare` | anyone, with a signature from the holder |
| 228 | `EmitEvent` | the program itself, to emit an event |

Numbers 128, 133, 139, 146, 154, 155, 160 and 162 belonged to instructions that were removed.
They are refused, and they are never given to another instruction.

## Signer mode and program mode

The instructions that an owner sends work in two modes.

- **Signer mode.** The owner is a wallet, and it signs the transaction.
- **Program mode.** The owner is a program's CPI authority. The program calls the ika program
  through a CPI and signs for its CPI authority with `invoke_signed`.

The ika program tells the two apart by one account: when the account in a fixed slot is an
executable program, the instruction is in program mode, and it takes one more account. In
program mode the program checks that the CPI authority signed, that it is the address
`["__ika_cpi_authority"]` derived under the calling program, and that it equals the owner. See
[The CPI Framework](../on-chain/cpi-framework.md).

## Vouchers

### IssueSignatureVoucher (156)

Creates a `SignatureVoucher`: the right to have the network sign one message once, with one
dWallet. See [Signature Vouchers](../on-chain/signature-voucher.md).

Data, 67 to 131 bytes after the instruction number:

| Field | Size | Meaning |
|---|---|---|
| `message_digest` | 32 | The Keccak-256 of the message |
| `message_metadata_digest` | 32 | The Keccak-256 of the message's metadata, or 32 zeros for none |
| `signature_scheme` | 2 | The signature scheme number, little-endian |
| `flags` | 1 | Bit 1: an owner follows. Bit 2: a signing key follows. Any other bit is refused |
| `owner` | 32 | Only when bit 1 is set. The voucher's owner. Must not be all zeros |
| `signing_key` | 32 | Only when bit 2 is set. The key a sign request must be signed by |

Without an owner, the voucher's owner is the issuer. Without a signing key, the voucher has none
until its owner sets one.

Accounts in signer mode:

| # | Account | Writable | Signer | Meaning |
|---|---|---|---|---|
| 0 | coordinator | no | no | The `DWalletCoordinator` |
| 1 | signature_voucher | yes | yes | The new voucher's address. It must be empty and owned by the system program |
| 2 | dwallet | no | no | The dWallet |
| 3 | owner | no | yes | The dWallet's owner |
| 4 | payer | yes | yes | Pays the voucher's rent |
| 5 | system_program | no | no | The system program |

Accounts in program mode:

| # | Account | Writable | Signer | Meaning |
|---|---|---|---|---|
| 0 | coordinator | no | no | The `DWalletCoordinator` |
| 1 | signature_voucher | yes | yes | The new voucher's address |
| 2 | dwallet | no | no | The dWallet |
| 3 | caller_program | no | no | The calling program. Executable |
| 4 | cpi_authority | no | yes | The calling program's CPI authority |
| 5 | payer | yes | yes | Pays the voucher's rent |
| 6 | system_program | no | no | The system program |

It is refused when the dWallet is not Active (`InvalidDWalletState`, 4005), when the
coordinator is paused (`Paused`, 4030), or when the signer is not the dWallet's owner
(`MissingRequiredSignature`).

### IssueFutureSignatureVoucher (161)

Creates a `FutureSignatureVoucher`. Its data, its accounts and its checks are those of
`IssueSignatureVoucher`. Its signing key is the key step 1 must be signed by. See
[Future Signature Vouchers](../on-chain/future-signature-voucher.md).

### SetVoucherSigningKey (157), RevokeSignatureVoucher (158), TransferSignatureVoucher (159)

The voucher's owner changes the voucher. Each acts on a `SignatureVoucher` or a
`FutureSignatureVoucher`, chosen by the account's tag. None checks the pause, so an owner can
always narrow what a voucher allows.

| Instruction | Data | Effect |
|---|---|---|
| `SetVoucherSigningKey` | the new signing key, 32 bytes | Sets or replaces the key a request must be signed by |
| `RevokeSignatureVoucher` | none | Revokes the voucher for good |
| `TransferSignatureVoucher` | the new owner, 32 bytes, not all zeros | Gives the voucher to a new owner, in any state |

Accounts in signer mode: `signature_voucher` (writable), then `owner` (signer).

Accounts in program mode: `signature_voucher` (writable), `caller_program` (executable), then
`cpi_authority` (signer).

A signature voucher takes a new key, or a revoke, only while pending. A future voucher takes
them while open or partially signed. Otherwise the instruction fails with `VoucherNotPending`
(4059). A signer that is not the voucher's owner fails with `NotVoucherOwner` (4060).

## Ownership

### TransferOwnership (129)

Gives a dWallet to a new owner. The dWallet must be Active. The pause does not apply.

Data: the new owner, 32 bytes, not all zeros (`InvalidAuthority`, 4031).

Accounts in signer mode:

| # | Account | Writable | Signer |
|---|---|---|---|
| 0 | owner | no | yes |
| 1 | dwallet | yes | no |

Accounts in program mode:

| # | Account | Writable | Signer |
|---|---|---|---|
| 0 | caller_program | no | no |
| 1 | cpi_authority | no | yes |
| 2 | dwallet | yes | no |

## Gas deposits

See [Gas Deposits](../on-chain/gas-deposits.md) for what a deposit is and what the network
charges.

### CreateDeposit (136)

Creates the `GasDeposit` of one request key. The request key proves it agrees with an Ed25519
signature, checked by the Ed25519 precompile in an earlier instruction of the same transaction.
The signed message is:

```text
version (u16, 1) || "ika_protocol::gas::proof_of_possession" || chain_number (u32) ||
network (u8) || 32 || the signer's address (32)
```

All integers are little-endian. The chain number and the network are the coordinator's. The
signer is account 0, the wallet that creates the deposit. A paused coordinator refuses the
instruction (`Paused`, 4030).

Data, 97 bytes:

| Field | Size | Meaning |
|---|---|---|
| `user_pubkey` | 32 | The request key |
| `pop_signature` | 64 | The request key's signature over the message above |
| `bump` | 1 | The deposit's canonical bump |

Accounts:

| # | Account | Writable | Signer |
|---|---|---|---|
| 0 | signer | no | yes |
| 1 | gas_deposit, `["gas_deposit", user_pubkey]` | yes | no |
| 2 | coordinator | no | no |
| 3 | payer | yes | yes |
| 4 | system_program | no | no |
| 5 | instructions sysvar | no | no |

`createDepositInstructions` in `@ika.xyz/sdk-solana/instructions` builds the precompile
instruction and this one, in order.

### TopUp (137)

Adds IKA, SOL, or both to a deposit. Anyone may top up any deposit. A top-up that moves
nothing is refused (`EmptyTopUp`, 4038).

Data, 16 bytes: `ika_amount` (u64), then `sol_amount` (u64).

Accounts:

| # | Account | Writable | Signer | Meaning |
|---|---|---|---|---|
| 0 | gas_deposit | yes | no | The deposit |
| 1 | coordinator | no | no | Names the treasury vault and the IKA mint |
| 2 | user_token_account | yes | no | The IKA source. `payer` must be its owner |
| 3 | treasury_vault | yes | no | The coordinator's treasury vault |
| 4 | token_program | no | no | The SPL Token program |
| 5 | payer | yes | yes | Pays the SOL and owns the token account |
| 6 | system_program | no | no | The system program |

### RequestWithdraw (141) and Withdraw (142)

A deposit's request key takes its unspent funds back in two steps. `RequestWithdraw` records
the amounts. `Withdraw` pays them out, once the network has signed a release for that request.

`RequestWithdraw` data, 16 bytes: `ika_amount` (u64), then `sol_amount` (u64). Accounts: the
request key (signer), the deposit (writable), the coordinator.

`Withdraw` data, 72 bytes: `withdrawal_sequence` (u64), then the network's signature (64).
Accounts, in order: the request key (signer, writable), the deposit (writable), the coordinator,
the request key's IKA token account (writable), the treasury vault (writable), the vault
authority `["vault_authority"]`, the SPL Token program, the network key's
`NetworkEncryptionKey`, and the instructions sysvar. An Ed25519 precompile instruction with the
network's signature must come right before it. The signed release is:

```text
0xFF || "solana-gas-release" || program_id (32) || gas_deposit (32) || user_pubkey (32) ||
withdrawal_sequence (u64) || ika_amount (u64) || sol_amount (u64)
```

The mock network charges nothing and signs no release. On the devnet pre-alpha, a deposit's
funds stay where they are.

## Encryption keys and shares

See [Encrypted Shares](../on-chain/encrypted-shares.md) for the whole flow.

### RegisterEncryptionKey (153)

Creates a holder's `EncryptionKey` for one curve. Anyone may send it and pay for it. The
authority is the holder's Ed25519 signature over the registration message, in an Ed25519
precompile instruction right before this one. That precompile instruction must hold exactly one
signature. The program reads the encryption key from the signed message, never from this
instruction's data. A paused coordinator refuses it (`Paused`, 4030).

The registration message is the BCS encoding of: the version 1 as a u16, the domain
`ika_encryption_key` as a byte vector, the chain number (u32), the network (u8), the curve
(u16), and the encryption key as a byte vector. The chain number and the network are the
coordinator's.

Data, 36 bytes: `signer_public_key` (32), `signature_scheme` (1, always 0), `curve` (u16),
`bump` (1).

Accounts:

| # | Account | Writable | Signer |
|---|---|---|---|
| 0 | holder: the signer key as an address | no | no |
| 1 | encryption_key, `["encryption_key", holder, curve_le]` | yes | no |
| 2 | coordinator | no | no |
| 3 | payer | yes | yes |
| 4 | system_program | no | no |
| 5 | instructions sysvar | no | no |
| 6 | event authority, `["__event_authority"]` | no | no |
| 7 | the ika program | no | no |

One key exists per holder and curve. A second registration fails with
`AccountAlreadyInitialized`.

### AcceptEncryptedUserShare (165)

A holder accepts its encrypted share. Anyone may send it and pay for it. The authority is the
holder's Ed25519 signature over the share's `acceptance_digest`, in an Ed25519 precompile
instruction right before this one, holding exactly one signature. A paused coordinator refuses
it (`Paused`, 4030). It has no data.

Accounts:

| # | Account | Writable | Signer |
|---|---|---|---|
| 0 | coordinator | no | no |
| 1 | dwallet | yes | no |
| 2 | encrypted_share | yes | no |
| 3 | instructions sysvar | no | no |
| 4 | event authority | no | no |
| 5 | the ika program | no | no |

The checks, in order:

| Check | Error |
|---|---|
| The coordinator is not paused | `Paused` (4030) |
| The share belongs to the dWallet | `ShareOfAnotherDWallet` (4072) |
| The share is not accepted yet | `ShareAlreadyAccepted` (4073) |
| An Ed25519 precompile instruction comes right before | `InvalidAttestation` (4009) |
| It holds one signature, by the holder, over `acceptance_digest` | `InvalidAcceptanceSignature` (4074) |
| A first share: the dWallet waits for its holder or is Active. A re-encrypted share: the dWallet is Active | `InvalidDWalletState` (4005) |

## Network instructions

The network sends these with its own transactions. An integrator never sends them, but sees
their effects on chain.

| Number | Instruction | What it writes |
|---|---|---|
| 130 | `CommitNetworkDkg` | A new `NetworkEncryptionKey`, or the network's signature into an unsigned one |
| 131 | `CommitNetworkKeyReconfiguration` | A `NetworkReconfigurationOutput` for one key and epoch |
| 132 | `CommitDWallet` | A new `DWallet` and its creation attestation. The owner is the request's `intended_chain_sender` |
| 134 | `CommitEncryptedUserSecretKeyShare` | A holder's `EncryptedUserSecretKeyShare` and its attestation |
| 135 | `CommitPublicUserSecretKeyShare` | A dWallet's public share attestation. It makes a waiting dWallet Active |
| 138 | `SettleGas` | Charges a deposit for served requests |
| 140 | `CommitSignature` | A signature into a voucher. A pending or revoked `SignatureVoucher`, or a `FutureSignatureVoucher` that holds step 1's result |
| 144 | `AdvanceEpoch` | The coordinator's epoch |
| 145 | `SettleGasWithoutDelivery` | Charges for a signature the network gave up delivering, and closes its voucher with status 2 |
| 149 | `SetPauser` | The coordinator's pauser |
| 150 | `SettleGasCharge` | A `GasCharge` record, and the charge |
| 163 | `CommitPartialUserSignature` | Step 1's result into a `FutureSignatureVoucher` |
| 164 | `SetChainIdentifier` | A new chain identifier that applies at the next epoch |

A network instruction is valid only when it is signed by an active network key's
`noa_public_key`. On the devnet pre-alpha, the mock holds the one network key and sends these
transactions itself.
