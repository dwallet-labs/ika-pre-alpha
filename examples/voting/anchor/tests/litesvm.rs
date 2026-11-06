// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! LiteSVM end-to-end tests for the Anchor voting example.
//!
//! Tests the full CPI flow against the real dWallet program: create council
//! -> transfer the dWallet to the CPI authority -> create proposal -> cast
//! votes -> quorum triggers issue_signature_voucher CPI -> SignatureVoucher
//! created at the voting program's PDA — plus the two attacks the council
//! binding exists to
//! stop: outsiders voting, and one council's proposal being executed against
//! another council's dWallet.
//!
//! Uses Anchor instruction serialization (8-byte discriminator + borsh args).

use ika_dwallet_litesvm_test::*;
use solana_keypair::Keypair;

/// Path to the compiled SBF binary for the Anchor voting example.
const VOTING_PROGRAM_BINARY: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../target/deploy/ika_example_voting_anchor.so"
);

// ── Anchor instruction discriminators ──
const CREATE_COUNCIL_DISC: [u8; 8] = [139, 168, 163, 13, 74, 173, 186, 168];
const CREATE_PROPOSAL_DISC: [u8; 8] = [132, 116, 68, 174, 216, 160, 198, 22];
const CAST_VOTE_DISC: [u8; 8] = [20, 212, 15, 189, 69, 180, 69, 151];

// ── Anchor account discriminators ──
const COUNCIL_DISC: [u8; 8] = [28, 184, 149, 185, 217, 59, 252, 96];
const PROPOSAL_DISC: [u8; 8] = [26, 94, 189, 187, 116, 136, 53, 33];

// ── Account sizes ──
const COUNCIL_LEN: usize = 369;
const PROPOSAL_LEN: usize = 184;

// ── Proposal offsets (after 8-byte Anchor discriminator) ──
const PROP_PROPOSAL_ID: usize = 8;
const PROP_YES_VOTES: usize = 170;
const PROP_NO_VOTES: usize = 174;
const PROP_QUORUM: usize = 178;
const PROP_STATUS: usize = 182;

// ── Status values (Anchor enum: Open=0, Approved=1, Rejected=2) ──
const STATUS_OPEN: u8 = 0;
const STATUS_APPROVED: u8 = 1;

// ── Anchor error codes (`VotingError`, 6000 + index) ──
const ERR_NOT_A_MEMBER: u32 = 6003;
const ERR_DWALLET_MISMATCH: u32 = 6004;
const ERR_NOT_DWALLET_OWNER: u32 = 6005;

// ═══════════════════════════════════════════════════════════════════════
// Instruction builders
// ═══════════════════════════════════════════════════════════════════════

/// Build a CreateCouncil instruction (Anchor serialization).
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
    let mut ix_data = Vec::with_capacity(16);
    ix_data.extend_from_slice(&CREATE_COUNCIL_DISC);
    ix_data.extend_from_slice(&quorum.to_le_bytes());
    ix_data.extend_from_slice(&(members.len() as u32).to_le_bytes());
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

