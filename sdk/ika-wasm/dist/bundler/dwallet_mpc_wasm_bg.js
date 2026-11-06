let wasm;
export function __wbg_set_wasm(val) {
    wasm = val;
}


let WASM_VECTOR_LEN = 0;

let cachedUint8ArrayMemory0 = null;

function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

const lTextEncoder = typeof TextEncoder === 'undefined' ? (0, module.require)('util').TextEncoder : TextEncoder;

let cachedTextEncoder = new lTextEncoder('utf-8');

const encodeString = (typeof cachedTextEncoder.encodeInto === 'function'
    ? function (arg, view) {
    return cachedTextEncoder.encodeInto(arg, view);
}
    : function (arg, view) {
    const buf = cachedTextEncoder.encode(arg);
    view.set(buf);
    return {
        read: arg.length,
        written: buf.length
    };
});

function passStringToWasm0(arg, malloc, realloc) {

    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }

    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = encodeString(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let cachedDataViewMemory0 = null;

function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_export_4.set(idx, obj);
    return idx;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

const lTextDecoder = typeof TextDecoder === 'undefined' ? (0, module.require)('util').TextDecoder : TextDecoder;

let cachedTextDecoder = new lTextDecoder('utf-8', { ignoreBOM: true, fatal: true });

cachedTextDecoder.decode();

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_export_4.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}
/**
 * @param {Uint8Array} protocol_pp
 * @param {Uint8Array} decentralized_first_round_public_output
 * @returns {any}
 */
