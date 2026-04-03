// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! LiteSVM end-to-end tests for the native voting example.
//!
//! Tests the full CPI flow: create_proposal -> cast votes -> quorum triggers
//! approve_message CPI -> MessageApproval PDA created on the dWallet program.
//!
//! All helpers are inlined (no separate crate dependency) since
//! `ika-dwallet-litesvm-test` is internal to ika.

use litesvm::LiteSVM;
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;

// ═══════════════════════════════════════════════════════════════════════
// Paths
// ═══════════════════════════════════════════════════════════════════════

/// Path to the pre-built dWallet program binary (checked into the repo).
const DWALLET_PROGRAM_BINARY: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../../../bin/ika_dwallet_program.so"
);

/// Path to the compiled SBF binary for the native voting example.
const VOTING_PROGRAM_BINARY: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../../../target/deploy/ika_example_voting_native.so"
);

// ═══════════════════════════════════════════════════════════════════════
// dWallet program constants (inlined from ika-dwallet-mollusk-tests)
// ═══════════════════════════════════════════════════════════════════════

/// System program ID (11111111111111111111111111111111).
const SYSTEM_PROGRAM_ID: Pubkey = Pubkey::new_from_array([0u8; 32]);

/// The dWallet program ID (must match the hardcoded `crate::ID` in the program).
const DWALLET_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c,
    0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c, 0x0c,
    0x0c, 0x01,
]);

/// CPI authority PDA seed (must match the dWallet program).
const CPI_AUTHORITY_SEED: &[u8] = b"__ika_cpi_authority";

// ── dWallet account discriminators ──
const DISC_COORDINATOR: u8 = 1;
const DISC_DWALLET: u8 = 2;
const DISC_NEK: u8 = 3;
const DISC_MESSAGE_APPROVAL: u8 = 14;

// ── dWallet instruction discriminators ──
const IX_TRANSFER_OWNERSHIP: u8 = 24;

// ── Account sizes ──
const COORDINATOR_LEN: usize = 2 + 114;
const DWALLET_LEN: usize = 2 + 690;
const NEK_LEN: usize = 2 + 162;
const MESSAGE_APPROVAL_LEN: usize = 2 + 285;

// ── DWallet offsets ──
const DW_AUTHORITY: usize = 2;
const DW_PUBLIC_KEY: usize = 37;
const DW_CREATED_EPOCH: usize = 102;
const DW_NOA_PUBLIC_KEY: usize = 110;
const DW_IS_IMPORTED: usize = 142;
const DW_BUMP: usize = 659;

// ── DWallet state/curve values ──
const DW_STATE_ACTIVE: u8 = 1;
const CURVE_CURVE25519: u8 = 2;

// ── Coordinator offsets ──
const COORD_AUTHORITY: usize = 2;
const COORD_EPOCH: usize = 34;
const COORD_TOTAL_DWALLETS: usize = 42;
const COORD_PAUSED: usize = 50;
const COORD_BUMP: usize = 51;

// ── NEK offsets ──
const NEK_NOA_PUBKEY: usize = 2;
const NEK_STATE: usize = 34;
const NEK_CREATED_EPOCH: usize = 35;
const NEK_BUMP: usize = 147;
const NEK_STATE_ACTIVE: u8 = 1;

// ── MessageApproval offsets ──
const MA_DWALLET: usize = 2;
const MA_MESSAGE_HASH: usize = 34;
const MA_APPROVER: usize = 66;
const MA_USER_PUBKEY: usize = 98;
const MA_SIGNATURE_SCHEME: usize = 130;
const MA_STATUS: usize = 139;
const MA_STATUS_PENDING: u8 = 0;

// ═══════════════════════════════════════════════════════════════════════
// Voting program constants (must match native lib.rs)
// ═══════════════════════════════════════════════════════════════════════

const PROPOSAL_LEN: usize = 195;

const PROP_PROPOSAL_ID: usize = 2;
const PROP_YES_VOTES: usize = 163;
const PROP_NO_VOTES: usize = 167;
const PROP_STATUS: usize = 175;

const STATUS_OPEN: u8 = 0;
const STATUS_APPROVED: u8 = 1;

// ═══════════════════════════════════════════════════════════════════════
// Address / Pubkey helpers
// ═══════════════════════════════════════════════════════════════════════

fn pubkey_to_address(pk: &Pubkey) -> Address {
    Address::new_from_array(pk.to_bytes())
}

