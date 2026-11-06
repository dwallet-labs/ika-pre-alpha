# dWallet Developer Guide for Solana

A dWallet is a signing key that a Solana account controls. It can sign for any chain: Bitcoin,
Ethereum, Solana and others. The owner of a dWallet decides which messages get signed, and the ika
network produces the signatures. When the owner is your Solana program, your program's rules decide
what the dWallet signs.

## The devnet pre-alpha is a mock network

> **Read this before you build anything.** The Solana devnet pre-alpha does not run the real ika
> network. One backend, the mock, stands in for all the validators.
>
> - **There is no MPC.** The mock holds an ordinary private key for every dWallet, and signs with it
>   alone.
> - **It is not secure.** The mock can sign any message with any dWallet. Put no real funds on a
>   pre-alpha dWallet.
> - **No private key is ever sent to the mock.** The mock makes every dWallet's key itself. In the
>   pre-alpha, importing a key does not send that key anywhere: the mock makes a new key, so the
>   imported dWallet has a different public key and address than the key you passed.
> - **Everything is wiped.** The program and all its accounts are reset from time to time, and
>   everything is deleted when ika moves to Alpha 1.
> - **Nothing is final.** Request formats, account layouts, derived addresses and the SDK's API can
>   change without notice.
>
> This software is provided "as is", without warranty of any kind. You use it entirely at your own
> risk, and dWallet Labs assumes no liability for any damages arising from its use.

The pre-alpha is still useful because everything around the signing is real:

- The Solana program on devnet is the one the real network uses.
- The transactions your app and your program send are the real ones.
- The SDK's calls are the real ones, and the SDK still checks every answer the mock signs and every
  record on Solana.

The SDK runs in mock mode for the pre-alpha. An app moves to the real network by creating its client
without mock mode and naming the real network. Nothing else in the app changes.

## How it works

1. **Create a dWallet.** Your app asks the network for a new dWallet. The network writes a `DWallet`
   account on Solana that holds its public key. The user accepts their share of the key on Solana,
   which makes the dWallet usable.
2. **Give it to your program.** The dWallet's owner transfers it to your program's CPI authority, an
   address only your program can sign for.
3. **Approve a message.** When your program's conditions hold, it calls `issue_signature_voucher`
   through a CPI. That creates a `SignatureVoucher` account, which allows exactly one signature of
   one message.
4. **Ask for the signature.** Your app sends a sign request that names the voucher. The network reads
   the voucher on Solana for itself and refuses a request the voucher does not allow.
5. **Read the signature.** The network writes the signature into the voucher account. The app gets it
   back from the request too, and anyone can read it from the account.

On the real network, the key is split between the user and the validators, and neither side can sign
alone. The validators sign together through the 2PC-MPC protocol. In the pre-alpha, the mock does all
of this with one key.

```rust
// Your program decides when to sign, and with which dWallet. The CPI authority
// is one address per program, shared by every dWallet you hand it, so bind each
// voucher to the dWallet the request was approved for.
fn cast_vote(ctx: &DWalletContext, proposal: &Proposal, dwallet: &AccountView) -> ProgramResult {
    if dwallet.address().as_array() != &proposal.dwallet {
        return Err(VotingError::DWalletMismatch.into());
    }
    if proposal.yes_votes >= proposal.quorum {
        ctx.issue_signature_voucher(
            coordinator, signature_voucher, dwallet, payer, system_program,
            proposal.message_digest, [0u8; 32], proposal.signature_scheme,
            None, Some(proposal.user_pubkey), Some(&voucher_seeds),
        )?;
    }
    Ok(())
}
```

## What this guide covers

- **Getting started.** What to install, the devnet pre-alpha's addresses, a first dWallet and
  signature from an app, and the concepts the rest of the guide uses.
- **SDK.** The TypeScript SDK, which an app uses to create dWallets and ask for signatures.
- **Tutorial.** A voting program, built step by step, where a quorum of votes makes a dWallet sign.
- **On-chain integration.** The dWallet and voucher accounts, the CPI crates, the rules your program
  must follow, and gas deposits.
- **gRPC API.** The requests the network serves, for a client that does not use an SDK.
- **Testing.** Mollusk, LiteSVM and end-to-end tests.
- **Frameworks.** The CPI crates for Pinocchio, native Solana programs and Anchor.
- **Examples.** A voting dWallet and a multisig dWallet, each with a program in three frameworks and
  an end-to-end demo in TypeScript.
- **Reference.** Every instruction, account and event of the program.
