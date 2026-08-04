/** Moves, scales and deletes an existing image, checking each lands exactly. */
import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { getPageContent } from '../src/pdf/page';
import { groupLines, walkPage } from '../src/pdf/content';
import { applyEdits } from '../src/pdf/writer';

async function run(file: string, mode: 'move' | 'scale' | 'remove') {
  const doc = await PDFDocument.load(new Uint8Array(fs.readFileSync(file)), { throwOnInvalidObject: false, updateMetadata: false });
  const page = doc.getPage(0);
  const c = getPageContent(page);
  const walk = walkPage(c.bytes, c.resources);
  if (!walk.images.length) return console.log(`${file.split('/').pop()}: no images`);

  const img = walk.images.sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0))[0];
  const id = `${img.streamId}:${img.index}`;
  const DX = 41.5, DY = -18.25, S = mode === 'scale' ? 1.5 : 1;
  const edit = { imageId: id, dx: mode === 'remove' ? 0 : DX, dy: mode === 'remove' ? 0 : DY, scale: S, remove: mode === 'remove' };

  const linesBefore = groupLines(walk.ops).length;
  const res = await applyEdits(doc, page, walk, groupLines(walk.ops), [], c.bytes, null, [], [], [edit]);
  const out = await doc.save({ useObjectStreams: false });

  const doc2 = await PDFDocument.load(out, { throwOnInvalidObject: false, updateMetadata: false });
  const c2 = getPageContent(doc2.getPage(0));
  const walk2 = walkPage(c2.bytes, c2.resources);
  const linesAfter = groupLines(walk2.ops).length;

  if (mode === 'remove') {
    console.log(`  remove: images ${walk.images.length} -> ${walk2.images.length} (want ${walk.images.length - 1}), text lines ${linesBefore} -> ${linesAfter}`);
    return;
  }
  const after = walk2.images.find((im) => im.name === img.name && Math.abs((im.x1 - im.x0) - (img.x1 - img.x0) * S) < 0.5);
  if (!after) return console.log(`  ${mode}: image not found after save`);
  const wantX = img.x0 + DX, wantY = img.y0 + DY;
  const ex = Math.abs(after.x0 - wantX), ey = Math.abs(after.y0 - wantY);
  const wantW = (img.x1 - img.x0) * S, gotW = after.x1 - after.x0;
  console.log(`  ${mode}: pos error dx=${ex.toFixed(3)} dy=${ey.toFixed(3)} | width ${gotW.toFixed(1)} want ${wantW.toFixed(1)} | text lines ${linesBefore} -> ${linesAfter} | warnings ${res.warnings.length}`);
}

const file = process.argv[2];
console.log(file.split('/').pop());
await run(file, 'move');
await run(file, 'scale');
await run(file, 'remove');
