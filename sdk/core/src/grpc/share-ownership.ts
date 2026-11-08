// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

/**
 * The ownership check: the SDK signs for a dWallet only when the user's own
 * key holds the dWallet's share.
 *
 * A request names the address that will control the new dWallet
 * (`intended_chain_sender`), and anyone may name any address. So someone can
 * create a dWallet for your address whose share only their key holds. The
 * network accepts such a dWallet, and its cap reaches you. You can approve
 * messages, but you cannot make the user's half of a signature, because you
 * cannot decrypt the share. The requester holds the share but cannot sign
 * either, because a signature needs your approval. The network does not ask
 * the controller to agree to a dWallet made for it. Instead the SDK treats a
 * dWallet as usable only when its share record on the chain names the user's
 * own signer key as its holder.
 *
 * A holder may act before its acceptance reaches the chain. While a dWallet
 * waits for its holder, the network runs a make-public or a re-encryption only
 * when the holder the attestation names signs it. So the holder runs
 * `signDWalletShareAcceptance`, which compares the attestation with its
 * creating request and sends nothing, and gives the signature to
 * `assertDWalletUsable` (`acceptanceSignature`). The check verifies it as it
 * verifies a stored one, and the result says `waiting`. Such a result builds a
 * make-public or a re-encryption that the holder must sign, and no sign.
 *
 * `assertDWalletUsable` runs that check against the chain and returns a
 * result that proves it ran. Every SDK builder that signs a message with a
 * dWallet takes either a reader, and runs the check itself, or a result of an
 * earlier check for the same dWallet and the same user key, and then reads
 * nothing. Given neither, a builder refuses. It never skips the check.
 *
 * A dWallet created with a public share names no holder. Its share is on the
 * chain for anyone to read, so the controller can sign, and anyone else still
 * needs the controller's approval. Such a dWallet is usable when its public
 * share record, read from the chain by the reader, verifies, including the
 * exact length of a public share. The length check matters here: an
 * encrypted share attestation can also decode as a public share attestation
 * with a share of the wrong length, and without the check a requester could
 * pass off a dWallet whose share they hold as a public-share one. A
 * public-share dWallet is not zero-trust: the network can sign with the
 * controller's approval alone. The check's result says which case it is
 * (`share`), and the SDK never presents a public-share dWallet as
 * zero-trust.
 *
 * A dWallet migrated from the classic contracts also names no holder, and the
 * migration creates no share record in the new contracts. Its attestation
 * names the classic dWallet as its session identifier, and the user's share
 * is still in the classic contracts. Such a dWallet is usable when the
 * reader's migration check (`CheckedDWalletRecord.migratedShare`, which the
 * Sui reader runs against the classic contracts) finds, on the classic
 * dWallet, a share encrypted to the user's own encryption key that the user's
 * key accepted. The result then says `migrated`. A migrated dWallet always has
 * an encrypted share: the classic coordinator refuses to migrate a dWallet
 * whose share is public (`ECannotMigratePublicUserShare`). Without classic reads, or with no classic dWallet at that id,
 * a dWallet with no holder and no public share record is refused. The
 * decisions for a dWallet with no holder are in one function,
 * `usabilityWithoutHolder`.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

import { fromNumberToCurve } from '../client/hash-signature-validation.js';
import { realCryptography } from '../client/user-cryptography.js';
import type { UserCryptography } from '../client/user-cryptography.js';
import {
	AttestationRecordError,
	attestationSigningMessage,
	recordOfAttestation,
	verifyDWalletAttestationRecord,
	verifyEncryptedShareAttestationRecord,
	verifyPublicShareAttestationRecord,
} from './attestation-record.js';
import type {
	AttestationRecord,
	AttestationRecordCheck,
	DWalletAttestation,
	EncryptedShareAttestation,
	VerifiedDWalletAttestation,
} from './attestation-record.js';
import {
	SignedRequestDataBcs,
	VersionedDWalletDataAttestationBcs,
	VersionedEncryptedUserKeyShareAttestationBcs,
} from './bcs.js';
import { copyTrustedNetworkKeys } from './deployed-networks.js';
import type { TrustedNetworkKeys } from './deployed-networks.js';
import {
	assertRequestFieldsWithinLimits,
	assertSignedRequestDataWithinLimit,
} from './request-size-limits.js';
import { signShareAcceptance } from './share-acceptance-signing.js';
import { shareAttestationDigest } from './share-acceptance.js';
import type { ShareAcceptanceSignature } from './share-acceptance.js';
import { signSerializedRequest } from './sign-request-bytes.js';
import type { TransportKeypair } from './sign-request-bytes.js';
import { requireMessageMetadataOfScheme } from './signature-verification.js';
import { issued, WAITING_RESULT_BUILDS_NO_SIGN } from './usable-state.js';
import type { IssuedState } from './usable-state.js';

/**
 * The user's keys, as far as the check needs them: the Ed25519 signer key
 * that a share record names as its holder. `UserShareEncryptionKeys` has it.
 */
export interface UserSignerKeys {
	getSigningPublicKeyBytes(): Uint8Array;
}

/** What a reader is asked for: the dWallet an attestation names. */
export interface DWalletLookup {
	curve: number;
	publicKey: Uint8Array;
	/** The import request's session identifier, for an imported dWallet. */
	importedSessionIdentifier?: Uint8Array;
}

/** An encrypted share's attestation, from a share record the reader checked. */
export type CheckedEncryptedShareRecord = AttestationRecord & {
	/**
	 * Whether the record holds no acceptance, and the signature the caller gave
	 * verified in its place. Left out, the record's own acceptance verified.
	 */
	acceptanceGiven?: boolean;
};

/**
 * A dWallet's record, read from its chain and checked by its chain package.
 *
 * Every record a reader returns must already be checked against its chain:
 * the record's address against the one derived from what was asked for,
 * every value the record stores beside its attestation, and, for an
 * encrypted share, the holder's acceptance signature: the stored one, or, when
 * the record holds none, the one the caller gave. The chain packages'
 * readers do this (`dwalletShareReader` in `@ika.xyz/sdk-sui`, with
 * `verifySuiDWalletRecord`, `verifySuiEncryptedShareRecord` and
 * `verifySuiPublicShareRecord`; `dwalletShareReader` in `@ika.xyz/pre-alpha-solana`,
 * with `verifySolanaEncryptedShareRecord`). A reader built by hand must run
 * the same checks: the core cannot, because they are chain code.
 *
 * What the core checks itself, on every reader's result, its own packages'
 * included: each attestation record's network signature under the reader's
 * trusted network key, and that the attestation names the dWallet, the
 * holder or the share that was asked for. So a reader cannot pass off an
 * attestation the trusted key did not sign, or one of another dWallet.
 */
export interface CheckedDWalletRecord {
	/** The dWallet record's address: the Sui object id's 32 bytes, or the Solana account's. */
	address: Uint8Array;
	/**
	 * The key that holds the dWallet's network share, as the checked record
	 * names it: one of the reader's trusted keys. A request on the dWallet
	 * names it as its attestation's `network_pubkey`.
	 */
	networkPublicKey: Uint8Array;
	/** The dWallet's attestation as the record stores it. */
	attestation: AttestationRecord;
	/**
	 * The attestation of the encrypted share held by `holderSignerPublicKey`,
	 * from a share record the reader checked; `undefined` when none exists.
	 *
	 * `givenAcceptanceSignature` is an acceptance signature the caller holds.
	 * The reader checks it as it checks a stored one, and only when the record
	 * holds none. It sets `acceptanceGiven` on what it returns when it did. A
	 * reader that leaves `givenAcceptanceSignature` unread refuses a record
	 * with no acceptance, and the check then refuses as it does for any
	 * failed record.
	 */
	readEncryptedShare(
		holderSignerPublicKey: Uint8Array,
		givenAcceptanceSignature?: Uint8Array,
	): Promise<CheckedEncryptedShareRecord | undefined>;
	/** The attestation of the dWallet's public share, checked; `undefined` when none exists. */
	readPublicShare(): Promise<AttestationRecord | undefined>;
	/**
	 * For a dWallet that names no holder and may have been migrated from older
	 * contracts: whether the user's key holds its share there. `encrypted`
	 * when it does, `undefined` when the dWallet was not migrated. It throws
	 * `DWalletShareNotYours` when the dWallet was migrated and the share there
	 * is not the user's. A reader that cannot read older contracts leaves it
	 * out, and the check then refuses every migrated dWallet. Only Sui has
	 * older contracts: the Sui reader runs this against the classic ones.
	 */
	migratedShare?(
		userKey: Uint8Array,
		classicShareId: string | undefined,
	): Promise<'encrypted' | undefined>;
}

/**
 * Where the check reads a dWallet's records from: a chain package's
 * `dwalletShareReader`, or a reader built by hand that checks its records the
 * same way (see `CheckedDWalletRecord`).
 */
