// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The ownership check an approval needs, and the reader it runs on.
 *
 * The SDK signs for a dWallet only when the user's own key holds its share
 * (`assertDWalletUsable` in `@ika.xyz/sdk-core`). Someone can create a dWallet
 * for your address whose share only their key holds, so an approval builder
 * takes the check's result, or a function that runs the check, and refuses
 * without one. The result's type is declared here by its shape.
 *
 * The reader the check runs on, `dwalletShareReader`, checks every account
 * it returns against the chain before the core checks its attestation again.
 */
import {
	AttestationRecordError,
	copyFromReader,
	copyTrustedNetworkKeys,
	verifyDWalletAttestationRecord,
	verifyStoredDWallet,
} from '@ika.xyz/sdk-core';
import type {
	AttestationRecord,
	CheckedDWalletRecord,
	DWalletLookup,
	DWalletShareReader,
	TrustedNetworkKeys,
} from '@ika.xyz/sdk-core';

import {
	readDWallet,
	readDWalletAttestationUnverified,
	readEncryptedShareAttestationUnverified,
	readEncryptedUserSecretKeyShareUnverified,
	readEncryptionKeyUnverified,
	readPublicShareAttestationUnverified,
} from './accounts.js';
import type { DWalletAccount } from './accounts.js';
import {
	dwalletAttestationPda,
	dwalletPda,
	encryptedShareAttestationPda,
	encryptedUserSecretKeySharePda,
	encryptionKeyPda,
	publicUserShareAttestationPda,
} from './addresses.js';
import { assertSolanaReadCrossCheck, crossCheckedAccountRead } from './read-cross-check.js';
import type { GetAccount, SolanaReadCrossCheck } from './read-cross-check.js';
import { verifySolanaEncryptedShareRecord } from './record-checks.js';
import type { SolanaEncryptedShareAccountInput } from './record-checks.js';

/**
 * What `assertDWalletUsable` returns. `dwallet.address` is the dWallet
 * record's 32-byte address, `holder` the user's signer key the check ran for,
 * and `share` says whether the user's key holds an encrypted share
 * (`encrypted`) or the share is public (`public`).
 */
export interface DWalletUsableResult {
	readonly dwallet: { readonly chain: 'sui' | 'solana'; readonly address: Uint8Array };
	readonly holder: Uint8Array;
	readonly share: 'encrypted' | 'public';
	readonly verifiedAt: Date;
}

/**
 * How an approval builder learns that the user's key holds the dWallet's
 * share. `holderSignerPublicKey` is the user's signer key, the one the SDK's
 * `UserShareEncryptionKeys.getSigningPublicKeyBytes()` returns. Then either
 * `usable`, the result of an earlier `assertDWalletUsable` for this dWallet
 * and this key, and the builder reads nothing; or `check`, a function that
 * runs `assertDWalletUsable` and returns its result, which the builder
 * calls. Given neither, the builder refuses.
 *
 * The builder binds a result to what it approves: the result must name this
 * chain, this dWallet's address and `holderSignerPublicKey`, so a result
 * copied from another dWallet, or checked for another key, is refused. It
 * cannot tell a genuine result from one built by hand, because this package
 * does not depend on the SDK. So a result must come from the SDK's check,
 * run in the caller's own process, and never from outside it: not from a
 * client, a request or a file. A service that approves for a dWallet an
 * untrusted party names passes `check`, which reads the chain again, not a
 * result.
 */
export interface ApprovalUsability {
	holderSignerPublicKey: Uint8Array;
	usable?: DWalletUsableResult;
	check?: () => Promise<DWalletUsableResult>;
}

/** Whether two attestation records hold the same stored fields. */
function sameAttestationRecord(first: AttestationRecord, second: AttestationRecord): boolean {
	return (
		sameBytes(first.attestationData, second.attestationData) &&
		first.attestationVersion === second.attestationVersion &&
		sameBytes(first.networkSignature, second.networkSignature) &&
		sameBytes(first.signerNoaPublicKey, second.signerNoaPublicKey)
	);
}

function sameBytes(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
	return (
		left.length === right.length && Array.from(left).every((byte, index) => byte === right[index])
	);
}

/**
 * Require the ownership check for the dWallet record at `dwalletAddress` and
 * the user's key: reuse `usability.usable`, or run `usability.check`. Throws
 * when given neither, or when the result is for another chain, dWallet or
 * key.
 */
