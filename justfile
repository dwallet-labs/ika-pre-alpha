# ika-pre-alpha justfile

# Build all workspace crates
build:
    cargo build --workspace

# Check all workspace crates
check:
    cargo check --workspace

# Run all tests
test:
    cargo test --workspace

# Run clippy lints
lint:
    cargo clippy --workspace --all-targets -- -D warnings

# Format code
fmt:
    cargo fmt --all

# Check formatting
fmt-check:
    cargo fmt --all -- --check

# Build all example programs (SBF)
build-sbf:
    cargo build-sbf --manifest-path chains/solana/examples/voting/pinocchio/Cargo.toml
    cargo build-sbf --manifest-path chains/solana/examples/voting/native/Cargo.toml
    cargo build-sbf --manifest-path chains/solana/examples/voting/anchor/Cargo.toml
    cargo build-sbf --manifest-path chains/solana/examples/multisig/pinocchio/Cargo.toml
    cargo build-sbf --manifest-path chains/solana/examples/multisig/native/Cargo.toml
    cargo build-sbf --manifest-path chains/solana/examples/multisig/anchor/Cargo.toml

# Test all examples (mollusk)
test-examples-mollusk:
    cargo test -p ika-example-voting-pinocchio --test mollusk
    cargo test -p ika-example-voting-native --test mollusk
    cargo test -p ika-example-multisig --test mollusk
    cargo test -p ika-example-multisig-native --test mollusk

# TypeScript e2e tests (requires validator + mock running)
e2e-voting DWALLET_ID VOTING_ID:
    cd chains/solana/examples/voting/e2e && bun main.ts {{DWALLET_ID}} {{VOTING_ID}}

e2e-multisig DWALLET_ID MULTISIG_ID:
    cd chains/solana/examples/multisig/e2e && bun main.ts {{DWALLET_ID}} {{MULTISIG_ID}}

# Rust e2e tests (requires validator + mock running)
e2e-voting-rust DWALLET_ID VOTING_ID:
    cd chains/solana/examples/voting/e2e-rust && cargo run -- {{DWALLET_ID}} {{VOTING_ID}}

e2e-multisig-rust DWALLET_ID MULTISIG_ID:
    cd chains/solana/examples/multisig/e2e-rust && cargo run -- {{DWALLET_ID}} {{MULTISIG_ID}}

# Install all TypeScript dependencies
install-ts:
    cd chains/solana/examples/_shared && bun install

# Generate clients (requires bun + IDL)
generate-clients:
    cd chains/solana && bun scripts/generate-clients.ts

# Generate IDL (requires ika-system-program source -- not in this repo)
generate-idl:
    @echo "IDL generation requires the full ika repo. Copy the IDL JSON to chains/solana/idl/"
