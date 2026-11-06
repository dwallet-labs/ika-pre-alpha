// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

import type { TransactionResponseDataBcs } from './bcs.js';
import type { NetworkKeyId } from './network-key-id.js';

export interface PresignInfo {
	presignId: Uint8Array;
	dwalletBindingId: Uint8Array;
	signatureAlgorithm: number;
	assignedEpoch: bigint;
}

export interface NetworkKeyOutput {
	/** BCS `VersionedNetworkDkgOutput` — the one-time network DKG output. */
	networkDkgOutput: Uint8Array;
	/**
	 * BCS `VersionedDecryptionKeyReconfigurationOutput` of the latest
	 * completed reconfiguration; undefined before the first one.
	 */
	latestReconfigurationOutput?: Uint8Array;
	/** Epoch of the latest output update. */
	epoch: bigint;
	/** The epoch the network DKG ran. */
	dkgAtEpoch: bigint;
	/**
	 * The key's NetworkKeyId: its Ed25519 public key,
	 * the value signed requests name the key by.
	 */
	networkKeyId: NetworkKeyId;
}

export type TransactionResponseData = ReturnType<typeof TransactionResponseDataBcs.parse>;
