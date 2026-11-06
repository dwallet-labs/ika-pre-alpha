// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The client's check of a validator's network-key certificate.
 *
 * A validator in its default TLS mode serves a self-signed certificate made
 * from its Ed25519 network key, for the server name `ika-dwallet-grpc`
 * The certificate is the same
 * bytes every time for one key, and changes when the key rotates.
 *
 * The check follows Sui's `ServerCertVerifier` (`verify_server_cert`). A
 * certificate is accepted only when:
 * - its Ed25519 key equals the one expected key;
 * - it verifies under its own key, as its own trust anchor, and is valid
 *   now (lines 225-231, 262-284 and 303-314);
 * - it names the expected server name (lines 286-292).
 *
 * grpc-js cannot run this check alone. Node's TLS calls
 * `checkServerIdentity` only after the certificate chain verified, and a
 * self-signed certificate fails that unless it is one of the trusted roots.
 * So the client first reads the served certificate over `node:tls`, checks
 * it here, and only then builds the channel with that certificate as its one
 * root, comparing the key again in `checkServerIdentity`.
 */
import { X509Certificate } from 'node:crypto';
import { connect } from 'node:tls';

import { IKA_DWALLET_GRPC_SERVER_NAME } from './committee.js';

/** The DER prefix of an Ed25519 SubjectPublicKeyInfo, before its 32 key bytes. */
const ED25519_SPKI_PREFIX = Uint8Array.from([
	0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

/** The extended key usage a server certificate may name: TLS server authentication. */
const SERVER_AUTH_USAGE = '1.3.6.1.5.5.7.3.1';

/** How long reading a served certificate may take. */
const FETCH_CERTIFICATE_TIMEOUT_MS = 10_000;

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The raw 32-byte Ed25519 key of `certificate`. Throws when the certificate
 * holds a key of another type, as Sui's `public_key_from_certificate` does.
 */
function certificateNetworkKey(certificate: X509Certificate): Uint8Array {
	if (certificate.publicKey.asymmetricKeyType !== 'ed25519') {
		throw new Error(
			`the served certificate holds a ${certificate.publicKey.asymmetricKeyType} key, not an Ed25519 network key`,
		);
	}
	const spki = new Uint8Array(certificate.publicKey.export({ type: 'spki', format: 'der' }));
	if (spki.length !== 44 || !sameBytes(spki.subarray(0, 12), ED25519_SPKI_PREFIX)) {
		throw new Error('the served certificate does not hold a 32-byte Ed25519 key');
	}
	return spki.slice(12);
}

/**
 * The refusal of a validator whose certificate is valid but holds a key that
 * is not the one expected: not the given network key, or not the network key
 * of a member of a verified committee. Asking again does not change it.
 */
export class UnexpectedNetworkKeyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UnexpectedNetworkKeyError';
	}
}

/**
 * Accept the certificate `der` only when it is the network-key certificate of
 * `expectedNetworkKey`, by the three rules of Sui's `ServerCertVerifier`.
 * Throws a descriptive error otherwise.
 */
export function checkNetworkKeyCertificate(
	der: Uint8Array,
	expectedNetworkKey: Uint8Array,
	now: Date = new Date(),
): void {
	const certificate = new X509Certificate(der);
	const servedKey = certificateNetworkKey(certificate);
	if (!sameBytes(servedKey, expectedNetworkKey)) {
		throw new UnexpectedNetworkKeyError(
			`the served certificate's key ${hex(servedKey)} is not the validator's network key ` +
				`${hex(expectedNetworkKey)}; refusing the server`,
		);
	}
	checkCertificateExceptKey(certificate, now);
}

/**
 * Check the certificate `der` by every rule of `checkNetworkKeyCertificate`
 * except which key it holds, and return that key: the raw 32-byte Ed25519
 * network key the validator serves. The caller then checks the key itself,
 * against the members of the committees it verified.
 */
export function checkServedNetworkKeyCertificate(
	der: Uint8Array,
	now: Date = new Date(),
): Uint8Array {
	const certificate = new X509Certificate(der);
	const servedKey = certificateNetworkKey(certificate);
	checkCertificateExceptKey(certificate, now);
	return servedKey;
}

/**
 * The rules of Sui's `ServerCertVerifier` other than the key comparison: the
 * certificate verifies under its own key as its own trust anchor, is valid
 * at `now`, is for TLS server authentication and names `ika-dwallet-grpc`.
 */