export async function requireApprovalUsability(
	usability: ApprovalUsability | undefined,
	dwalletAddress: Uint8Array,
): Promise<DWalletUsableResult> {
	const result =
		usability?.usable ?? (usability?.check !== undefined ? await usability.check() : undefined);
	if (usability === undefined || result === undefined) {
		throw new Error(
			"an approval needs the ownership check: pass the result of the SDK's assertDWalletUsable " +
				'for this dWallet, or a function that runs it. The builder does not approve for a ' +
				'dWallet whose share your key may not hold',
		);
	}
	if (result.dwallet.chain !== 'solana' || !sameBytes(result.dwallet.address, dwalletAddress)) {
		throw new Error("the ownership check's result is for another dWallet than this approval's");
	}
	if (!sameBytes(result.holder, usability.holderSignerPublicKey)) {
		throw new Error("the ownership check's result is for another user key than the one given");
	}
	return result;
}

/** An account as an RPC read returns it: its owner and its data. */
export interface ReadAccount {
	owner: Uint8Array;
	data: Uint8Array;
}

/**
 * The values of a dWallet account the checked reader uses, as `readDWallet`
 * returns them: the key that holds the dWallet's network share, and the
 * values it checks against the dWallet's attestation.
 */
export type SolanaDWalletAccountInput = Pick<
	DWalletAccount,
	'curve' | 'publicKey' | 'isImported' | 'importedSessionIdentifier' | 'noaPublicKey'
>;

/**
 * The Solana account reads a checked reader is built on, none of them
 * verified. `dwalletShareReader` makes them from an RPC read. Another source
 * of the same accounts (a cache, a test) can supply them to
 * `checkedSolanaShareReader`, which checks every account they return. Each
 * read derives the account's address from what it is given, and resolves
 * `undefined` when no account exists there.
 */
export interface SolanaDWalletAccountReadsUnverified {
	/**
	 * The network keys the caller trusts (`trustedNetworkKeys` of
	 * `@ika.xyz/sdk-core`), never one a record states about itself: on mainnet
	 * and testnet the keys the SDK lists, elsewhere the caller's own. A
	 * record's signer, and the key that holds the dWallet's network share,
	 * must each be one of them.
	 */
	trustedNetworkKeys: TrustedNetworkKeys;
	/** The address of the dWallet's record (`dwalletPda`). */
	dwalletAddress(
		curve: number,
		publicKey: Uint8Array,
		importedSessionIdentifier?: Uint8Array,
	): Uint8Array;
	readDWalletAttestation(
		curve: number,
		publicKey: Uint8Array,
		importedSessionIdentifier?: Uint8Array,
	): Promise<AttestationRecord | undefined>;
	/**
	 * The dWallet account at `dwalletAddress` (`readDWallet`); `undefined`
	 * when no account exists there. The checked reader takes the key that
	 * holds the dWallet's network share (`noaPublicKey`), and checks the
	 * curve, public key, import flag and import session against the
	 * dWallet's attestation. It does not check the owner, which
	 * `TransferDWallet` changes.
	 */
	readDWalletAccount(
		curve: number,
		publicKey: Uint8Array,
		importedSessionIdentifier?: Uint8Array,
	): Promise<SolanaDWalletAccountInput | undefined>;
	/**
	 * The share account, its attestation account, and the holder's encryption
	 * key as the holder's `EncryptionKey` account for `curve` registers it;
	 * `undefined` when the share or its attestation is missing.
	 */
	readEncryptedShare(
		curve: number,
		publicKey: Uint8Array,
		holderSignerPublicKey: Uint8Array,
		importedSessionIdentifier?: Uint8Array,
	): Promise<
		| {
				account: SolanaEncryptedShareAccountInput;
				attestation: AttestationRecord;
				registeredEncryptionKey: Uint8Array;
		  }
		| undefined
	>;
	readPublicShareAttestation(
		curve: number,
		publicKey: Uint8Array,
		importedSessionIdentifier?: Uint8Array,
	): Promise<AttestationRecord | undefined>;
	/**
	 * The dWallet account at `address`, whichever dWallet it is; `undefined`
	 * when no account exists there. The checked reader takes only its curve,
	 * public key and import session from it, and reads the dWallet again at
	 * the addresses those derive. Without it the reader cannot read a dWallet
	 * by its address.
	 */
	readDWalletAt?(address: Uint8Array): Promise<DWalletAccount | undefined>;
}

/**
 * The reader for the core's ownership check (`assertDWalletUsable` and
 * `signReEncryptedShareAcceptance` in `@ika.xyz/sdk-core`), over `reads`.
 * Every account it returns is checked first: the dWallet's attestation with
 * the core's `verifyDWalletAttestationRecord`, the dWallet account's network
 * key, which must be one of the trusted keys, the dWallet account's curve,
 * public key, import flag and import session against the attestation with
 * the core's `verifyStoredDWallet` (the program no longer compares them when
 * it commits the dWallet; the owner is not compared, because
 * `TransferDWallet` changes it), and an encrypted share's
 * account with `verifySolanaEncryptedShareRecord`, which compares every
 * stored field and the holder's registered encryption key with the share's
 * attestation and verifies the holder's acceptance signature. A public share's attestation account stores nothing
 * beside the attestation, which the core checks. A record that fails its
 * check rejects with an `AttestationRecordError`.
 *
 * `reads` is taken once, here. The dWallet's address is derived, and copied,
 * before the first wait. A byte array goes into a read only as a fresh copy,
 * and every value a read returns is copied before it is checked.
 */
