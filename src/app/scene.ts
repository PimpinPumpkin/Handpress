/**
 * The page taken apart into a backdrop and the objects that sit on it.
 *
 * Every previous attempt at dragging did its work when the drag began, and no
 * amount of care makes that instant: a render is a render, whether it is a
 * rectangle of copied pixels or the object drawn properly. Acrobat does not do
 * that. It holds the page as objects and recomposites, so moving one is a few
 * draw calls rather than any rendering at all.
 *
 * This does the same. Once a page has been rendered, it is taken apart in the
 * background into the page with its movable objects removed, plus one small
 * picture per object. From then on a drag is backdrop plus tiles, with the one
 * being dragged drawn at an offset, which is a handful of drawImage calls.
 *
 * The cost is one extra pass over the page, paid once, off the critical path.
 * That is the trade the whole thing rests on and it is the right way round:
 * it is paid where nobody is waiting and saved where everybody is.
 */

import * as pdfjs from 'pdfjs-dist';
import { PDFDocument, PDFName } from 'pdf-lib';
import { getPageContent, setPageContent } from '../pdf/page';
import { findGraphics, type Graphic } from '../pdf/graphics';
import { walkPage, type Matrix } from '../pdf/content';

/** One object, drawn on its own, with where it belongs on the page. */
export interface Tile {
  id: string;
  canvas: HTMLCanvasElement;
  /** Page-space box the picture covers. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Scene {
  /** The page with every tile's object removed from it. */
  backdrop: HTMLCanvasElement;
  tiles: Tile[];
  /** Page size the scene was built at, so a zoom change can be spotted. */
  width: number;
  height: number;
}

const enc = new TextEncoder();
const fmt = (n: number): string => String(Math.round(n * 1000) / 1000);

/** Draws the object at a matrix, with the state and clip the page gave it. */
function tileContent(
  bytes: Uint8Array,
  start: number,
  end: number,
  ctm: Matrix,
  state?: Graphic['state'],
): Uint8Array {
  const parts: string[] = ['q'];
  // The clip is kept, so a tile looks exactly as the page draws it. Without it
  // a logo cut to its own shape would show its uncut self the moment the page
  // was composited rather than rendered, which is a difference nobody asked
  // for appearing at rest.
  const clip = state?.clip;
  if (clip && !state?.clipComplex) {
    parts.push(`${fmt(clip.x0)} ${fmt(clip.y0)} ${fmt(clip.x1 - clip.x0)} ${fmt(clip.y1 - clip.y0)} re W n`);
  }
  parts.push(`${fmt(ctm[0])} ${fmt(ctm[1])} ${fmt(ctm[2])} ${fmt(ctm[3])} ${fmt(ctm[4])} ${fmt(ctm[5])} cm`);
  if (state) {
    if (state.extGState) parts.push(`/${state.extGState} gs`);
    parts.push(`${fmt(state.fill.r)} ${fmt(state.fill.g)} ${fmt(state.fill.b)} rg`);
    parts.push(`${fmt(state.stroke.r)} ${fmt(state.stroke.g)} ${fmt(state.stroke.b)} RG`);
    parts.push(`${fmt(state.lineWidth)} w`);
    if (state.dash) parts.push(`${state.dash} d`);
  }

  const head = enc.encode(`${parts.join('\n')}\n`);
  const body = bytes.subarray(start, end);
  const tail = enc.encode('\nQ\n');
  const out = new Uint8Array(head.length + body.length + tail.length);
  out.set(head, 0);
  out.set(body, head.length);
  out.set(tail, head.length + body.length);
  return out;
}

/** The page content with the given byte ranges taken out of it. */
function withoutRanges(bytes: Uint8Array, ranges: Array<{ start: number; end: number }>): Uint8Array {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const keep: Uint8Array[] = [];
  let cursor = 0;
  for (const r of sorted) {
    if (r.start < cursor) continue;
    keep.push(bytes.subarray(cursor, r.start));
    cursor = r.end;
  }
  keep.push(bytes.subarray(cursor));
  const total = keep.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const part of keep) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

/**
 * Takes a page apart, in one pass.
 *
 * Everything goes into a single document: the backdrop stays on the page it
 * came from and each object is appended as a page of its own, cropped to the
 * object. One document load and a page render each, rather than a document
 * load per object, which is the difference between a second and a minute on a
 * page with twenty marks on it.
 */
