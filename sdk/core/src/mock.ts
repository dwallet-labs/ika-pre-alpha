// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * `@ika.xyz/sdk-core/mock`: the SDK's mock mode, for a mock ika network such
 * as the Solana devnet pre-alpha's.
 *
 * NOT SECURE. A mock network is one backend that holds an ordinary key for
 * each dWallet, so it can sign anything with any dWallet. Use it only with
 * funds you can lose.
 *
 * The main entry never imports this one. Only a client created with
 * {@link withMockCryptography} runs the mock; every other client, in the
 * same process too, refuses mock values.
 *
 * ```ts
 * import { withMockCryptography } from '@ika.xyz/sdk-core/mock';
 *
 * const ikaClient = new IkaClient(withMockCryptography({ connection, grpc, config }));
 * ```
 */
import { mockCryptography } from './client/mock-cryptography.js';

export {
	mockCryptography,
	mockDWalletOutput,
	mockNetworkKeyOutput,
	mockVerifySignature,
} from './client/mock-cryptography.js';
export { isMockValue, MOCK_MAGIC, MockKind, mockValue } from './client/mock-format.js';

/**
 * `options`, for a client of a mock ika network: the same options with the
 * mock's cryptography. The client then refuses a network that serves a real
 * network key, and is allowed only on a custom network.
 */
export function withMockCryptography<Options extends object>(
	options: Options,
): Options & { cryptography: typeof mockCryptography } {
	return { ...options, cryptography: mockCryptography };
}
