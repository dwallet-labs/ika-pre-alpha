// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The messages of a validator's dWallet gRPC service, and their encoding.
 *
 * protobufjs parses the proto text below, keeping the field names as written,
 * and encodes and decodes each message from that parse. Nothing here needs
 * Node: decoded bytes fields are `Uint8Array`s.
 */
import protobuf from 'protobufjs';

import type { CommitteeAnswer, SignedCommittee } from './committee.js';

/** Mirror of proto/ika_dwallet.proto (kept inline: the SDK ships without the repo). */
const PROTO = `
syntax = "proto3";
package ika.dwallet.v1alpha1;
service DWalletService {
  rpc SubmitTransaction(UserSignedRequest) returns (TransactionResponse);
  rpc GetPresigns(GetPresignsRequest) returns (GetPresignsResponse);
  rpc GetPresignsForDWallet(GetPresignsForDWalletRequest) returns (GetPresignsResponse);
  rpc GetNetworkKeyOutput(GetNetworkKeyOutputRequest) returns (GetNetworkKeyOutputResponse);
  rpc GetNetworkKeysByAge(GetNetworkKeysByAgeRequest) returns (GetNetworkKeysByAgeResponse);
  rpc GetCommittee(GetCommitteeRequest) returns (GetCommitteeResponse);
}
message UserSignedRequest {
  bytes user_signature = 1;
  bytes signed_request_data = 2;
}
message TransactionResponse {
  bytes response_data = 1;
}
message GetPresignsRequest {
  bytes user_pubkey = 1;
}
message GetPresignsForDWalletRequest {
  bytes user_pubkey = 1;
  bytes dwallet_public_key = 2;
  bytes imported_session_identifier = 3;
}
message GetPresignsResponse {
  repeated PresignInfo presigns = 1;
}
message PresignInfo {
  bytes presign_id = 1;
  bytes dwallet_binding_id = 2;
  uint32 signature_algorithm = 3;
  uint64 assigned_epoch = 4;
}
message GetNetworkKeyOutputRequest {
  bytes network_key_identifier = 1;
}
message GetNetworkKeyOutputResponse {
  bytes network_dkg_output = 1;
  bytes latest_reconfiguration_output = 2;
  uint64 epoch = 3;
  uint64 dkg_at_epoch = 4;
  bytes noa_public_key = 5;
  bytes secp256k1_noa_public_key = 6;
}
message GetNetworkKeysByAgeRequest {}
message GetNetworkKeysByAgeResponse {
  repeated bytes network_key_ids = 1;
  bytes latest_usable_network_key_id = 2;
}
message GetCommitteeRequest {}
message SignedCommittee {
  bytes members = 1;
  bytes attestation = 2;
  bytes signer_noa_public_key = 3;
  bytes signature = 4;
}
message GetCommitteeResponse {
  SignedCommittee committee = 1;
  SignedCommittee next_committee = 2;
}
`;

/** The service's full name, as a gRPC path names it. */
export const DWALLET_SERVICE_NAME = 'ika.dwallet.v1alpha1.DWalletService';

/**
 * The parsed service. protobufjs parses the text in memory, keeping the field
 * names as written. No file is written: an earlier version wrote the text to
 * a fixed name in the shared temporary directory, where another user could
 * replace it with a link, or with another definition, before it was read.
 */
const service = protobuf
	.parse(PROTO, { keepCase: true })
	.root.resolveAll()
	.lookupService(DWALLET_SERVICE_NAME);

/**
 * How a decoded message becomes a plain object: 64-bit numbers as decimal
 * strings, enums as numbers, and fields at their default value left out.
 * These are the options the client decoded with when grpc-js and
 * proto-loader decoded its answers.
 */
const TO_OBJECT_OPTIONS: protobuf.IConversionOptions = { longs: String };

/** The names of the service's methods. */
export const DWALLET_SERVICE_METHOD_NAMES: readonly string[] = Object.keys(service.methods);

function methodOf(method: string): protobuf.Method {
	const found = service.methods[method];
	if (found === undefined) {
		throw new Error(`${DWALLET_SERVICE_NAME} has no method ${method}`);
	}
	return found;
}

/** Encode `message`, a plain object with the proto's field names. */
function encode(type: protobuf.Type, message: object): Uint8Array {
	return type.encode(type.fromObject(message)).finish();
}

/** Decode `bytes` to a plain object with the proto's field names. */
function decode(type: protobuf.Type, bytes: Uint8Array): any {
	return type.toObject(type.decode(bytes), TO_OBJECT_OPTIONS);
}

/** Encode the request of `method`. */
export function encodeRequest(method: string, request: object): Uint8Array {
	return encode(methodOf(method).resolvedRequestType!, request);
}

/** Decode the answer of `method`. */
export function decodeResponse(method: string, bytes: Uint8Array): any {
	return decode(methodOf(method).resolvedResponseType!, bytes);
}

/** Decode the request of `method`, as a server does. */
export function decodeRequest(method: string, bytes: Uint8Array): any {
	return decode(methodOf(method).resolvedRequestType!, bytes);
}

/** Encode the answer of `method`, as a server does. */
export function encodeResponse(method: string, response: object): Uint8Array {
	return encode(methodOf(method).resolvedResponseType!, response);
}

/**
 * One `SignedCommittee` message as the committee check takes it. A bytes
 * field left at its default, empty, is decoded as no field, and is empty
 * bytes here.
 */
function signedCommitteeOf(message: {
	members?: Uint8Array;
	attestation?: Uint8Array;
	signer_noa_public_key?: Uint8Array;
	signature?: Uint8Array;
}): SignedCommittee {
	return {
		members: Uint8Array.from(message.members ?? []),
		attestation: Uint8Array.from(message.attestation ?? []),
		signerNoaPublicKey: Uint8Array.from(message.signer_noa_public_key ?? []),
		signature: Uint8Array.from(message.signature ?? []),
	};
}

/**
 * Decode a `GetCommittee` answer for `verifyCommitteeAnswer`. A committee the
 * validator left out is `undefined`.
 */
export function decodeCommitteeAnswer(bytes: Uint8Array): CommitteeAnswer {
	const { committee, next_committee } = decodeResponse('GetCommittee', bytes);
	return {
		committee: committee === undefined ? undefined : signedCommitteeOf(committee),
		nextCommittee: next_committee === undefined ? undefined : signedCommitteeOf(next_committee),
	};
}
