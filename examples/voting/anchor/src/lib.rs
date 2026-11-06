// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! Example: Voting-controlled dWallet signing (Anchor version).
//!
//! An Anchor program demonstrating program-controlled dWallets via the CPI
//! authority pattern. A dWallet is placed under the control of a **council** —
//! a fixed member list with a quorum — and its ownership is transferred to this
//! program's CPI authority PDA. Council members create proposals referencing the
//! council's dWallet; when enough "yes" votes are cast (reaching the council's
//! quorum), the program CPI-calls `issue_signature_voucher` on the dWallet
//! program to authorize signing. The voucher sits at this program's PDA
//! `["signature_voucher", proposal_id]`, and the program signs for it.
//!
//! # Why a council exists (read this before copying the pattern)
//!
//! The dWallet program authenticates a program caller by ONE PDA per program:
//! `["__ika_cpi_authority"]`. Every dWallet whose owner is that PDA is
//! controlled by this program as a whole, not by a particular proposal or
//! member set. So the program itself must decide, for every dWallet it
//! controls, *who* may approve — otherwise anyone could create their own
//! proposal (with their own quorum) targeting a dWallet somebody else handed
//! to the program, and approve any message with any signer key. Two rules
//! close that:
//!
//! 1. Exactly one `Council` per dWallet, at the PDA `["council", dwallet]`,
//!    created by the dWallet's *current* owner (verified against the
//!    dWallet account) BEFORE ownership is transferred to the CPI PDA. Its
//!    members and quorum are fixed at creation.
//! 2. Every proposal and vote is bound to that council: the proposal stores
//!    the council's dWallet, only council members may propose or vote, the
//!    quorum comes from the council, and at execution the dWallet account
//!    passed for the CPI must be the one the proposal was created for
//!    (`address = proposal.dwallet`).
//!
//! This is the Anchor equivalent of the Pinocchio `ika-example-voting-pinocchio` program.

use anchor_lang::prelude::*;
use ika_dwallet_anchor::{DWalletContext, ID as IKA_PROGRAM_ID};

// Placeholder program ID — replace with actual keypair before deployment.
declare_id!("LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY");

/// Maximum number of council members.
pub const MAX_MEMBERS: usize = 10;

/// Discriminator of a `DWallet` account in the dWallet program.
// The merged program ranges account discriminators by subsystem; the
// dWallet record is 97, not 2.
const DWALLET_ACCOUNT_DISCRIMINATOR: u8 = 97;
/// Offset of the `owner` field inside a `DWallet` account (after the
/// 2-byte discriminator + version header).
const DWALLET_OWNER_OFFSET: usize = 2;

#[program]
pub mod voting_anchor {
    use super::*;

    /// Fix the member list and quorum for a dWallet. Must be signed by the
    /// dWallet's CURRENT owner, before that ownership is transferred to
    /// this program's CPI authority PDA. One council per dWallet.
    pub fn create_council(
        ctx: Context<CreateCouncil>,
        quorum: u32,
        members: Vec<Pubkey>,
    ) -> Result<()> {
        require!(
            !members.is_empty() && members.len() <= MAX_MEMBERS,
            VotingError::TooManyMembers
        );
        require!(
            quorum > 0 && quorum as usize <= members.len(),
            VotingError::InvalidQuorum
        );
        let has_duplicate = members
            .iter()
            .enumerate()
            .any(|(index, member)| members[index.saturating_add(1)..].contains(member));
        require!(!has_duplicate, VotingError::DuplicateMember);

        // Only the dWallet's current owner may fix its governance.
        let dwallet_data = ctx.accounts.dwallet.try_borrow_data()?;
        require!(
            dwallet_data.first() == Some(&DWALLET_ACCOUNT_DISCRIMINATOR),
            VotingError::InvalidDWalletAccount
        );
        let stored_owner = dwallet_data
            .get(DWALLET_OWNER_OFFSET..)
            .and_then(|tail| tail.first_chunk::<32>())
            .ok_or(VotingError::InvalidDWalletAccount)?;
        require!(
            *stored_owner == ctx.accounts.owner.key().to_bytes(),
            VotingError::NotDWalletOwner
        );

        let council = &mut ctx.accounts.council;
        council.dwallet = ctx.accounts.dwallet.key();
        council.quorum = quorum;
        council.bump = ctx.bumps.council;
        council.members = members;
        Ok(())
    }

