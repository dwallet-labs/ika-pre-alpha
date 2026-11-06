// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

export interface WaitOptions {
	/** How long to wait, in milliseconds. Defaults to 2 minutes. */
	timeout?: number;
	/** How long between two reads, in milliseconds. Defaults to 1 second. */
	interval?: number;
}

/** Read until `read` returns a value, or throw once `timeout` has passed. */
export async function poll<T>(
	read: () => Promise<T | null | undefined>,
	what: string,
	{ timeout = 120_000, interval = 1_000 }: WaitOptions,
): Promise<T> {
	const deadline = Date.now() + timeout;
	for (;;) {
		const value = await read();
		if (value !== null && value !== undefined) return value;
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, interval));
	}
}