/// Build a CreateProposal instruction (Anchor serialization).
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
) -> Instruction {
    let mut ix_data = Vec::with_capacity(107);
    ix_data.extend_from_slice(&CREATE_PROPOSAL_DISC);
    ix_data.extend_from_slice(&proposal_id);
    ix_data.extend_from_slice(&message_hash);
    ix_data.extend_from_slice(&user_pubkey);
    ix_data.extend_from_slice(&signature_scheme.to_le_bytes());
    ix_data.push(signature_voucher_bump);

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

/// CPI accounts (always present for Anchor) of a CastVote instruction.
struct CpiAccounts {
    coordinator: Pubkey,
    signature_voucher: Pubkey,
    dwallet: Pubkey,
    program: Pubkey,
    cpi_authority: Pubkey,
    dwallet_program: Pubkey,
}

/// Build a CastVote instruction (Anchor serialization).
fn build_cast_vote_ix(
    program_id: &Pubkey,
    proposal: &Pubkey,
    vote_record: &Pubkey,
    council: &Pubkey,
    voter: &Pubkey,
    payer: &Pubkey,
    proposal_id: [u8; 32],
    vote: bool,
    cpi_authority_bump: u8,
    cpi: &CpiAccounts,
) -> Instruction {
    let mut ix_data = Vec::with_capacity(42);
    ix_data.extend_from_slice(&CAST_VOTE_DISC);
    ix_data.extend_from_slice(&proposal_id);
    ix_data.push(if vote { 1 } else { 0 });
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
            AccountMeta::new_readonly(cpi.coordinator, false),
            AccountMeta::new(cpi.signature_voucher, false),
            AccountMeta::new_readonly(cpi.dwallet, false),
            AccountMeta::new_readonly(cpi.program, false),
            AccountMeta::new_readonly(cpi.cpi_authority, false),
            AccountMeta::new_readonly(cpi.dwallet_program, false),
        ],
        data: ix_data,
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

/// Anchor programs must be deployed at their `declare_id!` address.
fn deploy_voting(ctx: &mut DWalletTestContext) -> Pubkey {
    let voting_program_id: Pubkey = "LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY"
        .parse()
        .unwrap();
    ctx.deploy_program_at(&voting_program_id, VOTING_PROGRAM_BINARY);
    voting_program_id
}

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
    let (proposal_pda, _) =
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
    );
    ctx.send_tx(&[&payer_ref, creator], &[ix]);
    proposal_pda
}

/// The CPI account set for a vote on `governed`'s proposal `proposal_id`.
fn cpi_for(
    ctx: &DWalletTestContext,
    voting_program_id: &Pubkey,
    governed: &Governed,
    proposal_id: &[u8; 32],
) -> CpiAccounts {
    let (cpi_authority, _) = ctx.cpi_authority_for(voting_program_id);
    let (signature_voucher, _) = signature_voucher_pda(voting_program_id, proposal_id);
    CpiAccounts {
        coordinator: ctx.coordinator_pda,
        signature_voucher,
        dwallet: governed.dwallet,
        program: *voting_program_id,
        cpi_authority,
        dwallet_program: ctx.dwallet_program_id,
    }
}

/// Cast a vote by `voter` (a member); the CPI accounts must always be present
/// for Anchor, but are only invoked at quorum.
fn cast_vote(
    ctx: &mut DWalletTestContext,
    voting_program_id: &Pubkey,
    proposal_pda: &Pubkey,
    council: &Pubkey,
    voter: &Keypair,
    proposal_id: [u8; 32],
    vote: bool,
    cpi: &CpiAccounts,
) -> Result<(), String> {
    let (_, cpi_authority_bump) = ctx.cpi_authority_for(voting_program_id);
    let voter_pubkey = keypair_pubkey(voter);
    let (vr_pda, _) = Pubkey::find_program_address(
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
        cpi_authority_bump,
        cpi,
    );
    ctx.try_send_tx(&[&payer_ref, voter], &[ix])
        .map(|_| ())
        .map_err(|failed| format!("{failed:?}"))
}

