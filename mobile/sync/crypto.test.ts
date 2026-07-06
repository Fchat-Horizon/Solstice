import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decryptBody, encryptBody, sealWithIv, SyncCryptoError, SYNC_IV_LENGTH, SYNC_TAG_LENGTH} from './crypto.ts';
import {parseSessionPayload, SyncError} from './payload.ts';

function hex(s: string): Uint8Array {
    const out = new Uint8Array(s.length / 2);
    for(let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
}

// MARK: Framing

// Known-answer test pinning the exact wire layout: the McGrew-Viega AES-256-GCM
// vector (test case 15's key/IV, 60-byte plaintext, no AAD). If this fails, the
// framing does not interoperate with Horizon's encryptBody/decryptBody.
test('crypto: known-answer vector matches the protocol framing', async () => {
    const key = hex('feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308');
    const iv = hex('cafebabefacedbaddecaf888');
    const plain = hex('d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a72'
        + '1c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39');
    const expected = hex('cafebabefacedbaddecaf888522dc1f099567d07f47f37a32a84427d643a8cdc'
        + 'bfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e63'
        + '93ba7a0abcc9f662eb9f796c8d356fc31a8433884b696f4f');
    assert.deepEqual(await sealWithIv(key, plain, iv), expected);
    assert.deepEqual(await decryptBody(key, expected), plain);
});

test('crypto: round trip with a random IV', async () => {
    const key = new Uint8Array(Array.from({length: 32}, (_, i) => i));
    const plain = new TextEncoder().encode('the quick brown fox \u{1F98A}');
    const sealed = await encryptBody(key, plain);
    assert.equal(sealed.length, plain.length + SYNC_IV_LENGTH + SYNC_TAG_LENGTH);
    assert.deepEqual(await decryptBody(key, sealed), plain);
});

test('crypto: each message gets a fresh IV', async () => {
    const key = new Uint8Array(32).fill(7);
    const a = await encryptBody(key, new TextEncoder().encode('same'));
    const b = await encryptBody(key, new TextEncoder().encode('same'));
    assert.notDeepEqual(a.subarray(0, SYNC_IV_LENGTH), b.subarray(0, SYNC_IV_LENGTH));
});

test('crypto: an empty body round trips (IV + tag only)', async () => {
    const key = new Uint8Array(32).fill(3);
    const sealed = await encryptBody(key, new Uint8Array(0));
    assert.equal(sealed.length, SYNC_IV_LENGTH + SYNC_TAG_LENGTH);
    assert.deepEqual(await decryptBody(key, sealed), new Uint8Array(0));
});

test('crypto: a tampered body fails authentication', async () => {
    const key = new Uint8Array(32).fill(9);
    const sealed = await encryptBody(key, new TextEncoder().encode('payload'));
    sealed[sealed.length - 1] ^= 0x01;
    await assert.rejects(decryptBody(key, sealed), (e: unknown) =>
        e instanceof SyncCryptoError && e.code === 'authenticationFailed');
});

test('crypto: the wrong key fails authentication', async () => {
    const sealed = await encryptBody(new Uint8Array(32).fill(1), new TextEncoder().encode('payload'));
    await assert.rejects(decryptBody(new Uint8Array(32).fill(2), sealed), (e: unknown) =>
        e instanceof SyncCryptoError && e.code === 'authenticationFailed');
});

test('crypto: a too-short body is rejected', async () => {
    await assert.rejects(decryptBody(new Uint8Array(32).fill(1), new Uint8Array(27)), (e: unknown) =>
        e instanceof SyncCryptoError && e.code === 'bodyTooShort');
});

test('crypto: a bad key length is rejected', async () => {
    await assert.rejects(encryptBody(new Uint8Array(16).fill(1), new TextEncoder().encode('x')), (e: unknown) =>
        e instanceof SyncCryptoError && e.code === 'badKey');
});

// MARK: QR payload

const KEY_B64 = Buffer.from(new Uint8Array(32).fill(5)).toString('base64');
const validPayload = JSON.stringify({
    v: 1, app: 'horizon-log-sync', addrs: ['192.168.1.5', '10.0.0.3'],
    port: 51234, token: 'ab'.repeat(32), key: KEY_B64, account: 'AccountName'
});

test('payload: parses the spec example (tolerating stray whitespace)', () => {
    const payload = parseSessionPayload(`  ${validPayload}\n`);
    assert.deepEqual(payload.addrs, ['192.168.1.5', '10.0.0.3']);
    assert.equal(payload.port, 51234);
    assert.equal(payload.token, 'ab'.repeat(32));
    assert.deepEqual(payload.key, new Uint8Array(32).fill(5));
    assert.equal(payload.account, 'AccountName');
});

test('payload: rejects foreign and malformed codes', () => {
    const bad = [
        '',
        'hello',
        validPayload.replace('horizon-log-sync', 'other-app'),
        validPayload.replace('"v":1', '"v":2'),
        JSON.stringify({...JSON.parse(validPayload), v: 2}),
        JSON.stringify({...JSON.parse(validPayload), port: 0}),
        JSON.stringify({...JSON.parse(validPayload), key: Buffer.from(new Uint8Array(16)).toString('base64')}),
        JSON.stringify({...JSON.parse(validPayload), addrs: []})
    ];
    for(const text of bad)
        assert.throws(() => parseSessionPayload(text), (e: unknown) =>
            e instanceof SyncError && e.kind.type === 'invalidPayload', `expected reject for: ${text}`);
});
