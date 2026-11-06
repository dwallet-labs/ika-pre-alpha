// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! LiteSVM end-to-end tests for the native voting example.
//!
//! Tests the full CPI flow against the real dWallet program: create council
//! -> transfer the dWallet to the CPI authority -> create proposal -> cast
//! votes -> quorum triggers issue_signature_voucher CPI -> SignatureVoucher
//! created at the voting program's PDA — plus the two attacks the council
//! binding exists to
//! stop: outsiders voting, and one council's proposal being executed against
//! another council's dWallet.

use ika_dwallet_litesvm_test::*;
use solana_keypair::Keypair;

/// Path to the compiled SBF binary for the voting example.
const VOTING_PROGRAM_BINARY: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../target/deploy/ika_example_voting_native.so"
);

// ── Voting program constants (must match lib.rs) ──
const PROPOSAL_LEN: usize = 196;
const COUNCIL_LEN: usize = 361;

// ── Proposal offsets ──
const PROP_PROPOSAL_ID: usize = 2;
const PROP_YES_VOTES: usize = 164;
const PROP_NO_VOTES: usize = 168;
const PROP_QUORUM: usize = 172;
const PROP_STATUS: usize = 176;

// ── Status values ──
const STATUS_OPEN: u8 = 0;
const STATUS_APPROVED: u8 = 1;

// ── Program error codes (`VotingError`) ──
const ERR_DWALLET_MISMATCH: u32 = 0;
const ERR_NOT_A_MEMBER: u32 = 1;
const ERR_NOT_DWALLET_OWNER: u32 = 2;
const ERR_VOUCHER_MISMATCH: u32 = 10;
const ERR_INVALID_VOUCHER_BUMP: u32 = 9;
const ERR_INVALID_BUMP: u32 = 11;

// ═══════════════════════════════════════════════════════════════════════
// Instruction builders
// ═══════════════════════════════════════════════════════════════════════

/// Build a CreateCouncil instruction (disc=2).
///
/// Data: quorum(4) + member_count(2) + members(32 * n)
///
/// Accounts: [council(w), dwallet(r), dwallet_program(r), owner(s), payer(ws), system_program(r)]
fn build_create_council_ix(
    program_id: &Pubkey,
    council: &Pubkey,
    dwallet: &Pubkey,
    dwallet_program: &Pubkey,
    owner: &Pubkey,
    payer: &Pubkey,
    quorum: u32,
    members: &[Pubkey],
) -> Instruction {
    let mut ix_data = Vec::with_capacity(7);
    ix_data.push(2); // discriminator = CreateCouncil
    ix_data.extend_from_slice(&quorum.to_le_bytes());
    ix_data.extend_from_slice(&(members.len() as u16).to_le_bytes());
    for member in members {
        ix_data.extend_from_slice(member.as_ref());
    }
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*council, false),
            AccountMeta::new_readonly(*dwallet, false),
            AccountMeta::new_readonly(*dwallet_program, false),
            AccountMeta::new_readonly(*owner, true),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        ],
        data: ix_data,
    }
}

/// Build a CreateProposal instruction (disc=0).
///
/// Data: proposal_id(32) + message_hash(32) + user_pubkey(32) +
///       signature_scheme(2) + signature_voucher_bump(1) + bump(1) = 100
///
/// Accounts: [proposal(w), council(r), dwallet(r), creator(s), payer(ws), system_program(r)]
fn build_create_proposal_ix(
    program_id: &Pubkey,
    proposal: &Pubkey,
    council: &Pubkey,
    dwallet: &Pubkey,
    creator: &Pubkey,
    payer: &Pubkey,
    proposal_id: [u8; 32],
    message_hash: [u8; 32],
    user_pubkey: [u8; 32],
    signature_scheme: u16,
    signature_voucher_bump: u8,
    proposal_bump: u8,
) -> Instruction {
    let mut ix_data = Vec::with_capacity(101);
    ix_data.push(0); // discriminator = CreateProposal
    ix_data.extend_from_slice(&proposal_id);
    ix_data.extend_from_slice(&message_hash);
    ix_data.extend_from_slice(&user_pubkey);
    ix_data.extend_from_slice(&signature_scheme.to_le_bytes());
    ix_data.push(signature_voucher_bump);
    ix_data.push(proposal_bump);

    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*proposal, false),
            AccountMeta::new_readonly(*council, false),
            AccountMeta::new_readonly(*dwallet, false),
            AccountMeta::new_readonly(*creator, true),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        ],
        data: ix_data,
    }
}

