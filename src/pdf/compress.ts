/**
 * Making a PDF smaller.
 *
 * Almost all of the weight in a large PDF is images stored at far more detail
 * than the page ever shows: a phone photograph dropped into a report, or a scan
 * made at 600 dots per inch and printed two inches wide. Nothing else in a
 * typical file comes close, so that is what this touches. The object graph is
 * already packed by the save, and fonts are usually subset by whoever made the
 * document.
 *
 * How much detail an image needs is decided by the size it is actually drawn
 * at, not by the size it was stored at. That is the whole trick: an image drawn
 * two inches wide needs 300 pixels for a good print and nothing more, however
 * many it arrived with.
 *
 * Decoding pictures needs a canvas, which this file must not have, so the
 * caller passes in something that can redraw one. That keeps the engine free of
 * the DOM and lets the whole thing be tested under Node.
 */

import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream } from 'pdf-lib';
import { walkPage } from './content';
import { getPageContent } from './page';

export interface CompressOptions {
  /** Detail to keep, in dots per inch of the size the image is drawn at. */
  targetDpi: number;
  /** JPEG quality, 0 to 1. */
  quality: number;
}

export const DEFAULT_COMPRESSION: CompressOptions = { targetDpi: 150, quality: 0.72 };

/** An image as it is stored, handed to the caller to redraw. */
export interface StoredImage {
  bytes: Uint8Array;
  width: number;
  height: number;
  /** The stream's filter, which says how `bytes` are encoded. */
  filter: 'jpeg' | 'raw';
  /** Components per sample for a raw image: 1 is grey, 3 is colour. */
  components: number;
}

/** Redraws an image smaller and returns it as a JPEG. */
export type Recompressor = (
  image: StoredImage,
  targetWidth: number,
  targetHeight: number,
  quality: number,
) => Promise<{ bytes: Uint8Array; width: number; height: number } | null>;

export interface CompressReport {
  before: number;
  after: number;
  /** Images redrawn smaller. */
  shrunk: number;
  /** Images left alone, either already small enough or not safely convertible. */
  kept: number;
}

/**
 * Rewrites a document with its oversized images redrawn at the size they are
 * shown.
 *
 * An image that carries transparency is left alone: JPEG has no alpha channel,
 * so redrawing it would silently fill the see-through parts with black. So is
 * anything whose colour is not plain grey or RGB, since guessing at a separation
 * or indexed palette would change how the page looks.
 */
