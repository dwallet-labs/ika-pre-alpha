# Core Concepts

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

This page explains the terms the rest of the guide uses. Each section starts with what the thing is,
then says where it lives and who changes it. The byte layouts are in the
[account reference](../reference/accounts.md).

## dWallet

A dWallet is a signing key that a Solana account controls. Its `DWallet` account on Solana holds the
public key, the curve and the owner.

On the real network, the private key never exists in one place. It is split into two shares. The
user holds one share, and the validators hold the other between them. Neither side can sign alone:
a signature needs both, through the 2PC-MPC protocol. In the devnet pre-alpha, the mock holds the
whole key instead.

A dWallet can sign for any chain whose signature scheme it supports. The curve decides which schemes
those are. See [Curves and signature schemes](#curves-and-signature-schemes) below.

A new dWallet goes through these states, and only forward:

1. **Awaiting the key holder's signature.** The network has written the dWallet and left the user's
   share waiting on Solana, encrypted to the user's encryption key.
2. **Active.** The user accepted the share in a Solana transaction (`AcceptEncryptedUserShare`), or
   the user's share was made public. Only an active dWallet can get a voucher or be transferred.

## Owner

The owner of a dWallet decides which messages it signs, because only the owner can issue a voucher
for it. The owner is one of two things:

- **A wallet.** The user signs the voucher's transaction directly. This is how a dWallet starts: its
  creator owns it.
- **A program's CPI authority.** A program owns the dWallet and issues vouchers through a CPI.

The owner transfers a dWallet with the `TransferDWallet` instruction.

## CPI authority

A program's CPI authority is the address derived from the seed `__ika_cpi_authority` under the
program's id. Only that program can sign for it.

When a dWallet's owner is a program's CPI authority, only that program can issue vouchers for it. The
ika program checks the CPI caller to make sure.

A program has one CPI authority, and every dWallet handed to the program shares it. So the ika
program cannot tell which of your dWallets a request is meant for. Your program must bind each
voucher to the right dWallet itself. See [Integrator Invariants](../on-chain/integrator-invariants.md).

## Signature voucher

A signature voucher is an account that allows the network to sign one message with one dWallet,
once. Its owner creates it with `IssueSignatureVoucher`. It records:

- the dWallet;
- the digest of the message, and of its metadata if it has any;
- the signature scheme;
- the signing key: the request key that may send the sign request;
- its status, and the signature once the network writes it.

A voucher lives at a fresh address that signs its own creation. No seeds derive it. A sign request
names the voucher by its address.

The network signs for a voucher only when the voucher is pending and has a signing key, and the
request matches the voucher's dWallet, digests, scheme and signing key. Two signatures of the same
message need two vouchers.

A voucher's status is one of these:

| Status | Meaning |
| --- | --- |
| Pending | Waiting for its signature. |
| Signed | Holds its signature. |
| Settled without delivery | The network charged for the sign, and no signature will be written. |
| Revoked | The owner revoked it. A sign agreed before the revoke still writes its signature. |

A future signature voucher works the same way, in two steps. The user's half of the signature is
written first, and the signature is finished later, from any key the voucher names.

## Request key and gas deposit

Requests to the ika network do not go through Solana. The app sends them to the network directly.
Each request is signed by a request key and charged to that key's gas deposit on Solana.

The SDK derives the request key from the user's root seed, the same seed every other key of the user
comes from. The request key does not depend on the curve. So one gas deposit serves all the user's
dWallets, on every curve.

A gas deposit holds two balances:

- IKA, for the network's fees for each request;
- SOL, for the network's cost of writing results to Solana.

The devnet pre-alpha charges nothing, but a request still needs a deposit to exist. See
[Gas Deposits](../on-chain/gas-deposits.md).

## Encryption key

The user's encryption key is the key the user's share is encrypted to. The user registers it on
Solana once per curve (`RegisterEncryptionKey`), before their first dWallet on that curve. The
network writes each new share encrypted to it, so only the user can read their share.

## The network's address

The network acts on Solana through its own Ed25519 key. It writes every result: new dWallets, shares,
signatures and the first step of future signs. The program accepts these writes only when that key
signed them. On the real network the key is a threshold key: the validators make each of its
signatures together, and no single validator holds it.

## Presign

A presign is a part of a signature that the network computes before the message is known. A sign
uses up one presign, which makes the sign faster.

- **Global presigns** come from the network's pool, one pool per signature algorithm. Any dWallet
  made by the network can use them.
- **Presigns for one dWallet** are made for one imported-key dWallet. Its ECDSA signs need them.

A presign belongs to the epoch it was made in, and expires with it. The SDK takes a new one when that
happens.

## Epoch

The ika network works in epochs. Every request names the epoch the chain shows, and the network
refuses a request for another epoch. On Solana, the SDK reads the epoch from the program's dWallet
coordinator account. The devnet pre-alpha moves its epoch rarely.

## Key generation (DKG)

A new dWallet comes from a distributed key generation. On the real network, the user and the network
compute the key together, so that each ends up with its own share and neither knows the other's.

The flow on Solana:

1. The app sends a DKG request to the network.
2. The network computes its side, writes the `DWallet` account and the user's encrypted share
   (`CommitDWallet`), and answers the app with a signed record of the result.
3. The SDK checks that record against the network key.
4. The user accepts the share on Solana. The dWallet is then active, and its creator owns it.

## Curves and signature schemes

| Curve | Value | Used by |
| --- | --- | --- |
| Secp256k1 | 0 | Bitcoin, Ethereum |
| Secp256r1 (P-256) | 1 | WebAuthn, secure enclaves |
| Curve25519 | 2 | Ed25519: Solana, Sui |
| Ristretto | 3 | sr25519: Substrate, Polkadot |

A voucher names a signature scheme: the signature algorithm and the hash together.

| Scheme | Value | Curve | Used by |
| --- | --- | --- | --- |
| `EcdsaKeccak256` | 0 | Secp256k1 | Ethereum |
| `EcdsaSha256` | 1 | Secp256k1, Secp256r1 | Bitcoin legacy, WebAuthn |
| `EcdsaDoubleSha256` | 2 | Secp256k1 | Bitcoin BIP143 |
| `TaprootSha256` | 3 | Secp256k1 | Bitcoin Taproot |
| `EcdsaBlake2b256` | 4 | Secp256k1 | Zcash |
| `EddsaSha512` | 5 | Curve25519 | Ed25519 |
| `SchnorrkelMerlin` | 6 | Ristretto | sr25519 |

In the SDKs, a sign takes the signature algorithm and the hash separately, for example
`SignatureAlgorithm.EdDSA` with `Hash.SHA512`. Presigns are kept per signature algorithm, not per
scheme.

An ECDSA signature comes back as 65 bytes: the recovery byte, then `r` and `s`.
