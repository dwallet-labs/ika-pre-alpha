// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The mock cryptography ships only in `@ika.xyz/sdk-core/mock`. No other
 * entry of the package imports it, directly or through another module, so an
 * app that does not import `/mock` has no mock code in its bundle.
 *
 * The test reads `package.json`'s exports, maps each built path back to its
 * source file, and walks every static and dynamic import from it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MOCK_MODULES = ['src/mock.ts', 'src/client/mock-cryptography.ts'];

/** The source file of a built `./dist/esm/...js` path. */
function sourceOf(built: string): string {
	return join(PACKAGE, built.replace(/^\.\/dist\/esm\//, 'src/').replace(/\.js$/, '.ts'));
}

/** Every entry of `package.json`'s exports, by export name, as source files. */
function entries(): Map<string, string> {
	const exports = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')).exports as Record<
		string,
		Record<string, string>
	>;
	const found = new Map<string, string>();
	for (const [name, conditions] of Object.entries(exports)) {
		for (const [condition, path] of Object.entries(conditions)) {
			if (condition !== 'types' && path.endsWith('.js'))
				found.set(`${name} (${condition})`, sourceOf(path));
		}
	}
	return found;
}

const IMPORT =
	/(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)|import\s*['"](\.[^'"]+)['"]/g;
/(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g;

/** Every package source file `file` reaches through its relative imports. */
function reached(file: string, seen = new Set<string>()): Set<string> {
	if (seen.has(file)) return seen;
	seen.add(file);
	for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
		const specifier = (match[1] ?? match[2] ?? match[3])!;
		const target = resolve(dirname(file), specifier.replace(/\.js$/, '.ts'));
		reached(target, seen);
	}
	return seen;
}

describe('the mock entry', () => {
	it('is the package export `./mock`', () => {
		expect(entries().get('./mock (import)')).toBe(join(PACKAGE, 'src/mock.ts'));
	});

	it('is reached from no other entry', () => {
		const mock = MOCK_MODULES.map((path) => join(PACKAGE, path));
		for (const [name, source] of entries()) {
			if (name.startsWith('./mock ')) continue;
			const files = [...reached(source)].map((file) => relative(PACKAGE, file));
			expect(
				files.filter((file) => mock.includes(join(PACKAGE, file))),
				`${name} imports the mock`,
			).toEqual([]);
		}
	});

	it('is reached from the mock entry itself', () => {
		const files = [...reached(join(PACKAGE, 'src/mock.ts'))];
		expect(files).toContain(join(PACKAGE, 'src/client/mock-cryptography.ts'));
	});
});