/// Build a CastVote instruction (disc=1) without CPI accounts.
///
/// Data: proposal_id(32) + vote(1) + vote_record_bump(1) + cpi_authority_bump(1) = 35
///
/// Accounts: [proposal(w), vote_record(w), council(r), voter(s), payer(ws), system_program(r)]
fn build_cast_vote_ix(
    program_id: &Pubkey,
    proposal: &Pubkey,
    vote_record: &Pubkey,
    council: &Pubkey,
    voter: &Pubkey,
    payer: &Pubkey,
    proposal_id: [u8; 32],
    vote: u8,
    vote_record_bump: u8,
    cpi_authority_bump: u8,
) -> Instruction {
    let mut ix_data = Vec::with_capacity(36);
    ix_data.push(1); // discriminator = CastVote
    ix_data.extend_from_slice(&proposal_id);
    ix_data.push(vote);
    ix_data.push(vote_record_bump);
    ix_data.push(cpi_authority_bump);

    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*proposal, false),
            AccountMeta::new(*vote_record, false),
            AccountMeta::new_readonly(*council, false),
            AccountMeta::new_readonly(*voter, true),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(SYSTEM_PROGRAM_ID, false),
        ],
        data: ix_data,
    }
}

/// CPI accounts appended to a CastVote instruction for the quorum path
/// (indices 6-11): coordinator, signature_voucher, dwallet, this program,
/// cpi_authority, dwallet_program.
struct CpiAccounts {
    coordinator: Pubkey,
    signature_voucher: Pubkey,
    dwallet: Pubkey,
    voting_program: Pubkey,
    cpi_authority: Pubkey,
    dwallet_program: Pubkey,
}

fn with_cpi_accounts(mut ix: Instruction, cpi: &CpiAccounts) -> Instruction {
    ix.accounts.extend([
        AccountMeta::new_readonly(cpi.coordinator, false),
        AccountMeta::new(cpi.signature_voucher, false),
        AccountMeta::new_readonly(cpi.dwallet, false),
        AccountMeta::new_readonly(cpi.voting_program, false),
        AccountMeta::new_readonly(cpi.cpi_authority, false),
        AccountMeta::new_readonly(cpi.dwallet_program, false),
    ]);
    ix
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

/// The voucher the voting program issues for a proposal: its own PDA
/// `["signature_voucher", proposal_id]`, which it signs for.
fn signature_voucher_pda(voting_program_id: &Pubkey, proposal_id: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"signature_voucher", proposal_id], voting_program_id)
}

fn council_pda(voting_program_id: &Pubkey, dwallet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"council", dwallet.as_ref()], voting_program_id).0
}

/// A dWallet placed under a council's control: created with a user owner,
/// council created by that owner, then ownership transferred to the CPI PDA.
struct Governed {
    dwallet: Pubkey,
    council: Pubkey,
    members: Vec<Keypair>,
}

fn setup_governed(
    ctx: &mut DWalletTestContext,
    voting_program_id: &Pubkey,
    dwallet_pk: [u8; 32],
    quorum: u32,
    member_count: usize,
) -> Governed {
    let (cpi_authority, _) = ctx.cpi_authority_for(voting_program_id);
    let owner_keypair = ctx.new_funded_keypair();
    let owner_pubkey = keypair_pubkey(&owner_keypair);
    let dwallet = ctx.create_dwallet(&owner_pubkey, CURVE_CURVE25519, 32, &dwallet_pk);

    let members: Vec<Keypair> = (0..member_count)
        .map(|_| ctx.new_funded_keypair())
        .collect();
    let member_pubkeys: Vec<Pubkey> = members.iter().map(keypair_pubkey).collect();
    let council = council_pda(voting_program_id, &dwallet);
    let payer_ref = ctx.clone_payer();
    let ix = build_create_council_ix(
        voting_program_id,
        &council,
        &dwallet,
        &ctx.dwallet_program_id,
        &owner_pubkey,
        &keypair_pubkey(&payer_ref),
        quorum,
        &member_pubkeys,
    );
    ctx.send_tx(&[&payer_ref, &owner_keypair], &[ix]);

    // Hand the dWallet to the program only AFTER the council is fixed.
    ctx.transfer_dwallet(&dwallet, &owner_keypair, &cpi_authority);

    Governed {
        dwallet,
        council,
        members,
    }
}

/// Create a proposal by `creator` (a member) for the governed dWallet.
fn create_proposal(
    ctx: &mut DWalletTestContext,
    voting_program_id: &Pubkey,
    governed: &Governed,
    creator: &Keypair,
    proposal_id: [u8; 32],
    message_hash: [u8; 32],
    user_pubkey: [u8; 32],
) -> Pubkey {
    let (_, voucher_bump) = signature_voucher_pda(voting_program_id, &proposal_id);
    let (proposal_pda, proposal_bump) =
        Pubkey::find_program_address(&[b"proposal", &proposal_id], voting_program_id);
    let payer_ref = ctx.clone_payer();
    let ix = build_create_proposal_ix(
        voting_program_id,
        &proposal_pda,
        &governed.council,
        &governed.dwallet,
        &keypair_pubkey(creator),
        &keypair_pubkey(&payer_ref),
        proposal_id,
        message_hash,
        user_pubkey,
        0,
        voucher_bump,
        proposal_bump,
    );
    ctx.send_tx(&[&payer_ref, creator], &[ix]);
    proposal_pda
}

