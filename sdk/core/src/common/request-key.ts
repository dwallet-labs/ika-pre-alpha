// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * A request key an app holds for its users: it signs their requests to the
 * network and pays for them through its own gas deposit, so the users never
 * hold IKA.
 *
 * The app's backend keeps the `RequestKey`. Its clients pass `IkaClient` a
 * `RequestSigner` that sends each request's bytes to the backend, which
 * checks them (`decodeSignedRequest`) against its own rules and signs them
 * (`RequestKey.signRequest`). The users' devices still compute their half of
 * every signature from their own shares, which never leave them, and a sign
 * still needs a voucher the dWallet's owner issued: the backend pays, and
 * decides what it pays for, but cannot sign with anyone's dWallet.
 */
import { ed25519 } from '@noble/curves/ed25519.js';

import { requestSigningMessage, SignedRequestDataBcs } from '../index.js';
import type { RequestSigner } from './engine.js';

export type { RequestSigner } from './engine.js';

export class RequestKey implements RequestSigner {
	readonly publicKey: Uint8Array;
	readonly #secretKey: Uint8Array;

	private constructor(secretKey: Uint8Array) {
		if (secretKey.length !== 32) {
			throw new Error(`an Ed25519 secret key is 32 bytes, and this one is ${secretKey.length}`);
		}
		this.#secretKey = Uint8Array.from(secretKey);
		this.publicKey = ed25519.getPublicKey(this.#secretKey);
	}

	/** A new random request key. Keep its `secretKey` to use the same gas deposit again. */
	static generate(): RequestKey {
		return new RequestKey(ed25519.utils.randomSecretKey());
	}

	/** The request key of a 32-byte Ed25519 secret key. */
	static fromSecretKey(secretKey: Uint8Array): RequestKey {
		return new RequestKey(secretKey);
	}

	/** The 32-byte secret key. Store it as a secret: it spends the gas deposit. */
	get secretKey(): Uint8Array {
		return Uint8Array.from(this.#secretKey);
	}

	/** Sign request bytes: the Ed25519 signature of their request signing message. */
	async signRequest(signedRequestData: Uint8Array): Promise<Uint8Array> {
		return this.sign(requestSigningMessage(signedRequestData));
	}

	/** Sign `message` with the key. Used for a gas deposit's consent. */
	sign(message: Uint8Array): Uint8Array {
		return ed25519.sign(message, this.#secretKey);
	}
}

/** What a request asks for, decoded from the bytes a `RequestSigner` is asked to sign. */
export interface DecodedRequest {
	/** The request's kind, as the network names it: `Dkg`, `Presign`, `Sign`, `AcceptShare`, ... */
	kind: string;
	/** The chain the request is for, and the one its gas deposit is on. */
	chain: string;
	/** The chain address the request names; a new dWallet is owned by it. */
	intendedChainSender: Uint8Array;
	epoch: bigint;
	/** The request's own fields, as the network's BCS decodes them. */
	request: Record<string, unknown>;
}

/**
 * Decode request bytes, so the signer of an app's requests can check what it
 * pays for before it signs: the kind, the chain, and the address that will
 * own a new dWallet. Throws for bytes that are not a request.
 */
export function decodeSignedRequest(signedRequestData: Uint8Array): DecodedRequest {
	const data = SignedRequestDataBcs.parse(signedRequestData);
	const kind = data.request.$kind as string;
	return {
		kind,
		chain: data.chain_id.$kind as string,
		intendedChainSender: Uint8Array.from(data.intended_chain_sender),
		epoch: BigInt(data.epoch),
		request: (data.request as Record<string, unknown>)[kind] as Record<string, unknown>,
	};
}
