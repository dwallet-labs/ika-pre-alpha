// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! dWallet Voting E2E Demo
//!
//! Runs the full on-chain voting flow against Solana devnet and
//! the pre-alpha dWallet gRPC service, using gRPC for DKG and signing.
//!
//! 1. gRPC DKG -> create dWallet keypair
//! 2. CommitDWallet on-chain using attestation
//! 3. Transfer dWallet authority to voting program CPI PDA
//! 4. Create a voting proposal (quorum=3)
//! 5. Cast 3 yes votes (last triggers approve_message CPI)
//! 6. Verify MessageApproval on-chain
//! 7. Allocate presign via gRPC
//! 8. Sign via gRPC with presign + ApprovalProof
//!
//! Usage: cargo run -- <DWALLET_ID> <VOTING_ID>
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

const IX_COMMIT_DWALLET: u8 = 31;
const IX_TRANSFER_OWNERSHIP: u8 = 24;

const DISC_COORDINATOR: u8 = 1;
const DISC_NEK: u8 = 3;
const DISC_MESSAGE_APPROVAL: u8 = 14;

const COORDINATOR_LEN: usize = 116;
const NEK_LEN: usize = 164;

const MA_STATUS: usize = 139;
const MA_STATUS_SIGNED: u8 = 1;
const MA_SIGNATURE_LEN: usize = 140;
const MA_SIGNATURE: usize = 142;

const SEED_DWALLET_COORDINATOR: &[u8] = b"dwallet_coordinator";
const SEED_DWALLET: &[u8] = b"dwallet";
const SEED_MESSAGE_APPROVAL: &[u8] = b"message_approval";
const SEED_CPI_AUTHORITY: &[u8] = b"__ika_cpi_authority";

const CURVE_CURVE25519: u8 = 2;

// Voting program offsets
const PROP_YES_VOTES: usize = 163;
const PROP_STATUS: usize = 175;

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

fn read_u32_le(data: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(data[offset..offset + 4].try_into().unwrap())
}

fn simple_keccak256(data: &[u8]) -> [u8; 32] {
    solana_sdk::keccak::hash(data).to_bytes()
}

