// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

// Shared Ika dWallet setup: gRPC client, BCS types, dWallet creation flow.

import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import { bcs } from "@mysten/bcs";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "path";
import { sendTx, pda, pollUntil, ok, val, log } from "./helpers.ts";

// ── Constants ──

const SEED_DWALLET_COORDINATOR = Buffer.from("dwallet_coordinator");
const SEED_DWALLET = Buffer.from("dwallet");
const SEED_CPI_AUTHORITY = Buffer.from("__ika_cpi_authority");
const SEED_MESSAGE_APPROVAL = Buffer.from("message_approval");
const IX_TRANSFER_OWNERSHIP = 24;
const DISC_COORDINATOR = 1;
const DISC_NEK = 3;
const DISC_DWALLET = 2;
const COORDINATOR_LEN = 116;
const NEK_LEN = 164;
const CURVE_CURVE25519 = 2;

// ── BCS Type Definitions (must match crates/ika-dwallet-types/src/lib.rs) ──

const ChainId = bcs.enum("ChainId", {
  Solana: null,
  Sui: null,
});

const DWalletCurve = bcs.enum("DWalletCurve", {
  Secp256k1: null,
  Secp256r1: null,
  Curve25519: null,
  Ristretto: null,
});

const DWalletSignatureAlgorithm = bcs.enum("DWalletSignatureAlgorithm", {
  ECDSASecp256k1: null,
  ECDSASecp256r1: null,
  Taproot: null,
  EdDSA: null,
  SchnorrkelSubstrate: null,
});

const DWalletHashScheme = bcs.enum("DWalletHashScheme", {
  Keccak256: null,
  SHA256: null,
  DoubleSHA256: null,
  SHA512: null,
  Merlin: null,
});

// Combined (algorithm, hash) pair — the on-wire signature scheme.
const DWalletSignatureScheme = bcs.enum("DWalletSignatureScheme", {
  EcdsaKeccak256: null,
  EcdsaSha256: null,
  EcdsaDoubleSha256: null,
  TaprootSha256: null,
  EcdsaBlake2b256: null,
  EddsaSha512: null,
  SchnorrkelMerlin: null,
});

const ApprovalProof = bcs.enum("ApprovalProof", {
  Solana: bcs.struct("ApprovalProofSolana", {
    transaction_signature: bcs.vector(bcs.u8()),
    slot: bcs.u64(),
  }),
  Sui: bcs.struct("ApprovalProofSui", {
    effects_certificate: bcs.vector(bcs.u8()),
  }),
});

const UserSignature = bcs.enum("UserSignature", {
  Ed25519: bcs.struct("UserSignatureEd25519", {
    signature: bcs.vector(bcs.u8()),
    public_key: bcs.vector(bcs.u8()),
  }),
  Secp256k1: bcs.struct("UserSignatureSecp256k1", {
    signature: bcs.vector(bcs.u8()),
    public_key: bcs.vector(bcs.u8()),
  }),
  Secp256r1: bcs.struct("UserSignatureSecp256r1", {
    signature: bcs.vector(bcs.u8()),
    public_key: bcs.vector(bcs.u8()),
  }),
});

const NetworkSignedAttestation = bcs.struct("NetworkSignedAttestation", {
  attestation_data: bcs.vector(bcs.u8()),
  network_signature: bcs.vector(bcs.u8()),
  network_pubkey: bcs.vector(bcs.u8()),
  epoch: bcs.u64(),
});

const SignDuringDKGRequest = bcs.struct("SignDuringDKGRequest", {
  presign_session_identifier: bcs.vector(bcs.u8()),
  presign: bcs.vector(bcs.u8()),
  signature_scheme: DWalletSignatureScheme,
  message: bcs.vector(bcs.u8()),
  message_metadata: bcs.vector(bcs.u8()),
  message_centralized_signature: bcs.vector(bcs.u8()),
});

const UserSecretKeyShare = bcs.enum("UserSecretKeyShare", {
  Encrypted: bcs.struct("UserSecretKeyShareEncrypted", {
    encrypted_centralized_secret_share_and_proof: bcs.vector(bcs.u8()),
    encryption_key: bcs.vector(bcs.u8()),
    signer_public_key: bcs.vector(bcs.u8()),
  }),
  Public: bcs.struct("UserSecretKeySharePublic", {
    public_user_secret_key_share: bcs.vector(bcs.u8()),
  }),
});