function checkCertificateExceptKey(certificate: X509Certificate, now: Date): void {
	if (!certificate.verify(certificate.publicKey)) {
		throw new Error(
			'the served certificate does not verify under its own key; refusing the server',
		);
	}
	if (now < certificate.validFromDate || now > certificate.validToDate) {
		throw new Error(
			`the served certificate is valid from ${certificate.validFrom} to ${certificate.validTo}, ` +
				'not now; refusing the server',
		);
	}
	const usages = certificate.keyUsage;
	if (usages !== undefined && !usages.includes(SERVER_AUTH_USAGE)) {
		throw new Error(
			'the served certificate is not for TLS server authentication; refusing the server',
		);
	}
	if (certificate.checkHost(IKA_DWALLET_GRPC_SERVER_NAME, { subject: 'never' }) === undefined) {
		throw new Error(
			`the served certificate does not name ${IKA_DWALLET_GRPC_SERVER_NAME}; refusing the server`,
		);
	}
}

/** `host` and `port` of a `host:port` endpoint. An IPv6 host may be in brackets. */
function splitEndpoint(endpoint: string): { host: string; port: number } {
	const colon = endpoint.lastIndexOf(':');
	const port = Number(endpoint.slice(colon + 1));
	if (colon < 0 || !Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error(`the endpoint ${endpoint} is not host:port`);
	}
	return { host: endpoint.slice(0, colon).replace(/^\[(.*)\]$/, '$1'), port };
}

/**
 * The DER certificate the TLS server at `endpoint` serves for
 * `ika-dwallet-grpc`. This connection checks nothing about the certificate:
 * the caller checks it with `checkNetworkKeyCertificate`. The handshake
 * still makes the server prove it holds the certificate's private key. TLS
 * 1.3 only, as Sui's client config. Rejects when
 * nothing listens, when the server does not speak TLS, and after 10 seconds.
 */
export function fetchServedCertificate(
	endpoint: string,
	timeoutMs = FETCH_CERTIFICATE_TIMEOUT_MS,
): Promise<Uint8Array> {
	const { host, port } = splitEndpoint(endpoint);
	return new Promise((resolve, reject) => {
		const socket = connect({
			host,
			port,
			servername: IKA_DWALLET_GRPC_SERVER_NAME,
			ALPNProtocols: ['h2'],
			minVersion: 'TLSv1.3',
			// The certificate is self-signed, so no chain check can pass. The
			// caller checks it against the chain's key instead.
			rejectUnauthorized: false,
		});
		const fail = (error: Error) => {
			socket.destroy();
			reject(
				new Error(`reading the TLS certificate of ${endpoint} failed: ${error.message}`, {
					cause: error,
				}),
			);
		};
		// The code marks a timeout, which the client's read of the network keys
		// tries again (`hasTransportSocketCause` in ./client.ts).
		socket.setTimeout(timeoutMs, () =>
			fail(Object.assign(new Error(`no TLS handshake in ${timeoutMs} ms`), { code: 'ETIMEDOUT' })),
		);
		socket.once('error', fail);
		socket.once('secureConnect', () => {
			const certificate = socket.getPeerCertificate(false);
			socket.end();
			if (!certificate?.raw) {
				reject(new Error(`the TLS server at ${endpoint} served no certificate`));
				return;
			}
			resolve(new Uint8Array(certificate.raw));
		});
	});
}

/** A certificate's DER bytes as PEM. */
export function certificatePem(der: Uint8Array): string {
	const body = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, '$1\n');
	return `-----BEGIN CERTIFICATE-----\n${body}${body.endsWith('\n') ? '' : '\n'}-----END CERTIFICATE-----\n`;
}

/**
 * What a pinned channel needs: the certificate as its one root, and a
 * `checkServerIdentity` that accepts only a certificate holding
 * `networkKey` and naming `ika-dwallet-grpc`.
 */
export interface PinnedCertificate {
	rootCertPem: string;
	checkServerIdentity: (hostname: string, certificate: { raw: Uint8Array }) => Error | undefined;
}

/**
 * Read the certificate served at `endpoint`, accept it only when it is the
 * network-key certificate of `networkKey`, and return what the pinned
 * channel needs.
 */
export async function pinNetworkKeyCertificate(
	endpoint: string,
	networkKey: Uint8Array,
): Promise<PinnedCertificate> {
	const der = await fetchServedCertificate(endpoint);
	checkNetworkKeyCertificate(der, networkKey);
	return {
		rootCertPem: certificatePem(der),
		checkServerIdentity: (_hostname, certificate) => {
			try {
				checkNetworkKeyCertificate(new Uint8Array(certificate.raw), networkKey);
				return undefined;
			} catch (error) {
				return error instanceof Error ? error : new Error(String(error));
			}
		},
	};
}
