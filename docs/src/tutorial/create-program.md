# Create the Program

> **Pre-alpha.** The devnet pre-alpha is a mock network with no MPC. Read
> [the warning in the introduction](../introduction.md#the-devnet-pre-alpha-is-a-mock-network) first.

This chapter sets up the program: its dependencies, its three account types, its errors, and the
function that reads a dWallet's owner.

## Cargo.toml

```toml
[package]
name = "my-voting-program"
version = "0.1.0"
edition = "2024"

[dependencies]
ika-dwallet-pinocchio = { git = "https://github.com/dwallet-labs/ika-pre-alpha" }
pinocchio = { version = "0.11", features = ["cpi"] }
pinocchio-system = "0.6"
solana-address = { version = "2.6", features = ["curve25519"] }

[dev-dependencies]
mollusk-svm = "0.15"
solana-account = "4.3"
solana-instruction = "3.4"
solana-program-error = "3"
solana-pubkey = "4.1"

[features]
devnet-pre-alpha = ["ika-dwallet-pinocchio/devnet-pre-alpha"]

[lib]
crate-type = ["cdylib", "lib"]
```

- `ika-dwallet-pinocchio` gives `DWalletContext`, which makes the CPI into the ika program, and
  `ID`, the ika program's address on the network you build for.
- The features pick that network. Build for the devnet pre-alpha with
  `cargo build-sbf --tools-version v1.54 --arch v3 -- --features devnet-pre-alpha`. The tests build
  with no feature. See
  [Build for one network](../frameworks/pinocchio.md#build-for-one-network).
- `pinocchio-system` creates the program's own accounts.
- `solana-address` with `curve25519` derives PDAs when the program runs in host tests. On chain,
  the program uses the runtime's own call for it.

## The skeleton

```rust
#![no_std]

extern crate alloc;

use pinocchio::{
    AccountView, Address, ProgramResult,
    cpi::{Seed, Signer},
    entrypoint,
    error::ProgramError,
};
use pinocchio_system::instructions::CreateAccount;

use ika_dwallet_pinocchio::{DWalletContext, ID as IKA_PROGRAM_ID};

entrypoint!(process_instruction);
pinocchio::nostd_panic_handler!();

// Replace with your program's id before you deploy.
pub const ID: Address = Address::new_from_array([5u8; 32]);
```

## Errors

Each check gets its own error code, so a test can assert the exact one.

```rust
#[repr(u32)]
pub enum VotingError {
    DWalletMismatch = 0,       // the dWallet passed is not the proposal's
    NotAMember = 1,            // the signer is not on the council
    NotDWalletOwner = 2,       // the council's creator is not the dWallet's owner
    InvalidCouncil = 3,        // the council account is not the dWallet's council
    InvalidDWalletAccount = 4, // the account is not a DWallet of the ika program
    InvalidQuorum = 5,         // the quorum is 0 or above the member count
    DuplicateMember = 6,
    ProposalClosed = 7,
    ProposalMismatch = 8,      // the proposal id does not match the account
    InvalidVoucherBump = 9,    // the voucher bump is not the canonical one
    VoucherMismatch = 10,      // the voucher account is not the proposal's voucher PDA
    InvalidBump = 11,          // a bump the client chose is not the canonical one
}

impl From<VotingError> for ProgramError {
    fn from(error: VotingError) -> Self {
        ProgramError::Custom(error as u32)
    }
}
```

## The accounts

Every account starts with a two-byte header, a tag and a version, like the ika program's own.

**Council**, at `["council", dwallet]`, 361 bytes, tag 3:

| Offset | Field | Size | Meaning |
|---|---|---|---|
| 2 | `dwallet` | 32 | The dWallet this council governs |
| 34 | `quorum` | 4 | Yes votes needed |
| 38 | `member_count` | 2 | 1 to 10 |
| 40 | `bump` | 1 | The council's canonical bump |
| 41 | `members` | 320 | Ten 32-byte keys. The first `member_count` are used |

**Proposal**, at `["proposal", proposal_id]`, 196 bytes, tag 1:

| Offset | Field | Size | Meaning |
|---|---|---|---|
| 2 | `proposal_id` | 32 | The proposal's id |
| 34 | `dwallet` | 32 | The council's dWallet |
| 66 | `message_digest` | 32 | The Keccak-256 of the message to sign |
| 98 | `user_pubkey` | 32 | The request key that will send the sign request. It becomes the voucher's signing key |
| 130 | `signature_scheme` | 2 | The scheme, such as 5 for EdDSA |
| 132 | `creator` | 32 | The member who proposed |
| 164 | `yes_votes` | 4 | |
| 168 | `no_votes` | 4 | |
| 172 | `quorum` | 4 | Copied from the council |
| 176 | `status` | 1 | 0 open, 1 approved |
| 177 | `signature_voucher_bump` | 1 | The bump of `["signature_voucher", proposal_id]` |
| 178 | `bump` | 1 | The proposal's bump |
| 179 | `_reserved` | 16 | |

**VoteRecord**, at `["vote", proposal_id, voter]`, 69 bytes, tag 2:

| Offset | Field | Size |
|---|---|---|
| 2 | `voter` | 32 |
| 34 | `proposal_id` | 32 |
| 66 | `vote` | 1 |
| 67 | `bump` | 1 |

## Dispatch

The first byte of the instruction data names the instruction:

```rust
pub fn process_instruction(
    program_id: &Address,
    accounts: &mut [AccountView],
    data: &[u8],
) -> ProgramResult {
    let (discriminator, rest) = data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;

    match *discriminator {
        0 => create_proposal(program_id, accounts, rest),
        1 => cast_vote(program_id, accounts, rest),
        2 => create_council(program_id, accounts, rest),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
```

## Reading a dWallet's owner

`create_council` must prove that its signer owns the dWallet now. It reads the `DWallet` account
of the ika program: tag 97 at byte 0, then `owner` at offset 2. First it proves the account is
really the ika program's.

```rust
const DWALLET_ACCOUNT_DISCRIMINATOR: u8 = 97;
const DWALLET_OWNER_OFFSET: usize = 2;

fn dwallet_owner(
    dwallet: &AccountView,
    dwallet_program: &AccountView,
) -> Result<[u8; 32], ProgramError> {
    // The dWallet program must be ika's own, the address this program was
    // built for: a dWallet account of any other program is anyone's word.
    if dwallet_program.address() != &IKA_PROGRAM_ID
        || !dwallet_program.executable()
        || !dwallet.owned_by(&IKA_PROGRAM_ID)
    {
        return Err(VotingError::InvalidDWalletAccount.into());
    }
    let data = dwallet.try_borrow()?;
    if data.first() != Some(&DWALLET_ACCOUNT_DISCRIMINATOR) {
        return Err(VotingError::InvalidDWalletAccount.into());
    }
    read_key(&data, DWALLET_OWNER_OFFSET).map_err(|_| VotingError::InvalidDWalletAccount.into())
}
```

The owner is compared with `IKA_PROGRAM_ID`, never with the program account the caller passed. A
caller could otherwise pass a program of its own, with a look-alike account that names the caller
as owner. Your own program can also check the account's length, 185 bytes.

## Rent

The example pays rent with a fixed formula:

```rust
fn minimum_balance(data_len: usize) -> u64 {
    (data_len as u64).saturating_add(128).saturating_mul(6960)
}
```

It equals Solana's rent-exempt minimum at the current rent rate. Reading the `Rent` sysvar is the
choice that stays right if the rate changes.

## Next

[Create the council and the proposal](./issue-signature-vouchers.md).
