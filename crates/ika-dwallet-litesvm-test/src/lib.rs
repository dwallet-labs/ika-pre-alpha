// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! Run a program that holds dWallets under LiteSVM, against the real ika
//! program.
//!
//! The ika program is loaded from `bin/ika_protocol_test.so`: the ika
//! program built for the local development address, which
//! `ika_protocol_program_id::ID` names when no network feature is on. So a
//! program under test is built with no network feature too, and its
//! `DWalletContext` calls the ika program loaded here.
//!
//! LiteSVM runs no ika network, so nothing creates dWallets on its own.
//! [`DWalletTestContext`] writes the accounts the network would have written:
//! the dWallet coordinator, one network encryption key, and each dWallet,
//! byte for byte at the offsets the account reference documents. Your
//! program then runs its real instructions against them, and its CPIs run
//! the real ika program.

use litesvm::LiteSVM;
use solana_address::Address;
use solana_hash::Hash;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;

pub use solana_account::Account;
pub use solana_instruction::{AccountMeta, Instruction};
pub use solana_program_error::ProgramError;
pub use solana_pubkey::Pubkey;

/// The ika program, built for the local development address.
pub const DWALLET_PROGRAM_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../bin/ika_protocol_test.so"
);

/// The address the ika program is loaded at: `ika_protocol_program_id::ID`
/// with no network feature on.
pub const PROGRAM_ID: Pubkey = Pubkey::new_from_array(ika_protocol_program_id::ID);

/// The system program.
pub const SYSTEM_PROGRAM_ID: Pubkey = Pubkey::new_from_array([0u8; 32]);

/// The seed of a program's CPI authority, `["__ika_cpi_authority"]`.
pub const CPI_AUTHORITY_SEED: &[u8] = b"__ika_cpi_authority";

// ── The ika program's instructions this harness sends ──

/// `TransferDWallet`: the dWallet's owner gives it to a new owner.
pub const IX_TRANSFER_DWALLET: u8 = 129;

// ── Account tags: byte 0 of every ika account ──

pub const DISC_COORDINATOR: u8 = 96;
pub const DISC_DWALLET: u8 = 97;
pub const DISC_NETWORK_ENCRYPTION_KEY: u8 = 98;
pub const DISC_SIGNATURE_VOUCHER: u8 = 108;
pub const DISC_FUTURE_SIGNATURE_VOUCHER: u8 = 109;

// ── Account lengths: the tag, the version, then the fields ──

pub const COORDINATOR_LEN: usize = 2 + 629;
pub const NETWORK_ENCRYPTION_KEY_LEN: usize = 2 + 197;
pub const DWALLET_LEN: usize = 2 + 183;
pub const SIGNATURE_VOUCHER_LEN: usize = 2 + 302;
pub const FUTURE_SIGNATURE_VOUCHER_LEN: usize = 2 + 1939;

// ── DWalletCoordinator offsets ──

pub const COORD_EPOCH: usize = 2;
pub const COORD_PAUSED: usize = 18;
pub const COORD_BUMP: usize = 19;
pub const COORD_PAUSER: usize = 84;
pub const COORD_CHAIN_IDENTIFIER_LEN: usize = 116;
pub const COORD_CHAIN_IDENTIFIER: usize = 117;
pub const COORD_VAULT_AUTHORITY_BUMP: usize = 568;
pub const COORD_CHAIN_NUMBER: usize = 569;
pub const COORD_NETWORK: usize = 630;

/// A local Solana network's chain identifier: chain type 2 with an empty
/// reference.
pub const LOCAL_SOLANA_CHAIN_ID: [u8; 6] = [0x00, 0x01, 0x00, 0x02, 0x00, 0x00];

/// The chain number and network value the test coordinator records.
pub const TEST_CHAIN_NUMBER: u32 = 1;
pub const TEST_NETWORK: u8 = 3;

// ── NetworkEncryptionKey offsets and states ──

pub const NEK_NOA_PUBKEY: usize = 2;
pub const NEK_STATE: usize = 34;
pub const NEK_CREATED_EPOCH: usize = 35;
pub const NEK_BUMP: usize = 83;
pub const NEK_STATE_ACTIVE: u8 = 1;

// ── DWallet offsets, states and curves ──

pub const DW_OWNER: usize = 2;
pub const DW_CURVE: usize = 34; // u16, little endian
pub const DW_STATE: usize = 36;
pub const DW_PUBLIC_KEY_LEN: usize = 37;
pub const DW_PUBLIC_KEY: usize = 38;
pub const DW_CREATED_EPOCH: usize = 103;
pub const DW_NOA_PUBLIC_KEY: usize = 111;
pub const DW_IS_IMPORTED: usize = 143;
pub const DW_BUMP: usize = 144;

pub const DW_STATE_ACTIVE: u8 = 1;

