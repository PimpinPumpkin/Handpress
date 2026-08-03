/**
 * Document model.
 *
 * Holds the original file bytes plus the set of edits made against them. Output
 * is always produced by replaying every edit onto a fresh copy of the original,
 * never by editing an already-edited document. That keeps undo exact, avoids
 * compounding rounding, and means a save is reproducible from the edit list
 * alone.
 */

import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { getPageContent } from '../pdf/page';
import { groupLines, walkPage, type TextLine, type WalkResult } from '../pdf/content';
import { applyEdits, type EditWarning, type FontProvider, type LineEdit } from '../pdf/writer';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface PageModel {
  index: number;
  width: number;
  height: number;
  rotation: number;
  lines: TextLine[];
  walk: WalkResult;
  contentBytes: Uint8Array;
  /** CSS font-family per line id, taken from pdf.js so editing shows the real font. */
  cssFonts: Map<string, string>;
}

export interface LoadReport {
  pageCount: number;
  /** Pages with no extractable text at all, which usually means a scan. */
  scannedPages: number[];
  encrypted: boolean;
}

export class VellumDocument {
  readonly name: string;
  private originalBytes: Uint8Array;
  /** pageIndex -> lineId -> replacement text. */
  private edits = new Map<number, Map<string, string>>();
  private undoStack: Array<{ page: number; lineId: string; before: string | undefined }> = [];
  private redoStack: Array<{ page: number; lineId: string; before: string | undefined; after: string | undefined }> = [];

  private pdfjsDoc: PDFDocumentProxy | null = null;
  private loadingTask: PDFDocumentLoadingTask | null = null;
  /**
   * Text models keyed by page, always derived from the original file.
   *
   * Line ids encode the operator's position in the content stream, so they only
   * stay meaningful against one fixed version of the document. Deriving them
   * from the original, never from an already-edited rebuild, keeps every
   * recorded edit addressable no matter how many edits precede it.
   */
  private lineCache = new Map<number, PageModel>();
  /** CSS font names, which belong to the current pdf.js instance and reset with it. */
  private cssFontCache = new Map<number, Map<string, string>>();
  /** Bytes currently rendered, which include all committed edits. */
  private currentBytes: Uint8Array;

  pageCount = 0;
  lastWarnings: EditWarning[] = [];
  /** Optional source of real typefaces for substitutions. */
  fontProvider: FontProvider | null = null;

  private constructor(name: string, bytes: Uint8Array) {
    this.name = name;
    this.originalBytes = bytes;
    this.currentBytes = bytes;
  }

  static async open(name: string, bytes: Uint8Array): Promise<{ doc: VellumDocument; report: LoadReport }> {
    const doc = new VellumDocument(name, bytes);
    const report = await doc.reload();
    return { doc, report };
  }

  /** True when the file is encrypted, which blocks writing. */
  static async isEncrypted(bytes: Uint8Array): Promise<boolean> {
    try {
      await PDFDocument.load(bytes.slice(), { throwOnInvalidObject: false, updateMetadata: false });
      return false;
    } catch (e) {
      return /encrypted/i.test((e as Error).message);
    }
  }

  private async reload(): Promise<LoadReport> {
    if (this.loadingTask) {
      // Tearing down the old worker before starting a new one keeps memory flat
      // across the many reloads that editing produces.
      await this.loadingTask.destroy().catch(() => undefined);
      this.loadingTask = null;
      this.pdfjsDoc = null;
    }
    // Line models survive a reload; only the pdf.js-derived font names reset.
    this.cssFontCache.clear();

    // pdf.js takes ownership of the buffer it is given, so it gets a copy.
    this.loadingTask = pdfjs.getDocument({
      data: this.currentBytes.slice(),
      useSystemFonts: true,
    });
    this.pdfjsDoc = await this.loadingTask.promise;
    this.pageCount = this.pdfjsDoc.numPages;

    const encrypted = await VellumDocument.isEncrypted(this.currentBytes);
    const scannedPages: number[] = [];
    if (!encrypted) {
      // Only the first few pages are probed up front; the rest resolve lazily.
      const probe = Math.min(this.pageCount, 5);
      for (let i = 0; i < probe; i++) {
        const model = await this.getPage(i);
        if (model && model.lines.length === 0) scannedPages.push(i);
      }
    }

    return { pageCount: this.pageCount, scannedPages, encrypted };
  }

  get pdfjs(): PDFDocumentProxy | null {
    return this.pdfjsDoc;
  }

  get bytes(): Uint8Array {
    return this.currentBytes;
  }

  hasEdits(): boolean {
    for (const m of this.edits.values()) if (m.size) return true;
    return false;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  editCount(): number {
    let n = 0;
    for (const m of this.edits.values()) n += m.size;
    return n;
  }

  /** Text currently shown for a line, which may differ from the file's text. */
  textFor(pageIndex: number, line: TextLine): string {
    return this.edits.get(pageIndex)?.get(line.id) ?? line.text;
  }

  isEdited(pageIndex: number, lineId: string): boolean {
    return this.edits.get(pageIndex)?.has(lineId) ?? false;
  }

  /** Records an edit. Returns false when the text is unchanged. */
  setLineText(pageIndex: number, line: TextLine, newText: string): boolean {
    const current = this.textFor(pageIndex, line);
    if (current === newText) return false;

    let pageEdits = this.edits.get(pageIndex);
    if (!pageEdits) {
      pageEdits = new Map();
      this.edits.set(pageIndex, pageEdits);
    }
    const before = pageEdits.get(line.id);
    if (newText === line.text) pageEdits.delete(line.id);
    else pageEdits.set(line.id, newText);

    this.undoStack.push({ page: pageIndex, lineId: line.id, before });
    this.redoStack = [];
    return true;
  }

  undo(): number | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    const pageEdits = this.edits.get(entry.page) ?? new Map<string, string>();
    const after = pageEdits.get(entry.lineId);
    if (entry.before === undefined) pageEdits.delete(entry.lineId);
    else pageEdits.set(entry.lineId, entry.before);
    this.edits.set(entry.page, pageEdits);
    this.redoStack.push({ ...entry, after });
    return entry.page;
  }

