# @ika.xyz/pre-alpha-core

The chain-neutral core of the ika dWallet SDK: the requests to the network and their BCS types, the
request signing, the checks of the network's answers, the user's keys, and the user's half of the
cryptography. An app on Solana uses it through `@ika.xyz/pre-alpha-solana`, which re-exports what an app
needs, and imports `@ika.xyz/pre-alpha-core` directly for two things: the mock mode and the browser client.

> **Pre-alpha.** The Solana devnet pre-alpha is a mock ika network with no MPC. Read the warning in
> the docs (`docs/src/introduction.md`) before you build anything.

## Entry points

- `@ika.xyz/pre-alpha-core` loads in a browser. It holds the request builders and their BCS types, the
  attestation and share checks, and the cryptography the flow uses, through `@ika.xyz/pre-alpha-wasm`.
- `@ika.xyz/pre-alpha-core/client` is Node only. It holds `DWalletGrpcClient`, the client that sends
  requests to the network over gRPC. It opens HTTP/2 sockets through `@grpc/grpc-js`, which a browser
  cannot do.
- `@ika.xyz/pre-alpha-core/web` is the client for a browser. Its `DWalletGrpcClient` has the same calls and
  the same rules as the Node one, and speaks gRPC-Web over `fetch`. It works in Node too, and it is
  the client the devnet pre-alpha needs: the pre-alpha serves gRPC-Web at
  `https://solana-alpha-dev-1.ika-network.net`.
- `@ika.xyz/pre-alpha-core/mock` is the mock mode, which the devnet pre-alpha needs. Wrap the client's
  options in `withMockCryptography`. The main entry never imports it, so an app that does not import
  `/mock` ships no mock code.
- `@ika.xyz/pre-alpha-core/wasm-worker` is the program of the Web Worker that `useWasmWorker` starts.

## Mock mode

In mock mode the SDK skips its 2PC-MPC computations: the user's half of the key generation, the
encryption and decryption of the share, and the user's half of each signature. Every other check
stays: the network's signatures on its answers, the records on the chain, the holder's acceptance of
a share, and each signature against the dWallet's public key.

- Mock mode needs a custom network.
- A client in mock mode refuses a network that serves a real network key.
- Mock mode belongs to one client. Every other client, in the same process too, refuses the mock's
  values with the error "mock values need the SDK's mock feature".
- No private key is ever sent to the mock. In mock mode, importing a key does not read the key you
  pass: the mock makes a new key for the dWallet.

## Module support

The package ships ES modules only. It needs Node 22.12.0 or later.

- Use `import { ... } from '@ika.xyz/pre-alpha-core'` from an ES module. Bundlers use the ES-module build.
- From CommonJS code, load the package with `await import('@ika.xyz/pre-alpha-core')`. Node 22.12 and later
  can also `require` it.
- A TypeScript project should set `moduleResolution` to `node16`, `nodenext` or `bundler`. Legacy
  `moduleResolution: node` does not read `exports`, so it cannot find `@ika.xyz/pre-alpha-core/client`.

## In a browser

The user's half of each protocol step runs in `@ika.xyz/pre-alpha-wasm`. Under the `browser` condition its
web build fetches its `.wasm` file from beside its own module URL, which Vite, webpack 5 and Next.js
copy into the build. If Vite's development server cannot find the file, leave the package out of
Vite's dependency pre-bundling (`optimizeDeps: { exclude: ['@ika.xyz/pre-alpha-wasm'] }`). In mock mode the
SDK makes none of these calls.

On the real network, the class-group operations take seconds and freeze a page's main thread. Call
`useWasmWorker()` once at startup, and they run in a Web Worker.

A page whose Content Security Policy sets `script-src` must allow `'wasm-unsafe-eval'` there, and
must allow connections to the network's gRPC-Web endpoint and to its Solana RPC (`connect-src`).

## Build and test (in this repository)

```bash
pnpm install
pnpm --filter @ika.xyz/pre-alpha-core build
pnpm --filter @ika.xyz/pre-alpha-core test
```

`build` writes `dist/esm`: esbuild transpiles each source file, and `tsc` writes the declarations.

## License

BSD-3-Clause-Clear
