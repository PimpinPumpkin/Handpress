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
import {
  applyEdits,
  type EditWarning,
  type FontProvider,
  type ImageStamp,
  type ImageEdit,
  type LineEdit,
  type TextInsertion,
} from '../pdf/writer';
import { decryptToBytes } from '../pdf/decrypt';
import { describeSignatures, findSignatures, type SignatureReport } from '../pdf/signatures';
import { applyFormValues, readForm, type FormField } from '../pdf/forms';

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

interface EditState {
  edits: Map<number, Map<string, string>>;
  lineOffsets: Map<number, Map<string, { dx: number; dy: number }>>;
  imageEdits: Map<number, Map<string, ImageEdit>>;
  insertions: Map<number, Map<string, TextInsertion>>;
  stamps: Map<number, Map<string, ImageStamp>>;
  formValues: Map<string, string>;
}

export interface LoadReport {
  pageCount: number;
  /** Pages with no extractable text at all, which usually means a scan. */
  scannedPages: number[];
  /** True when the file arrived encrypted and was unlocked on the way in. */
  wasEncrypted: boolean;
  /** What the document declares about its own digital signatures. */
  signatures: SignatureReport;
  /** One sentence naming the risk, or null when the document is unsigned. */
  signatureWarning: string | null;
}

export class VellumDocument {
  readonly name: string;
  private originalBytes: Uint8Array;
  /** pageIndex -> lineId -> replacement text. */
  private edits = new Map<number, Map<string, string>>();
  /** pageIndex -> lineId -> how far that line has been dragged, in page units. */
  private lineOffsets = new Map<number, Map<string, { dx: number; dy: number }>>();
  /** pageIndex -> image id -> how that image has been moved, resized or removed. */
  private imageEdits = new Map<number, Map<string, ImageEdit>>();
  /** pageIndex -> insertion id -> text added where the page had none. */
  private insertions = new Map<number, Map<string, TextInsertion>>();
  /** pageIndex -> stamp id -> image placed on the page, such as a signature. */
  private stamps = new Map<number, Map<string, ImageStamp>>();
  /** Interactive form field values, keyed by the field's own name. */
  private formValues = new Map<string, string>();
  /** Fields as the original document declares them, read once. */
  private formFields: FormField[] = [];
  /**
   * History as whole-state snapshots rather than per-change deltas.
   *
   * There are two kinds of change now, edits and insertions, and the state is
   * only ever a little text, so snapshotting is far cheaper to reason about
   * than composing inverse operations for each kind.
   */
  private undoStack: EditState[] = [];
  private redoStack: EditState[] = [];
  private nextInsertionId = 1;
  private nextStampId = 1;

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

  /**
   * Opens a file, decrypting it first when necessary.
   *
   * Permission-locked documents are decrypted up front and then treated as
   * ordinary ones, so nothing downstream has to know about encryption. Throws
   * DecryptionError when the file genuinely needs a password.
   */
  static async open(name: string, bytes: Uint8Array): Promise<{ doc: VellumDocument; report: LoadReport }> {
    const { bytes: plain, wasEncrypted } = await decryptToBytes(bytes);
    const doc = new VellumDocument(name, plain);
    const report = await doc.reload();
    report.wasEncrypted = wasEncrypted;
    return { doc, report };
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

    const scannedPages: number[] = [];
    // Only the first few pages are probed up front; the rest resolve lazily.
    const probe = Math.min(this.pageCount, 5);
    for (let i = 0; i < probe; i++) {
      const model = await this.getPage(i).catch(() => null);
      if (model && model.lines.length === 0) scannedPages.push(i);
    }

    // Signatures are read from the original file, since that is what a reader
    // would be verifying against.
    let signatures: SignatureReport = { signatures: [], emptyFields: 0 };
    try {
      const libDoc = await PDFDocument.load(this.originalBytes.slice(), {
        throwOnInvalidObject: false,
        updateMetadata: false,
      });
      signatures = findSignatures(libDoc);
      this.formFields = readForm(libDoc).fields;
    } catch {
      // An unreadable object graph simply reports no signatures.
    }

    return {
      pageCount: this.pageCount,
      scannedPages,
      wasEncrypted: false,
      signatures,
      signatureWarning: describeSignatures(signatures),
    };
  }

  get pdfjs(): PDFDocumentProxy | null {
    return this.pdfjsDoc;
  }

