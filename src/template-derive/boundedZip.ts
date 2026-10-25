import { inflateRawSync } from 'node:zlib';
import { LIMITS, StyleError, Guard } from './limits';

type Entry = { name: string; method: number; flags: number; crc: number; size: number; compressed: number; offset: number; data: number };
async function crc32(bytes: Uint8Array, guard: Guard): Promise<number> { let crc = -1; for (const [index, byte] of bytes.entries()) { if (index % 8192 === 0) await guard.tick(); crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ -1) >>> 0; }

/** No extraction to disk and no whole-package inflater. Every stream has an
 * actual-output cap, a verified central/local header, and a CRC check. */
export async function readBoundedZip(input: Uint8Array, guard: Guard): Promise<Map<string, Uint8Array>> {
  if (input.byteLength > LIMITS.input) throw new StyleError('too_large', 'Input exceeds 32 MiB.');
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const bad = (message: string): never => { throw new StyleError('corrupted', message); };
  const u16 = (offset: number) => offset >= 0 && offset + 2 <= bytes.length ? bytes.readUInt16LE(offset) : bad('Truncated ZIP.');
  const u32 = (offset: number) => offset >= 0 && offset + 4 <= bytes.length ? bytes.readUInt32LE(offset) : bad('Truncated ZIP.');
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) if (u32(offset) === 0x06054b50 && offset + 22 + u16(offset + 20) === bytes.length) { end = offset; break; }
  if (end < 0) return bad('Missing ZIP directory.');
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10)) throw new StyleError('unsupported', 'Multi-disk ZIP unsupported.');
  const count = u16(end + 10), directorySize = u32(end + 12), directory = u32(end + 16);
  if (count === 65535 || directorySize === 0xffffffff || directory === 0xffffffff) throw new StyleError('unsupported', 'ZIP64 unsupported.');
  if (count > LIMITS.entries) throw new StyleError('too_large', 'Too many ZIP entries.');
  if (directory + directorySize !== end) return bad('Invalid ZIP directory bounds.');
  let offset = directory, declared = 0;
  const entries: Entry[] = [], names = new Set<string>(), ranges: Array<[number, number]> = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let index = 0; index < count; index++) {
    await guard.tick();
    if (u32(offset) !== 0x02014b50) return bad('Bad ZIP central header.');
    const flags = u16(offset + 8), method = u16(offset + 10), crc = u32(offset + 16), compressed = u32(offset + 20), size = u32(offset + 24), nameLength = u16(offset + 28), extraLength = u16(offset + 30), commentLength = u16(offset + 32), local = u32(offset + 42);
    if (flags & 1) throw new StyleError('encrypted', 'Encrypted ZIP.');
    if (![0, 8].includes(method) || [size, compressed, local].includes(0xffffffff)) throw new StyleError('unsupported', 'Unsupported ZIP method/ZIP64.');
    if (offset + 46 + nameLength + extraLength + commentLength > end) return bad('Truncated ZIP entry.');
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength), name = decoder.decode(rawName);
// eslint-disable-next-line no-control-regex -- Control bytes must be rejected in untrusted Vault/archive paths.
    if (!name || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || /[\x00-\x1f]/.test(name) || name.split('/').some(part => part === '..' || part === '.') || names.has(name)) return bad('Unsafe/duplicate ZIP entry path.');
    if ((u32(offset + 38) >>> 16 & 0xf000) === 0xa000) throw new StyleError('unsupported', 'ZIP symlink unsupported.');
    names.add(name);
    for (let extra = offset + 46 + nameLength; extra < offset + 46 + nameLength + extraLength;) { const tag = u16(extra), length = u16(extra + 2); if (tag === 1) throw new StyleError('unsupported', 'ZIP64 extra field.'); extra += 4 + length; if (extra > offset + 46 + nameLength + extraLength) return bad('Invalid ZIP extra field.'); }
    if (u32(local) !== 0x04034b50 || u16(local + 6) !== flags || u16(local + 8) !== method || local >= directory) return bad('ZIP header mismatch.');
    const localLength = u16(local + 26), localExtra = u16(local + 28), data = local + 30 + localLength + localExtra;
    if (!rawName.equals(bytes.subarray(local + 30, local + 30 + localLength)) || data + compressed > directory) return bad('ZIP local path/bounds mismatch.');
    if (!(flags & 8) && (u32(local + 14) !== crc || u32(local + 18) !== compressed || u32(local + 22) !== size)) return bad('ZIP local sizes mismatch.');
    declared += size;
    if (size > LIMITS.stream || declared > LIMITS.inflated) throw new StyleError('bomb', 'ZIP inflated byte limit.');
    ranges.push([local, data + compressed]); entries.push({ name, method, flags, crc, size, compressed, offset: local, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== end) return bad('ZIP entry count mismatch.');
  ranges.sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < ranges.length; index++) if (ranges[index][0] < ranges[index - 1][1]) return bad('Overlapping ZIP entries.');
  const result = new Map<string, Uint8Array>(); let total = 0;
  for (const entry of entries) {
    await guard.tick();
    const compressed = bytes.subarray(entry.data, entry.data + entry.compressed);
    let output: Uint8Array;
    try { output = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, Math.min(LIMITS.stream, LIMITS.inflated - total, entry.size + 1)) }); }
    catch { throw new StyleError('bomb', 'Invalid or oversized compressed ZIP stream.'); }
    total += output.byteLength;
    if (output.byteLength !== entry.size || total > LIMITS.inflated || await crc32(output, guard) !== entry.crc) return bad('ZIP size/CRC mismatch.');
    result.set(entry.name, output);
  }
  return result;
}
