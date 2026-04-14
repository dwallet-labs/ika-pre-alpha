// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! dWallet Multisig E2E Demo
//!
//! Runs the full on-chain multisig flow against Solana devnet and
//! the pre-alpha dWallet gRPC service, using gRPC for all dWallet operations.
//!
//! 1. gRPC DKG request -> creates dWallet keypair + returns attestation
//! 2. CommitDWallet on-chain using attestation data
//! 3. Transfer dWallet authority to multisig CPI PDA
//! 4. Create 2-of-3 multisig
//! 5. Propose a transaction with message data on-chain
//! 6. Member1 approves (1/2)
//! 7. Member2 approves (2/2 = quorum) -> triggers approve_message CPI
//! 8. Event loop auto-detects MessageApproval and commits signature
//! 9. Poll until signature appears on-chain
//! 10. Test rejection flow
//!
//! Usage: cargo run -- <DWALLET_ID> <MULTISIG_ID>
//!
//! Environment variables:
//!   RPC_URL  — Solana RPC (default: https://api.devnet.solana.com)
//!   GRPC_URL — dWallet gRPC (default: https://pre-alpha-dev-1.ika.ika-network.net:443)

use std::env;
use std::str::FromStr;
use std::thread;
use std::time::{Duration, Instant};

use solana_rpc_client::rpc_client::RpcClient;
use solana_sdk::commitment_config::CommitmentConfig;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;
#[allow(deprecated)]
use solana_sdk::system_program;
use solana_sdk::transaction::Transaction;

use ika_dwallet_types::*;
use ika_grpc::UserSignedRequest;
use ika_grpc::d_wallet_service_client::DWalletServiceClient;

// ======================================================================
// ANSI colors
// ======================================================================

const BOLD: &str = "\x1b[1m";
const RESET: &str = "\x1b[0m";
const CYAN: &str = "\x1b[36m";
const GREEN: &str = "\x1b[32m";
const YELLOW: &str = "\x1b[33m";

fn log(step: &str, msg: &str) {
    println!("{CYAN}[{step}]{RESET} {msg}");
}
fn ok(msg: &str) {
    println!("{GREEN}  \u{2713}{RESET} {msg}");
}
fn val(label: &str, v: impl std::fmt::Display) {
    println!("{YELLOW}  \u{2192}{RESET} {label}: {v}");
}

// ======================================================================
// dWallet program constants
// ======================================================================

const IX_TRANSFER_OWNERSHIP: u8 = 24;

const DISC_COORDINATOR: u8 = 1;
const DISC_NEK: u8 = 3;
const DISC_MESSAGE_APPROVAL: u8 = 14;

const COORDINATOR_LEN: usize = 116;
const NEK_LEN: usize = 164;

const MA_STATUS: usize = 172;
const MA_SIGNATURE_LEN: usize = 173;
const MA_SIGNATURE: usize = 175;
const MA_STATUS_SIGNED: u8 = 1;

const SEED_DWALLET_COORDINATOR: &[u8] = b"dwallet_coordinator";
const SEED_NETWORK_ENCRYPTION_KEY: &[u8] = b"network_encryption_key";
const SEED_DWALLET: &[u8] = b"dwallet";
const SEED_MESSAGE_APPROVAL: &[u8] = b"message_approval";
const SEED_CPI_AUTHORITY: &[u8] = b"__ika_cpi_authority";

const CURVE_CURVE25519: u16 = 2;

// Multisig program constants
const TX_APPROVAL_COUNT: usize = 136;
const TX_STATUS: usize = 140;
const TX_MESSAGE_DATA_LEN: usize = 175;
const TX_MESSAGE_DATA: usize = 177;

// ======================================================================
// Helpers
// ======================================================================

fn load_payer() -> Keypair {
    let path = env::var("PAYER_KEYPAIR").unwrap_or_else(|_| {
        format!(
            "{}/.config/solana/devnet-admin.json",
            env::var("HOME").unwrap_or_default()
        )
    });
    let data =
        std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("Cannot read keypair at {path}"));
    let bytes: Vec<u8> = {
        let s = data.trim();
        s[1..s.len() - 1]
            .split(',')
            .map(|v| v.trim().parse::<u8>().unwrap())
            .collect()
    };
    #[allow(deprecated)]
    Keypair::from_bytes(&bytes).expect("valid keypair")
}

