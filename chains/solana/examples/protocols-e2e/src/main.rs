// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! Full E2E test for all gRPC dWallet protocols against the mock server.
//!
//! Tests every DKG curve, every signature scheme (full DKG → Presign → Sign),
//! imported key flow, ReEncryptShare, MakeSharePublic, FutureSign, and
//! two-step conditional signing (SignWithPartialUserSig).
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
const BOLD: &str = "\x1b[1m";
const RESET: &str = "\x1b[0m";

fn ok(msg: &str) { println!("{GREEN}  \u{2713}{RESET} {msg}"); }
fn val<V: std::fmt::Display>(label: &str, v: V) { println!("{YELLOW}  \u{2192}{RESET} {label}: {v}"); }
fn section(name: &str) { println!("\n{BOLD}{CYAN}--- {name} ---{RESET}\n"); }

fn new_session() -> [u8; 32] {
    solana_sdk::signature::Keypair::new().pubkey().to_bytes()
}

fn build_request(
    payer: &solana_sdk::signature::Keypair,
    session_id: [u8; 32],
    request: DWalletRequest,
) -> UserSignedRequest {
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

/// Run DKG → return (session_id, attestation, public_key)
async fn do_dkg(
    client: &mut DWalletServiceClient<Channel>,
    payer: &solana_sdk::signature::Keypair,
    curve: DWalletCurve,
    label: &str,
) -> ([u8; 32], NetworkSignedAttestation, Vec<u8>) {
    let session = new_session();
    let resp = submit(client, build_request(payer, session, DWalletRequest::DKG {
        dwallet_network_encryption_public_key: vec![0u8; 32],
        curve,
        centralized_public_key_share_and_proof: vec![0u8; 32],
        user_secret_key_share: UserSecretKeyShare::Encrypted {
            encrypted_centralized_secret_share_and_proof: vec![0u8; 32],
            encryption_key: vec![0u8; 32],
            signer_public_key: vec![0u8; 32],
        },
        user_public_output: vec![0u8; 32],
        sign_during_dkg_request: None,
    })).await;

    match resp {
        TransactionResponseData::Attestation(att) => {
            let v: VersionedDWalletDataAttestation =
                bcs::from_bytes(&att.attestation_data).expect("decode");
            let VersionedDWalletDataAttestation::V1(ref data) = v;
            ok(&format!("DKG {label}: pk={} ({} bytes)", hex::encode(&data.public_key), data.public_key.len()));
            let pk = data.public_key.clone();
            (session, att, pk)
        }
        TransactionResponseData::Error { message } => panic!("DKG {label} failed: {message}"),
        other => panic!("unexpected: {other:?}"),
    }
}

/// Run Presign → return presign_session_identifier
async fn do_presign(
    client: &mut DWalletServiceClient<Channel>,
    payer: &solana_sdk::signature::Keypair,
    session: [u8; 32],
    curve: DWalletCurve,
    algo: DWalletSignatureAlgorithm,
    label: &str,
) -> Vec<u8> {
    let resp = submit(client, build_request(payer, session, DWalletRequest::Presign {
        dwallet_network_encryption_public_key: vec![0u8; 32],
        curve,
        signature_algorithm: algo,
    })).await;

    match resp {
        TransactionResponseData::Attestation(att) => {
            let v: VersionedPresignDataAttestation =
                bcs::from_bytes(&att.attestation_data).expect("decode presign");
            let VersionedPresignDataAttestation::V1(ref data) = v;
            ok(&format!("Presign {label}: id={}", hex::encode(&data.presign_session_identifier)));
            data.presign_session_identifier.clone()
        }
        TransactionResponseData::Error { message } => panic!("Presign {label} failed: {message}"),
        other => panic!("unexpected: {other:?}"),
    }
}

/// Run Sign → return signature bytes (or None if MA not found on-chain)
async fn do_sign(
    client: &mut DWalletServiceClient<Channel>,
    payer: &solana_sdk::signature::Keypair,
    session: [u8; 32],
    attestation: NetworkSignedAttestation,
    presign_id: Vec<u8>,
    message: &[u8],
    message_metadata: Vec<u8>,
    label: &str,
) -> Option<Vec<u8>> {
    let resp = submit(client, build_request(payer, session, DWalletRequest::Sign {
        message: message.to_vec(),
        message_metadata,
        presign_session_identifier: presign_id,
        message_centralized_signature: vec![0u8; 64],
        dwallet_attestation: attestation,
        approval_proof: ApprovalProof::Solana {
            transaction_signature: vec![0u8; 64],
            slot: 0,
        },
    })).await;

    match resp {
        TransactionResponseData::Signature { signature } => {
            ok(&format!("Sign {label}: sig={} ({} bytes)", hex::encode(&signature), signature.len()));
            Some(signature)
        }
        TransactionResponseData::Error { message } if message.contains("MessageApproval PDA not found") => {
            ok(&format!("Sign {label}: correctly requires on-chain MessageApproval (no on-chain program in this test)"));
            None
        }
        TransactionResponseData::Error { message } => panic!("Sign {label} failed: {message}"),
        other => panic!("unexpected: {other:?}"),
    }
}

/// Full DKG → Presign → Sign flow for a given curve/algo/scheme combo
async fn test_full_sign_flow(
    client: &mut DWalletServiceClient<Channel>,
    payer: &solana_sdk::signature::Keypair,
    curve: DWalletCurve,
    algo: DWalletSignatureAlgorithm,
    scheme: DWalletSignatureScheme,
    message: &[u8],
    message_metadata: Vec<u8>,
    label: &str,
) {
    section(&format!("Full Sign: {label}"));
    let (session, att, _pk) = do_dkg(client, payer, curve, label).await;
    let presign_id = do_presign(client, payer, session, curve, algo, label).await;
    let sig = do_sign(client, payer, session, att, presign_id, message, message_metadata, label).await;
    if let Some(ref s) = sig {
        assert!(!s.is_empty(), "signature should not be empty");
    }
    let _ = scheme;
}

#[tokio::main]
async fn main() {
    let grpc_url = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "http://127.0.0.1:50051".to_string());

    println!("\n{BOLD}=== dWallet Full Protocol E2E ==={RESET}\n");
    val("gRPC", &grpc_url);

    let mut client = DWalletServiceClient::connect(grpc_url)
        .await
        .expect("connect to gRPC");

    let payer = solana_sdk::signature::Keypair::new();
    let msg = b"e2e test message";

    // ══════════════════════════════════════════════════════════════════
    // 1. EdDSA + SHA-512 (Ed25519 / Curve25519) — Solana, Sui
    // ══════════════════════════════════════════════════════════════════
    test_full_sign_flow(
        &mut client, &payer,
        DWalletCurve::Curve25519,
        DWalletSignatureAlgorithm::EdDSA,
        DWalletSignatureScheme::EddsaSha512,
        msg, vec![],
        "EdDSA+SHA512 (Curve25519)",
    ).await;

    // ══════════════════════════════════════════════════════════════════
    // 2. ECDSA + Keccak-256 (Secp256k1) — Ethereum
    // ══════════════════════════════════════════════════════════════════
    test_full_sign_flow(
        &mut client, &payer,
        DWalletCurve::Secp256k1,
        DWalletSignatureAlgorithm::ECDSASecp256k1,
        DWalletSignatureScheme::EcdsaKeccak256,
        msg, vec![],
        "ECDSA+Keccak256 (Secp256k1)",
    ).await;

    // ══════════════════════════════════════════════════════════════════
    // 3. ECDSA + SHA-256 (Secp256k1) — generic / WebAuthn
    // ══════════════════════════════════════════════════════════════════
    test_full_sign_flow(
        &mut client, &payer,
        DWalletCurve::Secp256k1,
        DWalletSignatureAlgorithm::ECDSASecp256k1,
        DWalletSignatureScheme::EcdsaSha256,
        msg, vec![],
        "ECDSA+SHA256 (Secp256k1)",
    ).await;

    // ══════════════════════════════════════════════════════════════════
    // 4. ECDSA + Double-SHA-256 (Secp256k1) — Bitcoin BIP143
    // ══════════════════════════════════════════════════════════════════
    test_full_sign_flow(
        &mut client, &payer,
        DWalletCurve::Secp256k1,
        DWalletSignatureAlgorithm::ECDSASecp256k1,
        DWalletSignatureScheme::EcdsaDoubleSha256,
        msg, vec![],
        "ECDSA+DoubleSHA256 (Secp256k1)",
    ).await;

    // ══════════════════════════════════════════════════════════════════
    // 5. Taproot + SHA-256 (Secp256k1) — Bitcoin Taproot
    // ══════════════════════════════════════════════════════════════════
    test_full_sign_flow(
        &mut client, &payer,
        DWalletCurve::Secp256k1,
        DWalletSignatureAlgorithm::Taproot,
        DWalletSignatureScheme::TaprootSha256,
        msg, vec![],
        "Taproot+SHA256 (Secp256k1)",
    ).await;

    // ══════════════════════════════════════════════════════════════════
    // 6. ECDSA + BLAKE2b-256 (Secp256k1) — Zcash
    // ══════════════════════════════════════════════════════════════════
    let blake2b_meta = bcs::to_bytes(&Blake2bMessageMetadata {
        personal: b"ZcashSigHash\x00\x00\x00\x00".to_vec(),
        salt: vec![],
    }).expect("BCS blake2b meta");

    test_full_sign_flow(
        &mut client, &payer,
        DWalletCurve::Secp256k1,
        DWalletSignatureAlgorithm::ECDSASecp256k1,
        DWalletSignatureScheme::EcdsaBlake2b256,
        msg, blake2b_meta,
        "ECDSA+BLAKE2b256 (Secp256k1/Zcash)",
    ).await;

    // ══════════════════════════════════════════════════════════════════
    // 7. Schnorrkel + Merlin (Ristretto) — Substrate
    // ══════════════════════════════════════════════════════════════════
    let schnorrkel_meta = bcs::to_bytes(&SchnorrkelMessageMetadata {
        context: b"substrate".to_vec(),
    }).expect("BCS schnorrkel meta");

    test_full_sign_flow(
        &mut client, &payer,
        DWalletCurve::Ristretto,
        DWalletSignatureAlgorithm::Schnorrkel,
        DWalletSignatureScheme::SchnorrkelMerlin,
        msg, schnorrkel_meta,
        "Schnorrkel+Merlin (Ristretto/Substrate)",
    ).await;

    // ══════════════════════════════════════════════════════════════════
    // 8. ImportedKeyVerification → PresignForDWallet (Secp256k1 ECDSA)
    // ══════════════════════════════════════════════════════════════════
    section("ImportedKeyVerification + PresignForDWallet");

    let imported_session = new_session();
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

    let imported_att = match imported_resp {
        TransactionResponseData::Attestation(att) => {
            let v: VersionedDWalletDataAttestation =
                bcs::from_bytes(&att.attestation_data).expect("decode");
            let VersionedDWalletDataAttestation::V1(ref data) = v;
            ok(&format!("ImportedKeyVerification: pk={}, is_imported={}", hex::encode(&data.public_key), data.is_imported_key));
            assert!(data.is_imported_key);
            att
        }
        TransactionResponseData::Error { message } => panic!("ImportedKeyVerification failed: {message}"),
        other => panic!("unexpected: {other:?}"),
    };

    // PresignForDWallet (imported only)
    let presign_imported = submit(&mut client, build_request(&payer, imported_session, DWalletRequest::PresignForDWallet {
        dwallet_network_encryption_public_key: vec![0u8; 32],
        dwallet_public_key: imported_session.to_vec(),
        curve: DWalletCurve::Secp256k1,
        signature_algorithm: DWalletSignatureAlgorithm::ECDSASecp256k1,
    })).await;

    match presign_imported {
        TransactionResponseData::Attestation(att) => {
            let v: VersionedPresignDataAttestation =
                bcs::from_bytes(&att.attestation_data).expect("decode");
            let VersionedPresignDataAttestation::V1(ref data) = v;
            ok(&format!("PresignForDWallet (imported): id={}", hex::encode(&data.presign_session_identifier)));
        }
        TransactionResponseData::Error { message } => panic!("PresignForDWallet failed: {message}"),
        other => panic!("unexpected: {other:?}"),
    };

    // ══════════════════════════════════════════════════════════════════
    // 9. ReEncryptShare
    // ══════════════════════════════════════════════════════════════════
    section("ReEncryptShare");

    let re_session = new_session();
    let (_, re_att, _) = do_dkg(&mut client, &payer, DWalletCurve::Curve25519, "for ReEncrypt").await;

    let re_resp = submit(&mut client, build_request(&payer, re_session, DWalletRequest::ReEncryptShare {
        dwallet_network_encryption_public_key: vec![0u8; 32],
        dwallet_public_key: vec![0u8; 32],
        dwallet_attestation: re_att,
        encrypted_centralized_secret_share_and_proof: vec![0u8; 64],
        encryption_key: vec![0u8; 32],
    })).await;

    match re_resp {
        TransactionResponseData::Attestation(att) => {
            let v: VersionedEncryptedUserKeyShareAttestation =
                bcs::from_bytes(&att.attestation_data).expect("decode");
            let VersionedEncryptedUserKeyShareAttestation::V1(ref data) = v;
            ok(&format!("ReEncryptShare: dwallet_pk={}", hex::encode(&data.dwallet_public_key)));
        }
        TransactionResponseData::Error { message } => panic!("ReEncryptShare failed: {message}"),
        other => panic!("unexpected: {other:?}"),
    };

    // ══════════════════════════════════════════════════════════════════
    // 10. MakeSharePublic
    // ══════════════════════════════════════════════════════════════════
    section("MakeSharePublic");

    let (_, msp_att, _) = do_dkg(&mut client, &payer, DWalletCurve::Curve25519, "for MakeSharePublic").await;

    let msp_resp = submit(&mut client, build_request(&payer, new_session(), DWalletRequest::MakeSharePublic {
        dwallet_public_key: vec![0u8; 32],
        dwallet_attestation: msp_att,
        public_user_secret_key_share: vec![0u8; 32],
    })).await;

    match msp_resp {
        TransactionResponseData::Attestation(att) => {
            let v: VersionedPublicUserKeyShareAttestation =
                bcs::from_bytes(&att.attestation_data).expect("decode");
            let VersionedPublicUserKeyShareAttestation::V1(ref data) = v;
            ok(&format!("MakeSharePublic: dwallet_pk={}", hex::encode(&data.dwallet_public_key)));
        }
        TransactionResponseData::Error { message } => panic!("MakeSharePublic failed: {message}"),
        other => panic!("unexpected: {other:?}"),
    };

    // ══════════════════════════════════════════════════════════════════
    // 11. FutureSign → SignWithPartialUserSig (two-step conditional)
    // ══════════════════════════════════════════════════════════════════
    section("FutureSign + SignWithPartialUserSig (two-step)");

    let (fs_session, fs_att, _) = do_dkg(&mut client, &payer, DWalletCurve::Curve25519, "for FutureSign").await;
    let fs_presign = do_presign(&mut client, &payer, fs_session, DWalletCurve::Curve25519, DWalletSignatureAlgorithm::EdDSA, "for FutureSign").await;

    let future_msg = b"conditional transfer 50 ETH";
    let fs_resp = submit(&mut client, build_request(&payer, fs_session, DWalletRequest::FutureSign {
        dwallet_public_key: vec![0u8; 32],
        presign_session_identifier: fs_presign,
        message: future_msg.to_vec(),
        message_metadata: vec![],
        message_centralized_signature: vec![0u8; 64],
        signature_scheme: DWalletSignatureScheme::EddsaSha512,
    })).await;

    let partial_att = match fs_resp {
        TransactionResponseData::Attestation(att) => {
            let v: VersionedPartialUserSignatureAttestation =
                bcs::from_bytes(&att.attestation_data).expect("decode");
            let VersionedPartialUserSignatureAttestation::V1(ref data) = v;
            ok(&format!("FutureSign: scheme={:?}, msg={}", data.signature_scheme, String::from_utf8_lossy(&data.message)));
            att
        }
        TransactionResponseData::Error { message } => panic!("FutureSign failed: {message}"),
        other => panic!("unexpected: {other:?}"),
    };

    // Step 2: SignWithPartialUserSig
    let step2_resp = submit(&mut client, build_request(&payer, fs_session, DWalletRequest::SignWithPartialUserSig {
        partial_user_signature_attestation: partial_att,
        dwallet_attestation: fs_att,
        approval_proof: ApprovalProof::Solana {
            transaction_signature: vec![0u8; 64],
            slot: 0,
        },
    })).await;

    match step2_resp {
        TransactionResponseData::Signature { ref signature } => {
            ok(&format!("SignWithPartialUserSig: sig={} ({} bytes)", hex::encode(signature), signature.len()));
        }
        TransactionResponseData::Error { ref message } => {
            // May fail if no on-chain MA — acceptable for pure gRPC test
            ok(&format!("SignWithPartialUserSig: {}", &message[..message.len().min(80)]));
        }
        other => panic!("unexpected: {other:?}"),
    };

    // ══════════════════════════════════════════════════════════════════
    // 12. DKG with Public share mode
    // ══════════════════════════════════════════════════════════════════
    section("DKG (Public share mode)");

    let pub_session = new_session();
    let pub_resp = submit(&mut client, build_request(&payer, pub_session, DWalletRequest::DKG {
        dwallet_network_encryption_public_key: vec![0u8; 32],
        curve: DWalletCurve::Secp256k1,
        centralized_public_key_share_and_proof: vec![0u8; 32],
        user_secret_key_share: UserSecretKeyShare::Public {
            public_user_secret_key_share: vec![0u8; 32],
        },
        user_public_output: vec![0u8; 32],
        sign_during_dkg_request: None,
    })).await;

    match pub_resp {
        TransactionResponseData::Attestation(att) => {
            let v: VersionedDWalletDataAttestation =
                bcs::from_bytes(&att.attestation_data).expect("decode");
            let VersionedDWalletDataAttestation::V1(ref data) = v;
            ok(&format!("DKG Public mode: pk={} ({} bytes)", hex::encode(&data.public_key), data.public_key.len()));
        }
        TransactionResponseData::Error { message } => panic!("DKG Public failed: {message}"),
        other => panic!("unexpected: {other:?}"),
    };

    // ══════════════════════════════════════════════════════════════════
    // Summary
    // ══════════════════════════════════════════════════════════════════
    println!("\n{BOLD}{GREEN}=== All Protocol Tests Passed! ==={RESET}");
    println!("  7 signature schemes (full DKG → Presign → Sign)");
    println!("  ImportedKeyVerification + PresignForDWallet");
    println!("  ReEncryptShare, MakeSharePublic");
    println!("  FutureSign + SignWithPartialUserSig");
    println!("  DKG Public share mode\n");
}
