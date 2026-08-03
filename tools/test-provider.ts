/**
 * Verifies the font provider path: when the document's own font cannot draw a
 * character, a real typeface supplied by the provider is embedded and used
 * instead of a standard font.
 */

import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { getPageContent } from '../src/pdf/page';
import { groupLines, walkPage } from '../src/pdf/content';
import { applyEdits, type FontProvider } from '../src/pdf/writer';
import { missingChars } from '../src/pdf/fonts';

const file = process.argv[2];
const fontPath = process.argv[3] ?? '/System/Library/Fonts/Supplemental/Arial.ttf';

if (!fs.existsSync(fontPath)) {
  console.log(`no font at ${fontPath}; pass one as the second argument`);
  process.exit(1);
}
const fontBytes = new Uint8Array(fs.readFileSync(fontPath));

let asked: string[] = [];
const provider: FontProvider = {
  async fetch(req) {
    asked.push(`${req.family} bold=${req.bold} italic=${req.italic}`);
    return fontBytes;
  },
};

async function run(useProvider: boolean): Promise<{ bytes: number; warnings: string[] }> {
  const doc = await PDFDocument.load(new Uint8Array(fs.readFileSync(file)), {
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
  const page = doc.getPage(0);
  const content = getPageContent(page);
  const walk = walkPage(content.bytes, content.resources);
  const lines = groupLines(walk.ops);

  // Find a line whose font genuinely cannot draw some character we want to type.
  const probe = 'Zwykły ĝeneraljo VVKKQQ';
  const target = lines.find((l) => l.editable && l.text.length > 12 && missingChars(l.font, probe).length > 0);
  if (!target) throw new Error('no line found whose font lacks the probe characters');

  const result = await applyEdits(
    doc,
    page,
    walk,
    lines,
    [{ lineId: target.id, newText: `${target.text} VVKKQQ` }],
    content.bytes,
    useProvider ? provider : null,
  );
  const out = await doc.save({ useObjectStreams: false });

  // Confirm the edit survives a reload.
  const doc2 = await PDFDocument.load(out, { throwOnInvalidObject: false, updateMetadata: false });
  const c2 = getPageContent(doc2.getPage(0));
  const lines2 = groupLines(walkPage(c2.bytes, c2.resources).ops);
  const found = lines2.some((l) => l.text.includes('VVKKQQ'));
  if (!found) throw new Error('edited text not found after save');

  return { bytes: out.length, warnings: result.warnings.map((w) => w.detail) };
}

asked = [];
const withStd = await run(false);
console.log('standard-font fallback:');
console.log(`  saved ${withStd.bytes} bytes`);
console.log(`  ${withStd.warnings[0] ?? 'no warnings'}`);

asked = [];
const withLocal = await run(true);
console.log('\nprovider-supplied font:');
console.log(`  saved ${withLocal.bytes} bytes`);
console.log(`  provider asked for: ${asked.join(', ') || 'nothing'}`);
console.log(`  ${withLocal.warnings[0] ?? 'no warnings'}`);

const usedLocal = withLocal.warnings.some((w) => /from this computer/.test(w));
const grew = withLocal.bytes > withStd.bytes;
console.log(
  `\nprovider font embedded: ${usedLocal ? 'yes' : 'NO'} | output grew by ${withLocal.bytes - withStd.bytes} bytes (subset embedded: ${grew ? 'yes' : 'NO'})`,
);
process.exit(usedLocal && grew ? 0 : 1);
