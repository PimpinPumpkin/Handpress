/**
 * Headless check of the text engine: walks a PDF's content streams and compares
 * the recovered text against pdf.js's own extraction.
 */

import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { getPageContent } from '../src/pdf/page';
import { groupLines, walkPage } from '../src/pdf/content';
import { encodeText, missingChars } from '../src/pdf/fonts';

const argv = process.argv.slice(2);
const listIdx = argv.indexOf('--list');
const files =
  listIdx >= 0
    ? fs.readFileSync(argv[listIdx + 1], 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
    : argv;
const showText = process.env.SHOW_TEXT === '1';
// Private documents are identified by index in the output rather than by name.
const anon = process.env.ANON === '1';

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

let fileNo = 0;
for (const file of files) {
  fileNo++;
  const label = anon ? `doc#${fileNo}` : file.split('/').pop();
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(fs.readFileSync(file));
  } catch {
    console.log(`SKIP ${label}: unreadable`);
    continue;
  }

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { throwOnInvalidObject: false, updateMetadata: false });
  } catch (e) {
    console.log(`FAIL ${label}: pdf-lib load: ${(e as Error).message}`);
    continue;
  }

  let pageCount: number;
  try {
    pageCount = doc.getPageCount();
  } catch {
    console.log(`FAIL ${label}: unreadable page tree`);
    continue;
  }
  const pagesToCheck = Math.min(pageCount, 3);

  let totalOps = 0;
  let totalLines = 0;
  let reEncodable = 0;
  let notEncodable = 0;
  const missingSet = new Set<string>();
  const fontKinds = new Map<string, number>();
  let jsChars = 0;
  let myChars = 0;

  let jsDoc;
  try {
    jsDoc = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false, disableFontFace: true }).promise;
  } catch {
    console.log(`SKIP ${label}: pdf.js could not open it`);
    continue;
  }

  for (let p = 0; p < pagesToCheck; p++) {
    let page, content, walk, lines;
    try {
      page = doc.getPage(p);
      content = getPageContent(page);
      walk = walkPage(content.bytes, content.resources);
      lines = groupLines(walk.ops);
    } catch {
      continue; // a page that will not parse is reported as contributing nothing
    }
    totalOps += walk.ops.length;
    totalLines += lines.length;

    for (const f of walk.fonts.values()) {
      const key = `${f.subtype}${f.embedded ? '/' + f.fontFileKind : '/none'}${f.hasToUnicode ? '+tu' : '-tu'}`;
      fontKinds.set(key, (fontKinds.get(key) ?? 0) + 1);
    }

    // Round-trip each segment through its own font's encoder: this is exactly
    // the test the editor runs before deciding it can edit text in place.
    for (const line of lines) {
      let ok = true;
      for (const seg of line.segments) {
        if (encodeText(seg.font, seg.text)) continue;
        ok = false;
        for (const c of missingChars(seg.font, seg.text)) missingSet.add(c);
      }
      if (ok) reEncodable++;
      else notEncodable++;
    }

    let jsText = '';
    try {
      const jsPage = await jsDoc.getPage(p + 1);
      const tc = await jsPage.getTextContent({ includeMarkedContent: false, disableNormalization: true });
      jsText = norm((tc.items as Array<{ str?: string }>).map((i) => i.str ?? '').join(''));
    } catch {
      jsText = '';
    }
    const myText = norm(walk.ops.map((o) => o.text).join(''));
    jsChars += jsText.length;
    myChars += myText.length;

    if (showText && p === 0) {
      console.log(`\n--- ${label} page 1: first 12 lines ---`);
      for (const l of lines.slice(0, 12)) {
        console.log(
          `  [${l.x0.toFixed(0)},${l.baselineY.toFixed(0)}] ${l.fontSize.toFixed(1)}pt ` +
            `${l.uniform ? ' ' : '~'}${l.font.family || l.font.subtype} :: ${JSON.stringify(l.text.slice(0, 70))}`,
        );
      }
    }
  }

  const ratio = jsChars ? ((myChars / jsChars) * 100).toFixed(0) : 'n/a';
  const pct = totalLines ? ((reEncodable / totalLines) * 100).toFixed(0) : '0';
  console.log(
    `${label}\n  pages=${pageCount} ops=${totalOps} lines=${totalLines} ` +
      `extract-vs-pdfjs=${ratio}% editable-in-place=${pct}% (${reEncodable}/${totalLines})`,
  );
  console.log(`  fonts: ${[...fontKinds.entries()].map(([k, v]) => `${k}x${v}`).join(' ')}`);
  if (missingSet.size) {
    console.log(`  unencodable chars: ${JSON.stringify([...missingSet].slice(0, 20).join(''))}`);
  }
}
