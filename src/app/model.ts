/**
 * Document model.
 *
 * Holds the original file bytes plus the set of edits made against them. Output
 * is always produced by replaying every edit onto a fresh copy of the original,
 * never by editing an already-edited document. That keeps undo exact, avoids
 * compounding rounding, and means a save is reproducible from the edit list
 * alone.
 */

import { degrees, PDFBool, PDFDict, PDFDocument, PDFName, PDFString, type PDFPage } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { getPageContent, setPageContent } from '../pdf/page';
import { charsInRect, groupLines, walkPage, type ImageOp, type TextLine, type WalkResult } from '../pdf/content';
import { groupParagraphs, overflowOf, paragraphOf, reflow, type Paragraph } from '../pdf/paragraphs';
import { splitChunks } from '../pdf/split';
import { standardTextWidth } from '../pdf/fonts';
import {
  applyEdits,
  type EditWarning,
  type FontProvider,
  type ImageStamp,
  type ImageEdit,
  type LineEdit,
  type RectFill,
  type InkStroke,
  type GraphicEdit,
  type LineStyle,
  type ZOrderEdit,
  type TextInsertion,
} from '../pdf/writer';
import { findGraphics, type Graphic } from '../pdf/graphics';
import { decryptToBytes } from '../pdf/decrypt';
import { describeSignatures, findSignatures, type SignatureReport } from '../pdf/signatures';
import { applyFormValues, readForm, type FormField } from '../pdf/forms';
import { addFields, type NewField } from '../pdf/newfields';
import { Dictionary, FOREIGN_SHARE, findMisspellings } from '../pdf/spell';
import { preflight, type PreflightReport } from '../pdf/preflight';
import { compareDocuments, type CompareReport } from '../pdf/compare';
import { buildScene, type Scene } from './scene';
import { addNotes, readNotes, type ExistingNote, type PageNote } from '../pdf/notes';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface PageModel {
  index: number;
  width: number;
  height: number;
  rotation: number;
  lines: TextLine[];
  /** Lines grouped into the paragraphs they were wrapped into, for reflow. */
  paragraphs: Paragraph[];
  walk: WalkResult;
  contentBytes: Uint8Array;
  /** CSS font-family per line id, taken from pdf.js so editing shows the real font. */
  cssFonts: Map<string, string>;
}

interface EditState {
  edits: Map<number, Map<string, string>>;
  lineOffsets: Map<number, Map<string, { dx: number; dy: number }>>;
  imageEdits: Map<number, Map<string, ImageEdit>>;
  lineStyles: Map<number, Map<string, LineStyle>>;
  graphicEdits: Map<number, Map<string, GraphicEdit>>;
  zOrder: Map<number, Map<string, ZOrderEdit>>;
  erasures: Map<number, Map<string, RectFill>>;
  ink: Map<number, Map<string, InkStroke>>;
  redactions: Map<number, Map<string, RedactionArea>>;
  insertions: Map<number, Map<string, TextInsertion>>;
  stamps: Map<number, Map<string, ImageStamp>>;
  notes: Map<number, Map<string, PageNote>>;
  formValues: Map<string, string>;
  language: string;
  title: string;
  newFields: Map<number, Map<string, NewField>>;
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
   * opened; anything higher indexes a file merged in afterwards; -1 is a blank
   * page that came from nowhere and is made at build time.
   */
  doc: number;
  /** Index of the page within that file. */
  source: number;
  /** Extra rotation in degrees, added to whatever the page already had. */
  rotate: number;
  /**
   * The visible area, in the page's own coordinates, or absent for all of it.
   *
   * A crop is a CropBox rather than a rewrite: nothing outside it is deleted,
   * it is simply not shown or printed. That is what every reader means by
   * cropping a PDF, and it is reversible, but it is worth knowing that a
   * cropped page still carries whatever was outside the box.
   */
  crop?: { x: number; y: number; width: number; height: number };
}

/** A page plan entry that is a blank page rather than one from a file. */
export const BLANK_PAGE = -1;

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
  /**
   * False when the editor's parser cannot read the file at all.
   *
   * The renderer and the editor are different parsers with different tolerance
   * for damage, so a file can be perfectly viewable and still be beyond
   * rewriting. Showing it is better than refusing it, as long as nobody is left
   * expecting to be able to save.
   */
  canEdit: boolean;
}

/** One heading in the document's table of contents. */
export interface OutlineEntry {
  title: string;
  /** Page it points at, or null when the file has lost track of where it went. */
  pageIndex: number | null;
  children: OutlineEntry[];
}

/** What pdf.js hands back, which is looser than what the rest of this wants. */
interface RawOutline {
  title?: string;
  dest?: string | unknown[] | null;
  items?: RawOutline[];
}

export class HandpressDocument {
  /**
   * What the document is called. Not readonly: it names every file this
   * produces, from a saved copy to the pieces of a split, so renaming it here
   * is the one place that has to change.
   */
  name: string;
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
  /** pageIndex -> lineId -> a change of typeface, size or colour for that line. */
  private lineStyles = new Map<number, Map<string, LineStyle>>();
  /** pageIndex -> graphic id -> how far that drawing has been dragged. */
  private graphicEdits = new Map<number, Map<string, GraphicEdit>>();
  /** pageIndex -> object id -> which side of the page's own drawing it sits on. */
  private zOrder = new Map<number, Map<string, ZOrderEdit>>();
  /** pageIndex -> the movable drawings found on it, worked out once per parse. */
  private graphicCache = new Map<number, Graphic[]>();
  /** pageIndex -> erasure id -> a rectangle painted over the page. */
  private erasures = new Map<number, Map<string, RectFill>>();
  private ink = new Map<number, Map<string, InkStroke>>();
  private nextInkId = 1;
  /** pageIndex -> redaction id -> a region whose text is deleted. */
  private redactions = new Map<number, Map<string, RedactionArea>>();
  /** pageIndex -> insertion id -> text added where the page had none. */
  private insertions = new Map<number, Map<string, TextInsertion>>();
  /** pageIndex -> stamp id -> image placed on the page, such as a signature. */
  private stamps = new Map<number, Map<string, ImageStamp>>();
  /** pageIndex -> note id -> a comment attached to a point on the page. */
  private notes = new Map<number, Map<string, PageNote>>();
  /** pageIndex -> field id -> an interactive field being added to the document. */
  private newFields = new Map<number, Map<string, NewField>>();
  private nextFieldId = 1;
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
  private nextNoteId = 1;
  private nextErasureId = 1;
  private nextRedactionId = 1;

  private pdfjsDoc: PDFDocumentProxy | null = null;
  private loadingTask: PDFDocumentLoadingTask | null = null;
  /** Kept across reloads; see the note in `reload`. */
  private worker: InstanceType<typeof pdfjs.PDFWorker> | null = null;
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
  /** True when the file arrived encrypted, which no archival profile allows. */
  wasEncrypted = false;
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
  /** False when the editor's parser could not read the file; see LoadReport. */
  canEdit = true;
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
  static async open(
    name: string,
    bytes: Uint8Array,
    password?: string,
  ): Promise<{ doc: HandpressDocument; report: LoadReport }> {
    const { bytes: plain, wasEncrypted } = await decryptToBytes(bytes, password);
    const doc = new HandpressDocument(name, plain);
    // Kept, because a file that arrived locked can never be archival and the
    // check for that runs long after this point.
    doc.wasEncrypted = wasEncrypted;
    await doc.reload();
    const report = await doc.describe();
    report.wasEncrypted = wasEncrypted;
    return { doc, report };
  }

