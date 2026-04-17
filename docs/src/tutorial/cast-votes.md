# Cast Votes

> **Pre-Alpha Disclaimer:** This is a pre-alpha release for development and testing only. Signing uses a single mock signer, not real distributed MPC. All 11 protocol operations are implemented (DKG, Sign, Presign, FutureSign, ReEncryptShare, etc.) across all 4 curves and 7 signature schemes, but without real MPC security guarantees. The dWallet keys, trust model, and signing protocol are not final; do not rely on any key material until mainnet. All interfaces, APIs, and data formats are subject to change without notice. The Solana program and all on-chain data will be wiped periodically and everything will be deleted when we transition to Ika Alpha 1. This software is provided "as is" without warranty of any kind; use is entirely at your own risk and dWallet Labs assumes no liability for any damages arising from its use.

## cast_vote Instruction

The `cast_vote` instruction records a vote and -- when quorum is reached -- triggers the CPI call to `approve_message`.

### Instruction Data

| Offset | Field | Size |
|--------|-------|------|
| 0 | proposal_id | 32 |
| 32 | vote | 1 |
| 33 | vote_record_bump | 1 |
| 34 | cpi_authority_bump | 1 |

Total: 35 bytes. The `vote` field is `1` for yes and `0` for no.

### Accounts (No Quorum Path)

| # | Account | W | S | Description |
|---|---------|---|---|-------------|
| 0 | proposal | yes | no | Proposal PDA |
| 1 | vote_record | yes | no | VoteRecord PDA (`["vote", proposal_id, voter]`) |
| 2 | voter | no | yes | Voter (signer) |
| 3 | payer | yes | yes | Rent payer |
| 4 | system_program | no | no | System program |

### Additional Accounts (When Quorum Reached)

When the vote triggers quorum, 5 additional accounts are required:

| # | Account | W | S | Description |
|---|---------|---|---|-------------|
| 5 | message_approval | yes | no | MessageApproval PDA (to create via CPI) |
| 6 | dwallet | no | no | dWallet account |
| 7 | caller_program | no | no | This voting program (executable) |
| 8 | cpi_authority | no | no | CPI authority PDA (signer via invoke_signed) |
| 9 | dwallet_program | no | no | dWallet program |

### Implementation

The core logic:

```rust
fn cast_vote(
    program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    let proposal_id: [u8; 32] = data[0..32].try_into().unwrap();
    let vote = data[32];
    let vote_record_bump = data[33];
    let cpi_authority_bump = data[34];

    // 1. Verify proposal is open
    // 2. Create VoteRecord PDA (fails if already exists = double vote prevention)
    // 3. Update yes_votes or no_votes on the proposal
    // 4. If yes_votes >= quorum, trigger CPI

    // ... vote counting ...

    if yes_votes >= quorum {
        // Need additional accounts for CPI
        let message_approval = &accounts[5];
        let dwallet = &accounts[6];
        let caller_program = &accounts[7];
        let cpi_authority = &accounts[8];
        let dwallet_program = &accounts[9];

        // Build DWalletContext and call approve_message
        let ctx = DWalletContext {
            dwallet_program,
            cpi_authority,
            caller_program,
            cpi_authority_bump,
        };

        ctx.approve_message(
            message_approval,
            dwallet,
            payer,
            system_program,
            message_hash,
            user_pubkey,
            signature_scheme,
            message_approval_bump,
        )?;

        // Mark proposal as approved
        prop_data[PROP_STATUS] = STATUS_APPROVED;
    }

    Ok(())
}
```

### Double Vote Prevention

The VoteRecord PDA uses seeds `["vote", proposal_id, voter]`. Since `CreateAccount` will fail if the account already exists (non-zero lamports), a voter cannot vote twice on the same proposal.

### The CPI Call Chain

When quorum triggers `approve_message`, the call chain is:

```
Voting Program
  └── invoke_signed (CPI authority PDA signs)
        └── dWallet Program: approve_message
              ├── Verifies caller_program is executable
              ├── Verifies cpi_authority = PDA(["__ika_cpi_authority"], caller_program)
              ├── Verifies dwallet.authority == cpi_authority
              └── Creates MessageApproval PDA
```

The `DWalletContext` handles all of this -- building the instruction data, assembling accounts, and calling `invoke_signed` with the correct seeds.

### Client-Side Account Assembly

When constructing the transaction client-side, you need to know whether this vote will trigger quorum. If it will, include the extra 5 accounts:

```rust
let mut accounts = vec![
    AccountMeta::new(proposal_pda, false),
    AccountMeta::new(vote_record_pda, false),
    AccountMeta::new_readonly(voter.pubkey(), true),
    AccountMeta::new(payer.pubkey(), true),
    AccountMeta::new_readonly(system_program::id(), false),
];

// Include CPI accounts if this vote reaches quorum
if current_yes_votes + 1 >= quorum {
    accounts.extend_from_slice(&[
        AccountMeta::new(message_approval_pda, false),
        AccountMeta::new_readonly(dwallet_pda, false),
        AccountMeta::new_readonly(voting_program_id, false),
        AccountMeta::new_readonly(cpi_authority, false),
        AccountMeta::new_readonly(dwallet_program_id, false),
    ]);
}
```

## Next Step

With voting and approval working, the next chapter shows how to [verify the resulting signature](./verify-signature.md).
