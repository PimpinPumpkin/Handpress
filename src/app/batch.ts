/**
 * The same recipe over a pile of files.
 *
 * Acrobat calls this an Action, and it runs over a folder on a server or a
 * disk. There is no server here and no folder, so it is a set of files dropped
 * in at once and a zip handed back. That is the whole difference.
 *
 * Only steps that need no decision per document belong in a recipe. Anything
 * that has to be aimed at a particular page or a particular sentence is not a
 * batch operation, it is an edit, and pretending otherwise produces a feature
 * that appears to work and quietly does the wrong thing to file forty.
 */

import { HandpressDocument } from './model';
import { compress } from '../pdf/compress';
import { recompressInBrowser } from './recompress';
import { encrypt } from '../pdf/encrypt';
import { openRecogniser, wordsToInsertions, OCR_SCALE, type Recogniser } from './ocr';
import { standardTextWidth } from '../pdf/fonts';
import { zip, type ZipEntry } from '../pdf/zip';

export interface BatchRecipe {
  /** Read every page that is a picture rather than text. */
  recognise?: { language: string };
  /** The same text on every page: a watermark, a header, a footer, numbering. */
  stamp?: Parameters<HandpressDocument['stampEveryPage']>[0];
  /** A quarter turn, applied to every page. */
  rotate?: number;
  /** Squeeze the images down. */
  compress?: boolean;
  /** Lock the result. Applied last, since it rewrites the whole file. */
  password?: string;
}

export interface BatchResult {
  /** The zip, ready to be handed to the user. */
  bytes: Uint8Array;
  done: number;
  /** Files that failed, with the reason, so nothing is lost in silence. */
  failed: Array<{ name: string; detail: string }>;
  /** Where a sequential numbering run finished, for the record. */
  lastNumber: number;
}

export interface BatchProgress {
  (message: string, fraction: number): void;
}

/**
 * Runs the recipe over every file and packs the results into one zip.
 *
 * A file that fails is reported and the rest carry on. Forty scans is exactly
 * the situation where one damaged file should not cost the other thirty-nine,
 * and the failures are handed back rather than logged.
 */
export async function runBatch(
  files: Array<{ name: string; bytes: Uint8Array }>,
  recipe: BatchRecipe,
  onProgress: BatchProgress = () => {},
): Promise<BatchResult> {
  const entries: ZipEntry[] = [];
  const failed: BatchResult['failed'] = [];
  let next = recipe.stamp?.number?.next ?? 1;

  // Opened once for the whole run rather than per file. Starting the
  // recogniser means loading its wasm core and a language, which is tens of
  // megabytes and several seconds: doing that forty times is the difference
  // between a batch that finishes and one nobody waits for.
  let recogniser: Recogniser | null = null;
  try {
    if (recipe.recognise) {
      recogniser = await openRecogniser(recipe.recognise.language, (fraction, label) => {
        onProgress(`${label}…`, fraction * 0.15);
      });
    }

    for (const [n, file] of files.entries()) {
      const base = 0.15 + (n / Math.max(1, files.length)) * 0.85;
      const step = 0.85 / Math.max(1, files.length);
      onProgress(`${file.name}, ${n + 1} of ${files.length}`, base);

      let doc: HandpressDocument | null = null;
      try {
        const opened = await HandpressDocument.open(file.name, file.bytes.slice());
        doc = opened.doc;

        if (recogniser) {
          const targets = await doc.pagesNeedingRecognition().catch(() => []);
          for (const [k, pageIndex] of targets.entries()) {
            onProgress(
              `${file.name}: reading page ${pageIndex + 1}`,
              base + (step * (k + 1)) / (targets.length + 2),
            );
            await recognisePage(doc, pageIndex, recogniser);
          }
        }

        if (recipe.rotate) {
          for (let i = 0; i < doc.pageCount; i++) doc.rotatePage(i, recipe.rotate);
        }
        if (recipe.stamp) {
          // The sequence runs on into the next file. A Bates number that
          // restarted per document would be worse than useless: the number is
          // how a page gets cited, so it has to be unique across the set.
          await doc.stampEveryPage(
            recipe.stamp.number ? { ...recipe.stamp, number: { ...recipe.stamp.number, next } } : recipe.stamp,
          );
          if (recipe.stamp.number) next = doc.lastNumber;
        }

        let bytes = (await doc.build()).bytes;
        if (recipe.compress) bytes = (await compress(bytes, recompressInBrowser)).bytes;
        if (recipe.password) {
          bytes = await encrypt(bytes, { userPassword: recipe.password, ownerPassword: recipe.password });
        }

        entries.push({ name: outputName(file.name), bytes });
      } catch (e) {
        failed.push({ name: file.name, detail: (e as Error).message });
      } finally {
        // Each document holds a pdf.js worker; forty left open is forty
        // threads and the memory to go with them.
        doc?.close();
      }
    }
  } finally {
    await recogniser?.close().catch(() => undefined);
  }

  onProgress('Packing them up…', 0.99);
  return { bytes: zip(entries), done: entries.length, failed, lastNumber: next };
}

/** Reads one page and writes what it finds back as invisible text. */
async function recognisePage(doc: HandpressDocument, pageIndex: number, recogniser: Recogniser): Promise<void> {
  const canvas = await rasterise(doc, pageIndex, OCR_SCALE);
  if (!canvas) return;
  const result = await recogniser.recognise(canvas, OCR_SCALE);
  if (!result.words.length) return;
  // Measured with Helvetica's own metrics, not the browser's idea of them, so
  // a scan read on one machine puts its words where another machine does.
  for (const insertion of wordsToInsertions(result.words, (t, size) => standardTextWidth('Helvetica', t, size))) {
    doc.addInsertion(pageIndex, insertion);
  }
}

/**
 * Draws a page offscreen.
 *
 * The viewer has its own rasteriser, but it draws into the canvas the user is
 * looking at and queues behind that page's other renders. A batch has no
 * canvas and no viewer, so it does its own, which is also what keeps forty
 * documents from queueing behind one another.
 */
async function rasterise(
  doc: HandpressDocument,
  pageIndex: number,
  scale: number,
): Promise<HTMLCanvasElement | null> {
  if (!doc.pdfjs) return null;
  const page = await doc.pdfjs.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  await page.render({ canvas, canvasContext: ctx, viewport } as never).promise;
  return canvas;
}

/** What each result is called inside the zip. */
function outputName(name: string): string {
  const base = name.replace(/\.pdf$/i, '');
  return `${base}.pdf`;
}