    /// Create a proposal PDA for the council's dWallet. The creator must be a
    /// council member; the quorum is the council's.
    pub fn create_proposal(
        ctx: Context<CreateProposal>,
        proposal_id: [u8; 32],
        message_digest: [u8; 32],
        user_pubkey: [u8; 32],
        signature_scheme: u16,
        signature_voucher_bump: u8,
    ) -> Result<()> {
        // The voucher's address is this program's PDA for the proposal, and
        // the program signs for it with the stored bump when the proposal
        // passes. A non-canonical bump would put the voucher at an address
        // clients do not compute, so only the canonical one is accepted.
        let (_, canonical_voucher_bump) = Pubkey::find_program_address(
            &[b"signature_voucher", proposal_id.as_ref()],
            ctx.program_id,
        );
        require!(
            signature_voucher_bump == canonical_voucher_bump,
            VotingError::InvalidVoucherBump
        );
        let proposal = &mut ctx.accounts.proposal;
        proposal.proposal_id = proposal_id;
        proposal.dwallet = ctx.accounts.dwallet.key();
        proposal.message_digest = message_digest;
        proposal.user_pubkey = user_pubkey;
        proposal.signature_scheme = signature_scheme;
        proposal.creator = ctx.accounts.creator.key();
        proposal.yes_votes = 0;
        proposal.no_votes = 0;
        proposal.quorum = ctx.accounts.council.quorum;
        proposal.status = ProposalStatus::Open;
        proposal.signature_voucher_bump = signature_voucher_bump;
        Ok(())
    }

    /// Cast a vote on a proposal (council members only). When quorum is
    /// reached, CPI-issues a signature voucher on the proposal's dWallet,
    /// with the proposal's `user_pubkey` as its signing key.
    pub fn cast_vote(
        ctx: Context<CastVote>,
        proposal_id: [u8; 32],
        vote: bool,
        cpi_authority_bump: u8,
    ) -> Result<()> {
        // Record vote.
        let vote_record = &mut ctx.accounts.vote_record;
        vote_record.voter = ctx.accounts.voter.key();
        vote_record.proposal_id = proposal_id;
        vote_record.vote = vote;

        // Update proposal.
        let proposal = &mut ctx.accounts.proposal;
        require!(
            proposal.status == ProposalStatus::Open,
            VotingError::ProposalClosed
        );

        if vote {
            proposal.yes_votes = proposal
                .yes_votes
                .checked_add(1)
                .ok_or(error!(VotingError::ArithmeticOverflow))?;
        } else {
            proposal.no_votes = proposal
                .no_votes
                .checked_add(1)
                .ok_or(error!(VotingError::ArithmeticOverflow))?;
        }

        // Check quorum — if reached, CPI-call issue_signature_voucher on the dWallet program.
        if proposal.yes_votes >= proposal.quorum {
            let dwallet_ctx = DWalletContext {
                dwallet_program: ctx.accounts.dwallet_program.to_account_info(),
                cpi_authority: ctx.accounts.cpi_authority.to_account_info(),
                caller_program: ctx.accounts.program.to_account_info(),
                cpi_authority_bump,
            };

            // No message metadata for voting — use all zeros.
            let message_metadata_digest = [0u8; 32];

            // The voucher is this program's PDA for the proposal, so the
            // program signs its creation.
            let voucher_seeds: &[&[u8]] = &[
                b"signature_voucher",
                proposal_id.as_ref(),
                &[proposal.signature_voucher_bump],
            ];

            dwallet_ctx.issue_signature_voucher(
                &ctx.accounts.coordinator.to_account_info(),
                &ctx.accounts.signature_voucher.to_account_info(),
                &ctx.accounts.dwallet.to_account_info(),
                &ctx.accounts.payer.to_account_info(),
                &ctx.accounts.system_program.to_account_info(),
                proposal.message_digest,
                message_metadata_digest,
                proposal.signature_scheme,
                None,
                Some(proposal.user_pubkey),
                Some(voucher_seeds),
            )?;

            proposal.status = ProposalStatus::Approved;
        }

        Ok(())
    }
}

// ── Accounts ──

#[derive(Accounts)]
pub struct CreateCouncil<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Council::INIT_SPACE,
        seeds = [b"council", dwallet.key().as_ref()],
        bump,
    )]
    pub council: Account<'info, Council>,

    /// CHECK: dWallet account; must be owned by the dWallet program, and its
    /// stored owner must be `owner` (checked in the handler).
    #[account(owner = IKA_PROGRAM_ID @ VotingError::InvalidDWalletAccount)]
    pub dwallet: UncheckedAccount<'info>,

    /// CHECK: The Ika dWallet program (must be executable).
    #[account(executable)]
    pub dwallet_program: UncheckedAccount<'info>,

    /// The dWallet's current owner.
    pub owner: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(proposal_id: [u8; 32])]
