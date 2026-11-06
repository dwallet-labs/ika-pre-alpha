// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The SDK's mock mode (`@ika.xyz/sdk-core/mock`, `src/mock.ts`), against a
 * stub of the mock backend.
 *
 * The stub answers the way the backend does: it reads the dWallet's key from
 * the user's key message, attests the user's own output as the dWallet's
 * output, and signs with the key in the network's signature encodings. The
 * request engine runs for real, with its checks. So these tests pin both the
 * SDK's mock path and the formats the backend must write.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { p256 } from '@noble/curves/nist.js';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';

import { Network, signatureSchemeNumber } from '../../src/common/engine.js';
import type { DWallet, Requester } from '../../src/common/engine.js';
import { DWalletGrpcClient } from '../../src/grpc/client.js';
import {
	assertDWalletUsable,
	attestationSigningMessage,
	Curve,
	grpcSessionIdentifier,
	networkKeyDkgRecordMessage,
	networkKeyIdFromBytes,
	networkOutputDigest,
	publicKeyFromDWalletOutput,
	SignedRequestDataBcs,
	TransactionResponseDataBcs,
	trustedNetworkKeys,
	UserSignatureBcs,
	VersionedDWalletDataAttestationBcs,
	VersionedEncryptedUserKeyShareAttestationBcs,
	VersionedPresignDataAttestationBcs,
} from '../../src/index.js';
import type {
	AttestationKind,
	AttestationRecord,
	DWalletShareReader,
	NetworkKeyOutputRecordReader,
} from '../../src/index.js';
import {
	isMockValue,
	MOCK_MAGIC,
	mockCryptography,
	MockKind,
	mockNetworkKeyOutput,
	mockValue,
	withMockCryptography,
} from '../../src/mock.js';
import { callThroughStubs } from './stub-validators.js';

const NETWORK_SECRET = new Uint8Array(32).fill(0x21);
const NETWORK_KEY = networkKeyIdFromBytes(ed25519.getPublicKey(NETWORK_SECRET));
const NETWORK = { custom: { networkPublicKeys: [NETWORK_KEY] } };
const EPOCH = 1n;
const CURVE_NAMES = ['Secp256k1', 'Secp256r1', 'Curve25519', 'Ristretto'] as const;

const REQUEST_SECRET = new Uint8Array(32).fill(0x31);
const requester: Requester = {
	keypair: { secretKey: REQUEST_SECRET, publicKey: ed25519.getPublicKey(REQUEST_SECRET) },
	chain: 'Solana',
	intendedChainSender: ed25519.getPublicKey(REQUEST_SECRET),
};
const HOLDER_SECRET = new Uint8Array(32).fill(0x41);
const holder = { secretKey: HOLDER_SECRET, publicKey: ed25519.getPublicKey(HOLDER_SECRET) };
const ENCRYPTION_KEY = new Uint8Array(64).fill(0x51);

const hex = (bytes: ArrayLike<number>) =>
	Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

async function refusal(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		return error as Error;
	}
	throw new Error('expected a refusal');
}