fn build_grpc_request(payer: &Keypair, request: SignedRequestData) -> UserSignedRequest {
    let signed_data = bcs::to_bytes(&request).expect("BCS serialize");
    let user_sig = UserSignature::Ed25519 {
        signature: vec![0u8; 64],
        public_key: payer.pubkey().to_bytes().to_vec(),
    };
    UserSignedRequest {
        user_signature: bcs::to_bytes(&user_sig).expect("BCS serialize sig"),
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
        eprintln!("Usage: e2e-voting <DWALLET_PROGRAM_ID> <VOTING_PROGRAM_ID>");
        std::process::exit(1);
    }

    let dwallet_program_id = Pubkey::from_str(&args[1]).expect("invalid dWallet program ID");
    let voting_program_id = Pubkey::from_str(&args[2]).expect("invalid voting program ID");
    let grpc_url = env::var("GRPC_URL")
        .unwrap_or_else(|_| "https://pre-alpha-dev-1.ika.ika-network.net:443".to_string());

    let client = RpcClient::new_with_commitment(
        env::var("RPC_URL").unwrap_or_else(|_| "https://api.devnet.solana.com".to_string()),
        CommitmentConfig::confirmed(),
    );

    println!();
    println!(
        "{BOLD}\u{2550}\u{2550}\u{2550} dWallet Voting E2E Demo \u{2550}\u{2550}\u{2550}{RESET}"
    );
    println!();
    val("dWallet program", dwallet_program_id);
    val("Voting program", voting_program_id);
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

    // Find NEK via getProgramAccounts.
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
    let noa_pubkey = Pubkey::new_from_array(nek_data.data[2..34].try_into().unwrap());
    ok(&format!("NetworkEncryptionKey: {nek_pda}"));
    val("NOA (from NEK)", noa_pubkey);
    println!();

    // ===================================================================
    // Step 1: gRPC DKG
    // ===================================================================

    log(
        "1/7",
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

    let dkg_request = build_grpc_request(
        &payer,
        SignedRequestData {
            session_identifier_preimage: [0u8; 32],
            epoch: 1,
            chain_id: ChainId::Solana,
            intended_chain_sender: payer.pubkey().to_bytes().to_vec(),
            request: DWalletRequest::DKG {
                dwallet_network_encryption_public_key: vec![0u8; 32],
                curve: DWalletCurve::Curve25519,
                centralized_public_key_share_and_proof: vec![0u8; 32],
                user_secret_key_share: UserSecretKeyShare::Encrypted {
                    encrypted_centralized_secret_share_and_proof: vec![0u8; 32],
                    encryption_key: vec![0u8; 32],
                    signer_public_key: payer.pubkey().to_bytes().to_vec(),
                },
                user_public_output: vec![0u8; 32],
                sign_during_dkg_request: None,
            },
        },
    );

    let response = grpc_client
        .submit_transaction(dkg_request)
        .await
        .expect("gRPC DKG");
    let response_data: TransactionResponseData =
        bcs::from_bytes(&response.into_inner().response_data).expect("BCS deserialize");

    let attestation = match response_data {
        TransactionResponseData::Attestation(att) => {
            ok("DKG attestation received");
            att
        }
        other => panic!("unexpected DKG response: {other:?}"),
    };

    // BCS-decode the versioned DWallet data attestation from the signed bytes.
    let versioned: VersionedDWalletDataAttestation =
        bcs::from_bytes(&attestation.attestation_data).expect("decode attestation");
    let VersionedDWalletDataAttestation::V1(data) = versioned;
    let (public_key, _public_output, _intended_sender) =
        (data.public_key, data.public_output, data.intended_chain_sender);

    // dwallet_addr is now derived deterministically from (curve, public_key)
    // by the dwallet PDA seeds — we don't extract it from the attestation
    // bytes anymore. Use payer.pubkey() as the session_identifier_preimage
    // below to maintain the existing dwallet lookup flow.
    let dwallet_addr: [u8; 32] = payer.pubkey().to_bytes();

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
    // Step 2: Transfer dWallet authority to voting CPI PDA
    // ===================================================================

    log("2/7", "Transferring dWallet authority to voting program...");

    let (cpi_authority, cpi_authority_bump) =
        Pubkey::find_program_address(&[SEED_CPI_AUTHORITY], &voting_program_id);

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
    // Step 3: Create voting proposal (quorum=3)
    // ===================================================================

    log("3/7", "Creating voting proposal (quorum=3)...");

    let proposal_id = Keypair::new().pubkey().to_bytes();
    let message = b"Transfer 100 USDC to treasury";
    let message_hash = simple_keccak256(message);
    let user_pubkey = [0xCCu8; 32];
    let quorum: u32 = 3;

    let (proposal_pda, proposal_bump) =
        Pubkey::find_program_address(&[b"proposal", &proposal_id], &voting_program_id);

    let (message_approval_pda, message_approval_bump) = Pubkey::find_program_address(
        &[SEED_MESSAGE_APPROVAL, dwallet_pda.as_ref(), &message_hash],
        &dwallet_program_id,
    );

    let mut create_proposal = Vec::with_capacity(104);
    create_proposal.push(0); // disc
    create_proposal.extend_from_slice(&proposal_id);
    create_proposal.extend_from_slice(&message_hash);
    create_proposal.extend_from_slice(&user_pubkey);
    create_proposal.push(0); // signature_scheme
    create_proposal.extend_from_slice(&quorum.to_le_bytes());
    create_proposal.push(message_approval_bump);
    create_proposal.push(proposal_bump);

    send_tx(
        &client,
        &payer,
        vec![Instruction::new_with_bytes(
            voting_program_id,
            &create_proposal,
            vec![
                AccountMeta::new(proposal_pda, false),
                AccountMeta::new_readonly(dwallet_pda, false),
                AccountMeta::new_readonly(payer.pubkey(), true),
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new_readonly(system_program::id(), false),
            ],
        )],
        &[],
    );
    ok(&format!("Proposal: {proposal_pda}"));
    val("Message", String::from_utf8_lossy(message));
    val("Quorum", quorum);

    // ===================================================================
    // Step 5: Cast 3 yes votes
    // ===================================================================

    let voter_names = ["Alice", "Bob", "Charlie"];
    let mut quorum_tx_sig = solana_sdk::signature::Signature::default();

    for (i, name) in voter_names.iter().enumerate() {
        let vote_num = i + 1;
        log("4/7", &format!("Vote {vote_num}/3: {name} casts YES..."));

        let voter = fund_keypair(&client, &payer, 100_000_000);

        let (vote_record_pda, vote_record_bump) = Pubkey::find_program_address(
            &[b"vote", &proposal_id, voter.pubkey().as_ref()],
            &voting_program_id,
        );

        let mut cast_vote_data = Vec::with_capacity(36);
        cast_vote_data.push(1); // disc
        cast_vote_data.extend_from_slice(&proposal_id);
        cast_vote_data.push(1); // yes
        cast_vote_data.push(vote_record_bump);
        cast_vote_data.push(cpi_authority_bump);

        let mut accounts = vec![
            AccountMeta::new(proposal_pda, false),
            AccountMeta::new(vote_record_pda, false),
            AccountMeta::new_readonly(voter.pubkey(), true),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(system_program::id(), false),
        ];

        if vote_num as u32 >= quorum {
            accounts.extend_from_slice(&[
                AccountMeta::new(message_approval_pda, false),
                AccountMeta::new_readonly(dwallet_pda, false),
                AccountMeta::new_readonly(voting_program_id, false),
                AccountMeta::new_readonly(cpi_authority, false),
                AccountMeta::new_readonly(dwallet_program_id, false),
            ]);
        }

        let sig = send_tx(
            &client,
            &payer,
            vec![Instruction::new_with_bytes(
                voting_program_id,
                &cast_vote_data,
                accounts,
            )],
            &[&voter],
        );

        if vote_num as u32 >= quorum {
            quorum_tx_sig = sig;
        }
        ok(&format!("{name} voted YES"));
    }

    let prop_data = client
        .get_account(&proposal_pda)
        .expect("read proposal")
        .data;
    assert_eq!(read_u32_le(&prop_data, PROP_YES_VOTES), 3);
    assert_eq!(prop_data[PROP_STATUS], 1);
    ok("Proposal approved (3/3 yes)");

    // ===================================================================
    // Step 6: Verify MessageApproval
    // ===================================================================

    log("5/7", "Verifying MessageApproval on-chain...");

    let ma_data = poll_until(
        &client,
        &message_approval_pda,
        |d| d.len() > MA_STATUS && d[0] == DISC_MESSAGE_APPROVAL,
        Duration::from_secs(10),
    );
    assert_eq!(ma_data[MA_STATUS], 0); // Pending
    ok(&format!("MessageApproval: {message_approval_pda}"));
    val("Status", "Pending");

    // ===================================================================
    // Step 7: Allocate presign via gRPC
    // ===================================================================

    log("6/7", "Allocating presign via gRPC...");

    let presign_request = build_grpc_request(
        &payer,
        SignedRequestData {
            session_identifier_preimage: dwallet_addr,
            epoch: 1,
            chain_id: ChainId::Solana,
            intended_chain_sender: payer.pubkey().to_bytes().to_vec(),
            request: DWalletRequest::PresignForDWallet {
                dwallet_network_encryption_public_key: vec![0u8; 32],
                dwallet_public_key: dwallet_addr.to_vec(),
                curve: DWalletCurve::Curve25519,
                signature_algorithm: DWalletSignatureAlgorithm::EdDSA,
            },
        },
    );

    let presign_response = grpc_client
        .submit_transaction(presign_request)
        .await
        .expect("presign");
    let presign_data: TransactionResponseData =
        bcs::from_bytes(&presign_response.into_inner().response_data).expect("BCS");

    let presign_id = match presign_data {
        TransactionResponseData::Attestation(att) => {
            let versioned: VersionedPresignDataAttestation =
                bcs::from_bytes(&att.attestation_data).expect("decode presign attestation");
            let VersionedPresignDataAttestation::V1(data) = versioned;
            ok("Presign allocated!");
            val("Presign ID", hex::encode(&data.presign_session_identifier));
            data.presign_session_identifier
        }
        other => panic!("unexpected presign response: {other:?}"),
    };

    // ===================================================================
    // Step 8: Sign via gRPC
    // ===================================================================

    log("7/8", "Sending Sign request via gRPC...");

    let sign_request = build_grpc_request(
        &payer,
        SignedRequestData {
            session_identifier_preimage: dwallet_addr,
            epoch: 1,
            chain_id: ChainId::Solana,
            intended_chain_sender: payer.pubkey().to_bytes().to_vec(),
            request: DWalletRequest::Sign {
                message: message.to_vec(),
                message_metadata: vec![],
                presign_session_identifier: presign_id,
                message_centralized_signature: vec![0u8; 64],
                dwallet_attestation: NetworkSignedAttestation {
                    attestation_data: vec![0u8; 32],
                    network_signature: vec![0u8; 64],
                    network_pubkey: vec![0u8; 32],
                    epoch: 1,
                },
                approval_proof: ApprovalProof::Solana {
                    transaction_signature: quorum_tx_sig.as_ref().to_vec(),
                    slot: 0,
                },
            },
        },
    );

    let sign_response = grpc_client
        .submit_transaction(sign_request)
        .await
        .expect("sign");
    let sign_data: TransactionResponseData =
        bcs::from_bytes(&sign_response.into_inner().response_data).expect("BCS");

    let grpc_signature = match sign_data {
        TransactionResponseData::Signature { signature } => {
            ok("Signature received from gRPC!");
            val("Signature length", signature.len());
            val("Signature", hex::encode(&signature));
            signature
        }
        TransactionResponseData::Error { message } => {
            panic!("gRPC Sign failed: {message}");
        }
        other => panic!("Unexpected sign response: {other:?}"),
    };

    // ===================================================================
    // Step 8: Verify signature on-chain
    // ===================================================================

    log("8/8", "Verifying signature on-chain...");

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
fn pack_dwallet_seed_payload(curve: u8, public_key: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(1 + public_key.len());
    buf.push(curve);
    buf.extend_from_slice(public_key);
    buf
}
