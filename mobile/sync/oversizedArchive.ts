/**
 * Test-only helper. Rewrites every central-directory entry's declared
 * *uncompressed* size to `declaredBytes` without touching the (tiny, real)
 * compressed data, so a test can build an archive whose `archiveUncompressedBytes`
 * sum exceeds SYNC_MAX_UNCOMPRESSED_BYTES cheaply. This exercises the 2 GiB cap
 * (and the "reject before decompressing" path) without allocating or CRC-ing
 * gigabytes. Walks the End-Of-Central-Directory record to find the central
 * directory, so it is robust against the signature bytes appearing inside
 * compressed data. Not imported by any production code.
 */

const CENSIG = 0x02014b50; // central-directory file header, "PK\x01\x02"
const ENDSIG = 0x06054b50; // end of central directory, "PK\x05\x06"

/** Return a copy of `zipBytes` with every entry declaring `declaredBytes` uncompressed. */
export function inflateDeclaredSizes(zipBytes: Uint8Array, declaredBytes: number): Uint8Array {
    const buf = Buffer.from(zipBytes);
    let eocd = -1;
    for(let i = buf.length - 22; i >= 0; i--)
        if(buf.readUInt32LE(i) === ENDSIG) { eocd = i; break; }
    if(eocd < 0) throw new Error('no end-of-central-directory record');
    const count = buf.readUInt16LE(eocd + 10); // ENDTOT: total entries
    let offset = buf.readUInt32LE(eocd + 16);  // ENDOFF: start of central directory
    for(let n = 0; n < count; n++) {
        if(buf.readUInt32LE(offset) !== CENSIG) throw new Error('malformed central directory');
        buf.writeUInt32LE(declaredBytes >>> 0, offset + 24); // CENLEN: uncompressed size
        const nameLen = buf.readUInt16LE(offset + 28);       // CENNAM
        const extraLen = buf.readUInt16LE(offset + 30);      // CENEXT
        const commentLen = buf.readUInt16LE(offset + 32);    // CENCOM
        offset += 46 + nameLen + extraLen + commentLen;      // CENHDR + variable-length fields
    }
    return new Uint8Array(buf);
}
