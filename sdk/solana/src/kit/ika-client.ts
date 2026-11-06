// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * `IkaClient` on Solana, with `@solana/kit`: the network's requests (from
 * `IkaClientBase`) and the reads of the ika program's accounts
 * (`SolanaIkaClientCore`), with each address a kit `Address`.
 *
 * Reads that a network signature covers are checked against it. The other
 * reads go through `rpc`, or `getAccount`: pass `crossCheck` with a second
 * endpoint, run by another provider, to have each one checked against it.
 */
import type { IkaNetwork } from '@ika.xyz/sdk-core';
import type { IkaClientBaseOptions } from '@ika.xyz/sdk-core/common';
import { getAddressDecoder, getAddressEncoder, getBase64Encoder } from '@solana/kit';
import type { Address, GetAccountInfoApi, Rpc } from '@solana/kit';

import { SolanaIkaClientCore } from '../client-core.js';
import type { GetAccount, SolanaReadCrossCheck } from '../read-cross-check.js';

/** Where the network is on Solana: the ika network, and its program. */
export interface IkaConfig {
	/** `'mainnet'`, `'testnet'`, or a custom network with its trusted network keys. */
	network: IkaNetwork;
	/** The ika program's id on this cluster. */
	programId: Address;
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
	/** The cluster's RPC, as `createSolanaRpc` makes it. */
	rpc: Rpc<GetAccountInfoApi>;
	config: IkaConfig;
	/** Reads one account, or `null`. Defaults to reads through `rpc` at `confirmed`. */
	getAccount?: GetAccount;
	/**
	 * A second endpoint, run by another provider, for the reads no network
	 * signature covers. Defaults to `'not-cross-checked'`.
	 */
	crossCheck?: SolanaReadCrossCheck;
}

export class IkaClient extends SolanaIkaClientCore<Address> {
	readonly rpc: Rpc<GetAccountInfoApi>;

	constructor(options: IkaClientOptions) {
		super({
			...options,
			network: options.config.network,
			programId: addressBytes(options.config.programId),
			chainNumber: options.config.chainNumber,
			networkValue: options.config.networkValue,
			getAccount: options.getAccount ?? rpcGetAccount(options.rpc),
		});
		this.rpc = options.rpc;
	}

	protected address(bytes: Uint8Array): Address {
		return getAddressDecoder().decode(bytes);
	}

	protected addressBytes(address: Address): Uint8Array {
		return addressBytes(address);
	}
}

function addressBytes(address: Address): Uint8Array {
	return Uint8Array.from(getAddressEncoder().encode(address));
}

/** Reads accounts through `rpc`, at `confirmed` commitment. */
function rpcGetAccount(rpc: Rpc<GetAccountInfoApi>): GetAccount {
	return async (address) => {
		const { value } = await rpc
			.getAccountInfo(getAddressDecoder().decode(address), {
				encoding: 'base64',
				commitment: 'confirmed',
			})
			.send();
		return value === null
			? null
			: {
					owner: addressBytes(value.owner),
					data: Uint8Array.from(getBase64Encoder().encode(value.data[0])),
				};
	};
}