pub const CURVE_SECP256K1: u16 = 0;
pub const CURVE_SECP256R1: u16 = 1;
pub const CURVE_CURVE25519: u16 = 2;
pub const CURVE_RISTRETTO: u16 = 3;

// ── SignatureVoucher offsets and statuses ──

pub const SV_DWALLET: usize = 2;
pub const SV_MESSAGE_DIGEST: usize = 34;
pub const SV_MESSAGE_METADATA_DIGEST: usize = 66;
pub const SV_OWNER: usize = 98;
pub const SV_SIGNATURE_SCHEME: usize = 130; // u16, little endian
pub const SV_HAS_SIGNING_KEY: usize = 132;
pub const SV_SIGNING_KEY: usize = 133;
pub const SV_ISSUED_EPOCH: usize = 165;
pub const SV_STATUS: usize = 173;
pub const SV_SIGNATURE_LEN: usize = 174;
pub const SV_SIGNATURE: usize = 176;

pub const SV_STATUS_PENDING: u8 = 0;
pub const SV_STATUS_SIGNED: u8 = 1;
pub const SV_STATUS_SETTLED_WITHOUT_DELIVERY: u8 = 2;
pub const SV_STATUS_REVOKED: u8 = 3;

// ── FutureSignatureVoucher offsets and statuses ──

pub const FSV_DWALLET: usize = 2;
pub const FSV_MESSAGE_DIGEST: usize = 34;
pub const FSV_MESSAGE_METADATA_DIGEST: usize = 66;
pub const FSV_OWNER: usize = 98;
pub const FSV_SIGNATURE_SCHEME: usize = 130;
pub const FSV_HAS_SIGNING_KEY: usize = 132;
pub const FSV_SIGNING_KEY: usize = 133;
pub const FSV_ISSUED_EPOCH: usize = 165;
pub const FSV_STATUS: usize = 173;

pub const FSV_STATUS_OPEN: u8 = 0;
pub const FSV_STATUS_PARTIALLY_SIGNED: u8 = 1;
pub const FSV_STATUS_SIGNED: u8 = 2;
pub const FSV_STATUS_SETTLED_WITHOUT_DELIVERY: u8 = 3;
pub const FSV_STATUS_REVOKED: u8 = 4;

/// The epoch the test coordinator is at.
pub const TEST_EPOCH: u64 = 5;

/// A `Pubkey` as LiteSVM's `Address`.
pub fn pubkey_to_address(pubkey: &Pubkey) -> Address {
    Address::new_from_array(pubkey.to_bytes())
}

/// LiteSVM's `Address` as a `Pubkey`.
pub fn address_to_pubkey(address: &Address) -> Pubkey {
    Pubkey::new_from_array(address.to_bytes())
}

/// A keypair's public key as a `Pubkey`.
pub fn keypair_pubkey(keypair: &Keypair) -> Pubkey {
    Pubkey::new_from_array(keypair.pubkey().to_bytes())
}

/// An account owned by `owner` that holds `data`, rent exempt.
pub fn program_account(owner: &Pubkey, data: Vec<u8>) -> Account {
    Account {
        lamports: (data.len() as u64)
            .saturating_add(128)
            .saturating_mul(6960)
            .max(1),
        data,
        owner: *owner,
        executable: false,
        rent_epoch: 0,
    }
}

/// Write `bytes` into `data` at `offset`.
fn put(data: &mut [u8], offset: usize, bytes: &[u8]) {
    data[offset..offset.saturating_add(bytes.len())].copy_from_slice(bytes);
}

/// The data of a DWalletCoordinator at `epoch`, not paused, with `pauser`
/// as its pauser.
pub fn build_coordinator_data(pauser: &Pubkey, epoch: u64, bump: u8) -> Vec<u8> {
    let mut data = vec![0u8; COORDINATOR_LEN];
    data[0] = DISC_COORDINATOR;
    data[1] = 1; // version
    put(&mut data, COORD_EPOCH, &epoch.to_le_bytes());
    data[COORD_PAUSED] = 0;
    data[COORD_BUMP] = bump;
    put(&mut data, COORD_PAUSER, pauser.as_ref());
    data[COORD_CHAIN_IDENTIFIER_LEN] = LOCAL_SOLANA_CHAIN_ID.len() as u8;
    put(&mut data, COORD_CHAIN_IDENTIFIER, &LOCAL_SOLANA_CHAIN_ID);
    data[COORD_VAULT_AUTHORITY_BUMP] =
        Pubkey::find_program_address(&[b"vault_authority"], &PROGRAM_ID).1;
    put(
        &mut data,
        COORD_CHAIN_NUMBER,
        &TEST_CHAIN_NUMBER.to_le_bytes(),
    );
    data[COORD_NETWORK] = TEST_NETWORK;
    data
}

