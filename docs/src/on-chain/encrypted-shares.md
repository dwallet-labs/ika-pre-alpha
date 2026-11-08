# Encrypted Shares

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

A zero-trust dWallet keeps the user's secret share encrypted on chain. Only the holder of the
matching decryption key can read it. The network stores the encrypted copy and cannot use it.
This page explains the three accounts involved and the two instructions a user sends.

## The three accounts

- **`EncryptionKey`**: a holder's public encryption key for one curve, at
  `["encryption_key", holder, curve_le]`. The holder is an Ed25519 key, which signed the
  registration.
- **`EncryptedUserSecretKeyShare`**: one holder's encrypted share of one dWallet, at
  `["dwallet", "encrypted_user_share", root..., holder]`.
- **`DWalletAttestation`** of the share: the network's signed record of the share, at
  `["dwallet", "encrypted_share_attestation", root..., holder]`.

`root` is the dWallet's root of 32-byte chunks. See
[The dWallet's address](../reference/accounts.md#the-dwallets-address).

## Step 1: register the encryption key

Before the network encrypts a share to a holder, the holder registers its encryption key on
chain. The network serves a request only when the holder's registered key is exactly the key
the request names. A request for a holder with no registered key waits for about a minute, then
is refused.

The holder signs the registration message with its Ed25519 key. The message names this chain's
number, the deployment's network, the curve and the encryption key, so a registration signed for
one chain or curve cannot be used for another. Anyone may then send the registration and pay for
it: an Ed25519 precompile instruction with the holder's signature, followed by
`RegisterEncryptionKey`. The program reads the key from the signed message.

One key exists per holder and curve, and it never changes. To use another key, a holder
registers it under another Ed25519 key, which is then another holder.

In TypeScript, `registerEncryptionKeyInstructions` from `@ika.xyz/pre-alpha-solana/instructions` builds
the two instructions. The SDKs register the key for you when they create a dWallet.

## Step 2: the network stores the share

When the network creates a dWallet with an encrypted share, it writes the dWallet and the share
in one transaction. The dWallet's state is 3, waiting for its holder. The share is not accepted.
Until a share is accepted, the dWallet cannot be used: the program issues it no voucher, and the
network starts no sign on it.

The share account stores the digest the holder must sign to accept it
(`acceptance_digest`, offset 182):

- for a dWallet's first share, the Keccak-256 of the dWallet attestation's bytes;
- for a re-encrypted share, the Keccak-256 of the share attestation's bytes.

## Step 3: the holder accepts

The holder checks the share before it accepts:

1. Read the share's attestation account. Check that the network's signature in it verifies under
   a network key you trust.
2. Check that the stored encrypted share hashes to the share hash the attestation names.

Then the holder signs `acceptance_digest` with its Ed25519 key. Anyone sends an Ed25519
precompile instruction with that signature, followed by `AcceptEncryptedUserShare`. The program
checks that the signature is the holder's, over the stored digest. It then marks the share
accepted, and moves the dWallet from waiting to Active.

`acceptEncryptedUserShareInstructions` from `@ika.xyz/pre-alpha-solana/instructions` builds the two
instructions. The SDKs do these checks and the accept for you.

The accept is refused while the coordinator is paused. The network charges no fee for it.

## Re-encrypting a share to another holder

The holder of a share can give a copy to another holder. The second holder registers its own
encryption key first. Then the first holder asks the network to re-encrypt (`ReEncryptShare`).
The network writes the new share, with its own attestation, at the second holder's address. The
second holder checks and accepts it the same way.

A re-encrypted share can be accepted only when the dWallet is already Active.

## Making the share public

The holder can reveal its share to the network (`MakeSharePublic`). The network writes the public
share into the dWallet's public-share attestation, `["dwallet", "public_user_share", root...]`.
From then on, the network can sign with the dWallet without the user's help. This cannot be
undone. The network starts a reveal only for an Active dWallet.

## On the devnet pre-alpha

The mock network holds an ordinary key for every dWallet. It does not use the encrypted share to
sign. The accounts, the instructions and the accept work as on the real network, so the flow an
app writes is the same.