export function checkedSolanaShareReader(
	reads: SolanaDWalletAccountReadsUnverified,
): DWalletShareReader {
	const keys = copyTrustedNetworkKeys(reads.trustedNetworkKeys);
	const dwalletAddress = reads.dwalletAddress.bind(reads);
	const readDWalletAttestation = reads.readDWalletAttestation.bind(reads);
	const readDWalletAccount = reads.readDWalletAccount.bind(reads);
	const readEncryptedShare = reads.readEncryptedShare.bind(reads);
	const readPublicShareAttestation = reads.readPublicShareAttestation.bind(reads);
	const readDWalletAt = reads.readDWalletAt?.bind(reads);
	const fresh = (bytes: Uint8Array) => Uint8Array.from(bytes);
	const checkedReadDWallet = async (
		lookup: DWalletLookup,
	): Promise<CheckedDWalletRecord | undefined> => {
		const { curve, publicKey, importedSessionIdentifier } = lookup;
		const freshSession = () =>
			importedSessionIdentifier === undefined ? undefined : fresh(importedSessionIdentifier);
		const address = fresh(dwalletAddress(curve, fresh(publicKey), freshSession()));
		const attestation = copyFromReader(
			await readDWalletAttestation(curve, fresh(publicKey), freshSession()),
		);
		if (attestation === undefined) {
			return undefined;
		}
		const dwallet = verifyDWalletAttestationRecord(attestation, keys, lookup);
		const account = copyFromReader(
			await readDWalletAccount(curve, fresh(publicKey), freshSession()),
		);
		if (account === undefined) {
			throw new AttestationRecordError(
				'record',
				'the dWallet has an attestation account but no dWallet account',
				'noa_public_key',
			);
		}
		const networkPublicKey = account.noaPublicKey;
		if (!keys.publicKeys.some((key) => sameBytes(key, networkPublicKey))) {
			throw new AttestationRecordError(
				'record',
				"the dWallet account's network key is not one of the trusted network keys",
				'noa_public_key',
			);
		}
		verifyStoredDWallet(
			{
				curve: account.curve,
				publicKey: account.publicKey,
				isImportedKey: account.isImported,
				importedSessionIdentifier: account.importedSessionIdentifier ?? undefined,
			},
			dwallet,
		);
		return {
			address,
			networkPublicKey,
			attestation,
			readEncryptedShare: async (holderSignerPublicKey, givenAcceptanceSignature) => {
				const share = copyFromReader(
					await readEncryptedShare(
						curve,
						fresh(publicKey),
						fresh(holderSignerPublicKey),
						freshSession(),
					),
				);
				if (share === undefined) {
					return undefined;
				}
				const verified = verifySolanaEncryptedShareRecord(
					share.account,
					share.attestation,
					keys,
					dwallet,
					address,
					{ holderSignerPublicKey },
					share.registeredEncryptionKey,
					givenAcceptanceSignature,
				);
				return { ...share.attestation, acceptanceGiven: verified.acceptanceGiven };
			},
			readPublicShare: async () =>
				copyFromReader(await readPublicShareAttestation(curve, fresh(publicKey), freshSession())),
		};
	};
	return {
		chain: 'solana',
		trustedNetworkKeys: keys,
		readDWallet: checkedReadDWallet,
		readDWalletAt:
			readDWalletAt === undefined
				? undefined
				: async (address): Promise<CheckedDWalletRecord | undefined> => {
						// The account at the address names a dWallet. That dWallet is then
						// read at the addresses its own values derive, and checked there.
						// Its derived address must be the address read: an account
						// elsewhere is not that dWallet's record.
						const asked = fresh(address);
						const stored = copyFromReader(await readDWalletAt(fresh(asked)));
						if (stored === undefined) {
							return undefined;
						}
						const record = await checkedReadDWallet({
							curve: stored.curve,
							publicKey: stored.publicKey,
							importedSessionIdentifier: stored.importedSessionIdentifier ?? undefined,
						});
						if (record !== undefined && !sameBytes(record.address, asked)) {
							throw new AttestationRecordError(
								'record',
								'the dWallet account read is not at the address its own dWallet derives',
								'address',
							);
						}
						return record;
					},
	};
}