export interface DWalletShareReader {
	chain: 'sui' | 'solana';
	/**
	 * The network keys the caller trusts (`trustedNetworkKeys`), never one a
	 * record states about itself: on mainnet and testnet the keys this SDK
	 * lists, elsewhere the caller's own. A record's signer, and the key that
	 * holds the dWallet's network share, must each be one of them. The
	 * network's signing key can change from one epoch to the next, so a
	 * dWallet made under an earlier key has records a newer key signed: on a
	 * custom network, trust both keys to read it.
	 */
	trustedNetworkKeys: TrustedNetworkKeys;
	/** The dWallet's record, checked; `undefined` when no record exists. */
	readDWallet(lookup: DWalletLookup): Promise<CheckedDWalletRecord | undefined>;
	/**
	 * The dWallet record at `address`, checked as `readDWallet` checks the
	 * record of the dWallet stored there; `undefined` when no dWallet record
	 * is there. `readDWalletVerified` uses it for a lookup by address, and
	 * requires the address it then checks to be `address`. The chain
	 * packages' readers have it. A reader built by hand without it cannot
	 * look a dWallet up by address.
	 */
	readDWalletAt?(address: Uint8Array): Promise<CheckedDWalletRecord | undefined>;
	/**
	 * The cryptography of the client the reader serves. A dWallet's output is
	 * read under it. Absent means the 2PC-MPC protocol, which refuses a mock
	 * dWallet's output.
	 */
	cryptography?: UserCryptography;
}

/**
 * `reader`, read under `cryptography`: a copy whose functions call
 * `reader`'s own.
 */
export function readerWithCryptography(
	reader: DWalletShareReader,
	cryptography: UserCryptography,
): DWalletShareReader {
	const readDWalletAt = reader.readDWalletAt?.bind(reader);
	return {
		chain: reader.chain,
		trustedNetworkKeys: reader.trustedNetworkKeys,
		readDWallet: reader.readDWallet.bind(reader),
		...(readDWalletAt === undefined ? {} : { readDWalletAt }),
		cryptography,
	};
}

/** The dWallet a check ran for. */
export interface CheckedDWallet {
	chain: 'sui' | 'solana';
	/** The dWallet record's address: the Sui object id's 32 bytes, or the Solana account's. */
	address: Uint8Array;
	curve: number;
	publicKey: Uint8Array;
	/** The import request's session identifier, for an imported dWallet. */
	importedSessionIdentifier?: Uint8Array;
}

/**
 * What `assertDWalletUsable` returns: proof that the check ran and passed.
 * Only that function makes one. A builder refuses an object of this shape
 * that it did not make.
 */
export interface DWalletUsable {
	readonly dwallet: CheckedDWallet;
	/**
	 * The user's signer key the check ran for. For an encrypted share it is the
	 * holder the share record names. A public share has no holder.
	 */
	readonly holder: Uint8Array;
	/**
	 * `encrypted`: the user's key holds the encrypted share, and the dWallet is
	 * zero-trust: a signature needs the user's half. `public`: the share is
	 * public, and the network can sign with the controller's approval alone, so
	 * the dWallet is trust-minimized, not zero-trust.
	 */
	readonly share: 'encrypted' | 'public';
	/**
	 * Whether the dWallet was migrated from the classic contracts, so that the
	 * check found the user's share there: a share encrypted to the user's key
	 * and accepted by it. `share` is then always `encrypted`.
	 */
	readonly migrated: boolean;
	/**
	 * `true` means no acceptance is on the chain for this share, and the
	 * caller's signature stood in for one (`AssertDWalletUsableOptions`). It does
	 * not mean the dWallet's state was read: the check does not read the state.
	 * A dWallet that another share's accept made Active also gives `true` here,
	 * until this holder accepts its own share. The result then builds a
	 * make-public or a re-encryption, which the holder must sign itself, and no
	 * sign, because the chain and the network refuse a sign until the dWallet is
	 * Active. `holder` is the attested holder.
	 */
	readonly waiting: boolean;
	/**
	 * The dWallet's public output, from the attestation the check verified
	 * against the chain record. This result is the one source of a dWallet's
	 * output in the gRPC SDK: take the output from here, never from an
	 * attestation that was not checked. Each read returns a fresh copy.
	 */
	readonly publicOutput: Uint8Array;
	/**
	 * The dWallet's attestation as the check verified it: the bytes the chain
	 * record holds, the record's network signature, the reader's trusted
	 * network key as the key that holds the dWallet's network share, and the
	 * record's signer, under which that signature verified. A later request
	 * on the dWallet carries this attestation. Each read returns fresh copies.
	 */
	readonly attestation: {
		attestation_data: Uint8Array;
		network_signature: Uint8Array;
		network_pubkey: Uint8Array;
		signer_noa_public_key: Uint8Array;
	};
	readonly verifiedAt: Date;
}

const copyOf = (bytes: Uint8Array | undefined) =>
	bytes === undefined ? undefined : Uint8Array.from(bytes);

/** Why a dWallet's share is not the user's. */
export type DWalletShareNotYoursReason = 'missing' | 'another_holder';

/**
 * The dWallet's share is not held by the user's key. Someone else created
 * the dWallet for the user's address, and the SDK will not sign for it.
 */
export class DWalletShareNotYours extends Error {
	readonly reason: DWalletShareNotYoursReason;
	readonly dwalletPublicKey: Uint8Array;
	readonly userSignerPublicKey: Uint8Array;

	constructor(
		reason: DWalletShareNotYoursReason,
		dwalletPublicKey: Uint8Array,
		userSignerPublicKey: Uint8Array,
		detail: string,
	) {
		super(
			`The share of the dWallet with public key ${toHex(dwalletPublicKey)} is not held by your ` +
				`key ${toHex(userSignerPublicKey)}. ${detail} Someone else created this dWallet for your ` +
				'address, and the SDK will not sign for it. If you want this dWallet, ask its share ' +
				'holder to re-encrypt the share to your key, and accept that share.',
		);
		this.name = 'DWalletShareNotYours';
		this.reason = reason;
		this.dwalletPublicKey = Uint8Array.from(dwalletPublicKey);
		this.userSignerPublicKey = Uint8Array.from(userSignerPublicKey);
	}
}

/**
 * A builder that signs for a dWallet was given neither a reader nor an
 * earlier check's result, or was given a result that does not fit.
 */
export class DWalletUsabilityNotChecked extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DWalletUsabilityNotChecked';
	}
}

/** Options of `assertDWalletUsable`. */
export interface AssertDWalletUsableOptions {
	/**
	 * For a dWallet migrated from Sui's classic contracts: the id of the
	 * user's own classic share, for example from the classic acceptance. The
	 * Sui reader's migration check then reads only that share instead of
	 * scanning the classic dWallet's share table.
	 */
	classicShareId?: string;
	/**
	 * The holder's acceptance signature, for a dWallet that waits for it:
	 * `signature` of what `signDWalletShareAcceptance` returned. It is used only
	 * when the share record on the chain holds no acceptance, and only for the
	 * holder the dWallet's attestation names. A signature that does not verify
	 * is refused. The result then says `waiting`.
	 */
	acceptanceSignature?: Uint8Array;
}

/**
 * The ownership check ran, or would run, on another chain than the one the
 * request is for. The same public key can be a dWallet on Sui and another
 * on Solana, each with its own holder, so a check on one chain says nothing
 * about the other.
 */
export class DWalletCheckedOnAnotherChain extends Error {
	readonly checkedChain: 'sui' | 'solana';
	readonly requestChain: 'sui' | 'solana';

	constructor(checkedChain: 'sui' | 'solana', requestChain: 'sui' | 'solana') {
		super(
			`the ownership check is for the dWallet on ${checkedChain}, and this request is for ` +
				`${requestChain}; check the dWallet on ${requestChain}`,
		);
		this.name = 'DWalletCheckedOnAnotherChain';
		this.checkedChain = checkedChain;
		this.requestChain = requestChain;
	}
}

function toHex(bytes: ArrayLike<number>): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function equalBytes(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
	return (
		left.length === right.length && Array.from(left).every((byte, index) => byte === right[index])
	);
}

/** `DWalletCurve` in variant order. */
const CURVES = ['Secp256k1', 'Secp256r1', 'Curve25519', 'Ristretto'];

/**
 * Refuse with an error that names `field`, unless `holds`. The error's check
 * is `binding` unless `check` names another.
 */
function refuseUnless(
	field: string,
	holds: boolean,
	what: string,
	check: AttestationRecordCheck = 'binding',
): void {
	if (!holds) {
		throw new AttestationRecordError(check, `the ${field} is not ${what}`, field);
	}
}

/**
 * Require the public key a dWallet attestation states to be the key inside
 * the public output it states. The network signs both fields, but nothing in
 * the signature ties one to the other. Every address of a dWallet is derived
 * from the attested key, and every signature is made with the key in the
 * output, so an attestation whose two fields differ names a dWallet whose
 * addresses nobody can sign for. The failure is check `binding`, field
 * `public_key_of_output`.
 */
