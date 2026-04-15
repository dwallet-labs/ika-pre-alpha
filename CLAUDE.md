# ika-pre-alpha

Public developer SDK repository for building Solana programs that integrate with Ika dWallets.

This is the pre-alpha SDK -- it contains CPI libraries, clients, examples, IDL, and gRPC types. It does NOT contain program source code, internal tests, mock infrastructure, or network internals.

## Build

```bash
cargo build --workspace
cargo check --workspace
cargo test --workspace
```

## Structure

- `chains/solana/program-sdk/pinocchio/` -- CPI SDK for Pinocchio programs
- `chains/solana/program-sdk/anchor/` -- CPI SDK for Anchor programs
- `chains/solana/program-sdk/native/` -- CPI SDK for native solana-program programs
- `chains/solana/program-sdk/quasar/` -- CPI SDK for Quasar programs
- `chains/solana/sdk/types/` -- Account readers and PDA helpers
- `chains/solana/clients/` -- Generated Rust/TypeScript clients
- `chains/solana/examples/voting/` -- Example voting-controlled dWallet (pinocchio, native, anchor, quasar)
- `chains/solana/examples/multisig/` -- Example multisig-controlled dWallet (pinocchio, native, anchor, quasar)
- `crates/ika-grpc/` -- gRPC client types (generated from proto)
- `crates/ika-dwallet-types/` -- BCS request/response types
- `proto/` -- Protobuf definitions

## Conventions

- Rust 1.94 toolchain
- Edition 2024
- BSD-3-Clause-Clear license
- No unsafe code
- Use `tracing` for logging, bounded channels only
