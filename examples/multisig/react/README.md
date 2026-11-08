# The multisig demo, in a browser

Everything the Node multisig demo does, from a page: a dWallet owned by a
connected wallet, and a message that gets signed once enough members
approve it. Every approval is a wallet signature, which is what an
integrator actually ships.

The page uses the SDK as a browser app does: `IkaClient` and
`IkaTransaction` from `@ika.xyz/pre-alpha-solana/web3`, talking gRPC-Web to the
ika network through `fetch` (`src/lib/ika.ts`).

It does not walk every request type. It creates one dWallet and signs one
message with it.

## The Solana devnet pre-alpha is a mock

The devnet pre-alpha runs on a mock ika network. One backend holds an
ordinary key for each dWallet and signs with it alone, so the page builds
its client in mock mode (`withMockCryptography` from
`@ika.xyz/pre-alpha-core/mock`). Mock mode skips the user's half of the 2PC-MPC
computation and keeps every other check. Do not put real funds on a
pre-alpha dWallet. Against the real network, build the client without
`withMockCryptography`; nothing else on the page changes.

## A browser talks gRPC-Web

No browser API can open plain gRPC, so the page speaks gRPC-Web. The devnet
pre-alpha serves gRPC-Web at `https://solana-alpha-dev-1.ika-network.net`,
which is the page's default.

## Running it

```bash
# Once, from the repository root: the SDK's dependencies, then the SDK.
pnpm install
pnpm --filter @ika.xyz/pre-alpha-core build
pnpm --filter @ika.xyz/pre-alpha-solana build

cd examples/multisig/react
VITE_DWALLET_PROGRAM_ID=8siGnE3tCZbu4LTuX8QoBPErvWeGBF4pRSJDnaGdHyQv \
VITE_MULTISIG_PROGRAM_ID=<your deployed multisig program> \
pnpm dev
```

`VITE_RPC_URL` (default `https://api.devnet.solana.com`) and
`VITE_GRPC_WEB_URL` (default the devnet pre-alpha) pick another cluster or
network. The connected wallet needs devnet SOL: it pays for every
transaction. The multisig program is the one in
`examples/multisig/pinocchio`, deployed to the same cluster.

## Two keys, and which is which

The page uses two keys.

**The connected wallet** owns the dWallet, pays for every transaction, and
signs the multisig's instructions.

**The user's keys** (`UserShareEncryptionKeys`) hold the key the user's
share is encrypted to and the request key that signs every gRPC request.
The network charges the request key's gas deposit, not the transaction's
fee payer, so **the gas deposit belongs to the request key**, and the
wallet only pays to open it. The two are bound together at that moment: the
request key signs a message naming the wallet's address, and the program
checks that signature before it creates the deposit.

The proposal records the request key as the one allowed to sign with the
voucher, because that is the key that will ask the network to sign.

The page makes the keys from a new random root seed and holds it in memory.
Reloading the page loses the keys, and with them the user's share of the
dWallet the page made. A real app keeps the root seed, encrypted, or
derives it from something the user holds.