/// The data of a NetworkEncryptionKey record for the network key
/// `noa_pubkey`, in `state`.
pub fn build_nek_data(noa_pubkey: &Pubkey, state: u8, bump: u8) -> Vec<u8> {
    let mut data = vec![0u8; NETWORK_ENCRYPTION_KEY_LEN];
    data[0] = DISC_NETWORK_ENCRYPTION_KEY;
    data[1] = 1; // version
    put(&mut data, NEK_NOA_PUBKEY, noa_pubkey.as_ref());
    data[NEK_STATE] = state;
    put(&mut data, NEK_CREATED_EPOCH, &1u64.to_le_bytes());
    data[NEK_BUMP] = bump;
    data
}

/// The data of a DWallet account.
#[allow(clippy::too_many_arguments)]
pub fn build_dwallet_data(
    owner: &Pubkey,
    curve: u16,
    state: u8,
    public_key_len: u8,
    public_key: &[u8],
    noa_pubkey: &Pubkey,
    is_imported: u8,
    bump: u8,
) -> Vec<u8> {
    let mut data = vec![0u8; DWALLET_LEN];
    data[0] = DISC_DWALLET;
    data[1] = 1; // version
    put(&mut data, DW_OWNER, owner.as_ref());
    put(&mut data, DW_CURVE, &curve.to_le_bytes());
    data[DW_STATE] = state;
    data[DW_PUBLIC_KEY_LEN] = public_key_len;
    let copy_len = public_key.len().min(65);
    put(&mut data, DW_PUBLIC_KEY, &public_key[..copy_len]);
    put(&mut data, DW_CREATED_EPOCH, &1u64.to_le_bytes());
    put(&mut data, DW_NOA_PUBLIC_KEY, noa_pubkey.as_ref());
    data[DW_IS_IMPORTED] = is_imported;
    data[DW_BUMP] = bump;
    data
}

/// A `TransferDWallet` instruction signed by the dWallet's owner.
///
/// Accounts: the owner (signer), the dWallet (writable). Data: the
/// instruction byte, then the new owner.
pub fn build_transfer_dwallet_ix(
    program_id: &Pubkey,
    owner: &Pubkey,
    dwallet: &Pubkey,
    new_owner: &Pubkey,
) -> Instruction {
    let mut data = Vec::with_capacity(33);
    data.push(IX_TRANSFER_DWALLET);
    data.extend_from_slice(new_owner.as_ref());
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new_readonly(*owner, true),
            AccountMeta::new(*dwallet, false),
        ],
        data,
    }
}

/// `curve || public_key`: the root a dWallet's address is derived from. The
/// address's seeds are `["dwallet", "record", ...]` followed by this root,
/// split into 32-byte seeds.
pub fn pack_dwallet_seed_payload(curve: u16, public_key: &[u8]) -> Vec<u8> {
    let mut payload = Vec::with_capacity(2_usize.saturating_add(public_key.len()));
    payload.extend_from_slice(&curve.to_le_bytes());
    payload.extend_from_slice(public_key);
    payload
}

/// A LiteSVM with the ika program loaded, a funded payer, and the accounts
/// the ika network would have written: the dWallet coordinator and one
/// active network encryption key.
pub struct DWalletTestContext {
    pub svm: LiteSVM,
    /// The ika program's address.
    pub dwallet_program_id: Pubkey,
    /// A funded payer.
    pub payer: Keypair,
    /// The network key the test dWallets name.
    pub noa_keypair: Keypair,
    /// The DWalletCoordinator's address, `["dwallet_coordinator"]`.
    pub coordinator_pda: Pubkey,
    /// The network key's record, `["network_encryption_key", key]`.
    pub nek_pda: Pubkey,
}