const DWalletRequest = bcs.enum("DWalletRequest", {
  DKG: bcs.struct("DKG", {
    dwallet_network_encryption_public_key: bcs.vector(bcs.u8()),
    curve: DWalletCurve,
    centralized_public_key_share_and_proof: bcs.vector(bcs.u8()),
    user_secret_key_share: UserSecretKeyShare,
    user_public_output: bcs.vector(bcs.u8()),
    sign_during_dkg_request: bcs.option(SignDuringDKGRequest),
  }),
  Sign: bcs.struct("Sign", {
    message: bcs.vector(bcs.u8()),
    message_metadata: bcs.vector(bcs.u8()),
    presign_session_identifier: bcs.vector(bcs.u8()),
    message_centralized_signature: bcs.vector(bcs.u8()),
    dwallet_attestation: NetworkSignedAttestation,
    approval_proof: ApprovalProof,
  }),
  ImportedKeySign: bcs.struct("ImportedKeySign", {
    message: bcs.vector(bcs.u8()),
    message_metadata: bcs.vector(bcs.u8()),
    presign_session_identifier: bcs.vector(bcs.u8()),
    message_centralized_signature: bcs.vector(bcs.u8()),
    dwallet_attestation: NetworkSignedAttestation,
    approval_proof: ApprovalProof,
  }),
  Presign: bcs.struct("Presign", {
    dwallet_network_encryption_public_key: bcs.vector(bcs.u8()),
    curve: DWalletCurve,
    signature_algorithm: DWalletSignatureAlgorithm,
  }),
  PresignForDWallet: bcs.struct("PresignForDWallet", {
    dwallet_network_encryption_public_key: bcs.vector(bcs.u8()),
    dwallet_public_key: bcs.vector(bcs.u8()),
    curve: DWalletCurve,
    signature_algorithm: DWalletSignatureAlgorithm,
  }),
  ImportedKeyVerification: bcs.struct("ImportedKeyVerification", {
    dwallet_network_encryption_public_key: bcs.vector(bcs.u8()),
    curve: DWalletCurve,
    centralized_party_message: bcs.vector(bcs.u8()),
    user_secret_key_share: UserSecretKeyShare,
    user_public_output: bcs.vector(bcs.u8()),
  }),
  ReEncryptShare: bcs.struct("ReEncryptShare", {
    dwallet_network_encryption_public_key: bcs.vector(bcs.u8()),
    dwallet_public_key: bcs.vector(bcs.u8()),
    dwallet_attestation: NetworkSignedAttestation,
    encrypted_centralized_secret_share_and_proof: bcs.vector(bcs.u8()),
    encryption_key: bcs.vector(bcs.u8()),
  }),
  MakeSharePublic: bcs.struct("MakeSharePublic", {
    dwallet_public_key: bcs.vector(bcs.u8()),
    dwallet_attestation: NetworkSignedAttestation,
    public_user_secret_key_share: bcs.vector(bcs.u8()),
  }),
  FutureSign: bcs.struct("FutureSign", {
    dwallet_public_key: bcs.vector(bcs.u8()),
    presign_session_identifier: bcs.vector(bcs.u8()),
    message: bcs.vector(bcs.u8()),
    message_metadata: bcs.vector(bcs.u8()),
    message_centralized_signature: bcs.vector(bcs.u8()),
    signature_scheme: DWalletSignatureScheme,
  }),
  SignWithPartialUserSig: bcs.struct("SignWithPartialUserSig", {
    partial_user_signature_attestation: NetworkSignedAttestation,
    dwallet_attestation: NetworkSignedAttestation,
    approval_proof: ApprovalProof,
  }),
  ImportedKeySignWithPartialUserSig: bcs.struct("ImportedKeySignWithPartialUserSig", {
    partial_user_signature_attestation: NetworkSignedAttestation,
    dwallet_attestation: NetworkSignedAttestation,
    approval_proof: ApprovalProof,
  }),
});

const SignedRequestData = bcs.struct("SignedRequestData", {
  session_identifier_preimage: bcs.fixedArray(32, bcs.u8()),
  epoch: bcs.u64(),
  chain_id: ChainId,
  intended_chain_sender: bcs.vector(bcs.u8()),
  request: DWalletRequest,
});

// Three response variants: Signature (self-verifying), Attestation
// (NOA-signed wrapper covering DKG / FutureSign / ReEncrypt /
// MakeSharePublic / ImportedKeyVerification AND presigns), Error.
// `Attestation` carries `NetworkSignedAttestation` directly as a tuple variant.
const TransactionResponseData = bcs.enum("TransactionResponseData", {
  Signature: bcs.struct("SignatureResponse", {
    signature: bcs.vector(bcs.u8()),
  }),
  Attestation: NetworkSignedAttestation,
  Error: bcs.struct("ErrorResponse", {
    message: bcs.string(),
  }),
});

