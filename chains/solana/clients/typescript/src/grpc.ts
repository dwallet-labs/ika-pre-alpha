// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

// Node.js / Bun gRPC client for the Ika dWallet service.
// Uses @grpc/grpc-js for native gRPC transport.

import * as grpc from '@grpc/grpc-js';
import { bcs } from '@mysten/bcs';
import {
  DWalletServiceClient,
  type UserSignedRequest as ProtoRequest,
} from './generated/grpc/ika_dwallet.js';
import { defineBcsTypes } from './bcs-types.js';

const { SignedRequestData, TransactionResponseData, UserSignature } = defineBcsTypes();

export { defineBcsTypes } from './bcs-types.js';

export interface DKGResult {
  dwalletAddr: Uint8Array;
  publicKey: Uint8Array;
  attestationData: Uint8Array;
  networkSignature: Uint8Array;
  networkPubkey: Uint8Array;
}

export interface IkaDWalletClient {
  requestDKG(senderPubkey: Uint8Array): Promise<DKGResult>;
  requestPresign(senderPubkey: Uint8Array, dwalletAddr: Uint8Array): Promise<Uint8Array>;
  requestSign(
    senderPubkey: Uint8Array, dwalletAddr: Uint8Array,
    message: Uint8Array, presignId: Uint8Array, txSignature: Uint8Array,
  ): Promise<Uint8Array>;
  close(): void;
}

/** gRPC endpoint for the Ika dWallet pre-alpha on Solana devnet. */
export const DEVNET_PRE_ALPHA_GRPC_URL =
  "pre-alpha-dev-1.ika.ika-network.net:443";

export function createIkaClient(grpcUrl?: string): IkaDWalletClient {
  const url = grpcUrl ?? DEVNET_PRE_ALPHA_GRPC_URL;
  const creds = url.includes('localhost') || url.match(/127\.0\.0\.1/)
    ? grpc.credentials.createInsecure()
    : grpc.credentials.createSsl();
  const client = new DWalletServiceClient(url, creds);

  function submit(userSig: Uint8Array, signedData: Uint8Array): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      client.submitTransaction(
        { userSignature: Buffer.from(userSig), signedRequestData: Buffer.from(signedData) },
        (err, resp) => {
          if (err) reject(err);
          else resolve(new Uint8Array(resp!.responseData));
        },
      );
    });
  }

  function buildSig(pubkey: Uint8Array): Uint8Array {
    return UserSignature.serialize({
      Ed25519: { signature: Array.from(new Uint8Array(64)), public_key: Array.from(pubkey) },
    }).toBytes();
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
          encrypted_centralized_secret_share_and_proof: Array.from(new Uint8Array(32)),
          encryption_key: Array.from(new Uint8Array(32)),
          user_public_output: Array.from(new Uint8Array(32)),
          signer_public_key: Array.from(senderPubkey),
        }},
      }).toBytes();

      const respBytes = await submit(buildSig(senderPubkey), data);
      const resp = TransactionResponseData.parse(new Uint8Array(respBytes));
      if (!resp.Attestation) throw new Error(`DKG failed: ${JSON.stringify(resp)}`);
      const att = resp.Attestation.attestation_data;
      const pkLen = att[32];
      return {
        dwalletAddr: new Uint8Array(att.slice(0, 32)),
        publicKey: new Uint8Array(att.slice(33, 33 + pkLen)),
        attestationData: new Uint8Array(att),
        networkSignature: new Uint8Array(resp.Attestation.network_signature),
        networkPubkey: new Uint8Array(resp.Attestation.network_pubkey),
      };
    },

    async requestPresign(senderPubkey, dwalletAddr) {
      const data = SignedRequestData.serialize({
        session_identifier_preimage: Array.from(dwalletAddr),
        epoch: 1n, chain_id: { Solana: true },
        intended_chain_sender: Array.from(senderPubkey),
        request: { PresignForDWallet: {
          dwallet_id: Array.from(dwalletAddr),
          curve: { Curve25519: true }, signature_algorithm: { EdDSA: true },
        }},
      }).toBytes();

      const respBytes = await submit(buildSig(senderPubkey), data);
      const resp = TransactionResponseData.parse(new Uint8Array(respBytes));
      if (!resp.Presign) throw new Error(`Presign failed: ${JSON.stringify(resp)}`);
      return new Uint8Array(resp.Presign.presign_id);
    },

    async requestSign(senderPubkey, dwalletAddr, message, presignId, txSignature) {
      const data = SignedRequestData.serialize({
        session_identifier_preimage: Array.from(dwalletAddr),
        epoch: 1n, chain_id: { Solana: true },
        intended_chain_sender: Array.from(senderPubkey),
        request: { Sign: {
          message: Array.from(message), curve: { Curve25519: true },
          signature_algorithm: { EdDSA: true }, hash_scheme: { Keccak256: true },
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

    close() { client.close(); },
  };
}