async function requireAttestedKeyOfOutput(
	attestation: DWalletAttestation,
	cryptography: UserCryptography = realCryptography,
): Promise<void> {
	const curve = fromNumberToCurve(CURVES.indexOf(attestation.curve.$kind));
	const output = Uint8Array.from(attestation.public_output);
	const keyOfOutput = await cryptography.publicKeyFromDWalletOutput(curve, output);
	const attested = equalBytes(attestation.public_key, keyOfOutput);
	refuseUnless('public_key_of_output', attested, 'the public key inside the attested output');
}

/** What a dWallet attestation names: the dWallet it asks the chain for. */
interface AskedDWallet {
	curve: number;
	publicKey: Uint8Array;
	importedSessionIdentifier?: Uint8Array;
}

function askedOf(attestation: DWalletAttestation): AskedDWallet {
	return {
		curve: CURVES.indexOf(attestation.curve.$kind),
		publicKey: Uint8Array.from(attestation.public_key),
		importedSessionIdentifier: attestation.is_imported_key
			? Uint8Array.from(attestation.session_identifier)
			: undefined,
	};
}

/** Decode the attestation bytes the caller holds, as a dWallet attestation. */
function decodeDWalletAttestation(attestationData: ArrayLike<number>): DWalletAttestation {
	let decoded;
	try {
		decoded = VersionedDWalletDataAttestationBcs.parse(Uint8Array.from(attestationData));
	} catch (error) {
		throw new AttestationRecordError(
			'decode',
			'the attestation is not a dWallet attestation: ' +
				`${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (decoded.$kind !== 'V1') {
		throw new AttestationRecordError('decode', `the dWallet attestation is ${decoded.$kind}`);
	}
	return decoded.V1;
}

/** The dWallet's record on the chain, verified, and the share reads bound to it. */
interface ChainDWallet {
	verified: VerifiedDWalletAttestation;
	address: Uint8Array;
	/** The key that holds the dWallet's network share, one of the trusted keys. */
	networkPublicKey: Uint8Array;
	/**
	 * Read and verify the user's encrypted share; `undefined` when it does not
	 * exist. `givenAcceptanceSignature` stands in for an acceptance the record
	 * does not hold, and `acceptanceGiven` then says so.
	 */
	readOwnShare(
		userKey: Uint8Array,
		givenAcceptanceSignature?: Uint8Array,
	): Promise<{ holder: Uint8Array; acceptanceGiven: boolean } | undefined>;
	/** Read and verify the public share; `false` when it does not exist. */
	readPublicShare(): Promise<boolean>;
	/** The reader's migration check, when it has one (`CheckedDWalletRecord.migratedShare`). */
	migratedShare?(
		userKey: Uint8Array,
		classicShareId: string | undefined,
	): Promise<'encrypted' | undefined>;
}

/**
 * A copy of `reader` taken at one moment: its chain, its trusted network key
 * and its read function. A check takes it before its first wait and uses only
 * the copy, so a reader object that changes while a read is pending changes
 * neither what the check reads nor what it records.
 */
function snapshotReader(reader: DWalletShareReader): DWalletShareReader {
	return Object.freeze({
		chain: reader.chain,
		trustedNetworkKeys: copyTrustedNetworkKeys(reader.trustedNetworkKeys),
		readDWallet: reader.readDWallet.bind(reader),
		cryptography: reader.cryptography ?? realCryptography,
	});
}

/**
 * The built-in getter behind every typed array's `Symbol.toStringTag`
 * (`%TypedArray%.prototype[@@toStringTag]`), taken once when this module
 * loads. It reads the array's internal type name, so an override of the tag
 * on a subclass or an object does not change what it returns, and it returns
 * `undefined` for anything that is not a typed array. It works on a typed
 * array from any JavaScript context.
 */
const typedArrayTag = Object.getOwnPropertyDescriptor(
	Object.getPrototypeOf(Uint8Array.prototype),
	Symbol.toStringTag,
)?.get;

/**
 * Whether `value` is a byte array. A `Uint8Array` of this context, a
 * subclass or a proxy of one included, is recognised as it is. A
 * `Uint8Array` made in another context (`node:vm`, an iframe) is not an
 * `instanceof` this context's, so it is recognised by its internal type
 * name. Another typed array is refused, whatever tag it claims.
 */
function isByteArray(value: unknown): value is Uint8Array {
	if (value instanceof Uint8Array) {
		return true;
	}
	try {
		return typedArrayTag !== undefined && typedArrayTag.call(value) === 'Uint8Array';
	} catch {
		return false;
	}
}

/**
 * A deep copy of a value a reader returned: every byte array, array and
 * plain object in it is new. A reader that keeps what it returned and
 * changes it later changes nothing the check verified or kept. A byte array
 * from any JavaScript context is copied into a `Uint8Array` of this one.
 * Functions are kept as they are. The chain packages copy what a caller's
 * own reads return with it too.
 */
export function copyFromReader<T>(value: T): T {
	if (isByteArray(value)) {
		return Uint8Array.from(value) as T;
	}
	if (Array.isArray(value)) {
		return value.map((item) => copyFromReader(item)) as T;
	}
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([name, item]) => [name, copyFromReader(item)]),
		) as T;
	}
	return value;
}

/**
 * Read the dWallet's record from the chain, as the reader checked it, and
 * verify its attestation again as asked for.
 *
 * `asked` and every key here are the check's private values. A byte array
 * goes into a reader callback only as a fresh copy (`fresh`), and every
 * value a reader returns is copied before it is used (`copyFromReader`).
 *
 * The reader has checked each record against its chain. The network
 * signature under the trusted key, and the binding to what was asked for,
 * are checked here again for every record, whichever reader returned it.
 */
async function readChainDWallet(
	reader: DWalletShareReader,
	asked: AskedDWallet,
): Promise<ChainDWallet | undefined> {
	const { curve, publicKey, importedSessionIdentifier } = asked;
	const fresh = (bytes: Uint8Array) => Uint8Array.from(bytes);
	const freshSession = () =>
		importedSessionIdentifier === undefined ? undefined : fresh(importedSessionIdentifier);
	const trusted = reader.trustedNetworkKeys;
	const keys = trusted.publicKeys.map(fresh);
	const record = await reader.readDWallet({
		curve,
		publicKey: fresh(publicKey),
		importedSessionIdentifier: freshSession(),
	});
	if (record === undefined) {
		return undefined;
	}
	// The record's reads are taken once, and its values copied, before the
	// next wait.
	const { readEncryptedShare, readPublicShare, migratedShare } = record;
	const address = copyFromReader(record.address);
	const networkPublicKey = copyFromReader(record.networkPublicKey);
	const verified = verifyDWalletAttestationRecord(
		copyFromReader(record.attestation),
		trusted,
		asked,
	);
	if (!keys.some((key) => equalBytes(key, networkPublicKey))) {
		throw new AttestationRecordError(
			'record',
			"the dWallet record's network key is not one of the trusted network keys",
			'noa_public_key',
		);
	}
	return {
		verified,
		address,
		networkPublicKey,
		readOwnShare: async (userKey, givenAcceptanceSignature) => {
			const share = copyFromReader(
				await readEncryptedShare.call(
					record,
					fresh(userKey),
					givenAcceptanceSignature === undefined ? undefined : fresh(givenAcceptanceSignature),
				),
			);
			if (share === undefined) {
				return undefined;
			}
			const attestation = verifyEncryptedShareAttestationRecord(share, trusted, verified, {
				holderSignerPublicKey: userKey,
			});
			return {
				holder: Uint8Array.from(attestation.holder.signer_public_key),
				acceptanceGiven: share.acceptanceGiven === true,
			};
		},
		readPublicShare: async () => {
			const share = copyFromReader(await readPublicShare.call(record));
			if (share === undefined) {
				return false;
			}
			verifyPublicShareAttestationRecord(share, trusted, verified);
			return true;
		},
		migratedShare:
			migratedShare === undefined
				? undefined
				: (userKey, classicShareId) => migratedShare.call(record, fresh(userKey), classicShareId),
	};
}

/** The epoch a migrated dWallet's attestation carries: u64::MAX, as BCS decodes it. */
const MIGRATED_DWALLET_ATTESTATION_EPOCH = '18446744073709551615';

/**
 * Whether the user's key holds a share attached to the migrated dWallet
 * (`AttachEncryptedShare`): the share record at the address derived from the
 * dWallet and the user's key verifies, with the user's key as its holder.
 * `false` for a dWallet whose attestation is not a migration's (the epoch
 * `MIGRATED_DWALLET_ATTESTATION_EPOCH` and no holder), and when no record is
 * there. A record that names another holder is refused with
 * `DWalletShareNotYours` (`another_holder`).
 */
async function attachedShareOfMigratedDWallet(
	chainDWallet: ChainDWallet,
	asked: AskedDWallet,
	userKey: Uint8Array,
): Promise<boolean> {
	const attestation = chainDWallet.verified.attestation;
	const isMigration =
		String(attestation.epoch) === MIGRATED_DWALLET_ATTESTATION_EPOCH &&
		(attestation.holder === null || attestation.holder === undefined);
	if (!isMigration) {
		return false;
	}
	let own: { holder: Uint8Array } | undefined;
	try {
		own = await chainDWallet.readOwnShare(userKey);
	} catch (error) {
		if (error instanceof AttestationRecordError && error.field === 'holder') {
			throw new DWalletShareNotYours(
				'another_holder',
				asked.publicKey,
				userKey,
				'The share attached to the migrated dWallet names another holder.',
			);
		}
		throw error;
	}
	if (own === undefined) {
		return false;
	}
	if (!equalBytes(own.holder, userKey)) {
		throw new DWalletShareNotYours(
			'another_holder',
			asked.publicKey,
			userKey,
			`The share attached to the migrated dWallet names the holder ${toHex(own.holder)}.`,
		);
	}
	return true;
}

/**
 * The decision for a dWallet whose attestation names no holder and that has
 * no public share record. `assertDWalletUsable` reads the public share record
 * first, for every dWallet: a dWallet is usable as public when that record,
 * read from the chain, verifies, including the public share's exact length.
 *
 * A dWallet migrated from the classic contracts names no holder and has no
 * share record in the new contracts. Its migration names its new owner, so
 * someone could migrate their own classic dWallet to another person's
 * address while only they hold the share. So it is usable only when the
 * classic contracts show that the user holds the share (the reader's
 * `migratedShare`, which the Sui reader runs). Anything else is refused.
 *
 * A migrated dWallet's owner can attach a share under a new key
 * (`AttachEncryptedShare`). So for a migrated dWallet the share record under
 * the user's key is read first, as for a dWallet that names a holder
 * (`attachedShareOfMigratedDWallet`). A record there that verifies makes the
 * dWallet `encrypted` and not `migrated`, and the classic contracts are not
 * read. With no record there, the classic read runs as before.
 */
async function usabilityWithoutHolder(
	chainDWallet: ChainDWallet,
	asked: AskedDWallet,
	userKey: Uint8Array,
	classicShareId: string | undefined,
): Promise<{ share: 'encrypted'; migrated: boolean }> {
	if (await attachedShareOfMigratedDWallet(chainDWallet, asked, userKey)) {
		return { share: 'encrypted', migrated: false };
	}
	const migrationCheck = chainDWallet.migratedShare;
	const migratedShare =
		migrationCheck === undefined ? undefined : await migrationCheck(userKey, classicShareId);
	if (migratedShare !== undefined) {
		return { share: migratedShare, migrated: true };
	}
	throw new DWalletShareNotYours(
		'missing',
		asked.publicKey,
		userKey,
		'The dWallet names no holder and has no public share record on the chain, so no record ' +
			'shows that your key holds its share. ' +
			(migrationCheck === undefined
				? 'A dWallet migrated from the classic contracts is checked against its share there, ' +
					"and this reader has no classic reads: pass the Sui client's classicShareReaderUnverified to " +
					'dwalletShareReader.'
				: 'It was not migrated from the classic contracts either: no classic dWallet exists ' +
					'at its session identifier.'),
	);
}

/**
 * Read the dWallet's record from the chain, verified as `asked`, and require
 * it to hold the attestation bytes the caller gave. Throws an `Error` when
 * the dWallet has no record on the chain, and an `AttestationRecordError`
 * (check `record`, field `attestation_data`) when the record holds another
 * attestation.
 */
async function readDWalletHolding(
	source: DWalletShareReader,
	asked: AskedDWallet,
	attestationData: Uint8Array,
): Promise<ChainDWallet> {
	const chainDWallet = await readChainDWallet(source, asked);
	if (chainDWallet === undefined) {
		throw new Error(
			`no dWallet with public key ${toHex(asked.publicKey)} is on the chain; it may not be ` +
				'committed yet',
		);
	}
	if (!equalBytes(chainDWallet.verified.attestationData, attestationData)) {
		throw new AttestationRecordError(
			'record',
			"the dWallet's record holds another attestation than the one given",
			'attestation_data',
		);
	}
	return chainDWallet;
}

/**
 * Check that the user's key holds the share of the dWallet `dwalletAttestation`
 * names, and return the proof that the check ran.
 *
 * The check reads the dWallet's record from the chain and verifies it with
 * the reader's trusted network key, as asked for by the attestation (curve,
 * public key and, for an import, the session identifier). The record must
 * hold the same attestation bytes. Then it reads the dWallet's public share
 * record: one that verifies makes the dWallet `public`, whatever its
 * attestation names, because a make-public leaves the encrypted share record
 * in place. Without one, it reads the share record at the
 * address derived from the dWallet and the user's signer key
 * (`userKeys.getSigningPublicKeyBytes()`), verifies it, and requires its
 * holder to be the user's key.
 *
 * Throws `DWalletShareNotYours` when no share record exists for the user's
 * key, or when the share names another holder. Throws an
 * `AttestationRecordError` when a record fails its check, and an `Error` when
 * the dWallet has no record on the chain. For a dWallet migrated from Sui's
 * classic contracts, the Sui reader throws `ClassicShareTableTooLarge` when
 * the classic share table is too large to scan; pass
 * `options.classicShareId` then.
 *
 * For every dWallet, the attested public key must be the key inside the
 * attested public output (check `binding`, field `public_key_of_output`).
 * The result carries that output and the verified attestation
 * (`publicOutput`, `attestation`).
 *
 * A share record with no acceptance is refused, unless the attested holder
 * gives its own signature (`options.acceptanceSignature`). The result then
 * says `waiting`. The same option from another key is refused with
 * `DWalletShareNotYours`, because the network runs nothing for that key while
 * the dWallet waits.
 */
export async function assertDWalletUsable(
	reader: DWalletShareReader,
	userKeys: UserSignerKeys,
	dwalletAttestation: { attestation_data: ArrayLike<number> },
	options: AssertDWalletUsableOptions = {},
): Promise<DWalletUsable> {
	const classicShareId = options.classicShareId;
	const acceptanceSignature = copyOf(options.acceptanceSignature);
	// Every input is copied before the first wait, the reader included, so a
	// caller that changes one meanwhile changes nothing this check reads,
	// compares or records.
	const source = snapshotReader(reader);
	const userKey = Uint8Array.from(userKeys.getSigningPublicKeyBytes());
	const attestationData = Uint8Array.from(dwalletAttestation.attestation_data);
	const attestation = decodeDWalletAttestation(attestationData);
	const asked = askedOf(attestation);
	const chainDWallet = await readDWalletHolding(source, asked, attestationData);
	await requireAttestedKeyOfOutput(chainDWallet.verified.attestation, source.cryptography);
	const named = chainDWallet.verified.attestation.holder;
	// A dWallet whose share was made public after it was created still names
	// its holder, and the chain keeps its encrypted share record. So the
	// public share record is read for every dWallet, and a record that
	// verifies makes it public whatever the attestation names.
	const hasPublicShare = await chainDWallet.readPublicShare();
	const { share, migrated, waiting } = hasPublicShare
		? { share: 'public' as const, migrated: false, waiting: false }
		: named === null || named === undefined
			? {
					...(await usabilityWithoutHolder(chainDWallet, asked, userKey, classicShareId)),
					waiting: false,
				}
			: {
					share: 'encrypted' as const,
					migrated: false,
					waiting: await usabilityOfEncryptedShare(
						chainDWallet,
						asked,
						userKey,
						named.signer_public_key,
						acceptanceSignature,
					),
				};
	const verifiedAt = Date.now();
	const state: IssuedState = {
		chain: source.chain,
		address: Uint8Array.from(chainDWallet.address),
		curve: asked.curve,
		publicKey: Uint8Array.from(asked.publicKey),
		importedSessionIdentifier: copyOf(asked.importedSessionIdentifier),
		holder: Uint8Array.from(userKey),
		share,
		migrated,
		waiting,
		publicOutput: Uint8Array.from(chainDWallet.verified.attestation.public_output),
		attestation: {
			attestation_data: Uint8Array.from(chainDWallet.verified.attestationData),
			network_signature: Uint8Array.from(chainDWallet.verified.networkSignature),
			network_pubkey: Uint8Array.from(chainDWallet.networkPublicKey),
			signer_noa_public_key: Uint8Array.from(chainDWallet.verified.signerNoaPublicKey),
		},
		verifiedAt,
	};
	// Every byte array the caller reads is a fresh copy of the private state,
	// so the result cannot be changed in place: changing a copy changes
	// neither the result nor what the SDK checks a later reuse against.
	const result: DWalletUsable = Object.freeze({
		dwallet: Object.freeze({
			chain: state.chain,
			get address() {
				return Uint8Array.from(state.address);
			},
			curve: state.curve,
			get publicKey() {
				return Uint8Array.from(state.publicKey);
			},
			get importedSessionIdentifier() {
				return copyOf(state.importedSessionIdentifier);
			},
		}),
		get holder() {
			return Uint8Array.from(state.holder);
		},
		share: state.share,
		migrated: state.migrated,
		waiting: state.waiting,
		get publicOutput() {
			return Uint8Array.from(state.publicOutput);
		},
		get attestation() {
			return {
				attestation_data: Uint8Array.from(state.attestation.attestation_data),
				network_signature: Uint8Array.from(state.attestation.network_signature),
				network_pubkey: Uint8Array.from(state.attestation.network_pubkey),
				signer_noa_public_key: Uint8Array.from(state.attestation.signer_noa_public_key),
			};
		},
		get verifiedAt() {
			return new Date(verifiedAt);
		},
	});
	issued.set(result, state);
	return result;
}

/** Whether two import session identifiers are both absent, or the same bytes. */
function sameSession(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
	return left === undefined || right === undefined ? left === right : equalBytes(left, right);
}

/**
 * The dWallet `readDWalletVerified` reads: the address of its record on the
 * chain (the Sui object id's 32 bytes, or the Solana account's), or the values
 * that address is derived from.
 */
export type DWalletToRead = { address: Uint8Array } | DWalletLookup;

/**
 * Read the dWallet `dwallet` names from the chain `reader` reads, check it
 * for the user's key, and return what the check verified: the public key
 * (`dwallet.publicKey`), the public output (`publicOutput`), the attestation
 * (`attestation`), and whether the share is the user's encrypted share or
 * public (`share`). A user who kept nothing about the dWallet, for example
 * on a new device restored from the seed, takes a dWallet's values only from
 * here. `findDWalletUnverified` in `@ika.xyz/sdk-sui` only says where to
 * look.
 *
 * The steps, in order:
 * 1. Read the dWallet's record: at `dwallet.address` (the reader's
 *    `readDWalletAt`), or at the address derived from `dwallet`'s curve,
 *    public key and import session. None is an error.
 * 2. Run `assertDWalletUsable` on the attestation that record stores. It
 *    verifies the record's network signature under the reader's trusted
 *    keys, the user's own share record and acceptance signature (or the
 *    public share record), and that the attested public key is the key
 *    inside the attested output.
 * 3. Require the checked dWallet to be the one asked for: the same curve,
 *    public key and import session identifier, or, for a lookup by address,
 *    the same record address. A record of another dWallet is refused, even
 *    one the user accepted.
 *
 * Every value returned comes from `assertDWalletUsable`'s result, so a lying
 * RPC can serve only a dWallet the user accepted, or one whose share is
 * public. A dWallet whose share was made public comes back with `share:
 * 'public'`: it is not zero-trust. Throws as `assertDWalletUsable` throws,
 * and an `Error` when the chain has no record, when the reader cannot read
 * by address, or when the checked dWallet is not the one asked for.
 */
export async function readDWalletVerified(
	reader: DWalletShareReader,
	userKeys: UserSignerKeys,
	dwallet: DWalletToRead,
	options: AssertDWalletUsableOptions = {},
): Promise<DWalletUsable> {
	// What was asked for is copied before the first wait.
	const askedAddress = 'address' in dwallet ? Uint8Array.from(dwallet.address) : undefined;
	const askedKey: DWalletLookup | undefined =
		'address' in dwallet
			? undefined
			: {
					curve: dwallet.curve,
					publicKey: Uint8Array.from(dwallet.publicKey),
					importedSessionIdentifier: copyOf(dwallet.importedSessionIdentifier),
				};
	const readDWallet = reader.readDWallet.bind(reader);
	const readDWalletAt = reader.readDWalletAt?.bind(reader);
	let record: CheckedDWalletRecord | undefined;
	if (askedAddress !== undefined) {
		if (readDWalletAt === undefined) {
			throw new Error(
				'this reader cannot read a dWallet by its address (it has no readDWalletAt); read it ' +
					"by its curve and public key, or use the chain package's dwalletShareReader",
			);
		}
		record = await readDWalletAt(Uint8Array.from(askedAddress));
	} else if (askedKey !== undefined) {
		record = await readDWallet({
			curve: askedKey.curve,
			publicKey: Uint8Array.from(askedKey.publicKey),
			importedSessionIdentifier: copyOf(askedKey.importedSessionIdentifier),
		});
	}
	if (record === undefined) {
		throw new Error(
			askedAddress !== undefined
				? `no dWallet record is at ${toHex(askedAddress)}; it may not be committed yet`
				: `no dWallet with public key ${toHex(askedKey?.publicKey ?? [])} is on the chain; ` +
						'it may not be committed yet',
		);
	}
	const attestationData = copyFromReader(record.attestation.attestationData);
	const usable = await assertDWalletUsable(
		reader,
		userKeys,
		{ attestation_data: attestationData },
		options,
	);
	const checked = usable.dwallet;
	const askedFor =
		askedAddress !== undefined
			? equalBytes(checked.address, askedAddress)
			: askedKey !== undefined &&
				checked.curve === askedKey.curve &&
				equalBytes(checked.publicKey, askedKey.publicKey) &&
				sameSession(checked.importedSessionIdentifier, askedKey.importedSessionIdentifier);
	if (!askedFor) {
		throw new Error(
			`the chain served the record of another dWallet, with public key ` +
				`${toHex(checked.publicKey)}, than the one asked for`,
		);
	}
	return usable;
}

/**
 * The decision for a dWallet whose attestation names a holder. Returns whether
 * the record holds no acceptance and `acceptanceSignature` verified in its
 * place, which only the named holder may use.
 */
async function usabilityOfEncryptedShare(
	chainDWallet: ChainDWallet,
	asked: AskedDWallet,
	userKey: Uint8Array,
	namedHolder: ArrayLike<number>,
	acceptanceSignature: Uint8Array | undefined,
): Promise<boolean> {
	const another = !equalBytes(namedHolder, userKey);
	let own: { holder: Uint8Array; acceptanceGiven: boolean } | undefined;
	try {
		own = await chainDWallet.readOwnShare(userKey, acceptanceSignature);
	} catch (error) {
		if (error instanceof AttestationRecordError && error.field === 'holder') {
			throw new DWalletShareNotYours(
				'another_holder',
				asked.publicKey,
				userKey,
				`The dWallet's attestation names the holder ${toHex(namedHolder)}.`,
			);
		}
		throw error;
	}
	if (own === undefined) {
		throw new DWalletShareNotYours(
			another ? 'another_holder' : 'missing',
			asked.publicKey,
			userKey,
			another
				? `No share record exists for your key: the dWallet's attestation names the holder ${toHex(namedHolder)}.`
				: 'No share record exists for your key on the chain.',
		);
	}
	if (!equalBytes(own.holder, userKey)) {
		throw new DWalletShareNotYours(
			'another_holder',
			asked.publicKey,
			userKey,
			`The share record names the holder ${toHex(own.holder)}.`,
		);
	}
	if (own.acceptanceGiven && another) {
		throw new DWalletShareNotYours(
			'another_holder',
			asked.publicKey,
			userKey,
			`Your share record holds no acceptance, and only the holder ${toHex(namedHolder)} the ` +
				"dWallet's attestation names may act before one is on the chain. Accept your share first.",
		);
	}
	return own.acceptanceGiven;
}

