#!/usr/bin/env bash
# Build every example program for SBPF v3, into target/deploy.
#
# With no argument the programs are built for the test suites, which load
# the ika program at its local development address (bin/ika_protocol_test.so).
# Pass a network feature, for example `devnet-pre-alpha`, to build them for
# that network instead.
set -euo pipefail
cd "$(dirname "$0")/.."

feature="${1:-}"
for manifest in \
  examples/voting/pinocchio/Cargo.toml \
  examples/voting/native/Cargo.toml \
  examples/voting/anchor/Cargo.toml \
  examples/multisig/pinocchio/Cargo.toml \
  examples/multisig/native/Cargo.toml \
  examples/multisig/anchor/Cargo.toml; do
  if [ -n "$feature" ]; then
    cargo build-sbf --tools-version v1.54 --arch v3 --manifest-path "$manifest" -- --features "$feature"
  else
    cargo build-sbf --tools-version v1.54 --arch v3 --manifest-path "$manifest"
  fi
done
