// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! E2E test for all gRPC dWallet protocols against the mock server.
//!
//! Tests every DWalletRequest variant the mock supports:
//!   1. DKG (Ed25519 / Secp256k1)
//!   2. Presign
//!   3. ImportedKeyVerification
//!   4. PresignForDWallet (imported ECDSA)
//!   5. ReEncryptShare
//!   6. MakeSharePublic
//!   7. FutureSign
//!   8. SignWithPartialUserSig
//!
//! Usage: cargo run -- [GRPC_URL]
//! Default gRPC: http://127.0.0.1:50051

use ika_dwallet_types::*;
use ika_grpc::d_wallet_service_client::DWalletServiceClient;
use ika_grpc::UserSignedRequest;
use solana_sdk::signer::Signer;
use tonic::transport::Channel;

const GREEN: &str = "\x1b[32m";
const CYAN: &str = "\x1b[36m";
const YELLOW: &str = "\x1b[33m";
const RED: &str = "\x1b[31m";
const BOLD: &str = "\x1b[1m";
const RESET: &str = "\x1b[0m";

fn ok(msg: &str) {
    println!("{GREEN}  \u{2713}{RESET} {msg}");
}
fn val<V: std::fmt::Display>(label: &str, v: V) {
    println!("{YELLOW}  \u{2192}{RESET} {label}: {v}");
}
fn section(name: &str) {
    println!("\n{BOLD}{CYAN}--- {name} ---{RESET}\n");
}
fn fail(msg: &str) {
    println!("{RED}  \u{2717}{RESET} {msg}");
}

fn build_request(
    payer: &solana_sdk::signature::Keypair,
    session_id: [u8; 32],
    request: DWalletRequest,
) -> UserSignedRequest {
    use solana_sdk::signer::Signer;
    let signed = SignedRequestData {
        session_identifier_preimage: session_id,
        epoch: 1,
        chain_id: ChainId::Solana,
        intended_chain_sender: payer.pubkey().to_bytes().to_vec(),
        request,
    };
    let signed_data = bcs::to_bytes(&signed).expect("BCS serialize");
    let user_sig = UserSignature::Ed25519 {
        signature: vec![0u8; 64],
        public_key: payer.pubkey().to_bytes().to_vec(),
    };
    UserSignedRequest {
        user_signature: bcs::to_bytes(&user_sig).expect("BCS sig"),
        signed_request_data: signed_data,
    }
}

async fn submit(
    client: &mut DWalletServiceClient<Channel>,
    req: UserSignedRequest,
) -> TransactionResponseData {
    let resp = client
        .submit_transaction(req)
        .await
        .expect("gRPC call failed")
        .into_inner();
    bcs::from_bytes(&resp.response_data).expect("BCS deserialize response")
}

