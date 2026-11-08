// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

import { describe, expect, it, vi } from 'vitest';

import { initializeWasm } from '../../src/client/wasm-loader';

// The WASM package is replaced by an object the test changes. While the
// object lacks the function the loader checks for, loading fails, as it
// would after a broken download. Once the function is added, loading works.
const wasmGlue = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock('@ika.xyz/pre-alpha-wasm', () => ({ default: wasmGlue }));

describe('the WASM loader', () => {
	it('loads again after a failed load instead of keeping the failure', async () => {
		await expect(initializeWasm()).rejects.toThrow('ika-wasm node glue not initialized');

		wasmGlue.generate_secp_cg_keypair_from_seed_v2 = () => new Uint8Array();

		await expect(initializeWasm()).resolves.toBeUndefined();
	});
});
