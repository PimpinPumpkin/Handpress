/**
 * Images in and out.
 *
 * Two of the most common things anyone wants from a PDF tool are "make this
 * picture a PDF" and "make this page a picture". Both are a few lines given
 * everything else here, and neither needs a server: the first wraps the image
 * in a page of its own size, the second is the page already being rendered to a
 * canvas for the screen.
 */

import { PDFDocument } from 'pdf-lib';

/** Image types a page can be built from. */
export const IMAGE_TYPES = /\.(png|jpe?g)$/i;

export function looksLikeImage(file: { name: string; type: string }): boolean {
  return IMAGE_TYPES.test(file.name) || /^image\/(png|jpeg)$/.test(file.type);
}

/**
 * Wraps images in a PDF, one page each, at the image's own size.
 *
 * The page is made the size of the image rather than fitting the image to a
 * letter or A4 page, because the picture is the document here: cropping it to a
 * paper size nobody asked for is the kind of helpfulness that loses the edges.
 */
export async function pdfFromImages(
  images: Array<{ name: string; bytes: Uint8Array }>,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();

  for (const image of images) {
    const isJpeg = /\.jpe?g$/i.test(image.name) || isJpegBytes(image.bytes);
    const embedded = isJpeg ? await doc.embedJpg(image.bytes) : await doc.embedPng(image.bytes);
    const page = doc.addPage([embedded.width, embedded.height]);
    page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
  }

  if (doc.getPageCount() === 0) throw new Error('No usable images.');
  return doc.save();
}

/** JPEG files start with the same two bytes whatever they are called. */
function isJpegBytes(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8;
}