  get bytes(): Uint8Array {
    return this.currentBytes;
  }

  hasEdits(): boolean {
    for (const m of this.edits.values()) if (m.size) return true;
    for (const m of this.lineOffsets.values()) if (m.size) return true;
    for (const m of this.imageEdits.values()) if (m.size) return true;
    for (const m of this.insertions.values()) if (m.size) return true;
    for (const m of this.stamps.values()) if (m.size) return true;
    return this.formValues.size > 0;
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
    for (const m of this.lineOffsets.values()) n += m.size;
    for (const m of this.imageEdits.values()) n += m.size;
    for (const m of this.insertions.values()) n += m.size;
    for (const m of this.stamps.values()) n += m.size;
    return n + this.formValues.size;
  }

  /** Text currently shown for a line, which may differ from the file's text. */
  textFor(pageIndex: number, line: TextLine): string {
    return this.edits.get(pageIndex)?.get(line.id) ?? line.text;
  }

  isEdited(pageIndex: number, lineId: string): boolean {
    return this.edits.get(pageIndex)?.has(lineId) ?? false;
  }

  private snapshot(): EditState {
    return {
      edits: new Map([...this.edits].map(([k, v]) => [k, new Map(v)])),
      lineOffsets: new Map([...this.lineOffsets].map(([k, v]) => [k, new Map([...v].map(([i, o]) => [i, { ...o }]))])),
      imageEdits: new Map([...this.imageEdits].map(([k, v]) => [k, new Map([...v].map(([i, o]) => [i, { ...o }]))])),
      insertions: new Map([...this.insertions].map(([k, v]) => [k, new Map([...v].map(([i, x]) => [i, { ...x }]))])),
      stamps: new Map([...this.stamps].map(([k, v]) => [k, new Map([...v].map(([i, x]) => [i, { ...x }]))])),
      formValues: new Map(this.formValues),
    };
  }

  private restore(state: EditState): void {
    this.edits = state.edits;
    this.lineOffsets = state.lineOffsets;
    this.imageEdits = state.imageEdits;
    this.insertions = state.insertions;
    this.stamps = state.stamps;
    this.formValues = state.formValues;
  }

  /** Records an edit. Returns false when the text is unchanged. */
  setLineText(pageIndex: number, line: TextLine, newText: string): boolean {
    const current = this.textFor(pageIndex, line);
    if (current === newText) return false;

    const before = this.snapshot();
    let pageEdits = this.edits.get(pageIndex);
    if (!pageEdits) {
      pageEdits = new Map();
      this.edits.set(pageIndex, pageEdits);
    }
    if (newText === line.text) pageEdits.delete(line.id);
    else pageEdits.set(line.id, newText);

    this.undoStack.push(before);
    this.redoStack = [];
    return true;
  }

  /** Adds new text at a point on a page and returns it. */
  addInsertion(pageIndex: number, insertion: Omit<TextInsertion, 'id'>): TextInsertion {
    const before = this.snapshot();
    const created: TextInsertion = { ...insertion, id: `ins${this.nextInsertionId++}` };
    let page = this.insertions.get(pageIndex);
    if (!page) {
      page = new Map();
      this.insertions.set(pageIndex, page);
    }
    page.set(created.id, created);
    this.undoStack.push(before);
    this.redoStack = [];
    return created;
  }

  /** Current move, scale and removal state for an image already on the page. */
  imageEditFor(pageIndex: number, imageId: string): ImageEdit {
    return (
      this.imageEdits.get(pageIndex)?.get(imageId) ?? { imageId, dx: 0, dy: 0, scale: 1, remove: false }
    );
  }

  /** Applies a change to an image already in the document. */
  editImage(pageIndex: number, imageId: string, change: Partial<Omit<ImageEdit, 'imageId'>>): boolean {
    const current = this.imageEditFor(pageIndex, imageId);
    const next: ImageEdit = {
      imageId,
      dx: current.dx + (change.dx ?? 0),
      dy: current.dy + (change.dy ?? 0),
      scale: change.scale !== undefined ? current.scale * change.scale : current.scale,
      remove: change.remove ?? current.remove,
    };
    const unchanged =
      Math.abs(next.dx - current.dx) < 0.01 &&
      Math.abs(next.dy - current.dy) < 0.01 &&
      Math.abs(next.scale - current.scale) < 0.001 &&
      next.remove === current.remove;
    if (unchanged) return false;

    const before = this.snapshot();
    let page = this.imageEdits.get(pageIndex);
    if (!page) {
      page = new Map();
      this.imageEdits.set(pageIndex, page);
    }
    // Back to exactly as it was found means there is nothing to record.
    const isIdentity = Math.abs(next.dx) < 0.01 && Math.abs(next.dy) < 0.01 && Math.abs(next.scale - 1) < 0.001 && !next.remove;
    if (isIdentity) page.delete(imageId);
    else page.set(imageId, next);
    this.undoStack.push(before);
    this.redoStack = [];
    return true;
  }

