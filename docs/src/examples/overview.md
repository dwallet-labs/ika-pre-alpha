# Examples

> **Pre-Alpha Disclaimer:** This is a pre-alpha release for development and testing only. Signing uses a single mock signer, not real distributed MPC. All 11 protocol operations are implemented (DKG, Sign, Presign, FutureSign, ReEncryptShare, etc.) across all 4 curves and 7 signature schemes, but without real MPC security guarantees. The dWallet keys, trust model, and signing protocol are not final; do not rely on any key material until mainnet. All interfaces, APIs, and data formats are subject to change without notice. The Solana program and all on-chain data will be wiped periodically and everything will be deleted when we transition to Ika Alpha 1. This software is provided "as is" without warranty of any kind; use is entirely at your own risk and dWallet Labs assumes no liability for any damages arising from its use.

## Overview

The Ika SDK ships with two complete example programs demonstrating different patterns for program-controlled dWallet signing:

| Example | Pattern | Description |
|---------|---------|-------------|
| [Voting](./voting/overview.md) | Governance | Open voting with quorum — anyone can vote, quorum triggers signing |
| [Multisig](./multisig/overview.md) | Access Control | M-of-N multisig — fixed members, threshold approval triggers signing |

## Structure

Each example follows the same directory layout:

```
examples/<name>/
├── pinocchio/          # Pinocchio framework implementation
│   ├── src/lib.rs
│   └── tests/mollusk.rs
├── native/             # Native solana-program implementation
│   ├── src/lib.rs
│   └── tests/mollusk.rs
├── anchor/             # Anchor framework implementation
│   └── src/lib.rs
├── quasar/             # Quasar framework implementation
│   └── src/lib.rs
├── e2e/                # TypeScript end-to-end tests (bun)
│   ├── main.ts
│   └── instructions.ts
└── e2e-rust/           # Rust end-to-end tests (alternative)
    └── src/main.rs
```

## Common Flow

Both examples follow the same high-level flow:

1. **Create dWallet** via gRPC DKG request — the mock commits on-chain and transfers authority to the caller
2. **Transfer authority** to the example program's CPI authority PDA (`["__ika_cpi_authority"]`)
3. **Create proposal/transaction** — on-chain state describing what to sign
4. **Collect approvals** — votes or multisig member approvals
5. **CPI `approve_message`** — when threshold is reached, the program calls the dWallet program to create a `MessageApproval` PDA
6. **gRPC presign + sign** — allocate a presign, then sign via gRPC with `ApprovalProof` referencing the on-chain approval
7. **Signature returned** — 64-byte Ed25519 signature for the approved message

## Running Examples

### Pre-Alpha Environment

| Resource | Endpoint |
|----------|----------|
| **dWallet gRPC** | `https://pre-alpha-dev-1.ika.ika-network.net:443` |
| **Solana RPC** | `https://api.devnet.solana.com` |

Deploy your example program to devnet, then run E2E tests against the pre-alpha environment:

```bash
# TypeScript (recommended)
just e2e-voting <DWALLET_ID> <VOTING_ID>
just e2e-multisig <DWALLET_ID> <MULTISIG_ID>

# Rust (alternative)
just e2e-voting-rust <DWALLET_ID> <VOTING_ID>
just e2e-multisig-rust <DWALLET_ID> <MULTISIG_ID>
```

### Unit Tests (Mollusk)

Mollusk tests run in-process with no network dependency:

```bash
just test-examples-mollusk
```

## Shared Helpers

TypeScript e2e tests use shared helpers from `examples/_shared/`:

- **`helpers.ts`** — Colored logging (`log`, `ok`, `val`), `sendTx`, `pda`, `pollUntil`, `createAndFundKeypair`
- **`ika-setup.ts`** — BCS types matching `ika-dwallet-types`, gRPC client, `setupDWallet()`, `requestPresign()`, `requestSign()`

These helpers handle the full dWallet lifecycle (DKG, on-chain polling, authority transfer) so example e2e tests focus on their specific program logic.
