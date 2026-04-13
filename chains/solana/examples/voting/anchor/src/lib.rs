// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! Example: Voting-controlled dWallet signing (Anchor version).
//!
//! An Anchor program demonstrating program-controlled dWallets via the CPI
//! authority pattern. Proposals are created referencing a dWallet whose authority
//! has been transferred to this program's CPI authority PDA. When enough "yes"
//! votes are cast (reaching quorum), the program automatically CPI-calls
//! `approve_message` on the dWallet program to authorize signing.
//!
//! This is the Anchor equivalent of the Pinocchio `ika-example-voting` program.

use anchor_lang::prelude::*;
use ika_dwallet_anchor::DWalletContext;

// Placeholder program ID — replace with actual keypair before deployment.
declare_id!("LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY");

#[program]
pub mod voting_anchor {
    use super::*;

    /// Create a proposal PDA with a target dWallet, message digest, and quorum.
    pub fn create_proposal(
        ctx: Context<CreateProposal>,
        proposal_id: [u8; 32],
        message_digest: [u8; 32],
        user_pubkey: [u8; 32],
        signature_scheme: u16,
        quorum: u32,
        message_approval_bump: u8,
    ) -> Result<()> {
        require!(quorum > 0, VotingError::InvalidQuorum);

        let proposal = &mut ctx.accounts.proposal;
        proposal.proposal_id = proposal_id;
        proposal.dwallet = ctx.accounts.dwallet.key();
        proposal.message_digest = message_digest;
        proposal.user_pubkey = user_pubkey;
        proposal.signature_scheme = signature_scheme;
        proposal.creator = ctx.accounts.creator.key();
        proposal.yes_votes = 0;
        proposal.no_votes = 0;
        proposal.quorum = quorum;
        proposal.status = ProposalStatus::Open;
        proposal.message_approval_bump = message_approval_bump;
        Ok(())
    }

    /// Cast a vote on a proposal. When quorum is reached, CPI-approves signing.
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

        // Check quorum — if reached, CPI-call approve_message on the dWallet program.
        if proposal.yes_votes >= proposal.quorum {
            let dwallet_ctx = DWalletContext {
                dwallet_program: ctx.accounts.dwallet_program.to_account_info(),
                cpi_authority: ctx.accounts.cpi_authority.to_account_info(),
                caller_program: ctx.accounts.program.to_account_info(),
                cpi_authority_bump,
            };

            // No message metadata for voting — use all zeros.
            let message_metadata_digest = [0u8; 32];

            dwallet_ctx.approve_message(
                &ctx.accounts.coordinator.to_account_info(),
                &ctx.accounts.message_approval.to_account_info(),
                &ctx.accounts.dwallet.to_account_info(),
                &ctx.accounts.payer.to_account_info(),
                &ctx.accounts.system_program.to_account_info(),
                proposal.message_digest,
                message_metadata_digest,
                proposal.user_pubkey,
                proposal.signature_scheme,
                proposal.message_approval_bump,
            )?;

            proposal.status = ProposalStatus::Approved;
        }

        Ok(())
    }
}

// ── Accounts ──

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

    /// CHECK: dWallet account (owned by the dWallet program).
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

    pub voter: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,

    // CPI accounts (needed when quorum is reached).

    /// CHECK: DWalletCoordinator PDA on the dWallet program (for epoch).
    pub coordinator: UncheckedAccount<'info>,

    /// CHECK: MessageApproval PDA on the dWallet program.
    #[account(mut)]
    pub message_approval: UncheckedAccount<'info>,

    /// CHECK: dWallet account (owned by the dWallet program).
    pub dwallet: UncheckedAccount<'info>,

    /// CHECK: This program's executable account (for CPI authority verification).
    pub program: UncheckedAccount<'info>,

    /// CHECK: CPI authority PDA (seeds: `[CPI_AUTHORITY_SEED]`, derived from this program).
    pub cpi_authority: UncheckedAccount<'info>,

    /// CHECK: The Ika dWallet program.
    pub dwallet_program: UncheckedAccount<'info>,
}

// ── State ──

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
    pub message_approval_bump: u8,
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
    #[msg("Quorum must be at least 1")]
    InvalidQuorum,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
}
