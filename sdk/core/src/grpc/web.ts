// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The dWallet gRPC client for a browser: `@ika.xyz/pre-alpha-core/web`.
 *
 * It has the calls of the Node client at `@ika.xyz/pre-alpha-core/client`, with the
 * same failover, epoch-close and network-keys rules, over gRPC-Web through
 * `fetch` (`./web-transport.ts`). It needs a validator's gRPC-Web listener,
 * which answers the page's CORS checks.
 *
 * A browser checks the listener's certificate against the authorities it
 * trusts, and a page cannot pin it to a key. So the client trusts that
 * certificate, the way a Sui dApp trusts its full node's. The SDK's answer
 * checks still refuse a dWallet, a signature or a network-key output the
 * network did not sign. What it takes on the endpoint's word is what is not
 * signed: refusals, presign lists, the key list and status answers.
 *
 * The options that only Node can honour are refused when the client is
 * built: `tls`, `networkPublicKey` and `committeeReader`.
 */
import { DWalletGrpcClientBase } from './dwallet-client.js';
import type { GrpcWebValidatorEndpoint } from './web-transport.js';
import { WebTransport } from './web-transport.js';

export type { SignedGrpcRequest } from './dwallet-client.js';
export { EVERY_VALIDATOR_REFUSED } from './dwallet-client.js';
export {
	EPOCH_CLOSING_REFUSAL,
	GAS_WAIT_ENDED_WITH_THE_EPOCH,
	isEpochClosingRefusal,
} from './transport.js';
export type { GrpcWebValidatorEndpoint } from './web-transport.js';

/**
 * How the browser client connects to its first validator. `insecure: true`
 * lets the endpoint be a plaintext `http://` URL, for a localnet node only.
 */
export interface DWalletGrpcWebClientOptions {
	insecure?: boolean;
}

/**
 * Why each option only Node can honour is refused, by option name. Each needs
 * a raw TLS connection, which a browser does not give a page.
 */
const NODE_ONLY_OPTIONS: Record<string, string> = {
	tls:
		'a browser checks the certificate against the authorities it trusts, and takes no root ' +
		'certificate or server name from a page',
	networkPublicKey:
		"pinning TLS to a validator's network key needs a raw TLS connection, which a browser " +
		'does not give a page',
	committeeReader:
		'pinning TLS to the committee the network signed needs a raw TLS connection, which a ' +
		'browser does not give a page',
};

/**
 * Throw when `fields`, the options of the validator at `endpoint`, sets an
 * option only Node can honour.
 */
function refuseNodeOnlyOptions(endpoint: string, fields: object): void {
	Object.entries(NODE_ONLY_OPTIONS).forEach(([name, reason]) => {
		if ((fields as Record<string, unknown>)[name] !== undefined) {
			throw new Error(
				`the browser client cannot honour \`${name}\` for the validator at ${endpoint}: ` +
					`${reason}. In a browser the validator's gRPC-Web listener serves a publicly ` +
					"trusted certificate, and the SDK's answer checks verify what the network signed; " +
					`leave \`${name}\` out, or use \`@ika.xyz/pre-alpha-core/client\` in Node`,
			);
		}
	});
}

/** The dWallet gRPC client for a browser, over gRPC-Web through `fetch`. */
export class DWalletGrpcClient extends DWalletGrpcClientBase {
	/**
	 * The arguments sit where the Node client's do, so that a caller moves
	 * from one to the other by its import.
	 *
	 * @param endpoint - the `https://` URL of a validator's gRPC-Web
	 * listener. An `http://` URL needs `options.insecure`.
	 * @param tls - no value is taken. A browser checks the certificate against
	 * the authorities it trusts, so any value is refused.
	 * @param furtherValidators - further validators, from the caller's own
	 * configuration, each a URL as `endpoint` is. `submitTransaction` sends a
	 * request to them, in this order, when the validators before answered
	 * `UNAVAILABLE`. A browser reports a validator it could not reach, and a
	 * request its CORS check refused, as `UNAVAILABLE` too. Every read talks to
	 * the first validator only.
	 * @param options - how to connect to the first validator
	 * ({@link DWalletGrpcWebClientOptions}). `networkPublicKey` and
	 * `committeeReader` are refused.
	 */
	constructor(
		endpoint: string,
		tls?: undefined,
		furtherValidators: GrpcWebValidatorEndpoint[] = [],
		options: DWalletGrpcWebClientOptions = {},
	) {
		refuseNodeOnlyOptions(endpoint, { tls, ...options });
		furtherValidators.forEach((validator) => refuseNodeOnlyOptions(validator.endpoint, validator));
		super(
			new WebTransport([{ endpoint, insecure: options.insecure }, ...furtherValidators]),
			furtherValidators.length,
		);
	}
}
