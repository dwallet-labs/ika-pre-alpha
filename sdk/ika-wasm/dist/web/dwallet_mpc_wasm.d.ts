/* tslint:disable */
/* eslint-disable */
export function create_dkg_centralized_output_v1(protocol_pp: Uint8Array, decentralized_first_round_public_output: Uint8Array): any;
/**
 * The user's partial signature over `message`, from the user's own DKG output.
 *
 * `hash_context` is taken as `create_sign_centralized_party_message` takes it.
 */
export function create_sign_centralized_party_message_with_centralized_party_dkg_output(protocol_pp: Uint8Array, centralized_party_dkg_public_output: Uint8Array, centralized_party_dkg_secret_output: Uint8Array, presign: Uint8Array, message: Uint8Array, hash_scheme: number, signature_algorithm: number, curve: number, hash_context?: Uint8Array | null): any;
export function parse_signature_from_sign_output(curve: number, signature_algorithm: number, signature_output: Uint8Array): any;
export function create_dkg_centralized_output_v2(curve: number, protocol_pp: Uint8Array, session_identifier: Uint8Array): any;
export function public_key_from_dwallet_output(curve: number, dwallet_output: Uint8Array): any;
export function public_key_from_centralized_dkg_output(curve: number, centralized_dkg_output: Uint8Array): any;
/**
 * Encrypts the given secret share to the given encryption key.
 * Returns a tuple of the encryption key and proof of encryption.
 */
export function encrypt_secret_share(curve: number, secret_key_share: Uint8Array, encryption_key: Uint8Array, protocol_pp: Uint8Array): any;
/**
 * Decrypts the given encrypted user share using the given decryption key.
 */
export function decrypt_user_share(curve: number, decryption_key: Uint8Array, dwallet_dkg_output: Uint8Array, encrypted_user_share_and_proof: Uint8Array, protocol_pp: Uint8Array): any;
/**
 * Verifies that the given secret key share matches the given dWallet public key share.
 * DKG output->centralized_party_public_key_share.
 */
export function verify_user_share(curve: number, secret_share: Uint8Array, dkg_output: Uint8Array, network_dkg_public_output: Uint8Array): any;
export function sample_dwallet_keypair(network_dkg_public_output: Uint8Array): any;
/**
 * Verifies a signature the network returned, under the public key inside the dWallet's DKG output.
 * Throws when the signature does not verify.
 *
 * `signature` is the sign session's output as the network returns it, before
 * `parse_signature_from_sign_output` reads it. `hash_context` is the BCS encoding of a
 * `HashContext`; when it is absent, the context is the one the algorithm signs with.
 */
export function verify_signature(curve: number, signature_algorithm: number, hash_scheme: number, hash_context: Uint8Array | null | undefined, dwallet_public_output: Uint8Array, message: Uint8Array, signature: Uint8Array): void;
/**
 * Verifies a secp256k1 ECDSA signature over the BLAKE2b-256 hash of the message, under the
 * public key inside the dWallet's DKG output. Throws when the signature does not verify.
 *
 * `personal` and `salt` are the BLAKE2b personalization and salt, each at most 16 bytes.
 * `signature` is the sign session's output as the network returns it.
 */
export function verify_ecdsa_blake2b256_signature(personal: Uint8Array, salt: Uint8Array, dwallet_public_output: Uint8Array, message: Uint8Array, signature: Uint8Array): void;
export function create_imported_dwallet_centralized_step(curve: number, network_dkg_public_output: Uint8Array, session_identifier: Uint8Array, secret_share: Uint8Array): any;
/**
 * The user's partial signature over `message`, for the network's sign.
 *
 * `hash_context` is the BCS encoding of a `HashContext`: the context the message's hash
 * takes, which a sign's metadata names. When it is absent, the context is the one the
 * algorithm signs with: `substrate` for Schnorrkel, none otherwise. An ECDSA sign over a
 * BLAKE2b hash takes `create_sign_centralized_party_message_ecdsa_blake2b256` instead.
 */
