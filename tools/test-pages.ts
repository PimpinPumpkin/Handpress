/** Exercises page rotate, delete and reorder against a real multi-page file. */
import fs from 'node:fs';
import { degrees, PDFDocument } from 'pdf-lib';

const src = new Uint8Array(fs.readFileSync(process.argv[2]));
const plan = [
  { source: 2, rotate: 90 },
  { source: 0, rotate: 0 },
  { source: 1, rotate: 180 },
];

const doc = await PDFDocument.load(src, { throwOnInvalidObject: false, updateMetadata: false });
const originalCount = doc.getPageCount();
if (originalCount < 3) { console.log('needs at least 3 pages'); process.exit(0); }
const originalSizes = doc.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())]);
const originalRotations = doc.getPages().map((p) => p.getRotation().angle);

const originals = doc.getPages();
const chosen = plan.map((e) => ({ page: originals[e.source], rotate: e.rotate })).filter((x) => x.page);
for (let i = doc.getPageCount() - 1; i >= 0; i--) doc.removePage(i);
for (const { page, rotate } of chosen) {
  if (rotate) page.setRotation(degrees((page.getRotation().angle + rotate) % 360));
  doc.addPage(page);
}
const out = await doc.save({ useObjectStreams: false });

const doc2 = await PDFDocument.load(out, { throwOnInvalidObject: false, updateMetadata: false });
const got = doc2.getPages();
console.log(`pages ${originalCount} -> ${got.length} (want ${plan.length})`);
got.forEach((p, i) => {
  const want = plan[i];
  const wantRot = (originalRotations[want.source] + want.rotate) % 360;
  const size = [Math.round(p.getWidth()), Math.round(p.getHeight())];
  const srcSize = originalSizes[want.source];
  const sizeOk = size[0] === srcSize[0] && size[1] === srcSize[1];
  console.log(`  out[${i}] from source ${want.source}: rotation ${p.getRotation().angle} (want ${wantRot}) ${p.getRotation().angle === wantRot ? 'OK' : 'WRONG'}, size ${sizeOk ? 'matches source' : `${size} vs ${srcSize} MISMATCH`}`);
});
