// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

// The entries of the ika program's wire table that this SDK uses: the
// instruction bytes, account discriminators and lengths, and seed layouts of
// the dWallet instructions and accounts. Generated from the program's own
// table. Do not edit by hand.
const tables = {
	"schema_version": 1,
	"program": "ika_protocol",
	"account_header": {
		"discriminator_offset": 0,
		"version_offset": 1,
		"len": 2
	},
	"instructions": {
		"DWalletTransferOwnership": 129,
		"DWalletCommitDWallet": 132,
		"DWalletCreateDeposit": 136,
		"DWalletTopUp": 137,
		"DWalletPauseSigningParameter": 151,
		"DWalletUnpauseSigningParameter": 152,
		"DWalletRegisterEncryptionKey": 153,
		"DWalletIssueSignatureVoucher": 156,
		"DWalletSetVoucherSigningKey": 157,
		"DWalletRevokeSignatureVoucher": 158,
		"DWalletTransferSignatureVoucher": 159,
		"DWalletIssueFutureSignatureVoucher": 161,
		"DWalletAcceptEncryptedUserShare": 165
	},
	"accounts": {
		"SystemState": {
			"discriminator": 1,
			"version": 1,
			"data_len": 566
		},
		"DWalletCoordinator": {
			"discriminator": 96,
			"version": 1,
			"data_len": 631
		},
		"DWallet": {
			"discriminator": 97,
			"version": 1,
			"data_len": 185
		},
		"NetworkEncryptionKey": {
			"discriminator": 98,
			"version": 1,
			"data_len": 199
		},
		"GasDeposit": {
			"discriminator": 99,
			"version": 1,
			"data_len": 147
		},
		"EncryptedUserSecretKeyShare": {
			"discriminator": 101,
			"version": 1,
			"header_len": 214,
			"variable": true
		},
		"NetworkReconfigurationOutput": {
			"discriminator": 102,
			"version": 1,
			"data_len": 182
		},
		"DWalletAttestation": {
			"discriminator": 104,
			"version": 1,
			"header_len": 101,
			"variable": true
		},
		"GasCharge": {
			"discriminator": 106,
			"version": 1,
			"data_len": 91
		},
		"EncryptionKey": {
			"discriminator": 107,
			"version": 1,
			"header_len": 120,
			"variable": true
		},
		"SignatureVoucher": {
			"discriminator": 108,
			"version": 1,
			"data_len": 304
		},
		"FutureSignatureVoucher": {
			"discriminator": 109,
			"version": 1,
			"data_len": 1941
		}
	},
	"seed_schemas": {
		"SystemState": {
			"owner": "system",
			"components": [
				{
					"name": "prefix",
					"literal": "ika_system_state"
				}
			]
		},
		"DWalletCoordinator": {
			"owner": "dwallet",
			"components": [
				{
					"name": "prefix",
					"literal": "dwallet_coordinator"
				}
			]
		},
		"DWallet": {
			"owner": "dwallet",
			"components": [
				{
					"name": "prefix",
					"literal": "dwallet"
				},
				{
					"name": "tag",
					"literal": "record"
				},
				{
					"name": "dwallet_root",
					"chunks_of": 32,
					"min_len": 34,
					"max_len": 67
				}
			]
		},
		"DWalletAttestation": {
			"owner": "dwallet",
			"components": [
				{
					"name": "prefix",
					"literal": "dwallet"
				},
				{
					"name": "tag",
					"literal": "attestation"
				},
				{
					"name": "dwallet_root",
					"chunks_of": 32,
					"min_len": 34,
					"max_len": 67
				}
			]
		},
		"ImportedDWallet": {
			"owner": "dwallet",
			"components": [
				{
					"name": "prefix",
					"literal": "dwallet"
				},
				{
					"name": "tag",
					"literal": "imported_record"
				},
				{
					"name": "dwallet_root",
					"chunks_of": 32,
					"min_len": 34,
					"max_len": 67
				},
				{
					"name": "session_identifier",
					"width": 32
				}
			]
		},
		"ImportedDWalletAttestation": {
			"owner": "dwallet",
			"components": [
				{
					"name": "prefix",
					"literal": "dwallet"
				},
				{
					"name": "tag",
					"literal": "imported_attestation"
				},
				{
					"name": "dwallet_root",
					"chunks_of": 32,
					"min_len": 34,
					"max_len": 67
				},
				{
					"name": "session_identifier",
					"width": 32
				}
			]
		},
		"PublicUserShareAttestation": {
			"owner": "dwallet",
			"components": [
				{
					"name": "prefix",
					"literal": "dwallet"
				},
				{
					"name": "tag",
					"literal": "public_user_share"
				},
				{
					"name": "dwallet_root",
					"chunks_of": 32,
					"min_len": 34,
					"max_len": 67
				}
			]
		},
		"EncryptedShareAttestation": {
			"owner": "dwallet",
			"components": [
				{
					"name": "prefix",
					"literal": "dwallet"
				},
				{
					"name": "tag",
					"literal": "encrypted_share_attestation"
				},
				{
					"name": "dwallet_root",
					"chunks_of": 32,
					"min_len": 34,
					"max_len": 67
				},
				{
					"name": "encryption_key_owner",
					"width": 32
				}
			]
		},
		"EncryptedUserSecretKeyShare": {
			"owner": "dwallet",
			"components": [
				{
					"name": "prefix",
					"literal": "dwallet"
				},
				{
					"name": "tag",
					"literal": "encrypted_user_share"
				},
				{
					"name": "dwallet_root",
					"chunks_of": 32,
					"min_len": 34,
					"max_len": 67
				},
				{
					"name": "encryption_key_owner",
					"width": 32
				}
			]
		},
		"ImportedPublicUserShareAttestation": {
			"owner": "dwallet",
			"components": [
				{
					"name": "prefix",
					"literal": "dwallet"
				},
				{
					"name": "tag",
					"literal": "imported_public_user_share"
				},
				{
					"name": "dwallet_root",
					"chunks_of": 32,
					"min_len": 34,
					"max_len": 67
				},
				{
					"name": "session_identifier",
					"width": 32
				}
			]
		},
		"ImportedEncryptedShareAttestation": {
			"owner": "dwallet",
			"components": [
				{
					"name": "prefix",
					"literal": "dwallet"
				},
				{
					"name": "tag",
					"literal": "imported_enc_share_attestation"
				},
				{
					"name": "dwallet_root",
					"chunks_of": 32,
					"min_len": 34,
					"max_len": 67
				},
				{
					"name": "session_identifier",
					"width": 32
				},
				{
					"name": "encryption_key_owner",
					"width": 32
				}
			]
		},
		"ImportedEncryptedUserSecretKeyShare": {
			"owner": "dwallet",
			"components": [
				{
					"name": "prefix",
					"literal": "dwallet"
				},
				{
					"name": "tag",
					"literal": "imported_encrypted_user_share"
				},
				{
					"name": "dwallet_root",
					"chunks_of": 32,
					"min_len": 34,
					"max_len": 67
				},
				{
					"name": "session_identifier",
					"width": 32
				},
				{
					"name": "encryption_key_owner",
					"width": 32
				}
			]
		},
		"GasDeposit": {
			"owner": "dwallet",
			"components": [
				{
					"name": "prefix",
					"literal": "gas_deposit"
				},
				{
					"name": "user_pubkey",
					"width": 32
				}
			]
		},
		"GasCharge": {
			"owner": "dwallet",
			"components": [
				{
					"name": "prefix",
					"literal": "gas_charge"
				},
				{
					"name": "charge_id",
					"width": 32
				}
			]
		},
		"NetworkEncryptionKey": {
			"owner": "dwallet",
			"components": [
				{
					"name": "prefix",
					"literal": "network_encryption_key"
				},
				{
					"name": "noa_public_key",
					"width": 32
				}
			]
		},
		"NetworkReconfigurationOutput": {
			"owner": "dwallet",
			"components": [
				{
					"name": "prefix",
					"literal": "network_reconfig"
				},
				{
					"name": "noa_public_key",
					"width": 32
				},
				{
					"name": "epoch_le",
					"width": 8
				}
			]
		},
		"EncryptionKey": {
			"owner": "dwallet",
			"components": [
				{
					"name": "prefix",
					"literal": "encryption_key"
				},
				{
					"name": "signer_public_key",
					"width": 32
				},
				{
					"name": "curve_le",
					"width": 2
				}
			]
		}
	}
};

export default tables;
