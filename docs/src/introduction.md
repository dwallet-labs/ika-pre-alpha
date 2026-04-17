# dWallet Developer Guide

> **Pre-Alpha Disclaimer:** This is a pre-alpha release for development and testing only. Signing uses a single mock signer, not real distributed MPC. All 11 protocol operations are implemented (DKG, Sign, Presign, FutureSign, ReEncryptShare, etc.) across all 4 curves and 7 signature schemes, but without real MPC security guarantees. The dWallet keys, trust model, and signing protocol are not final; do not rely on any key material until mainnet. All interfaces, APIs, and data formats are subject to change without notice. The Solana program and all on-chain data will be wiped periodically and everything will be deleted when we transition to Ika Alpha 1. This software is provided "as is" without warranty of any kind; use is entirely at your own risk and dWallet Labs assumes no liability for any damages arising from its use.

dWallet enables smart contracts to **control signing keys** on any blockchain. Your program determines what gets signed -- the Ika network performs the distributed signing via 2PC-MPC.

## How It Works

1. **Create a dWallet** -- the Ika network runs DKG and produces a public key
2. **Your program controls it** -- transfer the dWallet authority to your program's CPI authority PDA
3. **Approve messages** -- when conditions are met, your program CPI-calls `approve_message`
4. **Network signs** -- the Ika validator network produces the signature via 2PC-MPC
5. **Signature stored on-chain** -- anyone can read the MessageApproval account to get the signature

```rust
// Your program decides when to sign
fn cast_vote(ctx: &DWalletContext, proposal: &Proposal) -> ProgramResult {
    if proposal.yes_votes >= proposal.quorum {
        ctx.approve_message(
            message_approval, dwallet, payer, system_program,
            proposal.message_hash, user_pubkey, signature_scheme, bump,
        )?;
    }
    Ok(())
}
```

## What You'll Learn

- **Getting Started**: Install dependencies, create your first dWallet-controlled program
- **Tutorial**: Build a voting app where quorum triggers signing
- **On-Chain Integration**: dWallet accounts, message approval, CPI framework, gas deposits
- **gRPC API**: SubmitTransaction, request/response types
- **Testing**: Mollusk, LiteSVM, and E2E testing
- **Reference**: Instructions, accounts, events
