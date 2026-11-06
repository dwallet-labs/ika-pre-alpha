#!/usr/bin/env node
// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

// Builds the package in the current directory as ES modules: every file under
// `src` (tests excluded) is transpiled to `dist/esm` with esbuild, and the
// type declarations come from `tsc -p tsconfig.esm.json`.
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { build } from 'esbuild';

async function sourceFiles(dir, files = []) {
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) await sourceFiles(file, files);
		else if (!/\.test\.ts$/.test(file)) files.push(file);
	}
	return files;
}

const cwd = process.cwd();
const packageJson = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
await fs.rm(path.join(cwd, 'dist'), { recursive: true, force: true });
await build({
	format: 'esm',
	logLevel: 'error',
	target: 'es2020',
	entryPoints: await sourceFiles(path.join(cwd, 'src')),
	outdir: 'dist/esm',
	outbase: 'src',
	sourcemap: true,
});
execFileSync('tsc', ['--project', 'tsconfig.esm.json'], { stdio: 'inherit' });
const marker = { private: true, type: 'module' };
if (packageJson.sideEffects === false) marker.sideEffects = false;
await fs.writeFile(path.join(cwd, 'dist/esm/package.json'), JSON.stringify(marker, null, 2));