/// Cast a vote without CPI accounts (for pre-quorum votes).
fn cast_vote_no_cpi(
    ctx: &mut DWalletTestContext,
    voting_program_id: &Pubkey,
    proposal_pda: &Pubkey,
    council: &Pubkey,
    voter: &Keypair,
    proposal_id: [u8; 32],
    vote: u8,
) {
    let voter_pubkey = keypair_pubkey(voter);
    let (vr_pda, vr_bump) = Pubkey::find_program_address(
        &[b"vote", &proposal_id, voter_pubkey.as_ref()],
        voting_program_id,
    );
    let payer_ref = ctx.clone_payer();
    let ix = build_cast_vote_ix(
        voting_program_id,
        proposal_pda,
        &vr_pda,
        council,
        &voter_pubkey,
        &keypair_pubkey(&payer_ref),
        proposal_id,
        vote,
        vr_bump,
        0,
    );
    ctx.send_tx(&[&payer_ref, voter], &[ix]);
}

/// Assert that a transaction failed with the given custom program error
/// (litesvm's failure metadata renders the error as `Custom(<code>)`).
fn assert_custom_error<T: std::fmt::Debug, E: std::fmt::Debug>(result: Result<T, E>, code: u32) {
    match result {
        Ok(meta) => panic!("expected Custom({code}) failure, transaction succeeded: {meta:?}"),
        Err(failed) => {
            let rendered = format!("{failed:?}");
            assert!(
                rendered.contains(&format!("Custom({code})")),
                "expected Custom({code}), got {rendered}"
            );
        }
    }
}

fn read_u32(data: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(data[offset..offset.saturating_add(4)].try_into().unwrap())
}

