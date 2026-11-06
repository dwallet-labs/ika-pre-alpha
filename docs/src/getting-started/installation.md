# Installation

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

What you install depends on what you build. An app that creates dWallets and asks for signatures
needs an SDK. A Solana program that controls dWallets needs a CPI crate. Most projects have both.

## Tools

- **Rust**, edition 2024: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- **Solana CLI 4.2 or later**: `sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"`. The
  network sends its transactions in format v1, which Agave 4.2 and later can read and send.
- **Node.js 22.12 or later** and **pnpm**, for the TypeScript SDK. Bun runs the examples.
- **Anchor CLI 1.x**, only for Anchor programs. See the [Anchor guide](../frameworks/anchor.md).

## An app in TypeScript

The SDK is two packages, `@ika.xyz/sdk-core` and `@ika.xyz/sdk-solana`, with the crypto package
`@ika.xyz/ika-wasm` they depend on. They are not on npm yet. This repository ships them packed, in
`packages/`, so an app installs them by URL:

```bash
npm install \
  https://github.com/dwallet-labs/ika-pre-alpha/raw/main/packages/ika.xyz-ika-wasm-0.4.0-pre-alpha.tgz \
  https://github.com/dwallet-labs/ika-pre-alpha/raw/main/packages/ika.xyz-sdk-core-0.1.0.tgz \
  https://github.com/dwallet-labs/ika-pre-alpha/raw/main/packages/ika.xyz-sdk-solana-0.1.0.tgz \
  @solana/web3.js
```

To build them from source instead, clone this repository and run `pnpm install && pnpm build` at
its root. `pnpm pack:sdk` packs them again into `packages/`.

`@ika.xyz/sdk-solana` has two entry points. `@ika.xyz/sdk-solana/web3` works with `@solana/web3.js`,
and `@ika.xyz/sdk-solana/kit` works with `@solana/kit`. The kit entry point also needs
`@solana/web3.js` installed, because the SDK builds its instructions with it.

`@ika.xyz/sdk-core` is listed on its own because the pre-alpha's mock mode comes from it, as
`@ika.xyz/sdk-core/mock`. See [the TypeScript SDK](../frameworks/typescript.md).

## A Solana program

Pick the crate for your framework. All three call the same instructions of the ika program, so the
programs they build work the same way.

**Pinocchio**, for the lowest compute cost, `no_std`:

```toml
[dependencies]
ika-dwallet-pinocchio = { git = "https://github.com/dwallet-labs/ika-pre-alpha" }
pinocchio = { version = "0.11", features = ["cpi"] }
pinocchio-system = "0.6"
```

**Anchor 1.x**, declarative:

```toml
[dependencies]
ika-dwallet-anchor = { git = "https://github.com/dwallet-labs/ika-pre-alpha" }
anchor-lang = "1.2"
```

**Native**, plain `solana-program` with no framework:

```toml
[dependencies]
ika-dwallet-native = { git = "https://github.com/dwallet-labs/ika-pre-alpha" }
solana-program = "2.2"
```

Each program also needs:

```toml
[lib]
crate-type = ["cdylib", "lib"]
```

Build for SBPF v3, and name the ika network your program will run on:

```bash
cargo build-sbf --tools-version v1.54 --arch v3 -- --features devnet-pre-alpha
```

- **SBPF v3**, because Solana refuses to deploy a program built for an earlier version.
- **The network feature**, because each CPI crate holds the ika program's address for each network.
  Forward a `devnet-pre-alpha` feature of your own program to the crate's feature of the same name:

  ```toml
  [features]
  devnet-pre-alpha = ["ika-dwallet-pinocchio/devnet-pre-alpha"]
  ```

  The crate's `DWalletContext` refuses to call any other program as the ika program. Without that
  check, a caller could pass a fake ika program and borrow your program's CPI authority to get a
  voucher on another dWallet your program controls. Build without a network feature only for tests.

A program built for one network refuses the dWallets of every other. If a pre-alpha wipe moves the
ika program to a new address, update the crate, rebuild with the feature, and upgrade your program.

## Next

- [The devnet pre-alpha](./devnet.md): the addresses and values to connect with.
- [Quick start](./quick-start.md): a first dWallet and signature.

## For AI coding agents

This repository has a skill for coding agents, `ika-solana-pre-alpha`, in `skills/`. It holds the
pre-alpha's addresses, the rules that prevent the common failures, and the SDK and program
references in a compact form. Install it with the `skills` CLI, which works with most coding agents:

```bash
npx skills add dwallet-labs/ika-pre-alpha --skill ika-solana-pre-alpha
```

Add `-g` to install it for every project, or `-a <agent>` to pick the agents.
