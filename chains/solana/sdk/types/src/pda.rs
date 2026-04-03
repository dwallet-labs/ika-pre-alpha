// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! PDA derivation helpers for off-chain clients.

use pinocchio::Address;

/// Derive the SystemState PDA address.
pub fn find_system_state_address(program_id: &Address) -> (Address, u8) {
    Address::find_program_address(&[b"ika_system_state"], program_id)
}

/// Derive a Validator PDA address from the validator's identity pubkey.
pub fn find_validator_address(program_id: &Address, identity: &[u8; 32]) -> (Address, u8) {
    Address::find_program_address(&[b"validator", identity.as_ref()], program_id)
}

/// Derive a StakeAccount PDA address from the stake ID.
pub fn find_stake_account_address(program_id: &Address, stake_id: u64) -> (Address, u8) {
    let stake_id_bytes = stake_id.to_le_bytes();
    Address::find_program_address(&[b"stake_account", stake_id_bytes.as_ref()], program_id)
}

/// Derive the ValidatorList PDA address.
pub fn find_validator_list_address(program_id: &Address) -> (Address, u8) {
    Address::find_program_address(&[b"validator_list"], program_id)
}

/// Derive the mint authority PDA address.
pub fn find_mint_authority_address(program_id: &Address) -> (Address, u8) {
    Address::find_program_address(&[b"mint_authority"], program_id)
}

/// Derive the event authority PDA address.
pub fn find_event_authority_address(program_id: &Address) -> (Address, u8) {
    Address::find_program_address(&[b"__event_authority"], program_id)
}
