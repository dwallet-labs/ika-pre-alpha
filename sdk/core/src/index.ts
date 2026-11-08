// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

// The browser-safe entry. The network client is not exported here: import it
// from `@ika.xyz/pre-alpha-core/client` in Node, which opens sockets, or from
// `@ika.xyz/pre-alpha-core/web` in a browser, which speaks gRPC-Web over `fetch`.
export * from './client/cryptography.js';
export * from './client/hash-signature-validation.js';
export * from './client/types.js';
export * from './client/user-cryptography.js';
export { initializeWasm, stopWasmWorker, useWasmWorker } from './client/wasm-loader.js';
export type { WasmWorker } from './client/wasm-loader.js';
export * from './grpc/index.js';