export async function compress(
  bytes: Uint8Array,
  recompress: Recompressor,
  options: CompressOptions = DEFAULT_COMPRESSION,
): Promise<{ bytes: Uint8Array; report: CompressReport }> {
  const doc = await PDFDocument.load(bytes, { throwOnInvalidObject: false, updateMetadata: false });
  const drawnWidths = measureDrawnWidths(doc);

  let shrunk = 0;
  let kept = 0;
  const seen = new Set<string>();

  for (const page of doc.getPages()) {
    const resources = page.node.Resources();
    const xobjects = resources?.lookup(PDFName.of('XObject'));
    if (!(xobjects instanceof PDFDict)) continue;

    for (const [name, value] of xobjects.entries()) {
      const ref = value instanceof PDFRef ? value : null;
      const key = ref ? `${ref.objectNumber} ${ref.generationNumber}` : `inline:${name.asString()}`;
      // One image can be placed on many pages; it only needs redrawing once.
      if (seen.has(key)) continue;
      seen.add(key);

      const stream = xobjects.lookup(name);
      if (!(stream instanceof PDFRawStream)) continue;

      const stored = readImage(stream);
      if (!stored) {
        kept++;
        continue;
      }

      // The lexer records the name without its slash; a PDFName keeps it.
      const drawn = drawnWidths.get(name.asString().replace(/^\//, '')) ?? 0;
      const target = targetPixels(stored, drawn, options.targetDpi);
      if (!target) {
        kept++;
        continue;
      }

      const smaller = await recompress(stored, target.width, target.height, options.quality);
      // A redraw that came back no smaller is not worth the loss of quality.
      if (!smaller || smaller.bytes.length >= stored.bytes.length) {
        kept++;
        continue;
      }

      replaceWithJpeg(stream, smaller);
      shrunk++;
    }
  }

  const out = await doc.save({ useObjectStreams: true });
  return { bytes: out, report: { before: bytes.length, after: out.length, shrunk, kept } };
}

/**
 * The widest any image is drawn, in points, keyed by its resource name.
 *
 * An image XObject is always painted into the unit square, so the transformation
 * matrix in effect is its size on the page.
 */
function measureDrawnWidths(doc: PDFDocument): Map<string, number> {
  const widths = new Map<string, number>();

  for (const page of doc.getPages()) {
    try {
      const content = getPageContent(page);
      const walk = walkPage(content.bytes, content.resources);
      for (const image of walk.images) {
        const width = Math.abs(image.x1 - image.x0);
        widths.set(image.name, Math.max(widths.get(image.name) ?? 0, width));
      }
    } catch {
      // A page that will not walk simply contributes no measurements, and its
      // images are then left at the size they arrived.
    }
  }
  return widths;
}

/** Reads an image stream into something the caller can redraw, or null to skip it. */
function readImage(stream: PDFRawStream): StoredImage | null {
  const dict = stream.dict;
  if (dict.lookup(PDFName.of('Subtype')) !== PDFName.of('Image')) return null;

  // Transparency cannot survive a JPEG, which has no alpha channel at all.
  if (dict.has(PDFName.of('SMask')) || dict.has(PDFName.of('Mask'))) return null;

  const width = numberOf(dict, 'Width');
  const height = numberOf(dict, 'Height');
  const bits = numberOf(dict, 'BitsPerComponent');
  if (!width || !height || bits !== 8) return null;

  const colourSpace = dict.lookup(PDFName.of('ColorSpace'));
  const components =
    colourSpace === PDFName.of('DeviceRGB') ? 3 : colourSpace === PDFName.of('DeviceGray') ? 1 : 0;

  const filter = dict.lookup(PDFName.of('Filter'));
  const filterName = filter instanceof PDFName ? filter.asString() : null;

  if (filterName === '/DCTDecode') {
    // Already a JPEG; the bytes are the file.
    return { bytes: stream.getContents(), width, height, filter: 'jpeg', components: components || 3 };
  }

  if (filterName === '/FlateDecode' && components) {
    try {
      return { bytes: decodePDFRawStream(stream).decode(), width, height, filter: 'raw', components };
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * How many pixels the image should keep, or null to leave it alone.
 *
 * An image that is already at or below the detail its size on the page calls
 * for is left exactly as it is: redrawing it could only make it worse.
 */
function targetPixels(
  image: StoredImage,
  drawnWidthPoints: number,
  targetDpi: number,
): { width: number; height: number } | null {
  if (drawnWidthPoints <= 0) return null;

  const wanted = Math.round((drawnWidthPoints / 72) * targetDpi);
  // A tenth of headroom, so an image that is merely a little over is not
  // rewritten for nothing.
  if (wanted <= 0 || image.width <= wanted * 1.1) return null;

  const scale = wanted / image.width;
  return { width: wanted, height: Math.max(1, Math.round(image.height * scale)) };
}

function replaceWithJpeg(
  stream: PDFRawStream,
  smaller: { bytes: Uint8Array; width: number; height: number },
): void {
  const dict = stream.dict;
  dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
  dict.set(PDFName.of('Width'), PDFNumber.of(smaller.width));
  dict.set(PDFName.of('Height'), PDFNumber.of(smaller.height));
  dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
  dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
  dict.delete(PDFName.of('DecodeParms'));
  dict.delete(PDFName.of('Decode'));
  (stream as unknown as { contents: Uint8Array }).contents = smaller.bytes;
  dict.set(PDFName.of('Length'), PDFNumber.of(smaller.bytes.length));
}

function numberOf(dict: PDFDict, key: string): number {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof PDFNumber ? value.asNumber() : 0;
}