// Per-type versioned attestation enums for NetworkSignedAttestation.attestation_data.
// DKG results: decode with `VersionedDWalletDataAttestation.parse(...)`.
const VersionedDWalletDataAttestation = bcs.enum("VersionedDWalletDataAttestation", {
  V1: bcs.struct("DWalletDataAttestationV1", {
    session_identifier: bcs.fixedArray(32, bcs.u8()),
    intended_chain_sender: bcs.vector(bcs.u8()),
    curve: DWalletCurve,
    public_key: bcs.vector(bcs.u8()),
    public_output: bcs.vector(bcs.u8()),
    is_imported_key: bcs.bool(),
    sign_during_dkg_signature: bcs.option(bcs.vector(bcs.u8())),
  }),
});

// Presign results: decode with `VersionedPresignDataAttestation.parse(...)`.
const VersionedPresignDataAttestation = bcs.enum("VersionedPresignDataAttestation", {
  V1: bcs.struct("PresignDataAttestationV1", {
    session_identifier: bcs.fixedArray(32, bcs.u8()),
    epoch: bcs.u64(),
    presign_session_identifier: bcs.vector(bcs.u8()),
    presign_data: bcs.vector(bcs.u8()),
    curve: DWalletCurve,
    signature_algorithm: DWalletSignatureAlgorithm,
    dwallet_public_key: bcs.option(bcs.vector(bcs.u8())),
    user_pubkey: bcs.vector(bcs.u8()),
  }),
});

// ── gRPC Client ──

function loadGrpcClient(grpcUrl: string): any {
  const protoPath = path.resolve(
    import.meta.dirname ?? ".",
    "../../../../proto/ika_dwallet.proto",
  );
  const packageDef = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const protoDesc = grpc.loadPackageDefinition(packageDef) as any;
  const DWalletService = protoDesc.ika.dwallet.v1.DWalletService;
  return new DWalletService(
    grpcUrl.replace(/^https?:\/\//, ""),
    grpc.credentials.createInsecure(),
  );
}

function grpcSubmitTransaction(
  client: any,
  userSignature: Uint8Array,
  signedRequestData: Uint8Array,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    client.SubmitTransaction(
      {
        user_signature: Buffer.from(userSignature),
        signed_request_data: Buffer.from(signedRequestData),
      },
      (err: any, response: any) => {
        if (err) reject(err);
        else resolve(response.response_data);
      },
    );
  });
}

/**
 * Build the dWallet PDA seed list for `find_program_address`.
 *
 * Mirrors `ika_dwallet_program::state::dwallet::DWalletPdaSeeds::new`:
 * concatenate `curve_byte || public_key` into a single buffer and split
 * it into 32-byte chunks (Solana's `MAX_SEED_LEN`). Each chunk becomes
 * its own seed. The total seed count varies by pubkey length but stays
 * well under `MAX_SEEDS = 16`.
 *
 *   - 32-byte pubkey (Ed25519/Curve25519/Ristretto): payload 33 → [32, 1]
 *   - 33-byte pubkey (compressed Secp256k1/r1):      payload 34 → [32, 2]
 *   - 65-byte pubkey (uncompressed SEC1):            payload 66 → [32, 32, 2]
 */
function dwalletPdaSeeds(curve: number, publicKey: Uint8Array): Buffer[] {
  const payload = Buffer.alloc(1 + publicKey.length);
  payload[0] = curve;
  Buffer.from(publicKey).copy(payload, 1);

  const seeds: Buffer[] = [SEED_DWALLET];
  for (let i = 0; i < payload.length; i += 32) {
    seeds.push(payload.subarray(i, Math.min(i + 32, payload.length)));
  }
  return seeds;
}

function buildUserSignature(payer: Keypair): Uint8Array {
  return UserSignature.serialize({
    Ed25519: {
      signature: Array.from(new Uint8Array(64)),
      public_key: Array.from(payer.publicKey.toBytes()),
    },
  }).toBytes();
}

// ── Exports ──

export interface DWalletSetup {
  dwalletPda: PublicKey;
  dwalletAddr: Uint8Array;
  publicKey: Uint8Array;
  cpiAuthority: PublicKey;
  cpiAuthorityBump: number;
  grpcClient: any;
}

/**
 * Full dWallet setup: wait for mock, gRPC DKG, poll for on-chain dWallet,
 * transfer authority to the example program's CPI PDA.
 */