  /** Moves an existing line of the document by a page-space delta. */
  moveLine(pageIndex: number, lineId: string, dx: number, dy: number): boolean {
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return false;
    const before = this.snapshot();
    let page = this.lineOffsets.get(pageIndex);
    if (!page) {
      page = new Map();
      this.lineOffsets.set(pageIndex, page);
    }
    const existing = page.get(lineId) ?? { dx: 0, dy: 0 };
    const next = { dx: existing.dx + dx, dy: existing.dy + dy };
    // Dragged back to where it started means there is nothing to record.
    if (Math.abs(next.dx) < 0.01 && Math.abs(next.dy) < 0.01) page.delete(lineId);
    else page.set(lineId, next);
    this.undoStack.push(before);
    this.redoStack = [];
    return true;
  }

  /** How far a line has been dragged so far. */
  offsetFor(pageIndex: number, lineId: string): { dx: number; dy: number } {
    return this.lineOffsets.get(pageIndex)?.get(lineId) ?? { dx: 0, dy: 0 };
  }

  /** Moves added text by a page-space delta. */
  moveInsertion(pageIndex: number, id: string, dx: number, dy: number): boolean {
    const existing = this.insertions.get(pageIndex)?.get(id);
    if (!existing || (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01)) return false;
    const before = this.snapshot();
    this.insertions.get(pageIndex)!.set(id, { ...existing, x: existing.x + dx, y: existing.y + dy });
    this.undoStack.push(before);
    this.redoStack = [];
    return true;
  }

  /** Moves a placed image by a page-space delta. */
  moveStamp(pageIndex: number, id: string, dx: number, dy: number): boolean {
    const existing = this.stamps.get(pageIndex)?.get(id);
    if (!existing || (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01)) return false;
    const before = this.snapshot();
    this.stamps.get(pageIndex)!.set(id, { ...existing, x: existing.x + dx, y: existing.y + dy });
    this.undoStack.push(before);
    this.redoStack = [];
    return true;
  }

  /** Updates added text. Empty text removes it, which is how deleting works. */
  setInsertionText(pageIndex: number, id: string, text: string): boolean {
    const page = this.insertions.get(pageIndex);
    const existing = page?.get(id);
    if (!existing || existing.text === text) return false;

    const before = this.snapshot();
    if (text.trim().length === 0) page!.delete(id);
    else page!.set(id, { ...existing, text });
    this.undoStack.push(before);
    this.redoStack = [];
    return true;
  }

  insertionsFor(pageIndex: number): TextInsertion[] {
    return [...(this.insertions.get(pageIndex)?.values() ?? [])];
  }

  /** Places an image on a page and returns it. */
  addStamp(pageIndex: number, stamp: Omit<ImageStamp, 'id'>): ImageStamp {
    const before = this.snapshot();
    const created: ImageStamp = { ...stamp, id: `stamp${this.nextStampId++}` };
    let page = this.stamps.get(pageIndex);
    if (!page) {
      page = new Map();
      this.stamps.set(pageIndex, page);
    }
    page.set(created.id, created);
    this.undoStack.push(before);
    this.redoStack = [];
    return created;
  }

  removeStamp(pageIndex: number, id: string): boolean {
    const page = this.stamps.get(pageIndex);
    if (!page?.has(id)) return false;
    const before = this.snapshot();
    page.delete(id);
    this.undoStack.push(before);
    this.redoStack = [];
    return true;
  }

  stampsFor(pageIndex: number): ImageStamp[] {
    return [...(this.stamps.get(pageIndex)?.values() ?? [])];
  }