impl DWalletTestContext {
    /// Load the ika program and write the coordinator and the network key.
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        let dwallet_program_id = PROGRAM_ID;
        svm.add_program_from_file(pubkey_to_address(&dwallet_program_id), DWALLET_PROGRAM_PATH)
            .expect("load the ika program from bin/ika_protocol_test.so");

        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 100_000_000_000)
            .expect("airdrop the payer");

        let noa_keypair = Keypair::new();
        let noa_pubkey = keypair_pubkey(&noa_keypair);

        let (coordinator_pda, coordinator_bump) =
            Pubkey::find_program_address(&[b"dwallet_coordinator"], &dwallet_program_id);
        let coordinator_data =
            build_coordinator_data(&Pubkey::new_unique(), TEST_EPOCH, coordinator_bump);
        svm.set_account(
            pubkey_to_address(&coordinator_pda),
            program_account(&dwallet_program_id, coordinator_data),
        )
        .expect("write the coordinator");

        let (nek_pda, nek_bump) = Pubkey::find_program_address(
            &[b"network_encryption_key", noa_pubkey.as_ref()],
            &dwallet_program_id,
        );
        svm.set_account(
            pubkey_to_address(&nek_pda),
            program_account(
                &dwallet_program_id,
                build_nek_data(&noa_pubkey, NEK_STATE_ACTIVE, nek_bump),
            ),
        )
        .expect("write the network key");

        Self {
            svm,
            dwallet_program_id,
            payer,
            noa_keypair,
            coordinator_pda,
            nek_pda,
        }
    }

    /// Load a program from `elf_path` at a new address, and return it.
    pub fn deploy_program(&mut self, elf_path: &str) -> Pubkey {
        let program_id = Pubkey::new_unique();
        self.deploy_program_at(&program_id, elf_path);
        program_id
    }

    /// Load a program from `elf_path` at `program_id`.
    pub fn deploy_program_at(&mut self, program_id: &Pubkey, elf_path: &str) {
        self.svm
            .add_program_from_file(pubkey_to_address(program_id), elf_path)
            .expect("load the program");
    }

    /// The CPI authority of `caller_program_id`, and its bump.
    pub fn cpi_authority_for(&self, caller_program_id: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[CPI_AUTHORITY_SEED], caller_program_id)
    }

    /// Write an active dWallet owned by `owner`, at its canonical address,
    /// and return that address.
    pub fn create_dwallet(
        &mut self,
        owner: &Pubkey,
        curve: u16,
        public_key_len: u8,
        public_key: &[u8],
    ) -> Pubkey {
        let actual_key = &public_key[..public_key_len as usize];
        let payload = pack_dwallet_seed_payload(curve, actual_key);
        let mut seeds: Vec<&[u8]> = vec![b"dwallet", b"record"];
        seeds.extend(payload.chunks(32));
        let (dwallet_pda, dwallet_bump) =
            Pubkey::find_program_address(&seeds, &self.dwallet_program_id);

        let noa_pubkey = keypair_pubkey(&self.noa_keypair);
        let dwallet_data = build_dwallet_data(
            owner,
            curve,
            DW_STATE_ACTIVE,
            public_key_len,
            public_key,
            &noa_pubkey,
            0,
            dwallet_bump,
        );
        self.svm
            .set_account(
                pubkey_to_address(&dwallet_pda),
                program_account(&self.dwallet_program_id, dwallet_data),
            )
            .expect("write the dWallet");
        dwallet_pda
    }

    /// Transfer `dwallet` from `current_owner` to `new_owner`, with the ika
    /// program's own `TransferDWallet`.
    pub fn transfer_dwallet(
        &mut self,
        dwallet: &Pubkey,
        current_owner: &Keypair,
        new_owner: &Pubkey,
    ) {
        let ix = build_transfer_dwallet_ix(
            &self.dwallet_program_id,
            &keypair_pubkey(current_owner),
            dwallet,
            new_owner,
        );
        let payer = self.clone_payer();
        self.send_tx(&[current_owner, &payer], &[ix]);
    }

    /// Send a transaction the payer pays for, signed by `signers`, and panic
    /// if it fails.
    pub fn send_tx(&mut self, signers: &[&Keypair], ixs: &[Instruction]) {
        self.try_send_tx(signers, ixs)
            .expect("send_transaction failed");
    }

    /// Send a transaction the payer pays for, signed by `signers`. The error
    /// is LiteSVM's own, which carries the logs a test asserts on.
    #[allow(clippy::result_large_err)]
    pub fn try_send_tx(
        &mut self,
        signers: &[&Keypair],
        ixs: &[Instruction],
    ) -> Result<litesvm::types::TransactionMetadata, litesvm::types::FailedTransactionMetadata>
    {
        let blockhash: Hash = self.svm.latest_blockhash();
        let tx =
            Transaction::new_signed_with_payer(ixs, Some(&self.payer.pubkey()), signers, blockhash);
        self.svm.send_transaction(tx)
    }

    /// The data of the account at `pubkey`, if it exists.
    pub fn get_account_data(&self, pubkey: &Pubkey) -> Option<Vec<u8>> {
        self.svm
            .get_account(&pubkey_to_address(pubkey))
            .map(|account| account.data.to_vec())
    }

    /// Whether an account exists at `pubkey`.
    pub fn account_exists(&self, pubkey: &Pubkey) -> bool {
        self.svm.get_account(&pubkey_to_address(pubkey)).is_some()
    }

    /// A new keypair holding 10 SOL.
    pub fn new_funded_keypair(&mut self) -> Keypair {
        let keypair = Keypair::new();
        self.svm
            .airdrop(&keypair.pubkey(), 10_000_000_000)
            .expect("airdrop");
        keypair
    }

    /// A copy of the payer's keypair.
    pub fn clone_payer(&self) -> Keypair {
        Keypair::new_from_array(*self.payer.secret_bytes())
    }
}

impl Default for DWalletTestContext {
    fn default() -> Self {
        Self::new()
    }
}
