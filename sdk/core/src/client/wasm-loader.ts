// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

import type * as WasmModule from '@ika.xyz/ika-wasm';

let wasmModule: typeof WasmModule | null = null;
let initPromise: Promise<void> | null = null;
const isNode = typeof process !== 'undefined' && !!process.versions?.node;

export async function ensureWasmInitialized() {
	if (wasmModule) return;
	if (!initPromise) initPromise = init();
	await initPromise;
}

async function init() {
	// Always import root; exports pick web vs node for us
	const mod: any = await import('@ika.xyz/ika-wasm');

	if (isNode) {
		// Node glue self-initializes (uses fs internally)
		const normalized = mod && typeof mod === 'object' && 'default' in mod ? mod.default : mod;
		if (typeof normalized.generate_secp_cg_keypair_from_seed_v2 !== 'function') {
			throw new Error('ika-wasm node glue not initialized (wrong target?)');
		}
		wasmModule = normalized as typeof WasmModule;
		return;
	}

	// Web glue: explicitly init with NO args so it fetches its own wasm URL
	const initFn: any = mod.default ?? mod.init;
	if (typeof initFn !== 'function') throw new Error('ika-wasm web glue missing init()');
	await initFn(); // <— NO url here
	wasmModule = mod as typeof WasmModule;
}

/**
 * `@ika.xyz/ika-wasm` loaded in this thread. The worker program calls it; every
 * other caller goes through `getWasmModule`, which honours `useWasmWorker`.
 */
export async function wasmModuleOfThisThread(): Promise<typeof WasmModule> {
	await ensureWasmInitialized();
	return wasmModule!;
}

async function getWasmModule(): Promise<typeof WasmModule> {
	return workerCalls ? workerCalls.module : wasmModuleOfThisThread();
}

// ── Running the WASM calls in a worker ─────────────────────────────────────

/** A WASM call the main thread sends to the worker. */
export interface WasmCall {
	id: number;
	/** The name of an `@ika.xyz/ika-wasm` function. */
	name: string;
	args: unknown[];
}

/** The worker's answer to a `WasmCall`: its result, or its error's message. */
export type WasmCallAnswer = { id: number; result: unknown } | { id: number; error: string };

/**
 * A worker the WASM calls can run in, as a browser's `Worker` is: a module
 * worker that runs `@ika.xyz/sdk-core/wasm-worker`.
 */
export interface WasmWorker {
	postMessage(message: unknown): void;
	addEventListener(type: 'message', listener: (event: { data: WasmCallAnswer }) => void): void;
	addEventListener(type: 'error', listener: (event: { message?: string }) => void): void;
	terminate(): unknown;
}

/** The worker, as the calls use it, whichever kind of worker it is. */
interface WorkerPort {
	post(message: WasmCall): void;
	terminate(): void;
	/** Node only: keep the process alive while a call is pending, and only then. */
	ref?(): void;
	unref?(): void;
}

/** The calls sent to one worker, each waiting for its answer. */
class WorkerCalls {
	readonly #port: WorkerPort;
	readonly #pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	#nextId = 0;
	/** The WASM module's functions, each sending its call to the worker. */
	readonly module: typeof WasmModule;

	constructor(connect: (calls: WorkerCalls) => WorkerPort) {
		this.#port = connect(this);
		// `then` stays undefined: the module is returned from an async
		// function, and a value with a `then` would be awaited as a promise.
		this.module = new Proxy({} as typeof WasmModule, {
			get: (_, name) =>
				typeof name === 'string' && name !== 'then'
					? (...args: unknown[]) => this.#call(name, args)
					: undefined,
		});
	}

	#call(name: string, args: unknown[]): Promise<unknown> {
		const id = this.#nextId++;
		return new Promise((resolve, reject) => {
			if (this.#pending.size === 0) this.#port.ref?.();
			this.#pending.set(id, { resolve, reject });
			this.#port.post({ id, name, args });
		});
	}

