/**
 * Document model.
 *
 * Holds the original file bytes plus the set of edits made against them. Output
 * is always produced by replaying every edit onto a fresh copy of the original,
 * never by editing an already-edited document. That keeps undo exact, avoids
 * compounding rounding, and means a save is reproducible from the edit list
 * alone.
 */

import { degrees, PDFDocument, type PDFPage } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { getPageContent } from '../pdf/page';
import { charsInRect, groupLines, walkPage, type TextLine, type WalkResult } from '../pdf/content';
import {
  applyEdits,
  type EditWarning,
  type FontProvider,
  type ImageStamp,
  type ImageEdit,
  type LineEdit,
  type RectFill,
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
  erasures: Map<number, Map<string, RectFill>>;
  redactions: Map<number, Map<string, RedactionArea>>;
  insertions: Map<number, Map<string, TextInsertion>>;
  stamps: Map<number, Map<string, ImageStamp>>;
  formValues: Map<string, string>;
  /** Page order and rotation, as a list of operations against the original. */
  pagePlan: PagePlanEntry[];
  extraDocs: Array<{ name: string; bytes: Uint8Array }>;
}

/**
 * One page of the output, naming which original page it comes from.
 *
 * Page operations are held as a plan rather than applied eagerly, so they
 * compose with every other edit and undo the same way. Deleting a page removes
 * its entry; reordering moves entries; rotating changes one field.
 */
export interface PagePlanEntry {
  /**
   * Which loaded file the page comes from. Zero is the document that was
   * opened; anything higher indexes a file merged in afterwards.
   */
  doc: number;
  /** Index of the page within that file. */
  source: number;
  /** Extra rotation in degrees, added to whatever the page already had. */
  rotate: number;
}

/** A region whose text is removed from the file, not merely covered. */
export interface RedactionArea {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SearchMatch {
  pageIndex: number;
  /** The line the hit sits in, empty when the hit is in added text. */
  lineId: string;
  /** Set instead of lineId when the hit is in text added to the page. */
  insertionId?: string;
  /** Character range of the hit within the line's current text. */
  start: number;
  end: number;
  text: string;
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
  /** The output's page list. Empty until a page operation is performed. */
  private pagePlan: PagePlanEntry[] | null = null;
  /** Files merged in after opening, in the order they were added. */
  private extraDocs: Array<{ name: string; bytes: Uint8Array }> = [];
  /** pageIndex -> image id -> how that image has been moved, resized or removed. */
  private imageEdits = new Map<number, Map<string, ImageEdit>>();
  /** pageIndex -> erasure id -> a rectangle painted over the page. */
  private erasures = new Map<number, Map<string, RectFill>>();
  /** pageIndex -> redaction id -> a region whose text is deleted. */
  private redactions = new Map<number, Map<string, RedactionArea>>();
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
  private nextErasureId = 1;
  private nextRedactionId = 1;

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
  /**
   * The original parsed once and kept.
   *
   * Page models are built from the original file, and building one used to
   * reparse the whole document. That is fine for a page or two and quadratic
   * for anything longer, which searching across every page immediately exposes.
   */
  private originalDoc: Promise<PDFDocument> | null = null;

