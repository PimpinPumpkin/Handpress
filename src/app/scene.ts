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
 * background into the whole page, plus two small pictures per object: the
 * object on its own, and the page without that one object, cropped to its
 * box. From then on a drag is three drawImage calls: the page, the hole
 * patched over the dragged object's spot, and its picture on a layer under
 * the pointer. Nothing else is touched, so nothing else can be covered.
 *
 * The cost is one extra pass over the page, paid once, off the critical path.
 * That is the trade the whole thing rests on and it is the right way round:
 * it is paid where nobody is waiting and saved where everybody is.
 */

import * as pdfjs from 'pdfjs-dist';
import { PDFDocument, PDFName } from 'pdf-lib';
import { getPageContent } from '../pdf/page';
import { findGraphics, type Graphic } from '../pdf/graphics';
import { walkPage, type Matrix, type WalkResult } from '../pdf/content';
import { neutralAdvance } from '../pdf/writer';
import { Lexer, Tok } from '../pdf/lexer';

/** One object, drawn on its own, with where it belongs on the page. */
export interface Tile {
  id: string;
  canvas: HTMLCanvasElement;
  /**
   * The page without this one object, cropped to the same box.
   *
   * Lifting an object out is drawing this patch over its spot: it erases the
   * object and shows exactly what the page looks like behind it, text and
   * all, because it is a real render of the true content minus one thing.
   * The first design instead removed every object from one shared backdrop
   * and blitted the others back on top, and that order is a lie: a caption
   * the page draws over a band lives in the backdrop, so the band's tile
   * covered it and every drag made the text on every panel vanish.
   */
  hole: HTMLCanvasElement;
  /**
   * Everything the page draws after this object, on a transparent ground.
   *
   * Painted over the moving copy, so a drag stays in the object's own place
   * in the painting order: what covered it at rest keeps covering it while
   * it moves, instead of the copy popping over content it was naturally
   * behind. Rendered on demand by `Scene.primeOver` when the object is
   * grabbed, never eagerly: it is a full page of pixels per object, and a
   * report with sixteen objects on every page held eagerly was a quarter of
   * a gigabyte per page, which is what an out-of-memory crash looks like
   * from the outside. Null until primed, or when nothing later draws, and
   * then the copy rides on top, which for the brief unprimed moment is the
   * old behaviour rather than a wrong one.
   */
  over: HTMLCanvasElement | null;
  /** True while the over layer render is in flight, so it is asked for once. */
  overPending?: boolean;
  /**
   * Page-space box both pictures cover, which is the object's own box grown
   * by whatever its stroke hangs outside it. A path's bounds are its points,
   * and a stroked shape is drawn half a line width beyond them on every side:
   * cut to the points, an ellipse comes back with slivers shaved off its
   * widest parts, which is precisely where the stroke sticks out furthest.
   */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** The object's own box, which is what the selection knows it by. */
  hx0: number;
  hy0: number;
  hx1: number;
  hy1: number;
}

export interface Scene {
  /** The whole page, exactly as it draws, nothing removed. */
  backdrop: HTMLCanvasElement;
  tiles: Tile[];
  /** Page size the scene was built at, so a zoom change can be spotted. */
  width: number;
  height: number;
  /**
   * Renders the over layer for one tile, if it has one, keeping only the most
   * recent so a page full of objects costs one layer of pixels, not sixteen.
   * Called when an object is grabbed; the first few frames of the very first
   * drag may run without it, which shows the copy on top until it arrives.
   */
  primeOver(tile: Tile): void;
  /** Releases the rendered document the layers are drawn from. */
  destroy(): void;
}

const enc = new TextEncoder();
const fmt = (n: number): string => String(Math.round(n * 1000) / 1000);

/** Room for rounding, so a tile never loses its outermost pixel. */
const EDGE = 1;

/**
 * Sets a page's content without compressing it.
 *
 * The scene document exists for a few milliseconds between being saved and
 * being rendered, so deflating up to fifty copies of the page's content into
 * it buys nothing and costs a visible stall on a heavy page. Only what is
 * written to disk deserves compression, and none of this is.
 */
