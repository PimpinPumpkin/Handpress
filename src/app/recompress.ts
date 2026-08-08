/**
 * Redrawing an image smaller, in the browser.
 *
 * The engine decides which images are worth shrinking and to what size; this is
 * the part that needs a canvas, so it lives here rather than in `src/pdf`.
 */

import type { Recompressor, StoredImage } from '../pdf/compress';

/**
 * Draws an image at a smaller size and hands it back as a JPEG.
 *
 * Returns null rather than throwing when an image cannot be decoded. A picture
 * this cannot read is one the document keeps exactly as it was, which is the
 * right outcome: making a file smaller is never worth breaking a page over.
 */
export const recompressInBrowser: Recompressor = async (image, targetWidth, targetHeight, quality) => {
  try {
    const source = await decode(image);
    if (!source) return null;

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // A white ground, because a JPEG has no transparency and an unpainted
    // canvas would come out black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, targetWidth, targetHeight);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, targetWidth, targetHeight);
    if (source instanceof ImageBitmap) source.close();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality),
    );
    if (!blob) return null;

    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      width: targetWidth,
      height: targetHeight,
    };
  } catch {
    return null;
  }
};

/** Turns a stored image into something drawable. */
async function decode(image: StoredImage): Promise<ImageBitmap | null> {
  if (image.filter === 'jpeg') {
    const blob = new Blob([image.bytes as BlobPart], { type: 'image/jpeg' });
    return createImageBitmap(blob);
  }

  // Raw samples, one byte per component. Building the ImageData by hand is the
  // only way in: the browser has no idea what a PDF colour space is.
  const pixels = new ImageData(image.width, image.height);
  const src = image.bytes;
  const out = pixels.data;
  const stride = image.components;

  for (let i = 0, p = 0; p < out.length; i += stride, p += 4) {
    if (stride === 1) {
      out[p] = out[p + 1] = out[p + 2] = src[i] ?? 0;
    } else {
      out[p] = src[i] ?? 0;
      out[p + 1] = src[i + 1] ?? 0;
      out[p + 2] = src[i + 2] ?? 0;
    }
    out[p + 3] = 255;
  }

  return createImageBitmap(pixels);
}
