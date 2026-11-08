// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * Client for a validator's dWallet gRPC transport (pre-alpha).
 *
 * By default each connection is TLS pinned to the network key of a member of
 * the committee the network signed, the way Sui's validator client pins a
 * validator's key (`./network-key-tls.ts`, `./committee.ts`).
 *
 * `SubmitTransaction` carries a user-signed BCS payload; the request type
 * lives INSIDE the signed bytes, so the transport itself has one method
 * for every dWallet operation. Responses decode to
 * `TransactionResponseData` (signature / network attestation / error).
 */
import type { CommitteeChainReader } from './committee.js';
import { DWalletGrpcClientBase } from './dwallet-client.js';
import type { GrpcValidatorEndpoint } from './node-transport.js';
import { NodeTransport } from './node-transport.js';

export {
	checkNetworkKeyCertificate,
	checkServedNetworkKeyCertificate,
	fetchServedCertificate,
	pinNetworkKeyCertificate,
} from './network-key-tls.js';
export type { PinnedCertificate } from './network-key-tls.js';
export type { GrpcValidatorEndpoint } from './node-transport.js';
export {
	EPOCH_CLOSING_REFUSAL,
	GAS_WAIT_ENDED_WITH_THE_EPOCH,
	isEpochClosingRefusal,
} from './transport.js';
export type { SignedGrpcRequest } from './dwallet-client.js';
export { EVERY_VALIDATOR_REFUSED, PIN_REFUSAL_MAX_AGE_MS } from './dwallet-client.js';

/**
 * How the client connects to its first validator, and the reader of the
 * client's chain that the committee is checked against. For each validator
 * the first of these that is set decides:
 * - `tls` (the constructor's argument, or the entry's): TLS as given, with
 *   system roots for `{}` or the given `rootCert` and `servername`;
 * - `insecure: true`: plaintext. Only for a localnet, whose nodes serve
 *   plaintext. Production validators never do;
 * - `networkPublicKey`: TLS pinned to this one 32-byte Ed25519 network key.
 *   A key the validator later changes is not followed;
 * - `committeeReader`: TLS pinned to the network key of any member of the
 *   committee the network signed. The client reads the committee from a
 *   validator (`GetCommittee`), checks the network's signature over it,
 *   checks that the signer is a network key registered on the chain the
 *   reader reads and that the committee is of the chain's epoch or the next,
 *   and keeps the committees that pass (`verifyCommitteeAnswer`). A
 *   validator whose key is not a verified member's makes the client read the
 *   committee again through it, so the client follows the committee into a
 *   later epoch. The reader comes from the chain client:
 *   `createSuiCommitteeReader` of `@ika.xyz/sdk-sui` or
 *   `solanaCommitteeReader` of `@ika.xyz/pre-alpha-solana`.
 * A validator with none of these is refused when the client is built.
 *
 * The pinned connection follows Sui's validator client. The client reads the
 * certificate the validator serves, accepts it only when it verifies under
 * its own key, is valid now and names `ika-dwallet-grpc`, and when its key
 * is the expected one: `networkPublicKey`, or a verified member's. It then
 * builds the channel with that certificate as its one trusted root
 * (`./network-key-tls.ts`, and the committee pin in `./node-transport.ts`).
 */
export interface DWalletGrpcClientOptions {
	insecure?: boolean;
	networkPublicKey?: Uint8Array;
	committeeReader?: CommitteeChainReader;
}

/** The dWallet gRPC client for Node, over grpc-js. */
export class DWalletGrpcClient extends DWalletGrpcClientBase {
	/**
	 * @param endpoint - `host:port` of a validator's dWallet gRPC server.
	 * @param tls - TLS options, as before: `{}` uses the system CA roots
	 * against a validator that serves a certificate from a public authority,
	 * and a `rootCert` PEM with a `servername` trusts that certificate. Omit
	 * it for the default, TLS pinned to the network key of a member of the
	 * committee the network signed, which needs `options.committeeReader`, or
	 * pinned to one key, `options.networkPublicKey`. Plaintext needs
	 * `options.insecure`.
	 * @param furtherValidators - further validators, from the caller's own
	 * configuration. `submitTransaction` sends a request to them, in this
	 * order, when the validators before answered `UNAVAILABLE`.
	 * `submitTransactionAcrossEpochClose` submits the same way. Every read
	 * goes to the first validator, until the pinned TLS check refuses its key;
	 * from then on they go to the next validator whose key it has not
	 * refused. A validator whose key was refused is recorded and not asked again for
	 * `PIN_REFUSAL_MAX_AGE_MS`.
	 * Omit the list and the client talks to one validator.
	 * @param options - how to connect to the first validator, and the reader
	 * of the chain every validator's committee pin checks against
	 * ({@link DWalletGrpcClientOptions}).
	 */
	constructor(
		endpoint: string,
		tls?: { rootCert?: Uint8Array; servername?: string },
		furtherValidators: GrpcValidatorEndpoint[] = [],
		options: DWalletGrpcClientOptions = {},
	) {
		const validators: GrpcValidatorEndpoint[] = [
			{
				endpoint,
				tls,
				insecure: options.insecure,
				networkPublicKey: options.networkPublicKey,
			},
			...furtherValidators,
		];
		super(new NodeTransport(validators, options.committeeReader), furtherValidators.length);
	}
}