  private async reload(): Promise<void> {
    if (this.loadingTask) {
      // The document is torn down, but the worker it ran in is kept and handed
      // to the next one. Every committed edit reloads, and starting a fresh
      // worker each time means booting a thread and loading two megabytes of
      // pdf.js script before the edit can be seen.
      await this.loadingTask.destroy().catch(() => undefined);
      this.loadingTask = null;
      this.pdfjsDoc = null;
    }
    if (!this.worker) this.worker = new pdfjs.PDFWorker();
    // Line models survive a reload; only the pdf.js-derived font names reset.
    this.cssFontCache.clear();

    // pdf.js takes ownership of the buffer it is given, so it gets a copy.
    this.loadingTask = pdfjs.getDocument({
      worker: this.worker,
      data: this.currentBytes.slice(),
      useSystemFonts: true,
    });
    this.pdfjsDoc = await this.loadingTask.promise;
    this.pageCount = this.pdfjsDoc.numPages;
    if (!this.pagePlan) this.originalPageCount = this.pageCount;

  }

  /**
   * Everything that can only be learned by looking at the original file.
   *
   * Derived once, when the document is opened, because the original bytes
   * never change. This used to run on every reload, which is after every
   * committed edit: five pages probed for text, each forcing a `getTextContent`
   * round trip and a full font-name scan, and then a second whole-file parse to
   * read signatures and form fields. `refresh` threw all of it away again. It
   * was the largest thing standing between pressing Enter and seeing the edit.
   */
  private async describe(): Promise<LoadReport> {
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
      // Comments the file arrived with, so they can be read and answered
      // rather than only the ones made here.
      this.documentNotes = readNotes(libDoc);
      // Loading is not the same as being usable: a broken page tree parses
      // happily and then throws the moment anything asks for a page, which is
      // every single thing the editor does.
      libDoc.getPage(0);
      this.canEdit = true;
    } catch {
      // The renderer opened it, so it can still be looked at; the editor cannot
      // touch it, and saying so up front beats failing at the save.
      this.canEdit = false;
    }

