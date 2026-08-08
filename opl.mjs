import { readFileSync } from 'fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
const files = ['sample.pdf','sample-form.pdf','sample-long.pdf','sample-multi.pdf','sample-heavy.pdf','sample-scan.pdf'];
for (const f of files) {
  const data = new Uint8Array(readFileSync('public/'+f));
  let t = performance.now();
  const doc = await pdfjs.getDocument({ data, useSystemFonts:true }).promise;
  const tDoc = performance.now()-t;
  const pg = await doc.getPage(1);
  t = performance.now();
  await pg.getOperatorList();
  const tOpl = performance.now()-t;
  t = performance.now();
  await pg.getTextContent();
  const tTxt = performance.now()-t;
  console.log(`${f} getDocument=${tDoc.toFixed(1)} opList=${tOpl.toFixed(1)} textContent=${tTxt.toFixed(1)}`);
  await doc.destroy();
}