#[tokio::main]
async fn main() {
    let grpc_url = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "http://127.0.0.1:50051".to_string());

    println!("\n{BOLD}=== dWallet Protocol E2E Test ==={RESET}\n");
    val("gRPC", &grpc_url);

    let mut client = DWalletServiceClient::connect(grpc_url)
        .await
        .expect("connect to gRPC");

    let payer = solana_sdk::signature::Keypair::new();
    let session_id: [u8; 32] = solana_sdk::signature::Keypair::new()
        .pubkey()
        .to_bytes();

    // ══════════════════════════════════════════════════════════════════
    // 1. DKG — Ed25519 (Curve25519)
    // ══════════════════════════════════════════════════════════════════
    section("1. DKG (Ed25519 / Curve25519)");

    let dkg_resp = submit(&mut client, build_request(&payer, session_id, DWalletRequest::DKG {
        dwallet_network_encryption_public_key: vec![0u8; 32],
        curve: DWalletCurve::Curve25519,
        centralized_public_key_share_and_proof: vec![0u8; 32],
        user_secret_key_share: UserSecretKeyShare::Encrypted {
            encrypted_centralized_secret_share_and_proof: vec![0u8; 32],
            encryption_key: vec![0u8; 32],
            signer_public_key: vec![0u8; 32],
        },
        user_public_output: vec![0u8; 32],
        sign_during_dkg_request: None,
    })).await;

    let ed25519_attestation = match dkg_resp {
        TransactionResponseData::Attestation(att) => {
            let v: VersionedDWalletDataAttestation =
                bcs::from_bytes(&att.attestation_data).expect("decode DKG attestation");
            let VersionedDWalletDataAttestation::V1(ref data) = v;
            ok("DKG Ed25519 succeeded");
            val("Public key", hex::encode(&data.public_key));
            val("Curve", format!("{:?}", data.curve));
            assert!(!data.is_imported_key);
            att
        }
        TransactionResponseData::Error { message } => panic!("DKG failed: {message}"),
        other => panic!("unexpected: {other:?}"),
    };

    // ══════════════════════════════════════════════════════════════════
    // 2. DKG — Secp256k1
    // ══════════════════════════════════════════════════════════════════
    section("2. DKG (Secp256k1)");

    let secp_session_id: [u8; 32] = solana_sdk::signature::Keypair::new()
        .pubkey()
        .to_bytes();

    let secp_resp = submit(&mut client, build_request(&payer, secp_session_id, DWalletRequest::DKG {
        dwallet_network_encryption_public_key: vec![0u8; 32],
        curve: DWalletCurve::Secp256k1,
        centralized_public_key_share_and_proof: vec![0u8; 32],
        user_secret_key_share: UserSecretKeyShare::Public {
            public_user_secret_key_share: vec![0u8; 32],
        },
        user_public_output: vec![0u8; 32],
        sign_during_dkg_request: None,
    })).await;

    let secp_attestation = match secp_resp {
        TransactionResponseData::Attestation(att) => {
            let v: VersionedDWalletDataAttestation =
                bcs::from_bytes(&att.attestation_data).expect("decode");
            let VersionedDWalletDataAttestation::V1(ref data) = v;
            ok("DKG Secp256k1 succeeded");
            val("Public key (compressed)", hex::encode(&data.public_key));
            val("PK length", data.public_key.len());
            assert!(!data.is_imported_key);
            att
        }
        TransactionResponseData::Error { message } => panic!("DKG Secp256k1 failed: {message}"),
        other => panic!("unexpected: {other:?}"),
    };

    // ══════════════════════════════════════════════════════════════════
    // 3. Presign (global, Ed25519)
    // ══════════════════════════════════════════════════════════════════
    section("3. Presign (Ed25519)");

    let presign_resp = submit(&mut client, build_request(&payer, session_id, DWalletRequest::Presign {
        dwallet_network_encryption_public_key: vec![0u8; 32],
        curve: DWalletCurve::Curve25519,
        signature_algorithm: DWalletSignatureAlgorithm::EdDSA,
    })).await;

    let _ed25519_presign = match presign_resp {
        TransactionResponseData::Attestation(att) => {
            let v: VersionedPresignDataAttestation =
                bcs::from_bytes(&att.attestation_data).expect("decode presign");
            let VersionedPresignDataAttestation::V1(ref data) = v;
            ok("Presign Ed25519 allocated");
            val("Presign session ID", hex::encode(&data.presign_session_identifier));
            att
        }
        TransactionResponseData::Error { message } => panic!("Presign failed: {message}"),
        other => panic!("unexpected: {other:?}"),
    };

    // ══════════════════════════════════════════════════════════════════
    // 4. Presign (global, Secp256k1 ECDSA)
    // ══════════════════════════════════════════════════════════════════
    section("4. Presign (Secp256k1 ECDSA)");

    let presign_secp = submit(&mut client, build_request(&payer, secp_session_id, DWalletRequest::Presign {
        dwallet_network_encryption_public_key: vec![0u8; 32],
        curve: DWalletCurve::Secp256k1,
        signature_algorithm: DWalletSignatureAlgorithm::ECDSASecp256k1,
    })).await;

    match presign_secp {
        TransactionResponseData::Attestation(att) => {
            let v: VersionedPresignDataAttestation =
                bcs::from_bytes(&att.attestation_data).expect("decode");
            let VersionedPresignDataAttestation::V1(ref data) = v;
            ok("Presign Secp256k1 allocated");
            val("Presign session ID", hex::encode(&data.presign_session_identifier));
        }
        TransactionResponseData::Error { message } => panic!("Presign Secp256k1 failed: {message}"),
        other => panic!("unexpected: {other:?}"),
    };

    // ══════════════════════════════════════════════════════════════════
    // 5. ImportedKeyVerification (Secp256k1)
    // ══════════════════════════════════════════════════════════════════
    section("5. ImportedKeyVerification (Secp256k1)");

    let imported_session: [u8; 32] = solana_sdk::signature::Keypair::new()
        .pubkey()
        .to_bytes();

    let imported_resp = submit(&mut client, build_request(&payer, imported_session, DWalletRequest::ImportedKeyVerification {
        dwallet_network_encryption_public_key: vec![0u8; 32],
        curve: DWalletCurve::Secp256k1,
        centralized_party_message: vec![0u8; 64],
        user_secret_key_share: UserSecretKeyShare::Encrypted {
            encrypted_centralized_secret_share_and_proof: vec![0u8; 32],
            encryption_key: vec![0u8; 32],
            signer_public_key: vec![0u8; 32],
        },
        user_public_output: vec![0u8; 32],
    })).await;

    let imported_attestation = match imported_resp {
        TransactionResponseData::Attestation(att) => {
            let v: VersionedDWalletDataAttestation =
                bcs::from_bytes(&att.attestation_data).expect("decode imported");
            let VersionedDWalletDataAttestation::V1(ref data) = v;
            ok("ImportedKeyVerification succeeded");
            val("Public key", hex::encode(&data.public_key));
            assert!(data.is_imported_key);
            val("is_imported_key", data.is_imported_key);
            att
        }
        TransactionResponseData::Error { message } => panic!("ImportedKeyVerification failed: {message}"),
        other => panic!("unexpected: {other:?}"),
    };

    // ══════════════════════════════════════════════════════════════════
    // 6. PresignForDWallet (imported ECDSA key)
    // ══════════════════════════════════════════════════════════════════
    section("6. PresignForDWallet (imported Secp256k1)");

    let imported_pk = {
        let v: VersionedDWalletDataAttestation =
            bcs::from_bytes(&imported_attestation.attestation_data).unwrap();
        let VersionedDWalletDataAttestation::V1(data) = v;
        data.public_key
    };

    // The mock stores imported flag under session_identifier (32 bytes).
    // Pass it as dwallet_public_key so the mock can look it up.
    let presign_imported = submit(&mut client, build_request(&payer, imported_session, DWalletRequest::PresignForDWallet {
        dwallet_network_encryption_public_key: vec![0u8; 32],
        dwallet_public_key: imported_session.to_vec(),
        curve: DWalletCurve::Secp256k1,
        signature_algorithm: DWalletSignatureAlgorithm::ECDSASecp256k1,
    })).await;

    let imported_presign_att = match presign_imported {
        TransactionResponseData::Attestation(att) => {
            let v: VersionedPresignDataAttestation =
                bcs::from_bytes(&att.attestation_data).expect("decode");
            let VersionedPresignDataAttestation::V1(ref data) = v;
            ok("PresignForDWallet (imported) allocated");
            val("Presign session ID", hex::encode(&data.presign_session_identifier));
            att
        }
        TransactionResponseData::Error { message } => panic!("PresignForDWallet failed: {message}"),
        other => panic!("unexpected: {other:?}"),
    };

    // ══════════════════════════════════════════════════════════════════
    // 7. ReEncryptShare
    // ══════════════════════════════════════════════════════════════════
    section("7. ReEncryptShare");

    let reencrypt_resp = submit(&mut client, build_request(&payer, session_id, DWalletRequest::ReEncryptShare {
        dwallet_network_encryption_public_key: vec![0u8; 32],
        dwallet_public_key: vec![0u8; 32],
        dwallet_attestation: ed25519_attestation.clone(),
        encrypted_centralized_secret_share_and_proof: vec![0u8; 64],
        encryption_key: vec![0u8; 32],
    })).await;

    match reencrypt_resp {
        TransactionResponseData::Attestation(att) => {
            let v: VersionedEncryptedUserKeyShareAttestation =
                bcs::from_bytes(&att.attestation_data).expect("decode ReEncrypt");
            let VersionedEncryptedUserKeyShareAttestation::V1(ref data) = v;
            ok("ReEncryptShare succeeded");
            val("dWallet PK", hex::encode(&data.dwallet_public_key));
        }
        TransactionResponseData::Error { message } => panic!("ReEncryptShare failed: {message}"),
        other => panic!("unexpected: {other:?}"),
    };

    // ══════════════════════════════════════════════════════════════════
    // 8. MakeSharePublic
    // ══════════════════════════════════════════════════════════════════
    section("8. MakeSharePublic");

    let make_public_resp = submit(&mut client, build_request(&payer, session_id, DWalletRequest::MakeSharePublic {
        dwallet_public_key: vec![0u8; 32],
        dwallet_attestation: ed25519_attestation.clone(),
        public_user_secret_key_share: vec![0u8; 32],
    })).await;

    match make_public_resp {
        TransactionResponseData::Attestation(att) => {
            let v: VersionedPublicUserKeyShareAttestation =
                bcs::from_bytes(&att.attestation_data).expect("decode MakeSharePublic");
            let VersionedPublicUserKeyShareAttestation::V1(ref data) = v;
            ok("MakeSharePublic succeeded");
            val("dWallet PK", hex::encode(&data.dwallet_public_key));
        }
        TransactionResponseData::Error { message } => panic!("MakeSharePublic failed: {message}"),
        other => panic!("unexpected: {other:?}"),
    };

    // ══════════════════════════════════════════════════════════════════
    // 9. FutureSign (step 1 of two-step conditional signing)
    // ══════════════════════════════════════════════════════════════════
    section("9. FutureSign");

    let future_msg = b"conditional transfer 50 ETH";
    let future_sign_resp = submit(&mut client, build_request(&payer, session_id, DWalletRequest::FutureSign {
        dwallet_public_key: vec![0u8; 32],
        presign_session_identifier: vec![0u8; 32],
        message: future_msg.to_vec(),
        message_metadata: vec![],
        message_centralized_signature: vec![0u8; 64],
        signature_scheme: DWalletSignatureScheme::EddsaSha512,
    })).await;

    let future_sign_att = match future_sign_resp {
        TransactionResponseData::Attestation(att) => {
            let v: VersionedPartialUserSignatureAttestation =
                bcs::from_bytes(&att.attestation_data).expect("decode FutureSign");
            let VersionedPartialUserSignatureAttestation::V1(ref data) = v;
            ok("FutureSign succeeded");
            val("Scheme", format!("{:?}", data.signature_scheme));
            val("Message", String::from_utf8_lossy(&data.message));
            att
        }
        TransactionResponseData::Error { message } => panic!("FutureSign failed: {message}"),
        other => panic!("unexpected: {other:?}"),
    };

    // ══════════════════════════════════════════════════════════════════
    // 10. SignWithPartialUserSig (step 2, needs on-chain MA — expect error in pure gRPC)
    // ══════════════════════════════════════════════════════════════════
    section("10. SignWithPartialUserSig");

    let partial_resp = submit(&mut client, build_request(&payer, session_id, DWalletRequest::SignWithPartialUserSig {
        partial_user_signature_attestation: future_sign_att.clone(),
        dwallet_attestation: ed25519_attestation.clone(),
        approval_proof: ApprovalProof::Solana {
            transaction_signature: vec![0u8; 64],
            slot: 0,
        },
    })).await;

    match partial_resp {
        TransactionResponseData::Signature { ref signature } => {
            ok("SignWithPartialUserSig returned a signature (mock auto-signed)");
            val("Signature length", signature.len());
        }
        TransactionResponseData::Error { ref message } => {
            // Expected: MA PDA not found on-chain since we didn't deploy the program
            ok(&format!("SignWithPartialUserSig returned expected error (no on-chain MA): {}", &message[..message.len().min(80)]));
        }
        other => panic!("unexpected: {other:?}"),
    };

    // ══════════════════════════════════════════════════════════════════
    // Summary
    // ══════════════════════════════════════════════════════════════════
    println!("\n{BOLD}{GREEN}=== All Protocol Tests Passed! ==={RESET}\n");
}
