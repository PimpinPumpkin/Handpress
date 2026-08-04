/** Stamps a generated PNG onto a page and checks it lands as a real XObject. */
import fs from 'node:fs';
import { PDFDocument, PDFName, PDFDict } from 'pdf-lib';
import { getPageContent } from '../src/pdf/page';
import { groupLines, walkPage } from '../src/pdf/content';
import { applyEdits, type ImageStamp } from '../src/pdf/writer';

// A tiny PNG with alpha, built by pdf-lib itself so the test needs no fixture.
const scratch = await PDFDocument.create();
const page0 = scratch.addPage([200, 80]);
page0.drawText('signature', { x: 10, y: 30, size: 28 });
const madePdf = await scratch.save();

// Reuse an existing PNG from pdf-lib's own test surface instead: draw to a canvas
// is unavailable here, so a minimal hand-built RGBA PNG is used.
function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcInput = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i++) crcInput[i] = type.charCodeAt(i);
  crcInput.set(data, 4);
  dv.setUint32(8 + data.length, crc32(crcInput));
  return out;
}
const W = 8, H = 4;
const raw: number[] = [];
for (let y = 0; y < H; y++) {
  raw.push(0);
  for (let x = 0; x < W; x++) raw.push(20, 20, 160, x === y ? 0 : 255);
}
const zlib = await import('node:zlib');
const idat = zlib.deflateSync(Buffer.from(raw));
const ihdr = new Uint8Array(13);
new DataView(ihdr.buffer).setUint32(0, W);
new DataView(ihdr.buffer).setUint32(4, H);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const png = new Uint8Array([
  ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  ...chunk('IHDR', ihdr), ...chunk('IDAT', new Uint8Array(idat)), ...chunk('IEND', new Uint8Array(0)),
]);

const doc = await PDFDocument.load(new Uint8Array(fs.readFileSync(process.argv[2])), { throwOnInvalidObject: false, updateMetadata: false });
const page = doc.getPage(0);
const c = getPageContent(page);
const walk = walkPage(c.bytes, c.resources);
const lines = groupLines(walk.ops);
const linesBefore = lines.length;

const stamp: ImageStamp = { id: 'sig1', png, x: 100, y: 150, width: 180, height: 90 };
const res = await applyEdits(doc, page, walk, lines, [], c.bytes, null, [], [stamp]);
const out = await doc.save({ useObjectStreams: false });

const doc2 = await PDFDocument.load(out, { throwOnInvalidObject: false, updateMetadata: false });
const p2 = doc2.getPage(0);
const c2 = getPageContent(p2);
const lines2 = groupLines(walkPage(c2.bytes, c2.resources).ops);

const xo = p2.node.Resources()?.lookup(PDFName.of('XObject'));
const names = xo instanceof PDFDict ? [...xo.entries()].map(([k]) => k.asString()) : [];
const streamText = Buffer.from(c2.bytes).toString('latin1');
const drawn = /q 180 0 0 90 100 150 cm \/(\w+) Do Q/.exec(streamText);

console.log(`warnings=${JSON.stringify(res.warnings.map((w) => w.detail))}`);
console.log(`xobjects in page resources: ${names.join(', ') || 'none'}`);
console.log(`draw operator found: ${drawn ? drawn[0] : 'NO'}`);
console.log(`text lines before=${linesBefore} after=${lines2.length} (must be equal)`);
console.log(`saved ${out.length} bytes`);
