// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! Example: Voting-controlled dWallet signing (Quasar version).
//!
//! A Quasar program demonstrating program-controlled dWallets via the CPI
//! authority pattern. Proposals are created referencing a dWallet whose authority
//! has been transferred to this program's CPI authority PDA. When enough "yes"
//! votes are cast (reaching quorum), the program automatically CPI-calls
//! `approve_message` on the dWallet program to authorize signing.
//!
//! This is the Quasar equivalent of the Pinocchio `ika-example-voting` program.
//!
//! # Seed components
//!
//! Quasar uses account addresses as PDA seed components. The `proposal_id`
//! account's address provides the 32-byte proposal identifier seed (same bytes
//! as the Pinocchio version's instruction-data `proposal_id`).

#![no_std]

use ika_dwallet_quasar::DWalletContext;
use quasar_lang::prelude::*;
use solana_address::Address;

// Placeholder program ID -- replace with actual keypair before deployment.
declare_id!("US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx");

#[program]
mod voting_quasar {
    use super::*;

    /// Create a proposal PDA with a target dWallet, message digest, and quorum.
    #[instruction(discriminator = 0)]
    pub fn create_proposal(
        ctx: Ctx<CreateProposal>,
        message_digest: [u8; 32],
        user_pubkey: [u8; 32],
        signature_scheme: u16,
        quorum: u32,
        message_approval_bump: u8,
    ) -> Result<(), ProgramError> {
        ctx.accounts.create(
            message_digest,
            user_pubkey,
            signature_scheme,
            quorum,
            message_approval_bump,
        )
    }

    /// Cast a vote on a proposal. When quorum is reached, CPI-approves signing.
    #[instruction(discriminator = 1)]
    pub fn cast_vote(
        ctx: Ctx<CastVote>,
        vote: bool,
        cpi_authority_bump: u8,
    ) -> Result<(), ProgramError> {
        ctx.accounts.cast(vote, cpi_authority_bump)
    }
}

// ── State ──

#[account(discriminator = 1, set_inner)]
#[seeds(b"proposal", proposal_id: Address)]
pub struct Proposal {
    pub proposal_id: Address,
    pub dwallet: Address,
    pub message_digest: [u8; 32],
    pub user_pubkey: [u8; 32],
    pub signature_scheme: u16,
    pub creator: Address,
    pub yes_votes: u32,
    pub no_votes: u32,
    pub quorum: u32,
    pub status: u8,
    pub message_approval_bump: u8,
}

#[account(discriminator = 2, set_inner)]
#[seeds(b"vote", proposal_id: Address, voter: Address)]
pub struct VoteRecord {
    pub voter: Address,
    pub proposal_id: Address,
    pub vote: u8,
}

// ── Errors ──

#[error_code]
pub enum VotingError {
    ProposalClosed = 6000,
    InvalidQuorum,
    ArithmeticOverflow,
}

// ── Accounts ──

#[derive(Accounts)]
pub struct CreateProposal {
    /// Proposal identifier -- its address is the 32-byte seed.
    pub proposal_id: UncheckedAccount,

    #[account(init, payer = payer, seeds = Proposal::seeds(proposal_id), bump)]
    pub proposal: Account<Proposal>,

    /// dWallet account (owned by the dWallet program).
    pub dwallet: UncheckedAccount,

    pub creator: Signer,

    #[account(mut)]
    pub payer: Signer,

    pub system_program: Program<System>,
}

impl CreateProposal {
    #[inline(always)]
    pub fn create(
        &mut self,
        message_digest: [u8; 32],
        user_pubkey: [u8; 32],
        signature_scheme: u16,
        quorum: u32,
        message_approval_bump: u8,
    ) -> Result<(), ProgramError> {
        require!(quorum > 0, VotingError::InvalidQuorum);

        self.proposal.set_inner(ProposalInner {
            proposal_id: *self.proposal_id.address(),
            dwallet: *self.dwallet.address(),
            message_digest,
            user_pubkey,
            signature_scheme,
            creator: *self.creator.address(),
            yes_votes: 0,
            no_votes: 0,
            quorum,
            status: 0, // Open
            message_approval_bump,
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct CastVote {
    /// Proposal identifier -- its address is the 32-byte seed.
    pub proposal_id: UncheckedAccount,

    #[account(mut, seeds = Proposal::seeds(proposal_id), bump)]
    pub proposal: Account<Proposal>,

    #[account(init, payer = payer, seeds = VoteRecord::seeds(proposal_id, voter), bump)]
    pub vote_record: Account<VoteRecord>,

    pub voter: Signer,

    #[account(mut)]
    pub payer: Signer,

    pub system_program: Program<System>,

    // CPI accounts (needed when quorum is reached).

    /// DWalletCoordinator PDA on the dWallet program (for epoch).
    pub coordinator: UncheckedAccount,

    /// MessageApproval PDA on the dWallet program.
    #[account(mut)]
    pub message_approval: UncheckedAccount,

    /// dWallet account (owned by the dWallet program).
    pub dwallet: UncheckedAccount,

    /// This program's executable account (for CPI authority verification).
    pub caller_program: UncheckedAccount,

    /// CPI authority PDA (seeds: `[CPI_AUTHORITY_SEED]`, derived from this program).
    pub cpi_authority: UncheckedAccount,

    /// The Ika dWallet program.
    pub dwallet_program: UncheckedAccount,
}

impl CastVote {
    #[inline(always)]
    pub fn cast(
        &mut self,
        vote: bool,
        cpi_authority_bump: u8,
    ) -> Result<(), ProgramError> {
        // Record vote.
        self.vote_record.set_inner(VoteRecordInner {
            voter: *self.voter.address(),
            proposal_id: *self.proposal_id.address(),
            vote: if vote { 1 } else { 0 },
        });

        // Verify proposal is open.
        require!(self.proposal.status == 0, VotingError::ProposalClosed);

        if vote {
            self.proposal.yes_votes = self
                .proposal
                .yes_votes
                .checked_add(1u32)
                .ok_or(VotingError::ArithmeticOverflow)?;
        } else {
            self.proposal.no_votes = self
                .proposal
                .no_votes
                .checked_add(1u32)
                .ok_or(VotingError::ArithmeticOverflow)?;
        }

        // Check quorum -- if reached, CPI-call approve_message on the dWallet program.
        if self.proposal.yes_votes >= self.proposal.quorum {
            let dwallet_ctx = DWalletContext {
                dwallet_program: self.dwallet_program.to_account_view(),
                cpi_authority: self.cpi_authority.to_account_view(),
                caller_program: self.caller_program.to_account_view(),
                cpi_authority_bump,
            };

            let message_metadata_digest = [0u8; 32];

            dwallet_ctx.approve_message(
                self.coordinator.to_account_view(),
                self.message_approval.to_account_view(),
                self.dwallet.to_account_view(),
                self.payer.to_account_view(),
                self.system_program.to_account_view(),
                self.proposal.message_digest,
                message_metadata_digest,
                self.proposal.user_pubkey,
                self.proposal.signature_scheme.into(),
                self.proposal.message_approval_bump,
            )?;

            self.proposal.status = 1; // Approved
        }

        Ok(())
    }
}