  /** Fillable fields on a page, with any pending value already applied. */
  fieldsFor(pageIndex: number): FormField[] {
    return this.formFields
      .filter((f) => f.pageIndex === pageIndex)
      .map((f) => ({ ...f, value: this.formValues.get(f.name) ?? f.value }));
  }

  hasForm(): boolean {
    return this.formFields.length > 0;
  }

  setFieldValue(name: string, value: string): boolean {
    const current = this.formFields.find((f) => f.name === name);
    if (!current) return false;
    if ((this.formValues.get(name) ?? current.value) === value) return false;

    const before = this.snapshot();
    // Matching the document's own value again means there is nothing to write.
    if (value === current.value) this.formValues.delete(name);
    else this.formValues.set(name, value);
    this.undoStack.push(before);
    this.redoStack = [];
    return true;
  }

  undo(): boolean {
    const previous = this.undoStack.pop();
    if (!previous) return false;
    this.redoStack.push(this.snapshot());
    this.restore(previous);
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.snapshot());
    this.restore(next);
    return true;
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

    const touchedPages = new Set<number>([
      ...this.edits.keys(),
      ...this.lineOffsets.keys(),
      ...this.imageEdits.keys(),
      ...this.insertions.keys(),
      ...this.stamps.keys(),
    ]);
    for (const pageIndex of touchedPages) {
      const pageEdits = this.edits.get(pageIndex) ?? new Map<string, string>();
      const pageOffsets = this.lineOffsets.get(pageIndex) ?? new Map<string, { dx: number; dy: number }>();
      const pageInsertions = [...(this.insertions.get(pageIndex)?.values() ?? [])];
      const pageStamps = [...(this.stamps.get(pageIndex)?.values() ?? [])];
      const pageImages = [...(this.imageEdits.get(pageIndex)?.values() ?? [])];
      if (!pageEdits.size && !pageOffsets.size && !pageInsertions.length && !pageStamps.length && !pageImages.length) {
        continue;
      }
      try {
        if (pageIndex >= doc.getPageCount()) continue;

        const page = doc.getPage(pageIndex);
        const content = getPageContent(page);
        const walk = walkPage(content.bytes, content.resources);
        const lines = groupLines(walk.ops);
        // A line may be retyped, moved, or both, so the two maps are merged and
        // anything without a text change keeps the text it already had.
        const list: LineEdit[] = [];
        const byId = new Map(lines.map((l) => [l.id, l]));
        for (const lineId of new Set([...pageEdits.keys(), ...pageOffsets.keys()])) {
          const line = byId.get(lineId);
          if (!line) continue;
          const offset = pageOffsets.get(lineId);
          list.push({
            lineId,
            newText: pageEdits.get(lineId) ?? line.text,
            dx: offset?.dx ?? 0,
            dy: offset?.dy ?? 0,
          });
        }

        const result = await applyEdits(
          doc,
          page,
          walk,
          lines,
          list,
          content.bytes,
          this.fontProvider,
          pageInsertions,
          pageStamps,
          pageImages,
        );
        warnings.push(...result.warnings);
      } catch (e) {
        warnings.push({
          lineId: `page ${pageIndex + 1}`,
          kind: 'stream-missing',
          detail: `page ${pageIndex + 1} could not be rewritten: ${(e as Error).message}`,
        });
      }
    }

    // Field values are written last, so appearance regeneration sees the final
    // state of the page rather than something a later edit would change.
    for (const w of applyFormValues(doc, this.formValues)) {
      warnings.push({ lineId: w.field, kind: 'unencodable', detail: w.detail });
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
      // A damaged object graph must degrade to "no editable text on this page"
      // rather than take down the session; plenty of real files are broken.
      try {
        // pdf-lib parses the object graph for the text model; pdf.js renders pixels.
        const libDoc = await PDFDocument.load(this.originalBytes.slice(), {
          throwOnInvalidObject: false,
          updateMetadata: false,
        });

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
      } catch {
        const jsPage = await this.pdfjsDoc.getPage(index + 1).catch(() => null);
        const viewport = jsPage?.getViewport({ scale: 1 });
        model = {
          index,
          width: viewport?.width ?? 612,
          height: viewport?.height ?? 792,
          rotation: 0,
          lines: [],
          walk: { ops: [], images: [], streams: new Map(), fonts: new Map(), resources: new Map() },
          contentBytes: new Uint8Array(0),
          cssFonts: new Map(),
        };
      }
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
