# The Devnet Pre-Alpha

> **Pre-alpha.** This network is a mock with no MPC. It can sign anything with any dWallet, and it is
> wiped from time to time. Read [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network)
> first.

This page lists the addresses and values an app needs to reach the pre-alpha, and what is different
about it.

## Addresses

| What | Value |
| --- | --- |
| Solana cluster | devnet |
| Solana RPC | `https://api.devnet.solana.com`, or your own devnet RPC provider |
| ika program | `CqGtQgrYFUhobuknomFNntwoxCgKGkBRUtemgdPuM9qT` |
| ika network, gRPC-Web | `https://solana-alpha-dev-1.ika-network.net` |
| Network key | `fe8a6482521cc4bae052c55cd5b3c92d05c8749bcc2c584046de3efb077d65ed` |
| Chain number | `1` |
| Network value | `3` |
| IKA mint | `2hncrdGVjmRtDFQ4bsNkoJd5XuR2v1DKiUX7aSRUA3H1` |
| Treasury vault | `476J1DYngyTv6uqQ7pooJ6Mv1rxsZNdbd4h6A2vmRNFc` |

The SDK needs the network key, the chain number and the network value when you create the client.
A gas deposit's top-up names the IKA mint and the treasury vault.
The chain number and the network value are recorded in the program's dWallet coordinator account.
The SDK checks every answer against the network key, and the user signs the chain number and the
network value into their gas deposit. So copy these values from this page or from the coordinator
account. Never take them from an answer of the ika network.

The program and its accounts are wiped from time to time. A wipe can change the program id and the
network key. When it does, this page changes with it.

## Connecting

The pre-alpha serves the ika network's API over gRPC-Web, with a public TLS certificate. Use the
SDK's gRPC-Web client, `DWalletGrpcClient` from `@ika.xyz/sdk-core/web`. It works in a browser and
in Node, because it sends its calls through `fetch`. A plain gRPC client gets HTTP status 400 from
this address.

```ts
import { DWalletGrpcClient } from '@ika.xyz/sdk-core/web';

const grpc = new DWalletGrpcClient('https://solana-alpha-dev-1.ika-network.net');
```

## Mock mode

The pre-alpha's network key is a mock value. A client created without mock mode refuses it with the
error "mock values need the SDK's mock feature". A client in mock mode refuses any real network key.
So the SDK's mock mode is only for the pre-alpha, and it cannot be turned on by accident against the
real network.

In mock mode the SDK skips the user's half of the 2PC-MPC computations, because the mock has no MPC
to answer them. Every other check stays: the network's signatures on its answers, the records on
Solana, the holder's acceptance of a share, and each signature against the dWallet's public key.

See [mock mode in the TypeScript SDK](../frameworks/typescript.md#mock-mode-for-the-pre-alpha).

## Paying for requests

Each request to the ika network is charged to a gas deposit on Solana. A gas deposit belongs to a
request key, and the SDK derives the request key from the user's root seed. So a user needs one gas
deposit for each root seed, whatever curves their dWallets use. A request signed by a key with no
deposit is refused with "this transport key has no gas deposit on the chain the request names".

The mock charges nothing. An empty gas deposit is enough in the pre-alpha, but it must exist.

## Getting devnet SOL

Every Solana transaction costs SOL: the encryption key's registration, the gas deposit, the
acceptance of a share and each voucher. The devnet RPC faucet is closed, so the SDK's examples cannot
ask for an airdrop. Get devnet SOL from <https://faucet.solana.com>. One SOL covers many dWallets
and signatures.

## Things that differ from what you might expect

- **ECDSA signatures are 65 bytes.** On secp256k1 and P-256, the first byte is the recovery byte,
  then come `r` and `s`. A verifier that takes 64 bytes needs `signature.slice(1)`. Ed25519 signatures
  are the usual 64 bytes.
- **The public Solana RPC limits its rate.** A full flow reads many accounts, and
  `https://api.devnet.solana.com` answers some of those reads with HTTP 429. Use your own devnet RPC
  provider, or retry reads that get 429.
- **Imported keys get a new key.** As the introduction says, the mock makes a new key for an
  imported dWallet. Your imported key never leaves your device, and the dWallet does not sign as it.
