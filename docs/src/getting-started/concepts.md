# Core Concepts

> **Pre-Alpha Disclaimer:** This is a pre-alpha release for development and testing only. Signing uses a single mock signer, not real distributed MPC. All 11 protocol operations are implemented (DKG, Sign, Presign, FutureSign, ReEncryptShare, etc.) across all 4 curves and 7 signature schemes, but without real MPC security guarantees. The dWallet keys, trust model, and signing protocol are not final; do not rely on any key material until mainnet. All interfaces, APIs, and data formats are subject to change without notice. The Solana program and all on-chain data will be wiped periodically and everything will be deleted when we transition to Ika Alpha 1. This software is provided "as is" without warranty of any kind; use is entirely at your own risk and dWallet Labs assumes no liability for any damages arising from its use.

## dWallet

A **dWallet** is a distributed signing key controlled by a Solana account. The on-chain `DWallet` account stores the public key, curve type, and authority. The private key never exists in one place -- it is split between the user and the Ika validator network via 2PC-MPC (two-party computation with multi-party computation).

```
DWallet account (on Solana):
  authority(32)        -- who can approve signing
  curve(2)             -- u16 LE: Secp256k1(0), Secp256r1(1), Curve25519(2), Ristretto(3)
  state(1)             -- DKGInProgress(0), Active(1), Frozen(2)
  public_key_len(1)    -- actual public key length (32 or 33)
  public_key(65)       -- the dWallet's public key (padded to 65 bytes)
  created_epoch(8)     -- epoch when created
  noa_public_key(32)   -- NOA Ed25519 key used during DKG
  is_imported(1)       -- whether the key was imported (vs created via DKG)
  bump(1)              -- PDA bump seed
  _reserved(8)         -- reserved for future use
```

Attestation data (DKG output, proofs, etc.) is stored in separate `DWalletAttestation` PDAs, not inline in the DWallet account.

A dWallet can sign transactions on **any blockchain** -- Bitcoin, Ethereum, Solana, etc. The curve and signature scheme determine which chains are compatible.

## Authority

The **authority** of a dWallet controls who can approve messages for signing. It can be:

- A **user wallet** (direct signer) -- the user calls `approve_message` directly
- A **CPI authority PDA** -- a program controls the dWallet and approves messages via CPI

Transferring authority is done via the `TransferOwnership` instruction.

## CPI Authority PDA

Every program that wants to control a dWallet derives a **CPI authority PDA**:

```
Seeds: [b"__ika_cpi_authority"]
Program: YOUR_PROGRAM_ID
```

When a dWallet's authority is set to your program's CPI authority PDA, only your program can approve messages for that dWallet. The dWallet program verifies the CPI call chain to ensure the correct program is calling.

## Message Approval

A **MessageApproval** is a PDA that represents a request to sign a specific message. When your program calls `approve_message`, it creates this PDA:

```
MessageApproval PDA:
  Seeds: ["dwallet", chunks..., "message_approval", &scheme_u16_le, &message_digest, [&meta_digest]]
  Program: DWALLET_PROGRAM_ID

Fields:
  dwallet(32)                -- the dWallet to sign with
  message_digest(32)         -- keccak256 digest of the message
  message_metadata_digest(32) -- keccak256 digest of metadata (zero if none)
  approver(32)               -- dWallet authority who authorized signing
  user_pubkey(32)            -- user's public key
  signature_scheme(2)        -- DWalletSignatureScheme (u16 LE, values 0-6)
  epoch(8)                   -- epoch when approved
  status(1)                  -- Pending(0) or Signed(1)
  signature_len(2)           -- length of signature bytes
  signature(128)             -- the produced signature (padded)
  bump(1)                    -- PDA bump
  _reserved(8)               -- reserved
```

The Ika network monitors for new `MessageApproval` accounts and produces signatures for those with status = Pending.

## NOA (Network Operated Authority)

