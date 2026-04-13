// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

// Browser gRPC-Web client for the Ika dWallet service.
// Uses @protobuf-ts/grpcweb-transport for fetch-based gRPC-Web.

import { GrpcWebFetchTransport } from '@protobuf-ts/grpcweb-transport';
import { DWalletServiceClient } from './generated/grpc-web/ika_dwallet.client.js';
import { defineBcsTypes } from './bcs-types.js';

const { SignedRequestData, TransactionResponseData, UserSignature, VersionedDWalletDataAttestation, VersionedPresignDataAttestation } =
  defineBcsTypes();

export { defineBcsTypes } from './bcs-types.js';

export interface DKGResult {
  dwalletAddr: Uint8Array;
  publicKey: Uint8Array;
}

export interface IkaDWalletWebClient {
  requestDKG(senderPubkey: Uint8Array): Promise<DKGResult>;
  requestPresign(senderPubkey: Uint8Array, dwalletAddr: Uint8Array): Promise<Uint8Array>;
  requestSign(
    senderPubkey: Uint8Array, dwalletAddr: Uint8Array,
    message: Uint8Array, presignId: Uint8Array, txSignature: Uint8Array,
  ): Promise<Uint8Array>;
}

export function createIkaWebClient(baseUrl: string): IkaDWalletWebClient {
  const transport = new GrpcWebFetchTransport({ baseUrl });
  const client = new DWalletServiceClient(transport);

  function buildSig(pubkey: Uint8Array): Uint8Array {
    return UserSignature.serialize({
      Ed25519: { signature: Array.from(new Uint8Array(64)), public_key: Array.from(pubkey) },
    }).toBytes();
  }

  async function submit(userSig: Uint8Array, signedData: Uint8Array): Promise<Uint8Array> {
    const { response } = await client.submitTransaction({
      userSignature: userSig,
      signedRequestData: signedData,
    });
    return response.responseData;
  }

  return {
    async requestDKG(senderPubkey) {
      const data = SignedRequestData.serialize({
        session_identifier_preimage: Array.from(new Uint8Array(32)),
        epoch: 1n, chain_id: { Solana: true },
        intended_chain_sender: Array.from(senderPubkey),
        request: { DKG: {
          dwallet_network_encryption_public_key: Array.from(new Uint8Array(32)),
          curve: { Curve25519: true },
          centralized_public_key_share_and_proof: Array.from(new Uint8Array(32)),
          user_secret_key_share: { Encrypted: {
            encrypted_centralized_secret_share_and_proof: Array.from(new Uint8Array(32)),
            encryption_key: Array.from(new Uint8Array(32)),
            signer_public_key: Array.from(senderPubkey),
          }},
          user_public_output: Array.from(new Uint8Array(32)),
          sign_during_dkg_request: null,
        }},
      }).toBytes();

      const respBytes = await submit(buildSig(senderPubkey), data);
      const resp = TransactionResponseData.parse(new Uint8Array(respBytes));
      if (!resp.Attestation) throw new Error(`DKG failed: ${JSON.stringify(resp)}`);
      // Decode the versioned DWallet data attestation from the signed bytes.
      const payload = VersionedDWalletDataAttestation.parse(
        new Uint8Array(resp.Attestation.attestation_data),
      );
      if (!payload.V1) {
        throw new Error(`unexpected DKG payload variant: ${JSON.stringify(payload)}`);
      }
      // dwalletAddr is now derived from (curve, public_key) on-chain via
      // the dwallet PDA seeds; placeholder for now.
      return {
        dwalletAddr: new Uint8Array(32),
        publicKey: new Uint8Array(payload.V1.public_key),
      };
    },

    async requestPresign(senderPubkey, dwalletAddr) {
      const data = SignedRequestData.serialize({
        session_identifier_preimage: Array.from(dwalletAddr),
        epoch: 1n, chain_id: { Solana: true },
        intended_chain_sender: Array.from(senderPubkey),
        request: { PresignForDWallet: {
          dwallet_network_encryption_public_key: Array.from(new Uint8Array(32)),
          dwallet_public_key: Array.from(dwalletAddr), curve: { Curve25519: true },
          signature_algorithm: { EdDSA: true },
        }},
      }).toBytes();

      const respBytes = await submit(buildSig(senderPubkey), data);
      const resp = TransactionResponseData.parse(new Uint8Array(respBytes));
      if (!resp.Attestation) throw new Error(`Presign failed: ${JSON.stringify(resp)}`);
      const payload = VersionedPresignDataAttestation.parse(
        new Uint8Array(resp.Attestation.attestation_data),
      );
      if (!payload.V1) {
        throw new Error(`unexpected presign payload variant: ${JSON.stringify(payload)}`);
      }
      return new Uint8Array(payload.V1.presign_id);
    },

    async requestSign(senderPubkey, dwalletAddr, message, presignId, txSignature) {
      const data = SignedRequestData.serialize({
        session_identifier_preimage: Array.from(dwalletAddr),
        epoch: 1n, chain_id: { Solana: true },
        intended_chain_sender: Array.from(senderPubkey),
        request: { Sign: {
          message: Array.from(message), message_metadata: [],
          curve: { Curve25519: true },
          signature_scheme: { EddsaSha512: true },
          presign_id: Array.from(presignId),
          message_centralized_signature: Array.from(new Uint8Array(64)),
          approval_proof: { Solana: { transaction_signature: Array.from(txSignature), slot: 0n } },
        }},
      }).toBytes();

      const respBytes = await submit(buildSig(senderPubkey), data);
      const resp = TransactionResponseData.parse(new Uint8Array(respBytes));
      if (resp.Signature) return new Uint8Array(resp.Signature.signature);
      if (resp.Error) throw new Error(resp.Error.message);
      throw new Error(`Unexpected: ${JSON.stringify(resp)}`);
    },
  };
}
