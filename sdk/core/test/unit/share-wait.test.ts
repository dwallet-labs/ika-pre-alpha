// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * After a DKG, an import or a received share, the SDK waits until the chain
 * holds the holder's share. The share is not accepted yet at that point, so
 * the record check refuses it on its acceptance alone, and the wait must take
 * that refusal as the share being there. Any other refusal still throws.
 */
import { describe, expect, it } from 'vitest';

import { shareIsOnChain } from '../../src/common/ika-client-base.js';
import { AttestationRecordError } from '../../src/grpc/attestation-record.js';

const holder = new Uint8Array(32).fill(7);

function recordWhoseShareRead(read: () => Promise<unknown>) {
	return { readEncryptedShare: read } as unknown as Parameters<typeof shareIsOnChain>[0];
}

describe('the wait for a new share', () => {
	it('takes a share the chain holds and has not marked accepted (Solana)', async () => {
		const record = recordWhoseShareRead(async () => {
			throw new AttestationRecordError('record', 'not accepted', 'accepted');
		});
		await expect(shareIsOnChain(record, holder)).resolves.toBe(true);
	});

	it('takes a share the chain holds with no acceptance signature yet (Sui)', async () => {
		const record = recordWhoseShareRead(async () => {
			throw new AttestationRecordError('record', 'no signature', 'acceptance_signature');
		});
		await expect(shareIsOnChain(record, holder)).resolves.toBe(true);
	});

	it('takes an accepted share, and keeps waiting while there is none', async () => {
		await expect(
			shareIsOnChain(
				recordWhoseShareRead(async () => ({})),
				holder,
			),
		).resolves.toBe(true);
		await expect(
			shareIsOnChain(
				recordWhoseShareRead(async () => undefined),
				holder,
			),
		).resolves.toBe(false);
	});

	it('throws when the share is refused on any other field', async () => {
		const record = recordWhoseShareRead(async () => {
			throw new AttestationRecordError('record', 'wrong hash', 'encrypted_share');
		});
		await expect(shareIsOnChain(record, holder)).rejects.toThrow('wrong hash');
	});
});
