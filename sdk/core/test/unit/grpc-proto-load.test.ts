// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The network client loads its service definition from text it carries,
 * without writing a file.
 *
 * It once wrote that text to a fixed name in the shared temporary directory
 * and read it back. Another user of the machine could put a link, or another
 * definition, at that name first. These tests count every call the client
 * makes to the temporary directory and to the file writers, and require
 * none. They also check that the definition loaded in memory keeps the field
 * names as written, as the file load did: the client sends `user_signature`
 * and `signed_request_data` under those names.
 */
import { describe, expect, it, vi } from 'vitest';

import { DWalletGrpcClient } from '../../src/grpc/client';
import { encodeRequest } from '../../src/grpc/messages';

const touched = vi.hoisted(() => ({ tmpdir: 0, writeFileSync: 0, mkdtempSync: 0 }));

vi.mock('node:os', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:os')>();
	const tmpdir = () => {
		touched.tmpdir += 1;
		return actual.tmpdir();
	};
	return { ...actual, default: { ...actual, tmpdir }, tmpdir };
});

vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs')>();
	const writeFileSync: typeof actual.writeFileSync = (...args) => {
		touched.writeFileSync += 1;
		return actual.writeFileSync(...args);
	};
	const mkdtempSync = ((...args: Parameters<typeof actual.mkdtempSync>) => {
		touched.mkdtempSync += 1;
		return actual.mkdtempSync(...args);
	}) as typeof actual.mkdtempSync;
	return {
		...actual,
		default: { ...actual, writeFileSync, mkdtempSync },
		writeFileSync,
		mkdtempSync,
	};
});

describe('loading the service definition', () => {
	it('touches neither the temporary directory nor a file', () => {
		new DWalletGrpcClient('127.0.0.1:1', undefined, [], { insecure: true });

		expect(touched.tmpdir).toBe(0);
		expect(touched.writeFileSync).toBe(0);
		expect(touched.mkdtempSync).toBe(0);
	});

	it('keeps the field names as written', () => {
		const bytes = encodeRequest('SubmitTransaction', {
			user_signature: Uint8Array.from([1]),
			signed_request_data: Uint8Array.from([2]),
		});

		// Field 1 and field 2, each one byte long. Names the definition did
		// not keep would serialize as nothing.
		expect([...bytes]).toEqual([0x0a, 0x01, 0x01, 0x12, 0x01, 0x02]);
	});
});