pub struct CreateProposal<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Proposal::INIT_SPACE,
        seeds = [b"proposal", proposal_id.as_ref()],
        bump,
    )]
    pub proposal: Account<'info, Proposal>,

    /// The council governing `dwallet`; the creator must be one of its members.
    #[account(
        seeds = [b"council", dwallet.key().as_ref()],
        bump = council.bump,
        constraint = council.members.contains(&creator.key()) @ VotingError::NotAMember,
    )]
    pub council: Account<'info, Council>,

    /// CHECK: dWallet account (owned by the dWallet program); bound to the
    /// council through the council's PDA seeds.
    pub dwallet: UncheckedAccount<'info>,

    pub creator: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(proposal_id: [u8; 32], vote: bool, cpi_authority_bump: u8)]
pub struct CastVote<'info> {
    #[account(
        mut,
        seeds = [b"proposal", proposal_id.as_ref()],
        bump,
    )]
    pub proposal: Account<'info, Proposal>,

    #[account(
        init,
        payer = payer,
        space = 8 + VoteRecord::INIT_SPACE,
        seeds = [b"vote", proposal_id.as_ref(), voter.key().as_ref()],
        bump,
    )]
    pub vote_record: Account<'info, VoteRecord>,

    /// The council of the proposal's dWallet; the voter must be a member.
    #[account(
        seeds = [b"council", proposal.dwallet.as_ref()],
        bump = council.bump,
        constraint = council.members.contains(&voter.key()) @ VotingError::NotAMember,
    )]
    pub council: Account<'info, Council>,

    pub voter: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,

    // CPI accounts (needed when quorum is reached).
    /// CHECK: DWalletCoordinator PDA on the dWallet program (for epoch).
    pub coordinator: UncheckedAccount<'info>,

    /// CHECK: The SignatureVoucher to create: this program's PDA
    /// `["signature_voucher", proposal_id]`, checked by the seeds below. A
    /// signer at another address would also be accepted by the dWallet
    /// program, because an outer transaction's signatures carry through the
    /// CPI, so the address itself is what this constraint checks.
    #[account(
        mut,
        seeds = [b"signature_voucher", proposal_id.as_ref()],
        bump = proposal.signature_voucher_bump,
    )]
    pub signature_voucher: UncheckedAccount<'info>,

    /// CHECK: dWallet account — must be the dWallet this proposal was created
    /// for, never a caller-chosen one (the CPI authority PDA is shared by
    /// every dWallet this program controls).
    #[account(address = proposal.dwallet @ VotingError::DWalletMismatch)]
    pub dwallet: UncheckedAccount<'info>,

    /// CHECK: This program's executable account (for CPI authority verification).
    pub program: UncheckedAccount<'info>,

    /// CHECK: CPI authority PDA (seeds: `[CPI_AUTHORITY_SEED]`, derived from this program).
    pub cpi_authority: UncheckedAccount<'info>,

    /// CHECK: The Ika dWallet program.
    pub dwallet_program: UncheckedAccount<'info>,
}

// ── State ──

/// The governance of one dWallet: who may propose/vote and how many "yes"
/// votes approve. One per dWallet at `["council", dwallet]`.
#[account]
#[derive(InitSpace)]
pub struct Council {
    pub dwallet: Pubkey,
    pub quorum: u32,
    pub bump: u8,
    #[max_len(10)]
    pub members: Vec<Pubkey>,
}

#[account]
#[derive(InitSpace)]
pub struct Proposal {
    pub proposal_id: [u8; 32],
    pub dwallet: Pubkey,
    pub message_digest: [u8; 32],
    pub user_pubkey: [u8; 32],
    pub signature_scheme: u16,
    pub creator: Pubkey,
    pub yes_votes: u32,
    pub no_votes: u32,
    pub quorum: u32,
    pub status: ProposalStatus,
    pub signature_voucher_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct VoteRecord {
    pub voter: Pubkey,
    pub proposal_id: [u8; 32],
    pub vote: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum ProposalStatus {
    Open,
    Approved,
    Rejected,
}

// ── Errors ──

#[error_code]
pub enum VotingError {
    #[msg("Proposal is not open for voting")]
    ProposalClosed,
    #[msg("Quorum must be at least 1 and at most the member count")]
    InvalidQuorum,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Signer is not a council member")]
    NotAMember,
    #[msg("dWallet account is not the proposal's dWallet")]
    DWalletMismatch,
    #[msg("Signer is not the dWallet's current owner")]
    NotDWalletOwner,
    #[msg("Account is not a DWallet owned by the dWallet program")]
    InvalidDWalletAccount,
    #[msg("Member list contains a duplicate")]
    DuplicateMember,
    #[msg("Member list must have between 1 and 10 entries")]
    TooManyMembers,
    #[msg("The voucher bump is not the canonical bump of the proposal's voucher PDA")]
    InvalidVoucherBump,
}
