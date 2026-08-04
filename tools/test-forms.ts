/** Fills every writable field, saves, reloads, and checks the values survived. */
import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { decryptToBytes } from '../src/pdf/decrypt';
import { readForm, applyFormValues } from '../src/pdf/forms';

const argv = process.argv.slice(2);
const listIdx = argv.indexOf('--list');
const files = listIdx >= 0
  ? fs.readFileSync(argv[listIdx + 1], 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
  : argv;
const anon = process.env.ANON === '1';

let withForms = 0, ok = 0, bad = 0, xfa = 0, n = 0;

for (const file of files) {
  n++;
  const label = anon ? `doc#${n}` : file.split('/').pop();
  let src: Uint8Array;
  try { src = new Uint8Array(fs.readFileSync(file)); } catch { continue; }
  if (!/\/AcroForm/.test(Buffer.from(src).toString('latin1'))) continue;

  let doc: PDFDocument;
  try {
    const opened = await decryptToBytes(src);
    doc = await PDFDocument.load(opened.bytes, { throwOnInvalidObject: false, updateMetadata: false });
  } catch { continue; }

  let report;
  try { report = readForm(doc); } catch (e) {
    console.log(`FAIL ${label}: readForm threw: ${(e as Error).message}`); bad++; continue;
  }
  if (!report.fields.length) continue;
  withForms++;
  if (report.isXfa) xfa++;

  const byType = new Map<string, number>();
  for (const f of report.fields) byType.set(f.type, (byType.get(f.type) ?? 0) + 1);

  // Fill everything writable with something type-appropriate.
  const values = new Map<string, string>();
  const expected = new Map<string, string>();
  for (const f of report.fields) {
    if (f.readOnly || values.has(f.name)) continue;
    if (f.type === 'text') {
      // A field with a length limit legitimately stores only what fits.
      const v = 'ZQX-filled';
      values.set(f.name, v);
      expected.set(f.name, f.maxLength ? v.slice(0, f.maxLength) : v);
      continue;
    }
    if (f.type === 'checkbox') { values.set(f.name, 'on'); expected.set(f.name, 'on'); }
    else if ((f.type === 'radio' || f.type === 'dropdown') && f.options.length) {
      values.set(f.name, f.options[0]);
      expected.set(f.name, f.options[0]);
    }
  }
  if (!values.size) continue;

  let warnings;
  try { warnings = applyFormValues(doc, values); } catch (e) {
    console.log(`FAIL ${label}: applyFormValues threw: ${(e as Error).message}`); bad++; continue;
  }

  let out: Uint8Array;
  try { out = await doc.save({ useObjectStreams: false }); } catch (e) {
    console.log(`FAIL ${label}: save threw: ${(e as Error).message}`); bad++; continue;
  }

  // Read the saved file back and confirm the values are really there.
  let after;
  try {
    const doc2 = await PDFDocument.load(out, { throwOnInvalidObject: false, updateMetadata: false });
    after = readForm(doc2);
  } catch (e) {
    console.log(`FAIL ${label}: reload threw: ${(e as Error).message}`); bad++; continue;
  }

  let matched = 0, missed = 0;
  const seen = new Set<string>();
  for (const f of after.fields) {
    if (seen.has(f.name)) continue;
    seen.add(f.name);
    const want = expected.get(f.name);
    if (want === undefined) continue;
    if (f.value === want || (want === 'on' && f.value === 'on')) matched++;
    else { missed++; if (missed === 1) console.log(`  ${label}: ${JSON.stringify(f.name)} want ${JSON.stringify(want)} got ${JSON.stringify(f.value)}`); }
  }

  const types = [...byType.entries()].map(([k, v]) => `${k}:${v}`).join(' ');
  if (missed === 0 && matched > 0) {
    ok++;
    console.log(`OK ${label}: ${report.fields.length} widgets (${types}) filled ${matched}, warnings ${warnings.length}`);
  } else {
    bad++;
    console.log(`FAIL ${label}: ${matched} matched, ${missed} missed (${types})`);
  }
}

console.log(`\nforms: ${withForms} documents with fields, ${ok} filled correctly, ${bad} failed, ${xfa} XFA`);
