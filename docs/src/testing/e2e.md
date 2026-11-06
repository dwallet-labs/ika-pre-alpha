# End-to-End Tests

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

An end-to-end test runs the whole path: a dWallet is created, your program issues a voucher, the
network signs, and the signature lands in the voucher. It runs on the devnet pre-alpha,
where the ika program and the mock network are already running. You deploy only your own program,
and the SDK runs in mock mode, because the network is the mock.

## On the devnet pre-alpha

| | |
|---|---|
| Solana cluster | devnet, `https://api.devnet.solana.com` |
| ika program | `CqGtQgrYFUhobuknomFNntwoxCgKGkBRUtemgdPuM9qT` |
| ika gRPC-Web | `https://solana-alpha-dev-1.ika-network.net` |

What you need:

1. **A funded devnet wallet.** The devnet RPC faucet is closed. Get devnet SOL from
   `https://faucet.solana.com`. The mock charges no fees, but Solana transactions still cost SOL:
   your own program's deployment, the accounts it creates, and each voucher's rent.
2. **Your program, built for the pre-alpha and deployed to devnet.** Build it with the
   `devnet-pre-alpha` feature, so it calls the pre-alpha's ika program:

   ```bash
   cargo build-sbf --tools-version v1.54 --arch v3 -- --features devnet-pre-alpha
   solana program deploy -u devnet target/deploy/my_program.so
   ```

   A program built without the feature refuses the pre-alpha's dWallets.
3. **The SDK in mock mode.** Wrap the client's options in `withMockCryptography` from
   `@ika.xyz/sdk-core/mock`.

The public devnet RPC limits how fast you can read. A full run reads accounts often while it
waits for the network, and can be refused with HTTP 429. Use your own RPC endpoint, or retry
reads that are refused.

## The steps of a run

A run of a program that controls a dWallet goes like this:

1. Create a gas deposit for your request key. On the mock it needs no funds.
2. Create a dWallet with the SDK, and accept its encrypted share. The SDK does both.
3. While your wallet still owns the dWallet, create your program's rules for it, such as a
   council.
4. Transfer the dWallet to your program's CPI authority.
5. Run your program's instructions until it issues a voucher.
6. Take a presign, and send the sign request that names the voucher. The SDK does both.
7. Wait for the voucher's status to become 1, and check that its signature is the one the gRPC
   answer carried, and that it verifies under the dWallet's public key.

The voting and multisig examples run these steps against the pre-alpha. See
[Examples](../examples/overview.md) for how to run them.
