// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The root entry compiles with `@solana/web3.js` absent.
 *
 * That is the whole point of the split. The addresses, the account readers
 * and the wire tables are plain bytes and need nothing installed; only the
 * instruction builders need `@solana/web3.js`, and they are a subpath, so a
 * consumer that never imports them never has to have it.
 *
 * Nothing in this repository can check that by importing, because every
 * directory here inherits a `node_modules` where `@solana/web3.js` is
 * installed — as this package's own dev dependency, for the builders and
 * their tests. So the check builds a copy of the package's source outside
 * the repository, in a directory whose `node_modules` holds `@noble` and
 * the Node types and nothing else, and typechecks one file that imports the
 * root entry. If anything reachable from the root entry imports
 * `@solana/web3.js`, that typecheck fails to resolve it.
 *
 * Re-adding `export * from './instructions.js'` to `src/index.ts` is the
 * fault this is here to catch, and it does.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * What the root entry's own code needs, and nothing more: `@noble`, the Node
 * types, `@ika.xyz` for the core, whose attestation checks the reader and the
 * Solana record check run, and `@mysten` for the base58 decoding of a
 * submitted transfer's signature.
 */
const ALLOWED = ['@noble', '@types', '@ika.xyz', '@mysten'];

/** A copy of the package's source with a deliberately thin `node_modules`. */
function typecheckRootEntryAlone(): { ok: boolean; output: string } {
	const root = mkdtempSync(join(tmpdir(), 'ika-solana-client-root-'));
	// Only the source is copied. The source reaches nothing outside the
	// package, so the copy needs no file of the repository beside it.
	const dir = join(root, 'package');
	try {
		mkdirSync(dir, { recursive: true });
		cpSync(join(PACKAGE, 'src'), join(dir, 'src'), { recursive: true });
		mkdirSync(join(dir, 'node_modules'));
		for (const name of ALLOWED) {
			symlinkSync(join(PACKAGE, 'node_modules', name), join(dir, 'node_modules', name), 'dir');
		}

		writeFileSync(
			join(dir, 'entry.ts'),
			[
				"import { CURVE_CURVE25519, dwalletPda, readDWallet } from './src/index.js';",
				'export const curve = CURVE_CURVE25519;',
				'export const derive = dwalletPda;',
				'export const read = readDWallet;',
				'',
			].join('\n'),
		);
		writeFileSync(
			join(dir, 'tsconfig.json'),
			JSON.stringify({
				compilerOptions: {
					target: 'ES2022',
					module: 'ESNext',
					moduleResolution: 'bundler',
					strict: true,
					skipLibCheck: true,
					noEmit: true,
					types: ['node'],
					lib: ['esnext'],
					resolveJsonModule: true,
				},
				files: ['entry.ts'],
			}),
		);

		execFileSync(join(PACKAGE, 'node_modules/.bin/tsc'), ['--noEmit', '-p', dir], {
			encoding: 'utf8',
			stdio: 'pipe',
		});
		return { ok: true, output: '' };
	} catch (failure) {
		const error = failure as { stdout?: string; stderr?: string; message?: string };
		return {
			ok: false,
			output: `${error.stdout ?? ''}${error.stderr ?? ''}${error.message ?? ''}`,
		};
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe('the package root', () => {
	it('typechecks with @solana/web3.js absent', () => {
		const { ok, output } = typecheckRootEntryAlone();
		expect(output).toBe('');
		expect(ok).toBe(true);
	}, 120_000);
});
