# Integrator Invariants

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

The ika program checks only which program asks for a voucher, never why. Every check between "a
user gave a dWallet to my program" and "my program asked for a signature" is your program's job.
This page lists those checks. The voting and multisig examples make them, and each item names
where.

## The fact the rest follows from

Your program has one CPI authority, the PDA `["__ika_cpi_authority"]` under your program's id.
The ika program treats every dWallet owned by that address as controlled by your program as a
whole. It checks that the CPI authority signed and that it equals the dWallet's owner. It cannot
know which of your users, proposals or vaults a call is for.

So suppose your program holds dWallet A for one user and dWallet B for another. Any path in your
program that ends in `issue_signature_voucher` can issue a voucher for A or for B, unless your
program itself checks which dWallet the path may use. The typical attack: an attacker creates a
proposal of their own in your program, with rules they control. They meet its condition, and pass
somebody else's dWallet to the CPI.

## The invariants

### 1. Bind every voucher to the dWallet it was approved for

The record that approves a signature, such as a proposal or a multisig transaction, must store
its dWallet. When the record is carried out, the dWallet account passed to the CPI must be that
one. Check it before the CPI, with an error of your own.

*Examples:* `VotingError::DWalletMismatch` in the voting programs' `cast_vote`, Anchor's
`#[account(address = proposal.dwallet)]`, and `MultisigError::DWalletMismatch` in the multisig
programs' `approve`.

### 2. Let the dWallet's owner set its rules, once, before the transfer

Who may approve signatures for a dWallet must be fixed by the dWallet's current owner, before it
gives the dWallet to your program. After that, nobody may create a second set of rules for the
same dWallet. Derive the rules' account from the dWallet's address, so there is one per dWallet.
Require its creator to be the dWallet's stored `owner`.

To read that owner safely:

1. Check that the account's owner is the ika program: `ID` of the CPI crate, the address of the
   network your program was built for. Never compare it with a program account the caller passed.
   A caller can pass a program of its own, with a look-alike account that names the caller as
   owner.
2. Check that byte 0 is 97 and the account is 185 bytes.
3. Read `owner` at offset 2.