    return {
      pageCount: this.pageCount,
      scannedPages,
      wasEncrypted: false,
      signatures,
      signatureWarning: describeSignatures(signatures),
      canEdit: this.canEdit,
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
    for (const m of this.lineStyles.values()) if (m.size) return true;
    for (const m of this.graphicEdits.values()) if (m.size) return true;
    for (const m of this.zOrder.values()) if (m.size) return true;
    for (const m of this.erasures.values()) if (m.size) return true;
    for (const m of this.ink.values()) if (m.size) return true;
    for (const m of this.redactions.values()) if (m.size) return true;
    if (this.hasPageChanges()) return true;
    for (const m of this.insertions.values()) if (m.size) return true;
    for (const m of this.stamps.values()) if (m.size) return true;
    for (const m of this.notes.values()) if (m.size) return true;
    for (const m of this.newFields.values()) if (m.size) return true;
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
    for (const m of this.lineStyles.values()) n += m.size;
    for (const m of this.graphicEdits.values()) n += m.size;
    for (const m of this.zOrder.values()) n += m.size;
    for (const m of this.erasures.values()) n += m.size;
    for (const m of this.ink.values()) n += m.size;
    for (const m of this.redactions.values()) n += m.size;
    // Page operations count as one change however many pages they touched,
    // since they are performed and undone as single actions.
    if (this.hasPageChanges()) n += 1;
    for (const m of this.insertions.values()) n += m.size;
    for (const m of this.stamps.values()) n += m.size;
    for (const m of this.notes.values()) n += m.size;
    for (const m of this.newFields.values()) n += m.size;
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
      lineStyles: new Map([...this.lineStyles].map(([k, v]) => [k, new Map([...v].map(([i, o]) => [i, { ...o }]))])),
      graphicEdits: new Map(
        [...this.graphicEdits].map(([k, v]) => [k, new Map([...v].map(([i, o]) => [i, { ...o }]))]),
      ),
      zOrder: new Map([...this.zOrder].map(([k, v]) => [k, new Map([...v].map(([i, o]) => [i, { ...o }]))])),
      erasures: new Map([...this.erasures].map(([k, v]) => [k, new Map([...v].map(([i, o]) => [i, { ...o }]))])),
      ink: new Map([...this.ink].map(([k, v]) => [k, new Map([...v].map(([i, o]) => [i, { ...o, points: o.points.map((q) => ({ ...q })) }]))])),
      redactions: new Map([...this.redactions].map(([k, v]) => [k, new Map([...v].map(([i, o]) => [i, { ...o }]))])),
      insertions: new Map([...this.insertions].map(([k, v]) => [k, new Map([...v].map(([i, x]) => [i, { ...x }]))])),
      stamps: new Map([...this.stamps].map(([k, v]) => [k, new Map([...v].map(([i, x]) => [i, { ...x }]))])),
      notes: new Map([...this.notes].map(([k, v]) => [k, new Map([...v].map(([i, x]) => [i, { ...x }]))])),
      formValues: new Map(this.formValues),
      language: this.language,
      title: this.title,
      newFields: new Map([...this.newFields].map(([k, v]) => [k, new Map([...v].map(([i, o]) => [i, { ...o }]))])),
      pagePlan: (this.pagePlan ?? []).map((e) => ({ ...e })),
      extraDocs: [...this.extraDocs],
    };
  }

  private restore(state: EditState): void {
    this.edits = state.edits;
    this.lineOffsets = state.lineOffsets;
    this.imageEdits = state.imageEdits;
    this.lineStyles = state.lineStyles;
    this.graphicEdits = state.graphicEdits;
    this.zOrder = state.zOrder;
    this.erasures = state.erasures;
    this.ink = state.ink;
    this.redactions = state.redactions;
    this.insertions = state.insertions;
    this.stamps = state.stamps;
    this.notes = state.notes;
    this.formValues = state.formValues;
    this.language = state.language;
    this.title = state.title;
    this.newFields = state.newFields;
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

    const write = (target: TextLine, text: string): void => {
      if (text === target.text) pageEdits!.delete(target.id);
      else pageEdits!.set(target.id, text);
    };
    write(line, newText);

    // The rest of the paragraph follows the edit. Only the lines after it are
    // touched: the ones above wrapped correctly and the user did not change
    // them, so rewriting those would move text nobody asked to move.
    const rewrapped = this.rewrapAfter(pageIndex, line, (l) =>
      l.id === line.id ? newText : this.textFor(pageIndex, l),
    );
    if (rewrapped) for (const [target, text] of rewrapped) write(target, text);

    this.undoStack.push(before);
    this.redoStack = [];
    this.lastReflow = rewrapped ? rewrapped.length : 0;
    // Text drawn past the edge of the page is clipped by every reader there
    // is, so a line made too long simply loses its end with nothing to show
    // for it. A paragraph that rewrapped has already been held to its column
    // and cannot be over the edge.
    // Against the page's own width, not the viewport's: a page turned a
    // quarter turn is shown with its sides swapped, but the text still runs
    // along the same axis it always did.
    const page = this.lineCache.get(pageIndex);
    const across = page ? (page.rotation % 180 ? page.height : page.width) : 612;
    this.lastOverflow = rewrapped ? 0 : overflowOf(line, newText, across);
    return true;
  }

  /** How a line has been restyled, if it has. */
  styleFor(pageIndex: number, lineId: string): LineStyle {
    return this.lineStyles.get(pageIndex)?.get(lineId) ?? {};
  }

  /**
   * Changes the typeface, size or colour of a whole line.
   *
   * The whole line rather than a selection inside it, because a line is the
   * unit everything else here works in and a partial restyle would need a
   * second one. Fields left out keep what the document already had, so setting
   * a colour really does set only a colour.
   *
   * A change of typeface is limited to the three standard families. Anything
   * else would mean embedding a font file so that a document depends on it for
   * a change of typeface; these three every reader already has.
   */
  setLineStyle(pageIndex: number, lineId: string, change: LineStyle): boolean {
    const current = this.styleFor(pageIndex, lineId);
    const next: LineStyle = { ...current, ...change };
    // Undefined entries are removed rather than kept, so a style emptied back
    // out stops counting as an edit at all.
    for (const key of Object.keys(next) as Array<keyof LineStyle>) {
      if (next[key] === undefined) delete next[key];
    }
    if (JSON.stringify(next) === JSON.stringify(current)) return false;

    const before = this.snapshot();
    let page = this.lineStyles.get(pageIndex);
    if (!page) {
      page = new Map();
      this.lineStyles.set(pageIndex, page);
    }
    if (!Object.keys(next).length) page.delete(lineId);
    else page.set(lineId, next);
    this.undoStack.push(before);
    this.redoStack = [];
    return true;
  }

  /**
   * How far past the right edge of the page the last edit ran, in points.
   *
   * Zero when it fits. The edit is applied either way: refusing it would be
   * worse than letting someone see what they have done and undo it.
   */
  lastOverflow = 0;

  /**
   * How many lines the last edit rewrapped, so the interface can say so.
   *
   * Zero means the line stood alone, or its paragraph could not take the new
   * text without needing a line it does not have.
   */
  lastReflow = 0;

  /**
   * Re-breaks the paragraph containing a line, from that line onwards.
   *
   * Returns null when there is no paragraph to speak of, or when the words no
   * longer fit the lines available. Making room would mean pushing the rest of
   * the page down, which is a different and far riskier operation than editing
   * a line, so the edit is left as it was and the caller can say what happened.
   */
  private rewrapAfter(
    pageIndex: number,
    line: TextLine,
    textOf: (line: TextLine) => string,
  ): Array<[TextLine, string]> | null {
    const page = this.lineCache.get(pageIndex);
    if (!page) return null;

    const paragraph = paragraphOf(page.paragraphs, line.id);
    if (!paragraph) return null;

    const from = paragraph.lines.findIndex((l) => l.id === line.id);
    if (from < 0 || from >= paragraph.lines.length - 1) return null;

    const tail = paragraph.lines
      .slice(from)
      .map((l) => textOf(l).trim())
      .filter((t) => t.length > 0)
      .join(' ');

    const result = reflow(paragraph, tail, from);
    if (!result) return null;

    const out: Array<[TextLine, string]> = [];
    for (let i = from; i < paragraph.lines.length; i++) {
      out.push([paragraph.lines[i], result.texts[i - from]]);
    }
    return out;
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

  /* ---------------- freehand ink ---------------- */

  /** Adds a stroke to a page and returns it. */
  addInk(pageIndex: number, stroke: Omit<InkStroke, 'id'>): InkStroke | null {
    if (!stroke.points.length) return null;
    const before = this.snapshot();
    const created: InkStroke = { ...stroke, id: `ink${this.nextInkId++}` };
    let page = this.ink.get(pageIndex);
    if (!page) {
      page = new Map();
      this.ink.set(pageIndex, page);
    }
    page.set(created.id, created);
    this.undoStack.push(before);
    this.redoStack = [];
    return created;
  }

  inkFor(pageIndex: number): InkStroke[] {
    return [...(this.ink.get(pageIndex)?.values() ?? [])];
  }

  removeInk(pageIndex: number, id: string): boolean {
    const page = this.ink.get(pageIndex);
    if (!page?.has(id)) return false;
    const before = this.snapshot();
    page.delete(id);
    this.undoStack.push(before);
    this.redoStack = [];
    return true;
  }

  /** Rubs out every stroke crossing a point, which is what an eraser is. */
  eraseInkAt(pageIndex: number, x: number, y: number, radius: number): boolean {
    const page = this.ink.get(pageIndex);
    if (!page?.size) return false;
    const hit: string[] = [];
    for (const [id, stroke] of page) {
      const reach = radius + stroke.width / 2;
      if (stroke.points.some((p) => Math.hypot(p.x - x, p.y - y) <= reach)) hit.push(id);
    }
    if (!hit.length) return false;
    const before = this.snapshot();
    for (const id of hit) page.delete(id);
    this.undoStack.push(before);
    this.redoStack = [];
    return true;
  }

  /* ---------------- notes ---------------- */

  /** Attaches a comment to a point on a page and returns it. */
  addNote(pageIndex: number, note: Omit<PageNote, 'id'>): PageNote {
    const before = this.snapshot();
    const created: PageNote = { ...note, id: `note${this.nextNoteId++}` };
    let page = this.notes.get(pageIndex);
    if (!page) {
      page = new Map();
      this.notes.set(pageIndex, page);
    }
    page.set(created.id, created);
    this.undoStack.push(before);
    this.redoStack = [];
    return created;
  }

  /** Rewrites a note, or removes it when the comment is emptied. */
  setNoteText(pageIndex: number, id: string, text: string): boolean {
    const existing = this.notes.get(pageIndex)?.get(id);
    if (!existing || existing.text === text) return false;
    const before = this.snapshot();
    if (text.trim()) this.notes.get(pageIndex)!.set(id, { ...existing, text });
    else this.notes.get(pageIndex)!.delete(id);
    this.undoStack.push(before);
    this.redoStack = [];
    return true;
  }

  /** Moves a note by a page-space offset. */
  moveNote(pageIndex: number, id: string, dx: number, dy: number): boolean {
    const existing = this.notes.get(pageIndex)?.get(id);
    if (!existing || (!dx && !dy)) return false;
    const before = this.snapshot();
    this.notes.get(pageIndex)!.set(id, { ...existing, x: existing.x + dx, y: existing.y + dy });
    this.undoStack.push(before);
    this.redoStack = [];
    return true;
  }

  removeNote(pageIndex: number, id: string): boolean {
    const page = this.notes.get(pageIndex);
    if (!page?.has(id)) return false;
    const before = this.snapshot();
    page.delete(id);
    this.undoStack.push(before);
    this.redoStack = [];
    return true;
  }

  /** Comments the document arrived with, read once when it was opened. */
  private documentNotes: ExistingNote[] = [];

  /** Every comment on a page, the ones already in the file and the ones added. */
  commentsOn(pageIndex: number): Array<{
    id: string;
    x: number;
    y: number;
    text: string;
    author: string;
    written: number;
    replyTo?: string;
    /** False for comments the file arrived with, which cannot be edited here. */
    mine: boolean;
  }> {
    const theirs = this.documentNotes
      .filter((n) => n.pageIndex === pageIndex)
      .map((n) => ({ ...n, mine: false }));
    const mine = this.notesFor(pageIndex).map((n) => ({
      id: n.id,
      x: n.x,
      y: n.y,
      text: n.text,
      author: n.author,
      written: n.written,
      replyTo: n.replyTo,
      mine: true,
    }));
    return [...theirs, ...mine];
  }

  /**
   * Every comment in the document, in reading order, with its thread depth.
   *
   * A list of all of them is how a review is actually worked through: page by
   * page is how they were made, not how they are answered. Depth is carried so
   * replies can be shown under what they answer without the caller rebuilding
   * the tree.
   */
  allComments(): Array<{
    id: string;
    page: number;
    text: string;
    author: string;
    written: number;
    mine: boolean;
    depth: number;
  }> {
    const out: Array<{
      id: string;
      page: number;
      text: string;
      author: string;
      written: number;
      mine: boolean;
      depth: number;
    }> = [];

    for (let page = 0; page < this.pageCount; page++) {
      const here = this.commentsOn(page);
      const roots = here.filter((c) => !c.replyTo);
      const walk = (parent: (typeof here)[number], depth: number): void => {
        out.push({ ...parent, page, depth });
        for (const child of here.filter((c) => c.replyTo === parent.id)) walk(child, depth + 1);
      };
      for (const root of roots) walk(root, 0);
    }
    return out;
  }

  /**
   * Answers a comment, whether it came with the document or was added here.
   *
   * The reply is an ordinary note carrying the id of the one it answers, which
   * becomes /IRT at build time. It is placed on top of its parent, because
   * readers lay a thread out themselves and a reply given a position of its
   * own just leaves a second icon on the page.
   */
  replyToComment(pageIndex: number, parentId: string, text: string, author: string): PageNote | null {
    if (!text.trim()) return null;
    const parent = this.commentsOn(pageIndex).find((c) => c.id === parentId);
    if (!parent) return null;
    return this.addNote(pageIndex, {
      x: parent.x,
      y: parent.y,
      text,
      author,
      written: Date.now(),
      replyTo: parentId,
    });
  }

  notesFor(pageIndex: number): PageNote[] {
    return [...(this.notes.get(pageIndex)?.values() ?? [])];
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

  /**
   * Replaces occurrences of a string, either one or all of them.
   *
   * The whole sweep is one undo step. Calling setLineText once per hit would
   * push a snapshot per line, so undoing a replace across a long document
   * would mean pressing undo two hundred times, which is not undo.
   *
   * Hits within a line are applied from the end backwards, because replacing
   * the first one moves every offset after it and the recorded positions were
   * measured against the text as it read before any of this started.
   *
   * A line whose font cannot draw the replacement is still written: the writer
   * substitutes per character and reports it, which is the same thing that
   * happens when the text is retyped by hand, and refusing here would be a
   * second and different set of rules for the same edit.
   */
  async replace(
    query: string,
    replacement: string,
    opts: { caseSensitive?: boolean; only?: SearchMatch } = {},
  ): Promise<number> {
    const before = this.snapshot();
    const undoDepth = this.undoStack.length;
    let total = 0;

    // Replacing in one line can rewrap the rest of its paragraph, which changes
    // the text of lines that had hits of their own and were measured before any
    // of this happened. Those are skipped rather than cut in the wrong place,
    // so one pass genuinely does not replace everything: on a paper with ten
    // occurrences the first sweep took six. Sweeping again picks up what moved,
    // until a pass finds nothing left to do.
    //
    // Not when the replacement contains the search text, though. Replacing "a"
    // with "aa" would find its own output every time and never finish, and one
    // pass is the right answer there anyway.
    const feedsItself = opts.caseSensitive
      ? replacement.includes(query)
      : replacement.toLowerCase().includes(query.toLowerCase());
    const passes = opts.only || feedsItself ? 1 : 12;

    for (let pass = 0; pass < passes; pass++) {
      const done = await this.replacePass(query, replacement, opts);
      total += done;
      if (!done) break;
    }

    // Collapse every snapshot the writes pushed back into the one taken here.
    this.undoStack.length = undoDepth;
    if (total) {
      this.undoStack.push(before);
      this.redoStack = [];
    }
    return total;
  }

  /** One sweep of {@link replace}, which is as far as it can get in one go. */
  private async replacePass(
    query: string,
    replacement: string,
    opts: { caseSensitive?: boolean; only?: SearchMatch },
  ): Promise<number> {
    const targets = opts.only ? [opts.only] : await this.search(query, opts.caseSensitive);
    if (!targets.length) return 0;

    // Grouped so each line is written once with every one of its hits applied.
    const byTarget = new Map<string, SearchMatch[]>();
    for (const m of targets) {
      const key = `${m.pageIndex} ${m.insertionId ?? m.lineId}`;
      const list = byTarget.get(key) ?? [];
      list.push(m);
      byTarget.set(key, list);
    }

    let done = 0;
    for (const [, hits] of byTarget) {
      const first = hits[0];
      const page = await this.getPage(first.pageIndex).catch(() => null);
      if (!page) continue;

      const line = first.insertionId ? null : page.lines.find((l) => l.id === first.lineId);
      const insertion = first.insertionId
        ? this.insertionsFor(first.pageIndex).find((i) => i.id === first.insertionId)
        : null;
      if (!line && !insertion) continue;

      const current = line ? this.textFor(first.pageIndex, line) : (insertion?.text ?? '');
      // The recorded offsets belong to the text as it read when the search
      // ran. If it has changed since, they mean nothing and the safe answer is
      // to leave it alone rather than cut the string in the wrong place.
      if (current !== first.text) continue;

      let next = current;
      for (const hit of [...hits].sort((a, b) => b.start - a.start)) {
        next = next.slice(0, hit.start) + replacement + next.slice(hit.end);
      }
      const changed = line
        ? this.setLineText(first.pageIndex, line, next)
        : this.setInsertionText(first.pageIndex, insertion!.id, next);
      if (changed) done += hits.length;
    }
    return done;
  }

  /**
   * Checks the document against what it needs to survive being archived.
   *
   * Read from the original bytes rather than a rebuild, because the question
   * is about the file somebody has, not about what this would produce from it.
   */
  async preflight(): Promise<PreflightReport | null> {
    try {
      const libDoc = await PDFDocument.load(this.originalBytes.slice(), {
        throwOnInvalidObject: false,
        updateMetadata: false,
      });
      return preflight(libDoc, this.wasEncrypted);
    } catch {
      return null;
    }
  }

  /**
   * Compares this document with another file.
   *
   * Text only. Two versions of a contract differ in what they say, and a
   * comparison that also reported every image and rule that moved by a
   * fraction of a point would bury that under noise nobody asked about.
   *
   * The text on this side is what it currently reads, edits and all, so
   * comparing after making changes shows the changes.
   */
  async compareWith(other: Uint8Array): Promise<CompareReport | null> {
    const theirs = await this.textOf(other);
    if (!theirs) return null;

    const mine: string[][] = [];
    for (let i = 0; i < this.pageCount; i++) {
      const page = await this.getPage(i).catch(() => null);
      mine.push(page ? page.lines.map((l) => this.textFor(i, l)) : []);
    }
    return compareDocuments(mine, theirs);
  }

  /** Every line of every page of another file, without opening it properly. */
  private async textOf(bytes: Uint8Array): Promise<string[][] | null> {
    try {
      const doc = await PDFDocument.load(bytes.slice(), {
        throwOnInvalidObject: false,
        updateMetadata: false,
      });
      const out: string[][] = [];
      for (const page of doc.getPages()) {
        try {
          const content = getPageContent(page);
          const walk = walkPage(content.bytes, content.resources);
          out.push(groupLines(walk.ops).map((l) => l.text));
        } catch {
          // A page that will not parse contributes nothing rather than
          // stopping the comparison of the rest.
          out.push([]);
        }
      }
      return out;
    } catch {
      return null;
    }
  }

  /**
   * The document's language and title, which are accessibility, not metadata.
   *
   * A screen reader uses the language to decide how to pronounce the words: an
   * English reader speaking French text is unintelligible, and the file is the
   * only thing that can say which it is. The title is what a reader announces
   * when the document opens, and without one it announces the filename, which
   * is usually a reference number.
   *
   * These are two of the three things preflight reports and the only two that
   * can be fixed from here. The third is a structure tree, which is a
   * different and much larger job.
   */
  language = '';
  title = '';

  /** Sets the language, as a tag like `en-GB`. */
  setLanguage(code: string): boolean {
    const next = code.trim();
    if (next === this.language) return false;
    const before = this.snapshot();
    this.language = next;
    this.undoStack.push(before);
    this.redoStack = [];
    return true;
  }

  /** Sets the title a reader announces when the document opens. */
  setTitle(text: string): boolean {
    const next = text.trim();
    if (next === this.title) return false;
    const before = this.snapshot();
    this.title = next;
    this.undoStack.push(before);
    this.redoStack = [];
    return true;
  }

  /**
   * Takes a page apart into a backdrop and one picture per movable object.
   *
   * Done after the page is on screen rather than when a drag starts, because a
   * render begun by a drag can never be instant however it is done. This is
   * the cost that buys instant movement, paid where nobody is waiting.
   */
  async sceneFor(
    pageIndex: number,
    graphics: Graphic[],
    images: ImageOp[],
    scale: number,
  ): Promise<Scene | null> {
    return buildScene(this.originalBytes, pageIndex, graphics, images, scale, this.worker ?? undefined);
  }

  /** Rendered pictures of single images, kept so a second drag is instant. */
  private imageArt = new Map<string, HTMLCanvasElement>();

  /**
   * Draws one image from the page, on its own, with nothing else around it.
   *
   * Dragging an image used to float a rectangle of pixels copied off the page
   * canvas. The rectangle is the image's box, but the pixels in it are
   * whatever the page drew there: text over the picture, the panel showing
   * through a transparent one, a neighbour overlapping the corner. All of it
   * came along for the ride.
   *
   * Rather than decoding the image here, which would mean handling every
   * filter and colour space a PDF may use, the page is copied and its content
   * replaced with the one operator that draws this image. Its resources are
   * untouched, so no colour space, mask or decode array is left dangling, and
   * the renderer does what it already does well.
   */
  async imagePicture(pageIndex: number, image: { name: string; x0: number; y0: number; x1: number; y1: number }):
    Promise<HTMLCanvasElement | null> {
    const key = `${pageIndex}:${image.name}:${image.x0.toFixed(1)},${image.y0.toFixed(1)}`;
    const had = this.imageArt.get(key);
    if (had) return had;

    try {
      const doc = await PDFDocument.load(this.originalBytes.slice(), {
        throwOnInvalidObject: false,
        updateMetadata: false,
      });
      if (pageIndex >= doc.getPageCount()) return null;
      const page = doc.getPage(pageIndex);

      // Only this image, drawn where it sits, on a page cropped to it.
      const w = image.x1 - image.x0;
      const h = image.y1 - image.y0;
      if (w < 1 || h < 1) return null;
      setPageContent(
        doc,
        page,
        new TextEncoder().encode(`q ${w} 0 0 ${h} ${image.x0} ${image.y0} cm /${image.name} Do Q`),
      );
      // Annotations would draw over it and are not part of the image.
      page.node.set(PDFName.of('Annots'), doc.context.obj([]));
      page.setCropBox(image.x0, image.y0, w, h);

      const bytes = await doc.save({ useObjectStreams: false });
      const task = pdfjs.getDocument({ worker: this.worker ?? undefined, data: bytes });
      const rendered = await task.promise;
      const one = await rendered.getPage(pageIndex + 1);
      const viewport = one.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      await one.render({ canvas, canvasContext: ctx, viewport } as never).promise;
      await task.destroy().catch(() => undefined);

      this.imageArt.set(key, canvas);
      return canvas;
    } catch {
      // A page that will not rebuild is one the drag does without a preview
      // rather than one that throws in the middle of a gesture.
      return null;
    }
  }

  /* ---------------- spelling ---------------- */

  /** The word list, fetched once and kept, or null when it is not installed. */
  private dictionary: Dictionary | null = null;
  private dictionaryTried = false;

  /**
   * Loads the word list, which is fetched rather than bundled.
   *
   * Two and a half megabytes of English has no business in the script that
   * opens a document, and most sessions never run a spell check. It is asked
   * for the first time one is run and kept for the rest of the session.
   */
  private async loadDictionary(): Promise<Dictionary | null> {
    if (this.dictionary || this.dictionaryTried) return this.dictionary;
    this.dictionaryTried = true;
    try {
      const res = await fetch('dict/en.txt');
      if (!res.ok) return null;
      this.dictionary = new Dictionary((await res.text()).split('\n'));
    } catch {
      // Offline, or the list was never built. The caller says so.
      this.dictionary = null;
    }
    return this.dictionary;
  }

  /**
   * Every word in the document the dictionary does not recognise.
   *
   * Reported the same shape as a search hit, so jumping between them and
   * replacing them both go through machinery that already works.
   *
   * `foreign` says the document looks like it is in another language: a German
   * form checked against an English list is not a document with two hundred
   * mistakes in it, and listing them as though it were is worse than saying
   * nothing at all.
   */
  async spellCheck(): Promise<{ matches: SearchMatch[]; checked: number; foreign: boolean; ready: boolean }> {
    const dict = await this.loadDictionary();
    if (!dict) return { matches: [], checked: 0, foreign: false, ready: false };

    const matches: SearchMatch[] = [];
    let checked = 0;
    for (let pageIndex = 0; pageIndex < this.pageCount; pageIndex++) {
      const page = await this.getPage(pageIndex).catch(() => null);
      if (!page) continue;

      const look = (text: string, where: { lineId: string; insertionId?: string }): void => {
        checked += (text.match(/[A-Za-z]{3,}/g) ?? []).length;
        for (const bad of findMisspellings(dict, text)) {
          matches.push({ pageIndex, ...where, start: bad.start, end: bad.end, text });
        }
      };
      for (const line of page.lines) look(this.textFor(pageIndex, line), { lineId: line.id });
      for (const insertion of this.insertionsFor(pageIndex)) {
        look(insertion.text, { lineId: '', insertionId: insertion.id });
      }
    }

    const foreign = checked > 40 && matches.length / checked > FOREIGN_SHARE;
    return { matches, checked, foreign, ready: true };
  }

  /** Corrections for a word, nearest first. Empty when the list is not loaded. */
  suggestSpelling(word: string): string[] {
    return this.dictionary?.suggest(word.toLowerCase()) ?? [];
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
    return this.pagePlan.some((e, i) => e.doc !== 0 || e.source !== i || e.rotate !== 0 || !!e.crop);
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

  /**
   * Splits the document into one file per page, or per group of pages.
   *
   * Built once and copied from, rather than rebuilt for each piece: replaying
   * every edit twenty times to produce twenty single page files is the same
   * answer for twenty times the work.
   */
  /**
   * Cuts the document into separate PDFs.
   *
   * `perFile` is how many pages each piece gets. `only` limits it to a chosen
   * set of pages, given as positions from zero; the pieces are still cut in
   * order and named for the pages they actually hold, so splitting 1-3 and 8-10
   * two at a time gives "page 1-2", "page 3", "page 8-9", "page 10" rather than
   * a numbering that only makes sense to whoever typed the range.
   */
  async splitPages(
    perFile = 1,
    only?: number[],
  ): Promise<Array<{ name: string; bytes: Uint8Array; from: number; to: number }>> {
    const { bytes } = await this.build();
    const full = await PDFDocument.load(bytes, { throwOnInvalidObject: false, updateMetadata: false });
    const total = full.getPageCount();
    const size = Math.max(1, Math.floor(perFile));
    const base = this.name.replace(/\.pdf$/i, '');
    const out: Array<{ name: string; bytes: Uint8Array; from: number; to: number }> = [];

    const pages = (only ?? Array.from({ length: total }, (_, i) => i)).filter(
      (i) => i >= 0 && i < total,
    );

    for (const wanted of splitChunks(pages, size)) {
      if (!wanted.length) continue;

      const piece = await PDFDocument.create();
      const copied = await piece.copyPages(full, wanted);
      for (const page of copied) piece.addPage(page);

      const from = wanted[0] + 1;
      const to = wanted[wanted.length - 1] + 1;
      // Both numbers padded, so the files sort the way the pages read. Padding
      // only the first gave "page 01-2".
      const width = String(total).length;
      const pad = (n: number): string => `${n}`.padStart(width, '0');
      const label = from === to ? pad(from) : `${pad(from)}-${pad(to)}`;
      out.push({ name: `${base} page ${label}.pdf`, bytes: await piece.save(), from, to });
    }

    return out;
  }

  /**
   * Stamps the same text onto every page, or a range of them.
   *
   * One mechanism for four jobs. A watermark is large, turned, faint and in
   * the middle; a header is small and at the top; a footer is small and at the
   * bottom; page numbers are a footer whose text is a token. Building them
   * from four separate features would be four sets of bugs about where text
   * lands on a page whose size is not the one before it.
   *
   * `{page}` and `{pages}` are replaced per page, so numbering works on any of
   * the four and not only on the one called page numbers.
   *
   * The whole batch is one undo, and every stamp is an ordinary piece of added
   * text afterwards: it can be dragged, retyped or deleted one at a time.
   */
  async stampEveryPage(spec: {
    text: string;
    size: number;
    color: { r: number; g: number; b: number };
    opacity: number;
    rotate: number;
    place: 'top-left' | 'top-centre' | 'top-right' | 'centre' | 'bottom-left' | 'bottom-centre' | 'bottom-right';
    margin: number;
    bold: boolean;
    italic: boolean;
    /** Draw under the page rather than over it, which is what a watermark wants. */
    behind?: boolean;
    /**
     * Sequential numbering, for the `{n}` token.
     *
     * Bates numbering is this: a number that runs on across a whole set of
     * documents so that a page can be cited unambiguously afterwards. It must
     * never restart and never repeat, which is why the counter comes in and
     * the next value goes back out rather than being worked out from the page
     * index. `{page}` is per document; `{n}` is per set.
     */
    number?: { next: number; digits: number };
    /** Zero-based pages to stamp. Absent means all of them. */
    pages?: number[];
  }): Promise<number> {
    const wanted = spec.pages ?? Array.from({ length: this.pageCount }, (_, i) => i);
    if (!wanted.length || !spec.text.trim()) return 0;

    const before = this.snapshot();
    const undoDepth = this.undoStack.length;
    // The stamp is drawn in a standard face, so its widths are known without
    // embedding anything, which is what makes centring possible before the
    // file has been built.
    const alias = spec.bold
      ? spec.italic
        ? 'Helvetica-BoldOblique'
        : 'Helvetica-Bold'
      : spec.italic
        ? 'Helvetica-Oblique'
        : 'Helvetica';
    let done = 0;
    // Only advanced when a page is actually stamped, so a page that could not
    // be read does not silently consume a number and leave a gap in a sequence
    // whose whole purpose is that there are none.
    let next = spec.number?.next ?? 1;
    const counted = (): string =>
      spec.number ? String(next).padStart(spec.number.digits, '0') : '';

    for (const index of wanted) {
      const page = await this.getPage(index).catch(() => null);
      if (!page) continue;
      // A document can mix page sizes, so each stamp is placed against the
      // page it lands on rather than against the first one.
      const across = page.rotation % 180 ? page.height : page.width;
      const down = page.rotation % 180 ? page.width : page.height;

      const text = spec.text
        .replaceAll('{page}', String(index + 1))
        .replaceAll('{pages}', String(this.pageCount))
        .replaceAll('{n}', counted());
      const width = standardTextWidth(alias, text, spec.size);

      // A turned stamp is measured along its own axis, so the width that
      // matters for centring it is the width it actually covers.
      const turn = (spec.rotate * Math.PI) / 180;
      const spanX = Math.abs(width * Math.cos(turn));
      const spanY = Math.abs(width * Math.sin(turn));

      const left = spec.margin;
      const right = across - spec.margin - spanX;
      const middleX = (across - spanX) / 2;
      const x = spec.place.endsWith('left')
        ? left
        : spec.place.endsWith('right')
          ? right
          : middleX;

      // Measured to the baseline. The top margin allows for the ascent so the
      // words sit under the edge rather than through it.
      const y = spec.place.startsWith('top')
        ? down - spec.margin - spec.size * 0.8
        : spec.place.startsWith('bottom')
          ? spec.margin
          : (down - spanY) / 2;

      if (
        this.addInsertion(index, {
          x,
          y,
          size: spec.size,
          color: { ...spec.color },
          text,
          bold: spec.bold,
          italic: spec.italic,
          rotate: spec.rotate,
          opacity: spec.opacity,
          behind: spec.behind,
        })
      ) {
        done++;
        if (spec.number) next++;
      }
    }

    // Handed back so a batch can carry the sequence into the next file.
    this.lastNumber = next;
    this.undoStack.length = undoDepth;
    if (done) {
      this.undoStack.push(before);
      this.redoStack = [];
    }
    return done;
  }

  /**
   * Where a sequential numbering run got to, for the next document in a set.
   *
   * Bates numbering has to run on across files, so the counter cannot live
   * inside one document.
   */
  lastNumber = 1;

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

  /**
   * Sets the visible area of a page, or of every page.
   *
   * Cropping every page to one rectangle is the common case by a distance:
   * it is what a batch of scans with the same margin of grey needs, and doing
   * it a page at a time on a forty page document is not a feature.
   *
   * The rectangle is in the page's own coordinates, which for a rotated page
   * are still the unrotated ones. That is the same frame every other edit
   * here works in, so a crop dragged on screen lands where it was dragged.
   */
  cropPage(position: number, area: { x: number; y: number; width: number; height: number }, all = false): boolean {
    const plan = this.plan();
    if (position < 0 || position >= plan.length) return false;
    if (area.width < 1 || area.height < 1) return false;
    const before = this.snapshot();
    if (all) for (let i = 0; i < plan.length; i++) plan[i] = { ...plan[i], crop: { ...area } };
    else plan[position] = { ...plan[position], crop: { ...area } };
    this.undoStack.push(before);
    this.redoStack = [];
    return true;
  }

  /** Puts a cropped page, or every page, back to its full size. */
  uncropPage(position: number, all = false): boolean {
    const plan = this.plan();
    if (position < 0 || position >= plan.length) return false;
    const targets = all ? plan.map((_, i) => i) : [position];
    if (!targets.some((i) => plan[i].crop)) return false;
    const before = this.snapshot();
    for (const i of targets) {
      const { crop: _drop, ...rest } = plan[i];
      plan[i] = rest;
    }
    this.undoStack.push(before);
    this.redoStack = [];
    return true;
  }

  /** True when any page is currently cropped, so the interface can offer to undo it. */
  hasCrop(): boolean {
    return !!this.pagePlan?.some((e) => !!e.crop);
  }

  /**
   * Puts a blank page at a position, pushing the rest along.
   *
   * It takes the size of the page it lands after, so a blank page in an A4
   * document is A4 and one in a landscape deck is landscape. The alternative
   * is a letter-sized page appearing in the middle of a document that has
   * never been letter-sized.
   */
  insertBlankPage(position: number): boolean {
    const plan = this.plan();
    const at = Math.max(0, Math.min(position, plan.length));
    const before = this.snapshot();
    plan.splice(at, 0, { doc: BLANK_PAGE, source: 0, rotate: 0 });
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

  /**
   * The movable drawings on a page, with any move already applied to the box.
   *
   * Grouping is worked out from the page's own parse and cached, because it
   * walks every path on the page and the answer only changes when the page
   * does. The move is added to the bounds here rather than stored, so the
   * grouping stays a fact about the document and the drag stays an edit.
   */
  graphicsOn(pageIndex: number): Graphic[] {
    let found = this.graphicCache.get(pageIndex);
    if (!found) {
      const model = this.lineCache.get(pageIndex);
      if (!model) return [];
      found = findGraphics(model.walk, model.width, model.height);
      this.graphicCache.set(pageIndex, found);
    }
    const moves = this.graphicEdits.get(pageIndex);
    if (!moves?.size) return found;
    return found.map((g) => {
      const m = moves.get(g.id);
      if (!m) return g;
      return { ...g, x0: g.x0 + m.dx, x1: g.x1 + m.dx, y0: g.y0 + m.dy, y1: g.y1 + m.dy };
    });
  }

  /**
   * Where an object sits relative to the page's own drawing.
   *
   * Three rungs, not a full stack: behind everything the page draws, where the
   * file put it, or in front of everything. Objects that have been pushed to
   * the same side are ordered against each other, so stepping through a pile
   * of them works, but the page's own drawing is one rung and cannot be
   * stepped into the middle of. Reordering against the text and rules between
   * objects would mean rewriting the whole stream rather than lifting one
   * object out of it, and that is a different and much less safe operation.
   */
  zoneOf(pageIndex: number, objectId: string): 'back' | 'page' | 'front' {
    return this.zOrder.get(pageIndex)?.get(objectId)?.zone ?? 'page';
  }

  /** Every object on the page that has been pushed to one side or the other. */
  private zEntries(pageIndex: number): ZOrderEdit[] {
    return [...(this.zOrder.get(pageIndex)?.values() ?? [])];
  }

  /**
   * Moves an object up or down the stack, or all the way to one end.
   *
   * A step out of the page's own rung lands at the near edge of the zone it
   * enters, so one step forward from the page puts an object just in front of
   * the page and behind anything already brought forward. Stepping back out of
   * a zone returns it to the page rather than skipping across.
   */
  restack(pageIndex: number, objectId: string, how: 'front' | 'back' | 'forward' | 'backward'): boolean {
    const entries = this.zEntries(pageIndex).filter((e) => e.objectId !== objectId);
    const front = entries.filter((e) => e.zone === 'front').sort((a, b) => a.rank - b.rank);
    const back = entries.filter((e) => e.zone === 'back').sort((a, b) => a.rank - b.rank);
    const current = this.zOrder.get(pageIndex)?.get(objectId) ?? null;

    let next: ZOrderEdit | null = null;
    if (how === 'front') {
      next = { objectId, zone: 'front', rank: (front[front.length - 1]?.rank ?? 0) + 1 };
    } else if (how === 'back') {
      next = { objectId, zone: 'back', rank: (back[0]?.rank ?? 0) - 1 };
    } else if (how === 'forward') {
      if (!current) next = { objectId, zone: 'front', rank: (front[0]?.rank ?? 1) - 1 };
      else if (current.zone === 'front') {
        // Swap with whatever is directly above, if anything is.
        const above = front.find((e) => e.rank > current.rank);
        if (!above) return false;
        next = { objectId, zone: 'front', rank: above.rank };
        above.rank = current.rank;
      } else {
        const above = [...back].reverse().find((e) => e.rank > current.rank);
        // Nothing above it in the back zone means the next rung up is the page.
        if (!above) next = null;
        else {
          next = { objectId, zone: 'back', rank: above.rank };
          above.rank = current.rank;
        }
      }
    } else {
      if (!current) next = { objectId, zone: 'back', rank: (back[back.length - 1]?.rank ?? -1) + 1 };
      else if (current.zone === 'back') {
        const below = [...back].reverse().find((e) => e.rank < current.rank);
        if (!below) return false;
        next = { objectId, zone: 'back', rank: below.rank };
        below.rank = current.rank;
      } else {
        const below = [...front].reverse().find((e) => e.rank < current.rank);
        if (!below) next = null;
        else {
          next = { objectId, zone: 'front', rank: below.rank };
          below.rank = current.rank;
        }
      }
    }

    if (next && current && next.zone === current.zone && next.rank === current.rank) return false;
    if (!next && !current) return false;

    const before = this.snapshot();
    let page = this.zOrder.get(pageIndex);
    if (!page) {
      page = new Map();
      this.zOrder.set(pageIndex, page);
    }
    // Neighbours that were swapped past have to be written back too.
    for (const e of [...front, ...back]) page.set(e.objectId, e);
    if (next) page.set(objectId, next);
    else page.delete(objectId);
    this.undoStack.push(before);
    this.redoStack = [];
    return true;
  }

  /**
   * Moves something drawn with the pen or a shape tool.
   *
   * Ink had no way to be moved at all: once drawn it could only be rubbed out
   * and drawn again, which is not an edit, it is a redo. The points carry the
   * position, so moving one is moving all of them.
   */
  moveInk(pageIndex: number, id: string, dx: number, dy: number): boolean {
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return false;
    const page = this.ink.get(pageIndex);
    const stroke = page?.get(id);
    if (!page || !stroke) return false;
    const before = this.snapshot();
    page.set(id, { ...stroke, points: stroke.points.map((q) => ({ x: q.x + dx, y: q.y + dy })) });
    this.undoStack.push(before);
    this.redoStack = [];
    return true;
  }

  /** Moves a drawing by a page-space delta. */
  moveGraphic(pageIndex: number, graphicId: string, dx: number, dy: number): boolean {
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return false;
    const before = this.snapshot();
    let page = this.graphicEdits.get(pageIndex);
    if (!page) {
      page = new Map();
      this.graphicEdits.set(pageIndex, page);
    }
    const current = page.get(graphicId);
    const next: GraphicEdit = {
      graphicId,
      dx: (current?.dx ?? 0) + dx,
      dy: (current?.dy ?? 0) + dy,
    };
    // Dragged back to where it started is not an edit, it is a change of mind.
    if (Math.abs(next.dx) < 0.01 && Math.abs(next.dy) < 0.01) page.delete(graphicId);
    else page.set(graphicId, next);
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
  /**
   * The document's own table of contents, if it has one.
   *
   * Every entry is resolved to a page here rather than when it is clicked,
   * because a destination can be a named one that needs another lookup, and
   * doing that on the click makes a list that sometimes does nothing. An entry
   * whose destination cannot be resolved keeps its place in the tree with no
   * page attached, since a heading is still worth reading even when the file
   * has lost track of where it pointed.
   */
  async outline(): Promise<OutlineEntry[]> {
    const pdf = this.pdfjsDoc;
    if (!pdf) return [];

    let raw: RawOutline[] | null = null;
    try {
      raw = (await pdf.getOutline()) as RawOutline[] | null;
    } catch {
      return [];
    }
    if (!raw?.length) return [];

    const pageOf = async (dest: RawOutline['dest']): Promise<number | null> => {
      try {
        const resolved = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
        const ref = Array.isArray(resolved) ? resolved[0] : null;
        if (!ref) return null;
        return await pdf.getPageIndex(ref as Parameters<typeof pdf.getPageIndex>[0]);
      } catch {
        return null;
      }
    };

    const convert = async (items: RawOutline[], depth: number): Promise<OutlineEntry[]> => {
      // A file can nest these as deeply as it likes, including in a loop.
      if (depth > 12) return [];
      const out: OutlineEntry[] = [];
      for (const item of items) {
        const title = (item.title ?? '').trim();
        if (!title) continue;
        out.push({
          title,
          pageIndex: await pageOf(item.dest),
          children: item.items?.length ? await convert(item.items, depth + 1) : [],
        });
      }
      return out;
    };

    return convert(raw, 0);
  }

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

  /** Fields being added to a page, which do not exist in the file yet. */
  newFieldsOn(pageIndex: number): NewField[] {
    return [...(this.newFields.get(pageIndex)?.values() ?? [])];
  }

  /**
   * Adds an interactive field to a page.
   *
   * The name is what it will be called in the saved file and in any data
   * exported from it, so it is asked for rather than generated: a form whose
   * fields are Field 1 through Field 9 is a form nobody can process.
   *
   * Made unique at build time rather than here, because a page deleted and
   * restored would otherwise keep renaming the same field.
   */
  addField(pageIndex: number, field: Omit<NewField, 'id'>): NewField | null {
    if (field.width < 4 || field.height < 4) return null;
    const before = this.snapshot();
    let page = this.newFields.get(pageIndex);
    if (!page) {
      page = new Map();
      this.newFields.set(pageIndex, page);
    }
    const made: NewField = { ...field, id: `field${this.nextFieldId++}` };
    page.set(made.id, made);
    this.undoStack.push(before);
    this.redoStack = [];
    return made;
  }

  /** Takes a field back off the page, before it has ever been in the file. */
  removeField(pageIndex: number, id: string): boolean {
    const page = this.newFields.get(pageIndex);
    if (!page?.has(id)) return false;
    const before = this.snapshot();
    page.delete(id);
    this.undoStack.push(before);
    this.redoStack = [];
    return true;
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
      ...this.lineStyles.keys(),
      ...this.graphicEdits.keys(),
      ...this.zOrder.keys(),
      ...this.erasures.keys(),
      ...this.redactions.keys(),
      ...this.insertions.keys(),
      ...this.stamps.keys(),
      ...this.notes.keys(),
      ...this.ink.keys(),
    ]);
    for (const pageIndex of touchedPages) {
      const pageEdits = this.edits.get(pageIndex) ?? new Map<string, string>();
      const pageOffsets = this.lineOffsets.get(pageIndex) ?? new Map<string, { dx: number; dy: number }>();
      const pageInsertions = [...(this.insertions.get(pageIndex)?.values() ?? [])];
      const pageStamps = [...(this.stamps.get(pageIndex)?.values() ?? [])];
      const pageImages = [...(this.imageEdits.get(pageIndex)?.values() ?? [])];
      const pageStyles = this.lineStyles.get(pageIndex) ?? new Map<string, LineStyle>();
      const pageGraphics = [...(this.graphicEdits.get(pageIndex)?.values() ?? [])];
      const pageZOrder = [...(this.zOrder.get(pageIndex)?.values() ?? [])];
      const pageErasures = [...(this.erasures.get(pageIndex)?.values() ?? [])];
      const pageRedactions = [...(this.redactions.get(pageIndex)?.values() ?? [])];
      const pageNotes = [...(this.notes.get(pageIndex)?.values() ?? [])];
      const pageInk = [...(this.ink.get(pageIndex)?.values() ?? [])];
      // Every kind of edit has to be listed here. A page reaches this loop
      // because it is in one of the maps above, and then leaves it again if
      // this test does not know about that map: freehand strokes were recorded
      // and counted and then quietly dropped on the way to the file.
      if (
        !pageEdits.size &&
        !pageOffsets.size &&
        !pageStyles.size &&
        !pageInsertions.length &&
        !pageStamps.length &&
        !pageImages.length &&
        !pageErasures.length &&
        !pageRedactions.length &&
        !pageNotes.length &&
        !pageInk.length &&
        !pageGraphics.length &&
        !pageZOrder.length
      ) {
        continue;
      }
      try {
        if (pageIndex >= doc.getPageCount()) continue;

        const page = doc.getPage(pageIndex);
        // Notes are annotations rather than page content, so they are attached
        // to the page object and never touch the content stream.
        if (pageNotes.length) addNotes(doc, page, pageNotes, pageIndex);
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
        for (const lineId of new Set([
          ...pageEdits.keys(),
          ...pageOffsets.keys(),
          ...redactRanges.keys(),
          ...pageStyles.keys(),
        ])) {
          const line = byId.get(lineId);
          if (!line) continue;
          const offset = pageOffsets.get(lineId);
          list.push({
            lineId,
            newText: pageEdits.get(lineId) ?? line.text,
            dx: offset?.dx ?? 0,
            dy: offset?.dy ?? 0,
            redact: redactRanges.get(lineId),
            style: pageStyles.get(lineId),
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
          pageInk,
          pageGraphics,
          pageZOrder,
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
            page:
              entry.doc === BLANK_PAGE
                ? null
                : entry.doc === 0
                  ? originals[entry.source]
                  : copiedByDoc.get(entry.doc)?.get(entry.source),
            blank: entry.doc === BLANK_PAGE,
            rotate: entry.rotate,
            crop: entry.crop,
          }))
          .filter((x) => x.blank || !!x.page);

        if (chosen.length) {
          for (let i = doc.getPageCount() - 1; i >= 0; i--) doc.removePage(i);
          // A blank page is sized like the last real page before it, falling
          // back to the first page of the document and then to US Letter.
          const fallback = originals[0]?.getSize() ?? { width: 612, height: 792 };
          let lastSize = fallback;
          for (const { page, blank, rotate, crop } of chosen) {
            if (blank || !page) {
              doc.addPage([lastSize.width, lastSize.height]);
              continue;
            }
            lastSize = page.getSize();
            if (rotate) page.setRotation(degrees((page.getRotation().angle + rotate) % 360));
            // Held inside the media box: a crop box that reaches outside it is
            // invalid, and readers disagree about what to do with one.
            if (crop) {
              const media = page.getMediaBox();
              const x = Math.max(media.x, crop.x);
              const y = Math.max(media.y, crop.y);
              const w = Math.min(media.x + media.width, crop.x + crop.width) - x;
              const h = Math.min(media.y + media.height, crop.y + crop.height) - y;
              if (w > 1 && h > 1) page.setCropBox(x, y, w, h);
            }
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

    // Said before anything else is written, since neither depends on the page
    // contents and both are what a reader needs before it starts reading.
    if (this.language) doc.catalog.set(PDFName.of('Lang'), PDFString.of(this.language));
    if (this.title) {
      doc.setTitle(this.title);
      // The flag that tells a reader to announce the title rather than the
      // filename. Setting a title without it changes nothing that anyone hears.
      const prefs = doc.catalog.lookup(PDFName.of('ViewerPreferences'));
      const target = prefs instanceof PDFDict ? prefs : doc.context.obj({});
      target.set(PDFName.of('DisplayDocTitle'), PDFBool.True);
      doc.catalog.set(PDFName.of('ViewerPreferences'), target);
    }

    // Fields are created before values are written, so a value typed into a
    // field that is itself being added still lands.
    if (this.newFields.size) {
      const byPage = new Map(
        [...this.newFields].map(([pageIndex, m]) => [pageIndex, [...m.values()]] as [number, NewField[]]),
      );
      for (const w of await addFields(doc, byPage)) {
        warnings.push({ lineId: w.field, kind: 'unencodable', detail: w.detail });
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
  /**
   * Lets go of the pdf.js worker and document.
   *
   * The worker is kept across reloads of the same document, so opening a new
   * one has to release the old one or every file opened in a session leaves a
   * thread behind it.
   */
  async close(): Promise<void> {
    await this.loadingTask?.destroy().catch(() => undefined);
    this.loadingTask = null;
    this.pdfjsDoc = null;
    this.worker?.destroy();
    this.worker = null;
  }

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
          paragraphs: groupParagraphs(lines),
          walk,
          contentBytes: content.bytes,
          cssFonts: new Map(),
        };
      } catch (e) {
        console.warn(`[handpress] page ${index + 1} produced no text model:`, e);
        const jsPage = await this.pdfjsDoc.getPage(index + 1).catch(() => null);
        const viewport = jsPage?.getViewport({ scale: 1 });
        model = {
          index,
          width: viewport?.width ?? 612,
          height: viewport?.height ?? 792,
          rotation: 0,
          lines: [],
          paragraphs: [],
          walk: {
            ops: [],
            images: [],
            paths: [],
            stateMarks: new Map(),
            streams: new Map(),
            fonts: new Map(),
            resources: new Map(),
          },
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
