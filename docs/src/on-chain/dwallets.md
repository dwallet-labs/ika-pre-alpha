# dWallet Accounts

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

A dWallet is a signing key on some chain, held jointly by its user and the ika network. On
Solana each dWallet has one account in the ika program, of type `DWallet`. The account records
the dWallet's public key, its curve, its state, and its owner. The owner is whoever may ask the
network to sign with the dWallet.

Nobody creates a `DWallet` account directly. A user asks the network for a new dWallet over
gRPC, and the network writes the account to Solana with its own transaction. On the devnet
pre-alpha the mock network writes it.

## What the account holds

| Offset | Field | Meaning |
|---|---|---|
| 2 | `owner` | Who controls the dWallet: a wallet, or a program's CPI authority |
| 34 | `curve` | The curve, as a u16 |
| 36 | `state` | 1 when Active. 3 while it waits for its holder to accept an encrypted share |
| 37 | `public_key_len` | The public key's length |
| 38 | `public_key` | The public key, padded to 65 bytes |
| 103 | `created_epoch` | The epoch it was created in |
| 111 | `noa_public_key` | The network key that holds the network's share |
| 143 | `is_imported` | 1 when the user imported an existing key |
| 153 | `session_identifier` | For an imported dWallet, the import request's session |

The account is 185 bytes, tag 97. The full table is in the
[Account Reference](../reference/accounts.md#dwallet-tag-97).

The owner decides everything that matters. Only the owner can issue a voucher for the dWallet,
and only the owner can give the dWallet to someone else. A program becomes a dWallet's owner when
the dWallet is given to the program's CPI authority, an address derived from the program. See
[The CPI Framework](./cpi-framework.md).

## Curves

| Curve | Number | Public key | Schemes it signs with |
|---|---|---|---|
| secp256k1 | 0 | 33 bytes, compressed | ECDSA with Keccak-256 (0), SHA-256 (1), double SHA-256 (2) or BLAKE2b-256 (4); Taproot (3) |
| secp256r1 | 1 | 33 bytes, compressed | ECDSA with SHA-256 (1) |
| Curve25519 | 2 | 32 bytes | EdDSA with SHA-512 (5) |
| Ristretto | 3 | 32 bytes | Schnorrkel (6) |

The numbers in brackets are signature scheme numbers. A voucher records one, and a sign request
names the same one. A scheme that does not sign on the dWallet's curve is refused by the
network.

## The address

The dWallet's address is derived from its curve and its public key. Write the curve as two
little-endian bytes, append the public key, and split the result into chunks of 32 bytes. These
chunks are the root.

- A generated dWallet is at `["dwallet", "record", root...]`.
- An imported dWallet is at `["dwallet", "imported_record", root..., session_identifier]`.

So a client finds a generated dWallet from its public key alone. In TypeScript,
`dwalletPda(programId, curve, publicKey)` from `@ika.xyz/pre-alpha-solana` derives it, and
`readDWallet(data)` reads the account.

## How a dWallet is created

A dWallet comes from a key generation between the user and the network. The user computes its
half of the key, and the network computes the other half. The user keeps a secret share. The
network keeps its own share, which no single party holds.

The user's share is kept in one of two ways:

- **Encrypted.** The share is encrypted to an encryption key of the user's, and the network
  stores only the encrypted copy. The network cannot sign without the user's help. This is the
  zero-trust form.
- **Public.** The user reveals its share to the network. The network can then sign alone. This
  form trusts the network.

The steps for an encrypted share:

1. The user registers its encryption key on chain for the curve, with `RegisterEncryptionKey`.
   It does this once per curve.
2. The user sends a key generation request (`Dkg`) over gRPC, with its half of the key and its
   encrypted share.
3. The network runs its half and answers with an attestation: a record of the new dWallet that
   the network signed.
4. The network writes the dWallet to Solana with `CommitDWallet`, and the encrypted share with
   `CommitEncryptedUserSecretKeyShare`, in one transaction. The dWallet's state is 3: it waits
   for its holder.
5. The holder checks the share and accepts it on chain with `AcceptEncryptedUserShare`. The
   dWallet becomes Active.

With a public share, step 1 and step 5 do not happen. The network writes the dWallet Active and
then writes the public share.

The details of steps 1, 4 and 5 are in [Encrypted Shares](./encrypted-shares.md). The SDKs do
all five steps in one call. On the devnet pre-alpha the SDK must run in mock mode, and the mock
makes the dWallet's key itself.

## Who the owner is at creation

The network sets the owner to the request's `intended_chain_sender`: the 32-byte Solana address
the user named in its signed request. The SDKs put the user's wallet there. The program refuses
an all-zero owner, and the mock refuses a request that names one.

## Changing the owner

`TransferOwnership` gives the dWallet to a new owner. The current owner signs it, either as a
wallet or as a program through its CPI authority. The dWallet must be Active. The new owner
must not be all zeros.

To give a dWallet to a program, transfer it to the program's CPI authority:

```rust
let (cpi_authority, _bump) =
    Pubkey::find_program_address(&[b"__ika_cpi_authority"], &your_program_id);
```

After the transfer, only that program can issue vouchers for the dWallet or move it again.
Decide before the transfer who inside your program may ask for a signature. After the transfer
the user no longer signs for the dWallet, so it cannot set that up any more. See
[Integrator Invariants](./integrator-invariants.md).

A voucher issued before a transfer stays valid after it. It belongs to the voucher's owner, not
to the dWallet's.

## Reading a dWallet from a program

A program that reads a `DWallet` account must check that it is real before it reads `owner`:

1. The account is owned by the ika program. Compare the account's owner with `ID` of the CPI
   crate, the ika program of the network you built for. Never compare it with a program account
   the caller passed.
2. Byte 0 is 97.
3. The account is 185 bytes long.

Then read `owner` at offset 2 and `state` at offset 36.
