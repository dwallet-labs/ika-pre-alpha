// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

//! gRPC client and server types for the Ika dWallet signing service.
//!
//! Generated from `proto/ika_dwallet.proto`. Provides both client and server
//! types for the `DWalletService` gRPC API:
//! - `SubmitTransaction`: single RPC for all dWallet operations (DKG, sign, presign, etc.)
//! - `GetPresigns`: query global presigns for a user
//! - `GetPresignsForDWallet`: query dWallet-specific presigns for a user
//!
//! The request type is encoded inside the BCS-serialized `SignedRequestData.request`
//! (`DWalletRequest` enum variant), which is covered by the user's signature.
//!
//! # Client usage
//!
//! ```ignore
//! use ika_grpc::d_wallet_service_client::DWalletServiceClient;
//! use ika_grpc::UserSignedRequest;
//!
//! let mut client = DWalletServiceClient::connect("https://pre-alpha-dev-1.ika.ika-network.net:443").await?;
//! let resp = client.submit_transaction(UserSignedRequest {
//!     user_signature: signature_bytes.to_vec(),
//!     signed_request_data: bcs_serialized_signed_request_data,
//! }).await?;
//! let tx_response = resp.into_inner();
//! // BCS-deserialize tx_response.response_data -> TransactionResponseData
//! ```
//!
//! # Server usage
//!
//! ```ignore
//! use ika_grpc::d_wallet_service_server::{DWalletService, DWalletServiceServer};
//! ```

include!(concat!(env!("OUT_DIR"), "/ika.dwallet.v1.rs"));
