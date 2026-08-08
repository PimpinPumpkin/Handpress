/**
 * Page rendering and text editing surface.
 *
 * Each page is a canvas painted by pdf.js with an absolutely positioned overlay
 * of editable line boxes derived from the content-stream walker. Clicking a line
 * opens an inline editor styled with the document's own embedded font.
 *
 * Committing re-renders the page from the actual edited PDF rather than
 * approximating the result, so the canvas always shows exactly what a save
 * produces.
 */

import type { PageModel, HandpressDocument } from './model';
import { charPosition } from '../pdf/content';
import { measure } from '../pdf/paragraphs';
import { standardTextWidth } from '../pdf/fonts';
import type { TextLine } from '../pdf/content';
import type { TextInsertion } from '../pdf/writer';
import { NOTE_SIZE, type PageNote } from '../pdf/notes';
import type { ImageOp } from '../pdf/content';
import type { RectFill } from '../pdf/writer';

import type { SearchMatch } from './model';
import type { CapturedSignature } from './signature';
import type { FormField } from '../pdf/forms';

export type ViewerMode =
  | 'edit'
  | 'select'
  | 'add'
  | 'sign'
  | 'note'
  | 'erase'
  | 'redact'
  | 'highlight'
  | 'pen'
  | 'inkErase'
  | 'line'
  | 'arrow'
  | 'rect'
  | 'ellipse';

export interface ViewerCallbacks {
  onSelect(line: TextLine | null, page: PageModel | null): void;
  onEdited(): void;
  onStatus(message: string, tone?: 'info' | 'warn'): void;
  /** The user zoomed by gesture rather than by the toolbar. */
  onZoomedByHand?(zoom: number): void;
}

interface RenderedPage {
  index: number;
  container: HTMLElement;
  canvas: HTMLCanvasElement;
  overlay: HTMLElement;
  model: PageModel | null;
  renderedZoom: number;
  /**
   * In-flight render for this page.
   *
   * A page can be asked to render from several places at once, notably the
   * initial load and the visibility observer firing for the same page. Two
   * concurrent renders share one canvas context, and their save and restore
   * pairs interleave, which leaves a stray transform behind and draws the page
   * upside down. Every draw of this page therefore joins one chain, which is
   * strictly serial and cannot be lost the way a nullable in-flight promise can.
   * The chain is per page: one queue for the whole document deadlocks, because a
   * render can wait on work that is itself sitting behind it in the queue.
   */
  queue: Promise<void>;
  /**
   * Invisible, selectable copy of the page's text, laid over the canvas.
   *
   * A canvas has no text in it, so without this the page cannot be selected or
   * copied out, which is the first thing anyone tries. The spans carry the real
   * words at the real positions, so the browser does the selecting, the copying
   * and the reading aloud, and all of it agrees with what is drawn.
   */
  textLayer: HTMLDivElement;
  /**
   * Viewport of this page's last render, kept so highlights can be repainted
   * without rendering again. Pages differ in size and rotation, so this cannot
   * be shared between them.
   */
  viewport: {
    convertToViewportPoint(x: number, y: number): number[];
    convertToPdfPoint(x: number, y: number): number[];
  } | null;
}

const measureCanvas = document.createElement('canvas');
const measureCtx = measureCanvas.getContext('2d')!;

/** Baseline offset from the top of a line box, derived from real font metrics. */
function baselineOffset(cssFont: string, lineHeight: number): number {
  measureCtx.font = cssFont;
  const m = measureCtx.measureText('Hxy');
  const ascent = m.fontBoundingBoxAscent || m.actualBoundingBoxAscent || 0;
  const descent = m.fontBoundingBoxDescent || m.actualBoundingBoxDescent || 0;
  if (!ascent) return lineHeight * 0.8;
  // Half-leading is split evenly above and below the text box.
  return (lineHeight - (ascent + descent)) / 2 + ascent;
}

/**
 * Estimates the page colour immediately around a region.
 *
 * Samples a ring on all four sides rather than only above and below. A patch
 * inside a tinted panel has white paper above and below it but panel colour to
 * left and right, and picking white there leaves an obvious scar. The most
 * common colour around the whole perimeter is the one that blends.
 */
function sampleBackground(canvas: HTMLCanvasElement, rect: DOMRect, dpr: number): string {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return '#ffffff';

  const counts = new Map<string, number>();
  const gap = 3;
  const points: Array<[number, number]> = [];

  // Along the top and bottom edges.
  for (let i = 0; i <= 6; i++) {
    const x = rect.left + (rect.width * i) / 6;
    points.push([x, rect.top - gap], [x, rect.bottom + gap]);
  }
  // Along the left and right edges, which is what a panel background needs.
  for (let i = 0; i <= 6; i++) {
    const y = rect.top + (rect.height * i) / 6;
    points.push([rect.left - gap, y], [rect.right + gap, y]);
  }

  for (const [x, y] of points) {
    const px = Math.round(x * dpr);
    const py = Math.round(y * dpr);
    if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue;
    try {
      const d = ctx.getImageData(px, py, 1, 1).data;
      counts.set(`${d[0]},${d[1]},${d[2]}`, (counts.get(`${d[0]},${d[1]},${d[2]}`) ?? 0) + 1);
    } catch {
      return '#ffffff';
    }
  }

  let best = '255,255,255';
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return `rgb(${best})`;
}

/**
 * The points of a shape drawn between two corners.
 *
 * Every shape is a list of points, which means the pen's own path builder
 * draws all of them and nothing new has to know how to put ink on a page. An
 * arrow retraces its tip on the way to the second barb; a stroke drawn over
 * itself is invisible, and it saves carrying a second subpath around.
 */
function shapePoints(
  kind: 'line' | 'arrow' | 'rect' | 'ellipse',
  a: { x: number; y: number },
  b: { x: number; y: number },
  width: number,
): { points: Array<{ x: number; y: number }>; closed: boolean } {
  if (kind === 'rect') {
    return {
      points: [
        { x: a.x, y: a.y },
        { x: b.x, y: a.y },
        { x: b.x, y: b.y },
        { x: a.x, y: b.y },
      ],
      closed: true,
    };
  }

  if (kind === 'ellipse') {
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const rx = Math.abs(b.x - a.x) / 2;
    const ry = Math.abs(b.y - a.y) / 2;
    const steps = 48;
    return {
      points: Array.from({ length: steps }, (_, i) => {
        const t = (i / steps) * Math.PI * 2;
        return { x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry };
      }),
      closed: true,
    };
  }

  if (kind === 'line') return { points: [a, b], closed: false };

  // An arrowhead sized from the line weight, so a thick arrow keeps its
  // proportions instead of growing a pinhead.
  const head = Math.max(6, width * 3.5);
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const spread = Math.PI / 7;
  const barb = (turn: number): { x: number; y: number } => ({
    x: b.x - Math.cos(angle + turn) * head,
    y: b.y - Math.sin(angle + turn) * head,
  });
  return { points: [a, b, barb(spread), b, barb(-spread)], closed: false };
}

export class Viewer {
  readonly root: HTMLElement;
  private doc: HandpressDocument | null = null;
  private pages: RenderedPage[] = [];
  private zoom = 1;
  private cb: ViewerCallbacks;
  private activeEditor: HTMLElement | null = null;
  private activeLine: TextLine | null = null;
  private activePage: RenderedPage | null = null;
  private selectedLineId: string | null = null;
  private renderToken = 0;
  /** The column of pages, kept so a pinch can scale it without re-rendering. */
  private strip: HTMLElement | null = null;
  private observer: IntersectionObserver | null = null;
  private mode: ViewerMode = 'edit';
  /** Name attached to new notes. Empty until the user gives one. */
  noteAuthor = '';
  /** Copies of moved objects, shown until the page has really been redrawn. */
  private lifted: HTMLElement[] = [];
  private liftTimer = 0;

  /** Insertion being edited, when the active editor belongs to added text. */
  private activeInsertion: TextInsertion | null = null;
  /** Defaults applied to newly added text. */
  addSize = 12;
  addColor = { r: 0, g: 0, b: 0 };
  /** Ink settings for the pen and the shapes. */
  penColor = { r: 0.88, g: 0.13, b: 0.13 };
  penWidth = 2.5;
  penOpacity = 1;

  /** Colour used by the highlighter, a marker-pen yellow by default. */
  highlightColor = { r: 1, g: 0.92, b: 0.23 };
  /** Signature waiting to be placed, and the width it is placed at, in points. */
  pendingSignature: CapturedSignature | null = null;
  signatureWidth = 150;
  /** Shared canvas used only for text measurement, never drawn. */
  private static measureCtx: CanvasRenderingContext2D =
    document.createElement('canvas').getContext('2d')!;

  private matches: SearchMatch[] = [];
  private currentMatch = -1;
  /**
   * Serialises rebuilds.
   *
   * Rebuilding replaces the pdf.js document, which cancels any render still
   * running against the old one and leaves that canvas half drawn. Overlapping
   * rebuilds also cancel each other, so a burst of quick edits could settle
   * with the page showing a partial composite of two different renders.
   */
  private rebuildQueue: Promise<void> = Promise.resolve();


  constructor(root: HTMLElement, cb: ViewerCallbacks) {
    this.root = root;
    this.cb = cb;
    this.watchPinch();
    root.addEventListener('click', (e) => {
      if (e.target === root || (e.target as HTMLElement).classList.contains('page-strip')) {
        this.closeEditor(true);
        this.select(null);
      }
    });
  }

  get currentZoom(): number {
    return this.zoom;
  }

  setMode(mode: ViewerMode): void {
    this.closeEditor(false);
    this.mode = mode;
    for (const p of this.pages) {
      p.overlay.classList.toggle('placing', mode === 'add' || mode === 'sign' || mode === 'note');
      p.overlay.classList.toggle('erasing', mode === 'erase' || mode === 'redact' || mode === 'highlight');
      p.overlay.classList.toggle(
        'drawing',
        mode === 'pen' || mode === 'inkErase' || mode === 'line' || mode === 'arrow' || mode === 'rect' || mode === 'ellipse',
      );
      p.textLayer.classList.toggle('active', mode === 'select');
    }
  }