The CPI crates make the same check for every call they send: `DWalletContext` refuses a
`dwallet_program` that is not `ID`, with `IncorrectProgramId`. So your program's CPI authority
never signs a call to a fake ika program. Your own reads of ika accounts are still yours to check
against `ID`. See [The CPI Framework](./cpi-framework.md#the-context-calls-only-the-real-ika-program).

Order matters for the user: **create the rules first, then transfer the dWallet.** After the
transfer, the owner is your program's CPI authority, and the user cannot sign for the dWallet
any more.

*Examples:* `create_council` at `["council", dwallet]` and `CreateMultisig` at
`["multisig", dwallet]`, with `NotDWalletOwner` and `InvalidDWalletAccount`. Their `dwallet_owner`
requires the ika program account to be `ID` and executable, and to own the dWallet. The Anchor
examples use `owner = IKA_PROGRAM_ID`.

### 3. Close the set of actors

If your program has members, voters or signers, only they may create approval records and act
on them. Take the quorum or threshold from the rules' account, never from the caller. Refuse a
member listed twice, so one key cannot count twice. Refuse a threshold of zero or above the
member count.

*Examples:* `NotAMember` on propose and vote, the quorum copied from the council into the
proposal, and `InvalidQuorum`, `InvalidThreshold` and `DuplicateMember` at creation.

### 4. Bind every account the CPI touches, not only the dWallet

The voucher controls act on whatever voucher account you pass, of either kind. If your record
refers to a voucher, the account passed later must be that one.

A new voucher lives at an address the issuer picks. No account of the ika program names it.
Derive the address from your record, so your program and your clients can find it again. The
examples use `["signature_voucher", proposal_id]` and `["signature_voucher", transaction]`, and
refuse any other address (`VoucherMismatch`).

### 5. Check your own accounts by address, not only by content

An account your program owns, with the right tag, can still be the wrong one: another user's
council, or a transaction of another multisig. Check that its address is the PDA you expect.
`create_program_address` with the stored bump is cheap. Check the cross-references too, such as
`transaction.multisig == multisig`.

*Examples:* `InvalidCouncil` checks the address and the `dwallet` field. `InvalidMultisig` and
`TransactionMismatch` do the same for the multisig.

### 6. Use the canonical bump for every account whose existence enforces "once"

A seed list has up to 255 valid bumps, each giving another address. When the caller supplies the
bump, the caller can create a second account for the same seeds. So an account whose existence
means "this was done once" must be created at the canonical bump, the one
`find_program_address` returns. That covers the rules' account per dWallet, and also a vote
record per voter: with a bump of the caller's choosing, one voter could create two vote records
and vote twice.

The examples check every bump a client chooses: the proposal's, the vote record's, the multisig
transaction's and the approval record's. Their Pinocchio and native programs compare it with the
canonical one in `require_canonical_bump`, and refuse another with `InvalidBump` (11 in voting, 12
in multisig). Their Anchor programs derive every bump with `seeds` and `bump`, so Anchor uses the
canonical one. The LiteSVM tests `test_a_member_cannot_vote_twice_with_a_second_bump` and
`test_a_member_cannot_approve_twice_with_a_second_bump` show the check works.

The voucher's bump matters for another reason. A non-canonical voucher bump puts the voucher at an
address clients do not compute. The proposal would pass and use up its voucher, and no client
would find it. The examples refuse it (`InvalidVoucherBump`).

### 7. Read the ika program's accounts at the current offsets

`SignatureVoucher`, 304 bytes: `dwallet` at 2, `message_digest` at 34, `message_metadata_digest`
at 66, `owner` at 98, `signature_scheme` at 130, `has_signing_key` at 132, `signing_key` at 133,
`issued_epoch` at 165, `status` at 173, `signature_len` at 174, `signature` at 176.

`DWallet`, 185 bytes: `owner` at 2, `curve` at 34, `state` at 36, `public_key_len` at 37,
`public_key` at 38, `created_epoch` at 103, `noa_public_key` at 111, `is_imported` at 143,
`bump` at 144, `session_identifier` at 153.

Reading `status` at the offset of another field lets whoever controls that field make a voucher
look signed. Full tables: [Account Reference](../reference/accounts.md).

### 8. Pass the coordinator, and the scheme the sign request will use

`issue_signature_voucher` takes the `DWalletCoordinator` as its first account, and a u16 signature
scheme. The network serves a sign request only when its scheme equals the voucher's. So store the
scheme the later request will use, for example 5, EdDSA with SHA-512, for a Curve25519 dWallet.

### 9. Issue each voucher once

One voucher allows one signature. A second voucher for the same digest allows a second
signature. Decide how many vouchers one record may issue. With the voucher at a PDA of the
record, a second issue fails because the account exists, so the record must handle that. Store
the digest the voucher was issued for, and the voucher's address.

### 10. Check the owner and the dWallet when you read a voucher

Anything that acts on a `SignatureVoucher`, such as your client, an indexer or another program,
should check `owner` and `dwallet`. A voucher with the right digest for another dWallet is not
yours. A voucher stays valid after its dWallet changes owner, so the dWallet's current owner does
not tell you who issued it.

### 11. Check that the dWallet is Active when it matters

The ika program issues vouchers only for Active dWallets. If an earlier step of your program
assumes the dWallet is usable, read `state` at offset 36 instead of assuming.

### 12. Give every check its own error code, and test it

Return `ProgramError::Custom(n)` with a different `n` for each condition. Write negative tests
that assert the exact code. A test that only asserts that the instruction failed also passes
when it fails for another reason, while the check you meant to test no longer runs. Then prove
the tests matter: remove a check, run the attack, and confirm the test fails.

*Examples:* every negative test in `examples/*/*/tests/mollusk.rs`, and
`test_quorum_cannot_be_redirected_to_another_councils_dwallet` in the voting example's
`tests/litesvm.rs`.

### 13. Do not pass on signatures you did not mean to

Solana keeps an account's signer and writable flags through a CPI. An account that signed your
instruction is still a signer inside the program you call. Pass only what the callee needs.
Never pass a user's signer account into a CPI that could act for that user.

The voucher address is a case of this. A keypair that signed the outer transaction is a signer
inside your CPI too. That is why the examples check the voucher's address themselves, as in
invariant 4.

### 14. Plan how a dWallet leaves your program

Once a dWallet's owner is your CPI authority, only your program can move it, with
`transfer_dwallet`. Decide in advance how a user takes a dWallet back. Bind that path to the same
rules as signing. It is a change of owner, and it can be attacked the same way.

## Checklist

- [ ] The rules' account is derived from the dWallet's address, created only by the dWallet's stored owner, before the transfer.
- [ ] The owner check compares the dWallet account's owner with the CPI crate's `ID`, and the program is built with its network's feature.
- [ ] Every approval record stores its dWallet, and carrying it out refuses any other dWallet before the CPI.
- [ ] Every other account the CPI touches, such as a voucher your record names, is checked the same way.
- [ ] The actor set is closed, the quorum comes from the rules, and duplicates are refused.
- [ ] Your own accounts are checked by address and cross-reference, not only by tag.
- [ ] Every account whose existence enforces "once" is created at its canonical bump.
- [ ] The coordinator is passed, with the scheme the later sign request uses.
- [ ] Each record issues its voucher once, at an address your program can find again.
- [ ] Clients read `status` at 173 and `curve` as a u16 at 34.
- [ ] Every check has its own error code and a test that asserts it.
- [ ] The way out for a dWallet is bound to the same rules.