fn keypair_pubkey(kp: &Keypair) -> Pubkey {
    Pubkey::new_from_array(kp.pubkey().to_bytes())
}

// ═══════════════════════════════════════════════════════════════════════
// Data builders
// ═══════════════════════════════════════════════════════════════════════

fn program_account(owner: &Pubkey, data: Vec<u8>) -> Account {
    Account {
        lamports: ((data.len() as u64 + 128) * 6960).max(1),
        data,
        owner: *owner,
        executable: false,
        rent_epoch: 0,
    }
}

fn build_coordinator_data(authority: &Pubkey, epoch: u64, bump: u8) -> Vec<u8> {
    let mut data = vec![0u8; COORDINATOR_LEN];
    data[0] = DISC_COORDINATOR;
    data[1] = 1;
    data[COORD_AUTHORITY..COORD_AUTHORITY + 32].copy_from_slice(authority.as_ref());
    data[COORD_EPOCH..COORD_EPOCH + 8].copy_from_slice(&epoch.to_le_bytes());
    data[COORD_TOTAL_DWALLETS..COORD_TOTAL_DWALLETS + 8].copy_from_slice(&0u64.to_le_bytes());
    data[COORD_PAUSED] = 0;
    data[COORD_BUMP] = bump;
    data
}

fn build_nek_data(noa_pubkey: &Pubkey, state: u8, bump: u8) -> Vec<u8> {
    let mut data = vec![0u8; NEK_LEN];
    data[0] = DISC_NEK;
    data[1] = 1;
    data[NEK_NOA_PUBKEY..NEK_NOA_PUBKEY + 32].copy_from_slice(noa_pubkey.as_ref());
    data[NEK_STATE] = state;
    data[NEK_CREATED_EPOCH..NEK_CREATED_EPOCH + 8].copy_from_slice(&1u64.to_le_bytes());
    data[NEK_BUMP] = bump;
    data
}

fn build_dwallet_data(
    authority: &Pubkey,
    curve: u8,
    state: u8,
    public_key_len: u8,
    public_key: &[u8],
    noa_pubkey: &Pubkey,
    is_imported: u8,
    bump: u8,
) -> Vec<u8> {
    let mut data = vec![0u8; DWALLET_LEN];
    data[0] = DISC_DWALLET;
    data[1] = 1;
    data[DW_AUTHORITY..DW_AUTHORITY + 32].copy_from_slice(authority.as_ref());
    data[34] = curve;
    data[35] = state;
    data[36] = public_key_len;
    let copy_len = public_key.len().min(65);
    data[DW_PUBLIC_KEY..DW_PUBLIC_KEY + copy_len].copy_from_slice(&public_key[..copy_len]);
    data[DW_CREATED_EPOCH..DW_CREATED_EPOCH + 8].copy_from_slice(&1u64.to_le_bytes());
    data[DW_NOA_PUBLIC_KEY..DW_NOA_PUBLIC_KEY + 32].copy_from_slice(noa_pubkey.as_ref());
    data[DW_IS_IMPORTED] = is_imported;
    data[DW_BUMP] = bump;
    data
}

fn build_transfer_dwallet_ix(
    program_id: &Pubkey,
    authority: &Pubkey,
    dwallet: &Pubkey,
    new_authority: &Pubkey,
) -> Instruction {
    let mut ix_data = Vec::with_capacity(33);
    ix_data.push(IX_TRANSFER_OWNERSHIP);
    ix_data.extend_from_slice(new_authority.as_ref());

    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new_readonly(*authority, true),
            AccountMeta::new(*dwallet, false),
        ],
        data: ix_data,
    }
}

// ═══════════════════════════════════════════════════════════════════════
// DWalletTestContext (inlined from ika-dwallet-litesvm-test)
// ═══════════════════════════════════════════════════════════════════════

struct DWalletTestContext {
    svm: LiteSVM,
    dwallet_program_id: Pubkey,
    payer: Keypair,
    noa_keypair: Keypair,
}

impl DWalletTestContext {
    fn new() -> Self {
        let mut svm = LiteSVM::new();

        let dwallet_program_id = DWALLET_PROGRAM_ID;
        let dwallet_addr = pubkey_to_address(&dwallet_program_id);
        svm.add_program_from_file(&dwallet_addr, DWALLET_PROGRAM_BINARY)
            .expect("failed to deploy dWallet program");

        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 100_000_000_000)
            .expect("airdrop payer failed");

