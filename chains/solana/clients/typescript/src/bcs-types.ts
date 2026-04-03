// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

// BCS type definitions matching crates/ika-dwallet-types/src/lib.rs.
// Used by both grpc.ts (Node) and grpc-web.ts (browser).

import { bcs } from '@mysten/bcs';

export function defineBcsTypes() {
  const ChainId = bcs.enum('ChainId', { Solana: null, Sui: null });
  const DWalletCurve = bcs.enum('DWalletCurve', { Secp256k1: null, Secp256r1: null, Curve25519: null, Ristretto: null });
  const DWalletSignatureAlgorithm = bcs.enum('DWalletSignatureAlgorithm', {
    ECDSASecp256k1: null, ECDSASecp256r1: null, Taproot: null, EdDSA: null, SchnorrkelSubstrate: null,
  });
  const DWalletHashScheme = bcs.enum('DWalletHashScheme', {
    Keccak256: null, SHA256: null, DoubleSHA256: null, SHA512: null, Merlin: null,
  });

  const ApprovalProof = bcs.enum('ApprovalProof', {
    Solana: bcs.struct('APS', { transaction_signature: bcs.vector(bcs.u8()), slot: bcs.u64() }),
    Sui: bcs.struct('APSui', { effects_certificate: bcs.vector(bcs.u8()) }),
  });

  const UserSignature = bcs.enum('UserSignature', {
    Ed25519: bcs.struct('USE', { signature: bcs.vector(bcs.u8()), public_key: bcs.vector(bcs.u8()) }),
    Secp256k1: bcs.struct('USS', { signature: bcs.vector(bcs.u8()), public_key: bcs.vector(bcs.u8()) }),
    Secp256r1: bcs.struct('USR', { signature: bcs.vector(bcs.u8()), public_key: bcs.vector(bcs.u8()) }),
  });

  const DWalletRequest = bcs.enum('DWalletRequest', {
    DKG: bcs.struct('DKG', {
      dwallet_network_encryption_public_key: bcs.vector(bcs.u8()), curve: DWalletCurve,
      centralized_public_key_share_and_proof: bcs.vector(bcs.u8()),
      encrypted_centralized_secret_share_and_proof: bcs.vector(bcs.u8()),
      encryption_key: bcs.vector(bcs.u8()), user_public_output: bcs.vector(bcs.u8()),
      signer_public_key: bcs.vector(bcs.u8()),
    }),
    DKGWithPublicShare: bcs.struct('DKGWPS', {
      dwallet_network_encryption_public_key: bcs.vector(bcs.u8()), curve: DWalletCurve,
      centralized_public_key_share_and_proof: bcs.vector(bcs.u8()),
      public_user_secret_key_share: bcs.vector(bcs.u8()), signer_public_key: bcs.vector(bcs.u8()),
    }),
    Sign: bcs.struct('Sign', {
      message: bcs.vector(bcs.u8()), curve: DWalletCurve,
      signature_algorithm: DWalletSignatureAlgorithm, hash_scheme: DWalletHashScheme,
      presign_id: bcs.vector(bcs.u8()), message_centralized_signature: bcs.vector(bcs.u8()),
      approval_proof: ApprovalProof,
    }),
    ImportedKeySign: bcs.struct('IKS', {
      message: bcs.vector(bcs.u8()), curve: DWalletCurve,
      signature_algorithm: DWalletSignatureAlgorithm, hash_scheme: DWalletHashScheme,
      presign_id: bcs.vector(bcs.u8()), message_centralized_signature: bcs.vector(bcs.u8()),
      approval_proof: ApprovalProof,
    }),
    Presign: bcs.struct('Presign', { curve: DWalletCurve, signature_algorithm: DWalletSignatureAlgorithm }),
    PresignForDWallet: bcs.struct('PFD', {
      dwallet_id: bcs.vector(bcs.u8()), curve: DWalletCurve, signature_algorithm: DWalletSignatureAlgorithm,
    }),
    ImportedKeyVerification: null, ReEncryptShare: null, MakeSharePublic: null,
    FutureSign: null, SignWithPartialUserSig: null, ImportedKeySignWithPartialUserSig: null,
  });

  const SignedRequestData = bcs.struct('SignedRequestData', {
    session_identifier_preimage: bcs.fixedArray(32, bcs.u8()),
    epoch: bcs.u64(), chain_id: ChainId,
    intended_chain_sender: bcs.vector(bcs.u8()),
    request: DWalletRequest,
  });

  const TransactionResponseData = bcs.enum('TransactionResponseData', {
    Signature: bcs.struct('SigResp', { signature: bcs.vector(bcs.u8()) }),
    Attestation: bcs.struct('AttResp', {
      attestation_data: bcs.vector(bcs.u8()), network_signature: bcs.vector(bcs.u8()),
      network_pubkey: bcs.vector(bcs.u8()), epoch: bcs.u64(),
    }),
    Presign: bcs.struct('PreResp', {
      presign_id: bcs.vector(bcs.u8()), presign_data: bcs.vector(bcs.u8()), epoch: bcs.u64(),
    }),
    Error: bcs.struct('ErrResp', { message: bcs.string() }),
  });

  return { ChainId, DWalletCurve, DWalletSignatureAlgorithm, DWalletHashScheme, ApprovalProof, UserSignature, DWalletRequest, SignedRequestData, TransactionResponseData };
}
