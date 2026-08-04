/**
 * Wraps a page image in a PDF, which is what a flatbed scan actually is: no
 * text, just a picture. Used to exercise recognition.
 *
 *   sips -s format png -s dpiWidth 200 -s dpiHeight 200 in.pdf --out /tmp/scan.png
 *   npx tsx tools/make-scan.ts /tmp/scan.png public/sample-scan.pdf
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';

async function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('usage: make-scan.ts <image.png|jpg> <out.pdf>');
    process.exit(1);
  }
  const bytes = readFileSync(input);
  const doc = await PDFDocument.create();
  const image = /\.jpe?g$/i.test(input) ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
  const page = doc.addPage([image.width, image.height]);
  page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  writeFileSync(output, await doc.save());
  console.log(`wrote ${output} at ${image.width} by ${image.height}`);
}

main();