/** What `signReEncryptedShareAcceptance` takes. */
export interface AcceptReEncryptedShareArguments {
	/** Where the dWallet's records are read from, with the network key the caller trusts. */
	reader: DWalletShareReader;
	/** The new holder's 32-byte Ed25519 secret key: the key that signed `encryptionKey`. */
	holderSecretKey: Uint8Array;
	/** The new holder's class-groups decryption key, for `encryptionKey`. */
	decryptionKey: Uint8Array;
	/** The new holder's class-groups encryption key, which the share was re-encrypted to. */
	encryptionKey: Uint8Array;
	/**
	 * The signer key of the sender: the previous holder, whose share was
	 * re-encrypted to you. It must come from the sender, through a channel you
	 * trust, outside the network. Never take it from a validator or from
	 * anything that travels with the ciphertext. The function checks that the
	 * sender's accepted share record is on the chain under this key, and that
	 * check is only as good as the key. A key from a validator proves only
	 * that some holder with a record on this dWallet accepted it: a colluding
	 * quorum can create a dWallet under a holder of its own, accept it, and
	 * re-encrypt its share to you.
	 */
	senderSignerPublicKey: Uint8Array;
	/**
	 * The sender's acceptance signature, when its share record on the chain
	 * holds none: a dWallet that waits for its holder has no accepted share
	 * yet. The sender makes it with `signDWalletShareAcceptance`, and hands it
	 * over outside the network with its key. It is the signature the chain
	 * would store, and it is verified as a stored one is. Only the holder the
	 * dWallet's attestation names may be such a sender. With an accepted record
	 * on the chain it is not read.
	 */
	senderAcceptanceSignature?: Uint8Array;
	/** The attestation of the dWallet the re-encryption named. */
	dwalletAttestation: { attestation_data: ArrayLike<number> };
	/** The signed share attestation the re-encryption was answered with. */
	shareAttestation: {
		attestation_data: ArrayLike<number>;
		network_signature: ArrayLike<number>;
		network_pubkey: ArrayLike<number>;
		signer_noa_public_key: ArrayLike<number>;
	};
	/**
	 * The re-encrypted share and its proof. The new holder reads it from the
	 * share's record on the chain, or gets it from the sender. Its hash is
	 * compared with the hash the network signed, so neither the record's
	 * reader nor the sender need be trusted for it.
	 */
	encryptedShareAndProof: Uint8Array;
	/** The protocol public parameters of the dWallet's curve. */
	protocolPublicParameters: Uint8Array;
}

