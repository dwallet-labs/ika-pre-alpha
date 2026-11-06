// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		minWorkers: 1,
		maxWorkers: 50,
		hookTimeout: 1000000,
		testTimeout: 6_000_000, // 60 minutes
		retry: 0,
		pool: 'forks', // Use forks instead of threads for better memory isolation
		env: {
			NODE_ENV: 'test',
		},
		exclude: ['**/node_modules/**'],
	},
});