        let noa_keypair = Keypair::new();
        let noa_pubkey = keypair_pubkey(&noa_keypair);

        // Pre-populate DWalletCoordinator PDA.
        let (coordinator_pda, coord_bump) =
            Pubkey::find_program_address(&[b"dwallet_coordinator"], &dwallet_program_id);
        let authority_key = Pubkey::new_unique();
        let coord_data = build_coordinator_data(&authority_key, 5, coord_bump);
        let coord_account = program_account(&dwallet_program_id, coord_data);
        svm.set_account(pubkey_to_address(&coordinator_pda), coord_account)
            .expect("set coordinator account failed");

        // Pre-populate NetworkEncryptionKey PDA.
        let (nek_pda, nek_bump) = Pubkey::find_program_address(
            &[b"network_encryption_key", noa_pubkey.as_ref()],
            &dwallet_program_id,
        );
        let nek_data = build_nek_data(&noa_pubkey, NEK_STATE_ACTIVE, nek_bump);
        let nek_account = program_account(&dwallet_program_id, nek_data);
        svm.set_account(pubkey_to_address(&nek_pda), nek_account)
            .expect("set NEK account failed");

        Self {
            svm,
            dwallet_program_id,
            payer,
            noa_keypair,
        }
    }

    fn deploy_program(&mut self, elf_path: &str) -> Pubkey {
        let program_id = Pubkey::new_unique();
        let addr = pubkey_to_address(&program_id);
        self.svm
            .add_program_from_file(&addr, elf_path)
            .expect("failed to deploy program");
        program_id
    }

    fn cpi_authority_for(&self, caller_program_id: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[CPI_AUTHORITY_SEED], caller_program_id)
    }

    fn create_dwallet(
        &mut self,
        authority: &Pubkey,
        curve: u8,
        public_key_len: u8,
        public_key: &[u8],
    ) -> Pubkey {
        let actual_key = &public_key[..public_key_len as usize];
        let (dwallet_pda, dwallet_bump) = Pubkey::find_program_address(
            &[b"dwallet", &[curve], actual_key],
            &self.dwallet_program_id,
        );

        let noa_pubkey = keypair_pubkey(&self.noa_keypair);
        let mut pk_array = [0u8; 65];
        let copy_len = public_key.len().min(65);
        pk_array[..copy_len].copy_from_slice(&public_key[..copy_len]);

        let dwallet_data = build_dwallet_data(
            authority,
            curve,
            DW_STATE_ACTIVE,
            public_key_len,
            &pk_array,
            &noa_pubkey,
            0,
            dwallet_bump,
        );
        let account = program_account(&self.dwallet_program_id, dwallet_data);
        self.svm
            .set_account(pubkey_to_address(&dwallet_pda), account)
            .expect("set dWallet account failed");

        dwallet_pda
    }

    fn transfer_dwallet(
        &mut self,
        dwallet: &Pubkey,
        current_authority: &Keypair,
        new_authority: &Pubkey,
    ) {
        let authority_pubkey = keypair_pubkey(current_authority);
        let ix = build_transfer_dwallet_ix(
            &self.dwallet_program_id,
            &authority_pubkey,
            dwallet,
            new_authority,
        );

        let payer_copy = self.clone_payer();
        self.send_tx(&[current_authority, &payer_copy], &[ix]);
    }

    fn send_tx(&mut self, signers: &[&Keypair], ixs: &[Instruction]) {
        let payer_addr = self.payer.pubkey();
        let blockhash = self.svm.latest_blockhash();

        let tx = Transaction::new_signed_with_payer(ixs, Some(&payer_addr), signers, blockhash);

        self.svm
            .send_transaction(tx)
            .expect("send_transaction failed");
    }

    fn get_account_data(&self, pubkey: &Pubkey) -> Option<Vec<u8>> {
        let addr = pubkey_to_address(pubkey);
        self.svm.get_account(&addr).map(|a| a.data.to_vec())
    }

    fn new_funded_keypair(&mut self) -> Keypair {
        let kp = Keypair::new();
        self.svm
            .airdrop(&kp.pubkey(), 10_000_000_000)
            .expect("airdrop failed");
        kp
    }

    fn clone_payer(&self) -> Keypair {
        Keypair::new_from_array(*self.payer.secret_bytes())
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Data readers
// ═══════════════════════════════════════════════════════════════════════

fn read_u32(data: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(data[offset..offset + 4].try_into().unwrap())
}

// ═══════════════════════════════════════════════════════════════════════
// Voting instruction builders
// ═══════════════════════════════════════════════════════════════════════

fn build_create_proposal_ix(
    program_id: &Pubkey,
    proposal: &Pubkey,
    dwallet: &Pubkey,
    creator: &Pubkey,
    payer: &Pubkey,
    proposal_id: [u8; 32],
    message_hash: [u8; 32],
    user_pubkey: [u8; 32],
    signature_scheme: u8,
    quorum: u32,
    message_approval_bump: u8,
    proposal_bump: u8,
) -> Instruction {
    let mut ix_data = Vec::with_capacity(104);
    ix_data.push(0);
    ix_data.extend_from_slice(&proposal_id);
    ix_data.extend_from_slice(&message_hash);
    ix_data.extend_from_slice(&user_pubkey);
    ix_data.push(signature_scheme);
    ix_data.extend_from_slice(&quorum.to_le_bytes());
    ix_data.push(message_approval_bump);
    ix_data.push(proposal_bump);

    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*proposal, false),
            AccountMeta::new_readonly(*dwallet, false),
            AccountMeta::new_readonly(*creator, true),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        ],
        data: ix_data,
    }
}

