/**
 * Byte conversions that avoid the `buffer` polyfill's own encoders.
 *
 * Everything the sync moves crosses the native bridge as either a JS string or
 * base64, and on a real log store those conversions measured as a large share of
 * the total. `Buffer.from(text, 'utf8')`, `Buffer.from(b64, 'base64')` and
 * `buf.toString('base64')` are JavaScript loops inside the WebView; `TextEncoder`,
 * `Uint8Array.fromBase64` and `Uint8Array.prototype.toBase64` are the engine's own.
 * All fall back to the polyfill where the engine lacks them, so this is a speed
 * choice and never a correctness one.
 *
 * Every base64 the sync produces or consumes should go through here. The paths that
 * matter are not only the obvious ones: each log write, each send snapshot and each
 * HTTP body in both directions is a whole-buffer conversion, and together they move
 * more bytes than the log reads do.
 */

interface Base64Capable {
    fromBase64?(text: string): Uint8Array;
}

interface Base64Encodable {
    toBase64?(): string;
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

/** Encode base64, preferring the engine's own encoder (Chrome 140+, Safari 18.2+). */
export function toBase64(bytes: Uint8Array): string {
    const native = (bytes as Uint8Array & Base64Encodable).toBase64;
    if(native !== undefined) {
        try {
            return native.call(bytes);
        } catch {
            // Fall through to the polyfill rather than failing a transfer over an
            // encoder that is merely absent or stricter than expected.
        }
    }
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}