function setRawContent(doc: PDFDocument, page: ReturnType<PDFDocument['addPage']>, bytes: Uint8Array): void {
  const stream = doc.context.stream(bytes);
  const ref = doc.context.register(stream);
  page.node.set(PDFName.of('Contents'), ref);
}

/**
 * How far a stroke reaches outside the path it follows, in page space.
 *
 * The line width is in the space the object's own matrix maps from, so it has
 * to be carried through that matrix before it means anything on the page.
 */
function strokeReach(ctm: Matrix, lineWidth: number): number {
  const scale = Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])) || 1;
  return (Math.max(lineWidth, 1) * scale) / 2 + EDGE;
}

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

/**
 * The content with everything drawn before `cut` made invisible, state intact.
 *
 * This is what makes an over layer honest. The bytes after the cut cannot be
 * rendered alone, because they lean on state the earlier bytes set up: the
 * matrix, the colours, the font, the clip. So the earlier bytes stay, and only
 * their marks are taken away: paths, images and whole form invocations are
 * blanked outright, since none of them leaves state behind, and text becomes a
 * pure advance so the text matrix still ends up exactly where the skipped
 * operators would have left it.
 */
function overContent(
  bytes: Uint8Array,
  walk: WalkResult,
  inlineImages: Array<{ start: number; end: number }>,
  cut: number,
): Uint8Array {
  const patches: Array<{ start: number; end: number; bytes: Uint8Array }> = [];
  const blank = (start: number, end: number): void => {
    patches.push({ start, end, bytes: new Uint8Array(end - start).fill(0x20) });
  };
  for (const p of walk.paths) if (p.streamId === 'page' && p.start < cut) blank(p.start, p.end);
  for (const im of walk.images) if (im.streamId === 'page' && im.start < cut) blank(im.start, im.end);
  for (const f of walk.forms) if (f.streamId === 'page' && f.start < cut) blank(f.start, f.end);
  for (const ii of inlineImages) if (ii.start < cut) blank(ii.start, ii.end);
  for (const op of walk.ops) {
    if (op.streamId === 'page' && op.start < cut) {
      patches.push({ start: op.start, end: op.end, bytes: neutralAdvance(op) });
    }
  }

  patches.sort((a, b) => a.start - b.start);
  const keep: Uint8Array[] = [];
  let cursor = 0;
  for (const patch of patches) {
    if (patch.start < cursor) continue;
    keep.push(bytes.subarray(cursor, patch.start));
    keep.push(patch.bytes);
    cursor = patch.end;
  }
  keep.push(bytes.subarray(cursor));
  const total = keep.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const piece of keep) {
    out.set(piece, o);
    o += piece.length;
  }
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
 * Everything goes into a single document: the page itself, untouched, is the
 * backdrop, and each object appends two pages cropped to its box, the page
 * without it and the object alone. One document load and a page render each,
 * rather than a document load per object, which is the difference between a
 * second and a minute on a page with twenty marks on it.
 */