fn build_cast_vote_ix(
    program_id: &Pubkey,
    proposal: &Pubkey,
    vote_record: &Pubkey,
    voter: &Pubkey,
    payer: &Pubkey,
    proposal_id: [u8; 32],
    vote: u8,
    vote_record_bump: u8,
    cpi_authority_bump: u8,
) -> Instruction {
    let mut ix_data = Vec::with_capacity(36);
    ix_data.push(1);
    ix_data.extend_from_slice(&proposal_id);
    ix_data.push(vote);
    ix_data.push(vote_record_bump);
    ix_data.push(cpi_authority_bump);

    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*proposal, false),
            AccountMeta::new(*vote_record, false),
            AccountMeta::new_readonly(*voter, true),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        ],
        data: ix_data,
    }
}

fn build_cast_vote_with_cpi_ix(
    program_id: &Pubkey,
    proposal: &Pubkey,
    vote_record: &Pubkey,
    voter: &Pubkey,
    payer: &Pubkey,
    proposal_id: [u8; 32],
    vote: u8,
    vote_record_bump: u8,
    cpi_authority_bump: u8,
    message_approval: &Pubkey,
    dwallet: &Pubkey,
    voting_program_account: &Pubkey,
    cpi_authority: &Pubkey,
    dwallet_program: &Pubkey,
) -> Instruction {
    let mut ix_data = Vec::with_capacity(36);
    ix_data.push(1);
    ix_data.extend_from_slice(&proposal_id);
    ix_data.push(vote);
    ix_data.push(vote_record_bump);
    ix_data.push(cpi_authority_bump);

    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*proposal, false),
            AccountMeta::new(*vote_record, false),
            AccountMeta::new_readonly(*voter, true),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
            AccountMeta::new(*message_approval, false),
            AccountMeta::new_readonly(*dwallet, false),
            AccountMeta::new_readonly(*voting_program_account, false),
            AccountMeta::new_readonly(*cpi_authority, false),
            AccountMeta::new_readonly(*dwallet_program, false),
        ],
        data: ix_data,
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

