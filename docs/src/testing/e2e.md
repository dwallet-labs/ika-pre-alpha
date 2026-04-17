# E2E Tests

> **Pre-Alpha Disclaimer:** This is a pre-alpha release for development and testing only. Signing uses a single mock signer, not real distributed MPC. All 11 protocol operations are implemented (DKG, Sign, Presign, FutureSign, ReEncryptShare, etc.) across all 4 curves and 7 signature schemes, but without real MPC security guarantees. The dWallet keys, trust model, and signing protocol are not final; do not rely on any key material until mainnet. All interfaces, APIs, and data formats are subject to change without notice. The Solana program and all on-chain data will be wiped periodically and everything will be deleted when we transition to Ika Alpha 1. This software is provided "as is" without warranty of any kind; use is entirely at your own risk and dWallet Labs assumes no liability for any damages arising from its use.

## Overview

E2E tests run the full dWallet lifecycle against Solana devnet and the pre-alpha dWallet gRPC service. This tests the complete flow including on-chain program execution, CPI, and signing.

## Prerequisites

| Resource | Endpoint |
|----------|----------|
| **dWallet gRPC** | `https://pre-alpha-dev-1.ika.ika-network.net:443` |
| **Solana RPC** | `https://api.devnet.solana.com` |

Deploy your program to devnet, then run:

```bash
cargo run -p e2e-voting -- <DWALLET_PROGRAM_ID> <VOTING_PROGRAM_ID>
```

Override endpoints via environment variables:

```bash
RPC_URL=https://api.devnet.solana.com \
GRPC_URL=pre-alpha-dev-1.ika.ika-network.net:443 \
cargo run -p e2e-voting -- <DWALLET_PROGRAM_ID> <VOTING_PROGRAM_ID>
```

## E2E Flow

The voting E2E demo performs 7 steps:

### Step 1: Wait for Program Initialization

The mock signer creates:
- **DWalletCoordinator** PDA (`["dwallet_coordinator"]`) -- 116 bytes
- **NetworkEncryptionKey** PDA (`["network_encryption_key", noa_pubkey]`) -- 164 bytes

```rust
let (coordinator_pda, _) =
    Pubkey::find_program_address(&[b"dwallet_coordinator"], &dwallet_program_id);

poll_until(&client, &coordinator_pda, |data| {
    data.len() >= 116 && data[0] == 1 // DISC_COORDINATOR
}, Duration::from_secs(30));
```

### Step 2: Create dWallet

The NOA commits a dWallet via `CommitDWallet` (discriminator `31`):

The dWallet PDA seeds are `["dwallet", chunks_of(curve_byte ‖ public_key)]` — concatenate the curve byte with the public key into a single buffer, then split into 32-byte chunks (Solana's `MAX_SEED_LEN`) and pass each chunk as its own seed. For 32-byte pubkeys (Curve25519/Ristretto/Ed25519) the payload is 33 bytes → chunks `[32, 1]`; for 33-byte compressed SEC1 pubkeys (Secp256k1/r1) it is 34 bytes → chunks `[32, 2]`.

```rust
let mut payload = Vec::with_capacity(1 + public_key.len());
payload.push(curve);
payload.extend_from_slice(&public_key);

let mut seeds: Vec<&[u8]> = Vec::with_capacity(4);
seeds.push(b"dwallet");
for chunk in payload.chunks(32) {
    seeds.push(chunk);
}

let (dwallet_pda, dwallet_bump) =
    Pubkey::find_program_address(&seeds, &dwallet_program_id);
```

### Step 3: Transfer Authority

Transfer dWallet authority to the voting program's CPI PDA:

```rust
let (cpi_authority, _) = Pubkey::find_program_address(
    &[b"__ika_cpi_authority"],
    &voting_program_id,
);
```

### Step 4: Create Proposal

Create a proposal with quorum = 3:

```rust
let message = b"Transfer 100 USDC to treasury";
let message_hash = keccak256(message);
```

### Step 5: Cast 3 Votes

Three voters (Alice, Bob, Charlie) each cast YES. Charlie's vote reaches quorum and triggers the `approve_message` CPI.

The last vote transaction includes 10 accounts (5 base + 5 CPI accounts).

### Step 6: Verify MessageApproval

```rust
let ma_data = client.get_account(&message_approval_pda)?.data;
assert_eq!(ma_data[0], 14);  // discriminator
assert_eq!(ma_data[139], 0); // status = Pending
```

### Step 7: Sign and Verify

The mock signer signs the message and calls `CommitSignature` (discriminator `43`):

```rust
let signed_data = client.get_account(&message_approval_pda)?.data;
let sig_len = u16::from_le_bytes(signed_data[140..142].try_into().unwrap()) as usize;
let signature = &signed_data[142..142 + sig_len];
```

## Key PDA Seeds

| PDA | Seeds | Program |
|-----|-------|---------|
| DWalletCoordinator | `["dwallet_coordinator"]` | dWallet |
| NetworkEncryptionKey | `["network_encryption_key", noa_pubkey]` | dWallet |
| DWallet | `["dwallet", chunks_of(curve ‖ public_key)]` (32-byte chunks) | dWallet |
| MessageApproval | `["message_approval", dwallet, message_hash]` | dWallet |
| CPI Authority | `["__ika_cpi_authority"]` | Your program |
| Proposal | `["proposal", proposal_id]` | Voting |
| VoteRecord | `["vote", proposal_id, voter]` | Voting |

## Key Discriminators

| Instruction | Discriminator |
|-------------|---------------|
| CreateProposal (voting) | 0 |
| CastVote (voting) | 1 |
| ApproveMessage (dWallet) | 8 |
| TransferOwnership (dWallet) | 24 |
| CommitDWallet (dWallet) | 31 |
| CommitSignature (dWallet) | 43 |

## Running the E2E Test

```bash
cargo run -p e2e-voting -- <DWALLET_PROGRAM_ID> <VOTING_PROGRAM_ID>
```

Expected output:

```
=== dWallet Voting E2E Demo ===

[Setup] Funding payer...
  > Payer: <pubkey>
[1/7] Creating dWallet via CommitDWallet...
  > dWallet created: <pubkey>
[2/7] Transferring dWallet authority to voting program...
  > Authority transferred to CPI PDA: <pubkey>
[3/7] Creating voting proposal (quorum=3)...
  > Proposal: <pubkey>
[4/7] Vote 1/3: Alice casts YES...
[4/7] Vote 2/3: Bob casts YES...
[4/7] Vote 3/3: Charlie casts YES...
  > Proposal approved (yes_votes=3)
[5/7] Verifying MessageApproval on-chain...
  > MessageApproval: <pubkey>
[6/7] Signing message with NOA key and committing on-chain...
  > Signature committed on-chain!
[7/7] Reading signature from MessageApproval...
  > Signature: <hex>

=== E2E Test Passed! ===
```