export async function setupDWallet(
  connection: Connection,
  payer: Keypair,
  dwalletProgramId: PublicKey,
  exampleProgramId: PublicKey,
  grpcUrl = "pre-alpha-dev-1.ika.ika-network.net:443",
): Promise<DWalletSetup> {
  // Wait for coordinator.
  const [coordinatorPda] = pda(
    [SEED_DWALLET_COORDINATOR],
    dwalletProgramId,
  );
  await pollUntil(
    connection,
    coordinatorPda,
    (d) => d.length >= COORDINATOR_LEN && d[0] === DISC_COORDINATOR,
  );
  ok(`DWalletCoordinator: ${coordinatorPda.toBase58()}`);

  // Find NEK via getProgramAccounts.
  const nekAccounts = await pollUntilProgramAccount(
    connection,
    dwalletProgramId,
    (d) => d.length >= NEK_LEN && d[0] === DISC_NEK,
  );
  const nekPda = nekAccounts[0].pubkey;
  ok(`NetworkEncryptionKey: ${nekPda.toBase58()}`);

  // gRPC DKG.
  log("DKG", "Requesting DKG via gRPC...");
  const grpcClient = loadGrpcClient(grpcUrl);

  const dkgRequestData = SignedRequestData.serialize({
    session_identifier_preimage: Array.from(new Uint8Array(32)),
    epoch: 1n,
    chain_id: { Solana: true },
    intended_chain_sender: Array.from(payer.publicKey.toBytes()),
    request: {
      DKG: {
        dwallet_network_encryption_public_key: Array.from(new Uint8Array(32)),
        curve: { Curve25519: true },
        centralized_public_key_share_and_proof: Array.from(new Uint8Array(32)),
        user_secret_key_share: {
          Encrypted: {
            encrypted_centralized_secret_share_and_proof: Array.from(new Uint8Array(32)),
            encryption_key: Array.from(new Uint8Array(32)),
            signer_public_key: Array.from(payer.publicKey.toBytes()),
          },
        },
        user_public_output: Array.from(new Uint8Array(32)),
        sign_during_dkg_request: null,
      },
    },
  }).toBytes();

  const responseBytes = await grpcSubmitTransaction(
    grpcClient,
    buildUserSignature(payer),
    dkgRequestData,
  );

  const response = TransactionResponseData.parse(new Uint8Array(responseBytes));
  if (!response.Attestation) {
    throw new Error(`DKG failed: ${JSON.stringify(response)}`);
  }
  ok("DKG attestation received");

  const attestation = response.Attestation;
  // Decode the versioned DWallet data attestation from the signed bytes.
  const payload = VersionedDWalletDataAttestation.parse(
    new Uint8Array(attestation.attestation_data),
  );
  if (!payload.V1) {
    throw new Error(
      `unexpected DKG payload variant: ${JSON.stringify(payload)}`,
    );
  }
  const publicKey = new Uint8Array(payload.V1.public_key);
  // dwalletAddr is now derived from (curve, public_key) by the dwallet PDA
  // seeds — we don't extract it from the attestation bytes anymore.
  const dwalletAddr = new Uint8Array(payer.publicKey.toBytes());

  val("dWallet address", Buffer.from(dwalletAddr).toString("hex"));
  val("Public key", Buffer.from(publicKey).toString("hex"));

  // Poll for dWallet PDA on-chain.
  //
  // Seeds = ["dwallet", chunks_of(curve || pubkey)] — concatenate the
  // curve byte with the raw pubkey into a single buffer and split it
  // into 32-byte chunks (Solana's MAX_SEED_LEN), passing each chunk as
  // its own seed. Mirrors the on-chain `DWalletPdaSeeds::new`.
  const [dwalletPda] = pda(
    dwalletPdaSeeds(CURVE_CURVE25519, publicKey),
    dwalletProgramId,
  );

  await pollUntil(
    connection,
    dwalletPda,
    (d) => d.length > 2 && d[0] === DISC_DWALLET,
    15_000,
  );
  ok(`dWallet on-chain: ${dwalletPda.toBase58()}`);

  // Transfer authority to example program CPI PDA.
  const [cpiAuthority, cpiAuthorityBump] = pda(
    [SEED_CPI_AUTHORITY],
    exampleProgramId,
  );

  const transferData = Buffer.alloc(33);
  transferData[0] = IX_TRANSFER_OWNERSHIP;
  cpiAuthority.toBuffer().copy(transferData, 1);

  await sendTx(
    connection,
    payer,
    [
      new TransactionInstruction({
        programId: dwalletProgramId,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
          { pubkey: dwalletPda, isSigner: false, isWritable: true },
        ],
        data: transferData,
      }),
    ],
  );
  ok(`Authority transferred to CPI PDA: ${cpiAuthority.toBase58()}`);

  return {
    dwalletPda,
    dwalletAddr,
    publicKey,
    cpiAuthority,
    cpiAuthorityBump,
    grpcClient,
  };
}

