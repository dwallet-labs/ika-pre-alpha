# @ika.xyz/pre-alpha-wasm

The user's half of the ika dWallet protocol, compiled to WebAssembly. `@ika.xyz/pre-alpha-core` loads
it. This directory holds the compiled package only: `dist/node` for Node, `dist/web` for browsers,
and `dist/bundler` for bundlers.

In the devnet pre-alpha's mock mode the SDK skips these computations, so an app on the pre-alpha
never calls into this package.

These files are the ones published as `@ika.xyz/pre-alpha-wasm` 0.1.0. They were built in release
mode with wasm-pack 0.15.1, for the three targets, from the public
[inkrypto](https://github.com/dwallet-labs/inkrypto) at revision
`8347fd40eb8d95ee6a1f59a0813381b3d81f62c3`.
