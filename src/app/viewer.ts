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

import type { PageModel, VellumDocument } from './model';
import type { TextLine } from '../pdf/content';

export interface ViewerCallbacks {
  onSelect(line: TextLine | null, page: PageModel | null): void;
  onEdited(): void;
  onStatus(message: string, tone?: 'info' | 'warn'): void;
}

interface RenderedPage {
  index: number;
  container: HTMLElement;
  canvas: HTMLCanvasElement;
  overlay: HTMLElement;
  model: PageModel | null;
  renderedZoom: number;
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
 * Estimates the page background immediately around a line, used to hide the
 * original text while its replacement is being typed.
 */
function sampleBackground(canvas: HTMLCanvasElement, rect: DOMRect, dpr: number): string {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return '#ffffff';
  const counts = new Map<string, number>();
  const probeY = [rect.top - 3, rect.bottom + 3];
  const probeX = [rect.left + 2, rect.left + rect.width / 2, rect.right - 2];

  for (const y of probeY) {
    for (const x of probeX) {
      const px = Math.round(x * dpr);
      const py = Math.round(y * dpr);
      if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue;
      try {
        const d = ctx.getImageData(px, py, 1, 1).data;
        const key = `${d[0]},${d[1]},${d[2]}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      } catch {
        return '#ffffff';
      }
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

export class Viewer {
  readonly root: HTMLElement;
  private doc: VellumDocument | null = null;
  private pages: RenderedPage[] = [];
  private zoom = 1;
  private cb: ViewerCallbacks;
  private activeEditor: HTMLElement | null = null;
  private activeLine: TextLine | null = null;
  private activePage: RenderedPage | null = null;
  private selectedLineId: string | null = null;
  private renderToken = 0;
  private observer: IntersectionObserver | null = null;

  constructor(root: HTMLElement, cb: ViewerCallbacks) {
    this.root = root;
    this.cb = cb;
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

  async load(doc: VellumDocument): Promise<void> {
    this.doc = doc;
    this.root.innerHTML = '';
    this.pages = [];
    this.observer?.disconnect();

    const strip = document.createElement('div');
    strip.className = 'page-strip';
    this.root.appendChild(strip);

    for (let i = 0; i < doc.pageCount; i++) {
      const container = document.createElement('div');
      container.className = 'page';
      container.dataset.page = String(i);

      const canvas = document.createElement('canvas');
      canvas.className = 'page-canvas';
      const overlay = document.createElement('div');
      overlay.className = 'page-overlay';

      const label = document.createElement('div');
      label.className = 'page-label';
      label.textContent = String(i + 1);

      container.append(canvas, overlay, label);
      strip.appendChild(container);
      this.pages.push({ index: i, container, canvas, overlay, model: null, renderedZoom: 0 });
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
    await this.renderPage(0);
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
  async refreshRendered(): Promise<void> {
    const token = ++this.renderToken;
    for (const p of this.pages) {
      p.renderedZoom = 0;
      p.model = null;
    }
    if (token !== this.renderToken) return;
    await this.renderVisible();
  }

  private async renderPage(index: number): Promise<void> {
    const p = this.pages[index];
    if (!p || !this.doc?.pdfjs) return;
    if (p.renderedZoom === this.zoom && p.model) return;

    const token = this.renderToken;
    const jsPage = await this.doc.pdfjs.getPage(index + 1);
    const viewport = jsPage.getViewport({ scale: this.zoom });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    p.canvas.width = Math.floor(viewport.width * dpr);
    p.canvas.height = Math.floor(viewport.height * dpr);
    p.canvas.style.width = `${Math.floor(viewport.width)}px`;
    p.canvas.style.height = `${Math.floor(viewport.height)}px`;
    p.container.style.width = `${Math.floor(viewport.width)}px`;
    p.container.style.height = `${Math.floor(viewport.height)}px`;

    const ctx = p.canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, p.canvas.width, p.canvas.height);

    // Device pixel scaling goes through pdf.js's own transform hook rather than
    // a pre-set canvas transform, which it would otherwise compose incorrectly.
    await jsPage.render({
      canvasContext: ctx,
      viewport,
      canvas: p.canvas,
      transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
    }).promise;
    if (token !== this.renderToken) return;

    p.model = await this.doc.getPage(index);
    p.renderedZoom = this.zoom;
    this.buildOverlay(p, viewport);
  }

  private buildOverlay(p: RenderedPage, viewport: { convertToViewportPoint(x: number, y: number): number[] }): void {
    p.overlay.innerHTML = '';
    if (!p.model || !this.doc) return;

    for (const line of p.model.lines) {
      const box = document.createElement('div');
      box.className = 'line-box';
      if (!line.editable) box.classList.add('line-locked');
      if (this.doc.isEdited(p.index, line.id)) box.classList.add('line-edited');
      if (this.selectedLineId === line.id) box.classList.add('line-selected');

      const geo = this.lineGeometry(line, viewport);
      box.style.left = `${geo.left}px`;
      box.style.top = `${geo.top}px`;
      box.style.width = `${geo.width}px`;
      box.style.height = `${geo.height}px`;
      if (geo.angle) box.style.transform = `rotate(${geo.angle}deg)`;
      box.style.transformOrigin = 'left top';
      box.title = line.editable
        ? this.doc.textFor(p.index, line)
        : 'This text uses a font with no reliable character mapping, so it cannot be edited safely.';

      box.addEventListener('mousedown', (e) => e.preventDefault());
      box.addEventListener('click', (e) => {
        e.stopPropagation();
        this.select(line, p);
        if (line.editable) this.openEditor(p, line, viewport);
        else this.cb.onStatus('That text uses a font Vellum cannot map to characters, so editing it is disabled.', 'warn');
      });

      p.overlay.appendChild(box);
    }
  }

  /** Converts a line's PDF-space geometry into CSS pixels, honouring rotation. */
  private lineGeometry(
    line: TextLine,
    viewport: { convertToViewportPoint(x: number, y: number): number[] },
  ): { left: number; top: number; width: number; height: number; angle: number; baselineLeft: number; baselineTop: number } {
    const [bx, by] = viewport.convertToViewportPoint(line.x0, line.baselineY);
    const [ex, ey] = viewport.convertToViewportPoint(line.x1, line.baselineY);
    const dx = ex - bx;
    const dy = ey - by;
    const width = Math.hypot(dx, dy) || 1;
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;

    const size = line.fontSize * this.zoom;
    const ascent = (line.font.ascent / 1000) * size;
    const descent = (Math.abs(line.font.descent) / 1000) * size;
    const height = Math.max(ascent + descent, size * 1.1);

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
    cover.style.background = sampleBackground(p.canvas, rect, Math.min(window.devicePixelRatio || 1, 2));
    cover.style.left = `${geo.left - 1}px`;
    cover.style.top = `${geo.top}px`;
    cover.style.width = `${geo.width + 4}px`;
    cover.style.height = `${geo.height}px`;
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

    p.overlay.append(cover, editor);
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
    const page = this.activePage;
    if (!editor || !line || !page || !this.doc) return;

    // Detach first so the blur handler cannot re-enter during the rebuild.
    this.activeEditor = null;
    this.activeLine = null;
    this.activePage = null;

    const newText = (editor.textContent ?? '').replace(/\n/g, ' ');
    const changed = this.doc.setLineText(page.index, line, newText);
    editor.remove();
    page.overlay.querySelector('.edit-cover')?.remove();

    if (!changed) return;

    this.cb.onStatus('Applying edit…');
    try {
      const warnings = await this.doc.refresh();
      await this.refreshRendered();
      this.cb.onEdited();
      const substituted = warnings.filter((w) => w.kind === 'substituted-font');
      if (substituted.length) {
        this.cb.onStatus(substituted[0].detail, 'warn');
      } else if (warnings.length) {
        this.cb.onStatus(warnings[0].detail, 'warn');
      } else {
        this.cb.onStatus('Edit applied.');
      }
    } catch (e) {
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
    this.activePage?.overlay.querySelector('.edit-cover')?.remove();
    this.activeEditor = null;
    this.activeLine = null;
    this.activePage = null;
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
