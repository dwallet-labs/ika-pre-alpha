# @ika.xyz/ika-wasm

The user's half of the ika dWallet protocol, compiled to WebAssembly. `@ika.xyz/sdk-core` loads
it. This directory holds the compiled package only: `dist/node` for Node, `dist/web` for browsers,
and `dist/bundler` for bundlers.

In the devnet pre-alpha's mock mode the SDK skips these computations, so an app on the pre-alpha
never calls into this package.
