import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { decryptToBytes } from '../src/pdf/decrypt';
import { describeSignatures, findSignatures } from '../src/pdf/signatures';

for (const file of process.argv.slice(2)) {
  const label = file.split('/').pop();
  try {
    const src = new Uint8Array(fs.readFileSync(file));
    const { bytes } = await decryptToBytes(src);
    const doc = await PDFDocument.load(bytes, { throwOnInvalidObject: false, updateMetadata: false });
    const report = findSignatures(doc);
    console.log(`${label}: signatures=${report.signatures.length} emptyFields=${report.emptyFields}`);
    for (const s of report.signatures) {
      console.log(`    name=${JSON.stringify(s.name)} at=${JSON.stringify(s.signedAt)} reason=${JSON.stringify(s.reason)} certified=${s.certification} P=${s.permittedChanges}`);
    }
    const msg = describeSignatures(report);
    if (msg) console.log(`    -> ${msg}`);
  } catch (e) {
    console.log(`${label}: ERROR ${(e as Error).message}`);
  }
}