/// Full lifecycle: deploy programs -> create dWallet -> transfer authority ->
/// create proposal -> cast 3 votes (quorum) -> verify MessageApproval exists.
#[test]
fn test_voting_full_lifecycle() {
    let mut ctx = DWalletTestContext::new();

    let voting_program_id = ctx.deploy_program(VOTING_PROGRAM_BINARY);
    let (cpi_authority, cpi_authority_bump) = ctx.cpi_authority_for(&voting_program_id);

    let authority_keypair = ctx.new_funded_keypair();
    let authority_pubkey = keypair_pubkey(&authority_keypair);
    let dwallet_public_key = [0xAAu8; 32];
    let dwallet = ctx.create_dwallet(&authority_pubkey, CURVE_CURVE25519, 32, &dwallet_public_key);

    ctx.transfer_dwallet(&dwallet, &authority_keypair, &cpi_authority);

    // Verify transfer.
    let dw_data = ctx.get_account_data(&dwallet).expect("dWallet should exist");
    let stored_authority = Pubkey::new_from_array(
        dw_data[DW_AUTHORITY..DW_AUTHORITY + 32].try_into().unwrap(),
    );
    assert_eq!(stored_authority, cpi_authority, "dWallet authority should be CPI authority PDA");

    // Create proposal.
    let proposal_id = [0x01u8; 32];
    let message_hash = [0xBBu8; 32];
    let user_pubkey = [0xCCu8; 32];
    let quorum = 3u32;

    let (proposal_pda, proposal_bump) =
        Pubkey::find_program_address(&[b"proposal", &proposal_id], &voting_program_id);
    let (message_approval_pda, message_approval_bump) = Pubkey::find_program_address(
        &[b"message_approval", dwallet.as_ref(), &message_hash],
        &ctx.dwallet_program_id,
    );

    let payer_copy = ctx.clone_payer();
    let payer_pubkey = keypair_pubkey(&payer_copy);
    let creator = ctx.new_funded_keypair();
    let creator_pubkey = keypair_pubkey(&creator);

    let create_proposal_ix = build_create_proposal_ix(
        &voting_program_id,
        &proposal_pda,
        &dwallet,
        &creator_pubkey,
        &payer_pubkey,
        proposal_id,
        message_hash,
        user_pubkey,
        0,
        quorum,
        message_approval_bump,
        proposal_bump,
    );

    let payer_ref = ctx.clone_payer();
    ctx.send_tx(&[&payer_ref, &creator], &[create_proposal_ix]);

    // Verify proposal created.
    let prop_data = ctx.get_account_data(&proposal_pda).expect("proposal should exist");
    assert_eq!(prop_data.len(), PROPOSAL_LEN, "proposal account length");
    assert_eq!(
        &prop_data[PROP_PROPOSAL_ID..PROP_PROPOSAL_ID + 32],
        &proposal_id,
        "proposal_id"
    );
    assert_eq!(prop_data[PROP_STATUS], STATUS_OPEN, "status = Open");

    // Cast 3 yes votes.
    let voter_one = ctx.new_funded_keypair();
    let voter_two = ctx.new_funded_keypair();
    let voter_three = ctx.new_funded_keypair();

    // Vote 1.
    cast_vote_no_cpi(
        &mut ctx, &voting_program_id, &proposal_pda, &voter_one,
        proposal_id, cpi_authority_bump,
    );
    let prop_data = ctx.get_account_data(&proposal_pda).unwrap();
    assert_eq!(read_u32(&prop_data, PROP_YES_VOTES), 1, "yes_votes = 1");

    // Vote 2.
    cast_vote_no_cpi(
        &mut ctx, &voting_program_id, &proposal_pda, &voter_two,
        proposal_id, cpi_authority_bump,
    );
    let prop_data = ctx.get_account_data(&proposal_pda).unwrap();
    assert_eq!(read_u32(&prop_data, PROP_YES_VOTES), 2, "yes_votes = 2");
    assert_eq!(prop_data[PROP_STATUS], STATUS_OPEN, "status still Open");

    // Vote 3 (quorum reached -- CPI triggered).
    let voter_three_pubkey = keypair_pubkey(&voter_three);
    let (vr_pda_three, vr_bump_three) = Pubkey::find_program_address(
        &[b"vote", &proposal_id, voter_three_pubkey.as_ref()],
        &voting_program_id,
    );

    let payer_ref = ctx.clone_payer();
    let payer_pubkey = keypair_pubkey(&payer_ref);

    let ix = build_cast_vote_with_cpi_ix(
        &voting_program_id,
        &proposal_pda,
        &vr_pda_three,
        &voter_three_pubkey,
        &payer_pubkey,
        proposal_id,
        1,
        vr_bump_three,
        cpi_authority_bump,
        &message_approval_pda,
        &dwallet,
        &voting_program_id,
        &cpi_authority,
        &ctx.dwallet_program_id,
    );

    ctx.send_tx(&[&payer_ref, &voter_three], &[ix]);

    // Verify proposal approved.
    let prop_data = ctx.get_account_data(&proposal_pda).unwrap();
    assert_eq!(read_u32(&prop_data, PROP_YES_VOTES), 3, "yes_votes = 3");
    assert_eq!(prop_data[PROP_STATUS], STATUS_APPROVED, "status should be Approved");

    // Verify MessageApproval PDA created.
    let ma_data = ctx
        .get_account_data(&message_approval_pda)
        .expect("MessageApproval PDA should exist after quorum");
    assert_eq!(ma_data.len(), MESSAGE_APPROVAL_LEN, "MessageApproval account length");
    assert_eq!(ma_data[0], DISC_MESSAGE_APPROVAL, "MessageApproval discriminator");
    assert_eq!(ma_data[1], 1, "MessageApproval version");

    let ma_dwallet = Pubkey::new_from_array(
        ma_data[MA_DWALLET..MA_DWALLET + 32].try_into().unwrap(),
    );
    assert_eq!(ma_dwallet, dwallet, "MA.dwallet");

    let ma_message_hash: [u8; 32] = ma_data[MA_MESSAGE_HASH..MA_MESSAGE_HASH + 32]
        .try_into()
        .unwrap();
    assert_eq!(ma_message_hash, message_hash, "MA.message_hash");

    let ma_approver = Pubkey::new_from_array(
        ma_data[MA_APPROVER..MA_APPROVER + 32].try_into().unwrap(),
    );
    assert_eq!(ma_approver, cpi_authority, "MA.approver should be CPI authority PDA");

    let ma_user_pubkey: [u8; 32] = ma_data[MA_USER_PUBKEY..MA_USER_PUBKEY + 32]
        .try_into()
        .unwrap();
    assert_eq!(ma_user_pubkey, user_pubkey, "MA.user_pubkey");

    assert_eq!(ma_data[MA_SIGNATURE_SCHEME], 0, "MA.signature_scheme");
    assert_eq!(ma_data[MA_STATUS], MA_STATUS_PENDING, "MA.status should be Pending");
}