fn fund_keypair(client: &RpcClient, payer: &Keypair, lamports: u64) -> Keypair {
    let kp = Keypair::new();
    let ix = solana_sdk::system_instruction::transfer(&payer.pubkey(), &kp.pubkey(), lamports);
    send_tx(client, payer, vec![ix], &[]);
    kp
}

/// Send a transaction and return its signature.
fn send_tx(
    client: &RpcClient,
    payer: &Keypair,
    ixs: Vec<Instruction>,
    extra: &[&Keypair],
) -> solana_sdk::signature::Signature {
    let blockhash = client.get_latest_blockhash().expect("blockhash");
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra);
    let tx = Transaction::new_signed_with_payer(&ixs, Some(&payer.pubkey()), &signers, blockhash);
    client
        .send_and_confirm_transaction(&tx)
        .expect("send_and_confirm")
}

fn poll_until(
    client: &RpcClient,
    account: &Pubkey,
    check: impl Fn(&[u8]) -> bool,
    timeout: Duration,
) -> Vec<u8> {
    let start = Instant::now();
    loop {
        if start.elapsed() > timeout {
            panic!("timeout waiting for account {account}");
        }
        if let Ok(acct) = client.get_account(account) {
            if check(&acct.data) {
                return acct.data;
            }
        }
        thread::sleep(Duration::from_millis(500));
    }
}

fn read_u16_le(data: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(data[offset..offset + 2].try_into().unwrap())
}

fn simple_keccak256(data: &[u8]) -> [u8; 32] {
    solana_sdk::keccak::hash(data).to_bytes()
}

/// Build a dummy BCS-serialized gRPC request for DKG.
fn build_dkg_grpc_request(user_keypair: &Keypair, curve: DWalletCurve) -> UserSignedRequest {
    let request = SignedRequestData {
        session_identifier_preimage: user_keypair.pubkey().to_bytes(),
        epoch: 1,
        chain_id: ChainId::Solana,
        intended_chain_sender: user_keypair.pubkey().to_bytes().to_vec(),
        request: DWalletRequest::DKG {
            dwallet_network_encryption_public_key: vec![0u8; 32],
            curve,
            centralized_public_key_share_and_proof: vec![0u8; 32],
            user_secret_key_share: UserSecretKeyShare::Encrypted {
                encrypted_centralized_secret_share_and_proof: vec![0u8; 32],
                encryption_key: vec![0u8; 32],
                signer_public_key: user_keypair.pubkey().to_bytes().to_vec(),
            },
            user_public_output: vec![0u8; 32],
            sign_during_dkg_request: None,
        },
    };

    let signed_data = bcs::to_bytes(&request).expect("BCS serialize request");

    // Mock signature (mock skips verification).
    let user_sig = UserSignature::Ed25519 {
        signature: vec![0u8; 64],
        public_key: user_keypair.pubkey().to_bytes().to_vec(),
    };
    let user_sig_bytes = bcs::to_bytes(&user_sig).expect("BCS serialize sig");

    UserSignedRequest {
        user_signature: user_sig_bytes,
        signed_request_data: signed_data,
    }
}

// ======================================================================
// Main
// ======================================================================