/** Decode the bytes as exactly one V1 encrypted share attestation. */
function decodeEncryptedShareAttestation(attestationData: Uint8Array): EncryptedShareAttestation {
	let decoded;
	try {
		decoded = VersionedEncryptedUserKeyShareAttestationBcs.parse(attestationData);
	} catch (error) {
		throw new AttestationRecordError(
			'decode',
			'the share attestation is not an encrypted share attestation: ' +
				`${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (decoded.$kind !== 'V1') {
		throw new AttestationRecordError('decode', `the share attestation is ${decoded.$kind}`);
	}
	const encoded = VersionedEncryptedUserKeyShareAttestationBcs.serialize(decoded).toBytes();
	if (!equalBytes(encoded, attestationData)) {
		throw new AttestationRecordError(
			'decode',
			'the share attestation bytes are not exactly an encrypted share attestation: bytes ' +
				'remain after it',
		);
	}
	return decoded.V1;
}

/** Whether `signature` is the network key's signature over an encrypted share attestation. */
function shareAttestationSignatureVerifies(
	attestationData: Uint8Array,
	signature: Uint8Array,
	networkPublicKey: Uint8Array,
): boolean {
	try {
		return ed25519.verify(
			signature,
			attestationSigningMessage('encrypted_share', attestationData),
			networkPublicKey,
		);
	} catch {
		return false;
	}
}

/**
 * The share the encrypted share decrypts to under `decryptionKey`, when it
 * is a share of `publicOutput`; `undefined` otherwise. The WASM verifies the
 * ciphertext's proof against the output before it decrypts, and refuses a
 * share whose public key share is the identity, so a share that decrypts
 * belongs to this output.
 */
async function decryptedShare(
	cryptography: UserCryptography,
	curve: number,
	decryptionKey: Uint8Array,
	publicOutput: Uint8Array,
	encryptedShareAndProof: Uint8Array,
	protocolPublicParameters: Uint8Array,
): Promise<Uint8Array | undefined> {
	try {
		return await cryptography.decryptUserShare(
			curve,
			decryptionKey,
			publicOutput,
			encryptedShareAndProof,
			protocolPublicParameters,
		);
	} catch {
		return undefined;
	}
}

/**
 * The holder's acceptance of a share re-encrypted to it, signed only after
 * the share is checked. The holder's key signs the digest of the share's own
 * attestation (`shareAttestationDigest`), which is the digest the share's
 * chain record stores. Pass the result to the chain client's accept builder:
 * `acceptEncryptedUserShareTx` in `@ika.xyz/sdk-sui`, or
 * `acceptEncryptedUserShareInstructions` in `@ika.xyz/pre-alpha-solana`. Any key
 * may send that transaction and pay for it.
 *
 * A new holder has no acceptance of its own yet, so it relies on the
 * previous holder's: the previous holder accepted this dWallet's output, and
 * its acceptance is on the chain or comes from the sender
 * (`senderAcceptanceSignature`). The previous holder's signer key
 * (`senderSignerPublicKey`) must come from the sender, outside the network.
 * The new holder's accept also makes a waiting dWallet Active.
 * The signed share attestation and the ciphertext come from the
 * re-encryption's answer, from the share's chain record, or from the sender.
 * None of them is verified when it is read: the checks below verify them.
 *
 * The checks, in order. The first that fails throws, and nothing is signed:
 * 1. The dWallet's record is on the chain, verifies under the reader's
 *    trusted network key, and holds the given attestation bytes (check
 *    `record`, field `attestation_data`).
 * 2. The attested public key is the key inside the attested public output
 *    (field `public_key_of_output`).
 * 3. The previous holder's share record, at the address derived from the
 *    dWallet and `senderSignerPublicKey`, is on the chain and verifies, its
 *    acceptance signature under that key included (an
 *    `AttestationRecordError` of the record check). No record there throws an
 *    `Error`. A record with no acceptance needs `senderAcceptanceSignature`,
 *    which is verified in its place.
 * 4. When that signature stood in for the record's, the sender is the holder
 *    the dWallet's attestation names (field `sender_is_attested_holder`). A
 *    dWallet that waits has no accepted share, so this holds for every waiting
 *    dWallet. While a dWallet waits, the network runs a re-encryption only from
 *    that holder.
 * 5. The share attestation decodes as exactly one V1 encrypted share
 *    attestation (check `decode`). Its signer is the reader's trusted key
 *    (check `signer`, field `share_signer_noa_public_key`), the network's
 *    signature verifies as an encrypted share attestation under that signer
 *    (check `signature`, field `share_network_signature`), and the key it
 *    names as holding the dWallet's network share is the reader's trusted key
 *    too (field `share_network_pubkey`).
 * 6. The share attestation names the holder's own Ed25519 key (field
 *    `share_holder`), the digest of the dWallet's attestation (field
 *    `share_dwallet_attestation_digest`), the dWallet's public key (field
 *    `share_dwallet_public_key`), the chain sender the dWallet's attestation
 *    names (field `share_intended_chain_sender`), the keccak256 of the
 *    holder's own encryption key (field `share_encryption_key_hash`), and the
 *    keccak256 of `encryptedShareAndProof` (field
 *    `share_encrypted_share_hash`). The record check the holder's own
 *    ownership check runs later compares the same sender, so a holder never
 *    signs a share that check would refuse.
 * 7. The share decrypts under the holder's decryption key to a share of the
 *    dWallet's public output (field `encrypted_share`).
 *
 * The checks of steps 2, 4, 6 and 7 have check `binding`.
 *
 * Every input is copied before the first wait, the reader included.
 */
export async function signReEncryptedShareAcceptance(
	args: AcceptReEncryptedShareArguments,
): Promise<ShareAcceptanceSignature> {
	const chainReader = snapshotReader(args.reader);
	const holderSecretKey = Uint8Array.from(args.holderSecretKey);
	const decryptionKey = Uint8Array.from(args.decryptionKey);
	const encryptionKey = Uint8Array.from(args.encryptionKey);
	const sender = Uint8Array.from(args.senderSignerPublicKey);
	const senderAcceptanceSignature = copyOf(args.senderAcceptanceSignature);
	const attestationData = Uint8Array.from(args.dwalletAttestation.attestation_data);
	const shareAttestationData = Uint8Array.from(args.shareAttestation.attestation_data);
	const shareNetworkSignature = Uint8Array.from(args.shareAttestation.network_signature);
	const shareNetworkPublicKey = Uint8Array.from(args.shareAttestation.network_pubkey);
	const shareSignerNoaPublicKey = Uint8Array.from(args.shareAttestation.signer_noa_public_key);
	const encryptedShareAndProof = Uint8Array.from(args.encryptedShareAndProof);
	const protocolPublicParameters = Uint8Array.from(args.protocolPublicParameters);
	const trustedKeys = chainReader.trustedNetworkKeys.publicKeys.map((key) => Uint8Array.from(key));

	const attestation = decodeDWalletAttestation(attestationData);
	const asked = askedOf(attestation);
	const chainDWallet = await readDWalletHolding(chainReader, asked, attestationData);
	await requireAttestedKeyOfOutput(chainDWallet.verified.attestation, chainReader.cryptography);

	// The previous holder's acceptance: `readOwnShare` verifies the record
	// under the sender's key, the acceptance signature included. The signature
	// the sender gave is read only when the record holds none.
	const source = await chainDWallet.readOwnShare(sender, senderAcceptanceSignature);
	if (source === undefined) {
		throw new Error(
			`no share record of the sender ${toHex(sender)} is on the chain for the ` +
				`dWallet with public key ${toHex(asked.publicKey)}, so nothing shows that the sender ` +
				'held and accepted this dWallet',
		);
	}
	const attestedHolder = chainDWallet.verified.attestation.holder;
	const senderIsAttested =
		attestedHolder !== null &&
		attestedHolder !== undefined &&
		attestedHolder.signature_scheme.$kind === 'Ed25519' &&
		equalBytes(attestedHolder.signer_public_key, sender);
	refuseUnless(
		'sender_is_attested_holder',
		!source.acceptanceGiven || senderIsAttested,
		"the holder the dWallet's attestation names, as a sender with no acceptance on the chain must be",
	);

	const share = decodeEncryptedShareAttestation(shareAttestationData);
	const signerTrusted = trustedKeys.some((key) => equalBytes(shareSignerNoaPublicKey, key));
	refuseUnless(
		'share_signer_noa_public_key',
		signerTrusted,
		"one of the reader's trusted network keys",
		'signer',
	);
	const shareSigned = shareAttestationSignatureVerifies(
		shareAttestationData,
		shareNetworkSignature,
		shareSignerNoaPublicKey,
	);
	refuseUnless('share_network_signature', shareSigned, 'a signature of its signer', 'signature');
	const sameDWalletKey = equalBytes(shareNetworkPublicKey, chainDWallet.networkPublicKey);
	refuseUnless('share_network_pubkey', sameDWalletKey, "the dWallet record's network key");

	const holderIsOwn =
		share.holder.signature_scheme.$kind === 'Ed25519' &&
		equalBytes(share.holder.signer_public_key, ed25519.getPublicKey(holderSecretKey));
	refuseUnless('share_holder', holderIsOwn, "the Ed25519 key of the holder's secret key");
	const dwalletDigest = keccak_256(attestationData);
	const sameDWallet = equalBytes(share.dwallet_attestation_digest, dwalletDigest);
	refuseUnless('share_dwallet_attestation_digest', sameDWallet, "the dWallet attestation's digest");
	const sameKey = equalBytes(share.dwallet_public_key, asked.publicKey);
	refuseUnless('share_dwallet_public_key', sameKey, "the dWallet's public key");
	const sameSender = equalBytes(share.intended_chain_sender, attestation.intended_chain_sender);
	refuseUnless('share_intended_chain_sender', sameSender, "the dWallet attestation's sender");
	const ownKey = equalBytes(share.encryption_key_hash, keccak_256(encryptionKey));
	refuseUnless('share_encryption_key_hash', ownKey, "the hash of the holder's encryption key");
	const sameShare = equalBytes(share.encrypted_share_hash, keccak_256(encryptedShareAndProof));
	refuseUnless('share_encrypted_share_hash', sameShare, 'the hash of the encrypted share given');

	// The decrypted share is not kept.
	const decrypted = await decryptedShare(
		chainReader.cryptography ?? realCryptography,
		asked.curve,
		decryptionKey,
		Uint8Array.from(chainDWallet.verified.attestation.public_output),
		encryptedShareAndProof,
		protocolPublicParameters,
	);
	refuseUnless(
		'encrypted_share',
		decrypted !== undefined,
		"a share of the dWallet's public output",
	);

	return signShareAcceptance(holderSecretKey, shareAttestationDigest(shareAttestationData));
}

/** What `decryptUserShare` takes. */
export interface DecryptUserShareArguments {
	/** Where the dWallet's record is read from, with the network key the caller trusts. */
	reader: DWalletShareReader;
	/** The holder's Ed25519 signer key: the key the share attestation must name as its holder. */
	holderSignerPublicKey: Uint8Array;
	/** The holder's class-groups decryption key, for `encryptionKey`. */
	decryptionKey: Uint8Array;
	/** The holder's class-groups encryption key, which the share was encrypted to. */
	encryptionKey: Uint8Array;
	/** The attestation of the dWallet whose share this is. */
	dwalletAttestation: { attestation_data: ArrayLike<number> };
	/**
	 * The signed attestation of the share. For the holder's own share it is
	 * the one the dWallet's creating request was answered with. For a share
	 * re-encrypted to the holder it is the one the re-encryption was answered
	 * with.
	 */
	shareAttestation: {
		attestation_data: ArrayLike<number>;
		network_signature: ArrayLike<number>;
		network_pubkey: ArrayLike<number>;
		signer_noa_public_key: ArrayLike<number>;
	};
	/** The encrypted share and its proof, whose hash the share attestation names. */
	encryptedShareAndProof: Uint8Array;
	/** The protocol public parameters of the dWallet's curve. */
	protocolPublicParameters: Uint8Array;
}

/**
 * Decrypt the holder's user secret key share of a dWallet and return it, only
 * after the share is checked.
 *
 * It takes both kinds of encrypted share. The first is the holder's own
 * share, made by the request that created the dWallet. The second is a share
 * re-encrypted to the holder later. Both have the same share attestation type
 * and the same ciphertext form. The share attestation check
 * (`verifyEncryptedShareAttestationRecord`) tells them apart by the session
 * identifier the share attestation names. The holder's own share names the
 * creating request's session, and its attestation must then agree with the
 * dWallet's attestation on the holder and on both hashes. A re-encrypted
 * share names the re-encryption's session.
 *
 * A dWallet with a public share has no encrypted share to decrypt. A dWallet
 * migrated from the classic contracts keeps its share there, so it has no
 * share attestation of these contracts unless a share was attached to it
 * (`AttachEncryptedShare`). An attached share's attestation names the attach
 * request's own session, so this function takes it as a re-encrypted share.
 *
 * The checks, in order. The first that fails throws, and nothing is
 * decrypted:
 * 1. The dWallet's record is on the chain, verifies under the reader's
 *    trusted network key, and holds the given attestation bytes (check
 *    `record`, field `attestation_data`).
 * 2. The attested public key is the key inside the attested public output
 *    (check `binding`, field `public_key_of_output`).
 * 3. The share attestation names the dWallet record's key as the key that
 *    holds the dWallet's network share (check `binding`, field
 *    `share_network_pubkey`).
 * 4. The share attestation passes `verifyEncryptedShareAttestationRecord`
 *    for the dWallet and for `holderSignerPublicKey`. Its signer is one of
 *    the reader's trusted keys (check `signer`). The network's signature
 *    verifies under that signer (check `signature`). It decodes as exactly
 *    one V1 encrypted share attestation (check `decode`). It names the
 *    dWallet, and it names the holder (check `binding`, field `holder`).
 * 5. The share attestation names the keccak256 of the holder's encryption
 *    key (field `encryption_key_hash`) and of `encryptedShareAndProof`
 *    (field `encrypted_share_hash`).
 * 6. The share decrypts under the holder's decryption key to a share of the
 *    dWallet's public output (check `binding`, field `encrypted_share`). The
 *    WASM verifies the share's proof against the output before it decrypts.
 *
 * It does not read the holder's share record, so a re-encrypted share can be
 * decrypted before its holder accepts it. It signs nothing. Every input is
 * copied before the first wait, the reader included.
 */
export async function decryptUserShare(args: DecryptUserShareArguments): Promise<Uint8Array> {
	const chainReader = snapshotReader(args.reader);
	const holderSignerPublicKey = Uint8Array.from(args.holderSignerPublicKey);
	const decryptionKey = Uint8Array.from(args.decryptionKey);
	const encryptionKey = Uint8Array.from(args.encryptionKey);
	const attestationData = Uint8Array.from(args.dwalletAttestation.attestation_data);
	const shareRecord = recordOfAttestation(args.shareAttestation);
	const shareNetworkPublicKey = Uint8Array.from(args.shareAttestation.network_pubkey);
	const encryptedShareAndProof = Uint8Array.from(args.encryptedShareAndProof);
	const protocolPublicParameters = Uint8Array.from(args.protocolPublicParameters);

	const asked = askedOf(decodeDWalletAttestation(attestationData));
	const chainDWallet = await readDWalletHolding(chainReader, asked, attestationData);
	await requireAttestedKeyOfOutput(chainDWallet.verified.attestation, chainReader.cryptography);

	const sameDWalletKey = equalBytes(shareNetworkPublicKey, chainDWallet.networkPublicKey);
	refuseUnless('share_network_pubkey', sameDWalletKey, "the dWallet record's network key");
	const share = verifyEncryptedShareAttestationRecord(
		shareRecord,
		chainReader.trustedNetworkKeys,
		chainDWallet.verified,
		{ holderSignerPublicKey },
	);
	const ownKey = equalBytes(share.encryption_key_hash, keccak_256(encryptionKey));
	refuseUnless('encryption_key_hash', ownKey, "the hash of the holder's encryption key");
	const sameShare = equalBytes(share.encrypted_share_hash, keccak_256(encryptedShareAndProof));
	refuseUnless('encrypted_share_hash', sameShare, 'the hash of the encrypted share given');

	const decrypted = await decryptedShare(
		chainReader.cryptography ?? realCryptography,
		asked.curve,
		decryptionKey,
		Uint8Array.from(chainDWallet.verified.attestation.public_output),
		encryptedShareAndProof,
		protocolPublicParameters,
	);
	if (decrypted === undefined) {
		throw new AttestationRecordError(
			'binding',
			"the encrypted_share is not a share of the dWallet's public output",
			'encrypted_share',
		);
	}
	return decrypted;
}

/**
 * How a builder that signs for a dWallet learns that the user's key holds its
 * share: `userKeys`, the user's keys, and either `reader`, so the builder
 * runs `assertDWalletUsable` itself, or `usable`, the result of an earlier
 * check for the same dWallet attestation, under the same network key, for the
 * same user key, and at most `DWALLET_USABLE_MAX_AGE_MS` old, so the builder
 * reads nothing. With `usable` given, `reader` is not used.
 */
export interface DWalletOwnership {
	userKeys: UserSignerKeys;
	reader?: DWalletShareReader;
	usable?: DWalletUsable;
}

/**
 * How long a result of `assertDWalletUsable` may be reused by a builder that
 * signs for its dWallet: 5 minutes. An older result is refused with
 * `DWalletUsabilityNotChecked`, and the caller runs the check again.
 *
 * The result can go stale while it is held. The dWallet's share may have been
 * made public, or moved to another holder by an accepted re-encryption. The
 * network then refuses a request built from the old result, and charges the
 * signer for the refusal. A check costs a few chain reads, and 5 minutes
 * covers one flow of several signs.
 */
export const DWALLET_USABLE_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Require `usable` to be a result `assertDWalletUsable` made, for the dWallet
 * `attestation` names and for `userKey`, as its check verified them: the
 * comparison reads the SDK's private copy, never the result's own fields.
 * The request's attestation must be the very bytes the check verified
 * (`attestationData`), under the network key the check trusted
 * (`networkPublicKey`), and the result must be at most
 * `DWALLET_USABLE_MAX_AGE_MS` old. Throws `DWalletUsabilityNotChecked`
 * otherwise.
 */
function requireUsableFor(
	usable: DWalletUsable,
	attestation: DWalletAttestation,
	attestationData: ArrayLike<number>,
	networkPublicKey: ArrayLike<number>,
	userKey: Uint8Array,
): void {
	const verified = issued.get(usable);
	if (verified === undefined) {
		throw new DWalletUsabilityNotChecked(
			'the usability result was not made by assertDWalletUsable; run the check, or pass a reader',
		);
	}
	const asked = askedOf(attestation);
	const same =
		verified.curve === asked.curve &&
		equalBytes(verified.publicKey, asked.publicKey) &&
		(verified.importedSessionIdentifier === undefined) ===
			(asked.importedSessionIdentifier === undefined) &&
		(asked.importedSessionIdentifier === undefined ||
			equalBytes(verified.importedSessionIdentifier ?? [], asked.importedSessionIdentifier));
	if (!same) {
		throw new DWalletUsabilityNotChecked(
			'the usability result is for another dWallet than the one this request signs for',
		);
	}
	if (!equalBytes(verified.holder, userKey)) {
		throw new DWalletUsabilityNotChecked(
			'the usability result is for another user key than the one given',
		);
	}
	if (!equalBytes(verified.attestation.attestation_data, attestationData)) {
		throw new DWalletUsabilityNotChecked(
			'the usability result checked another attestation of the dWallet than the one this ' +
				'request carries',
		);
	}
	if (!equalBytes(verified.attestation.network_pubkey, networkPublicKey)) {
		throw new DWalletUsabilityNotChecked(
			'the usability result was checked under another network key than the one this ' +
				"request's attestation names",
		);
	}
	const age = Date.now() - verified.verifiedAt;
	if (age > DWALLET_USABLE_MAX_AGE_MS) {
		throw new DWalletUsabilityNotChecked(
			`the usability result is ${age} ms old, over the ${DWALLET_USABLE_MAX_AGE_MS} ms a ` +
				'result may be reused; run assertDWalletUsable again',
		);
	}
}

/**
 * Run the ownership check a builder needs, or reuse an earlier result, and
 * return the result. Refuses with `DWalletUsabilityNotChecked` when given
 * neither a reader nor a result, and when given a result that says `waiting`,
 * because every caller of this function signs a message with the dWallet.
 * Never skips the check.
 */
export async function requireDWalletUsable(
	ownership: DWalletOwnership,
	dwalletAttestation: { attestation_data: ArrayLike<number>; network_pubkey: ArrayLike<number> },
): Promise<DWalletUsable> {
	const userKey = Uint8Array.from(ownership.userKeys.getSigningPublicKeyBytes());
	if (ownership.usable !== undefined) {
		requireUsableFor(
			ownership.usable,
			decodeDWalletAttestation(dwalletAttestation.attestation_data),
			dwalletAttestation.attestation_data,
			dwalletAttestation.network_pubkey,
			userKey,
		);
		if (issued.get(ownership.usable)?.waiting === true) {
			throw new DWalletUsabilityNotChecked(WAITING_RESULT_BUILDS_NO_SIGN);
		}
		return ownership.usable;
	}
	if (ownership.reader !== undefined) {
		return assertDWalletUsable(ownership.reader, ownership.userKeys, dwalletAttestation);
	}
	throw new DWalletUsabilityNotChecked(
		'a builder that signs for a dWallet needs a reader, to check that your key holds the ' +
			"dWallet's share, or the result of an earlier assertDWalletUsable; it was given neither",
	);
}

/**
 * Sign a `Sign` or `ImportedKeySign` request with the transport key, after
 * checking that the user's key holds the dWallet's share (`ownership`, see
 * `DWalletOwnership`). The dWallet is the one the request's
 * `dwallet_attestation` names. Returns the two byte payloads
 * `SubmitTransaction` carries.
 *
 * Throws the network's refusal when the request is over one of its size
 * limits (`GRPC_REQUEST_SIZE_LIMITS`), or when its metadata does not decode
 * for its scheme (`requireMessageMetadataOfScheme`), before it reads the
 * chain. Throws a `TypeError` for any other request kind (sign it with
 * `signGrpcRequest`), `DWalletUsabilityNotChecked` when `ownership` has
 * neither a reader nor a fitting result, and whatever `assertDWalletUsable`
 * throws, `DWalletShareNotYours` among them. Nothing is signed then.
 */
export async function signDWalletSignRequest(
	keypair: TransportKeypair,
	signedData: Parameters<typeof SignedRequestDataBcs.serialize>[0],
	ownership: DWalletOwnership,
): Promise<{ userSignature: Uint8Array; signedRequestData: Uint8Array }> {
	// The request is serialized before the first wait, the check's inputs are
	// decoded from those bytes, and exactly those bytes are signed. A caller
	// that changes `signedData` while the check reads the chain changes
	// nothing this call signs. Each byte field is held to its size limit
	// before the bytes are made, as `signRequestBytes` does, and the whole
	// request as soon as they are made. So a request over a limit is refused
	// before the chain is read.
	assertRequestFieldsWithinLimits(signedData);
	const signedRequestData = SignedRequestDataBcs.serialize(signedData).toBytes();
	assertSignedRequestDataWithinLimit(signedRequestData);
	const { request, chain_id } = SignedRequestDataBcs.parse(signedRequestData);
	const sign =
		request.$kind === 'Sign'
			? request.Sign
			: request.$kind === 'ImportedKeySign'
				? request.ImportedKeySign
				: undefined;
	if (sign === undefined) {
		throw new TypeError(
			'signDWalletSignRequest signs only a Sign or ImportedKeySign request; sign any other ' +
				'request with signGrpcRequest',
		);
	}
	requireMessageMetadataOfScheme(
		sign.signature_scheme.$kind,
		Uint8Array.from(sign.message_metadata),
	);
	// The same key can be a dWallet on Sui and another on Solana, with
	// different holders, so the check must have run on the request's chain.
	const requestChain = chain_id.$kind === 'Sui' ? 'sui' : 'solana';
	// The ownership is taken once, the reader as a snapshot, before the first
	// wait: the chain compared here is the chain the check reads and records.
	const usable = ownership.usable;
	const reader =
		usable === undefined && ownership.reader !== undefined
			? snapshotReader(ownership.reader)
			: undefined;
	const checkedChain = usable !== undefined ? issued.get(usable)?.chain : reader?.chain;
	if (checkedChain !== undefined && checkedChain !== requestChain) {
		throw new DWalletCheckedOnAnotherChain(checkedChain, requestChain);
	}
	const result = await requireDWalletUsable(
		{ userKeys: ownership.userKeys, reader, usable },
		{
			attestation_data: Uint8Array.from(sign.dwallet_attestation.attestation_data),
			network_pubkey: Uint8Array.from(sign.dwallet_attestation.network_pubkey),
		},
	);
	// The chain the check recorded must be the request's too.
	const recorded = issued.get(result);
	if (recorded === undefined) {
		throw new DWalletUsabilityNotChecked(
			'the usability result was not made by assertDWalletUsable',
		);
	}
	if (recorded.chain !== requestChain) {
		throw new DWalletCheckedOnAnotherChain(recorded.chain, requestChain);
	}
	const signed = signSerializedRequest(keypair, signedRequestData);
	return {
		userSignature: Uint8Array.from(signed.userSignature),
		signedRequestData: Uint8Array.from(signed.signedRequestData),
	};
}