export function create_dkg_centralized_output_v1(protocol_pp, decentralized_first_round_public_output) {
    const ptr0 = passArray8ToWasm0(protocol_pp, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(decentralized_first_round_public_output, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.create_dkg_centralized_output_v1(ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

function isLikeNone(x) {
    return x === undefined || x === null;
}
/**
 * The user's partial signature over `message`, from the user's own DKG output.
 *
 * `hash_context` is taken as `create_sign_centralized_party_message` takes it.
 * @param {Uint8Array} protocol_pp
 * @param {Uint8Array} centralized_party_dkg_public_output
 * @param {Uint8Array} centralized_party_dkg_secret_output
 * @param {Uint8Array} presign
 * @param {Uint8Array} message
 * @param {number} hash_scheme
 * @param {number} signature_algorithm
 * @param {number} curve
 * @param {Uint8Array | null} [hash_context]
 * @returns {any}
 */
export function create_sign_centralized_party_message_with_centralized_party_dkg_output(protocol_pp, centralized_party_dkg_public_output, centralized_party_dkg_secret_output, presign, message, hash_scheme, signature_algorithm, curve, hash_context) {
    const ptr0 = passArray8ToWasm0(protocol_pp, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(centralized_party_dkg_public_output, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(centralized_party_dkg_secret_output, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(presign, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArray8ToWasm0(message, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    var ptr5 = isLikeNone(hash_context) ? 0 : passArray8ToWasm0(hash_context, wasm.__wbindgen_malloc);
    var len5 = WASM_VECTOR_LEN;
    const ret = wasm.create_sign_centralized_party_message_with_centralized_party_dkg_output(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, hash_scheme, signature_algorithm, curve, ptr5, len5);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {number} curve
 * @param {number} signature_algorithm
 * @param {Uint8Array} signature_output
 * @returns {any}
 */
export function parse_signature_from_sign_output(curve, signature_algorithm, signature_output) {
    const ptr0 = passArray8ToWasm0(signature_output, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.parse_signature_from_sign_output(curve, signature_algorithm, ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {number} curve
 * @param {Uint8Array} protocol_pp
 * @param {Uint8Array} session_identifier
 * @returns {any}
 */
export function create_dkg_centralized_output_v2(curve, protocol_pp, session_identifier) {
    const ptr0 = passArray8ToWasm0(protocol_pp, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(session_identifier, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.create_dkg_centralized_output_v2(curve, ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {number} curve
 * @param {Uint8Array} dwallet_output
 * @returns {any}
 */
export function public_key_from_dwallet_output(curve, dwallet_output) {
    const ptr0 = passArray8ToWasm0(dwallet_output, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.public_key_from_dwallet_output(curve, ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {number} curve
 * @param {Uint8Array} centralized_dkg_output
 * @returns {any}
 */
export function public_key_from_centralized_dkg_output(curve, centralized_dkg_output) {
    const ptr0 = passArray8ToWasm0(centralized_dkg_output, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.public_key_from_centralized_dkg_output(curve, ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Encrypts the given secret share to the given encryption key.
 * Returns a tuple of the encryption key and proof of encryption.
 * @param {number} curve
 * @param {Uint8Array} secret_key_share
 * @param {Uint8Array} encryption_key
 * @param {Uint8Array} protocol_pp
 * @returns {any}
 */
export function encrypt_secret_share(curve, secret_key_share, encryption_key, protocol_pp) {
    const ptr0 = passArray8ToWasm0(secret_key_share, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(encryption_key, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(protocol_pp, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.encrypt_secret_share(curve, ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Decrypts the given encrypted user share using the given decryption key.
 * @param {number} curve
 * @param {Uint8Array} decryption_key
 * @param {Uint8Array} dwallet_dkg_output
 * @param {Uint8Array} encrypted_user_share_and_proof
 * @param {Uint8Array} protocol_pp
 * @returns {any}
 */
export function decrypt_user_share(curve, decryption_key, dwallet_dkg_output, encrypted_user_share_and_proof, protocol_pp) {
    const ptr0 = passArray8ToWasm0(decryption_key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(dwallet_dkg_output, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(encrypted_user_share_and_proof, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(protocol_pp, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.decrypt_user_share(curve, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Verifies that the given secret key share matches the given dWallet public key share.
 * DKG output->centralized_party_public_key_share.
 * @param {number} curve
 * @param {Uint8Array} secret_share
 * @param {Uint8Array} dkg_output
 * @param {Uint8Array} network_dkg_public_output
 * @returns {any}
 */
export function verify_user_share(curve, secret_share, dkg_output, network_dkg_public_output) {
    const ptr0 = passArray8ToWasm0(secret_share, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(dkg_output, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(network_dkg_public_output, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.verify_user_share(curve, ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {Uint8Array} network_dkg_public_output
 * @returns {any}
 */
export function sample_dwallet_keypair(network_dkg_public_output) {
    const ptr0 = passArray8ToWasm0(network_dkg_public_output, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.sample_dwallet_keypair(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Verifies a signature the network returned, under the public key inside the dWallet's DKG output.
 * Throws when the signature does not verify.
 *
 * `signature` is the sign session's output as the network returns it, before
 * `parse_signature_from_sign_output` reads it. `hash_context` is the BCS encoding of a
 * `HashContext`; when it is absent, the context is the one the algorithm signs with.
 * @param {number} curve
 * @param {number} signature_algorithm
 * @param {number} hash_scheme
 * @param {Uint8Array | null | undefined} hash_context
 * @param {Uint8Array} dwallet_public_output
 * @param {Uint8Array} message
 * @param {Uint8Array} signature
 */
export function verify_signature(curve, signature_algorithm, hash_scheme, hash_context, dwallet_public_output, message, signature) {
    var ptr0 = isLikeNone(hash_context) ? 0 : passArray8ToWasm0(hash_context, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(dwallet_public_output, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(message, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(signature, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.verify_signature(curve, signature_algorithm, hash_scheme, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * Verifies a secp256k1 ECDSA signature over the BLAKE2b-256 hash of the message, under the
 * public key inside the dWallet's DKG output. Throws when the signature does not verify.
 *
 * `personal` and `salt` are the BLAKE2b personalization and salt, each at most 16 bytes.
 * `signature` is the sign session's output as the network returns it.
 * @param {Uint8Array} personal
 * @param {Uint8Array} salt
 * @param {Uint8Array} dwallet_public_output
 * @param {Uint8Array} message
 * @param {Uint8Array} signature
 */
export function verify_ecdsa_blake2b256_signature(personal, salt, dwallet_public_output, message, signature) {
    const ptr0 = passArray8ToWasm0(personal, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(salt, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(dwallet_public_output, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(message, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArray8ToWasm0(signature, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ret = wasm.verify_ecdsa_blake2b256_signature(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * @param {number} curve
 * @param {Uint8Array} network_dkg_public_output
 * @param {Uint8Array} session_identifier
 * @param {Uint8Array} secret_share
 * @returns {any}
 */
export function create_imported_dwallet_centralized_step(curve, network_dkg_public_output, session_identifier, secret_share) {
    const ptr0 = passArray8ToWasm0(network_dkg_public_output, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(session_identifier, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(secret_share, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.create_imported_dwallet_centralized_step(curve, ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * The user's partial signature over `message`, for the network's sign.
 *
 * `hash_context` is the BCS encoding of a `HashContext`: the context the message's hash
 * takes, which a sign's metadata names. When it is absent, the context is the one the
 * algorithm signs with: `substrate` for Schnorrkel, none otherwise. An ECDSA sign over a
 * BLAKE2b hash takes `create_sign_centralized_party_message_ecdsa_blake2b256` instead.
 * @param {Uint8Array} protocol_pp
 * @param {Uint8Array} decentralized_party_dkg_public_output
 * @param {Uint8Array} centralized_party_dkg_secret_output
 * @param {Uint8Array} presign
 * @param {Uint8Array} message
 * @param {number} curve
 * @param {number} signature_algorithm
 * @param {number} hash_scheme
 * @param {Uint8Array | null} [hash_context]
 * @returns {any}
 */
export function create_sign_centralized_party_message(protocol_pp, decentralized_party_dkg_public_output, centralized_party_dkg_secret_output, presign, message, curve, signature_algorithm, hash_scheme, hash_context) {
    const ptr0 = passArray8ToWasm0(protocol_pp, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(decentralized_party_dkg_public_output, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(centralized_party_dkg_secret_output, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(presign, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArray8ToWasm0(message, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    var ptr5 = isLikeNone(hash_context) ? 0 : passArray8ToWasm0(hash_context, wasm.__wbindgen_malloc);
    var len5 = WASM_VECTOR_LEN;
    const ret = wasm.create_sign_centralized_party_message(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, curve, signature_algorithm, hash_scheme, ptr5, len5);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * The user's partial signature for a secp256k1 ECDSA sign over the BLAKE2b-256 hash of
 * `message` (the scheme `EcdsaBlake2b256`).
 *
 * `personal` and `salt` are the BLAKE2b personalization and salt of the sign's metadata,
 * each at most 16 bytes.
 * @param {Uint8Array} protocol_pp
 * @param {Uint8Array} decentralized_party_dkg_public_output
 * @param {Uint8Array} centralized_party_dkg_secret_output
 * @param {Uint8Array} presign
 * @param {Uint8Array} message
 * @param {Uint8Array} personal
 * @param {Uint8Array} salt
 * @returns {any}
 */
export function create_sign_centralized_party_message_ecdsa_blake2b256(protocol_pp, decentralized_party_dkg_public_output, centralized_party_dkg_secret_output, presign, message, personal, salt) {
    const ptr0 = passArray8ToWasm0(protocol_pp, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(decentralized_party_dkg_public_output, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(centralized_party_dkg_secret_output, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(presign, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArray8ToWasm0(message, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ptr5 = passArray8ToWasm0(personal, wasm.__wbindgen_malloc);
    const len5 = WASM_VECTOR_LEN;
    const ptr6 = passArray8ToWasm0(salt, wasm.__wbindgen_malloc);
    const len6 = WASM_VECTOR_LEN;
    const ret = wasm.create_sign_centralized_party_message_ecdsa_blake2b256(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {Uint8Array} network_key_bytes
 * @returns {any}
 */
export function network_key_version(network_key_bytes) {
    const ptr0 = passArray8ToWasm0(network_key_bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.network_key_version(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {Uint8Array} dwallet_output_bytes
 * @returns {any}
 */
export function dwallet_version(dwallet_output_bytes) {
    const ptr0 = passArray8ToWasm0(dwallet_output_bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.dwallet_version(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Re-encodes a dWallet's DKG public output as V2, the way a migration from the classic
 * contracts does before the network attests it.
 *
 * A V2 output is returned as it came. A V1 output of a curve other than secp256k1 is
 * refused. A V1 output is converted and wrapped as V2 with `public_key` as its
 * `public_key_bytes`.
 * @param {number} curve
 * @param {Uint8Array} dwallet_output
 * @param {Uint8Array} public_key
 * @returns {any}
 */
export function dwallet_output_at_latest_version(curve, dwallet_output, public_key) {
    const ptr0 = passArray8ToWasm0(dwallet_output, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(public_key, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.dwallet_output_at_latest_version(curve, ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

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
 * @param {number} curve
 * @param {Uint8Array} seed
 * @returns {any}
 */
export function generate_secp_cg_keypair_from_seed_v2(curve, seed) {
    const ptr0 = passArray8ToWasm0(seed, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.generate_secp_cg_keypair_from_seed_v2(curve, ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Recover class-groups keys derived with the historical 32-bit WASM sampler.
 * @param {number} curve
 * @param {Uint8Array} seed
 * @returns {any}
 */
export function generate_secp_cg_keypair_from_seed(curve, seed) {
    const ptr0 = passArray8ToWasm0(seed, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.generate_secp_cg_keypair_from_seed(curve, ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {number} curve
 * @param {Uint8Array} network_dkg_public_output
 * @returns {any}
 */
export function network_dkg_public_output_to_protocol_pp(curve, network_dkg_public_output) {
    const ptr0 = passArray8ToWasm0(network_dkg_public_output, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.network_dkg_public_output_to_protocol_pp(curve, ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {number} curve
 * @param {Uint8Array} reconfig_public_output
 * @param {Uint8Array} network_dkg_public_output
 * @returns {any}
 */
export function reconfiguration_public_output_to_protocol_pp(curve, reconfig_public_output, network_dkg_public_output) {
    const ptr0 = passArray8ToWasm0(reconfig_public_output, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(network_dkg_public_output, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.reconfiguration_public_output_to_protocol_pp(curve, ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {number} curve
 * @param {Uint8Array} centralized_dkg_output
 * @param {Uint8Array} decentralized_dkg_output
 * @returns {any}
 */
export function centralized_and_decentralized_parties_dkg_output_match(curve, centralized_dkg_output, decentralized_dkg_output) {
    const ptr0 = passArray8ToWasm0(centralized_dkg_output, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(decentralized_dkg_output, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.centralized_and_decentralized_parties_dkg_output_match(curve, ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

export function __wbg_String_8f0eb39a4a4c2f66(arg0, arg1) {
    const ret = String(arg1);
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
};

export function __wbg_getRandomValues_1c61fac11405ffdc() { return handleError(function (arg0, arg1) {
    globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
}, arguments) };

export function __wbg_new_78feb108b6472713() {
    const ret = new Array();
    return ret;
};

export function __wbg_set_37837023f3d740e8(arg0, arg1, arg2) {
    arg0[arg1 >>> 0] = arg2;
};

export function __wbindgen_error_new(arg0, arg1) {
    const ret = new Error(getStringFromWasm0(arg0, arg1));
    return ret;
};

export function __wbindgen_init_externref_table() {
    const table = wasm.__wbindgen_export_4;
    const offset = table.grow(4);
    table.set(0, undefined);
    table.set(offset + 0, undefined);
    table.set(offset + 1, null);
    table.set(offset + 2, true);
    table.set(offset + 3, false);
    ;
};

export function __wbindgen_number_new(arg0) {
    const ret = arg0;
    return ret;
};

export function __wbindgen_throw(arg0, arg1) {
    throw new Error(getStringFromWasm0(arg0, arg1));
};