#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 {
        eprintln!("Usage: e2e-multisig <DWALLET_PROGRAM_ID> <MULTISIG_PROGRAM_ID>");
        eprintln!();
        eprintln!("Defaults to Solana devnet and pre-alpha gRPC. Override with:");
        eprintln!(
            "  RPC_URL=<solana_rpc> GRPC_URL=<grpc_url> cargo run -- <DWALLET_ID> <MULTISIG_ID>"
        );
        std::process::exit(1);
    }

    let dwallet_program_id = Pubkey::from_str(&args[1]).expect("invalid dWallet program ID");
    let multisig_program_id = Pubkey::from_str(&args[2]).expect("invalid multisig program ID");
    let grpc_url = env::var("GRPC_URL")
        .unwrap_or_else(|_| "https://pre-alpha-dev-1.ika.ika-network.net:443".to_string());

    let client = RpcClient::new_with_commitment(
        env::var("RPC_URL").unwrap_or_else(|_| "https://api.devnet.solana.com".to_string()),
        CommitmentConfig::confirmed(),
    );

    println!();
    println!(
        "{BOLD}\u{2550}\u{2550}\u{2550} dWallet Multisig E2E Demo \u{2550}\u{2550}\u{2550}{RESET}"
    );
    println!();
    val("dWallet program", dwallet_program_id);
    val("Multisig program", multisig_program_id);
    val("gRPC endpoint", &grpc_url);
    println!();

    // -- Setup --
    log("Setup", "Funding payer...");
    let payer = load_payer();
    let balance = client.get_balance(&payer.pubkey()).unwrap_or(0);
    ok(&format!(
        "Payer: {} ({:.3} SOL)",
        payer.pubkey(),
        balance as f64 / 1e9
    ));

    log("Setup", "Waiting for mock to initialize program state...");

    let (coordinator_pda, _) =
        Pubkey::find_program_address(&[SEED_DWALLET_COORDINATOR], &dwallet_program_id);
    poll_until(
        &client,
        &coordinator_pda,
        |d| d.len() >= COORDINATOR_LEN && d[0] == DISC_COORDINATOR,
        Duration::from_secs(30),
    );
    ok(&format!("DWalletCoordinator: {coordinator_pda}"));

    // Find the NetworkEncryptionKey (disc=3) via getProgramAccounts.
    use solana_sdk::account::Account;
    let nek_accounts: Vec<(Pubkey, Account)> = {
        let start = Instant::now();
        loop {
            let accs = client
                .get_program_accounts(&dwallet_program_id)
                .unwrap_or_default();
            let neks: Vec<_> = accs
                .into_iter()
                .filter(|(_, a)| a.data.len() >= NEK_LEN && a.data[0] == DISC_NEK)
                .collect();
            if !neks.is_empty() {
                break neks;
            }
            if start.elapsed() > Duration::from_secs(30) {
                panic!("timeout waiting for NEK account");
            }
            thread::sleep(Duration::from_millis(500));
        }
    };
    let (nek_pda, nek_data) = &nek_accounts[0];
    // NEK layout: disc(1) + version(1) + noa_public_key(32 @ offset 2)
    let noa_pubkey = Pubkey::new_from_array(nek_data.data[2..34].try_into().unwrap());
    ok(&format!("NetworkEncryptionKey: {nek_pda}"));
    val("NOA (from NEK)", noa_pubkey);
    println!();

    // ===================================================================
    // Step 1: Create dWallet via gRPC DKG
    // ===================================================================

    log(
        "1/9",
        "Requesting DKG via gRPC (mock commits + transfers on-chain)...",
    );

    let mut grpc_client = if grpc_url.starts_with("https") {
        let tls = tonic::transport::ClientTlsConfig::new().with_native_roots();
        let channel = tonic::transport::Channel::from_shared(grpc_url.clone())
            .expect("valid URL")
            .tls_config(tls)
            .expect("tls")
            .connect()
            .await
            .expect("connect to gRPC");
        DWalletServiceClient::new(channel)
    } else {
        DWalletServiceClient::connect(grpc_url.clone())
            .await
            .expect("connect to gRPC")
    };

    let dkg_request = build_dkg_grpc_request(&payer, DWalletCurve::Curve25519);
    let response = grpc_client
        .submit_transaction(dkg_request)
        .await
        .expect("gRPC DKG request");

    let response_data: TransactionResponseData =
        bcs::from_bytes(&response.into_inner().response_data).expect("BCS deserialize");

    let attestation = match response_data {
        TransactionResponseData::Attestation(att) => {
            ok("DKG attestation received");
            att
        }
        TransactionResponseData::Error { message } => panic!("gRPC DKG failed: {message}"),
        other => panic!("unexpected gRPC response: {other:?}"),
    };

    // BCS-decode the versioned DWallet data attestation from the signed bytes.
    let versioned: VersionedDWalletDataAttestation =
        bcs::from_bytes(&attestation.attestation_data).expect("decode attestation");
    let VersionedDWalletDataAttestation::V1(data) = versioned;
    let public_key = data.public_key;

    // The mock stores the signing key under the session_identifier from the
    // DKG request. Use it as the session_identifier_preimage for subsequent
    // Presign/Sign requests so the mock can look up the key.
    let dwallet_addr: [u8; 32] = data.session_identifier;

    val("dWallet address", hex::encode(dwallet_addr));
    val("Public key", hex::encode(&public_key));

    // Poll for dWallet PDA on-chain (mock committed + transferred authority to payer).
    //
    // PDA seeds = ["dwallet", chunks_of(curve || pubkey)] where the
    // `curve || pubkey` payload is split into 32-byte chunks (Solana's
    // `MAX_SEED_LEN`). Mirrors the on-chain `DWalletPdaSeeds::new`.
    let curve = CURVE_CURVE25519;
    let payload = pack_dwallet_seed_payload(curve, &public_key);
    let mut seeds: Vec<&[u8]> = Vec::with_capacity(4);
    seeds.push(SEED_DWALLET);
    for chunk in payload.chunks(32) {
        seeds.push(chunk);
    }
    let (dwallet_pda, _) = Pubkey::find_program_address(&seeds, &dwallet_program_id);

    poll_until(
        &client,
        &dwallet_pda,
        |d| d.len() > 2 && d[0] == 2, // disc=2 = DWallet
        Duration::from_secs(15),
    );
    ok(&format!("dWallet on-chain: {dwallet_pda}"));

    // ===================================================================
    // Step 2: Transfer dWallet authority to multisig CPI PDA
    // ===================================================================

    log(
        "2/9",
        "Transferring dWallet authority to multisig program...",
    );

    let (cpi_authority, cpi_authority_bump) =
        Pubkey::find_program_address(&[SEED_CPI_AUTHORITY], &multisig_program_id);

    let mut transfer_data = Vec::with_capacity(33);
    transfer_data.push(IX_TRANSFER_OWNERSHIP);
    transfer_data.extend_from_slice(cpi_authority.as_ref());

    send_tx(
        &client,
        &payer,
        vec![Instruction::new_with_bytes(
            dwallet_program_id,
            &transfer_data,
            vec![
                AccountMeta::new_readonly(payer.pubkey(), true),
                AccountMeta::new(dwallet_pda, false),
            ],
        )],
        &[],
    );
    ok(&format!(
        "Authority transferred to CPI PDA: {cpi_authority}"
    ));

    // ===================================================================
    // Step 3: Create 2-of-3 multisig
    // ===================================================================

    log("3/9", "Creating 2-of-3 multisig...");

    let member1 = fund_keypair(&client, &payer, 100_000_000);
    let member2 = fund_keypair(&client, &payer, 100_000_000);
    let member3 = fund_keypair(&client, &payer, 100_000_000);

    let create_key: [u8; 32] = Keypair::new().pubkey().to_bytes();
    let (multisig_pda, multisig_bump) =
        Pubkey::find_program_address(&[b"multisig", &create_key], &multisig_program_id);

    let mut ms_data = vec![0u8]; // disc=0
    ms_data.extend_from_slice(&create_key);
    ms_data.extend_from_slice(dwallet_pda.as_ref());
    ms_data.extend_from_slice(&2u16.to_le_bytes());
    ms_data.extend_from_slice(&3u16.to_le_bytes());
    ms_data.push(multisig_bump);
    ms_data.extend_from_slice(member1.pubkey().as_ref());
    ms_data.extend_from_slice(member2.pubkey().as_ref());
    ms_data.extend_from_slice(member3.pubkey().as_ref());

    send_tx(
        &client,
        &payer,
        vec![Instruction::new_with_bytes(
            multisig_program_id,
            &ms_data,
            vec![
                AccountMeta::new(multisig_pda, false),
                AccountMeta::new_readonly(payer.pubkey(), true),
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new_readonly(system_program::id(), false),
            ],
        )],
        &[],
    );
    ok(&format!("Multisig: {multisig_pda}"));
    val("Threshold", "2-of-3");

    // ===================================================================
    // Step 5: Propose a transaction
    // ===================================================================

    log("4/9", "Proposing transaction...");

    let message = b"Transfer 100 USDC to treasury";
    let message_hash = simple_keccak256(message);
    let user_pubkey = [0xCCu8; 32];
    let tx_index: u32 = 0;

    // MessageApproval PDA uses hierarchical seeds:
    // ["dwallet", chunks(curve_u16_le || pk), "message_approval", &scheme_u16_le, &message_digest]
    let scheme_u16: u16 = 5; // EddsaSha512 — matches Curve25519 DKG
    let scheme_bytes = scheme_u16.to_le_bytes();
    let ma_payload = pack_dwallet_seed_payload(curve, &public_key);
    let mut ma_seeds: Vec<&[u8]> = vec![b"dwallet"];
    for chunk in ma_payload.chunks(32) {
        ma_seeds.push(chunk);
    }
    ma_seeds.push(SEED_MESSAGE_APPROVAL);
    ma_seeds.push(&scheme_bytes);
    ma_seeds.push(&message_hash);
    let (message_approval_pda, message_approval_bump) =
        Pubkey::find_program_address(&ma_seeds, &dwallet_program_id);

    let (tx_pda, tx_bump) = Pubkey::find_program_address(
        &[
            b"transaction",
            multisig_pda.as_ref(),
            &tx_index.to_le_bytes(),
        ],
        &multisig_program_id,
    );

    let mut create_tx = vec![1u8];
    create_tx.extend_from_slice(&message_hash);
    create_tx.extend_from_slice(&user_pubkey);
    create_tx.extend_from_slice(&scheme_u16.to_le_bytes()); // signature_scheme (u16)
    create_tx.push(message_approval_bump);
    create_tx.extend_from_slice(&[0u8; 32]); // no partial_user_sig
    create_tx.push(tx_bump);
    create_tx.extend_from_slice(&(message.len() as u16).to_le_bytes());
    create_tx.extend_from_slice(message);

    send_tx(
        &client,
        &payer,
        vec![Instruction::new_with_bytes(
            multisig_program_id,
            &create_tx,
            vec![
                AccountMeta::new(multisig_pda, false),
                AccountMeta::new(tx_pda, false),
                AccountMeta::new_readonly(member1.pubkey(), true),
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new_readonly(system_program::id(), false),
            ],
        )],
        &[&member1],
    );
    ok(&format!("Transaction: {tx_pda}"));
    val("Message", String::from_utf8_lossy(message));

    // Verify on-chain message data.
    let stored = client.get_account(&tx_pda).unwrap().data;
    let len = read_u16_le(&stored, TX_MESSAGE_DATA_LEN) as usize;
    assert_eq!(&stored[TX_MESSAGE_DATA..TX_MESSAGE_DATA + len], message);
    ok("Message data readable on-chain");

    // ===================================================================
    // Step 6: Member1 approves (1/2)
    // ===================================================================

    log("5/9", "Member1 approves (1/2)...");

    let (ar1_pda, ar1_bump) = Pubkey::find_program_address(
        &[b"approval", tx_pda.as_ref(), member1.pubkey().as_ref()],
        &multisig_program_id,
    );

    let mut approve1 = vec![2u8];
    approve1.extend_from_slice(&tx_index.to_le_bytes());
    approve1.push(ar1_bump);
    approve1.push(cpi_authority_bump);

    send_tx(
        &client,
        &payer,
        vec![Instruction::new_with_bytes(
            multisig_program_id,
            &approve1,
            vec![
                AccountMeta::new_readonly(multisig_pda, false),
                AccountMeta::new(tx_pda, false),
                AccountMeta::new(ar1_pda, false),
                AccountMeta::new_readonly(member1.pubkey(), true),
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new_readonly(system_program::id(), false),
            ],
        )],
        &[&member1],
    );
    ok("Member1 approved");

    // ===================================================================
    // Step 7: Member2 approves (2/2 = quorum, triggers CPI)
    // ===================================================================

    log("6/9", "Member2 approves (2/2 = quorum)...");

    let (ar2_pda, ar2_bump) = Pubkey::find_program_address(
        &[b"approval", tx_pda.as_ref(), member2.pubkey().as_ref()],
        &multisig_program_id,
    );

    let mut approve2 = vec![2u8];
    approve2.extend_from_slice(&tx_index.to_le_bytes());
    approve2.push(ar2_bump);
    approve2.push(cpi_authority_bump);

    let quorum_tx_sig = send_tx(
        &client,
        &payer,
        vec![Instruction::new_with_bytes(
            multisig_program_id,
            &approve2,
            vec![
                AccountMeta::new_readonly(multisig_pda, false),
                AccountMeta::new(tx_pda, false),
                AccountMeta::new(ar2_pda, false),
                AccountMeta::new_readonly(member2.pubkey(), true),
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new_readonly(system_program::id(), false),
                // CPI accounts for approve_message:
                AccountMeta::new_readonly(coordinator_pda, false),
                AccountMeta::new(message_approval_pda, false),
                AccountMeta::new_readonly(dwallet_pda, false),
                AccountMeta::new_readonly(multisig_program_id, false),
                AccountMeta::new_readonly(cpi_authority, false),
                AccountMeta::new_readonly(dwallet_program_id, false),
            ],
        )],
        &[&member2],
    );
    ok("Quorum reached! approve_message CPI executed.");
    val("Tx signature", quorum_tx_sig);

    let tx_data = client.get_account(&tx_pda).unwrap().data;
    assert_eq!(tx_data[TX_STATUS], 1); // Approved
    ok("Transaction status: Approved");

    // ===================================================================
    // Step 8: Verify MessageApproval on-chain
    // ===================================================================

    log("7/9", "Verifying MessageApproval on-chain...");

    let ma_data = poll_until(
        &client,
        &message_approval_pda,
        |d| d.len() > MA_STATUS && d[0] == DISC_MESSAGE_APPROVAL,
        Duration::from_secs(10),
    );
    ok(&format!("MessageApproval created: {message_approval_pda}"));
    assert_eq!(ma_data[MA_STATUS], 0); // Pending
    val("Status", "Pending");

    // ===================================================================
    // Step 9: Allocate presign via gRPC
    // ===================================================================

    log("8/9", "Allocating presign via gRPC...");

    let presign_request = {
        let request = SignedRequestData {
            session_identifier_preimage: dwallet_addr,
            epoch: 1,
            chain_id: ChainId::Solana,
            intended_chain_sender: payer.pubkey().to_bytes().to_vec(),
            request: DWalletRequest::Presign {
                dwallet_network_encryption_public_key: vec![0u8; 32],
                curve: DWalletCurve::Curve25519,
                signature_algorithm: DWalletSignatureAlgorithm::EdDSA,
            },
        };
        let signed_data = bcs::to_bytes(&request).expect("BCS serialize");
        let user_sig = UserSignature::Ed25519 {
            signature: vec![0u8; 64],
            public_key: payer.pubkey().to_bytes().to_vec(),
        };
        UserSignedRequest {
            user_signature: bcs::to_bytes(&user_sig).expect("BCS serialize sig"),
            signed_request_data: signed_data,
        }
    };

    let presign_response = grpc_client
        .submit_transaction(presign_request)
        .await
        .expect("gRPC Presign request");

    let presign_response_data: TransactionResponseData =
        bcs::from_bytes(&presign_response.into_inner().response_data)
            .expect("BCS deserialize presign response");

    let presign_id = match presign_response_data {
        TransactionResponseData::Attestation(att) => {
            let versioned: VersionedPresignDataAttestation =
                bcs::from_bytes(&att.attestation_data).expect("decode presign attestation");
            let VersionedPresignDataAttestation::V1(data) = versioned;
            ok("Presign allocated!");
            val("Presign ID", hex::encode(&data.presign_session_identifier));
            data.presign_session_identifier
        }
        TransactionResponseData::Error { message } => {
            panic!("gRPC Presign failed: {message}");
        }
        other => {
            panic!("unexpected presign response: {other:?}");
        }
    };

    // ===================================================================
    // Step 10: Send gRPC Sign request with ApprovalProof + presign
    // ===================================================================

    log("9/9", "Sending Sign request via gRPC...");

    // Use slot 0 for the mock (it skips verification).
    let quorum_slot: u64 = 0;

    // Send Sign request via gRPC. session_identifier_preimage must be the
    // dWallet address so the network can look up the signing key.
    let sign_request = {
        let request = SignedRequestData {
            session_identifier_preimage: dwallet_addr,
            epoch: 1,
            chain_id: ChainId::Solana,
            intended_chain_sender: payer.pubkey().to_bytes().to_vec(),
            request: DWalletRequest::Sign {
                message: message.to_vec(),
                message_metadata: vec![],
                presign_session_identifier: presign_id,
                message_centralized_signature: vec![0u8; 64],
                dwallet_attestation: attestation.clone(),
                approval_proof: ApprovalProof::Solana {
                    transaction_signature: quorum_tx_sig.as_ref().to_vec(),
                    slot: quorum_slot,
                },
            },
        };
        let signed_data = bcs::to_bytes(&request).expect("BCS serialize");
        let user_sig = UserSignature::Ed25519 {
            signature: vec![0u8; 64],
            public_key: payer.pubkey().to_bytes().to_vec(),
        };
        UserSignedRequest {
            user_signature: bcs::to_bytes(&user_sig).expect("BCS serialize sig"),
            signed_request_data: signed_data,
        }
    };

    let sign_response = grpc_client
        .submit_transaction(sign_request)
        .await
        .expect("gRPC Sign request");

    let sign_response_data: TransactionResponseData =
        bcs::from_bytes(&sign_response.into_inner().response_data)
            .expect("BCS deserialize sign response");

    let grpc_signature = match sign_response_data {
        TransactionResponseData::Signature { signature } => {
            ok("Signature received from gRPC!");
            val("Signature length", signature.len());
            val("Signature", hex::encode(&signature));
            signature
        }
        TransactionResponseData::Error { message } => {
            panic!("gRPC Sign failed: {message}");
        }
        other => {
            panic!("Unexpected sign response: {other:?}");
        }
    };

    // ===================================================================
    // Step 10: Verify signature committed on-chain
    // ===================================================================

    log("10/10", "Verifying signature on-chain...");

    let ma_signed = poll_until(
        &client,
        &message_approval_pda,
        |d| d.len() > MA_STATUS && d[MA_STATUS] == MA_STATUS_SIGNED,
        Duration::from_secs(15),
    );

    let onchain_sig_len = read_u16_le(&ma_signed, MA_SIGNATURE_LEN) as usize;
    let onchain_signature = &ma_signed[MA_SIGNATURE..MA_SIGNATURE + onchain_sig_len];

    assert_eq!(onchain_sig_len, 64, "on-chain signature should be 64 bytes");
    assert_eq!(
        onchain_signature,
        grpc_signature.as_slice(),
        "on-chain signature must match gRPC signature"
    );
    ok("Signature committed on-chain!");
    val("On-chain sig", hex::encode(onchain_signature));
    val("Status", "Signed (1)");
    val("dWallet", dwallet_pda);

    // ===================================================================
    // Step BONUS: Test rejection flow
    // ===================================================================

    log("BONUS", "Testing rejection flow...");

    let message2 = b"Bad tx - reject this";
    let message_hash2 = simple_keccak256(message2);
    let tx_index2: u32 = 1;

    let (tx_pda2, tx_bump2) = Pubkey::find_program_address(
        &[
            b"transaction",
            multisig_pda.as_ref(),
            &tx_index2.to_le_bytes(),
        ],
        &multisig_program_id,
    );
    let (_, ma_bump2) = Pubkey::find_program_address(
        &[SEED_MESSAGE_APPROVAL, dwallet_pda.as_ref(), &message_hash2],
        &dwallet_program_id,
    );

    let mut create_tx2 = vec![1u8];
    create_tx2.extend_from_slice(&message_hash2);
    create_tx2.extend_from_slice(&user_pubkey);
    create_tx2.extend_from_slice(&scheme_u16.to_le_bytes()); // signature_scheme (u16)
    create_tx2.push(ma_bump2);
    create_tx2.extend_from_slice(&[0u8; 32]);
    create_tx2.push(tx_bump2);
    create_tx2.extend_from_slice(&(message2.len() as u16).to_le_bytes());
    create_tx2.extend_from_slice(message2);

    send_tx(
        &client,
        &payer,
        vec![Instruction::new_with_bytes(
            multisig_program_id,
            &create_tx2,
            vec![
                AccountMeta::new(multisig_pda, false),
                AccountMeta::new(tx_pda2, false),
                AccountMeta::new_readonly(member1.pubkey(), true),
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new_readonly(system_program::id(), false),
            ],
        )],
        &[&member1],
    );
    ok(&format!("Transaction 2: {tx_pda2}"));

    // Member2 rejects.
    let (ar2r, ar2r_bump) = Pubkey::find_program_address(
        &[b"approval", tx_pda2.as_ref(), member2.pubkey().as_ref()],
        &multisig_program_id,
    );
    let mut rej2 = vec![3u8];
    rej2.extend_from_slice(&tx_index2.to_le_bytes());
    rej2.push(ar2r_bump);

    send_tx(
        &client,
        &payer,
        vec![Instruction::new_with_bytes(
            multisig_program_id,
            &rej2,
            vec![
                AccountMeta::new_readonly(multisig_pda, false),
                AccountMeta::new(tx_pda2, false),
                AccountMeta::new(ar2r, false),
                AccountMeta::new_readonly(member2.pubkey(), true),
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new_readonly(system_program::id(), false),
            ],
        )],
        &[&member2],
    );
    ok("Member2 rejected");

    // Member3 rejects (2 rejections = threshold for 2-of-3).
    let (ar3r, ar3r_bump) = Pubkey::find_program_address(
        &[b"approval", tx_pda2.as_ref(), member3.pubkey().as_ref()],
        &multisig_program_id,
    );
    let mut rej3 = vec![3u8];
    rej3.extend_from_slice(&tx_index2.to_le_bytes());
    rej3.push(ar3r_bump);

    send_tx(
        &client,
        &payer,
        vec![Instruction::new_with_bytes(
            multisig_program_id,
            &rej3,
            vec![
                AccountMeta::new_readonly(multisig_pda, false),
                AccountMeta::new(tx_pda2, false),
                AccountMeta::new(ar3r, false),
                AccountMeta::new_readonly(member3.pubkey(), true),
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new_readonly(system_program::id(), false),
            ],
        )],
        &[&member3],
    );

    let tx2_data = client.get_account(&tx_pda2).unwrap().data;
    assert_eq!(tx2_data[TX_STATUS], 2); // Rejected
    ok("Transaction 2 rejected!");

    println!();
    println!(
        "{BOLD}{GREEN}\u{2550}\u{2550}\u{2550} E2E Test Passed! \u{2550}\u{2550}\u{2550}{RESET}"
    );
    println!();
}

/// Pack `curve || public_key` into a single buffer for dWallet PDA seeds.
///
/// Mirrors `ika_dwallet_program::state::dwallet::DWalletPdaSeeds::new`:
/// callers split the returned buffer into 32-byte chunks and pass each
/// chunk as a separate seed to `find_program_address`.
fn pack_dwallet_seed_payload(curve: u16, public_key: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(2 + public_key.len());
    buf.extend_from_slice(&curve.to_le_bytes());
    buf.extend_from_slice(public_key);
    buf
}
