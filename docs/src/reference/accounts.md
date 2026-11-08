# Account Reference

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

This page lists the byte layout of every account the ika program keeps for dWallets. Use it to
read an account from a client or from your own program. The program also keeps accounts for the
network's own operation. An integrator does not read them, so they are not listed here.

## How to read an account

Every account starts with a two-byte header. Byte 0 is the account type's tag, and byte 1 is
the layout version. Every layout is version 1. All integers are little-endian. A key is 32 raw
bytes.

Before you trust an account's bytes, check three things:

1. The account's owner is the ika program.
2. Byte 0 is the tag of the type you expect.
3. The account's length is the type's length. A type marked "header" below has a fixed part
   and then data of varying length, so check that the account is at least that long.

Every account type has the same owner, the ika program. So the owner check alone does not
tell you which type an account is. The tag does.

| Account | Tag | Length in bytes | Address |
|---|---|---|---|
| `DWalletCoordinator` | 96 | 727 | `["dwallet_coordinator"]` |
| `DWallet` | 97 | 185 | see [The dWallet's address](#the-dwallets-address) |
| `NetworkEncryptionKey` | 98 | 199 | `["network_encryption_key", noa_public_key]` |
| `GasDeposit` | 99 | 205 | `["gas_deposit", user_pubkey]` |
| `EncryptedUserSecretKeyShare` | 101 | header 214 | `["dwallet", "encrypted_user_share", root, holder]` |
| `NetworkReconfigurationOutput` | 102 | 182 | `["network_reconfig", noa_public_key, epoch_le]` |
| `DWalletAttestation` | 104 | header 101 | see [Attestation accounts](#dwalletattestation-tag-104) |
| `GasCharge` | 106 | 91 | `["gas_charge", charge_id]` |
| `GasWithdrawalCharge` | 112 | 67 | `["gas_withdrawal_charge", user_pubkey, withdrawal_sequence_le]` |
| `EncryptionKey` | 107 | header 120 | `["encryption_key", signer_public_key, curve_le]` |
| `SignatureVoucher` | 108 | 304 | none: a fresh address the issuer picks |
| `FutureSignatureVoucher` | 109 | 1941 | none: a fresh address the issuer picks |

Every address in the table is a program-derived address (PDA) of the ika program, with the
seeds listed. `epoch_le` is the epoch as eight little-endian bytes. `curve_le` is the curve as
two little-endian bytes. The SDK carries a table of every tag, seed and instruction byte an integrator uses, in
`sdk/solana/src/wire-tables-data.ts`.

## The dWallet's address

A dWallet's address is derived from its curve and its public key. Take the curve as two
little-endian bytes and append the public key. Split that buffer into chunks of 32 bytes, the
most one Solana seed may hold. Each chunk is one seed. We call this list of chunks the root.

| Public key | Buffer | Chunks |
|---|---|---|
| 32 bytes (Curve25519, Ristretto) | 34 bytes | 32, 2 |
| 33 bytes (compressed secp256k1, secp256r1) | 35 bytes | 32, 3 |

A dWallet made by key generation lives at `["dwallet", "record", root...]`.

An imported dWallet lives at `["dwallet", "imported_record", root..., session_identifier]`.
The session identifier is the one of the import request that created it, and the dWallet
stores it at offset 153. The same key can be imported more than once. Each import makes its own
dWallet, so the identifier is part of the address.

Every account that belongs to one dWallet starts its seeds with `"dwallet"`, then a word that
names the account's kind, then the root. The kind comes before the root on purpose. A root has
no fixed length, so a word after it could be read as part of a longer root, and two kinds of
account could get one address.

## DWalletCoordinator (tag 96)

One account for the whole program, at `["dwallet_coordinator"]`. It holds the epoch, the pause
and this deployment's fixed values.

| Offset | Field | Size | Meaning |
|---|---|---|---|
| 2 | `epoch` | 8 | The network's epoch on this chain. Only the network moves it, with `AdvanceEpoch` |
| 10 | `total_dwallets_created` | 8 | How many dWallets `CommitDWallet` has created |
| 18 | `paused` | 1 | 1 while the program is paused. See [Pauses](../on-chain/pauses.md) |
| 19 | `bump` | 1 | This account's bump |
| 20 | `ika_mint` | 32 | The IKA token's mint |
| 52 | `treasury_vault` | 32 | The token account that holds every deposit's IKA |
| 84 | `pauser` | 32 | The key that may pause and unpause. All zeros means no pauser |
| 116 | `chain_identifier_len` | 1 | The length of the next field |
| 117 | `chain_identifier` | 40 | This chain's ERC-7930 chain identifier, padded with zeros |
| 157 | `collected_ika` | 8 | IKA the network has charged and not yet paid to stakers |
| 165 | `paused_signing_parameters` | 395 | The curves, algorithms and hashes the network refuses. See below |
| 560 | `pauser_protocol_version` | 8 | The protocol version that last set `pauser` |
| 568 | `vault_authority_bump` | 1 | The bump of `["vault_authority"]`, which owns `treasury_vault` |
| 569 | `chain_number` | 4 | This chain's fixed number. Signed messages name it |
| 573 | `pending_chain_identifier_len` | 1 | The length of the next field. Zero when nothing waits |
| 574 | `pending_chain_identifier` | 40 | A new chain identifier that waits for an epoch |
| 614 | `pending_chain_identifier_effective_epoch` | 8 | The epoch the waiting identifier applies at |
| 622 | `chain_identifier_protocol_version` | 8 | The protocol version that last set a waiting identifier |
| 630 | `network` | 1 | 1 mainnet, 2 testnet, 3 a local or test network |
| 631 | `min_first_deposit_ika` | 8 | The minimum first deposit in IKA's smallest unit. `CreateDeposit` and every `TopUp` must leave the balance net of debt at or above it. Zero is no minimum |
| 639 | `min_first_deposit_sol` | 8 | The same minimum in lamports |
| 647 | `min_first_deposit_protocol_version` | 8 | The protocol version that last set it. `SetMinFirstDeposit` refuses one not above it |
| 655 | `min_balance_ika` | 8 | The minimum balance net of debt to start a new action, in IKA's smallest unit. The network enforces it on requests. The program checks only that a `TopUp`'s IKA amount is zero or at least it |
| 663 | `min_balance_sol` | 8 | The same minimum in lamports |
| 671 | `min_balance_protocol_version` | 8 | The protocol version that last set it. `SetMinBalance` refuses one not above it |

The paused signing parameters, from offset 165:

| Offset | Field | Size | Meaning |
|---|---|---|---|
| 165 | `revision` | 8 | Counts every change to the three lists |
| 173 | `curves_len` | 1 | How many entries of the next list are in use |
| 174 | `curves` | 128 | Up to 32 curve numbers, four bytes each |
| 302 | `signature_algorithms_len` | 1 | As above |
| 303 | `signature_algorithms` | 128 | Up to 32 signature algorithm numbers |
| 431 | `hash_schemes_len` | 1 | As above |
| 432 | `hash_schemes` | 128 | Up to 32 hash scheme numbers |

On the devnet pre-alpha the coordinator holds chain number 1 and network 3.

## DWallet (tag 97)

| Offset | Field | Size | Meaning |
|---|---|---|---|
| 2 | `owner` | 32 | Who controls the dWallet: a wallet, or a program's CPI authority |
| 34 | `curve` | 2 | 0 secp256k1, 1 secp256r1, 2 Curve25519, 3 Ristretto |
| 36 | `state` | 1 | See the states below |
| 37 | `public_key_len` | 1 | The length of the public key |
| 38 | `public_key` | 65 | The dWallet's public key, padded with zeros |
| 103 | `created_epoch` | 8 | The epoch the dWallet was created in |
| 111 | `noa_public_key` | 32 | The network key that holds the network's share of this dWallet |
| 143 | `is_imported` | 1 | 1 for an imported key, 0 for a generated one |
| 144 | `bump` | 1 | This account's bump |
| 145 | `_reserved` | 8 | Zero |
| 153 | `session_identifier` | 32 | An imported dWallet's import session. Zero for a generated one |

The states:

| Value | State | Meaning |
|---|---|---|
| 0 | `DKGInProgress` | Not written by the current program |
| 1 | `Active` | Usable: vouchers can be issued and the owner can be changed |
| 2 | `Frozen` | Not written by the current program |
| 3 | `AwaitingKeyHolderSignature` | Created with an encrypted share that its holder has not accepted yet |

A dWallet only moves from 3 to 1. See [Encrypted Shares](../on-chain/encrypted-shares.md).

## NetworkEncryptionKey (tag 98)

The record of one network key. The network's address on Solana for that key is
`noa_public_key`: every transaction the network sends for the key is signed by it.

| Offset | Field | Size | Meaning |
|---|---|---|---|
| 2 | `noa_public_key` | 32 | The key's Ed25519 public key, and the network's signing address |
| 34 | `state` | 1 | 0 waiting for its key generation, 1 active, 2 waiting for a reconfiguration, 3 active after a reconfiguration |
| 35 | `created_epoch` | 8 | The epoch the record was created in |
| 43 | `last_reconfig_epoch` | 8 | The highest epoch with a reconfiguration record. 0 if none |
| 51 | `dkg_output_digest` | 32 | The Blake2b-256 digest of the key's network key-generation output |
| 83 | `bump` | 1 | This account's bump |
| 84 | `_reserved` | 16 | Zero |
| 100 | `dkg_output_proof_len` | 1 | The length of the next field. 0 while the record is unsigned |
| 101 | `dkg_output_proof` | 98 | The network's signature over this record |

## NetworkReconfigurationOutput (tag 102)

One per network key and epoch in which the key was reconfigured.

| Offset | Field | Size | Meaning |
|---|---|---|---|
| 2 | `noa_public_key` | 32 | The network key |
| 34 | `epoch` | 8 | The epoch of the reconfiguration |
| 42 | `reconfig_output_digest` | 32 | The Blake2b-256 digest of the reconfiguration's output |
| 74 | `reconfiguration_output_proof_len` | 1 | The length of the next field. 0 while unsigned |
| 75 | `reconfiguration_output_proof` | 98 | The network's signature over this record |
| 173 | `bump` | 1 | This account's bump |
| 174 | `_reserved` | 8 | Zero |

## GasDeposit (tag 99)

One per request key: the Ed25519 key that signs the user's gRPC requests. The wallet that
creates it owns it (`owner`). Only the owner requests a withdrawal, which the network then pays;
the request key only pays for requests. See [Gas Deposits](../on-chain/gas-deposits.md).

| Offset | Field | Size | Meaning |
|---|---|---|---|
| 2 | `user_pubkey` | 32 | The request key this deposit pays for |
| 34 | `ika_balance` | 8 | IKA available for request fees, in IKA's smallest unit |
| 42 | `sol_balance` | 8 | Lamports available for the network's own transactions |
| 50 | `total_ika_deposited` | 8 | All IKA ever added |
| 58 | `total_ika_consumed` | 8 | All IKA ever charged |
| 66 | `total_sol_deposited` | 8 | All lamports ever added |
| 74 | `total_sol_consumed` | 8 | All lamports ever charged |
| 82 | `withdrawal_sequence` | 8 | Counts withdrawal requests. Nothing else advances it |
| 90 | `last_settlement_epoch` | 8 | The epoch of the last charge |
| 98 | `created_epoch` | 8 | The epoch the deposit was created in |
| 106 | `bump` | 1 | This account's bump |
| 107 | `ika_debt` | 8 | IKA charged beyond the balance. The next charge takes it first |
| 115 | `sol_debt` | 8 | Lamports charged beyond the balance |
| 123 | `sequence` | 8 | Counts every change to the account. 1 at creation |
| 131 | `owner` | 32 | The deposit's owner: the wallet that signed `CreateDeposit`, or the owner a `TransferGasDeposit` named since |
| 163 | `withdrawal_pending` | 1 | 1 while a withdrawal request waits for the network's payout |
| 164 | `ika_destination` | 32 | The token account the pending request's IKA is paid to. Zeros when none is pending |

A request advances `withdrawal_sequence` and `sequence`. The payout, top-ups and charges advance
only `sequence`.

## GasCharge (tag 106)

A record the network writes when it charges for work it delivered nothing for. Its address is
derived from the charge's id, so the same charge is written only once.

| Offset | Field | Size | Meaning |
|---|---|---|---|
| 2 | `charge_id` | 32 | The charge's id |
| 34 | `user_pubkey` | 32 | The deposit charged |
| 66 | `ika_amount` | 8 | The IKA asked for |
| 74 | `sol_amount` | 8 | The lamports asked for, this record's rent included |
| 82 | `epoch` | 8 | The epoch of the charge |
| 90 | `bump` | 1 | This account's bump |

## GasWithdrawalCharge (tag 112)

The record of one withdrawal's charge. Its address is derived from the deposit's request key and
the withdrawal counter the request was made at. `SettleGasWithdrawal` writes it when it takes the
withdrawal's charge and pays the deposit out, or when it charges a request that is no longer
pending. Nothing closes it, so a second payout of the same request is refused. A payout short of
its charge writes none.

| Offset | Field | Size | Meaning |
|---|---|---|---|
| 2 | `user_pubkey` | 32 | The deposit charged |
| 34 | `withdrawal_sequence` | 8 | The withdrawal counter the request was made at |
| 42 | `ika_amount` | 8 | The IKA charged |
| 50 | `sol_amount` | 8 | The lamports charged, this record's rent included |
| 58 | `epoch` | 8 | The epoch the payout landed in |
| 66 | `bump` | 1 | This account's bump |

## SignatureVoucher (tag 108)

The right to one signature. See [Signature Vouchers](../on-chain/signature-voucher.md).

| Offset | Field | Size | Meaning |
|---|---|---|---|
| 2 | `dwallet` | 32 | The dWallet's address |
| 34 | `message_digest` | 32 | The Keccak-256 of the message |
| 66 | `message_metadata_digest` | 32 | The Keccak-256 of the message's metadata, or zeros for none |
| 98 | `owner` | 32 | Who controls the voucher |
| 130 | `signature_scheme` | 2 | The signature scheme number |
| 132 | `has_signing_key` | 1 | 1 when `signing_key` is set |
| 133 | `signing_key` | 32 | The Ed25519 key a sign request must be signed by |
| 165 | `issued_epoch` | 8 | The epoch the voucher was issued in |
| 173 | `status` | 1 | 0 pending, 1 signed, 2 closed by a charge, 3 revoked |
| 174 | `signature_len` | 2 | The signature's length. 0 while none is stored |
| 176 | `signature` | 128 | The signature, padded with zeros |

## FutureSignatureVoucher (tag 109)

The right to one signature made in two steps. See
[Future Signature Vouchers](../on-chain/future-signature-voucher.md).

| Offset | Field | Size | Meaning |
|---|---|---|---|
| 2 to 172 | | | The same fields as `SignatureVoucher`, at the same offsets |
| 173 | `status` | 1 | 0 open, 1 partially signed, 2 signed, 3 closed by a charge, 4 revoked |
| 174 | `attestation_proof` | 98 | The network's signature over step 1's result |
| 272 | `has_partial_signature` | 1 | 1 once step 1 wrote its result |
| 273 | `attestation_len` | 2 | The length of the next field's content |
| 275 | `attestation` | 1536 | Step 1's result, padded with zeros |
| 1811 | `signature_len` | 2 | The signature's length. 0 while none is stored |
| 1813 | `signature` | 128 | The signature, padded with zeros |

## EncryptedUserSecretKeyShare (tag 101)

One holder's encrypted copy of the user's share of a dWallet. The fixed part is 214 bytes. The
encrypted share follows it, `encrypted_share_len` bytes long. See
[Encrypted Shares](../on-chain/encrypted-shares.md).

| Offset | Field | Size | Meaning |
|---|---|---|---|
| 2 | `dwallet` | 32 | The dWallet the share belongs to |
| 34 | `encryption_key_owner` | 32 | The holder: the Ed25519 key whose registered encryption key encrypts the share |
| 66 | `source_share` | 32 | The share this one was re-encrypted from. Zero for the first share |
| 98 | `is_re_encrypted` | 1 | 1 for a re-encrypted share |
| 99 | `created_epoch` | 8 | The epoch the share was stored in |
| 107 | `bump` | 1 | This account's bump |
| 108 | `accepted` | 1 | 1 once the holder accepted the share |
| 109 | `_reserved` | 7 | Zero |
| 116 | `encrypted_share_len` | 2 | The length of the encrypted share after offset 214 |
| 118 | `acceptance_signature` | 64 | The holder's acceptance signature. Zero until accepted |
| 182 | `acceptance_digest` | 32 | The digest the holder signs to accept |
| 214 | encrypted share | varies | The encrypted share and its proof |

An imported dWallet's share lives at
`["dwallet", "imported_encrypted_user_share", root..., session_identifier, holder]`.

## EncryptionKey (tag 107)

A holder's registered encryption key for one curve. The fixed part is 120 bytes. The
encryption key follows it, `encryption_key_len` bytes long.

| Offset | Field | Size | Meaning |
|---|---|---|---|
| 2 | `signer_public_key` | 32 | The holder's Ed25519 key |
| 34 | `signature_scheme` | 1 | 0, Ed25519, the only scheme accepted |
| 35 | `curve` | 2 | The curve the encryption key is for |
| 37 | `encryption_key_len` | 2 | The length of the key after offset 120 |
| 39 | `signature` | 64 | The holder's signature over the registration message |
| 103 | `created_epoch` | 8 | The epoch the key was registered in |
| 111 | `bump` | 1 | This account's bump |
| 112 | `_reserved` | 8 | Zero |
| 120 | encryption key | varies | The encryption key |

## DWalletAttestation (tag 104)

A record of something the network signed about a dWallet. Each has a 101-byte header, then the
attested fields.

| Offset | Field | Size | Meaning |
|---|---|---|---|
| 2 | `bump` | 1 | This account's bump |
| 3 | `attestation_proof` | 98 | The network's proof: a variant byte (0), the attestation's version (0), the signing network key (32) and the signature (64) |
| 101 | fields | varies | The attested fields, in order. The session identifier comes first |

One account per kind:

| Kind | Address |
|---|---|
| The dWallet's creation | `["dwallet", "attestation", root...]` |
| An imported dWallet's creation | `["dwallet", "imported_attestation", root..., session_identifier]` |
| An encrypted share | `["dwallet", "encrypted_share_attestation", root..., holder]` |
| The public share | `["dwallet", "public_user_share", root...]` |

The imported dWallet's encrypted share and public share have the same pattern with the words
`imported_enc_share_attestation` and `imported_public_user_share`, and the session identifier
after the root.

The program stores these accounts and never reads them. A client reads them to check what the
network signed. To check one, rebuild the attestation's bytes from the fields, rebuild the
message the network signed, and verify the signature under a network key you trust. [Response
Types](../grpc/response-types.md) describes the attestations and the signed message. The SDKs
do this check for you.
