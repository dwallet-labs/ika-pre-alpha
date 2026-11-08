// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The user's half of each protocol step, as one client runs it.
 *
 * Every client holds one {@link UserCryptography}. It is
 * {@link realCryptography}, the 2PC-MPC protocol, unless the client was
 * created for a mock ika network with `withMockCryptography` from the
 * separate entry `@ika.xyz/pre-alpha-core/mock`. The main entry never imports that
 * entry, so an app that does not import it ships no mock code.
 *
 * The real implementation refuses every mock value
 * (`refuseMockValues`). The choice belongs to one client: two clients in one
 * process, one in mock mode and one not, do not affect each other.
 */
import {
	createUserSignMessageEcdsaBlake2b256,
	createUserSignMessageWithPublicOutput,
	createUserSignMessageWithUserPublicOutput,
	decryptUserShareOfOutput,
	encryptSecretShare,
	networkDkgPublicOutputToProtocolPublicParameters,
	prepareDKGForSessionIdentifier,
	prepareImportedKeyVerificationForSessionIdentifier,
	publicKeyFromCentralizedDKGOutput,
	publicKeyFromDWalletOutput,
	reconfigurationPublicOutputToProtocolPublicParameters,
	userAndNetworkDKGOutputMatch,
	verifyEcdsaBlake2b256Signature,
	verifySignature,
} from './cryptography.js';
import { refuseMockValues } from './mock-format.js';
import { decrypt_user_share } from './wasm-loader.js';

/** The user's half of each protocol step. */
export interface UserCryptography {
	/** Whether this is a mock ika network's cryptography. */
	readonly mock: boolean;
	readonly networkDkgPublicOutputToProtocolPublicParameters: typeof networkDkgPublicOutputToProtocolPublicParameters;
	readonly reconfigurationPublicOutputToProtocolPublicParameters: typeof reconfigurationPublicOutputToProtocolPublicParameters;
	readonly prepareDKGForSessionIdentifier: typeof prepareDKGForSessionIdentifier;
	readonly prepareImportedKeyVerificationForSessionIdentifier: typeof prepareImportedKeyVerificationForSessionIdentifier;
	readonly encryptSecretShare: typeof encryptSecretShare;
	readonly decryptUserShareOfOutput: typeof decryptUserShareOfOutput;
	/**
	 * The share `encryptedShareAndProof` decrypts to under `decryptionKey`,
	 * for the dWallet output `publicOutput`, on the curve numbered `curve`.
	 * Throws when it does not decrypt.
	 */
	readonly decryptUserShare: (
		curve: number,
		decryptionKey: Uint8Array,
		publicOutput: Uint8Array,
		encryptedShareAndProof: Uint8Array,
		protocolPublicParameters: Uint8Array,
	) => Promise<Uint8Array>;
	readonly publicKeyFromDWalletOutput: typeof publicKeyFromDWalletOutput;
	readonly publicKeyFromCentralizedDKGOutput: typeof publicKeyFromCentralizedDKGOutput;
	readonly userAndNetworkDKGOutputMatch: typeof userAndNetworkDKGOutputMatch;
	readonly createUserSignMessageWithPublicOutput: typeof createUserSignMessageWithPublicOutput;
	readonly createUserSignMessageWithUserPublicOutput: typeof createUserSignMessageWithUserPublicOutput;
	readonly createUserSignMessageEcdsaBlake2b256: typeof createUserSignMessageEcdsaBlake2b256;
	readonly verifySignature: typeof verifySignature;
	readonly verifyEcdsaBlake2b256Signature: typeof verifyEcdsaBlake2b256Signature;
}

/** The 2PC-MPC protocol. Every mock value is refused. */
export const realCryptography: UserCryptography = Object.freeze<UserCryptography>({
	mock: false,
	networkDkgPublicOutputToProtocolPublicParameters,
	reconfigurationPublicOutputToProtocolPublicParameters,
	prepareDKGForSessionIdentifier,
	prepareImportedKeyVerificationForSessionIdentifier,
	encryptSecretShare,
	decryptUserShareOfOutput,
	decryptUserShare: async (
		curve: number,
		decryptionKey: Uint8Array,
		publicOutput: Uint8Array,
		encryptedShareAndProof: Uint8Array,
		protocolPublicParameters: Uint8Array,
	) => {
		refuseMockValues(publicOutput, encryptedShareAndProof, protocolPublicParameters);
		return Uint8Array.from(
			await decrypt_user_share(
				curve,
				decryptionKey,
				publicOutput,
				encryptedShareAndProof,
				protocolPublicParameters,
			),
		);
	},
	publicKeyFromDWalletOutput,
	publicKeyFromCentralizedDKGOutput,
	userAndNetworkDKGOutputMatch,
	createUserSignMessageWithPublicOutput,
	createUserSignMessageWithUserPublicOutput,
	createUserSignMessageEcdsaBlake2b256,
	verifySignature,
	verifyEcdsaBlake2b256Signature,
});