/// Test that voting below quorum does NOT create a MessageApproval account.
#[test]
fn test_voting_below_quorum_no_approval() {
    let mut ctx = DWalletTestContext::new();
    let voting_program_id = ctx.deploy_program(VOTING_PROGRAM_BINARY);

    let (cpi_authority, cpi_authority_bump) = ctx.cpi_authority_for(&voting_program_id);

    let authority_keypair = ctx.new_funded_keypair();
    let authority_pubkey = keypair_pubkey(&authority_keypair);
    let dwallet = ctx.create_dwallet(&authority_pubkey, CURVE_CURVE25519, 32, &[0xAAu8; 32]);
    ctx.transfer_dwallet(&dwallet, &authority_keypair, &cpi_authority);

    let proposal_id = [0x02u8; 32];
    let message_hash = [0xDDu8; 32];
    let quorum = 5u32;

    let (proposal_pda, proposal_bump) =
        Pubkey::find_program_address(&[b"proposal", &proposal_id], &voting_program_id);
    let (_, ma_bump) = Pubkey::find_program_address(
        &[b"message_approval", dwallet.as_ref(), &message_hash],
        &ctx.dwallet_program_id,
    );

    let payer_ref = ctx.clone_payer();
    let payer_pubkey = keypair_pubkey(&payer_ref);
    let creator = ctx.new_funded_keypair();
    let creator_pubkey = keypair_pubkey(&creator);

    let create_ix = build_create_proposal_ix(
        &voting_program_id,
        &proposal_pda,
        &dwallet,
        &creator_pubkey,
        &payer_pubkey,
        proposal_id,
        message_hash,
        [0u8; 32],
        0,
        quorum,
        ma_bump,
        proposal_bump,
    );
    ctx.send_tx(&[&payer_ref, &creator], &[create_ix]);

    let voter_one = ctx.new_funded_keypair();
    let voter_two = ctx.new_funded_keypair();

    cast_vote_no_cpi(
        &mut ctx, &voting_program_id, &proposal_pda, &voter_one,
        proposal_id, cpi_authority_bump,
    );
    cast_vote_no_cpi(
        &mut ctx, &voting_program_id, &proposal_pda, &voter_two,
        proposal_id, cpi_authority_bump,
    );

    let prop_data = ctx.get_account_data(&proposal_pda).unwrap();
    assert_eq!(prop_data[PROP_STATUS], STATUS_OPEN, "status should be Open");
    assert_eq!(read_u32(&prop_data, PROP_YES_VOTES), 2, "yes_votes = 2");

    let (ma_pda, _) = Pubkey::find_program_address(
        &[b"message_approval", dwallet.as_ref(), &message_hash],
        &ctx.dwallet_program_id,
    );
    assert!(
        ctx.get_account_data(&ma_pda).is_none(),
        "MessageApproval should not exist before quorum"
    );
}