fn read_u16(data: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(data[offset..offset.saturating_add(2)].try_into().unwrap())
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

/// Full lifecycle: deploy programs -> create dWallet -> create council ->
/// transfer ownership -> create proposal -> cast 3 votes (quorum) -> verify
/// the SignatureVoucher exists.
#[test]
fn test_voting_full_lifecycle() {
    let mut ctx = DWalletTestContext::new();
    let voting_program_id = ctx.deploy_program(VOTING_PROGRAM_BINARY);
    let (cpi_authority, cpi_authority_bump) = ctx.cpi_authority_for(&voting_program_id);

    let governed = setup_governed(&mut ctx, &voting_program_id, [0xAAu8; 32], 3, 3);

    // The council was written as expected.
    let council_data = ctx
        .get_account_data(&governed.council)
        .expect("council should exist");
    assert_eq!(council_data.len(), COUNCIL_LEN, "council account length");
    assert_eq!(
        &council_data[2..34],
        governed.dwallet.as_ref(),
        "council.dwallet"
    );

    // The dWallet owner is now the CPI authority PDA.
    let dw_data = ctx
        .get_account_data(&governed.dwallet)
        .expect("dWallet should exist");
    let stored_owner = Pubkey::new_from_array(dw_data[DW_OWNER..DW_OWNER + 32].try_into().unwrap());
    assert_eq!(
        stored_owner, cpi_authority,
        "dWallet owner should be the CPI authority PDA"
    );

    let proposal_id = [0x01u8; 32];
    let message_hash = [0xBBu8; 32];
    let user_pubkey = [0xCCu8; 32];
    let proposal_pda = create_proposal(
        &mut ctx,
        &voting_program_id,
        &governed,
        &governed.members[0],
        proposal_id,
        message_hash,
        user_pubkey,
    );

    let prop_data = ctx
        .get_account_data(&proposal_pda)
        .expect("proposal should exist");
    assert_eq!(prop_data.len(), PROPOSAL_LEN, "proposal account length");
    assert_eq!(
        &prop_data[PROP_PROPOSAL_ID..PROP_PROPOSAL_ID + 32],
        &proposal_id
    );
    assert_eq!(
        read_u32(&prop_data, PROP_QUORUM),
        3,
        "quorum comes from the council"
    );
    assert_eq!(prop_data[PROP_STATUS], STATUS_OPEN, "status = Open");

    // Votes 1 and 2: no CPI triggered (quorum not reached).
    for (index, member) in governed.members.iter().take(2).enumerate() {
        cast_vote_no_cpi(
            &mut ctx,
            &voting_program_id,
            &proposal_pda,
            &governed.council,
            member,
            proposal_id,
            1,
        );
        let prop_data = ctx.get_account_data(&proposal_pda).unwrap();
        assert_eq!(read_u32(&prop_data, PROP_YES_VOTES), index as u32 + 1);
        assert_eq!(prop_data[PROP_STATUS], STATUS_OPEN, "status still Open");
    }

    // Vote 3 (quorum reached — CPI triggered).
    let voter_three = &governed.members[2];
    let voter_three_pubkey = keypair_pubkey(voter_three);
    let (vr_pda_three, vr_bump_three) = Pubkey::find_program_address(
        &[b"vote", &proposal_id, voter_three_pubkey.as_ref()],
        &voting_program_id,
    );
    let (voucher_pda, _) = signature_voucher_pda(&voting_program_id, &proposal_id);
    let payer_ref = ctx.clone_payer();
    let ix = with_cpi_accounts(
        build_cast_vote_ix(
            &voting_program_id,
            &proposal_pda,
            &vr_pda_three,
            &governed.council,
            &voter_three_pubkey,
            &keypair_pubkey(&payer_ref),
            proposal_id,
            1,
            vr_bump_three,
            cpi_authority_bump,
        ),
        &CpiAccounts {
            coordinator: ctx.coordinator_pda,
            signature_voucher: voucher_pda,
            dwallet: governed.dwallet,
            voting_program: voting_program_id,
            cpi_authority,
            dwallet_program: ctx.dwallet_program_id,
        },
    );
    ctx.send_tx(&[&payer_ref, voter_three], &[ix]);

    let prop_data = ctx.get_account_data(&proposal_pda).unwrap();
    assert_eq!(read_u32(&prop_data, PROP_YES_VOTES), 3, "yes_votes = 3");
    assert_eq!(
        prop_data[PROP_STATUS], STATUS_APPROVED,
        "proposal status should be Approved"
    );

    // The SignatureVoucher was created at the voting program's PDA.
    let voucher_data = ctx
        .get_account_data(&voucher_pda)
        .expect("the SignatureVoucher should exist after quorum");
    assert_eq!(
        voucher_data.len(),
        SIGNATURE_VOUCHER_LEN,
        "SignatureVoucher account length"
    );
    assert_eq!(
        voucher_data[0], DISC_SIGNATURE_VOUCHER,
        "SignatureVoucher discriminator"
    );
    assert_eq!(voucher_data[1], 1, "SignatureVoucher version");
    assert_eq!(
        &voucher_data[SV_DWALLET..SV_DWALLET + 32],
        governed.dwallet.as_ref(),
        "voucher.dwallet"
    );
    assert_eq!(
        &voucher_data[SV_MESSAGE_DIGEST..SV_MESSAGE_DIGEST + 32],
        &message_hash,
        "voucher.message_digest"
    );
    assert_eq!(
        &voucher_data[SV_OWNER..SV_OWNER + 32],
        cpi_authority.as_ref(),
        "voucher.owner should be the CPI authority PDA, the issuer"
    );
    assert_eq!(
        voucher_data[SV_HAS_SIGNING_KEY], 1,
        "voucher has a signing key"
    );
    assert_eq!(
        &voucher_data[SV_SIGNING_KEY..SV_SIGNING_KEY + 32],
        &user_pubkey,
        "voucher.signing_key is the proposal's user_pubkey"
    );
    assert_eq!(
        read_u16(&voucher_data, SV_SIGNATURE_SCHEME),
        0,
        "voucher.signature_scheme"
    );
    assert_eq!(
        voucher_data[SV_STATUS], SV_STATUS_PENDING,
        "voucher.status should be Pending"
    );
}

/// Voting on a proposal that doesn't reach quorum does NOT create a voucher.
#[test]
fn test_voting_below_quorum_no_voucher() {
    let mut ctx = DWalletTestContext::new();
    let voting_program_id = ctx.deploy_program(VOTING_PROGRAM_BINARY);
    let governed = setup_governed(&mut ctx, &voting_program_id, [0xAAu8; 32], 5, 5);

    let proposal_id = [0x02u8; 32];
    let message_hash = [0xDDu8; 32];
    let proposal_pda = create_proposal(
        &mut ctx,
        &voting_program_id,
        &governed,
        &governed.members[0],
        proposal_id,
        message_hash,
        [0u8; 32],
    );

    // Cast 2 votes (below quorum of 5).
    for member in governed.members.iter().take(2) {
        cast_vote_no_cpi(
            &mut ctx,
            &voting_program_id,
            &proposal_pda,
            &governed.council,
            member,
            proposal_id,
            1,
        );
    }

    let prop_data = ctx.get_account_data(&proposal_pda).unwrap();
    assert_eq!(prop_data[PROP_STATUS], STATUS_OPEN, "status should be Open");
    assert_eq!(read_u32(&prop_data, PROP_YES_VOTES), 2, "yes_votes = 2");

    let (voucher_pda, _) = signature_voucher_pda(&voting_program_id, &proposal_id);
    assert!(
        ctx.get_account_data(&voucher_pda).is_none(),
        "the voucher should not exist before quorum"
    );
}

/// "no" votes don't contribute to quorum.
#[test]
fn test_no_votes_dont_trigger_quorum() {
    let mut ctx = DWalletTestContext::new();
    let voting_program_id = ctx.deploy_program(VOTING_PROGRAM_BINARY);
    let governed = setup_governed(&mut ctx, &voting_program_id, [0xBBu8; 32], 2, 3);

    let proposal_id = [0x03u8; 32];
    let message_hash = [0xEEu8; 32];
    let proposal_pda = create_proposal(
        &mut ctx,
        &voting_program_id,
        &governed,
        &governed.members[0],
        proposal_id,
        message_hash,
        [0u8; 32],
    );

    // Cast 3 "no" votes — none should trigger quorum.
    for member in &governed.members {
        cast_vote_no_cpi(
            &mut ctx,
            &voting_program_id,
            &proposal_pda,
            &governed.council,
            member,
            proposal_id,
            0,
        );
    }

    let prop_data = ctx.get_account_data(&proposal_pda).unwrap();
    assert_eq!(
        prop_data[PROP_STATUS], STATUS_OPEN,
        "status should still be Open"
    );
    assert_eq!(read_u32(&prop_data, PROP_YES_VOTES), 0, "yes_votes = 0");
    assert_eq!(read_u32(&prop_data, PROP_NO_VOTES), 3, "no_votes = 3");

    let (voucher_pda, _) = signature_voucher_pda(&voting_program_id, &proposal_id);
    assert!(
        ctx.get_account_data(&voucher_pda).is_none(),
        "the voucher should not exist with only 'no' votes"
    );
}

/// An outsider can neither vote on a council's proposal nor create a council
/// for a dWallet the program already controls (its owner is the CPI PDA,
/// which nobody can sign for).
#[test]
fn test_outsider_cannot_vote_or_recreate_council() {
    let mut ctx = DWalletTestContext::new();
    let voting_program_id = ctx.deploy_program(VOTING_PROGRAM_BINARY);
    let governed = setup_governed(&mut ctx, &voting_program_id, [0xA1u8; 32], 1, 2);

    let proposal_id = [0x04u8; 32];
    let proposal_pda = create_proposal(
        &mut ctx,
        &voting_program_id,
        &governed,
        &governed.members[0],
        proposal_id,
        [0x11u8; 32],
        [0u8; 32],
    );

    // Outsider votes: rejected as not-a-member.
    let outsider = ctx.new_funded_keypair();
    let outsider_pubkey = keypair_pubkey(&outsider);
    let (vr_pda, vr_bump) = Pubkey::find_program_address(
        &[b"vote", &proposal_id, outsider_pubkey.as_ref()],
        &voting_program_id,
    );
    let payer_ref = ctx.clone_payer();
    let ix = build_cast_vote_ix(
        &voting_program_id,
        &proposal_pda,
        &vr_pda,
        &governed.council,
        &outsider_pubkey,
        &keypair_pubkey(&payer_ref),
        proposal_id,
        1,
        vr_bump,
        0,
    );
    let result = ctx.try_send_tx(&[&payer_ref, &outsider], &[ix]);
    assert_custom_error(result, ERR_NOT_A_MEMBER);

    // Outsider proposes: rejected as not-a-member.
    let (other_proposal, other_bump) =
        Pubkey::find_program_address(&[b"proposal", &[0x05u8; 32]], &voting_program_id);
    let payer_ref = ctx.clone_payer();
    let ix = build_create_proposal_ix(
        &voting_program_id,
        &other_proposal,
        &governed.council,
        &governed.dwallet,
        &outsider_pubkey,
        &keypair_pubkey(&payer_ref),
        [0x05u8; 32],
        [0x22u8; 32],
        [0u8; 32],
        0,
        0,
        other_bump,
    );
    let result = ctx.try_send_tx(&[&payer_ref, &outsider], &[ix]);
    assert_custom_error(result, ERR_NOT_A_MEMBER);

    // Outsider tries to (re)create the council for the governed dWallet: the
    // dWallet's owner is the CPI PDA now, so no signer can pass the check
    // (and the council PDA already exists anyway).
    let payer_ref = ctx.clone_payer();
    let ix = build_create_council_ix(
        &voting_program_id,
        &governed.council,
        &governed.dwallet,
        &ctx.dwallet_program_id,
        &outsider_pubkey,
        &keypair_pubkey(&payer_ref),
        1,
        &[outsider_pubkey],
    );
    let result = ctx.try_send_tx(&[&payer_ref, &outsider], &[ix]);
    assert_custom_error(result, ERR_NOT_DWALLET_OWNER);
}

/// The confused-deputy attack: an attacker governs their OWN dWallet through
/// this program (their own council, quorum 1), reaches quorum on their own
/// proposal, but passes the VICTIM's dWallet as the CPI target. The program
/// must refuse — the CPI authority PDA is shared by every dWallet the program
/// controls, so a voucher may be issued only on the proposal's own dWallet.
#[test]
fn test_quorum_cannot_be_redirected_to_another_councils_dwallet() {
    let mut ctx = DWalletTestContext::new();
    let voting_program_id = ctx.deploy_program(VOTING_PROGRAM_BINARY);
    let (cpi_authority, cpi_authority_bump) = ctx.cpi_authority_for(&voting_program_id);

    let victim = setup_governed(&mut ctx, &voting_program_id, [0xC1u8; 32], 2, 3);
    let attacker = setup_governed(&mut ctx, &voting_program_id, [0xC2u8; 32], 1, 1);

    let proposal_id = [0x06u8; 32];
    let message_hash = [0x99u8; 32];
    let proposal_pda = create_proposal(
        &mut ctx,
        &voting_program_id,
        &attacker,
        &attacker.members[0],
        proposal_id,
        message_hash,
        [0xFFu8; 32],
    );
    // The voucher the attacker's proposal would issue. Absent the binding,
    // the CPI would issue it on the victim's dWallet.
    let (voucher_pda, _) = signature_voucher_pda(&voting_program_id, &proposal_id);

    // Attacker's single vote reaches quorum; the CPI accounts name the
    // victim's dWallet.
    let voter = &attacker.members[0];
    let voter_pubkey = keypair_pubkey(voter);
    let (vr_pda, vr_bump) = Pubkey::find_program_address(
        &[b"vote", &proposal_id, voter_pubkey.as_ref()],
        &voting_program_id,
    );
    let payer_ref = ctx.clone_payer();
    let ix = with_cpi_accounts(
        build_cast_vote_ix(
            &voting_program_id,
            &proposal_pda,
            &vr_pda,
            &attacker.council,
            &voter_pubkey,
            &keypair_pubkey(&payer_ref),
            proposal_id,
            1,
            vr_bump,
            cpi_authority_bump,
        ),
        &CpiAccounts {
            coordinator: ctx.coordinator_pda,
            signature_voucher: voucher_pda,
            dwallet: victim.dwallet,
            voting_program: voting_program_id,
            cpi_authority,
            dwallet_program: ctx.dwallet_program_id,
        },
    );
    let result = ctx.try_send_tx(&[&payer_ref, voter], &[ix]);
    assert_custom_error(result, ERR_DWALLET_MISMATCH);

    assert!(
        ctx.get_account_data(&voucher_pda).is_none(),
        "no voucher may be issued on the victim's dWallet"
    );
    let prop_data = ctx.get_account_data(&proposal_pda).unwrap();
    assert_eq!(
        prop_data[PROP_STATUS], STATUS_OPEN,
        "the failed transaction rolled back"
    );
}

/// A proposal must carry the canonical bump of its voucher PDA. Another
/// valid bump would put the voucher at an address clients do not compute,
/// and the proposal would pass without a signature anyone can find, so the
/// program refuses it at creation and no proposal is written.
#[test]
fn test_create_proposal_refuses_a_non_canonical_voucher_bump() {
    let mut ctx = DWalletTestContext::new();
    let voting_program_id = ctx.deploy_program(VOTING_PROGRAM_BINARY);
    let governed = setup_governed(&mut ctx, &voting_program_id, [0xD1u8; 32], 1, 1);

    let proposal_id = [0x07u8; 32];
    let (_, canonical_bump) = signature_voucher_pda(&voting_program_id, &proposal_id);
    // A bump below the canonical one that still derives a valid address.
    let other_bump = (0..canonical_bump)
        .rev()
        .find(|bump| {
            Pubkey::create_program_address(
                &[b"signature_voucher", &proposal_id, &[*bump]],
                &voting_program_id,
            )
            .is_ok()
        })
        .expect("some bump below the canonical one derives an address");

    let (proposal_pda, proposal_bump) =
        Pubkey::find_program_address(&[b"proposal", &proposal_id], &voting_program_id);
    let creator = &governed.members[0];
    let payer_ref = ctx.clone_payer();
    let ix = build_create_proposal_ix(
        &voting_program_id,
        &proposal_pda,
        &governed.council,
        &governed.dwallet,
        &keypair_pubkey(creator),
        &keypair_pubkey(&payer_ref),
        proposal_id,
        [0x42u8; 32],
        [0xCCu8; 32],
        0,
        other_bump,
        proposal_bump,
    );
    let result = ctx.try_send_tx(&[&payer_ref, creator], &[ix]);
    assert_custom_error(result, ERR_INVALID_VOUCHER_BUMP);
    assert!(
        ctx.get_account_data(&proposal_pda).is_none(),
        "no proposal is written with a non-canonical voucher bump"
    );
}

/// The quorum vote must issue the voucher at the proposal's voucher PDA. A
/// voter who passes a fresh keypair in the voucher slot, and signs the
/// transaction with it, would get the dWallet program to accept it: an outer
/// transaction's signatures carry through the CPI. The voting program
/// checks the address first, so the vote is refused, no voucher is created
/// anywhere, and the proposal stays open.
#[test]
fn test_quorum_vote_refuses_a_substituted_voucher_account() {
    let mut ctx = DWalletTestContext::new();
    let voting_program_id = ctx.deploy_program(VOTING_PROGRAM_BINARY);
    let (cpi_authority, cpi_authority_bump) = ctx.cpi_authority_for(&voting_program_id);
    let governed = setup_governed(&mut ctx, &voting_program_id, [0xD2u8; 32], 1, 1);

    let proposal_id = [0x08u8; 32];
    let proposal_pda = create_proposal(
        &mut ctx,
        &voting_program_id,
        &governed,
        &governed.members[0],
        proposal_id,
        [0x43u8; 32],
        [0xCCu8; 32],
    );
    let (voucher_pda, _) = signature_voucher_pda(&voting_program_id, &proposal_id);

    let voter = &governed.members[0];
    let voter_pubkey = keypair_pubkey(voter);
    let (vr_pda, vr_bump) = Pubkey::find_program_address(
        &[b"vote", &proposal_id, voter_pubkey.as_ref()],
        &voting_program_id,
    );
    let substitute = Keypair::new();
    let substitute_pubkey = keypair_pubkey(&substitute);
    let payer_ref = ctx.clone_payer();
    let mut ix = with_cpi_accounts(
        build_cast_vote_ix(
            &voting_program_id,
            &proposal_pda,
            &vr_pda,
            &governed.council,
            &voter_pubkey,
            &keypair_pubkey(&payer_ref),
            proposal_id,
            1,
            vr_bump,
            cpi_authority_bump,
        ),
        &CpiAccounts {
            coordinator: ctx.coordinator_pda,
            signature_voucher: substitute_pubkey,
            dwallet: governed.dwallet,
            voting_program: voting_program_id,
            cpi_authority,
            dwallet_program: ctx.dwallet_program_id,
        },
    );
    // The substitute signs the outer transaction.
    ix.accounts[7].is_signer = true;
    let result = ctx.try_send_tx(&[&payer_ref, voter, &substitute], &[ix]);
    assert_custom_error(result, ERR_VOUCHER_MISMATCH);

    assert!(
        ctx.get_account_data(&substitute_pubkey).is_none(),
        "no voucher is created at the substituted address"
    );
    assert!(
        ctx.get_account_data(&voucher_pda).is_none(),
        "no voucher is created at the proposal's voucher PDA either"
    );
    let prop_data = ctx.get_account_data(&proposal_pda).unwrap();
    assert_eq!(
        prop_data[PROP_STATUS], STATUS_OPEN,
        "the proposal stays open"
    );
}

/// A bump below the canonical one for `seeds` that still derives a valid
/// address, and that address.
fn non_canonical_pda(seeds: &[&[u8]], program_id: &Pubkey) -> (Pubkey, u8) {
    let (_, canonical) = Pubkey::find_program_address(seeds, program_id);
    (0..canonical)
        .rev()
        .find_map(|bump| {
            let bump_bytes = [bump];
            let with_bump: Vec<&[u8]> = seeds.iter().copied().chain([&bump_bytes[..]]).collect();
            Pubkey::create_program_address(&with_bump, program_id)
                .ok()
                .map(|address| (address, bump))
        })
        .expect("some bump below the canonical one derives an address")
}

/// A vote record exists once per voter and proposal only at its canonical
/// address. A member who votes, then votes again with another bump that
/// derives a second valid address, is refused: otherwise the second record
/// would be created and the member's vote counted twice.
#[test]
fn test_a_member_cannot_vote_twice_with_a_second_bump() {
    let mut ctx = DWalletTestContext::new();
    let voting_program_id = ctx.deploy_program(VOTING_PROGRAM_BINARY);
    let governed = setup_governed(&mut ctx, &voting_program_id, [0xD2u8; 32], 3, 3);
    let proposal_id = [0x08u8; 32];
    let voter = &governed.members[0];
    let proposal_pda = create_proposal(
        &mut ctx,
        &voting_program_id,
        &governed,
        voter,
        proposal_id,
        [0x42u8; 32],
        [0xCCu8; 32],
    );
    cast_vote_no_cpi(
        &mut ctx,
        &voting_program_id,
        &proposal_pda,
        &governed.council,
        voter,
        proposal_id,
        1,
    );

    let voter_pubkey = keypair_pubkey(voter);
    let (second_record, second_bump) = non_canonical_pda(
        &[b"vote", &proposal_id, voter_pubkey.as_ref()],
        &voting_program_id,
    );
    let payer_ref = ctx.clone_payer();
    let ix = build_cast_vote_ix(
        &voting_program_id,
        &proposal_pda,
        &second_record,
        &governed.council,
        &voter_pubkey,
        &keypair_pubkey(&payer_ref),
        proposal_id,
        1,
        second_bump,
        0,
    );
    let result = ctx.try_send_tx(&[&payer_ref, voter], &[ix]);
    assert_custom_error(result, ERR_INVALID_BUMP);
    assert!(
        ctx.get_account_data(&second_record).is_none(),
        "no second vote record is written"
    );
    let prop_data = ctx.get_account_data(&proposal_pda).unwrap();
    assert_eq!(
        read_u32(&prop_data, PROP_YES_VOTES),
        1,
        "the vote counts once"
    );
}

/// A proposal exists only at its canonical address, so a second proposal
/// with the same identifier cannot be created at another bump's address.
#[test]
fn test_create_proposal_refuses_a_non_canonical_proposal_bump() {
    let mut ctx = DWalletTestContext::new();
    let voting_program_id = ctx.deploy_program(VOTING_PROGRAM_BINARY);
    let governed = setup_governed(&mut ctx, &voting_program_id, [0xD3u8; 32], 1, 1);
    let proposal_id = [0x09u8; 32];
    let (_, voucher_bump) = signature_voucher_pda(&voting_program_id, &proposal_id);
    let (proposal_pda, proposal_bump) =
        non_canonical_pda(&[b"proposal", &proposal_id], &voting_program_id);
    let creator = &governed.members[0];
    let payer_ref = ctx.clone_payer();
    let ix = build_create_proposal_ix(
        &voting_program_id,
        &proposal_pda,
        &governed.council,
        &governed.dwallet,
        &keypair_pubkey(creator),
        &keypair_pubkey(&payer_ref),
        proposal_id,
        [0x42u8; 32],
        [0xCCu8; 32],
        0,
        voucher_bump,
        proposal_bump,
    );
    let result = ctx.try_send_tx(&[&payer_ref, creator], &[ix]);
    assert_custom_error(result, ERR_INVALID_BUMP);
    assert!(
        ctx.get_account_data(&proposal_pda).is_none(),
        "no proposal is written at a non-canonical address"
    );
}

/// `DWalletContext` calls no program but ika's as the dWallet program. The
/// quorum vote hands the context whatever program the caller put in the
/// dWallet-program slot. Here that is another executable program, this
/// voting program itself, and the context refuses it with
/// `IncorrectProgramId` before any call: otherwise the program the caller
/// chose would be called with this program's CPI authority as a signer, and
/// could use that signature on the real ika program.
#[test]
fn test_dwallet_context_refuses_a_program_that_is_not_ika() {
    let mut ctx = DWalletTestContext::new();
    let voting_program_id = ctx.deploy_program(VOTING_PROGRAM_BINARY);
    let governed = setup_governed(&mut ctx, &voting_program_id, [0xD4u8; 32], 1, 1);
    let proposal_id = [0x0Au8; 32];
    let voter = &governed.members[0];
    let proposal_pda = create_proposal(
        &mut ctx,
        &voting_program_id,
        &governed,
        voter,
        proposal_id,
        [0x42u8; 32],
        [0xCCu8; 32],
    );
    let (cpi_authority, cpi_authority_bump) = ctx.cpi_authority_for(&voting_program_id);
    let voter_pubkey = keypair_pubkey(voter);
    let (vote_record, vote_record_bump) = Pubkey::find_program_address(
        &[b"vote", &proposal_id, voter_pubkey.as_ref()],
        &voting_program_id,
    );
    let (voucher_pda, _) = signature_voucher_pda(&voting_program_id, &proposal_id);
    let payer_ref = ctx.clone_payer();
    let ix = with_cpi_accounts(
        build_cast_vote_ix(
            &voting_program_id,
            &proposal_pda,
            &vote_record,
            &governed.council,
            &voter_pubkey,
            &keypair_pubkey(&payer_ref),
            proposal_id,
            1,
            vote_record_bump,
            cpi_authority_bump,
        ),
        &CpiAccounts {
            coordinator: ctx.coordinator_pda,
            signature_voucher: voucher_pda,
            dwallet: governed.dwallet,
            voting_program: voting_program_id,
            cpi_authority,
            dwallet_program: voting_program_id,
        },
    );
    let rendered = format!("{:?}", ctx.try_send_tx(&[&payer_ref, voter], &[ix]));
    assert!(
        rendered.contains("IncorrectProgramId"),
        "expected IncorrectProgramId, got {rendered}"
    );
    assert!(
        ctx.get_account_data(&voucher_pda).is_none(),
        "no voucher is issued"
    );
}