	answered(message: WasmCallAnswer): void {
		const pending = this.#pending.get(message.id);
		if (pending === undefined) return;
		this.#pending.delete(message.id);
		if (this.#pending.size === 0) this.#port.unref?.();
		if ('error' in message) {
			pending.reject(new Error(message.error));
		} else {
			pending.resolve(message.result);
		}
	}

	/** Reject every pending call: the worker failed, or was stopped. */
	failed(reason: string): void {
		const error = new Error(
			`the WASM worker ${reason}. If your bundler did not ship the worker file, pass ` +
				'your own worker, made from `@ika.xyz/sdk-core/wasm-worker`, to useWasmWorker',
		);
		this.#pending.forEach(({ reject }) => reject(error));
		this.#pending.clear();
		this.#port.unref?.();
	}

	terminate(): void {
		this.failed('was stopped');
		this.#port.terminate();
	}
}

let workerCalls: WorkerCalls | null = null;

/**
 * Run every WASM call of this package in a worker from now on, instead of on
 * the calling thread. The calls are the slow ones: making the user's half of
 * a dWallet, encrypting a share, and the user's half of a signature. In a
 * browser they would otherwise freeze the page while they run. The results
 * are the same; only the thread changes.
 *
 * With no argument, the package starts its own worker: a module `Worker` in a
 * browser, which bundlers that follow `new URL(..., import.meta.url)` ship,
 * and a `worker_threads` worker in Node. A worker that is idle does not keep a
 * Node process alive. Pass `worker` to use a worker you made, for example
 * when your bundler does not ship the package's own:
 * `new Worker(new URL('@ika.xyz/sdk-core/wasm-worker', import.meta.url), { type: 'module' })`.
 *
 * The setting is for the whole page or process, not for one client. Calling
 * it again stops the previous worker, and its pending calls are rejected.
 */
export function useWasmWorker(worker?: WasmWorker): void {
	stopWasmWorker();
	workerCalls = new WorkerCalls((calls) =>
		worker === undefined ? ownWorker(calls) : givenWorker(worker, calls),
	);
}

/** Stop the WASM worker, if one runs: the calls run on the calling thread again. */
export function stopWasmWorker(): void {
	workerCalls?.terminate();
	workerCalls = null;
}

function givenWorker(worker: WasmWorker, calls: WorkerCalls): WorkerPort {
	worker.addEventListener('message', (event) => calls.answered(event.data));
	worker.addEventListener('error', (event) =>
		calls.failed(`failed: ${event.message ?? 'it could not load'}`),
	);
	return { post: (message) => worker.postMessage(message), terminate: () => worker.terminate() };
}

/** The package's own worker, running `./wasm-worker.js` beside this file. */
function ownWorker(calls: WorkerCalls): WorkerPort {
	if (isNode) {
		const { Worker } = process.getBuiltinModule('node:worker_threads');
		const worker = new Worker(new URL('./wasm-worker.js', import.meta.url));
		worker.unref();
		worker.on('message', (message: WasmCallAnswer) => calls.answered(message));
		worker.on('error', (error: Error) => calls.failed(`failed: ${error.message}`));
		worker.on('exit', (code: number) => calls.failed(`exited with code ${code}`));
		return {
			post: (message) => worker.postMessage(message),
			terminate: () => void worker.terminate(),
			ref: () => worker.ref(),
			unref: () => worker.unref(),
		};
	}
	// Bundlers find the worker file by this exact expression.
	return givenWorker(
		new Worker(new URL('./wasm-worker.js', import.meta.url), { type: 'module' }) as WasmWorker,
		calls,
	);
}

// Export wrapped functions that ensure WASM is initialized
export async function encrypt_secret_share(
	curve: number,
	userSecretKeyShare: Uint8Array,
	encryptionKey: Uint8Array,
	protocolPublicParameters: Uint8Array,
): Promise<Uint8Array> {
	const wasm = await getWasmModule();
	return wasm.encrypt_secret_share(
		curve,
		userSecretKeyShare,
		encryptionKey,
		protocolPublicParameters,
	);
}

export async function verify_user_share(
	curve: number,
	userSecretKeyShare: Uint8Array,
	userDKGOutput: Uint8Array,
	networkDkgPublicOutput: Uint8Array,
): Promise<boolean> {
	const wasm = await getWasmModule();
	return wasm.verify_user_share(curve, userSecretKeyShare, userDKGOutput, networkDkgPublicOutput);
}

export async function generate_secp_cg_keypair_from_seed_v2(
	curve: number,
	seed: Uint8Array,
): Promise<[Uint8Array, Uint8Array]> {
	const wasm = await getWasmModule();
	return wasm.generate_secp_cg_keypair_from_seed_v2(curve, seed);
}

export async function create_dkg_centralized_output_v2(
	curve: number,
	protocolPublicParameters: Uint8Array,
	session_id: Uint8Array,
): Promise<[Uint8Array, Uint8Array, Uint8Array]> {
	const wasm = await getWasmModule();
	return wasm.create_dkg_centralized_output_v2(curve, protocolPublicParameters, session_id);
}

export async function create_imported_dwallet_centralized_step(
	curve: number,
	protocolPublicParameters: Uint8Array,
	sessionIdentifier: Uint8Array,
	secretKey: Uint8Array,
): Promise<[Uint8Array, Uint8Array, Uint8Array]> {
	const wasm = await getWasmModule();
	return wasm.create_imported_dwallet_centralized_step(
		curve,
		protocolPublicParameters,
		sessionIdentifier,
		secretKey,
	);
}

export async function create_sign_centralized_party_message_with_centralized_party_dkg_output(
	protocolPublicParameters: Uint8Array,
	userPublicOutput: Uint8Array,
	userSecretKeyShare: Uint8Array,
	presign: Uint8Array,
	message: Uint8Array,
	hash: number,
	signatureAlgorithm: number,
	curve: number,
	hashContext?: Uint8Array,
): Promise<Uint8Array> {
	const wasm = await getWasmModule();
	return wasm.create_sign_centralized_party_message_with_centralized_party_dkg_output(
		protocolPublicParameters,
		userPublicOutput,
		userSecretKeyShare,
		presign,
		message,
		hash,
		signatureAlgorithm,
		curve,
		hashContext,
	);
}

export async function create_sign_centralized_party_message(
	protocolPublicParameters: Uint8Array,
	publicOutput: Uint8Array,
	userSecretKeyShare: Uint8Array,
	presign: Uint8Array,
	message: Uint8Array,
	hash: number,
	signatureScheme: number,
	curve: number,
	hashContext?: Uint8Array,
): Promise<Uint8Array> {
	const wasm = await getWasmModule();
	return wasm.create_sign_centralized_party_message(
		protocolPublicParameters,
		publicOutput,
		userSecretKeyShare,
		presign,
		message,
		curve,
		signatureScheme,
		hash,
		hashContext,
	);
}

export async function create_sign_centralized_party_message_ecdsa_blake2b256(
	protocolPublicParameters: Uint8Array,
	publicOutput: Uint8Array,
	userSecretKeyShare: Uint8Array,
	presign: Uint8Array,
	message: Uint8Array,
	personal: Uint8Array,
	salt: Uint8Array,
): Promise<Uint8Array> {
	const wasm = await getWasmModule();
	return wasm.create_sign_centralized_party_message_ecdsa_blake2b256(
		protocolPublicParameters,
		publicOutput,
		userSecretKeyShare,
		presign,
		message,
		personal,
		salt,
	);
}

export async function network_dkg_public_output_to_protocol_pp(
	curve: number,
	networkDkgPublicOutput: Uint8Array,
): Promise<Uint8Array> {
	const wasm = await getWasmModule();
	return wasm.network_dkg_public_output_to_protocol_pp(curve, networkDkgPublicOutput);
}

export async function verify_signature(
	curve: number,
	signatureAlgorithm: number,
	hash: number,
	hashContext: Uint8Array | undefined,
	dWalletPublicOutput: Uint8Array,
	message: Uint8Array,
	signature: Uint8Array,
): Promise<void> {
	const wasm = await getWasmModule();
	await wasm.verify_signature(
		curve,
		signatureAlgorithm,
		hash,
		hashContext,
		dWalletPublicOutput,
		message,
		signature,
	);
}

export async function verify_ecdsa_blake2b256_signature(
	personal: Uint8Array,
	salt: Uint8Array,
	dWalletPublicOutput: Uint8Array,
	message: Uint8Array,
	signature: Uint8Array,
): Promise<void> {
	const wasm = await getWasmModule();
	await wasm.verify_ecdsa_blake2b256_signature(
		personal,
		salt,
		dWalletPublicOutput,
		message,
		signature,
	);
}

export async function public_key_from_dwallet_output(
	curve: number,
	dWalletOutput: Uint8Array,
): Promise<Uint8Array> {
	const wasm = await getWasmModule();
	return wasm.public_key_from_dwallet_output(curve, dWalletOutput);
}

export async function public_key_from_centralized_dkg_output(
	curve: number,
	centralizedDkgOutput: Uint8Array,
): Promise<Uint8Array> {
	const wasm = await getWasmModule();
	return wasm.public_key_from_centralized_dkg_output(curve, centralizedDkgOutput);
}

export async function dwallet_output_at_latest_version(
	curve: number,
	dWalletOutput: Uint8Array,
	publicKey: Uint8Array,
): Promise<Uint8Array> {
	const wasm = await getWasmModule();
	return wasm.dwallet_output_at_latest_version(curve, dWalletOutput, publicKey);
}

export async function reconfiguration_public_output_to_protocol_pp(
	curve: number,
	reconfig_public_output: Uint8Array,
	network_dkg_public_output: Uint8Array,
): Promise<Uint8Array> {
	const wasm = await getWasmModule();
	return wasm.reconfiguration_public_output_to_protocol_pp(
		curve,
		reconfig_public_output,
		network_dkg_public_output,
	);
}

export async function centralized_and_decentralized_parties_dkg_output_match(
	curve: number,
	userPublicOutput: Uint8Array,
	networkDKGOutput: Uint8Array,
): Promise<boolean> {
	const wasm = await getWasmModule();
	return wasm.centralized_and_decentralized_parties_dkg_output_match(
		curve,
		userPublicOutput,
		networkDKGOutput,
	);
}

export async function decrypt_user_share(
	curve: number,
	decryptionKey: Uint8Array,
	dWalletPublicOutput: Uint8Array,
	encryptedShare: Uint8Array,
	protocolPublicParameters: Uint8Array,
): Promise<Uint8Array> {
	const wasm = await getWasmModule();
	return wasm.decrypt_user_share(
		curve,
		decryptionKey,
		dWalletPublicOutput,
		encryptedShare,
		protocolPublicParameters,
	);
}

/**
 * Manually initialize the WASM module.
 * This is optional as functions will auto-initialize on first use.
 * Useful for preloading the WASM module during app initialization.
 */
export async function initializeWasm(): Promise<void> {
	await ensureWasmInitialized();
}