/// Test that "no" votes don't contribute to quorum.
#[test]
fn test_no_votes_dont_trigger_quorum() {
    let mut ctx = DWalletTestContext::new();
    let voting_program_id = ctx.deploy_program(VOTING_PROGRAM_BINARY);

    let (cpi_authority, cpi_authority_bump) = ctx.cpi_authority_for(&voting_program_id);

    let authority_keypair = ctx.new_funded_keypair();
    let authority_pubkey = keypair_pubkey(&authority_keypair);
    let dwallet = ctx.create_dwallet(&authority_pubkey, CURVE_CURVE25519, 32, &[0xBBu8; 32]);
    ctx.transfer_dwallet(&dwallet, &authority_keypair, &cpi_authority);

    let proposal_id = [0x03u8; 32];
    let message_hash = [0xEEu8; 32];
    let quorum = 2u32;

    let (proposal_pda, proposal_bump) =
        Pubkey::find_program_address(&[b"proposal", &proposal_id], &voting_program_id);
    let (_, ma_bump) = Pubkey::find_program_address(
        &[b"message_approval", dwallet.as_ref(), &message_hash],
        &ctx.dwallet_program_id,
    );

    let payer_ref = ctx.clone_payer();
    let payer_pubkey = keypair_pubkey(&payer_ref);
    let creator = ctx.new_funded_keypair();
    let creator_pubkey = keypair_pubkey(&creator);

    let create_ix = build_create_proposal_ix(
        &voting_program_id,
        &proposal_pda,
        &dwallet,
        &creator_pubkey,
        &payer_pubkey,
        proposal_id,
        message_hash,
        [0u8; 32],
        0,
        quorum,
        ma_bump,
        proposal_bump,
    );
    ctx.send_tx(&[&payer_ref, &creator], &[create_ix]);

    for _ in 0..3 {
        let voter = ctx.new_funded_keypair();
        let voter_pubkey = keypair_pubkey(&voter);
        let (vr_pda, vr_bump) = Pubkey::find_program_address(
            &[b"vote", &proposal_id, voter_pubkey.as_ref()],
            &voting_program_id,
        );

        let payer_ref = ctx.clone_payer();
        let payer_pubkey = keypair_pubkey(&payer_ref);

        let ix = build_cast_vote_ix(
            &voting_program_id,
            &proposal_pda,
            &vr_pda,
            &voter_pubkey,
            &payer_pubkey,
            proposal_id,
            0, // no
            vr_bump,
            cpi_authority_bump,
        );
        ctx.send_tx(&[&payer_ref, &voter], &[ix]);
    }

    let prop_data = ctx.get_account_data(&proposal_pda).unwrap();
    assert_eq!(prop_data[PROP_STATUS], STATUS_OPEN, "status should still be Open");
    assert_eq!(read_u32(&prop_data, PROP_YES_VOTES), 0, "yes_votes = 0");
    assert_eq!(read_u32(&prop_data, PROP_NO_VOTES), 3, "no_votes = 3");

    let (ma_pda, _) = Pubkey::find_program_address(
        &[b"message_approval", dwallet.as_ref(), &message_hash],
        &ctx.dwallet_program_id,
    );
    assert!(
        ctx.get_account_data(&ma_pda).is_none(),
        "MessageApproval should not exist with only 'no' votes"
    );
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

fn cast_vote_no_cpi(
    ctx: &mut DWalletTestContext,
    voting_program_id: &Pubkey,
    proposal_pda: &Pubkey,
    voter: &Keypair,
    proposal_id: [u8; 32],
    cpi_authority_bump: u8,
) {
    let voter_pubkey = keypair_pubkey(voter);
    let (vr_pda, vr_bump) = Pubkey::find_program_address(
        &[b"vote", &proposal_id, voter_pubkey.as_ref()],
        voting_program_id,
    );

    let payer_ref = ctx.clone_payer();
    let payer_pubkey = keypair_pubkey(&payer_ref);

    let ix = build_cast_vote_ix(
        voting_program_id,
        proposal_pda,
        &vr_pda,
        &voter_pubkey,
        &payer_pubkey,
        proposal_id,
        1, // yes
        vr_bump,
        cpi_authority_bump,
    );

    ctx.send_tx(&[&payer_ref, voter], &[ix]);
}