  async load(doc: HandpressDocument): Promise<void> {
    // The outgoing document's renders finish before it is let go of. Opening a
    // second file while the first was still drawing tore the canvases out from
    // under those renders, and the cancellation came back up as "Could not
    // open that PDF: Rendering cancelled, page 1" about a file that was
    // perfectly fine. settleRenders never rejects, so a page that was already
    // failing cannot take the new document down with it either.
    await this.settleRenders();
    this.doc = doc;
    this.root.innerHTML = '';
    this.pages = [];
    this.observer?.disconnect();

    const strip = document.createElement('div');
    strip.className = 'page-strip';
    this.root.appendChild(strip);
    this.strip = strip;

    for (let i = 0; i < doc.pageCount; i++) {
      const container = document.createElement('div');
      container.className = 'page';
      container.dataset.page = String(i);

      const canvas = document.createElement('canvas');
      canvas.className = 'page-canvas';
      const overlay = document.createElement('div');
      overlay.className = 'page-overlay';

      const textLayer = document.createElement('div');
      textLayer.className = 'text-layer';

      const label = document.createElement('div');
      label.className = 'page-label';
      label.textContent = String(i + 1);

      overlay.addEventListener('click', (e) => {
        // A click that landed on something placed earlier belongs to that thing,
        // not to a new placement. The boxes over existing text do not take part:
        // the stylesheet lets clicks through them while placing, because a
        // signature usually belongs exactly where the page already has text.
        if (e.target !== overlay) return;
        if (this.mode === 'add') void this.placeText(this.pages[i], e as MouseEvent);
        else if (this.mode === 'sign') void this.placeSignature(this.pages[i], e as MouseEvent);
        else if (this.mode === 'note') void this.placeNote(this.pages[i], e as MouseEvent);
      });

      // Erasing is a drag rather than a click, so it needs the pointer directly.
      overlay.addEventListener('pointerdown', (e) => {
        if (this.mode === 'pen' || this.mode === 'inkErase') {
          this.beginStroke(this.pages[i], e);
          return;
        }
        if (this.mode === 'line' || this.mode === 'arrow' || this.mode === 'rect' || this.mode === 'ellipse') {
          this.beginShape(this.pages[i], e, this.mode);
          return;
        }
        if (this.mode !== 'erase' && this.mode !== 'redact' && this.mode !== 'highlight') return;
        this.beginRegion(this.pages[i], e, this.mode);
      });

      // The text layer sits above the overlay so that, in select mode, a drag
      // reaches the words rather than the boxes drawn over them.
      container.append(canvas, overlay, textLayer, label);
      strip.appendChild(container);
      this.pages.push({
        index: i,
        container,
        canvas,
        overlay,
        textLayer,
        model: null,
        renderedZoom: 0,
        queue: Promise.resolve(),
        viewport: null,
      });
    }

    // Pages render as they approach the viewport, which keeps large files usable.
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const idx = Number((entry.target as HTMLElement).dataset.page);
          void this.renderPage(idx);
        }
      },
      { root: this.root, rootMargin: '400px 0px' },
    );
    for (const p of this.pages) this.observer.observe(p.container);

    await this.reserveSizes();
    try {
      await this.renderPage(0);
    } catch (e) {
      // A superseded first page is not a document that failed to open. It
      // means a third file arrived while this one was drawing, and that file's
      // render is the one that should be believed.
      if (!Viewer.isCancellation(e)) throw e;
    }
  }

  /** Sets page box sizes before rendering so scrolling does not jump. */
  private async reserveSizes(): Promise<void> {
    if (!this.doc?.pdfjs) return;
    for (const p of this.pages) {
      try {
        const jsPage = await this.doc.pdfjs.getPage(p.index + 1);
        const vp = jsPage.getViewport({ scale: this.zoom });
        p.container.style.width = `${Math.floor(vp.width)}px`;
        p.container.style.height = `${Math.floor(vp.height)}px`;
      } catch {
        // A page that will not measure still gets rendered on demand.
      }
    }
  }

  async setZoom(zoom: number): Promise<void> {
    this.closeEditor(true);
    this.zoom = Math.max(0.25, Math.min(5, zoom));
    for (const p of this.pages) p.renderedZoom = 0;
    await this.reserveSizes();
    await this.renderVisible();
  }

  private async renderVisible(): Promise<void> {
    const rootRect = this.root.getBoundingClientRect();
    for (const p of this.pages) {
      const r = p.container.getBoundingClientRect();
      if (r.bottom > rootRect.top - 400 && r.top < rootRect.bottom + 400) {
        await this.renderPage(p.index);
      }
    }
  }

  /** Re-renders every already-rendered page, used after an edit changes the file. */
  async refreshRendered(onlyPage?: number): Promise<void> {
    const token = ++this.renderToken;
    // Only the drawn scale is invalidated. The text model comes from the
    // original bytes and never changes, so throwing it away here only widened
    // the window in which a page had no model to click into.
    //
    // A change to one page is not a reason to redraw the others. Dragging an
    // image on page one used to invalidate every page in view and draw them
    // all again before the image appeared where it was dropped.
    for (const p of this.pages) {
      if (onlyPage === undefined || p.index === onlyPage) p.renderedZoom = 0;
    }
    if (token !== this.renderToken) return;
    await this.renderVisible();
  }

  private async renderPage(index: number): Promise<void> {
    const p = this.pages[index];
    if (!p || !this.doc?.pdfjs) return;
    if (p.renderedZoom === this.zoom && p.model) return;

    // Wait for any render already under way, then reconsider: it may have
    // produced exactly what this call wanted.
    await this.enqueue(p, async () => {
      // Re-checked inside the queue: whatever was already drawing may have
      // produced exactly what this call wanted.
      if (p.renderedZoom === this.zoom && p.model) return;
      await this.drawPage(p, index);
    });
  }

  /**
   * Runs a job on a page's render chain, one at a time.
   *
   * A failing job must not break the chain for everything queued behind it, so
   * the tail always resolves and the error goes only to this caller.
   */
  private enqueue<T>(p: RenderedPage, job: () => Promise<T>): Promise<T> {
    const result = p.queue.then(job);
    p.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Draws a page into an offscreen canvas at an arbitrary scale.
   *
   * pdf.js will not render the same page twice at once, so this joins the same
   * queue the on-screen render uses. Calling getPage and render directly while
   * the viewer was still drawing that page left both renders waiting forever.
   */
  async rasterise(index: number, scale: number): Promise<HTMLCanvasElement> {
    if (!this.doc?.pdfjs) throw new Error('No document is open.');
    const p = this.pages[index];

    const run = async (): Promise<HTMLCanvasElement> => {
      const jsPage = await this.doc!.pdfjs!.getPage(index + 1);
      const viewport = jsPage.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d')!;
      // A PDF page may draw nothing where it expects paper, and recognition
      // wants a white ground rather than a transparent one.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await jsPage.render({ canvasContext: ctx, viewport, canvas }).promise;
      return canvas;
    };

    return p ? this.enqueue(p, run) : run();
  }

  private async drawPage(p: RenderedPage, index: number): Promise<void> {
    if (!this.doc?.pdfjs) return;
    const token = this.renderToken;
    // Captured now, because the zoom can change while this render is running and
    // the page must be recorded at the scale it was actually drawn at.
    const drawnZoom = this.zoom;
    const jsPage = await this.doc.pdfjs.getPage(index + 1);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    // Two viewports: one at device resolution that the canvas matches exactly,
    // and one at CSS resolution for layout and for placing the overlay. Letting
    // pdf.js render into a canvas the same size as its own viewport is simpler
    // than composing a device-pixel transform with the viewport's own.
    const renderViewport = jsPage.getViewport({ scale: drawnZoom * dpr });
    const viewport = jsPage.getViewport({ scale: drawnZoom });

    p.canvas.style.width = `${Math.floor(viewport.width)}px`;
    p.canvas.style.height = `${Math.floor(viewport.height)}px`;
    p.container.style.width = `${Math.floor(viewport.width)}px`;
    p.container.style.height = `${Math.floor(viewport.height)}px`;

    // Drawn into a canvas of its own and only shown once it is finished. The
    // page used to be cleared here, before an await that takes as long as it
    // takes, so every edit blanked the page and then filled it back in. It is
    // also what makes the token check below load bearing rather than tidy: a
    // render that was superseded or failed now leaves the previous, correct
    // pixels alone instead of having already wiped them.
    const plate = document.createElement('canvas');
    plate.width = Math.floor(renderViewport.width);
    plate.height = Math.floor(renderViewport.height);
    const ctx = plate.getContext('2d')!;

    // The text model is read before the render rather than after it. It does
    // not depend on the render at all, and a render abandoned because the token
    // moved on used to leave the page drawn but with no model: every line then
    // selected on click and refused to open, with nothing to say why.
    p.model = await this.doc.getPage(index);

    await jsPage.render({ canvasContext: ctx, viewport: renderViewport, canvas: plate }).promise;
    if (token !== this.renderToken) return;

    if (p.canvas.width !== plate.width || p.canvas.height !== plate.height) {
      p.canvas.width = plate.width;
      p.canvas.height = plate.height;
    }
    const visible = p.canvas.getContext('2d')!;
    visible.setTransform(1, 0, 0, 1, 0, 0);
    visible.drawImage(plate, 0, 0);

    p.renderedZoom = drawnZoom;
    p.viewport = viewport;
    this.buildOverlay(p, viewport);
    this.buildTextLayer(p, viewport);
    this.paintMatches(p);
  }

  private buildOverlay(p: RenderedPage, viewport: { convertToViewportPoint(x: number, y: number): number[] }): void {
    // Never rebuild under an open editor. A page re-renders for reasons that
    // have nothing to do with what is being typed, and replacing the boxes
    // mid sentence takes the caret with them: the edit is lost and the click
    // that started it appears to have done nothing.
    if (this.activeEditor && this.activePage === p) return;

    p.overlay.innerHTML = '';
    if (!p.model || !this.doc) return;

    // A form drawn several times on a page gives each appearance its own line,
    // all reading the same bytes. Editing any of them rewrites the text
    // everywhere, so the ones that share are marked as such before anyone
    // types into them and wonders why the rest changed too.
    const shared = new Map<string, number>();
    for (const line of p.model.lines) {
      const op = line.ops[0];
      if (!op) continue;
      const key = `${line.streamId}:${op.start}`;
      shared.set(key, (shared.get(key) ?? 0) + 1);
    }

    for (const line of p.model.lines) {
      const box = document.createElement('div');
      box.className = 'line-box';
      if (!line.editable) box.classList.add('line-locked');
      if (this.doc.isEdited(p.index, line.id)) box.classList.add('line-edited');
      if (this.selectedLineId === line.id) box.classList.add('line-selected');

      const geo = this.lineGeometry(line, viewport);
      // A dragged line is drawn where it now sits, not where the original file
      // put it, so the box keeps following the text after a move.
      const offset = this.doc.offsetFor(p.index, line.id);
      const shift =
        offset.dx || offset.dy
          ? (() => {
              const [ax, ay] = viewport.convertToViewportPoint(line.startX, line.startY);
              const [bx, by] = viewport.convertToViewportPoint(line.startX + offset.dx, line.startY + offset.dy);
              return { x: bx - ax, y: by - ay };
            })()
          : { x: 0, y: 0 };
      // An edited line is not the length it was drawn. The box comes from the
      // original extent, so text that grew ran out past the edge of its own
      // box and text that shrank left the box hanging off the end. The
      // difference is measured in the line's own font and added.
      const shown = this.doc.textFor(p.index, line);
      let width = geo.width;
      if (shown !== line.text) {
        // Scaled by the ratio of measured widths rather than by adding their
        // difference. The width the line was drawn at and the width its own
        // font measures are not the same number, so adding one to the other
        // mixed two scales and barely moved the box. A ratio carries whatever
        // the measurement gets wrong through both sides. Character counts are
        // the fallback for a font that cannot be measured at all.
        const horizScale = line.ops[0]?.horizScale ?? 100;
        const was = measure(line.font, line.text, line.fontSize, horizScale);
        const now = measure(line.font, shown, line.fontSize, horizScale);
        width =
          was !== null && now !== null && was > 0.01
            ? geo.width * (now / was)
            : geo.width * (shown.length / Math.max(1, line.text.length));
        width = Math.max(4, width);
      }
      // A little past the type on each side, so the outline sits around the
      // words rather than against them.
      const sidePad = Math.max(1.5, line.fontSize * this.zoom * 0.08);

      box.style.left = `${geo.left + shift.x - sidePad}px`;
      box.style.top = `${geo.top + shift.y}px`;
      box.style.width = `${width + sidePad * 2}px`;
      box.style.height = `${geo.height}px`;
      if (geo.angle) box.style.transform = `rotate(${geo.angle}deg)`;
      box.style.transformOrigin = 'left top';
      const copies = line.ops[0] ? (shared.get(`${line.streamId}:${line.ops[0].start}`) ?? 1) : 1;
      box.title = line.editable
        ? this.doc.textFor(p.index, line) +
          (copies > 1
            ? `\n\nDrawn ${copies} times on this page from one place in the file. Editing it changes every copy.`
            : '')
        : 'This text uses a font with no reliable character mapping, so it cannot be edited safely.';
      if (copies > 1) box.classList.add('line-shared');

      // Dragging repositions the line; a plain click still opens it for editing.
      // The threshold inside makeDraggable is what keeps the two apart.
      this.makeDraggable(
        box,
        viewport as never,
        (dx, dy) => {
          if (!this.doc || !line.editable) return;
          if (!this.doc.moveLine(p.index, line.id, dx, dy)) return;
          void this.rebuild(p.index).then(() => this.cb.onEdited());
        },
        () => {
          this.select(line, p);
          if (line.editable) this.openEditor(p, line, viewport);
          else this.cb.onStatus('That text uses a font Handpress cannot map to characters, so editing it is disabled.', 'warn');
        },
        p,
      );

      p.overlay.appendChild(box);
    }

    // Images sit at the bottom of the overlay so text and fields stay clickable.
    for (const image of p.model.walk.images) {
      this.addImageBox(p, image, viewport);
    }

    // Interactive fields come first so their controls sit under nothing else.
    for (const field of this.doc.fieldsFor(p.index)) {
      this.addFieldControl(p, field, viewport);
    }

    for (const erasure of this.doc.erasuresFor(p.index)) {
      this.addErasureBox(p, erasure, viewport);
    }

    for (const area of this.doc.redactionsFor(p.index)) {
      const [ax, ay] = viewport.convertToViewportPoint(area.x, area.y + area.height);
      const [bx, by] = viewport.convertToViewportPoint(area.x + area.width, area.y);
      const box = document.createElement('div');
      box.className = 'line-box redact-box';
      box.style.left = `${Math.min(ax, bx)}px`;
      box.style.top = `${Math.min(ay, by)}px`;
      box.style.width = `${Math.abs(bx - ax)}px`;
      box.style.height = `${Math.abs(by - ay)}px`;
      box.title = 'Redacted. The text here is deleted from the saved file.';
      const remove = document.createElement('button');
      remove.className = 'box-remove';
      remove.type = 'button';
      remove.textContent = '\u00d7';
      remove.title = 'Undo this redaction';
      remove.addEventListener('pointerdown', (e) => e.stopPropagation());
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!this.doc?.removeRedaction(p.index, area.id)) return;
        void this.rebuild(p.index).then(() => {
          this.cb.onStatus('Redaction removed.');
          this.cb.onEdited();
        });
      });
      box.appendChild(remove);
      p.overlay.appendChild(box);
    }

    // Placed images are not text, so they need their own hit target to be
    // removable; there is nothing in the line model that corresponds to them.
    for (const stamp of this.doc.stampsFor(p.index)) {
      const [sx, sy] = viewport.convertToViewportPoint(stamp.x, stamp.y + stamp.height);
      const box = document.createElement('div');
      box.className = 'line-box line-stamp';
      box.style.left = `${sx}px`;
      box.style.top = `${sy}px`;
      box.style.width = `${stamp.width * this.zoom}px`;
      box.style.height = `${stamp.height * this.zoom}px`;
      box.title = 'Drag to move. Use the cross to remove it.';

      const remove = document.createElement('button');
      remove.className = 'box-remove';
      remove.type = 'button';
      remove.textContent = '\u00d7';
      remove.title = 'Remove';
      remove.addEventListener('pointerdown', (e) => e.stopPropagation());
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!this.doc) return;
        if (this.doc.removeStamp(p.index, stamp.id)) {
          void this.rebuild().then(() => {
            this.cb.onStatus('Signature removed.');
            this.cb.onEdited();
          });
        }
      });
      box.appendChild(remove);

      this.makeDraggable(
        box,
        viewport as never,
        (dx, dy) => {
          if (!this.doc) return;
          if (!this.doc.moveStamp(p.index, stamp.id, dx, dy)) return;
          void this.rebuild(p.index).then(() => this.cb.onEdited());
        },
        undefined,
        p,
      );
      p.overlay.appendChild(box);
    }

    // Added text lives only in the edit list, not in the original document the
    // line model is built from, so it gets its own boxes to stay editable.
    for (const insertion of this.doc.insertionsFor(p.index)) {
      const [ix, iy] = viewport.convertToViewportPoint(insertion.x, insertion.y);
      const size = insertion.size * this.zoom;
      const lineCount = insertion.text.split('\n').length;

      const box = document.createElement('div');
      box.className = 'line-box line-added';
      box.style.left = `${ix}px`;
      box.style.top = `${iy - size}px`;
      box.style.width = `${Math.max(size * 3, insertion.text.length * size * 0.5)}px`;
      box.style.height = `${size * 1.2 * lineCount}px`;
      box.title = `${insertion.text}\n\nDrag to move, click to edit.`;
      this.makeDraggable(
        box,
        viewport as never,
        (dx, dy) => {
          if (!this.doc) return;
          if (!this.doc.moveInsertion(p.index, insertion.id, dx, dy)) return;
          void this.rebuild(p.index).then(() => this.cb.onEdited());
        },
        () => this.openInsertionEditor(p, insertion, viewport),
        p,
      );
      p.overlay.appendChild(box);
    }

    // Notes are annotations, so the canvas never draws them: a reader shows its
    // own icon and its own popup. The marker here stands in for that icon and
    // is what makes the comment editable while the document is open.
    for (const note of this.doc.notesFor(p.index)) this.addNoteMarker(p, note, viewport);
  }

  /**
   * Lays an invisible, selectable copy of the page's text over the canvas.
   *
   * Each line becomes one span at the line's own origin, rotated with it and
   * scaled horizontally so it covers exactly the width the line was drawn at.
   * That last part is what makes a selection line up with the glyphs underneath:
   * the browser is laying the text out in a substitute face at a slightly
   * different width, and without the correction the highlight drifts further
   * from the words with every character.
   */
  private buildTextLayer(p: RenderedPage, viewport: { convertToViewportPoint(x: number, y: number): number[] }): void {
    p.textLayer.innerHTML = '';
    if (!p.model || !this.doc) return;

    for (const line of p.model.lines) {
      const text = this.doc.textFor(p.index, line);
      if (!text.trim()) continue;

      const geo = this.lineGeometry(line, viewport);
      const sizePx = line.fontSize * this.zoom;
      const cssFont = this.cssFontFor(p.model, line, sizePx);

      Viewer.measureCtx.font = cssFont;
      const natural = Viewer.measureCtx.measureText(text).width;

      const span = document.createElement('span');
      span.textContent = text;
      span.style.font = cssFont;
      span.style.left = `${geo.baselineLeft}px`;
      span.style.top = `${geo.baselineTop}px`;
      // Positioned on the baseline, which is the one line of the text the
      // document actually agrees with us about.
      const scale = natural > 0 ? geo.width / natural : 1;
      span.style.transform = `rotate(${geo.angle}deg) scaleX(${scale.toFixed(4)}) translateY(-100%)`;
      p.textLayer.appendChild(span);
      // Absolutely positioned spans are all one line as far as a copy is
      // concerned, so the break has to be a real element. It costs no layout,
      // since everything around it is taken out of the flow.
      p.textLayer.appendChild(document.createElement('br'));
    }
  }

  /**
   * Selects every word on the page the reader is looking at.
   *
   * Scoped to one page rather than the window, because the browser's own select
   * all would take the toolbar and the status line with it.
   */
  /** Which tool is active, so the shell can key shortcuts off it. */
  currentMode(): ViewerMode {
    return this.mode;
  }

  selectPageText(): boolean {
    const p = this.pages[this.currentPageIndex()];
    if (!p || !p.textLayer.childElementCount) return false;

    const range = document.createRange();
    range.selectNodeContents(p.textLayer);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return true;
  }

  /**
   * Pinching two fingers apart zooms the pages.
   *
   * During the gesture the whole column is simply scaled with a transform,
   * which costs nothing, and the real zoom is applied once on release. Asking
   * pdf.js to redraw every page on every frame of a pinch would be a slideshow.
   */
  private watchPinch(): void {
    const active = new Map<number, { x: number; y: number }>();
    let startGap = 0;
    let startZoom = 1;
    let scale = 1;

    const gap = (): number => {
      const [a, b] = [...active.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };

    this.root.addEventListener(
      'pointerdown',
      (e) => {
        if (e.pointerType !== 'touch') return;
        active.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (active.size === 2) {
          startGap = gap();
          startZoom = this.zoom;
          scale = 1;
        }
      },
      { capture: true },
    );

    // Movement and release are watched on the window, not on the page. A finger
    // that starts a pinch on the page can perfectly well leave it before it
    // lifts, and a release over the toolbar never reaches a listener on the
    // page: that pointer then stays in `active` for the rest of the session,
    // and the next single finger drag is read as the second half of a pinch
    // and zooms instead of scrolling.
    window.addEventListener(
      'pointermove',
      (e) => {
        if (!active.has(e.pointerId)) return;
        active.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (active.size !== 2 || !startGap || !this.strip) return;

        // Two fingers on the page mean a pinch, never a scroll.
        e.preventDefault();
        scale = Math.max(0.2, Math.min(6, gap() / startGap));
        this.strip.style.transformOrigin = 'top center';
        this.strip.style.transform = `scale(${scale})`;
      },
      { capture: true, passive: false },
    );

    const release = (e: PointerEvent): void => {
      if (!active.delete(e.pointerId)) return;
      if (active.size >= 2 || !startGap) return;

      const wanted = startZoom * scale;
      startGap = 0;
      scale = 1;
      if (this.strip) this.strip.style.transform = '';
      if (Math.abs(wanted - this.zoom) > 0.01) {
        void this.setZoom(wanted);
        // The toolbar has to agree, or the next window resize snaps the page
        // back to fit width and undoes the pinch.
        this.cb.onZoomedByHand?.(wanted);
      }
    };

    window.addEventListener('pointerup', release, { capture: true });
    window.addEventListener('pointercancel', release, { capture: true });
    // A gesture interrupted by the tab going away leaves nothing behind either.
    window.addEventListener('blur', () => {
      active.clear();
      startGap = 0;
      scale = 1;
      if (this.strip) this.strip.style.transform = '';
    });
  }

  /** Draws one note's marker and wires dragging and editing to it. */
  private addNoteMarker(
    p: RenderedPage,
    note: PageNote,
    viewport: { convertToViewportPoint(x: number, y: number): number[] },
  ): void {
    const [nx, ny] = viewport.convertToViewportPoint(note.x, note.y);
    const marker = document.createElement('div');
    marker.className = 'note-marker';
    marker.dataset.note = note.id;
    marker.style.left = `${nx}px`;
    marker.style.top = `${ny}px`;
    marker.style.width = `${NOTE_SIZE * this.zoom}px`;
    marker.style.height = `${NOTE_SIZE * this.zoom}px`;
    marker.textContent = '\u201c';
    marker.title = `${note.text || 'Empty note'}\n\nDrag to move, click to edit.`;

    this.makeDraggable(
      marker,
      viewport as never,
      (dx, dy) => {
        if (!this.doc) return;
        if (!this.doc.moveNote(p.index, note.id, dx, dy)) return;
        void this.rebuild(p.index).then(() => this.cb.onEdited());
      },
      () => this.openNoteEditor(p, note, viewport),
      // Deliberately not lifted. A note is an annotation, so the marker is our
      // own drawing rather than page pixels; copying the canvas underneath it
      // would float whatever the page happens to have there.
    );
    p.overlay.appendChild(marker);
  }

  /** Attaches a comment where the user clicked and opens it for typing. */
  private async placeNote(p: RenderedPage, event: MouseEvent): Promise<void> {
    if (!this.doc?.pdfjs) return;
    const rect = p.overlay.getBoundingClientRect();
    const jsPage = await this.doc.pdfjs.getPage(p.index + 1);
    const viewport = jsPage.getViewport({ scale: this.zoom });
    const [px, py] = viewport.convertToPdfPoint(event.clientX - rect.left, event.clientY - rect.top);

    // A draft, for the same reason a placed piece of text is one: putting a
    // note on the page and then thinking better of it should leave nothing
    // behind, not an empty comment counted as an edit.
    const note: PageNote = {
      id: 'draftNote',
      x: px,
      y: py,
      text: '',
      author: this.noteAuthor,
      written: Date.now(),
    };
    // Drawn straight away rather than waiting for the next rebuild, so the note
    // is visibly there while its comment is still being typed.
    this.addNoteMarker(p, note, viewport);
    this.openNoteEditor(p, note, viewport, true);
  }

  /**
   * Opens a note for typing.
   *
   * A comment is prose rather than a line of the page, so it gets a proper box
   * to write in instead of the in-place editor the rest of the text uses. An
   * empty comment on close removes the note, which is the only sensible reading
   * of a note with nothing in it.
   */
  private openNoteEditor(
    p: RenderedPage,
    note: PageNote,
    viewport: { convertToViewportPoint(x: number, y: number): number[] },
    draft = false,
  ): void {
    if (!this.doc) return;
    this.closeEditor(true);
    p.container.querySelector('.note-editor')?.remove();

    const [nx, ny] = viewport.convertToViewportPoint(note.x, note.y);
    const panel = document.createElement('div');
    panel.className = 'note-editor';
    panel.style.left = `${nx + NOTE_SIZE * this.zoom + 6}px`;
    panel.style.top = `${ny}px`;

    const area = document.createElement('textarea');
    area.value = note.text;
    area.placeholder = 'Write a comment';
    area.rows = 4;
    panel.appendChild(area);

    const row = document.createElement('div');
    row.className = 'note-actions';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'note-delete';
    remove.textContent = 'Delete';
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'note-done';
    done.textContent = 'Done';
    row.append(remove, done);
    panel.appendChild(row);

    const close = (): void => panel.remove();

    /** Takes back a draft's marker, which was drawn before the note existed. */
    const abandon = (message?: string): void => {
      close();
      void this.rebuild().then(() => {
        if (message) this.cb.onStatus(message);
      });
    };

    const save = (): void => {
      if (!this.doc) return;
      const text = area.value;
      close();
      if (draft) {
        if (!text.trim()) {
          abandon();
          return;
        }
        this.doc.addNote(p.index, { ...note, text });
        void this.rebuild().then(() => {
          this.cb.onStatus('Note saved.');
          this.cb.onEdited();
        });
        return;
      }
      if (!this.doc.setNoteText(p.index, note.id, text)) return;
      void this.rebuild().then(() => {
        this.cb.onStatus(text.trim() ? 'Note saved.' : 'Empty note removed.');
        this.cb.onEdited();
      });
    };

    done.addEventListener('click', save);
    remove.addEventListener('click', () => {
      if (!this.doc) return;
      close();
      if (draft) {
        abandon();
        return;
      }
      if (!this.doc.removeNote(p.index, note.id)) return;
      void this.rebuild().then(() => {
        this.cb.onStatus('Note removed.');
        this.cb.onEdited();
      });
    });
    panel.addEventListener('click', (e) => e.stopPropagation());
    panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (draft) abandon();
        else close();
      }
      e.stopPropagation();
    });

    // The panel belongs to the page rather than the overlay, because the
    // overlay is thrown away and rebuilt on every rebuild of the document and
    // would take a half typed comment with it.
    p.container.appendChild(panel);
    area.focus();
  }

  /**
   * Drags out a rectangle and paints over whatever is under it.
   *
   * The fill colour is sampled from the page just outside the region, so a patch
   * on tinted or coloured paper disappears instead of leaving a white scar. It
   * covers rather than deletes, which the interface says plainly.
   */
  /**
   * Draws a freehand stroke, or rubs strokes out.
   *
   * The line is previewed on a canvas of its own above the page, because the
   * page canvas holds pdf.js output of the real bytes and nothing else may
   * write to it. On release the points are handed to the document in page
   * coordinates and the page is rebuilt, at which point the preview is dropped
   * and the stroke is in the file rather than over it.
   */
  private beginStroke(p: RenderedPage, down: PointerEvent): void {
    if (!this.doc || !p.viewport) return;
    down.preventDefault();
    const rubbing = this.mode === 'inkErase';
    const rect = p.overlay.getBoundingClientRect();
    const viewport = p.viewport;
    const points: Array<{ x: number; y: number }> = [];

    const preview = document.createElement('canvas');
    preview.className = 'ink-preview';
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    preview.width = Math.floor(rect.width * dpr);
    preview.height = Math.floor(rect.height * dpr);
    preview.style.width = `${rect.width}px`;
    preview.style.height = `${rect.height}px`;
    const ctx = preview.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = `rgb(${Math.round(this.penColor.r * 255)},${Math.round(this.penColor.g * 255)},${Math.round(this.penColor.b * 255)})`;
    ctx.lineWidth = this.penWidth * this.zoom;
    ctx.globalAlpha = this.penOpacity;
    if (!rubbing) p.container.appendChild(preview);

    let rubbed = false;
    const at = (e: PointerEvent): { sx: number; sy: number } => ({
      sx: e.clientX - rect.left,
      sy: e.clientY - rect.top,
    });

    const take = (e: PointerEvent): void => {
      const { sx, sy } = at(e);
      const [px, py] = viewport.convertToPdfPoint(sx, sy);
      if (rubbing) {
        // A rub is a radius in page units, so it feels the same at any zoom.
        if (this.doc?.eraseInkAt(p.index, px, py, 6 / this.zoom)) rubbed = true;
        return;
      }
      const last = points[points.length - 1];
      // Samples closer together than a third of a point say nothing new and
      // make the saved path longer for no reason.
      if (last && Math.hypot(px - last.x, py - last.y) < 0.3) return;
      points.push({ x: px, y: py });

      if (points.length === 1) {
        ctx.beginPath();
        ctx.moveTo(sx, sy);
      } else {
        ctx.lineTo(sx, sy);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(sx, sy);
      }
    };

    take(down);

    const move = (e: PointerEvent): void => take(e);
    // Release and cancel share a handler, and a pointer can deliver both. A
    // second run would add the same stroke to the document twice.
    let finished = false;
    const up = (e: PointerEvent): void => {
      if (finished) return;
      finished = true;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      take(e);

      if (rubbing) {
        preview.remove();
        if (rubbed) void this.rebuild(p.index).then(() => this.cb.onEdited());
        return;
      }
      if (!points.length || !this.doc) {
        preview.remove();
        return;
      }
      this.doc.addInk(p.index, {
        color: { ...this.penColor },
        width: this.penWidth,
        opacity: this.penOpacity,
        points,
      });
      // Left up until the page has really been redrawn with the stroke in it,
      // for the same reason a moved object keeps its copy: taking it away first
      // makes the stroke vanish and come back.
      void this.rebuild(p.index).then(() => {
        preview.remove();
        this.cb.onStatus('Drawn. It is part of the page now, so it saves and prints with it.');
        this.cb.onEdited();
      });
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /**
   * Drags out a shape between two corners.
   *
   * The preview is redrawn from the two corners on every move rather than
   * accumulated, because unlike a freehand line the shape has no history: only
   * where it started and where the pointer is now.
   */
  private beginShape(p: RenderedPage, down: PointerEvent, kind: 'line' | 'arrow' | 'rect' | 'ellipse'): void {
    if (!this.doc || !p.viewport) return;
    down.preventDefault();
    const rect = p.overlay.getBoundingClientRect();
    const viewport = p.viewport;

    const preview = document.createElement('canvas');
    preview.className = 'ink-preview';
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    preview.width = Math.floor(rect.width * dpr);
    preview.height = Math.floor(rect.height * dpr);
    preview.style.width = `${rect.width}px`;
    preview.style.height = `${rect.height}px`;
    const ctx = preview.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = this.penOpacity;
    ctx.strokeStyle = `rgb(${Math.round(this.penColor.r * 255)},${Math.round(this.penColor.g * 255)},${Math.round(this.penColor.b * 255)})`;
    ctx.lineWidth = this.penWidth * this.zoom;
    p.container.appendChild(preview);

    const start = { x: down.clientX - rect.left, y: down.clientY - rect.top };
    let end = { ...start };

    const paint = (): void => {
      ctx.clearRect(0, 0, rect.width, rect.height);
      const shape = shapePoints(kind, start, end, this.penWidth * this.zoom);
      ctx.beginPath();
      shape.points.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      if (shape.closed) ctx.closePath();
      ctx.stroke();
    };

    const move = (e: PointerEvent): void => {
      end = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      paint();
    };

    let finished = false;
    const up = (e: PointerEvent): void => {
      if (finished) return;
      finished = true;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      end = { x: e.clientX - rect.left, y: e.clientY - rect.top };

      // A shape with no drag is somebody changing their mind, not a dot.
      if (Math.hypot(end.x - start.x, end.y - start.y) < 3 || !this.doc) {
        preview.remove();
        return;
      }

      const toPage = (q: { x: number; y: number }): { x: number; y: number } => {
        const [x, y] = viewport.convertToPdfPoint(q.x, q.y);
        return { x, y };
      };
      const shape = shapePoints(kind, toPage(start), toPage(end), this.penWidth);
      this.doc.addInk(p.index, {
        color: { ...this.penColor },
        width: this.penWidth,
        opacity: this.penOpacity,
        closed: shape.closed,
        points: shape.points,
      });
      void this.rebuild(p.index).then(() => {
        preview.remove();
        this.cb.onEdited();
      });
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  private beginRegion(p: RenderedPage, down: PointerEvent, kind: 'erase' | 'redact' | 'highlight'): void {
    if (!this.doc || !p.viewport) return;
    down.preventDefault();

    const rect = p.overlay.getBoundingClientRect();
    const startX = down.clientX - rect.left;
    const startY = down.clientY - rect.top;

    const preview = document.createElement('div');
    preview.className =
      kind === 'redact'
        ? 'erase-preview redact-preview'
        : kind === 'highlight'
          ? 'erase-preview highlight-preview'
          : 'erase-preview';
    p.overlay.appendChild(preview);

    const draw = (x: number, y: number): { left: number; top: number; width: number; height: number } => {
      const left = Math.min(startX, x);
      const top = Math.min(startY, y);
      const width = Math.abs(x - startX);
      const height = Math.abs(y - startY);
      preview.style.left = `${left}px`;
      preview.style.top = `${top}px`;
      preview.style.width = `${width}px`;
      preview.style.height = `${height}px`;
      return { left, top, width, height };
    };
    let box = draw(startX, startY);

    const move = (e: PointerEvent): void => {
      box = draw(e.clientX - rect.left, e.clientY - rect.top);
    };
    const up = async (e: PointerEvent): Promise<void> => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up as (ev: PointerEvent) => void);
      box = draw(e.clientX - rect.left, e.clientY - rect.top);
      const colour = sampleBackground(
        p.canvas,
        new DOMRect(box.left, box.top, box.width, box.height),
        p.canvas.width / Math.max(1, parseFloat(p.canvas.style.width)),
      );
      preview.remove();

      // A stray click is not an erasure.
      if (box.width < 4 || box.height < 4 || !this.doc || !p.viewport) return;

      const [x0, y0] = p.viewport.convertToPdfPoint(box.left, box.top);
      const [x1, y1] = p.viewport.convertToPdfPoint(box.left + box.width, box.top + box.height);
      const area = {
        x: Math.min(x0, x1),
        y: Math.min(y0, y1),
        width: Math.abs(x1 - x0),
        height: Math.abs(y1 - y0),
      };

      if (kind === 'highlight') {
        this.doc.addErasure(p.index, { ...area, color: { ...this.highlightColor }, blend: true });
        await this.rebuild(p.index);
        this.cb.onStatus('Highlighted.');
        this.cb.onEdited();
        return;
      }

      if (kind === 'redact') {
        this.doc.addRedaction(p.index, area);
        const removed = this.doc.countRedactedChars(p.index);
        await this.rebuild(p.index);
        this.cb.onStatus(
          removed
            ? `Redacted. ${removed} character${removed === 1 ? '' : 's'} deleted from the file, not just covered.`
            : 'Redaction area added, though no text falls inside it.',
        );
        this.cb.onEdited();
        return;
      }

      const match = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(colour);
      const rgb = match
        ? { r: Number(match[1]) / 255, g: Number(match[2]) / 255, b: Number(match[3]) / 255 }
        : { r: 1, g: 1, b: 1 };

      this.doc.addErasure(p.index, { ...area, color: rgb });
      await this.rebuild(p.index);
      this.cb.onStatus('Erased. The text underneath is covered, not removed.');
      this.cb.onEdited();
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up as (ev: PointerEvent) => void);
  }

  /** Shows an erasure so it can be moved or taken back. */
  private addErasureBox(
    p: RenderedPage,
    erasure: RectFill,
    viewport: { convertToViewportPoint(x: number, y: number): number[] },
  ): void {
    const [ax, ay] = viewport.convertToViewportPoint(erasure.x, erasure.y + erasure.height);
    const [bx, by] = viewport.convertToViewportPoint(erasure.x + erasure.width, erasure.y);

    const box = document.createElement('div');
    box.className = 'line-box erase-box';
    box.style.left = `${Math.min(ax, bx)}px`;
    box.style.top = `${Math.min(ay, by)}px`;
    box.style.width = `${Math.abs(bx - ax)}px`;
    box.style.height = `${Math.abs(by - ay)}px`;
    box.title = 'Erased area. Drag to move, cross to undo it.';

    const remove = document.createElement('button');
    remove.className = 'box-remove';
    remove.type = 'button';
    remove.textContent = '\u00d7';
    remove.title = 'Undo this erasure';
    remove.addEventListener('pointerdown', (e) => e.stopPropagation());
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this.doc?.removeErasure(p.index, erasure.id)) return;
      void this.rebuild().then(() => {
        this.cb.onStatus('Erasure removed.');
        this.cb.onEdited();
      });
    });
    box.appendChild(remove);

    this.makeDraggable(
      box,
      viewport as never,
      (dx, dy) => {
        if (!this.doc?.moveErasure(p.index, erasure.id, dx, dy)) return;
        void this.rebuild(p.index).then(() => this.cb.onEdited());
      },
      undefined,
      p,
    );
    p.overlay.appendChild(box);
  }

  /** Replaces the highlighted search hits and repaints the overlays. */
  setMatches(matches: SearchMatch[], current = -1): void {
    this.matches = matches;
    this.currentMatch = current;
    for (const p of this.pages) {
      if (p.model) this.paintMatches(p);
    }
  }

  /** Scrolls a hit into view and marks it as the current one. */
  async revealMatch(index: number): Promise<void> {
    const match = this.matches[index];
    if (!match) return;
    this.currentMatch = index;

    const p = this.pages[match.pageIndex];
    if (!p) return;
    await this.renderPage(match.pageIndex);
    this.paintMatches(p);

    const box = p.overlay.querySelector<HTMLElement>(`.match-box[data-match="${index}"]`);
    (box ?? p.container).scrollIntoView({ behavior: 'smooth', block: 'center' });
    for (const other of this.pages) {
      if (other !== p && other.model) this.paintMatches(other);
    }
  }

  /**
   * Draws a highlight over each hit on a page.
   *
   * The span of characters is turned into a position by walking the line's
   * styled segments and interpolating within whichever ones the hit covers,
   * rather than across the line as a whole. A line that mixes a bold label with
   * body text is not evenly spaced, and interpolating over the whole thing puts
   * the highlight in the wrong place.
   */
  private paintMatches(p: RenderedPage): void {
    for (const old of Array.from(p.overlay.querySelectorAll('.match-box'))) old.remove();
    if (!p.model || !this.matches.length || !this.doc?.pdfjs) return;

    const mine = this.matches
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => m.pageIndex === p.index);
    if (!mine.length) return;

    const byId = new Map(p.model.lines.map((l) => [l.id, l]));
    const insertions = new Map(this.doc.insertionsFor(p.index).map((x) => [x.id, x]));

    for (const { m, i } of mine) {
      if (m.insertionId) {
        const box = this.matchBoxForInsertion(p, insertions.get(m.insertionId), m, i);
        if (box) p.overlay.appendChild(box);
        continue;
      }
      const line = byId.get(m.lineId);
      if (!line) continue;

      // Where along the line the hit starts and ends, in page units. The same
      // measurement the rest of the app uses, rather than a second copy of it
      // that could drift away from the first.
      const uStart = charPosition(line, m.start);
      const uEnd = charPosition(line, m.end);
      const perpX = -line.dirY;
      const perpY = line.dirX;
      const descent = (Math.abs(line.font.descent) / 1000) * line.fontSize;
      const ascent = (line.font.ascent / 1000) * line.fontSize;

      // A point in the line's frame, back in page coordinates.
      const at = (u: number, v: number): [number, number] => [
        u * line.dirX + v * perpX,
        u * line.dirY + v * perpY,
      ];
      // The line's perpendicular coordinate, recovered from its start point.
      const vBase = -line.startX * line.dirY + line.startY * line.dirX;
      const pts = [
        at(uStart, vBase - descent),
        at(uEnd, vBase - descent),
        at(uEnd, vBase + ascent),
        at(uStart, vBase + ascent),
      ];

      const viewport = p.viewport;
      if (!viewport) continue;
      const screen = pts.map(([x, y]) => viewport.convertToViewportPoint(x, y));
      const xs = screen.map((s) => s[0]);
      const ys = screen.map((s) => s[1]);

      const box = document.createElement('div');
      box.className = 'match-box';
      if (i === this.currentMatch) box.classList.add('match-current');
      box.dataset.match = String(i);
      box.style.left = `${Math.min(...xs)}px`;
      box.style.top = `${Math.min(...ys)}px`;
      box.style.width = `${Math.max(2, Math.max(...xs) - Math.min(...xs))}px`;
      box.style.height = `${Math.max(2, Math.max(...ys) - Math.min(...ys))}px`;
      p.overlay.appendChild(box);
    }
  }

  /**
   * Draws a hit that falls inside added text.
   *
   * Added text has no styled segments to interpolate through, so the span is
   * measured in the font it is written in. Asking a canvas instead measures
   * whatever the machine decided Helvetica meant, which is not what ends up in
   * the file, and the box drifts further along the line the later the hit is.
   */
  private matchBoxForInsertion(
    p: RenderedPage,
    insertion: TextInsertion | undefined,
    match: SearchMatch,
    index: number,
  ): HTMLElement | null {
    const viewport = p.viewport;
    if (!insertion || !viewport) return null;

    const scale = (insertion.horizScale ?? 100) / 100;
    const face =
      'Helvetica' +
      (insertion.bold && insertion.italic
        ? 'BoldOblique'
        : insertion.bold
          ? 'Bold'
          : insertion.italic
            ? 'Oblique'
            : '');
    const measure = (text: string): number => standardTextWidth(face, text, insertion.size) * scale;
    const x0 = insertion.x + measure(insertion.text.slice(0, match.start));
    const x1 = insertion.x + measure(insertion.text.slice(0, match.end));
    const descent = insertion.size * 0.22;
    const ascent = insertion.size * 0.82;

    const a = viewport.convertToViewportPoint(x0, insertion.y - descent);
    const b = viewport.convertToViewportPoint(x1, insertion.y + ascent);

    const box = document.createElement('div');
    box.className = 'match-box';
    if (index === this.currentMatch) box.classList.add('match-current');
    box.dataset.match = String(index);
    box.style.left = `${Math.min(a[0], b[0])}px`;
    box.style.top = `${Math.min(a[1], b[1])}px`;
    box.style.width = `${Math.max(2, Math.abs(b[0] - a[0]))}px`;
    box.style.height = `${Math.max(2, Math.abs(b[1] - a[1]))}px`;
    return box;
  }

  /**
   * Offers an image already in the document as something you can move, resize
   * or remove, with a handle in the corner for resizing.
   */
  private addImageBox(
    p: RenderedPage,
    image: ImageOp,
    viewport: { convertToViewportPoint(x: number, y: number): number[] },
  ): void {
    if (!this.doc) return;
    const id = `${image.streamId}:${image.index}`;
    const state = this.doc.imageEditFor(p.index, id);
    if (state.remove) return;

    // Very small marks are usually rules or bullets, not something to drag.
    if (image.x1 - image.x0 < 6 || image.y1 - image.y0 < 6) return;

    const scale = state.scale;
    const x0 = image.x0 + state.dx;
    const y0 = image.y0 + state.dy;
    const [ax, ay] = viewport.convertToViewportPoint(x0, y0 + (image.y1 - image.y0) * scale);
    const [bx, by] = viewport.convertToViewportPoint(x0 + (image.x1 - image.x0) * scale, y0);

    const box = document.createElement('div');
    box.className = 'line-box image-box';
    box.style.left = `${Math.min(ax, bx)}px`;
    box.style.top = `${Math.min(ay, by)}px`;
    box.style.width = `${Math.abs(bx - ax)}px`;
    box.style.height = `${Math.abs(by - ay)}px`;
    box.title = 'Image. Drag to move, corner to resize, cross to remove.';

    const remove = document.createElement('button');
    remove.className = 'box-remove';
    remove.type = 'button';
    remove.textContent = '\u00d7';
    remove.title = 'Remove this image';
    remove.addEventListener('pointerdown', (e) => e.stopPropagation());
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this.doc?.editImage(p.index, id, { remove: true })) return;
      void this.rebuild().then(() => {
        this.cb.onStatus('Image removed.');
        this.cb.onEdited();
      });
    });
    box.appendChild(remove);

    // The handle scales about the corner being dragged away from, so the image
    // grows in the direction of the drag rather than jumping.
    const handle = document.createElement('div');
    handle.className = 'box-resize';
    handle.title = 'Resize';
    const widthPx = Math.abs(bx - ax) || 1;
    let startX = 0;
    let resizing = false;
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      resizing = true;
      startX = e.clientX;
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        // Capture is optional.
      }
    });
    handle.addEventListener('pointermove', (e) => {
      if (!resizing) return;
      const factor = Math.max(0.15, (widthPx + (e.clientX - startX)) / widthPx);
      box.style.width = `${widthPx * factor}px`;
      box.style.height = `${Math.abs(by - ay) * factor}px`;
    });
    handle.addEventListener('pointerup', (e) => {
      if (!resizing) return;
      resizing = false;
      const factor = Math.max(0.15, (widthPx + (e.clientX - startX)) / widthPx);
      if (Math.abs(factor - 1) < 0.01) return;
      if (!this.doc?.editImage(p.index, id, { scale: factor })) return;
      void this.rebuild(p.index).then(() => this.cb.onEdited());
    });
    box.appendChild(handle);

    this.makeDraggable(
      box,
      viewport as never,
      (dx, dy) => {
        if (!this.doc?.editImage(p.index, id, { dx, dy })) return;
        void this.rebuild(p.index).then(() => this.cb.onEdited());
      },
      undefined,
      p,
    );

    p.overlay.appendChild(box);
  }

  /**
   * Makes a box draggable, reporting the move in page coordinates.
   *
   * The delta is measured by converting both endpoints through the viewport
   * rather than dividing pixels by the zoom, so it stays correct on rotated
   * pages. A small threshold separates a drag from a click, because these boxes
   * are also click targets and a few stray pixels should not count as a move.
   */
  /**
   * Makes a box draggable, and a plain click on it do something else.
   *
   * The move and release are listened for on the window rather than the box.
   * A page re-renders for its own reasons, and on a long document that can
   * happen between pressing and releasing the mouse: the box the press landed
   * on is replaced, the release lands on its brand new twin, and a click whose
   * state lived on the old element is simply lost. Nothing here is kept on the
   * element, so the gesture survives the page being redrawn under it.
   */
  /**
   * Freezes how part of a page looks so a move can be seen straight away.
   *
   * Moving anything rebuilds the document and hands it back to pdf.js before a
   * single pixel can change, which is a few hundred milliseconds during which
   * the outline has moved and the artwork has not. So the object's own pixels
   * are lifted off the canvas into a floating copy, the space it left is
   * covered with the page's colour, and the copy is what follows the pointer.
   * When the real render lands, both are dropped.
   *
   * The copy is a rectangle of the rendered page, so anything overlapping that
   * rectangle comes with it. That is honest for an isolated object and a lie
   * for one sitting on a background or under something else, which is why it
   * is drawn slightly faded rather than as a perfect duplicate: it reads as a
   * preview of where the thing is going, not as the thing itself having
   * already arrived. Cutting the object out properly means rendering it alone,
   * which for an image means finding it in the file and for text means setting
   * it again, and neither is a copy of the canvas.
   *
   * The copies live on the page container rather than the overlay, which is
   * emptied and rebuilt whenever the page redraws.
   */
  private lift(p: RenderedPage, rect: DOMRect): { ghost: HTMLCanvasElement; cover: HTMLElement } | null {
    const cssWidth = parseFloat(p.canvas.style.width);
    if (!cssWidth || rect.width < 1 || rect.height < 1) return null;
    const scale = p.canvas.width / cssWidth;

    const ghost = document.createElement('canvas');
    ghost.className = 'lifted';
    ghost.width = Math.max(1, Math.round(rect.width * scale));
    ghost.height = Math.max(1, Math.round(rect.height * scale));
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    try {
      ghost.getContext('2d')!.drawImage(
        p.canvas,
        Math.round(rect.left * scale),
        Math.round(rect.top * scale),
        ghost.width,
        ghost.height,
        0,
        0,
        ghost.width,
        ghost.height,
      );
    } catch {
      return null;
    }

    const cover = document.createElement('div');
    cover.className = 'lifted-gap';
    cover.style.left = `${rect.left}px`;
    cover.style.top = `${rect.top}px`;
    cover.style.width = `${rect.width}px`;
    cover.style.height = `${rect.height}px`;
    cover.style.background = sampleBackground(p.canvas, rect, scale);

    p.container.append(cover, ghost);
    this.lifted.push(cover, ghost);
    // A backstop. If a rebuild never finishes, a stale copy sitting over the
    // page claims a move happened that did not, which is a worse lie than a
    // slow redraw.
    window.clearTimeout(this.liftTimer);
    this.liftTimer = window.setTimeout(() => this.dropLifted(), 8000);
    return { ghost, cover };
  }

  /** Puts back whatever was lifted, once the page has really been redrawn. */
  private dropLifted(): void {
    window.clearTimeout(this.liftTimer);
    for (const el of this.lifted) el.remove();
    this.lifted = [];
  }

  /**
   * Whether the current tool has claimed the drag for itself.
   *
   * A region is dragged out, and so is a stroke or a shape, so a press that
   * happens to land on a line or an image belongs to the tool rather than to
   * the thing underneath. Without this, drawing over a paragraph moved the
   * paragraph.
   */
  private toolOwnsDrag(): boolean {
    return (
      this.mode === 'erase' ||
      this.mode === 'redact' ||
      this.mode === 'highlight' ||
      this.mode === 'pen' ||
      this.mode === 'inkErase' ||
      this.mode === 'line' ||
      this.mode === 'arrow' ||
      this.mode === 'rect' ||
      this.mode === 'ellipse'
    );
  }

  private makeDraggable(
    box: HTMLElement,
    viewport: { convertToPdfPoint(x: number, y: number): number[] },
    onDrop: (dx: number, dy: number) => void,
    onClick?: () => void,
    page?: RenderedPage,
  ): void {
    const THRESHOLD = 3;

    box.addEventListener('pointerdown', (down) => {
      if (down.button !== 0) return;
      // In a region mode the drag belongs to the region being drawn, not to
      // whatever object happens to sit under the pointer.
      if (this.toolOwnsDrag()) return;
      down.preventDefault();
      down.stopPropagation();

      const parent = box.parentElement;
      let moved = false;
      let lifted: { ghost: HTMLCanvasElement; cover: HTMLElement } | null = null;

      const move = (e: PointerEvent): void => {
        const dx = e.clientX - down.clientX;
        const dy = e.clientY - down.clientY;
        if (!moved && Math.hypot(dx, dy) < THRESHOLD) return;
        if (!moved && page) {
          // Lifted on the first real movement rather than on the press, so a
          // click that was never a drag costs nothing.
          const b = box.getBoundingClientRect();
          const c = page.container.getBoundingClientRect();
          lifted = this.lift(page, new DOMRect(b.left - c.left, b.top - c.top, b.width, b.height));
        }
        moved = true;
        box.classList.add('dragging');
        box.style.transform = `translate(${dx}px, ${dy}px)`;
        if (lifted) lifted.ghost.style.transform = `translate(${dx}px, ${dy}px)`;
      };

      const up = (e: PointerEvent): void => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        box.classList.remove('dragging');
        box.style.transform = '';

        if (!moved) {
          onClick?.();
          return;
        }
        // The copy stays where it was let go, so the object appears to have
        // moved at once. dropLifted removes it when the page has really been
        // redrawn underneath it.

        if (!parent) return;
        const rect = parent.getBoundingClientRect();
        const [x0, y0] = viewport.convertToPdfPoint(down.clientX - rect.left, down.clientY - rect.top);
        const [x1, y1] = viewport.convertToPdfPoint(e.clientX - rect.left, e.clientY - rect.top);
        onDrop(x1 - x0, y1 - y0);
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  /**
   * Renders one form field as a real control.
   *
   * A fillable PDF already knows what belongs in each box, so the field is
   * offered as the input it actually is rather than as free text: a tick box
   * toggles, a list offers its own options, and a length limit is enforced by
   * the control itself.
   */
  private addFieldControl(
    p: RenderedPage,
    field: FormField,
    viewport: { convertToViewportPoint(x: number, y: number): number[] },
  ): void {
    const [x0, y0] = viewport.convertToViewportPoint(field.rect.x, field.rect.y + field.rect.height);
    const [x1, y1] = viewport.convertToViewportPoint(field.rect.x + field.rect.width, field.rect.y);
    const left = Math.min(x0, x1);
    const top = Math.min(y0, y1);
    const width = Math.abs(x1 - x0);
    const height = Math.abs(y1 - y0);

    const wrap = document.createElement('div');
    wrap.className = 'field-box';
    if (field.readOnly) wrap.classList.add('field-readonly');
    if (field.required) wrap.classList.add('field-required');
    wrap.style.left = `${left}px`;
    wrap.style.top = `${top}px`;
    wrap.style.width = `${width}px`;
    wrap.style.height = `${height}px`;
    wrap.title = `${field.name}${field.required ? ' (required)' : ''}${field.readOnly ? ' (read only)' : ''}`;

    if (field.readOnly) {
      p.overlay.appendChild(wrap);
      return;
    }

    // Field values are recorded but the document is deliberately not rebuilt.
    // The control itself is the preview, exactly as every PDF viewer does it,
    // and it covers the widget completely. Rebuilding here would draw the value
    // a second time underneath, and would cancel renders already in progress.
    const commit = (value: string): void => {
      if (!this.doc) return;
      if (!this.doc.setFieldValue(field.name, value)) return;
      this.cb.onEdited();
    };

    let control: HTMLElement;
    if (field.type === 'checkbox') {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = field.value === 'on';
      box.addEventListener('change', () => commit(box.checked ? 'on' : ''));
      control = box;
    } else if ((field.type === 'dropdown' || field.type === 'radio' || field.type === 'optionlist') && field.options.length) {
      const select = document.createElement('select');
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = field.type === 'radio' ? '(none)' : '';
      select.appendChild(blank);
      for (const option of field.options) {
        const el = document.createElement('option');
        el.value = option;
        el.textContent = option;
        select.appendChild(el);
      }
      select.value = field.value;
      select.addEventListener('change', () => commit(select.value));
      control = select;
    } else {
      const input = field.multiline ? document.createElement('textarea') : document.createElement('input');
      if (input instanceof HTMLInputElement) input.type = 'text';
      input.value = field.value;
      if (field.maxLength) input.maxLength = field.maxLength;
      // Committing on change rather than on every keystroke, since each commit
      // rebuilds and repaints the whole page.
      input.addEventListener('change', () => commit(input.value));
      input.addEventListener('blur', () => commit(input.value));
      input.addEventListener('keydown', (e) => {
        const key = (e as KeyboardEvent).key;
        if (key === 'Enter' && !field.multiline) {
          e.preventDefault();
          input.blur();
        }
        e.stopPropagation();
      });
      // A field is usually set in a size that suits the box it sits in.
      input.style.fontSize = `${Math.max(8, Math.min(height * 0.62, 18))}px`;
      control = input;
    }

    control.classList.add('field-control');
    control.addEventListener('click', (e) => e.stopPropagation());
    wrap.appendChild(control);
    p.overlay.appendChild(wrap);
  }

  /**
   * Places the pending signature centred on the click.
   *
   * Centring matters because people aim at the line they want to sign on rather
   * than at a corner, and the height follows from the captured aspect ratio so
   * the handwriting is never stretched.
   */
  private async placeSignature(p: RenderedPage, event: MouseEvent): Promise<void> {
    if (!this.doc?.pdfjs || !this.pendingSignature) return;
    const signature = this.pendingSignature;

    const rect = p.overlay.getBoundingClientRect();
    const jsPage = await this.doc.pdfjs.getPage(p.index + 1);
    const viewport = jsPage.getViewport({ scale: this.zoom });
    const [px, py] = viewport.convertToPdfPoint(event.clientX - rect.left, event.clientY - rect.top);

    const width = this.signatureWidth;
    const height = (signature.height / signature.width) * width;

    this.doc.addStamp(p.index, {
      png: signature.png,
      x: px - width / 2,
      y: py - height / 2,
      width,
      height,
    });

    // Rebuild before announcing the change: the callback repaints thumbnails,
    // and pdf.js cannot draw the same page into two canvases at once.
    await this.rebuild(p.index);
    this.cb.onStatus('Signature placed. Click again to place another, or switch tools when you are done.');
    this.cb.onEdited();
  }

  /** True for the error pdf.js raises when a newer render supersedes one. */
  private static isCancellation(e: unknown): boolean {
    const err = e as { message?: string; name?: string };
    return /cancel/i.test(err?.message ?? '') || err?.name === 'RenderingCancelledException';
  }

  /** Waits for every page render currently in flight to finish. */
  private async settleRenders(): Promise<void> {
    await Promise.allSettled(this.pages.map((p) => p.queue));
  }

  /**
   * Runs one document rebuild at a time, whoever asked for it.
   *
   * Every rebuild replaces the pdf.js document underneath the canvases, so two
   * of them overlapping is two sets of renders drawing from two different
   * files into the same page. Typing an edit and then dragging something while
   * it applies used to do exactly that, and the page settled on whichever
   * render happened to finish last: a composite of two versions of the
   * document, correct in neither.
   */
  private serialize<T>(job: () => Promise<T>): Promise<T> {
    const run = this.rebuildQueue.then(job);
    // Swallowed here only so a failure does not break the chain for whatever
    // is queued behind it. The caller still sees its own rejection.
    this.rebuildQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Rebuilds the document and repaints, shared by anything that changes it. */
  private async rebuild(onlyPage?: number): Promise<void> {
    return this.serialize(async () => {
      if (!this.doc) return;
      try {
        // Renders already running hold the document that is about to be
        // replaced; letting them finish first is what stops a cancelled render
        // leaving half a page behind.
        await this.settleRenders();
        await this.doc.refresh();
        await this.refreshRendered(onlyPage);
      } catch (e) {
        if (Viewer.isCancellation(e)) return;
        this.cb.onStatus(`Could not apply that: ${(e as Error).message}`, 'warn');
      } finally {
        // Unconditionally. A copy left floating over a page that was never
        // redrawn is worse than the wait it was there to hide, because it
        // shows the move as done when nothing happened.
        this.dropLifted();
      }
    });
  }

  /** Creates new text where the user clicked and opens it for typing. */
  private async placeText(p: RenderedPage, event: MouseEvent): Promise<void> {
    if (!this.doc || !this.doc.pdfjs) return;
    const rect = p.overlay.getBoundingClientRect();
    const jsPage = await this.doc.pdfjs.getPage(p.index + 1);
    const viewport = jsPage.getViewport({ scale: this.zoom });
    const [px, py] = viewport.convertToPdfPoint(event.clientX - rect.left, event.clientY - rect.top);

    // Not added to the document yet. Clicking somewhere is a statement of
    // intent, not an edit, and adding it here meant a click followed by Escape
    // left an empty piece of text behind: counted as an edit, sitting in the
    // undo history, and invisible because it had nothing to draw.
    const draft: TextInsertion = {
      id: 'draft',
      x: px,
      y: py,
      size: this.addSize,
      color: { ...this.addColor },
      text: '',
      bold: false,
      italic: false,
    };
    this.draftInsertion = true;
    this.openInsertionEditor(p, draft, viewport);
  }

  /** Whether the open editor belongs to text not yet added to the document. */
  private draftInsertion = false;

  private openInsertionEditor(
    p: RenderedPage,
    insertion: TextInsertion,
    viewport: { convertToViewportPoint(x: number, y: number): number[] },
  ): void {
    if (!this.doc) return;
    const draft = this.draftInsertion;
    this.closeEditor(true);
    this.draftInsertion = draft;

    const [ix, iy] = viewport.convertToViewportPoint(insertion.x, insertion.y);
    const sizePx = insertion.size * this.zoom;
    const cssFont = `${sizePx}px Helvetica, Arial, sans-serif`;
    const lineHeight = sizePx * 1.2;

    const editor = document.createElement('div');
    editor.className = 'line-editor line-editor-add';
    editor.contentEditable = 'plaintext-only';
    editor.spellcheck = false;
    editor.textContent = insertion.text;
    editor.style.font = cssFont;
    editor.style.color = `rgb(${Math.round(insertion.color.r * 255)},${Math.round(insertion.color.g * 255)},${Math.round(insertion.color.b * 255)})`;
    editor.style.lineHeight = `${lineHeight}px`;
    editor.style.left = `${ix}px`;
    editor.style.top = `${iy - baselineOffset(cssFont, lineHeight)}px`;
    editor.style.minWidth = `${sizePx * 4}px`;

    p.container.appendChild(editor);
    this.activeEditor = editor;
    this.activeInsertion = insertion;
    this.activePage = p;
    this.activeLine = null;

    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    editor.addEventListener('keydown', (e) => {
      // Shift+Enter adds a line; Enter alone finishes, matching the line editor.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void this.commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.closeEditor(true);
      }
      e.stopPropagation();
    });
    editor.addEventListener('blur', () => void this.commit());
    editor.addEventListener('click', (e) => e.stopPropagation());
  }

  /** Converts a line's PDF-space geometry into CSS pixels, honouring rotation. */
  private lineGeometry(
    line: TextLine,
    viewport: { convertToViewportPoint(x: number, y: number): number[] },
  ): { left: number; top: number; width: number; height: number; angle: number; baselineLeft: number; baselineTop: number } {
    const [bx, by] = viewport.convertToViewportPoint(line.startX, line.startY);
    const [ex, ey] = viewport.convertToViewportPoint(line.endX, line.endY);
    const dx = ex - bx;
    const dy = ey - by;
    const width = Math.hypot(dx, dy) || 1;
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;

    const size = line.fontSize * this.zoom;
    // A font's declared ascent is frequently smaller than the glyphs it draws,
    // and some report none at all, which put the top of every box on the caps.
    // Floors of roughly the usual ascender and descender keep the box around
    // the type rather than on it, without moving the baseline, which is the
    // one number here that has to stay exact.
    const ascent = Math.max((line.font.ascent / 1000) * size, size * 0.8);
    const descent = Math.max((Math.abs(line.font.descent) / 1000) * size, size * 0.24);
    const height = ascent + descent;

    return { left: bx, top: by - ascent, width, height, angle, baselineLeft: bx, baselineTop: by };
  }

  private cssFontFor(page: PageModel, line: TextLine, sizePx: number): string {
    const family = page.cssFonts.get(line.id);
    const generic = line.font.fixedPitch ? 'monospace' : line.font.serif ? 'serif' : 'sans-serif';

    // The embedded face already carries its own weight and slant. Asking for
    // bold or italic on top of it would make the browser synthesise a second
    // layer of emphasis, so those are only requested for the generic fallback.
    if (family) return `${sizePx}px ${family}, ${generic}`;

    const style = line.font.italic ? 'italic ' : '';
    const weight = line.font.bold ? '700 ' : '400 ';
    return `${style}${weight}${sizePx}px ${generic}`;
  }

  private select(line: TextLine | null, page?: RenderedPage): void {
    this.selectedLineId = line?.id ?? null;
    for (const p of this.pages) {
      for (const el of Array.from(p.overlay.children)) el.classList.remove('line-selected');
    }
    if (line && page) {
      const idx = page.model?.lines.indexOf(line) ?? -1;
      if (idx >= 0) page.overlay.children[idx]?.classList.add('line-selected');
    }
    this.cb.onSelect(line, page?.model ?? null);
  }

  private openEditor(
    p: RenderedPage,
    line: TextLine,
    viewport: { convertToViewportPoint(x: number, y: number): number[] },
  ): void {
    if (!this.doc || !p.model) return;
    this.closeEditor(true);

    const geo = this.lineGeometry(line, viewport);
    const sizePx = line.fontSize * this.zoom;
    const cssFont = this.cssFontFor(p.model, line, sizePx);
    const lineHeight = Math.max(geo.height, sizePx * 1.2);

    // Cover the original glyphs so the live text is the only one visible.
    const cover = document.createElement('div');
    cover.className = 'edit-cover';
    const rect = new DOMRect(geo.left, geo.top, geo.width, geo.height);
    const backingScale = p.canvas.width / Math.max(1, parseFloat(p.canvas.style.width));
    cover.style.background = sampleBackground(p.canvas, rect, backingScale);
    // Sized a little larger than the line was drawn. A cover cut exactly to
    // the measured extent leaves the tips of ascenders and the tails of
    // descenders showing around the live text, and two sets of glyphs half a
    // pixel apart read as the wrong font rather than as a leftover. The margin
    // scales with the type so it is the same at every zoom.
    // More room above than below. A line's measured box sits close under the
    // cap height, so ascenders and the outline drawn around them are what runs
    // out of the top; descenders have more room to begin with.
    const pad = Math.max(2, lineHeight * 0.12);
    cover.style.left = `${geo.left - pad}px`;
    cover.style.top = `${geo.top - pad * 1.4}px`;
    cover.style.width = `${geo.width + pad * 2.5}px`;
    cover.style.height = `${geo.height + pad * 2.2}px`;
    if (geo.angle) cover.style.transform = `rotate(${geo.angle}deg)`;
    cover.style.transformOrigin = 'left top';

    const editor = document.createElement('div');
    editor.className = 'line-editor';
    editor.contentEditable = 'plaintext-only';
    editor.spellcheck = false;
    editor.textContent = this.doc.textFor(p.index, line);
    editor.style.font = cssFont;
    editor.style.color = `rgb(${Math.round(line.fill.r * 255)},${Math.round(line.fill.g * 255)},${Math.round(line.fill.b * 255)})`;
    editor.style.lineHeight = `${lineHeight}px`;
    editor.style.left = `${geo.left}px`;
    editor.style.top = `${geo.baselineTop - baselineOffset(cssFont, lineHeight)}px`;
    editor.style.minWidth = `${geo.width}px`;
    editor.style.height = `${lineHeight}px`;
    if (geo.angle) editor.style.transform = `rotate(${geo.angle}deg)`;
    editor.style.transformOrigin = 'left top';

    // Mounted on the page rather than the overlay. The overlay is emptied and
    // rebuilt every time the page re-renders, which on a long document happens
    // while thumbnails are still being drawn, and it was taking the editor and
    // everything typed into it away mid sentence.
    p.container.append(cover, editor);
    this.activeEditor = editor;
    this.activeLine = line;
    this.activePage = p;

    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    editor.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void this.commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.closeEditor(true);
      }
      e.stopPropagation();
    });
    editor.addEventListener('blur', () => {
      void this.commit();
    });
    editor.addEventListener('click', (e) => e.stopPropagation());
  }

  /** Applies the in-progress edit and re-renders from the real PDF. */
  private async commit(): Promise<void> {
    const editor = this.activeEditor;
    const line = this.activeLine;
    const insertion = this.activeInsertion;
    const page = this.activePage;
    if (!editor || !page || !this.doc || (!line && !insertion)) return;

    // Detach first so the blur handler cannot re-enter during the rebuild.
    this.activeEditor = null;
    this.activeLine = null;
    this.activeInsertion = null;
    this.activePage = null;

    const raw = editor.textContent ?? '';
    const draft = this.draftInsertion;
    this.draftInsertion = false;
    const changed = insertion
      ? draft
        ? // Text typed into a fresh box joins the document now. A box left
          // empty never existed as far as the document is concerned.
          raw.trim().length > 0 && !!this.doc.addInsertion(page.index, { ...insertion, text: raw })
        : this.doc.setInsertionText(page.index, insertion.id, raw)
      : this.doc.setLineText(page.index, line!, raw.replace(/\n/g, ' '));
    editor.remove();
    page.container.querySelector('.edit-cover')?.remove();

    if (!changed) return;

    this.cb.onStatus('Applying edit…');
    try {
      // On the same chain as every other rebuild. This used to refresh on its
      // own, so an edit committing while a drag was being applied put two
      // rebuilds through at once and the page kept whichever finished last.
      const warnings = await this.serialize(async () => {
        if (!this.doc) return [];
        await this.settleRenders();
        const w = await this.doc.refresh();
        // Only the page that was typed on. A reflowed paragraph stays on its
        // own page, so nothing else on screen can have changed.
        await this.refreshRendered(page.index);
        return w;
      });
      this.dropLifted();
      this.cb.onEdited();
      const substituted = warnings.filter((w) => w.kind === 'substituted-font');
      if (substituted.length) {
        this.cb.onStatus(substituted[0].detail, 'warn');
      } else if (warnings.length) {
        this.cb.onStatus(warnings[0].detail, 'warn');
      } else if (this.doc.lastReflow > 1) {
        // Saying so matters: lines the user did not click on have changed, and
        // finding that out by noticing is worse than being told.
        this.cb.onStatus(`Edit applied, and the rest of the paragraph rewrapped.`);
      } else if (this.doc.lastOverflow > 0) {
        // The end of the line is on the page but off the paper, which looks
        // from here like text that simply stopped.
        this.cb.onStatus(
          `Edit applied, but the line now runs ${Math.round(this.doc.lastOverflow)} pt past the ` +
            'edge of the page, so the end of it will not be printed or shown.',
          'warn',
        );
      } else {
        this.cb.onStatus('Edit applied.');
      }
    } catch (e) {
      if (Viewer.isCancellation(e)) return;
      this.cb.onStatus(`Could not apply the edit: ${(e as Error).message}`, 'warn');
    }
  }

  closeEditor(discard: boolean): void {
    if (!this.activeEditor) return;
    if (!discard) {
      void this.commit();
      return;
    }
    this.activeEditor.remove();
    this.activePage?.container.querySelector('.edit-cover')?.remove();
    this.activeEditor = null;
    this.activeLine = null;
    this.activeInsertion = null;
    this.activePage = null;
    this.draftInsertion = false;
  }

  scrollToPage(index: number): void {
    this.pages[index]?.container.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /** Index of the page occupying most of the viewport. */
  currentPageIndex(): number {
    const rootRect = this.root.getBoundingClientRect();
    let best = 0;
    let bestArea = -1;
    for (const p of this.pages) {
      const r = p.container.getBoundingClientRect();
      const overlap = Math.min(r.bottom, rootRect.bottom) - Math.max(r.top, rootRect.top);
      if (overlap > bestArea) {
        bestArea = overlap;
        best = p.index;
      }
    }
    return best;
  }
}
