/**
 * What a page's vector drawing actually consists of.
 *
 * Prints every painted path with its bounds, so the clustering thresholds are
 * chosen from real documents rather than from a guess about what a logo looks
 * like.
 */

import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { getPageContent } from '../src/pdf/page';
import { walkPage } from '../src/pdf/content';

const file = process.argv[2];
const pageNo = Number(process.argv[3] ?? 1);
if (!file) {
  console.log('usage: probe-paths <file.pdf> [page]');
  process.exit(1);
}

const doc = await PDFDocument.load(new Uint8Array(fs.readFileSync(file)), {
  throwOnInvalidObject: false,
  updateMetadata: false,
});
const page = doc.getPage(pageNo - 1);
const content = getPageContent(page);
const walk = walkPage(content.bytes, content.resources);
const { width, height } = page.getSize();

console.log(`${file} page ${pageNo}, ${width.toFixed(0)}x${height.toFixed(0)}pt`);
console.log(`${walk.paths.length} painted paths, ${walk.images.length} images, ${walk.ops.length} text ops\n`);

for (const p of walk.paths) {
  const w = p.x1 - p.x0;
  const h = p.y1 - p.y0;
  console.log(
    `#${String(p.index).padStart(4)} ${p.streamId.padEnd(14)} d${p.depth} ` +
      `bytes ${String(p.start).padStart(7)}-${String(p.end).padStart(7)} ` +
      `at (${p.x0.toFixed(1)}, ${p.y0.toFixed(1)}) size ${w.toFixed(1)}x${h.toFixed(1)}`,
  );
}

const { findGraphics } = await import('../src/pdf/graphics');
const graphics = findGraphics(walk, width, height);
console.log(`\n${graphics.length} movable groups:`);
for (const g of graphics) {
  console.log(
    `  ${g.id.padEnd(16)} ${String(g.count).padStart(3)} paths  ` +
      `at (${g.x0.toFixed(1)}, ${g.y0.toFixed(1)}) size ${(g.x1 - g.x0).toFixed(1)}x${(g.y1 - g.y0).toFixed(1)}`,
  );
}
