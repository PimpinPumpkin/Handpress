/**
 * A minimal zip writer.
 *
 * Splitting a document produces one file per page, and handing somebody twenty
 * downloads is not an answer: browsers throttle them, ask about them, and
 * scatter them through a folder in whatever order they finish. One archive is
 * the obvious thing, and writing one is about eighty lines.
 *
 * Entries are stored rather than deflated. A PDF is already compressed, so
 * deflating it again buys a percent or two for the cost of pulling in a
 * compressor, and the browser has no zip of its own to borrow.
 */

/** One file in the archive. */
export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_DIRECTORY = 0x06054b50;

/** Stored, meaning the bytes go in exactly as they are. */
const STORED = 0;

export function zip(entries: ZipEntry[], now = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  const { time, date } = dosTime(now);

  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.bytes);

    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, LOCAL_HEADER, true);
    localView.setUint16(4, 20, true); // version needed
    localView.setUint16(6, 0x0800, true); // names are UTF-8
    localView.setUint16(8, STORED, true);
    localView.setUint16(10, time, true);
    localView.setUint16(12, date, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, entry.bytes.length, true);
    localView.setUint32(22, entry.bytes.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);

    parts.push(local, entry.bytes);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, CENTRAL_HEADER, true);
    centralView.setUint16(4, 20, true); // version made by
    centralView.setUint16(6, 20, true); // version needed
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, STORED, true);
    centralView.setUint16(12, time, true);
    centralView.setUint16(14, date, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, entry.bytes.length, true);
    centralView.setUint32(24, entry.bytes.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    directory.push(central);

    offset += local.length + entry.bytes.length;
  }

  const directorySize = directory.reduce((n, d) => n + d.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, END_OF_DIRECTORY, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, directorySize, true);
  endView.setUint32(16, offset, true);

  return concat([...parts, ...directory, end]);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** Zip stores the time the way MS-DOS did, in two packed sixteen bit words. */
function dosTime(when: Date): { time: number; date: number } {
  const year = Math.max(1980, when.getFullYear());
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}

let table: Uint32Array | null = null;

function crcTable(): Uint32Array {
  if (table) return table;
  table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
}

export function crc32(bytes: Uint8Array): number {
  const t = crcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = t[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
