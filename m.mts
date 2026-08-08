import { readFileSync } from 'fs';
import { PDFDocument } from 'pdf-lib';
import { getPageContent } from '/Users/user/Handpress/src/pdf/page.ts';
import { walkPage } from '/Users/user/Handpress/src/pdf/content.ts';

const files = ['sample.pdf','sample-form.pdf','sample-long.pdf','sample-multi.pdf','sample-heavy.pdf'];
for (const f of files) {
  const bytes = readFileSync('public/'+f);
  let t = performance.now();
  const doc = await PDFDocument.load(new Uint8Array(bytes), { throwOnInvalidObject:false, updateMetadata:false });
  const tLoad = performance.now()-t;
  const n = doc.getPageCount();
  t = performance.now();
  const page = doc.getPage(0);
  const c = getPageContent(page);
  const w = walkPage(c.bytes, c.resources);
  const tWalk = performance.now()-t;
  t = performance.now();
  await doc.save({ useObjectStreams:false });
  const tSave = performance.now()-t;
  t = performance.now();
  const b2 = await doc.save({ useObjectStreams:true });
  const tSave2 = performance.now()-t;
  console.log(`${f} pages=${n} load=${tLoad.toFixed(1)} walk1pg=${tWalk.toFixed(1)} save=${tSave.toFixed(1)} saveOS=${tSave2.toFixed(1)} sizeOS=${(b2.length/1024)|0}KB orig=${(bytes.length/1024)|0}KB`);
}