/// Assert that a rendered transaction failure names the given custom error.
fn assert_custom_error(result: Result<(), String>, code: u32) {
    match result {
        Ok(()) => panic!("expected Custom({code}) failure, transaction succeeded"),
        Err(rendered) => assert!(
            rendered.contains(&format!("Custom({code})")),
            "expected Custom({code}), got {rendered}"
        ),
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
    let voting_program_id = deploy_voting(&mut ctx);
    let (cpi_authority, _) = ctx.cpi_authority_for(&voting_program_id);

    let governed = setup_governed(&mut ctx, &voting_program_id, [0xAAu8; 32], 3, 3);

    let council_data = ctx
        .get_account_data(&governed.council)
        .expect("council should exist");
    assert_eq!(council_data.len(), COUNCIL_LEN, "council account length");
    assert_eq!(&council_data[0..8], &COUNCIL_DISC, "council discriminator");
    assert_eq!(
        &council_data[8..40],
        governed.dwallet.as_ref(),
        "council.dwallet"
    );

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
    assert_eq!(&prop_data[0..8], &PROPOSAL_DISC, "proposal discriminator");
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

    let cpi = cpi_for(&ctx, &voting_program_id, &governed, &proposal_id);
    for (index, member) in governed.members.iter().enumerate() {
        cast_vote(
            &mut ctx,
            &voting_program_id,
            &proposal_pda,
            &governed.council,
            member,
            proposal_id,
            true,
            &cpi,
        )
        .expect("member vote should succeed");
        let prop_data = ctx.get_account_data(&proposal_pda).unwrap();
        assert_eq!(read_u32(&prop_data, PROP_YES_VOTES), index as u32 + 1);
    }

    let prop_data = ctx.get_account_data(&proposal_pda).unwrap();
    assert_eq!(
        prop_data[PROP_STATUS], STATUS_APPROVED,
        "proposal status should be Approved"
    );

    // The SignatureVoucher was created at the voting program's PDA.
    let voucher_data = ctx
        .get_account_data(&cpi.signature_voucher)
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
    let voting_program_id = deploy_voting(&mut ctx);
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

    let cpi = cpi_for(&ctx, &voting_program_id, &governed, &proposal_id);
    for member in governed.members.iter().take(2) {
        cast_vote(
            &mut ctx,
            &voting_program_id,
            &proposal_pda,
            &governed.council,
            member,
            proposal_id,
            true,
            &cpi,
        )
        .expect("member vote should succeed");
    }

    let prop_data = ctx.get_account_data(&proposal_pda).unwrap();
    assert_eq!(prop_data[PROP_STATUS], STATUS_OPEN, "status should be Open");
    assert_eq!(read_u32(&prop_data, PROP_YES_VOTES), 2, "yes_votes = 2");
    assert_eq!(read_u32(&prop_data, PROP_NO_VOTES), 0, "no_votes = 0");
    assert!(
        ctx.get_account_data(&cpi.signature_voucher).is_none(),
        "the voucher should not exist before quorum"
    );
}

/// An outsider can neither vote on a council's proposal nor create a council
/// for a dWallet the program already controls (its owner is the CPI PDA,
/// which nobody can sign for).
#[test]
fn test_outsider_cannot_vote_or_recreate_council() {
    let mut ctx = DWalletTestContext::new();
    let voting_program_id = deploy_voting(&mut ctx);
    let governed = setup_governed(&mut ctx, &voting_program_id, [0xA1u8; 32], 1, 2);

    let proposal_id = [0x04u8; 32];
    let message_hash = [0x11u8; 32];
    let proposal_pda = create_proposal(
        &mut ctx,
        &voting_program_id,
        &governed,
        &governed.members[0],
        proposal_id,
        message_hash,
        [0u8; 32],
    );

    // Outsider votes: rejected as not-a-member.
    let outsider = ctx.new_funded_keypair();
    let outsider_pubkey = keypair_pubkey(&outsider);
    let cpi = cpi_for(&ctx, &voting_program_id, &governed, &proposal_id);
    let result = cast_vote(
        &mut ctx,
        &voting_program_id,
        &proposal_pda,
        &governed.council,
        &outsider,
        proposal_id,
        true,
        &cpi,
    );
    assert_custom_error(result, ERR_NOT_A_MEMBER);
    assert!(
        ctx.get_account_data(&cpi.signature_voucher).is_none(),
        "no voucher may be issued by an outsider vote"
    );

    // Outsider proposes: rejected as not-a-member.
    let (other_proposal, _) =
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
    );
    let result = ctx
        .try_send_tx(&[&payer_ref, &outsider], &[ix])
        .map(|_| ())
        .map_err(|failed| format!("{failed:?}"));
    assert_custom_error(result, ERR_NOT_A_MEMBER);

    // Outsider tries to (re)create the council: the dWallet's owner is
    // the CPI PDA now, so no signer can pass the check (Anchor's `init` on
    // the existing PDA would fail as well; the owner check runs on a
    // fresh council address here to isolate it).
    let other_governed_dwallet = governed.dwallet;
    let payer_ref = ctx.clone_payer();
    let ix = build_create_council_ix(
        &voting_program_id,
        &council_pda(&voting_program_id, &other_governed_dwallet),
        &other_governed_dwallet,
        &ctx.dwallet_program_id,
        &outsider_pubkey,
        &keypair_pubkey(&payer_ref),
        1,
        &[outsider_pubkey],
    );
    let result = ctx
        .try_send_tx(&[&payer_ref, &outsider], &[ix])
        .map(|_| ())
        .map_err(|failed| format!("{failed:?}"));
    assert!(
        result.is_err(),
        "outsider must not be able to recreate the council"
    );
    // Either the PDA already exists (system program error) or, if it did not,
    // the owner check would fire; both leave the council unchanged.
    let council_data = ctx.get_account_data(&governed.council).unwrap();
    assert_eq!(&council_data[8..40], governed.dwallet.as_ref());
    assert_eq!(read_u32(&council_data, 45), 2, "member count unchanged");

    // And for a dWallet whose council does not exist yet but whose owner
    // is someone else, the outsider is rejected as not-the-owner.
    let victim_owner = ctx.new_funded_keypair();
    let fresh_dwallet = ctx.create_dwallet(
        &keypair_pubkey(&victim_owner),
        CURVE_CURVE25519,
        32,
        &[0xA2u8; 32],
    );
    let payer_ref = ctx.clone_payer();
    let ix = build_create_council_ix(
        &voting_program_id,
        &council_pda(&voting_program_id, &fresh_dwallet),
        &fresh_dwallet,
        &ctx.dwallet_program_id,
        &outsider_pubkey,
        &keypair_pubkey(&payer_ref),
        1,
        &[outsider_pubkey],
    );
    let result = ctx
        .try_send_tx(&[&payer_ref, &outsider], &[ix])
        .map(|_| ())
        .map_err(|failed| format!("{failed:?}"));
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
    let voting_program_id = deploy_voting(&mut ctx);

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

    // Attacker's single vote reaches quorum; the CPI accounts name the
    // victim's dWallet. Absent the binding, the CPI would issue the
    // attacker's voucher on the victim's dWallet.
    let cpi = CpiAccounts {
        dwallet: victim.dwallet,
        ..cpi_for(&ctx, &voting_program_id, &attacker, &proposal_id)
    };
    let result = cast_vote(
        &mut ctx,
        &voting_program_id,
        &proposal_pda,
        &attacker.council,
        &attacker.members[0],
        proposal_id,
        true,
        &cpi,
    );
    assert_custom_error(result, ERR_DWALLET_MISMATCH);

    assert!(
        ctx.get_account_data(&cpi.signature_voucher).is_none(),
        "no voucher may be issued on the victim's dWallet"
    );
    let prop_data = ctx.get_account_data(&proposal_pda).unwrap();
    assert_eq!(
        prop_data[PROP_STATUS], STATUS_OPEN,
        "the failed transaction rolled back"
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
    let voting_program_id = deploy_voting(&mut ctx);
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
    let mut cpi = cpi_for(&ctx, &voting_program_id, &governed, &proposal_id);
    cpi.dwallet_program = voting_program_id;
    let result = cast_vote(
        &mut ctx,
        &voting_program_id,
        &proposal_pda,
        &governed.council,
        voter,
        proposal_id,
        true,
        &cpi,
    );
    let rendered = format!("{result:?}");
    assert!(
        rendered.contains("IncorrectProgramId"),
        "expected IncorrectProgramId, got {rendered}"
    );
    assert!(
        ctx.get_account_data(&cpi.signature_voucher).is_none(),
        "no voucher is issued"
    );
}
