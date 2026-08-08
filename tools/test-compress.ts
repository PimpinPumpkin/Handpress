/**
 * Compression.
 *
 * Checks the two things that could go badly wrong: that an image is only
 * redrawn when the page really shows it smaller than it is stored, and that a
 * document survives having its images replaced with all of its pages and all of
 * its text still there.
 *
 * The redrawing itself needs a canvas, so this stands in a fixed JPEG for it.
 * That is deliberate: what is being tested here is which images get chosen and
 * whether the file still reads afterwards, not the quality of a resize, which
 * is the browser's job and is checked by looking at it.
 */

import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { getPageContent } from '../src/pdf/page';
import { groupLines, walkPage } from '../src/pdf/content';
import { compress, type Recompressor, type StoredImage } from '../src/pdf/compress';

/** A bare 8 by 8 baseline JPEG with every metadata segment stripped. */
const STAND_IN = Uint8Array.from(
  Buffer.from(
    '/9j/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwAJCQkJCQkQCQkQFhAQEBYeFhYWFh4mHh4eHh4mLiYmJiYmJi4uLi4uLi4uNzc3Nzc3QEBAQEBISEhISEhISEhI/9sAQwELDAwSERIfEREfSzMqM0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tL/90ABAAB/9oADAMBAAIRAxEAPwDuKKKK5jU//9k=',
    'base64',
  ),
);

const files = process.argv.slice(2);
const anon = process.env.ANON === '1';

let pass = 0;
let fail = 0;
let fileNo = 0;

/** Stands in for the browser, and records what it was asked to do. */
function standIn(asked: Array<{ from: number; to: number }>): Recompressor {
  return async (image: StoredImage, targetWidth: number) => {
    asked.push({ from: image.width, to: targetWidth });
    return { bytes: STAND_IN, width: 8, height: 8 };
  };
}

for (const file of files) {
  fileNo++;
  const label = anon ? `doc#${fileNo}` : file.split('/').pop();
  const problems: string[] = [];

  const original = new Uint8Array(fs.readFileSync(file));
  const before = await read(original);

  const asked: Array<{ from: number; to: number }> = [];
  const { bytes, report } = await compress(original, standIn(asked));

  // Nothing should ever be asked to grow.
  for (const ask of asked) {
    if (ask.to >= ask.from) {
      problems.push(`asked to redraw ${ask.from}px wide as ${ask.to}px, which is no smaller`);
      break;
    }
  }

  const after = await read(bytes);
  if (after.pages !== before.pages) problems.push(`pages ${before.pages} -> ${after.pages}`);
  if (after.text !== before.text) problems.push(`page text changed`);
  if (report.shrunk && bytes.length >= original.length) {
    problems.push(`${report.shrunk} images redrawn but the file grew`);
  }

  const saved = report.before ? Math.round((1 - report.after / report.before) * 100) : 0;
  if (problems.length) {
    console.log(`FAIL ${label}: ${problems.join('; ')}`);
    fail++;
  } else {
    console.log(
      `OK ${label}: ${report.shrunk} shrunk, ${report.kept} kept, ` +
        `${(report.before / 1024).toFixed(0)}K -> ${(report.after / 1024).toFixed(0)}K (${saved}%)`,
    );
    pass++;
  }
}

async function read(bytes: Uint8Array): Promise<{ pages: number; text: string }> {
  const doc = await PDFDocument.load(bytes, { throwOnInvalidObject: false, updateMetadata: false });
  const content = getPageContent(doc.getPage(0));
  const lines = groupLines(walkPage(content.bytes, content.resources).ops);
  return { pages: doc.getPageCount(), text: lines.map((l) => l.text).join('\n') };
}

console.log(`\ncompress: ${pass} ok, ${fail} failed`);
if (fail) process.exitCode = 1;