/**
 * The reader for the core's ownership check, over the program's accounts
 * (`checkedSolanaShareReader`). `getAccount` reads one account by its 32-byte
 * address and resolves `null` when none exists (for example a wrapper around
 * `Connection.getAccountInfo`). Every account read must be owned by
 * `programId`, and must read as its type; otherwise the read rejects.
 * `trustedNetworkKeys` are the network keys the caller trusts, built with
 * `trustedNetworkKeys` of `@ika.xyz/sdk-core`: on mainnet and testnet the
 * network keys the SDK lists, and nothing else; on a custom network the keys
 * the caller passes, never keys read from the RPC that serves the accounts.
 * A dWallet made under an earlier network key has records a newer key
 * signed, so on a custom network pass both keys to read it.
 *
 * `crossCheck` is a second endpoint's `getAccount`, run by another provider,
 * or `'not-cross-checked'` (`SolanaReadCrossCheck`). With a second endpoint
 * the dWallet's public share attestation account is read through both, on
 * every network. A present account carries the network's signature, but
 * nothing signs its absence, and an endpoint that hid it would have a request
 * built for an encrypted share the network then refuses and charges. So the
 * account is absent only when both endpoints find none; an endpoint that
 * finds none while the other finds one is read again until the window ends;
 * and two present accounts must hold the same attestation record. Every
 * other read stays on `getAccount`.
 */
export function dwalletShareReader(
	programId: Uint8Array,
	getAccount: GetAccount,
	crossCheck: SolanaReadCrossCheck,
	trustedNetworkKeys: TrustedNetworkKeys,
): DWalletShareReader {
	assertSolanaReadCrossCheck(crossCheck, 'public share attestation');
	const readThrough = async <T>(
		readAccount: GetAccount,
		address: Uint8Array,
		kind: string,
		decode: (data: Uint8Array) => T | null,
	): Promise<T | undefined> => {
		const account = await readAccount(address);
		if (account === null) {
			return undefined;
		}
		if (!sameBytes(account.owner, programId)) {
			throw new Error(`the ${kind} account is not owned by the ika-dwallet program`);
		}
		const decoded = decode(account.data);
		if (decoded === null) {
			throw new Error(`the ${kind} account does not read as one`);
		}
		return decoded;
	};
	const read = <T>(address: Uint8Array, kind: string, decode: (data: Uint8Array) => T | null) =>
		readThrough(getAccount, address, kind, decode);
	return checkedSolanaShareReader({
		trustedNetworkKeys,
		dwalletAddress: (curve, publicKey, imported) =>
			dwalletPda(programId, curve, publicKey, imported).address,
		readDWalletAttestation: (curve, publicKey, imported) =>
			read(
				dwalletAttestationPda(programId, curve, publicKey, imported).address,
				'dWallet attestation',
				readDWalletAttestationUnverified,
			),
		readDWalletAccount: (curve, publicKey, imported) =>
			read(dwalletPda(programId, curve, publicKey, imported).address, 'dWallet', readDWallet),
		readEncryptedShare: async (curve, publicKey, holder, imported) => {
			const account = await read(
				encryptedUserSecretKeySharePda(programId, curve, publicKey, holder, imported).address,
				'encrypted share',
				readEncryptedUserSecretKeyShareUnverified,
			);
			const attestation = await read(
				encryptedShareAttestationPda(programId, curve, publicKey, holder, imported).address,
				'encrypted share attestation',
				readEncryptedShareAttestationUnverified,
			);
			if (account === undefined || attestation === undefined) {
				return undefined;
			}
			// The holder's registered key, which the share's attestation must
			// name by hash. The program no longer compares them at the commit.
			const entry = await read(
				encryptionKeyPda(programId, holder, curve).address,
				'encryption key',
				readEncryptionKeyUnverified,
			);
			if (
				entry === undefined ||
				!sameBytes(entry.signerPublicKey, holder) ||
				entry.curve !== curve
			) {
				throw new AttestationRecordError(
					'record',
					"the holder has no registered encryption key for the dWallet's curve",
					'encryption_key_hash',
				);
			}
			return { account, attestation, registeredEncryptionKey: entry.encryptionKey };
		},
		readPublicShareAttestation: (curve, publicKey, imported) =>
			crossCheckedAccountRead({
				getAccount,
				crossCheck,
				what: 'public share attestation',
				read: (readAccount) =>
					readThrough(
						readAccount,
						publicUserShareAttestationPda(programId, curve, publicKey, imported).address,
						'public share attestation',
						readPublicShareAttestationUnverified,
					),
				equal: sameAttestationRecord,
			}),
		readDWalletAt: (address) => read(address, 'dWallet', readDWallet),
	});
}
