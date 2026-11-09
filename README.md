# dWallets on Solana: the devnet pre-alpha

A dWallet is a signing key that a Solana account controls. It can sign for any chain: Bitcoin,
Ethereum, Solana and others. The dWallet's owner decides which messages it signs, and the ika
network produces the signatures. When the owner is your Solana program, your program's rules decide
what the dWallet signs.

This repository has what you need to build on the Solana devnet pre-alpha: the TypeScript SDK, the
crates a Solana program uses to control dWallets, examples, the developer guide, and a skill for
coding agents.

> **The devnet pre-alpha is a mock network.** One backend stands in for the ika network. There is
> no MPC: the backend holds an ordinary key for every dWallet, and can sign any message with any
> dWallet. Put no real funds on a pre-alpha dWallet. No private key is ever sent to the backend: an
> imported key is not read, and the backend makes a new key for the dWallet. The program and all its
> accounts are wiped from time to time. Interfaces, account layouts and the SDK's API can change
> without notice.
>
> The Solana program, the transactions and the SDK's calls are the ones the real network uses, so an
> app written against the pre-alpha moves to the real network by dropping mock mode.
>
> This software is provided "as is", without warranty of any kind. You use it entirely at your own
> risk, and dWallet Labs assumes no liability for any damages arising from its use.

## Contents

| Path | What it is |
| --- | --- |
| `sdk/core` | `@ika.xyz/pre-alpha-core`: requests to the ika network, the user's keys, the checks of the network's answers, and mock mode (`@ika.xyz/pre-alpha-core/mock`) |
| `sdk/solana` | `@ika.xyz/pre-alpha-solana`: `IkaClient` and `IkaTransaction` for Solana, the program's addresses, instructions and account readers |
| `crates/ika-dwallet-pinocchio` | CPI crate for Pinocchio programs |
| `crates/ika-dwallet-native` | CPI crate for `solana-program` programs |
| `crates/ika-dwallet-anchor` | CPI crate for Anchor programs |
| `crates/ika-protocol-program-id` | The ika program's address on each network |
| `bin/` | The compiled ika program, for local tests |
| `examples/voting` | A council votes, and the quorum makes a dWallet sign: programs in three frameworks, tests, and a TypeScript demo |
| `examples/multisig` | A multisig approves, and the threshold makes a dWallet sign: programs, tests, a TypeScript demo and a React page |
| `docs/` | The developer guide, an mdBook |
| `skills/ika-solana-pre-alpha` | A skill for coding agents |

## The devnet pre-alpha

| What | Value |
| --- | --- |
| Solana cluster | devnet, `https://api.devnet.solana.com` |
| ika program | `8siGnE3tCZbu4LTuX8QoBPErvWeGBF4pRSJDnaGdHyQv` |
| ika network, gRPC-Web | `https://solana-alpha-dev-1.ika-network.net` |
| Network key | `fe8a6482521cc4bae052c55cd5b3c92d05c8749bcc2c584046de3efb077d65ed` |
| Chain number | `1` |
| Network value | `3` |

Get devnet SOL from <https://faucet.solana.com>. The devnet RPC faucet is closed.

## Quick start: an app

The SDK is on npm:

```bash
npm install @ika.xyz/pre-alpha-core @ika.xyz/pre-alpha-solana @solana/web3.js
```

Then create a client in mock mode, make a dWallet and sign:

```ts
import { DWalletGrpcClient } from '@ika.xyz/pre-alpha-core/web';
import { withMockCryptography } from '@ika.xyz/pre-alpha-core/mock';
import { Curve, Hash, IkaClient, SignatureAlgorithm } from '@ika.xyz/pre-alpha-solana/web3';

const ikaClient = new IkaClient(
	withMockCryptography({
		connection,
		grpc: new DWalletGrpcClient('https://solana-alpha-dev-1.ika-network.net'),
		config: {
			network: { custom: { networkPublicKeys: [networkKey] } },
			programId,
			chainNumber: 1,
			networkValue: 3,
		},
	}),
);

const { dWallet } = await ikaClient.requestDWalletDKG({ curve: Curve.ED25519, userShareEncryptionKeys: keys, owner });
```

The [quick start](docs/src/getting-started/quick-start.md) has the whole flow: registering the
encryption key, the gas deposit, accepting the share, approving a message and signing it.

## Quick start: a program

```toml
[dependencies]
ika-dwallet-pinocchio = { git = "https://github.com/dwallet-labs/ika-pre-alpha" }

[features]
devnet-pre-alpha = ["ika-dwallet-pinocchio/devnet-pre-alpha"]
```

```bash
cargo build-sbf --tools-version v1.54 --arch v3 -- --features devnet-pre-alpha
```

The `devnet-pre-alpha` feature makes your program call only the pre-alpha's ika program. See the
[CPI framework](docs/src/on-chain/cpi-framework.md) and the
[voting tutorial](docs/src/tutorial/overview.md).

## The developer guide

The guide is in `docs/`. Read it as Markdown, starting at
[the introduction](docs/src/introduction.md), or build it with [mdBook](https://rust-lang.github.io/mdBook/):

```bash
mdbook serve docs --open
```

## For coding agents

```bash
npx skills add dwallet-labs/ika-pre-alpha --skill ika-solana-pre-alpha
```

The skill holds the pre-alpha's addresses, the rules that prevent the common failures, and compact
references for the SDK and for programs. Add `-g` to install it for every project.

## License

The code is under the license in [LICENSE](LICENSE). The documentation is under
[LICENSE-docs](LICENSE-docs).