export async function buildScene(
  bytes: Uint8Array,
  pageIndex: number,
  scale: number,
  worker?: pdfjs.PDFWorker,
): Promise<Scene | null> {
  try {
    const doc = await PDFDocument.load(bytes.slice(), {
      throwOnInvalidObject: false,
      updateMetadata: false,
    });
    if (pageIndex >= doc.getPageCount()) return null;
    const page = doc.getPage(pageIndex);
    const content = getPageContent(page);
    const size = page.getSize();

    // Found in the bytes being rendered rather than handed in from the model.
    // The model's geometry is the original document's, with edits accounted
    // for separately, so a tile cut to those bounds is cut to where an object
    // used to be: it drifts further every time the object is moved, and
    // anything added since is missing from the backdrop and vanishes for as
    // long as a drag lasts. The page has to describe itself.
    const walk = walkPage(content.bytes, content.resources);
    const graphics = findGraphics(walk, size.width, size.height);
    const images = walk.images;

    // Only what can be lifted cleanly. Anything else stays in the backdrop and
    // simply is not draggable with a preview, which is better than a tile that
    // does not match what the page draws.
    const parts: Array<{
      id: string;
      bytes: Uint8Array;
      start: number;
      end: number;
      x0: number;
      y0: number;
      x1: number;
      y1: number;
    }> = [];

    for (const g of graphics) {
      if (g.streamId !== 'page' || g.state.clipComplex) continue;
      parts.push({
        id: g.id,
        bytes: tileContent(content.bytes, g.start, g.end, g.ctm, g.state),
        start: g.start,
        end: g.end,
        x0: g.x0,
        y0: g.y0,
        x1: g.x1,
        y1: g.y1,
      });
    }
    for (const im of images) {
      if (im.streamId !== 'page') continue;
      parts.push({
        id: `${im.streamId}:${im.index}`,
        bytes: tileContent(content.bytes, im.start, im.end, im.ctm, undefined),
        start: im.start,
        end: im.end,
        x0: im.x0,
        y0: im.y0,
        x1: im.x1,
        y1: im.y1,
      });
    }
    if (!parts.length) return null;

    setPageContent(doc, page, withoutRanges(content.bytes, parts));
    page.node.set(PDFName.of('Annots'), doc.context.obj([]));

    // Each object as a page of its own, sharing the original's resources so
    // nothing it names has to be copied or can dangle.
    const resources = page.node.Resources();
    const firstTile = doc.getPageCount();
    for (const part of parts) {
      const tile = doc.addPage([size.width, size.height]);
      if (resources) tile.node.set(PDFName.of('Resources'), resources);
      setPageContent(doc, tile, part.bytes);
      const w = Math.max(1, part.x1 - part.x0);
      const h = Math.max(1, part.y1 - part.y0);
      tile.setCropBox(part.x0, part.y0, w, h);
    }

    const task = pdfjs.getDocument({ worker, data: await doc.save({ useObjectStreams: false }) });
    const rendered = await task.promise;

    const draw = async (index: number): Promise<HTMLCanvasElement | null> => {
      const p = await rendered.getPage(index + 1);
      const viewport = p.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      await p.render({ canvas, canvasContext: ctx, viewport } as never).promise;
      return canvas;
    };

    const backdrop = await draw(pageIndex);
    if (!backdrop) {
      await task.destroy().catch(() => undefined);
      return null;
    }

    const tiles: Tile[] = [];
    for (const [n, part] of parts.entries()) {
      const canvas = await draw(firstTile + n);
      if (canvas) tiles.push({ id: part.id, canvas, x0: part.x0, y0: part.y0, x1: part.x1, y1: part.y1 });
    }
    await task.destroy().catch(() => undefined);

    // Every object taken out of the backdrop must have a picture to put back.
    // One missing and that object is simply gone for as long as a drag lasts,
    // reappearing when the page is rendered again, which is exactly what a
    // half built scene looks like from the outside. Better no scene at all:
    // the drag then falls back to drawing the object itself.
    if (tiles.length !== parts.length) return null;

    return { backdrop, tiles, width: size.width, height: size.height };
  } catch {
    // A page that will not come apart is one that drags the old way rather
    // than one that throws in the middle of a gesture.
    return null;
  }
}
