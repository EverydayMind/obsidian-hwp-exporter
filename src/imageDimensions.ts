import * as path from 'path';

export interface PixelSize {
    width: number;
    height: number;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function isPositiveFinite(value: number): boolean {
    return Number.isFinite(value) && value > 0;
}

function isPng(buffer: Buffer): boolean {
    return buffer.length >= 24 && PNG_SIGNATURE.every((value, index) => buffer[index] === value);
}

function readPngSize(buffer: Buffer): PixelSize | null {
    if (!isPng(buffer)) return null;
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return isPositiveFinite(width) && isPositiveFinite(height) ? { width, height } : null;
}

function readGifSize(buffer: Buffer): PixelSize | null {
    if (buffer.length < 10) return null;
    const signature = buffer.subarray(0, 6).toString('ascii');
    if (signature !== 'GIF87a' && signature !== 'GIF89a') return null;
    const width = buffer.readUInt16LE(6);
    const height = buffer.readUInt16LE(8);
    return isPositiveFinite(width) && isPositiveFinite(height) ? { width, height } : null;
}

function isJpegSof(marker: number): boolean {
    return (marker >= 0xc0 && marker <= 0xc3)
        || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb)
        || (marker >= 0xcd && marker <= 0xcf);
}

function readJpegSize(buffer: Buffer): PixelSize | null {
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

    let offset = 2;
    while (offset + 3 < buffer.length) {
        while (offset < buffer.length && buffer[offset] !== 0xff) offset += 1;
        while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
        if (offset >= buffer.length) break;

        const marker = buffer[offset++];
        if (marker === 0xd8 || marker === 0xd9) continue;
        if (marker === 0xda) break;
        if (offset + 1 >= buffer.length) break;

        const segmentLength = buffer.readUInt16BE(offset);
        if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
        if (isJpegSof(marker) && segmentLength >= 7) {
            const height = buffer.readUInt16BE(offset + 3);
            const width = buffer.readUInt16BE(offset + 5);
            return isPositiveFinite(width) && isPositiveFinite(height) ? { width, height } : null;
        }
        offset += segmentLength;
    }
    return null;
}

/** Read dimensions without decoding the image. Unsupported/corrupt input returns null. */
export function readImagePixelSize(buffer: Buffer): PixelSize | null {
    return readPngSize(buffer) ?? readGifSize(buffer) ?? readJpegSize(buffer);
}

/** Return the extension used by the HWPX binary item contract. */
export function imageBinaryExtension(filePath: string): 'png' | 'jpg' | 'gif' {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    return ext === 'jpeg' ? 'jpg' : ext === 'jpg' || ext === 'gif' ? ext : 'png';
}
