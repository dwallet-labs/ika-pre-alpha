// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! Account data readers for off-chain consumption.
//!
//! These parse raw account data (including discriminator + version prefix)
//! into typed field accessors without heap allocation.

/// Account discriminator values.
pub const DISC_SYSTEM_STATE: u8 = 1;
pub const DISC_VALIDATOR: u8 = 2;
pub const DISC_STAKE_ACCOUNT: u8 = 3;
pub const DISC_VALIDATOR_LIST: u8 = 4;

/// SystemState account total size (discriminator + version + data).
pub const SYSTEM_STATE_LEN: usize = 2 + 363;

/// Validator account total size.
pub const VALIDATOR_LEN: usize = 2 + 971;

/// StakeAccount account total size.
pub const STAKE_ACCOUNT_LEN: usize = 2 + 113;

/// Read a u64 LE from a byte slice at the given offset.
#[inline(always)]
fn read_u64(data: &[u8], offset: usize) -> u64 {
    let bytes: [u8; 8] = data[offset..offset + 8].try_into().unwrap();
    u64::from_le_bytes(bytes)
}

/// Read a u32 LE from a byte slice at the given offset.
#[inline(always)]
fn read_u32(data: &[u8], offset: usize) -> u32 {
    let bytes: [u8; 4] = data[offset..offset + 4].try_into().unwrap();
    u32::from_le_bytes(bytes)
}

/// Read a u16 LE from a byte slice at the given offset.
#[inline(always)]
fn read_u16(data: &[u8], offset: usize) -> u16 {
    let bytes: [u8; 2] = data[offset..offset + 2].try_into().unwrap();
    u16::from_le_bytes(bytes)
}

// -- SystemState readers --
// Offsets are relative to account data start (after discriminator + version = byte 2).

/// Read SystemState.epoch from raw account data.
pub fn system_state_epoch(data: &[u8]) -> Option<u64> {
    if data.len() < SYSTEM_STATE_LEN || data[0] != DISC_SYSTEM_STATE {
        return None;
    }
    Some(read_u64(data, 2))
}

/// Read SystemState.authority from raw account data.
pub fn system_state_authority(data: &[u8]) -> Option<&[u8]> {
    if data.len() < SYSTEM_STATE_LEN || data[0] != DISC_SYSTEM_STATE {
        return None;
    }
    // authority starts at offset 2 + 24 + 8 = 34
    Some(&data[34..66])
}

// -- Validator readers --

/// Read Validator.state from raw account data (0=PreActive, 1=Active, 2=Withdrawing).
pub fn validator_state(data: &[u8]) -> Option<u8> {
    if data.len() < VALIDATOR_LEN || data[0] != DISC_VALIDATOR {
        return None;
    }
    // state at offset 2 + 96 = 98
    Some(data[98])
}

/// Read Validator.identity from raw account data.
pub fn validator_identity(data: &[u8]) -> Option<&[u8]> {
    if data.len() < VALIDATOR_LEN || data[0] != DISC_VALIDATOR {
        return None;
    }
    Some(&data[2..34])
}

/// Read Validator.ika_balance from raw account data.
pub fn validator_ika_balance(data: &[u8]) -> Option<u64> {
    if data.len() < VALIDATOR_LEN || data[0] != DISC_VALIDATOR {
        return None;
    }
    // ika_balance offset: 2 + 96 + 17 + 8 + 36 = 159
    Some(read_u64(data, 159))
}

// -- StakeAccount readers --

/// Read StakeAccount.owner from raw account data.
pub fn stake_account_owner(data: &[u8]) -> Option<&[u8]> {
    if data.len() < STAKE_ACCOUNT_LEN || data[0] != DISC_STAKE_ACCOUNT {
        return None;
    }
    Some(&data[2..34])
}

/// Read StakeAccount.state from raw account data (0=Active, 1=Withdrawing).
pub fn stake_account_state(data: &[u8]) -> Option<u8> {
    if data.len() < STAKE_ACCOUNT_LEN || data[0] != DISC_STAKE_ACCOUNT {
        return None;
    }
    // state at offset: 2 + 32 + 32 + 8 + 8 + 8 + 8 = 98
    Some(data[98])
}

/// Read StakeAccount.principal from raw account data.
pub fn stake_account_principal(data: &[u8]) -> Option<u64> {
    if data.len() < STAKE_ACCOUNT_LEN || data[0] != DISC_STAKE_ACCOUNT {
        return None;
    }
    // principal at offset: 2 + 32 + 32 + 8 = 74
    Some(read_u64(data, 74))
}

// -- ValidatorList readers --

/// Read ValidatorList.validator_count from raw account data.
pub fn validator_list_validator_count(data: &[u8]) -> Option<u32> {
    if data.len() < 18 || data[0] != DISC_VALIDATOR_LIST {
        return None;
    }
    Some(read_u32(data, 2))
}

/// Read ValidatorList.active_count from raw account data.
pub fn validator_list_active_count(data: &[u8]) -> Option<u32> {
    if data.len() < 18 || data[0] != DISC_VALIDATOR_LIST {
        return None;
    }
    Some(read_u32(data, 6))
}
