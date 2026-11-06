// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * `IkaClient` on Solana, with `@solana/web3.js`: the network's requests (from
 * `IkaClientBase`) and the reads of the ika program's accounts
 * (`SolanaIkaClientCore`), with each address a `PublicKey`.
 *
 * Reads that a network signature covers are checked against it. The other
 * reads go through `connection`, or `getAccount`: pass `crossCheck` with a
 * second endpoint, run by another provider, to have each one checked
 * against it.
 */
import type { IkaNetwork } from '@ika.xyz/sdk-core';
import type { IkaClientBaseOptions } from '@ika.xyz/sdk-core/common';
import { PublicKey } from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';

import { SolanaIkaClientCore } from '../client-core.js';
import type { GetAccount, SolanaReadCrossCheck } from '../read-cross-check.js';

/** Where the network is on Solana: the ika network, and its program. */
export interface IkaConfig {
	/** `'mainnet'`, `'testnet'`, or a custom network with its trusted network keys. */
	network: IkaNetwork;
	/** The ika program's id on this cluster. */
	programId: PublicKey;
	/**
	 * The chain number the coordinator records, which the registration and
	 * the gas deposit sign over. Required on a custom network; on mainnet and
	 * testnet the SDK's own is used.
	 */
	chainNumber?: number;
	/**
	 * The network the coordinator records: 1 mainnet, 2 testnet, 3 a local
	 * network. Required on a custom network.
	 */
	networkValue?: number;
}

export interface IkaClientOptions extends Omit<IkaClientBaseOptions, 'network'> {
	connection: Connection;
	config: IkaConfig;
	/** Reads one account, or `null`. Defaults to reads through `connection` at `confirmed`. */
	getAccount?: GetAccount;
	/**
	 * A second endpoint, run by another provider, for the reads no network
	 * signature covers. Defaults to `'not-cross-checked'`.
	 */
	crossCheck?: SolanaReadCrossCheck;
}

export class IkaClient extends SolanaIkaClientCore<PublicKey> {
	readonly connection: Connection;

	constructor(options: IkaClientOptions) {
		super({
			...options,
			network: options.config.network,
			programId: options.config.programId.toBytes(),
			chainNumber: options.config.chainNumber,
			networkValue: options.config.networkValue,
			getAccount: options.getAccount ?? connectionGetAccount(options.connection),
		});
		this.connection = options.connection;
	}

	protected address(bytes: Uint8Array): PublicKey {
		return new PublicKey(bytes);
	}

	protected addressBytes(address: PublicKey): Uint8Array {
		return address.toBytes();
	}
}

/** Reads accounts through `connection`, at `confirmed` commitment. */
function connectionGetAccount(connection: Connection): GetAccount {
	return async (address) => {
		const account = await connection.getAccountInfo(new PublicKey(address), 'confirmed');
		return account === null
			? null
			: { owner: account.owner.toBytes(), data: Uint8Array.from(account.data) };
	};
}