  redo(): number | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    const pageEdits = this.edits.get(entry.page) ?? new Map<string, string>();
    if (entry.after === undefined) pageEdits.delete(entry.lineId);
    else pageEdits.set(entry.lineId, entry.after);
    this.edits.set(entry.page, pageEdits);
    this.undoStack.push({ page: entry.page, lineId: entry.lineId, before: entry.before });
    return entry.page;
  }

  /**
   * Builds the edited PDF by replaying every edit onto a fresh copy of the
   * original file.
   */
  async build(): Promise<{ bytes: Uint8Array; warnings: EditWarning[] }> {
    const doc = await PDFDocument.load(this.originalBytes.slice(), {
      throwOnInvalidObject: false,
      updateMetadata: false,
    });
    const warnings: EditWarning[] = [];

    for (const [pageIndex, pageEdits] of this.edits) {
      if (!pageEdits.size) continue;
      if (pageIndex >= doc.getPageCount()) continue;

      const page = doc.getPage(pageIndex);
      const content = getPageContent(page);
      const walk = walkPage(content.bytes, content.resources);
      const lines = groupLines(walk.ops);
      const list: LineEdit[] = [];
      for (const [lineId, newText] of pageEdits) list.push({ lineId, newText });

      const result = await applyEdits(doc, page, walk, lines, list, content.bytes, this.fontProvider);
      warnings.push(...result.warnings);
    }

    const bytes = await doc.save({ useObjectStreams: false });
    this.lastWarnings = warnings;
    return { bytes, warnings };
  }

  /** Rebuilds and re-renders so the canvas shows exactly what a save would produce. */
  async refresh(): Promise<EditWarning[]> {
    const { bytes, warnings } = await this.build();
    this.currentBytes = bytes;
    await this.reload();
    return warnings;
  }

  async getPage(index: number): Promise<PageModel | null> {
    if (!this.pdfjsDoc || index < 0 || index >= this.pageCount) return null;

    let model = this.lineCache.get(index);
    if (!model) {
      // pdf-lib parses the object graph for the text model; pdf.js renders pixels.
      const libDoc = await PDFDocument.load(this.originalBytes.slice(), {
        throwOnInvalidObject: false,
        updateMetadata: false,
      }).catch(() => null);
      if (!libDoc) return null;

      const page = libDoc.getPage(index);
      const content = getPageContent(page);
      const walk = walkPage(content.bytes, content.resources);
      const lines = groupLines(walk.ops);

      const jsPage = await this.pdfjsDoc.getPage(index + 1);
      const viewport = jsPage.getViewport({ scale: 1 });

      model = {
        index,
        width: viewport.width,
        height: viewport.height,
        rotation: content.rotation,
        lines,
        walk,
        contentBytes: content.bytes,
        cssFonts: new Map(),
      };
      this.lineCache.set(index, model);
    }

    let cssFonts = this.cssFontCache.get(index);
    if (!cssFonts) {
      const jsPage = await this.pdfjsDoc.getPage(index + 1);
      cssFonts = await mapCssFonts(jsPage, model.lines);
      this.cssFontCache.set(index, cssFonts);
    }
    model.cssFonts = cssFonts;
    return model;
  }
}

/**
 * Associates each line with the CSS font pdf.js registered for it.
 *
 * pdf.js installs an @font-face for every embedded font, so the edit overlay can
 * be styled with the document's actual typeface instead of an approximation.
 * Matching is by baseline position, which is stable across both text models.
 */
async function mapCssFonts(
  jsPage: Awaited<ReturnType<PDFDocumentProxy['getPage']>>,
  lines: TextLine[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const tc = await jsPage.getTextContent({ includeMarkedContent: false, disableNormalization: true });
    const styles = tc.styles as Record<string, { fontFamily?: string }>;
    const items = tc.items as Array<{ transform?: number[]; fontName?: string; str?: string }>;

    const points = items
      .filter((i) => i.transform && (i.str ?? '').length > 0)
      .map((i) => ({ x: i.transform![4], y: i.transform![5], font: i.fontName ?? '' }));

    for (const line of lines) {
      let best: { d: number; font: string } | null = null;
      for (const p of points) {
        const d = Math.abs(p.x - line.x0) + Math.abs(p.y - line.baselineY) * 3;
        if (!best || d < best.d) best = { d, font: p.font };
      }
      if (best && best.d < 40 && best.font) {
        // pdf.js registers each embedded font under its internal name, so that
        // name is the family to ask for; the reported fontFamily is only the
        // generic fallback to use when the real face fails to load.
        const fallback = styles[best.font]?.fontFamily;
        out.set(line.id, fallback ? `"${best.font}", ${fallback}` : `"${best.font}"`);
      }
    }
  } catch {
    // Falling back to generic families is acceptable; only appearance suffers.
  }
  return out;
}