  pageCount = 0;
  /** Page count of the file as opened, which the plan is expressed against. */
  private originalPageCount = 0;
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
    if (!this.pagePlan) this.originalPageCount = this.pageCount;

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
    for (const m of this.erasures.values()) if (m.size) return true;
    for (const m of this.redactions.values()) if (m.size) return true;
    if (this.hasPageChanges()) return true;
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
    for (const m of this.erasures.values()) n += m.size;
    for (const m of this.redactions.values()) n += m.size;
    // Page operations count as one change however many pages they touched,
    // since they are performed and undone as single actions.
    if (this.hasPageChanges()) n += 1;
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
      erasures: new Map([...this.erasures].map(([k, v]) => [k, new Map([...v].map(([i, o]) => [i, { ...o }]))])),
      redactions: new Map([...this.redactions].map(([k, v]) => [k, new Map([...v].map(([i, o]) => [i, { ...o }]))])),
      insertions: new Map([...this.insertions].map(([k, v]) => [k, new Map([...v].map(([i, x]) => [i, { ...x }]))])),
      stamps: new Map([...this.stamps].map(([k, v]) => [k, new Map([...v].map(([i, x]) => [i, { ...x }]))])),
      formValues: new Map(this.formValues),
      pagePlan: (this.pagePlan ?? []).map((e) => ({ ...e })),
      extraDocs: [...this.extraDocs],
    };
  }

  private restore(state: EditState): void {
    this.edits = state.edits;
    this.lineOffsets = state.lineOffsets;
    this.imageEdits = state.imageEdits;
    this.erasures = state.erasures;
    this.redactions = state.redactions;
    this.insertions = state.insertions;
    this.stamps = state.stamps;
    this.formValues = state.formValues;
    this.pagePlan = state.pagePlan.length ? state.pagePlan : null;
    this.extraDocs = state.extraDocs;
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

  /* ---------------- searching ---------------- */

  /**
   * Finds every occurrence across the document.
   *
   * Searches the text as it currently reads, so a word that was typed in a
   * moment ago is findable and one that was typed out is not.
   */
  async search(query: string, caseSensitive = false): Promise<SearchMatch[]> {
    const needle = caseSensitive ? query : query.toLowerCase();
    if (!needle.trim()) return [];

    const matches: SearchMatch[] = [];
    for (let pageIndex = 0; pageIndex < this.pageCount; pageIndex++) {
      const page = await this.getPage(pageIndex).catch(() => null);
      if (!page) continue;

      const record = (text: string, where: { lineId: string; insertionId?: string }): void => {
        const haystack = caseSensitive ? text : text.toLowerCase();
        let from = 0;
        for (;;) {
          const at = haystack.indexOf(needle, from);
          if (at < 0) break;
          matches.push({ pageIndex, ...where, start: at, end: at + needle.length, text });
          // Overlapping hits are not useful, so the scan resumes after this one.
          from = at + Math.max(1, needle.length);
        }
      };

      for (const line of page.lines) {
        record(this.textFor(pageIndex, line), { lineId: line.id });
      }
      // Added text is part of the document too, and on a recognised scan it is
      // the only text there is, so searching without it would find nothing.
      for (const insertion of this.insertionsFor(pageIndex)) {
        record(insertion.text, { lineId: '', insertionId: insertion.id });
      }
    }
    return matches;
  }

  /* ---------------- page operations ---------------- */

  private plan(): PagePlanEntry[] {
    if (!this.pagePlan) {
      this.pagePlan = Array.from({ length: this.originalPageCount }, (_, i) => ({ doc: 0, source: i, rotate: 0 }));
    }
    return this.pagePlan;
  }

  /** The output's pages, in order, naming where each came from. */
  pages(): PagePlanEntry[] {
    return this.plan().map((e) => ({ ...e }));
  }

  hasPageChanges(): boolean {
    if (!this.pagePlan) return false;
    if (this.pagePlan.length !== this.originalPageCount) return true;
    return this.pagePlan.some((e, i) => e.doc !== 0 || e.source !== i || e.rotate !== 0);
  }

  /**
   * Appends every page of another file, keeping this document's edits intact.
   * Returns how many pages were added.
   */
  async mergeFile(name: string, bytes: Uint8Array): Promise<number> {
    const { bytes: plain } = await decryptToBytes(bytes);
    const incoming = await PDFDocument.load(plain, { throwOnInvalidObject: false, updateMetadata: false });
    const count = incoming.getPageCount();
    if (!count) return 0;

    const before = this.snapshot();
    const plan = this.plan();
    const docIndex = this.extraDocs.length + 1;
    this.extraDocs.push({ name, bytes: plain });
    for (let i = 0; i < count; i++) plan.push({ doc: docIndex, source: i, rotate: 0 });
    this.undoStack.push(before);
    this.redoStack = [];
    return count;
  }

  /** Names of the files merged in so far. */
  mergedNames(): string[] {
    return this.extraDocs.map((d) => d.name);
  }

  /**
   * Builds a new document containing only the given output positions, with
   * every edit applied. Used to split a file without disturbing this one.
   */
  async extractPages(positions: number[]): Promise<Uint8Array> {
    const { bytes } = await this.build();
    const full = await PDFDocument.load(bytes, { throwOnInvalidObject: false, updateMetadata: false });
    const wanted = positions.filter((i) => i >= 0 && i < full.getPageCount());
    if (!wanted.length) throw new Error('no pages in that range');

    const out = await PDFDocument.create();
    const copied = await out.copyPages(full, wanted);
    for (const page of copied) out.addPage(page);
    return out.save({ useObjectStreams: false });
  }

  /** Turns a page by a quarter turn, positive being clockwise. */
  rotatePage(position: number, degrees: number): boolean {
    const plan = this.plan();
    if (position < 0 || position >= plan.length) return false;
    const before = this.snapshot();
    plan[position] = { ...plan[position], rotate: (((plan[position].rotate + degrees) % 360) + 360) % 360 };
    this.undoStack.push(before);
    this.redoStack = [];
    return true;
  }

  /** Removes a page. The last remaining page cannot be removed. */
  deletePage(position: number): boolean {
    const plan = this.plan();
    if (plan.length <= 1 || position < 0 || position >= plan.length) return false;
    const before = this.snapshot();
    plan.splice(position, 1);
    this.undoStack.push(before);
    this.redoStack = [];
    return true;
  }

  /** Moves a page to a new position in the output. */
  movePage(from: number, to: number): boolean {
    const plan = this.plan();
    if (from === to || from < 0 || to < 0 || from >= plan.length || to >= plan.length) return false;
    const before = this.snapshot();
    const [entry] = plan.splice(from, 1);
    plan.splice(to, 0, entry);
    this.undoStack.push(before);
    this.redoStack = [];
    return true;
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

  /** Marks a region for redaction, which deletes its text on save. */
  addRedaction(pageIndex: number, rect: Omit<RedactionArea, 'id'>): RedactionArea {
    const before = this.snapshot();
    const created: RedactionArea = { ...rect, id: `redact${this.nextRedactionId++}` };
    let page = this.redactions.get(pageIndex);
    if (!page) {
      page = new Map();
      this.redactions.set(pageIndex, page);
    }
    page.set(created.id, created);
    this.undoStack.push(before);
    this.redoStack = [];
    return created;
  }

  removeRedaction(pageIndex: number, id: string): boolean {
    const page = this.redactions.get(pageIndex);
    if (!page?.has(id)) return false;
    const before = this.snapshot();
    page.delete(id);
    this.undoStack.push(before);
    this.redoStack = [];
    return true;
  }

  redactionsFor(pageIndex: number): RedactionArea[] {
    return [...(this.redactions.get(pageIndex)?.values() ?? [])];
  }

  /** How many characters a pending redaction would delete, for the interface. */
  countRedactedChars(pageIndex: number): number {
    const areas = this.redactions.get(pageIndex);
    const model = this.lineCache.get(pageIndex);
    if (!areas?.size || !model) return 0;
    let n = 0;
    for (const line of model.lines) {
      for (const area of areas.values()) {
        for (const [a, b] of charsInRect(line, area)) n += b - a;
      }
    }
    return n;
  }

  /** Paints over a region of a page and returns the erasure. */
  addErasure(pageIndex: number, rect: Omit<RectFill, 'id'>): RectFill {
    const before = this.snapshot();
    const created: RectFill = { ...rect, id: `erase${this.nextErasureId++}` };
    let page = this.erasures.get(pageIndex);
    if (!page) {
      page = new Map();
      this.erasures.set(pageIndex, page);
    }
    page.set(created.id, created);
    this.undoStack.push(before);
    this.redoStack = [];
    return created;
  }

  removeErasure(pageIndex: number, id: string): boolean {
    const page = this.erasures.get(pageIndex);
    if (!page?.has(id)) return false;
    const before = this.snapshot();
    page.delete(id);
    this.undoStack.push(before);
    this.redoStack = [];
    return true;
  }

  moveErasure(pageIndex: number, id: string, dx: number, dy: number): boolean {
    const existing = this.erasures.get(pageIndex)?.get(id);
    if (!existing || (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01)) return false;
    const before = this.snapshot();
    this.erasures.get(pageIndex)!.set(id, { ...existing, x: existing.x + dx, y: existing.y + dy });
    this.undoStack.push(before);
    this.redoStack = [];
    return true;
  }

  erasuresFor(pageIndex: number): RectFill[] {
    return [...(this.erasures.get(pageIndex)?.values() ?? [])];
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

  /**
   * Pages that are pictures of text rather than text.
   *
   * A page with no lines has nothing to read; one that already carries a
   * recognised layer has been read, and reading it twice would stack a second
   * copy of every word on top of the first.
   */
  async pagesNeedingRecognition(): Promise<number[]> {
    const out: number[] = [];
    for (let i = 0; i < this.pageCount; i++) {
      if (this.insertionsFor(i).some((x) => x.invisible)) continue;
      const page = await this.getPage(i).catch(() => null);
      if (page && page.lines.length === 0) out.push(i);
    }
    return out;
  }

  /** True once a page carries a recognised text layer. */
  wasRecognised(pageIndex: number): boolean {
    return this.insertionsFor(pageIndex).some((x) => x.invisible);
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
      ...this.erasures.keys(),
      ...this.redactions.keys(),
      ...this.insertions.keys(),
      ...this.stamps.keys(),
    ]);
    for (const pageIndex of touchedPages) {
      const pageEdits = this.edits.get(pageIndex) ?? new Map<string, string>();
      const pageOffsets = this.lineOffsets.get(pageIndex) ?? new Map<string, { dx: number; dy: number }>();
      const pageInsertions = [...(this.insertions.get(pageIndex)?.values() ?? [])];
      const pageStamps = [...(this.stamps.get(pageIndex)?.values() ?? [])];
      const pageImages = [...(this.imageEdits.get(pageIndex)?.values() ?? [])];
      const pageErasures = [...(this.erasures.get(pageIndex)?.values() ?? [])];
      const pageRedactions = [...(this.redactions.get(pageIndex)?.values() ?? [])];
      if (
        !pageEdits.size &&
        !pageOffsets.size &&
        !pageInsertions.length &&
        !pageStamps.length &&
        !pageImages.length &&
        !pageErasures.length &&
        !pageRedactions.length
      ) {
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
        // Which characters each redaction covers is worked out here, against the
        // same line model the edit ids refer to.
        const redactRanges = new Map<string, Array<[number, number]>>();
        for (const area of pageRedactions) {
          for (const line of lines) {
            const ranges = charsInRect(line, area);
            if (!ranges.length) continue;
            redactRanges.set(line.id, [...(redactRanges.get(line.id) ?? []), ...ranges]);
          }
        }

        const list: LineEdit[] = [];
        const byId = new Map(lines.map((l) => [l.id, l]));
        for (const lineId of new Set([...pageEdits.keys(), ...pageOffsets.keys(), ...redactRanges.keys()])) {
          const line = byId.get(lineId);
          if (!line) continue;
          const offset = pageOffsets.get(lineId);
          list.push({
            lineId,
            newText: pageEdits.get(lineId) ?? line.text,
            dx: offset?.dx ?? 0,
            dy: offset?.dy ?? 0,
            redact: redactRanges.get(lineId),
          });
        }

        // A black bar is painted over each redacted region as well, so the
        // result reads as redacted rather than as text that went missing.
        for (const area of pageRedactions) {
          pageErasures.push({
            id: `redact-bar-${area.id}`,
            x: area.x,
            y: area.y,
            width: area.width,
            height: area.height,
            color: { r: 0, g: 0, b: 0 },
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
          pageErasures,
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

    // Page operations come after content edits, because those are addressed by
    // the page's position in the original file. Rebuilding the page list first
    // would move the ground out from under them.
    if (this.pagePlan) {
      try {
        const originals = doc.getPages();

        // Pages from merged files are copied in first, since copying has to
        // happen while the destination still has its own page tree intact.
        const copiedByDoc = new Map<number, Map<number, PDFPage>>();
        for (let d = 1; d <= this.extraDocs.length; d++) {
          const wanted = [...new Set(this.pagePlan.filter((e) => e.doc === d).map((e) => e.source))];
          if (!wanted.length) continue;
          const source = await PDFDocument.load(this.extraDocs[d - 1].bytes, {
            throwOnInvalidObject: false,
            updateMetadata: false,
          });
          const valid = wanted.filter((i) => i < source.getPageCount());
          const pages = await doc.copyPages(source, valid);
          copiedByDoc.set(d, new Map(valid.map((srcIndex, k) => [srcIndex, pages[k]])));
        }

        const chosen = this.pagePlan
          .map((entry) => ({
            page: entry.doc === 0 ? originals[entry.source] : copiedByDoc.get(entry.doc)?.get(entry.source),
            rotate: entry.rotate,
          }))
          .filter((x): x is { page: PDFPage; rotate: number } => !!x.page);

        if (chosen.length) {
          for (let i = doc.getPageCount() - 1; i >= 0; i--) doc.removePage(i);
          for (const { page, rotate } of chosen) {
            if (rotate) page.setRotation(degrees((page.getRotation().angle + rotate) % 360));
            doc.addPage(page);
          }
        }
      } catch (e) {
        warnings.push({
          lineId: '(pages)',
          kind: 'stream-missing',
          detail: `page rearrangement failed: ${(e as Error).message}`,
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
        if (!this.originalDoc) {
          this.originalDoc = PDFDocument.load(this.originalBytes.slice(), {
            throwOnInvalidObject: false,
            updateMetadata: false,
          });
        }
        const libDoc = await this.originalDoc;

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
