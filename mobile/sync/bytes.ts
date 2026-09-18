/**
 * Byte conversions that avoid the `buffer` polyfill's own encoders.
 *
 * Everything the sync moves crosses the native bridge as either a JS string or
 * base64, and on a real log store those conversions measured as a large share of
 * the total. `Buffer.from(text, 'utf8')` and `Buffer.from(b64, 'base64')` are
 * JavaScript loops inside the WebView; `TextEncoder` and `Uint8Array.fromBase64`
 * are the engine's own. Both fall back to the polyfill where the engine lacks them,
 * so this is a speed choice and never a correctness one.
 */

interface Base64Capable {
    fromBase64?(text: string): Uint8Array;
}

/** UTF-8 encode, wrapping the result rather than copying it again. */
export function utf8(text: string): Buffer {
    const bytes = new TextEncoder().encode(text);
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Decode base64, preferring the engine's own decoder (Chrome 140+, Safari 18.2+). */
export function fromBase64(text: string): Buffer {
    const native = (Uint8Array as unknown as Base64Capable).fromBase64;
    if(native !== undefined) {
        try {
            const bytes = native.call(Uint8Array, text);
            return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        } catch {
            // Malformed input, or an implementation stricter than the polyfill:
            // fall through so behaviour matches what the rest of the code expects.
        }
    }
    return Buffer.from(text, 'base64');
}
