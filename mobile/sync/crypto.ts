/**
 * AES-256-GCM body framing of the Horizon log sync protocol (Horizon repo
 * docs/log-sync-protocol.md): every non-empty HTTP body is
 *
 *   IV (12 bytes) || ciphertext || GCM auth tag (16 bytes)
 *
 * with a fresh random IV per message. Web Crypto's `encrypt` returns
 * `ciphertext || tag`, so the wire body is just the 12-byte IV prepended to it,
 * which is byte-for-byte the reference implementation's layout (Horizon's
 * `electron/services/sync/protocol.ts`, Luna's `SyncCrypto`). Uses the global
 * `crypto.subtle`, present in both WebViews and in Node, so there is no
 * dependency and the unit tests exercise the identical code path.
 */

export const SYNC_IV_LENGTH = 12;
export const SYNC_TAG_LENGTH = 16;
export const SYNC_KEY_LENGTH = 32;

export type SyncCryptoErrorCode = 'badKey' | 'bodyTooShort' | 'authenticationFailed';

export class SyncCryptoError extends Error {
    readonly code: SyncCryptoErrorCode;
    constructor(code: SyncCryptoErrorCode) {
        super(code);
        this.code = code;
        this.name = 'SyncCryptoError';
    }
}

// TS 5.7+ makes Uint8Array generic over its backing buffer, but Web Crypto's BufferSource wants an
// ArrayBuffer-backed view; ours always are, so this assertion just satisfies the (over-strict) type.
function src(bytes: Uint8Array): BufferSource {
    return bytes as BufferSource;
}

async function importKey(key: Uint8Array): Promise<CryptoKey> {
    if(key.length !== SYNC_KEY_LENGTH) throw new SyncCryptoError('badKey');
    return crypto.subtle.importKey('raw', src(key), {name: 'AES-GCM'}, false, ['encrypt', 'decrypt']);
}

/** Encrypt a plaintext body with a fresh random IV. */
export async function encryptBody(key: Uint8Array, plain: Uint8Array): Promise<Uint8Array> {
    return sealWithIv(key, plain, crypto.getRandomValues(new Uint8Array(SYNC_IV_LENGTH)));
}

/**
 * Encrypt with a caller-chosen IV. Only for tests (known-answer vectors); real
 * traffic must use `encryptBody`, since GCM is broken by IV reuse under one key.
 */
export async function sealWithIv(key: Uint8Array, plain: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
    const cryptoKey = await importKey(key);
    const sealed = new Uint8Array(
        await crypto.subtle.encrypt({name: 'AES-GCM', iv: src(iv), tagLength: SYNC_TAG_LENGTH * 8}, cryptoKey, src(plain))
    );
    const out = new Uint8Array(iv.length + sealed.length);
    out.set(iv, 0);
    out.set(sealed, iv.length);
    return out;
}

/**
 * Decrypt and authenticate an `IV || ciphertext || tag` body. Throws
 * `SyncCryptoError` when the body is too short, the key is the wrong length, or
 * GCM authentication fails (wrong key or tampered body).
 */
export async function decryptBody(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
    if(data.length < SYNC_IV_LENGTH + SYNC_TAG_LENGTH) throw new SyncCryptoError('bodyTooShort');
    const cryptoKey = await importKey(key);
    const iv = data.subarray(0, SYNC_IV_LENGTH);
    const body = data.subarray(SYNC_IV_LENGTH);
    try {
        return new Uint8Array(
            await crypto.subtle.decrypt({name: 'AES-GCM', iv: src(iv), tagLength: SYNC_TAG_LENGTH * 8}, cryptoKey, src(body))
        );
    } catch {
        throw new SyncCryptoError('authenticationFailed');
    }
}