export function create_sign_centralized_party_message(protocol_pp: Uint8Array, decentralized_party_dkg_public_output: Uint8Array, centralized_party_dkg_secret_output: Uint8Array, presign: Uint8Array, message: Uint8Array, curve: number, signature_algorithm: number, hash_scheme: number, hash_context?: Uint8Array | null): any;
/**
 * The user's partial signature for a secp256k1 ECDSA sign over the BLAKE2b-256 hash of
 * `message` (the scheme `EcdsaBlake2b256`).
 *
 * `personal` and `salt` are the BLAKE2b personalization and salt of the sign's metadata,
 * each at most 16 bytes.
 */
export function create_sign_centralized_party_message_ecdsa_blake2b256(protocol_pp: Uint8Array, decentralized_party_dkg_public_output: Uint8Array, centralized_party_dkg_secret_output: Uint8Array, presign: Uint8Array, message: Uint8Array, personal: Uint8Array, salt: Uint8Array): any;
export function network_key_version(network_key_bytes: Uint8Array): any;
export function dwallet_version(dwallet_output_bytes: Uint8Array): any;
/**
 * Re-encodes a dWallet's DKG public output as V2, the way a migration from the classic
 * contracts does before the network attests it.
 *
 * A V2 output is returned as it came. A V1 output of a curve other than secp256k1 is
 * refused. A V1 output is converted and wrapped as V2 with `public_key` as its
 * `public_key_bytes`.
 */
export function dwallet_output_at_latest_version(curve: number, dwallet_output: Uint8Array, public_key: Uint8Array): any;
/**
 * Derives a class groups keypair from a given seed.
 *
 * The class groups public encryption key being used to encrypt a keypair will be
 * different from the encryption key used to encrypt a Ristretto keypair.
 * The plaintext space/fundamental group will correspond to the order
 * of the respective elliptic curve.
 * The secret decryption key may be the same in terms of correctness,
 * but to simplify security analysis and implementation current version maintain distinct key-pairs.
 * Create portable keys matching native Rust; callers opt in explicitly.
 */
export function generate_secp_cg_keypair_from_seed_v2(curve: number, seed: Uint8Array): any;
/**
 * Recover class-groups keys derived with the historical 32-bit WASM sampler.
 */
export function generate_secp_cg_keypair_from_seed(curve: number, seed: Uint8Array): any;
export function network_dkg_public_output_to_protocol_pp(curve: number, network_dkg_public_output: Uint8Array): any;
export function reconfiguration_public_output_to_protocol_pp(curve: number, reconfig_public_output: Uint8Array, network_dkg_public_output: Uint8Array): any;
export function centralized_and_decentralized_parties_dkg_output_match(curve: number, centralized_dkg_output: Uint8Array, decentralized_dkg_output: Uint8Array): any;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly centralized_and_decentralized_parties_dkg_output_match: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly create_dkg_centralized_output_v1: (a: number, b: number, c: number, d: number) => [number, number, number];
  readonly create_dkg_centralized_output_v2: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly create_imported_dwallet_centralized_step: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
  readonly create_sign_centralized_party_message: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number) => [number, number, number];
  readonly create_sign_centralized_party_message_ecdsa_blake2b256: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number) => [number, number, number];
  readonly create_sign_centralized_party_message_with_centralized_party_dkg_output: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number) => [number, number, number];
  readonly decrypt_user_share: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number];
  readonly dwallet_output_at_latest_version: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly dwallet_version: (a: number, b: number) => [number, number, number];
  readonly encrypt_secret_share: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
  readonly generate_secp_cg_keypair_from_seed: (a: number, b: number, c: number) => [number, number, number];
  readonly generate_secp_cg_keypair_from_seed_v2: (a: number, b: number, c: number) => [number, number, number];
  readonly network_dkg_public_output_to_protocol_pp: (a: number, b: number, c: number) => [number, number, number];
  readonly network_key_version: (a: number, b: number) => [number, number, number];
  readonly parse_signature_from_sign_output: (a: number, b: number, c: number, d: number) => [number, number, number];
  readonly public_key_from_centralized_dkg_output: (a: number, b: number, c: number) => [number, number, number];
  readonly public_key_from_dwallet_output: (a: number, b: number, c: number) => [number, number, number];
  readonly reconfiguration_public_output_to_protocol_pp: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly sample_dwallet_keypair: (a: number, b: number) => [number, number, number];
  readonly verify_ecdsa_blake2b256_signature: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number];
  readonly verify_signature: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number];
  readonly verify_user_share: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_export_4: WebAssembly.Table;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
