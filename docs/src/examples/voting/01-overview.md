# Voting dWallet: Overview

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

## Overview

A governance program where a dWallet is placed under a **council** — a fixed member list with a quorum, created by the dWallet's owner before the dWallet is handed to the program. Council members create proposals referencing the council's dWallet and cast yes/no votes; when the quorum of yes votes is reached, the program CPI-calls `issue_signature_voucher` on the dWallet program to authorize signing.

**Use case:** DAO governance, treasury management, group signing authorization.

The council is not decoration: the dWallet program authenticates a program by one CPI authority PDA per program, so every dWallet handed to this program is controlled by the program as a whole. The per-dWallet council (and the dWallet check at quorum) is what stops one group's proposal from issuing a voucher on another group's dWallet. See [Integrator Invariants](../../on-chain/integrator-invariants.md).

## Program Design

### Accounts

| Account | Seeds | Size | Description |
|---------|-------|------|-------------|
| Council | `["council", dwallet]` | 361 bytes | Members and quorum for one dWallet — exactly one per dWallet |
| Proposal | `["proposal", proposal_id]` | 196 bytes | Stores vote counts, quorum (from the council), message digest, dWallet reference |
| VoteRecord | `["vote", proposal_id, voter]` | 69 bytes | Prevents double voting — one per voter per proposal |

### Instructions

| Disc | Instruction | Description |
|------|-------------|-------------|
| `0` | CreateProposal | A council member creates a proposal (message digest, signer key) for the council's dWallet |
| `1` | CastVote | A council member records a vote; when quorum reached, CPI-issues a signature voucher on the proposal's dWallet |
| `2` | CreateCouncil | The dWallet's current owner fixes members and quorum for that dWallet |

### Council Layout (361 bytes)

```
disc(1) + version(1) + dwallet(32) + quorum(4) + member_count(2) + bump(1) + members(32*10)
```

### Proposal Layout (196 bytes)

```
disc(1) + version(1) + proposal_id(32) + dwallet(32) + message_digest(32) +
user_pubkey(32) + signature_scheme(2) + creator(32) + yes_votes(4) +
no_votes(4) + quorum(4) + status(1) + signature_voucher_bump(1) +
bump(1) + _reserved(16)
```

### Key Offsets

| Field | Offset | Size | Type |
|-------|--------|------|------|
| dwallet | 34 | 32 | pubkey |
| signature_scheme | 130 | 2 | u16 LE (`5` = EdDSA/SHA-512) |
| yes_votes | 164 | 4 | u32 LE |
| no_votes | 168 | 4 | u32 LE |
| quorum | 172 | 4 | u32 LE |
| status | 176 | 1 | 0=Open, 1=Approved |

## CPI Flow

When `yes_votes >= quorum`, the program:

1. Reads message digest, user pubkey, and signature scheme from the Proposal account
2. Checks that the dWallet account passed for the CPI **is the proposal's dWallet**
3. Constructs a `DWalletContext` with the CPI authority PDA
4. Calls `ctx.issue_signature_voucher(...)`, which creates a `SignatureVoucher` at the program's PDA `["signature_voucher", proposal_id]`; the program signs for that PDA with its seeds. The voucher's signing key is the proposal's `user_pubkey`, and its owner is the program's CPI authority
5. Sets proposal status to Approved

The caller then sends a gRPC `Sign` request to obtain the signature. That request names the voucher's address: validators read this `SignatureVoucher` themselves and vote on what they see.

## E2E Flow

```
1. Make a user        → new keys, encryption key registered, gas deposit opened
2. gRPC DKG           → dWallet created on-chain; the user accepts the share; owner = the payer
3. Create council     → quorum=3, members Alice/Bob/Charlie (signed by the payer, still the owner)
4. Transfer ownership → the program's CPI authority owns the dWallet
5. Create proposal    → Alice proposes the message; user_pubkey = the user's request key
6. Cast 3 YES votes   → the last vote issues the signature voucher through a CPI
7. gRPC presign       → take a presign
8. gRPC sign          → the 64-byte Ed25519 signature, also written into the voucher
```

The proposal's `user_pubkey` is the key allowed to send the sign request. With the SDK, that is the
user's request key (`ikaClient.getRequestPublicKey(keys)`), not the user's wallet.

## Testing

```bash
# from the repository root
# Mollusk (instruction-level) + LiteSVM (CPI path against the real dWallet program)
cargo test -p ika-example-voting-pinocchio
cargo test -p ika-example-voting-native
cargo test -p ika-example-voting-anchor

# TypeScript E2E, against the devnet pre-alpha (see the E2E Demo page)
cd examples && bun install
PAYER_KEYPAIR=<your-keypair.json> bun voting/e2e/main.ts CqGtQgrYFUhobuknomFNntwoxCgKGkBRUtemgdPuM9qT <VOTING_ID>
```

## Source Files

- Pinocchio: `examples/voting/pinocchio/src/lib.rs`
- Native: `examples/voting/native/src/lib.rs`
- Anchor: `examples/voting/anchor/src/lib.rs`
- TypeScript E2E: `examples/voting/e2e/main.ts`
