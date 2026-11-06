# Examples

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

Two complete examples show a Solana program that controls a dWallet:

| Example | What decides a signature |
| --- | --- |
| [Voting](./voting/01-overview.md) | A council votes on a message. When yes votes reach the quorum, the program issues a voucher. |
| [Multisig](./multisig/01-overview.md) | Fixed members approve a message. When approvals reach the threshold, the program issues a voucher. |

Each example binds its governance to the one dWallet it controls. [Integrator
Invariants](../on-chain/integrator-invariants.md) explains why that matters.

## What each example contains

```
examples/<name>/
├── pinocchio/     the program, written with Pinocchio, with Mollusk and LiteSVM tests
├── native/        the same program with plain solana-program, with the same tests
├── anchor/        the same program with Anchor, with LiteSVM tests
└── e2e/           the end-to-end demo in TypeScript, run with Bun
```

The multisig example also has `react/`, a page that runs the multisig flow in a browser with a
connected wallet.

The demos share their common steps in `examples/_shared/`. Each demo's own file is then only its
governance story.

## How every demo runs

The demos use the SDK as an app does, in mock mode for the pre-alpha:

1. **Make a user.** The demo makes new user keys, registers the encryption key on Solana, and opens a
   gas deposit for the user's request key.
2. **Create a dWallet.** The demo asks the network for a dWallet, accepts the user's share on Solana,
   and waits until the dWallet is active. The payer's wallet owns it.
3. **Create the governance.** The council or the multisig is an account of the example program, keyed
   by the dWallet's address. The dWallet's owner signs its creation, so this happens before the
   transfer.
4. **Transfer the dWallet** to the example program's CPI authority.
5. **Propose a message.** A member creates the proposal. It names the user's request key as the key
   allowed to ask for the signature.
6. **Approve it.** Members vote or approve. The approval that reaches the quorum or threshold makes
   the program issue the signature voucher through a CPI, in the same transaction.
7. **Sign.** The demo takes a presign and sends the sign request, naming the voucher. The network reads
   the voucher on Solana for itself, returns the signature, and writes it into the voucher account.
8. **Check.** The demo checks that the signature it got back equals the one written on Solana, and that
   it verifies under the dWallet's public key.

## Running them

The demos run against the devnet pre-alpha by default. You need:

- a devnet keypair with about 1 SOL, from <https://faucet.solana.com>. Deploying an example program
  needs most of it, and closing the program afterwards returns it;
- the example program built and deployed to devnet;
- Bun, and the SDK built from this repository;
- a Rust toolchain with `cargo build-sbf`, to build the program.

Build and deploy the Pinocchio variant of an example:

```bash
cargo build-sbf --tools-version v1.54 --arch v3 --manifest-path examples/voting/pinocchio/Cargo.toml \
  -- --features devnet-pre-alpha
solana program deploy -u devnet --keypair <your-keypair.json> target/deploy/ika_example_voting_pinocchio.so
```

The `devnet-pre-alpha` feature builds the program for the devnet pre-alpha's ika program. A
program built without it refuses every devnet dWallet. The deploy prints the program id. Each example's end-to-end page shows how to run its demo with that
id. When you are done, `solana program close <program id> -u devnet --keypair <your-keypair.json>
--bypass-warning` returns the program's rent. A closed program's address cannot be used again.

The program tests run in-process, with no network:

```bash
cargo test -p ika-example-voting-pinocchio --test litesvm
cargo test -p ika-example-multisig --test litesvm
```