describe('mock values on the real path', () => {
	it('refuses a mock value with the error that names the mock feature', async () => {
		const output = mockValue(MockKind.DWalletOutput, [2, ...new Uint8Array(32).fill(1)]);
		const error = await refusal(publicKeyFromDWalletOutput(Curve.ED25519, output));
		expect(error.message).toMatch(/mock values need the SDK's mock feature/);
	});

	it('refuses a mock network key output on a connection without the mock', async () => {
		const error = await refusal(connect({ mock: false }));
		expect(error.message).toMatch(/the network serves the mock network key/);
		expect(error.message).toMatch(/mock values need the SDK's mock feature/);
	});

	it('refuses a real network key output on a connection with the mock', async () => {
		const error = await refusal(connect({ mock: true, realNetworkKey: true }));
		expect(error.message).toMatch(/the client is in mock mode, and the network serves a real/);
	});

	it('still refuses mock values once a client in mock mode ran: the mock is per client', async () => {
		const { network } = await connect({ mock: true });
		expect(network.cryptography.mock).toBe(true);
		const output = mockValue(MockKind.DWalletOutput, [2, ...new Uint8Array(32).fill(1)]);
		const error = await refusal(publicKeyFromDWalletOutput(Curve.ED25519, output));
		expect(error.message).toMatch(/mock values need the SDK's mock feature/);
		const real = await refusal(connect({ mock: false }));
		expect(real.message).toMatch(/the network serves the mock network key/);
	});

	it('withMockCryptography sets the mock and keeps every other option', () => {
		const options = withMockCryptography({ network: NETWORK, grpc: 'host:50051' });
		expect(options.cryptography).toBe(mockCryptography);
		expect(options.grpc).toBe('host:50051');
		expect(options.network).toBe(NETWORK);
	});
});

describe('the mock formats', () => {
	it('starts every mock value with 0xff then "ika-mock", then the kind', () => {
		expect(hex(MOCK_MAGIC)).toBe('ff696b612d6d6f636b');
		expect(hex(mockNetworkKeyOutput())).toBe('ff696b612d6d6f636b00');
		expect(isMockValue(mockNetworkKeyOutput())).toBe(true);
		expect(isMockValue(MOCK_MAGIC)).toBe(false);
		expect(isMockValue(Uint8Array.of(0, 1, 2))).toBe(false);
	});
});

/** The curve of a mock key message, which carries the curve and no key. */
function curveOfMessage(message: ArrayLike<number>): number {
	const bytes = Uint8Array.from(message);
	expect(isMockValue(bytes)).toBe(true);
	expect(bytes[MOCK_MAGIC.length]).toBe(MockKind.KeyMessage);
	const payload = bytes.slice(MOCK_MAGIC.length + 1);
	expect(payload.length, 'a key message carries the curve and nothing else').toBe(1);
	return payload[0]!;
}

/** A new key on `curve`, as the backend makes one, with its compressed public key. */
function newKey(curve: number): { secretKey: Uint8Array; publicKey: Uint8Array } {
	if (curve === 0) {
		const secretKey = secp256k1.utils.randomSecretKey();
		return { secretKey, publicKey: secp256k1.getPublicKey(secretKey, true) };
	}
	if (curve === 1) {
		const secretKey = p256.utils.randomSecretKey();
		return { secretKey, publicKey: p256.getPublicKey(secretKey, true) };
	}
	const scalar = littleEndianScalar(randomBytes(64)) % ed25519.Point.Fn.ORDER;
	return {
		secretKey: littleEndian32(scalar),
		publicKey: ed25519.Point.BASE.multiply(scalar).toBytes(),
	};
}

function littleEndianScalar(bytes: Uint8Array): bigint {
	return Array.from(bytes)
		.reverse()
		.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
}

function littleEndian32(value: bigint): Uint8Array {
	return Uint8Array.from({ length: 32 }, (_, index) =>
		Number((value >> BigInt(8 * index)) & 0xffn),
	);
}

/** RFC 8032 Ed25519 over `message`, with a raw scalar for the secret key, as the backend signs. */
function eddsaWithScalar(secretKey: Uint8Array, message: Uint8Array): Uint8Array {
	const order = ed25519.Point.Fn.ORDER;
	const scalar = littleEndianScalar(secretKey);
	const publicKey = ed25519.Point.BASE.multiply(scalar).toBytes();
	const nonce =
		littleEndianScalar(sha512(Uint8Array.from([...randomBytes(32), ...message]))) % order;
	const commitment = ed25519.Point.BASE.multiply(nonce).toBytes();
	const challenge =
		littleEndianScalar(sha512(Uint8Array.from([...commitment, ...publicKey, ...message]))) % order;
	return Uint8Array.from([...commitment, ...littleEndian32((nonce + challenge * scalar) % order)]);
}

/** The signature the mock backend returns for `scheme`, in the network's encodings. */
function backendSignature(
	scheme: string,
	curve: number,
	secretKey: Uint8Array,
	message: Uint8Array,
): Uint8Array {
	switch (scheme) {
		case 'EcdsaKeccak256':
			return secp256k1.sign(keccak_256(message), secretKey, {
				prehash: false,
				format: 'recovered',
			});
		case 'EcdsaSha256':
			return (curve === 0 ? secp256k1 : p256).sign(sha256(message), secretKey, {
				prehash: false,
				format: 'recovered',
			});
		case 'EcdsaDoubleSha256':
			return secp256k1.sign(sha256(sha256(message)), secretKey, {
				prehash: false,
				format: 'recovered',
			});
		case 'TaprootSha256':
			return schnorr.sign(sha256(message), secretKey);
		case 'EddsaSha512':
			return eddsaWithScalar(secretKey, message);
		default:
			throw new Error(`the stub backend does not sign ${scheme}`);
	}
}

function signedAttestation(kind: AttestationKind, data: Uint8Array) {
	return {
		attestation_data: Array.from(data),
		network_signature: Array.from(
			ed25519.sign(attestationSigningMessage(kind, data), NETWORK_SECRET),
		),
		network_pubkey: Array.from(NETWORK_KEY),
		signer_noa_public_key: Array.from(NETWORK_KEY),
	};
}

/** A stub of the mock backend, with the dWallet keys it made, and every request's bytes. */
function mockBackend() {
	const keys = new Map<string, { curve: number; secretKey: Uint8Array }>();
	const received: any[] = [];
	const receivedBytes: Uint8Array[] = [];
	const answer = (data: any, sessionIdentifier: Uint8Array): object => {
		const request = data.request;
		received.push(request);
		const dkg = request.Dkg ?? request.ImportedKeyVerification;
		if (dkg !== undefined) {
			const message = dkg.centralized_public_key_share_and_proof ?? dkg.centralized_party_message;
			const curve = curveOfMessage(message);
			const { secretKey, publicKey } = newKey(curve);
			const key = { curve, secretKey };
			const output = mockValue(MockKind.DWalletOutput, [curve, ...publicKey]);
			keys.set(hex(publicKey), key);
			const encrypted = dkg.user_secret_key_share.Encrypted;
			const data = VersionedDWalletDataAttestationBcs.serialize({
				V1: {
					session_identifier: Array.from(sessionIdentifier),
					intended_chain_sender: Array.from(requester.intendedChainSender),
					curve: { [CURVE_NAMES[key.curve]]: null } as any,
					public_key: Array.from(publicKey),
					public_output: Array.from(output),
					is_imported_key: request.ImportedKeyVerification !== undefined,
					sign_during_dkg_signature: null,
					holder:
						encrypted === undefined
							? null
							: {
									signature_scheme: { Ed25519: null },
									signer_public_key: encrypted.signer_public_key,
								},
					encryption_key_hash:
						encrypted === undefined
							? null
							: Array.from(keccak_256(Uint8Array.from(encrypted.encryption_key))),
					encrypted_share_hash:
						encrypted === undefined
							? null
							: Array.from(
									keccak_256(
										Uint8Array.from(encrypted.encrypted_centralized_secret_share_and_proof),
									),
								),
					epoch: EPOCH,
				},
			}).toBytes();
			return { Attestation: signedAttestation('dwallet', data) };
		}
		if (request.Presign !== undefined) {
			const data = VersionedPresignDataAttestationBcs.serialize({
				V1: {
					session_identifier: Array.from(sessionIdentifier),
					epoch: EPOCH,
					presign_session_identifier: Array.from(randomBytes(32)),
					presign_data: Array.from(mockValue(MockKind.Presign, randomBytes(32))),
					curve: request.Presign.curve,
					signature_algorithm: request.Presign.signature_algorithm,
					dwallet_public_key: null,
					user_pubkey: Array.from(requester.keypair.publicKey),
				} as any,
			}).toBytes();
			return { Attestation: signedAttestation('presign', data) };
		}
		const sign = request.Sign ?? request.ImportedKeySign;
		if (sign !== undefined) {
			expect(hex(sign.message_centralized_signature)).toBe(hex(mockValue(MockKind.SignMessage)));
			const attested = VersionedDWalletDataAttestationBcs.parse(
				Uint8Array.from(sign.dwallet_attestation.attestation_data),
			).V1!;
			const key = keys.get(hex(attested.public_key))!;
			const signature = backendSignature(
				sign.signature_scheme.$kind,
				key.curve,
				key.secretKey,
				Uint8Array.from(sign.message),
			);
			return { Signature: { signature: Array.from(signature) } };
		}
		return { Error: { message: 'the stub backend does not answer this request' } };
	};
	return { keys, received, receivedBytes, answer };
}

function chainRecording(dkgOutput: Uint8Array): NetworkKeyOutputRecordReader {
	const digest = networkOutputDigest(dkgOutput);
	const record = {
		digest,
		proof: Uint8Array.from([
			0,
			0,
			...NETWORK_KEY,
			...ed25519.sign(networkKeyDkgRecordMessage(NETWORK_KEY, digest), NETWORK_SECRET),
		]),
	};
	return {
		dkgRecord: async () => record,
		reconfigurationRecord: async () => undefined,
		isRegisteredNetworkKey: async (key) => hex(key) === hex(NETWORK_KEY),
	};
}

async function connect(options: { mock: boolean; curve?: Curve; realNetworkKey?: boolean }) {
	const backend = mockBackend();
	const output = options.realNetworkKey ? Uint8Array.of(0, 1, 2, 3) : mockNetworkKeyOutput();
	const client = Object.create(DWalletGrpcClient.prototype) as any;
	client.furtherValidatorCount = 0;
	client.monotonicNow = () => performance.now();
	client.call = callThroughStubs(() => [client.service]);
	client.service = {
		GetNetworkKeysByAge: (_request: object, _options: object, callback: any) =>
			setImmediate(() =>
				callback(null, {
					network_key_ids: [NETWORK_KEY],
					latest_usable_network_key_id: NETWORK_KEY,
				}),
			),
		GetNetworkKeyOutput: (_request: object, _options: object, callback: any) =>
			setImmediate(() =>
				callback(null, {
					network_dkg_output: output,
					latest_reconfiguration_output: new Uint8Array(0),
					epoch: EPOCH.toString(),
					dkg_at_epoch: '1',
					noa_public_key: NETWORK_KEY,
				}),
			),
		SubmitTransaction: (
			request: { user_signature: Uint8Array; signed_request_data: Uint8Array },
			_options: object,
			callback: any,
		) => {
			backend.receivedBytes.push(Uint8Array.from(request.signed_request_data));
			const data = SignedRequestDataBcs.parse(Uint8Array.from(request.signed_request_data));
			const signer = UserSignatureBcs.parse(Uint8Array.from(request.user_signature)).Ed25519!;
			const sessionIdentifier = grpcSessionIdentifier(
				BigInt(data.epoch),
				'Ed25519',
				Uint8Array.from(signer.public_key),
				Uint8Array.from(data.session_identifier_preimage),
			);
			const answer = backend.answer(data, sessionIdentifier);
			setImmediate(() =>
				callback(null, {
					response_data: Buffer.from(TransactionResponseDataBcs.serialize(answer as any).toBytes()),
				}),
			);
		},
	};
	const network = await Network.connect({
		client: client as DWalletGrpcClient,
		curve: options.curve ?? Curve.ED25519,
		networkKeyId: NETWORK_KEY,
		network: NETWORK,
		records: chainRecording(output),
		chainEpoch: async () => EPOCH,
		...(options.mock ? { cryptography: mockCryptography } : {}),
	});
	return { network, backend };
}

/** The chain's records of `dwallet`, as the mock backend commits them, and the usable state they give. */
async function usableOf(dwallet: DWallet) {
	const record = (kind: AttestationKind, data: Uint8Array): AttestationRecord => ({
		attestationData: data,
		attestationVersion: 0,
		networkSignature: ed25519.sign(attestationSigningMessage(kind, data), NETWORK_SECRET),
		signerNoaPublicKey: NETWORK_KEY,
	});
	const dwalletData = Uint8Array.from(dwallet.attestation.attestation_data);
	const attested = VersionedDWalletDataAttestationBcs.parse(dwalletData).V1!;
	const shareData = VersionedEncryptedUserKeyShareAttestationBcs.serialize({
		V1: {
			session_identifier: attested.session_identifier,
			intended_chain_sender: attested.intended_chain_sender,
			dwallet_public_key: attested.public_key,
			encrypted_share_hash: attested.encrypted_share_hash!,
			encryption_key_hash: attested.encryption_key_hash!,
			holder: attested.holder!,
			dwallet_attestation_digest: Array.from(keccak_256(dwalletData)),
		},
	}).toBytes();
	const reader: DWalletShareReader = {
		chain: 'solana',
		trustedNetworkKeys: trustedNetworkKeys(NETWORK),
		readDWallet: async () => ({
			address: new Uint8Array(32).fill(0xd1),
			networkPublicKey: NETWORK_KEY,
			attestation: record('dwallet', dwalletData),
			readEncryptedShare: async () => record('encrypted_share', shareData),
			readPublicShare: async () => undefined,
		}),
		cryptography: mockCryptography,
	};
	return assertDWalletUsable(
		reader,
		{ getSigningPublicKeyBytes: () => holder.publicKey },
		dwallet.attestation,
	);
}

describe('mock mode against the mock backend', () => {
	it('connects to a mock network, and derives mock protocol parameters', async () => {
		const { network } = await connect({ mock: true });
		expect(isMockValue(network.protocolPublicParameters)).toBe(true);
	});

	const cases: { curve: Curve; schemes: string[] }[] = [
		{ curve: Curve.ED25519, schemes: ['EddsaSha512'] },
		{
			curve: Curve.SECP256K1,
			schemes: ['EcdsaKeccak256', 'EcdsaSha256', 'EcdsaDoubleSha256', 'TaprootSha256'],
		},
		{ curve: Curve.SECP256R1, schemes: ['EcdsaSha256'] },
	];
	for (const { curve, schemes } of cases) {
		it(`creates a dWallet on ${curve}, accepts its share, and signs with ${schemes.join(', ')}`, async () => {
			const { network, backend } = await connect({ mock: true, curve });
			const dwallet = await network.createDWallet(requester, {
				holder,
				encryptionKey: ENCRYPTION_KEY,
			});
			expect(dwallet.acceptance).toBeDefined();
			expect(
				hex(await mockCryptography.publicKeyFromDWalletOutput(curve, dwallet.networkPublicOutput)),
				"the dWallet's key is the one inside the network's output",
			).toBe(hex(dwallet.publicKey));
			expect(backend.keys.has(hex(dwallet.publicKey))).toBe(true);
			const usable = await usableOf(dwallet);
			for (const scheme of schemes) {
				const presign = await network.requestPresign(requester, scheme as any);
				const message = new TextEncoder().encode(`mock mode ${scheme}`);
				const signature = await network.requestSignature(requester, {
					dwallet,
					usable,
					presign,
					message,
					signatureScheme: scheme as any,
					signatureVoucher: new Uint8Array(32).fill(0x77),
				});
				expect(signature.length).toBe(scheme.startsWith('Ecdsa') ? 65 : 64);
			}
		});
	}

	it('refuses a signature that does not verify under the dWallet key', async () => {
		const { network, backend } = await connect({ mock: true, curve: Curve.SECP256K1 });
		const dwallet = await network.createDWallet(requester, {
			holder,
			encryptionKey: ENCRYPTION_KEY,
		});
		const usable = await usableOf(dwallet);
		backend.keys.set(hex(dwallet.publicKey), {
			curve: 0,
			secretKey: secp256k1.utils.randomSecretKey(),
		});
		const presign = await network.requestPresign(requester, 'EcdsaKeccak256');
		const error = await refusal(
			network.requestSignature(requester, {
				dwallet,
				usable,
				presign,
				message: Uint8Array.of(1, 2, 3),
				signatureScheme: signatureSchemeNumber('EcdsaKeccak256'),
				signatureVoucher: new Uint8Array(32).fill(0x77),
			}),
		);
		expect(error.message).toMatch(/does not verify/);
	});

	it('never sends an imported key: the backend makes a new key for the dWallet', async () => {
		const { network, backend } = await connect({ mock: true, curve: Curve.SECP256K1 });
		const secretKey = secp256k1.utils.randomSecretKey();
		const dwallet = await network.verifyImportedKey(
			requester,
			{ holder, encryptionKey: ENCRYPTION_KEY },
			secretKey,
		);
		// No byte sequence of the imported key, nor its public key, is in any request.
		const sent = backend.receivedBytes.map(hex).join('');
		expect(sent).not.toContain(hex(secretKey));
		expect(sent).not.toContain(hex(secp256k1.getPublicKey(secretKey, true)));
		// The dWallet holds the backend's key, not the imported one.
		expect(hex(dwallet.publicKey)).not.toBe(hex(secp256k1.getPublicKey(secretKey, true)));
		expect(hex(backend.keys.get(hex(dwallet.publicKey))!.secretKey)).not.toBe(hex(secretKey));
		expect(backend.received.at(-1).ImportedKeyVerification).toBeDefined();
	});

	it('sends no private key for a new dWallet either', async () => {
		const { network, backend } = await connect({ mock: true, curve: Curve.ED25519 });
		const dwallet = await network.createDWallet(requester, {
			holder,
			encryptionKey: ENCRYPTION_KEY,
		});
		const made = backend.keys.get(hex(dwallet.publicKey))!;
		expect(backend.receivedBytes.map(hex).join('')).not.toContain(hex(made.secretKey));
	});

	it('creates a dWallet whose share is public', async () => {
		const { network, backend } = await connect({ mock: true, curve: Curve.ED25519 });
		const dwallet = await network.createDWalletWithPublicShare(requester);
		expect(dwallet.share.kind).toBe('public');
		expect(dwallet.userSecretKeyShare.length).toBe(34);
		const dkg = backend.received.at(-1).Dkg;
		expect(dkg.user_secret_key_share.Public.public_user_secret_key_share.length).toBe(34);
	});

	it('refuses a value of the real protocol in mock mode', async () => {
		const parameters = mockValue(MockKind.ProtocolPublicParameters, [0]);
		const output = mockValue(MockKind.DWalletOutput, [
			0,
			...secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true),
		]);
		const error = await refusal(
			mockCryptography.createUserSignMessageWithPublicOutput(
				parameters,
				output,
				new Uint8Array(35),
				Uint8Array.of(0, 1, 2),
				Uint8Array.of(1),
				'KECCAK256',
				'ECDSASecp256k1',
				Curve.SECP256K1,
			),
		);
		expect(error.message).toMatch(/not a mock value of its kind/);
	});

	it('takes a mix of mock values and values of the real protocol as no match', async () => {
		expect(
			await mockCryptography.userAndNetworkDKGOutputMatch(
				Curve.ED25519,
				mockValue(MockKind.UserOutput, [2]),
				Uint8Array.of(1, 2, 3),
			),
		).toBe(false);
	});
});
