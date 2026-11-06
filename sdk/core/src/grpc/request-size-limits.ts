// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The size limits of a gRPC request's signed bytes.
 *
 * The network refuses a request over one of these limits from its bytes,
 * and charges the signer for it. The values are the protocol config's, from
 * protocol version 8: `grpc_max_request_field_bytes`,
 * `grpc_max_sign_message_bytes`, `grpc_max_message_metadata_bytes` and
 * `grpc_max_signed_request_data_bytes` in the network's protocol config.
 */
export const GRPC_REQUEST_SIZE_LIMITS = {
	/** The most bytes a byte field without a limit of its own may hold. */
	fieldBytes: 16_384,
	/** The most bytes a sign request's `message` may hold. */
	messageBytes: 16_384,
	/** The most bytes a `message_metadata` may hold. */
	messageMetadataBytes: 256,
	/** The most bytes the whole signed request may hold. */
	signedRequestDataBytes: 65_536,
} as const;

/** Which size limit a byte field is held to. */
type ByteFieldLimit = 'field' | 'message' | 'messageMetadata';

/** One byte field: its name as the network names it, its limit, and its length. */
type ByteField = [name: string, limit: ByteFieldLimit, length: number];

const LIMIT_BYTES: Record<ByteFieldLimit, number> = {
	field: GRPC_REQUEST_SIZE_LIMITS.fieldBytes,
	message: GRPC_REQUEST_SIZE_LIMITS.messageBytes,
	messageMetadata: GRPC_REQUEST_SIZE_LIMITS.messageMetadataBytes,
};

const ATTESTATION_BYTE_FIELDS = ['attestation_data', 'network_signature', 'network_pubkey'];

function lengthOf(value: unknown): number {
	return (value as { length: number }).length;
}

function fieldsOf(value: unknown): Record<string, unknown> {
	return value as Record<string, unknown>;
}

function attestationFields(prefix: string, attestation: unknown): ByteField[] {
	return ATTESTATION_BYTE_FIELDS.map((name) => [
		`${prefix}.${name}`,
		'field',
		lengthOf(fieldsOf(attestation)[name]),
	]);
}

/** The byte fields of a DKG's sign, none for a DKG without one. */
function signDuringDkgFields(sign: unknown): ByteField[] {
	if (sign == null) {
		return [];
	}
	const fields = fieldsOf(sign);
	return [
		[
			'sign_during_dkg_request.presign_session_identifier',
			'field',
			lengthOf(fields.presign_session_identifier),
		],
		['sign_during_dkg_request.presign', 'field', lengthOf(fields.presign)],
		['sign_during_dkg_request.message', 'message', lengthOf(fields.message)],
		[
			'sign_during_dkg_request.message_metadata',
			'messageMetadata',
			lengthOf(fields.message_metadata),
		],
		[
			'sign_during_dkg_request.message_centralized_signature',
			'field',
			lengthOf(fields.message_centralized_signature),
		],
	];
}

function userSecretKeyShareFields(share: unknown): ByteField[] {
	const { Encrypted, Public } = fieldsOf(share);
	if (Encrypted != null) {
		return [
			'encrypted_centralized_secret_share_and_proof',
			'encryption_key',
			'signer_public_key',
		].map((name) => [
			`user_secret_key_share.${name}`,
			'field',
			lengthOf(fieldsOf(Encrypted)[name]),
		]);
	}
	return [
		[
			'user_secret_key_share.public_user_secret_key_share',
			'field',
			lengthOf(fieldsOf(Public).public_user_secret_key_share),
		],
	];
}

/**
 * The byte fields of a request this SDK can build, in the order the network
 * checks them. The kinds the SDK cannot build carry no field here; the whole
 * request's limit still applies to them.
 */
function requestByteFields(request: unknown): ByteField[] {
	const { Dkg, Sign, ImportedKeySign, PresignForDWallet, ReEncryptShare, MakeSharePublic } =
		fieldsOf(request);
	if (Dkg != null) {
		const dkg = fieldsOf(Dkg);
		return [
			[
				'centralized_public_key_share_and_proof',
				'field',
				lengthOf(dkg.centralized_public_key_share_and_proof),
			],
			...userSecretKeyShareFields(dkg.user_secret_key_share),
			['user_public_output', 'field', lengthOf(dkg.user_public_output)],
			...signDuringDkgFields(dkg.sign_during_dkg_request),
		];
	}
	const sign = Sign ?? ImportedKeySign;
	if (sign != null) {
		const fields = fieldsOf(sign);
		return [
			['message', 'message', lengthOf(fields.message)],
			['message_metadata', 'messageMetadata', lengthOf(fields.message_metadata)],
			['presign_session_identifier', 'field', lengthOf(fields.presign_session_identifier)],
			['message_centralized_signature', 'field', lengthOf(fields.message_centralized_signature)],
			...attestationFields('dwallet_attestation', fields.dwallet_attestation),
		];
	}
	if (PresignForDWallet != null) {
		const fields = fieldsOf(PresignForDWallet);
		return [
			['dwallet_public_key', 'field', lengthOf(fields.dwallet_public_key)],
			...attestationFields('dwallet_attestation', fields.dwallet_attestation),
		];
	}
	if (ReEncryptShare != null) {
		const fields = fieldsOf(ReEncryptShare);
		return [
			['dwallet_public_key', 'field', lengthOf(fields.dwallet_public_key)],
			...attestationFields('dwallet_attestation', fields.dwallet_attestation),
			[
				'encrypted_centralized_secret_share_and_proof',
				'field',
				lengthOf(fields.encrypted_centralized_secret_share_and_proof),
			],
			['encryption_key', 'field', lengthOf(fields.encryption_key)],
		];
	}
	if (MakeSharePublic != null) {
		const fields = fieldsOf(MakeSharePublic);
		return [
			['dwallet_public_key', 'field', lengthOf(fields.dwallet_public_key)],
			...attestationFields('dwallet_attestation', fields.dwallet_attestation),
			['public_user_secret_key_share', 'field', lengthOf(fields.public_user_secret_key_share)],
		];
	}
	return [];
}

/**
 * Throw the network's refusal for the first byte field over its limit, in
 * the order the network checks them. The sentence is the one the network
 * answers with, so a caller sees the same refusal before and after sending.
 */
export function assertRequestFieldsWithinLimits(signedData: {
	intended_chain_sender: unknown;
	request: unknown;
}): void {
	const fields: ByteField[] = [
		['intended_chain_sender', 'field', lengthOf(signedData.intended_chain_sender)],
		...requestByteFields(signedData.request),
	];
	const over = fields.find(([, limit, length]) => length > LIMIT_BYTES[limit]);
	if (over) {
		const [name, limit, length] = over;
		throw new Error(
			`the request's ${name} is ${length} bytes, over the limit of ${LIMIT_BYTES[limit]} bytes`,
		);
	}
}

/** Throw the network's refusal when the whole signed request is over its limit. */
export function assertSignedRequestDataWithinLimit(signedRequestData: Uint8Array): void {
	const limit = GRPC_REQUEST_SIZE_LIMITS.signedRequestDataBytes;
	if (signedRequestData.length > limit) {
		throw new Error(
			`the signed request is ${signedRequestData.length} bytes, over the limit of ${limit} bytes`,
		);
	}
}
