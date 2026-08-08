/**
 * Optical character recognition for scanned pages.
 *
 * A scan is a picture of a document, so none of the editing, searching or
 * redaction in the rest of the app has anything to work with. Recognition adds
 * the missing layer: every word is written back over the image as invisible
 * text at the position it was found, which makes the page selectable,
 * searchable and editable while looking exactly as it did before.
 *
 * Tesseract is large, so it is imported only when somebody actually asks for
 * this, and its worker, wasm core and language data are fetched from a CDN on
 * first use rather than shipped. The page itself is never sent anywhere:
 * recognition runs in a worker on this machine.
 */

import type { TextInsertion } from '../pdf/writer';

export interface OcrWord {
  text: string;
  /** Baseline origin and size in PDF page coordinates, y measured upwards. */
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

export interface OcrResult {
  words: OcrWord[];
  /** Mean confidence across the page, 0 to 100. */
  confidence: number;
}

/** Recognition reads a bigger image than the screen shows; detail matters more than speed. */
export const OCR_SCALE = 2.5;

/** A recogniser held open across several pages. */
export interface Recogniser {
  /** Reads one already rendered page image and returns the words in page space. */
  recognise(canvas: HTMLCanvasElement, scale: number): Promise<OcrResult>;
  close(): Promise<void>;
}

/**
 * Starts the recogniser.
 *
 * Kept open deliberately: starting it means fetching and compiling several
 * megabytes of wasm, which is most of the cost of reading a single page and all
 * of the wasted cost of reading twenty. Reading a whole document reuses one.
 */
export async function openRecogniser(
  onProgress?: (fraction: number, label: string) => void,
): Promise<Recogniser> {
  onProgress?.(0.1, 'Loading the recogniser');
  const { createWorker } = await import('tesseract.js');

  let report = onProgress;
  const worker = await createWorker('eng', 1, {
    logger: (m: { status?: string; progress?: number }) => {
      // The first run downloads a few megabytes of recogniser and language
      // data, which is long enough that saying nothing reads as a hang.
      if (m.status === 'recognizing text') {
        report?.(0.25 + (m.progress ?? 0) * 0.7, 'Reading the page');
      } else if (m.status?.startsWith('loading') || m.status?.startsWith('downloading')) {
        report?.(0.1 + (m.progress ?? 0) * 0.15, 'Fetching the recogniser');
      } else if (m.status) {
        report?.(0.25, 'Starting the recogniser');
      }
    },
  });

  return {
    async recognise(canvas: HTMLCanvasElement, scale: number): Promise<OcrResult> {
      const { data } = await worker.recognize(canvas, {}, { blocks: true });
      return collectWords(data, canvas, scale);
    },
    async close(): Promise<void> {
      report = undefined;
      await worker.terminate();
    },
  };
}

/**
 * Turns what tesseract reported into words positioned in page space.
 *
 * Tesseract measures in image pixels with y downwards, so every box is scaled
 * back to points and flipped. The tree it returns is walked rather than indexed
 * because the shape of it depends on which recognition mode ran.
 */
function collectWords(data: unknown, canvas: HTMLCanvasElement, scale: number): OcrResult {
  const words: OcrWord[] = [];
  const toPage = (v: number): number => v / scale;
  const pageHeight = canvas.height / scale;

  type Box = { x0: number; y0: number; x1: number; y1: number };
  type Word = { text: string; confidence: number; bbox: Box };
  const collect = (node: unknown): void => {
    const n = node as { words?: Word[]; [k: string]: unknown };
    if (Array.isArray(n?.words)) {
      for (const w of n.words) {
        const text = (w.text ?? '').trim();
        if (!text || !w.bbox) continue;
        const height = toPage(w.bbox.y1 - w.bbox.y0);
        if (height <= 0) continue;
        words.push({
          text,
          x: toPage(w.bbox.x0),
          // The baseline sits a little above the box bottom for most type.
          y: pageHeight - toPage(w.bbox.y1) + height * 0.18,
          width: toPage(w.bbox.x1 - w.bbox.x0),
          height,
          confidence: w.confidence ?? 0,
        });
      }
    }
    for (const key of ['blocks', 'paragraphs', 'lines']) {
      const kids = n?.[key];
      if (Array.isArray(kids)) for (const kid of kids) collect(kid);
    }
  };
  collect(data);

  const confidence = words.length
    ? words.reduce((a, w) => a + w.confidence, 0) / words.length
    : 0;
  return { words, confidence };
}

/**
 * Turns recognised words into invisible text insertions.
 *
 * Each word is stretched horizontally to the width it occupies in the image, so
 * a selection drawn over the picture lines up with the words underneath rather
 * than drifting further out of step along the line.
 */
export function wordsToInsertions(
  words: OcrWord[],
  measure: (text: string, size: number) => number,
  minConfidence = 40,
): Array<Omit<TextInsertion, 'id'>> {
  const out: Array<Omit<TextInsertion, 'id'>> = [];

  for (const word of words) {
    if (word.confidence < minConfidence) continue;
    // Cap height so an odd tall box does not produce absurd type.
    const size = Math.max(4, Math.min(word.height * 0.95, 72));
    const natural = measure(word.text, size);
    const horizScale = natural > 0 ? Math.max(20, Math.min(400, (word.width / natural) * 100)) : 100;

    out.push({
      x: word.x,
      y: word.y,
      size,
      color: { r: 0, g: 0, b: 0 },
      text: word.text,
      bold: false,
      italic: false,
      invisible: true,
      horizScale,
    });
  }
  return out;
}