/**
 * Allocate a presign via gRPC.
 */
export async function requestPresign(
  grpcClient: any,
  payer: Keypair,
  dwalletAddr: Uint8Array,
): Promise<Uint8Array> {
  const data = SignedRequestData.serialize({
    session_identifier_preimage: Array.from(dwalletAddr),
    epoch: 1n,
    chain_id: { Solana: true },
    intended_chain_sender: Array.from(payer.publicKey.toBytes()),
    request: {
      PresignForDWallet: {
        dwallet_network_encryption_public_key: Array.from(new Uint8Array(32)),
        dwallet_public_key: Array.from(dwalletAddr),
        curve: { Curve25519: true },
        signature_algorithm: { EdDSA: true },
      },
    },
  }).toBytes();

  const responseBytes = await grpcSubmitTransaction(
    grpcClient,
    buildUserSignature(payer),
    data,
  );

  const response = TransactionResponseData.parse(new Uint8Array(responseBytes));
  if (!response.Attestation) {
    throw new Error(`Presign failed: ${JSON.stringify(response)}`);
  }
  const presignPayload = VersionedPresignDataAttestation.parse(
    new Uint8Array(response.Attestation.attestation_data),
  );
  if (!presignPayload.V1) {
    throw new Error(
      `unexpected presign payload variant: ${JSON.stringify(presignPayload)}`,
    );
  }
  return new Uint8Array(presignPayload.V1.presign_id);
}

/**
 * Sign a message via gRPC with presign + approval proof.
 */
export async function requestSign(
  grpcClient: any,
  payer: Keypair,
  dwalletAddr: Uint8Array,
  message: Uint8Array,
  presignId: Uint8Array,
  txSignature: string,
): Promise<Uint8Array> {
  const data = SignedRequestData.serialize({
    session_identifier_preimage: Array.from(dwalletAddr),
    epoch: 1n,
    chain_id: { Solana: true },
    intended_chain_sender: Array.from(payer.publicKey.toBytes()),
    request: {
      Sign: {
        message: Array.from(message),
        message_metadata: [],
        presign_session_identifier: Array.from(presignId),
        message_centralized_signature: Array.from(new Uint8Array(64)),
        dwallet_attestation: {
          attestation_data: Array.from(new Uint8Array(32)),
          network_signature: Array.from(new Uint8Array(64)),
          network_pubkey: Array.from(new Uint8Array(32)),
          epoch: 1n,
        },
        approval_proof: {
          Solana: {
            transaction_signature: Array.from(
              Buffer.from(txSignature, "base64"),
            ),
            slot: 0n,
          },
        },
      },
    },
  }).toBytes();

  const responseBytes = await grpcSubmitTransaction(
    grpcClient,
    buildUserSignature(payer),
    data,
  );

  const response = TransactionResponseData.parse(new Uint8Array(responseBytes));
  if (response.Signature) {
    return new Uint8Array(response.Signature.signature);
  }
  if (response.Error) {
    throw new Error(`Sign failed: ${response.Error.message}`);
  }
  throw new Error(`Unexpected sign response: ${JSON.stringify(response)}`);
}

// ── PDA helpers (exported for examples) ──

export function findMessageApprovalPda(
  dwalletProgramId: PublicKey,
  dwallet: PublicKey,
  messageHash: Uint8Array,
): [PublicKey, number] {
  return pda(
    [SEED_MESSAGE_APPROVAL, dwallet.toBuffer(), Buffer.from(messageHash)],
    dwalletProgramId,
  );
}

// ── Internal helpers ──

async function pollUntilProgramAccount(
  connection: Connection,
  programId: PublicKey,
  check: (data: Buffer) => boolean,
  timeoutMs = 30_000,
): Promise<{ pubkey: PublicKey; data: Buffer }[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const accounts = await connection.getProgramAccounts(programId);
    const matched = accounts
      .filter((a) => check(Buffer.from(a.account.data)))
      .map((a) => ({ pubkey: a.pubkey, data: Buffer.from(a.account.data) }));
    if (matched.length > 0) return matched;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Timeout waiting for program account");
}