The **NOA** is a special keypair operated by the Ika network. In the pre-alpha, this is a single mock signer. In production, the NOA's actions are backed by MPC consensus across all validators.

The NOA:
- Initializes the dWallet program state (DWalletCoordinator, NetworkEncryptionKey)
- Commits new dWallets after DKG (`CommitDWallet`)
- Commits signatures after signing (`CommitSignature`)
- Commits attestation PDAs (`CommitFutureSign`, `CommitEncryptedUserSecretKeyShare`, `CommitPublicUserSecretKeyShare`)
- Handles network DKG (`CommitNetworkDKG`) and key reconfiguration (`CommitNetworkKeyReconfiguration`)

## Presign

A **presign** is a precomputed partial signature that speeds up the signing process. Presigns are generated in advance and consumed during signing.

There are two types:
- **Global presigns** -- can be used with any non-imported dWallet (allocated via `Presign` request, uses `signature_algorithm`)
- **dWallet-specific presigns** -- bound to a specific dWallet by `dwallet_public_key` (allocated via `PresignForDWallet` request, required for imported ECDSA keys)

Presigns are managed via the gRPC API and returned as `Attestation(NetworkSignedAttestation)` containing a `VersionedPresignDataAttestation`.

## Gas Deposit

Programs that use dWallet instructions need a `GasDeposit` PDA. The deposit holds:
- **IKA balance**: For dWallet operation fees (DKG, signing, etc.)
- **SOL balance**: For NOA write-back transaction costs

Instructions: `CreateDeposit` (36), `TopUp` (37), `SettleGas` (38), `RequestWithdraw` (44), `Withdraw` (45).

## Supported Curves and Signature Schemes

| Curve | ID (u16) | Description | Mock DKG |
|-------|----------|-------------|----------|
| Secp256k1 | 0 | Bitcoin, Ethereum | Yes |
| Secp256r1 | 1 | WebAuthn, secure enclaves | Yes |
| Curve25519 | 2 | Solana, Sui, general Ed25519 | Yes |
| Ristretto | 3 | Substrate, Polkadot | Yes |

### DWalletSignatureScheme (u16)

Combined (algorithm, hash) pair used for signing and message approval:

| Variant | Index | Curve | Use For |
|---------|-------|-------|---------|
| `EcdsaKeccak256` | 0 | Secp256k1 | Ethereum |
| `EcdsaSha256` | 1 | Secp256k1 / Secp256r1 | Bitcoin (legacy) / WebAuthn |
| `EcdsaDoubleSha256` | 2 | Secp256k1 | Bitcoin BIP143 |
| `TaprootSha256` | 3 | Secp256k1 | Bitcoin Taproot (BIP340) |
| `EcdsaBlake2b256` | 4 | Secp256k1 | Zcash |
| `EddsaSha512` | 5 | Curve25519 | Ed25519 (Solana, Sui) |
| `SchnorrkelMerlin` | 6 | Ristretto | Substrate, Polkadot (sr25519) |

### DWalletSignatureAlgorithm

Used by presign requests (presigns are per-algorithm, not per-scheme):

| Variant | Value | Description |
|---------|-------|-------------|
| `ECDSASecp256k1` | 0 | ECDSA on Secp256k1 |
| `ECDSASecp256r1` | 1 | ECDSA on Secp256r1 |
| `Taproot` | 2 | Schnorr on Secp256k1 |
| `EdDSA` | 3 | Ed25519 on Curve25519 |
| `Schnorrkel` | 4 | sr25519 on Ristretto |

## DKG (Distributed Key Generation)

DKG is the process of creating a new dWallet. The user and the Ika network jointly generate a key pair such that:
- The user holds one share of the private key
- The network collectively holds the other share
- Neither party alone can produce a signature

The on-chain flow:
1. User submits DKG request via gRPC
2. Network runs 2PC-MPC DKG protocol
3. NOA calls `CommitDWallet` to create the on-chain dWallet account and its attestation PDA
4. The dWallet's authority is set to the requesting user
