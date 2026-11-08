// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The program of the worker `useWasmWorker` starts: it loads `@ika.xyz/pre-alpha-wasm`
 * in the worker's own thread, and runs each WASM call the main thread sends.
 *
 * A message from the main thread is `{ id, name, args }`: the name of an
 * `@ika.xyz/pre-alpha-wasm` function and its arguments. The worker answers
 * `{ id, result }`, or `{ id, error }` with the error's message. The same file
 * runs in a browser's module worker and in a Node `worker_threads` worker. In
 * Node it reaches `worker_threads` through `process.getBuiltinModule`, so a
 * browser bundler finds no Node import here.
 */
import { wasmModuleOfThisThread } from './wasm-loader.js';
import type { WasmCall, WasmCallAnswer } from './wasm-loader.js';

const nodeParentPort =
	typeof process !== 'undefined' && !!process.versions?.node
		? process.getBuiltinModule('node:worker_threads').parentPort
		: null;

function answer(message: WasmCallAnswer): void {
	if (nodeParentPort) {
		nodeParentPort.postMessage(message);
	} else {
		self.postMessage(message);
	}
}

async function run({ id, name, args }: WasmCall): Promise<void> {
	try {
		const wasm = (await wasmModuleOfThisThread()) as unknown as Record<string, unknown>;
		const call = wasm[name];
		if (typeof call !== 'function') {
			throw new Error(`@ika.xyz/pre-alpha-wasm has no function ${name}`);
		}
		answer({ id, result: call(...args) });
	} catch (error) {
		answer({ id, error: error instanceof Error ? error.message : String(error) });
	}
}

if (nodeParentPort) {
	nodeParentPort.on('message', (call: WasmCall) => void run(call));
} else {
	self.addEventListener('message', (event: MessageEvent<WasmCall>) => void run(event.data));
}
