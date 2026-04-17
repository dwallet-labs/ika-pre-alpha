# dWallet SDK for Solana (Pre-Alpha)

> **Pre-Alpha Disclaimer:** This is a pre-alpha release for development and testing only. Signing uses a single mock signer, not real distributed MPC. All 11 protocol operations are implemented (DKG, Sign, Presign, FutureSign, ReEncryptShare, etc.) across all 4 curves and 7 signature schemes, but without real MPC security guarantees. The dWallet keys, trust model, and signing protocol are not final; do not rely on any key material until mainnet. All interfaces, APIs, and data formats are subject to change without notice. The Solana program and all on-chain data will be wiped periodically and everything will be deleted when we transition to Ika Alpha 1. This software is provided "as is" without warranty of any kind; use is entirely at your own risk and dWallet Labs assumes no liability for any damages arising from its use.

Public developer SDK for building Solana programs that integrate with [Ika dWallets](https://ika.xyz).

## Contents

| Directory | Description |
|-----------|-------------|
| `bin/` | Pre-built dWallet program binary (`.so`) for testing and local deployment |
| `chains/solana/program-sdk/pinocchio/` | CPI SDK for Pinocchio programs (`ika-dwallet-pinocchio`) |
| `chains/solana/program-sdk/anchor/` | CPI SDK for Anchor v1.0.0 programs (`ika-dwallet-anchor`) |
| `chains/solana/program-sdk/native/` | CPI SDK for native solana-program programs (`ika-dwallet-native`) |
| `chains/solana/program-sdk/quasar/` | CPI SDK for Quasar programs (`ika-dwallet-quasar`) |
| `chains/solana/sdk/types/` | Account data readers and PDA derivation helpers (`ika-system-types`) |
| `chains/solana/clients/` | Generated Rust and TypeScript clients |
| `chains/solana/examples/voting/` | Example: voting-controlled dWallet (Pinocchio, Native, Anchor, Quasar) |
| `chains/solana/examples/multisig/` | Example: multisig-controlled dWallet (Pinocchio, Native, Anchor, Quasar) |
| `crates/ika-grpc/` | gRPC client types for the dWallet signing service |
| `crates/ika-dwallet-types/` | BCS-serializable request/response types |
| `proto/` | Protobuf definitions |
| `docs/` | Developer documentation (mdbook) |

## Devnet

| Resource | Endpoint |
|----------|----------|
| **dWallet gRPC** | `https://pre-alpha-dev-1.ika.ika-network.net:443` |
| **Solana RPC** | `https://api.devnet.solana.com` |
| **Program ID** | `87W54kGYFQ1rgWqMeu4XTPHWXWmXSQCcjm8vCTfiq1oY` |

## Quick Start

```bash
# Build all crates
cargo build --workspace

# Run voting example tests (mollusk)
cargo test -p ika-example-voting

# Check all crates
cargo check --workspace

# Serve docs locally
mdbook serve docs/
```

## Adding dWallet CPI to Your Program

### Pinocchio

```toml
[dependencies]
ika-dwallet-pinocchio = { git = "https://github.com/dwallet-labs/ika-pre-alpha" }
pinocchio = "0.10"
```

### Anchor v1

```toml
[dependencies]
ika-dwallet-anchor = { git = "https://github.com/dwallet-labs/ika-pre-alpha" }
anchor-lang = "1"
```

### Quasar

```toml
[dependencies]
ika-dwallet-quasar = { git = "https://github.com/dwallet-labs/ika-pre-alpha" }
quasar-lang = { git = "https://github.com/blueshift-gg/quasar", branch = "master" }
```

### Usage

```rust
use ika_dwallet_pinocchio::DWalletContext; // or ika_dwallet_anchor / ika_dwallet_quasar

let ctx = DWalletContext {
    dwallet_program, cpi_authority, caller_program, cpi_authority_bump: bump,
};

// Approve a message for signing — the Ika network signs it via 2PC-MPC
ctx.approve_message(
    message_approval, dwallet, payer, system_program,
    message_hash, user_pubkey, signature_scheme, bump,
)?;
```

## License

BSD-3-Clause-Clear