export async function buildScene(
  bytes: Uint8Array,
  pageIndex: number,
  scale: number,
  worker?: pdfjs.PDFWorker,
): Promise<Scene | null> {
  let task: ReturnType<typeof pdfjs.getDocument> | null = null;
  try {
    const src = await PDFDocument.load(bytes.slice(), {
      throwOnInvalidObject: false,
      updateMetadata: false,
    });
    if (pageIndex >= src.getPageCount()) return null;

    // Only the one page comes along. pdf-lib serialises every object in a
    // document's context whether anything references it or not, so building
    // the scene inside the loaded document meant every save carried the whole
    // file: on a twelve page report full of photographs that was seconds of
    // work per page, done again for every page scrolled past, which is what a
    // frozen tab looks like from the outside. Copying the page pulls over
    // exactly the objects it references and nothing else.
    const doc = await PDFDocument.create();
    const [page] = await doc.copyPages(src, [pageIndex]);
    doc.addPage(page);
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
      hx0: number;
      hy0: number;
      hx1: number;
      hy1: number;
    }> = [];

    for (const g of graphics) {
      if (g.streamId !== 'page' || g.state.clipComplex) continue;
      const pad = strokeReach(g.ctm, g.state.lineWidth);
      parts.push({
        id: g.id,
        bytes: tileContent(content.bytes, g.start, g.end, g.ctm, g.state),
        start: g.start,
        end: g.end,
        x0: g.x0 - pad,
        y0: g.y0 - pad,
        x1: g.x1 + pad,
        y1: g.y1 + pad,
        hx0: g.x0,
        hy0: g.y0,
        hx1: g.x1,
        hy1: g.y1,
      });
    }
    for (const im of images) {
      if (im.streamId !== 'page') continue;
      // An image is exactly its rectangle, with nothing hanging outside it, so
      // it needs only enough room not to lose a pixel to rounding.
      parts.push({
        id: `${im.streamId}:${im.index}`,
        bytes: tileContent(content.bytes, im.start, im.end, im.ctm, undefined),
        start: im.start,
        end: im.end,
        x0: im.x0 - EDGE,
        y0: im.y0 - EDGE,
        x1: im.x1 + EDGE,
        y1: im.y1 + EDGE,
        hx0: im.x0,
        hy0: im.y0,
        hx1: im.x1,
        hy1: im.y1,
      });
    }
    if (!parts.length) return null;

    // The crop and the blit have to agree about the box, so it is clamped to
    // the page here, once. A padded box reaching past the page edge gets its
    // crop intersected with the media box by the renderer, and a picture of
    // the intersection drawn into the full box arrives stretched.
    for (const part of parts) {
      part.x0 = Math.max(0, part.x0);
      part.y0 = Math.max(0, part.y0);
      part.x1 = Math.min(size.width, part.x1);
      part.y1 = Math.min(size.height, part.y1);
      if (part.x1 - part.x0 < 1) part.x1 = part.x0 + 1;
      if (part.y1 - part.y0 < 1) part.y1 = part.y0 + 1;
    }

    // The page itself is left exactly as it is: the backdrop is the whole
    // page, not the page with holes in it. The first design removed every
    // object and blitted them back over the top, and that is an ordering that
    // cannot be made right from outside: a caption the page draws over a band
    // lives in the flattened backdrop, so the band's picture covered it and
    // dragging anything made the text on every panel vanish.
    page.node.set(PDFName.of('Annots'), doc.context.obj([]));

    // What a moving object can slide under is anything drawn after it, and
    // the walker cannot see inside an inline image, so their ranges come from
    // the lexer once for the whole page.
    const inlineImages: Array<{ start: number; end: number }> = [];
    try {
      for (const t of Lexer.tokenize(content.bytes)) {
        if (t.kind === Tok.InlineImage) inlineImages.push({ start: t.start, end: t.end });
      }
    } catch {
      // A stream the lexer chokes on has already failed the walk above.
    }
    const laterDraws = (cut: number): boolean =>
      walk.paths.some((o) => o.streamId === 'page' && o.start >= cut) ||
      walk.images.some((o) => o.streamId === 'page' && o.start >= cut) ||
      walk.forms.some((o) => o.streamId === 'page' && o.start >= cut) ||
      walk.ops.some((o) => o.streamId === 'page' && o.start >= cut) ||
      inlineImages.some((o) => o.start >= cut);

    // Three pages per object, sharing the original's resources so nothing
    // they name has to be copied or can dangle: the page without that one
    // object, cropped to its box, which is what erases it during a drag; the
    // object on its own, which is what follows the pointer; and everything
    // drawn after it, full page on a transparent ground, which is what keeps
    // the moving copy in its own place in the painting order. The last is
    // skipped when nothing later draws, and its absence just means the copy
    // rides on top, which is then also the truth.
    const resources = page.node.Resources();
    const pageAt: Array<{ hole: number; tile: number; over: number | null }> = [];
    for (const part of parts) {
      const w = Math.max(1, part.x1 - part.x0);
      const h = Math.max(1, part.y1 - part.y0);
      const at = { hole: doc.getPageCount(), tile: doc.getPageCount() + 1, over: null as number | null };

      const hole = doc.addPage([size.width, size.height]);
      if (resources) hole.node.set(PDFName.of('Resources'), resources);
      setRawContent(doc, hole, withoutRanges(content.bytes, [part]));
      hole.setCropBox(part.x0, part.y0, w, h);

      const tile = doc.addPage([size.width, size.height]);
      if (resources) tile.node.set(PDFName.of('Resources'), resources);
      setRawContent(doc, tile, part.bytes);
      tile.setCropBox(part.x0, part.y0, w, h);

      if (laterDraws(part.end)) {
        at.over = doc.getPageCount();
        const over = doc.addPage([size.width, size.height]);
        if (resources) over.node.set(PDFName.of('Resources'), resources);
        setRawContent(doc, over, overContent(content.bytes, walk, inlineImages, part.end));
      }
      pageAt.push(at);
    }

    task = pdfjs.getDocument({ worker, data: await doc.save({ useObjectStreams: false }) });
    const rendered = await task.promise;

    // The object's own picture is rendered on a transparent background, so
    // the copy that follows the pointer is the object and not a white card
    // with the object on it. The page and the holes keep the renderer's
    // white: they stand in for paper, and paper is not transparent.
    const draw = async (index: number, clear = false): Promise<HTMLCanvasElement | null> => {
      const p = await rendered.getPage(index + 1);
      const viewport = p.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      const background = clear ? 'rgba(0,0,0,0)' : undefined;
      await p.render({ canvas, canvasContext: ctx, viewport, background } as never).promise;
      return canvas;
    };

    const backdrop = await draw(0);
    if (!backdrop) {
      await task.destroy().catch(() => undefined);
      return null;
    }

    const tiles: Tile[] = [];
    for (const [n, part] of parts.entries()) {
      const at = pageAt[n];
      const hole = await draw(at.hole);
      const canvas = await draw(at.tile, true);
      if (hole && canvas) {
        tiles.push({
          id: part.id,
          canvas,
          hole,
          // Not rendered here. An over layer is a full page of pixels per
          // object, and rendering all of them up front is what crashed the
          // tab on a real report. primeOver draws it when the object is
          // actually grabbed, and keeps only the most recent.
          over: null,
          x0: part.x0,
          y0: part.y0,
          x1: part.x1,
          y1: part.y1,
          hx0: part.hx0,
          hy0: part.hy0,
          hx1: part.hx1,
          hy1: part.hy1,
        });
      }
    }

    // Every object must have both its pictures. One missing and a drag either
    // cannot erase the object or cannot show it moving, which from outside is
    // an object flickering out of existence. Better no scene at all: the drag
    // then falls back to drawing the object itself.
    if (tiles.length !== parts.length) {
      await task.destroy().catch(() => undefined);
      return null;
    }

    // The rendered document stays alive so over layers can be drawn from it
    // on demand; destroy() is how the scene's owner lets it go.
    let holder: Tile | null = null;
    const primeOver = (tile: Tile): void => {
      const n = tiles.indexOf(tile);
      const at = n < 0 ? undefined : pageAt[n];
      if (at?.over == null || tile.over || tile.overPending) return;
      tile.overPending = true;
      void draw(at.over, true)
        .then((canvas) => {
          if (!canvas) return;
          // One layer at a time. Whoever held it last lets go, so a page
          // with sixteen objects costs one page of pixels, not sixteen.
          if (holder && holder !== tile) holder.over = null;
          tile.over = canvas;
          holder = tile;
        })
        .catch(() => undefined)
        .finally(() => {
          tile.overPending = false;
        });
    };
    const destroy = (): void => {
      void task?.destroy().catch(() => undefined);
    };

    return { backdrop, tiles, width: size.width, height: size.height, primeOver, destroy };
  } catch {
    // A page that will not come apart is one that drags the old way rather
    // than one that throws in the middle of a gesture.
    void task?.destroy().catch(() => undefined);
    return null;
  }
}
