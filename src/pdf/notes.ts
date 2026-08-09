/**
 * Sticky note annotations.
 *
 * A note is a comment attached to a point on the page, not something drawn onto
 * it. It is written as a real `/Text` annotation, which is what every other
 * reader already understands: Acrobat, Preview and the browser viewers all show
 * it as a note icon that opens the comment, and a reviewer can reply to it.
 * Drawing the words onto the page instead would look similar and be useless,
 * because nothing downstream would know it was a comment.
 */

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFPage,
  PDFRef,
  PDFString,
} from 'pdf-lib';

export interface PageNote {
  id: string;
  /** Top left of the note icon, in page coordinates with y measured upwards. */
  x: number;
  y: number;
  text: string;
  /** Who wrote it. Empty is allowed; readers show the note without a name. */
  author: string;
  /** When it was written, as milliseconds since the epoch. */
  written: number;
  /**
   * The note this one answers, if it is a reply.
   *
   * A reply is an ordinary annotation carrying /IRT, which points at the one
   * being answered, and /RT /R to say the relationship is a reply rather than
   * a grouping. That is the PDF specification's own mechanism and therefore
   * Acrobat's: nothing proprietary is involved, and a thread written here
   * opens as a thread in Acrobat, Preview and anything else that reads
   * annotations.
   */
  replyTo?: string;
}

/** A note already in the document when it was opened. */
export interface ExistingNote {
  /** Page and position among that page's annotations, which is stable across rebuilds. */
  id: string;
  pageIndex: number;
  x: number;
  y: number;
  text: string;
  author: string;
  written: number;
  /** The id of the note this answers, for comments that are already threaded. */
  replyTo?: string;
}

/** Icon size in points. Readers draw their own icon; this is the box it fits. */
export const NOTE_SIZE = 20;

/**
 * Attaches notes to a page.
 *
 * Text goes in as a hex string, which is UTF-16 and therefore able to carry a
 * comment written in any language. A literal string would be limited to the
 * document's own encoding and would mangle anything outside it.
 */
export function addNotes(doc: PDFDocument, page: PDFPage, notes: PageNote[], pageIndex = 0): void {
  // Refs of the notes written here, so a reply added in the same pass can
  // point at its parent. Replies to notes that were already in the file are
  // resolved through the page's own annotation list instead.
  const written = new Map<string, PDFRef>();
  const existing = annotRefs(page);

  const parentOf = (note: PageNote): PDFRef | null => {
    if (!note.replyTo) return null;
    const here = written.get(note.replyTo);
    if (here) return here;
    const prefix = `${pageIndex}:`;
    if (!note.replyTo.startsWith(prefix)) return null;
    return existing[Number(note.replyTo.slice(prefix.length))] ?? null;
  };

  // Parents before replies, and replies to replies after those, so a chain of
  // any depth resolves. Anything still unresolved after a pass that changed
  // nothing is orphaned and written as a note of its own rather than lost.
  const pending = [...notes];
  for (let guard = 0; pending.length && guard < 12; guard++) {
    const stuck: PageNote[] = [];
    for (const note of pending) {
      const parent = note.replyTo ? parentOf(note) : null;
      if (note.replyTo && !parent) {
        stuck.push(note);
        continue;
      }
      written.set(note.id, writeOne(doc, page, note, parent));
    }
    if (stuck.length === pending.length) {
      for (const note of stuck) written.set(note.id, writeOne(doc, page, note, null));
      break;
    }
    pending.length = 0;
    pending.push(...stuck);
  }
}

/** The refs of a page's annotations, in the order the page lists them. */
function annotRefs(page: PDFPage): PDFRef[] {
  const raw = page.node.get(PDFName.of('Annots'));
  const arr = raw instanceof PDFRef ? page.node.lookup(PDFName.of('Annots')) : raw;
  if (!(arr instanceof PDFArray)) return [];
  const out: PDFRef[] = [];
  for (let i = 0; i < arr.size(); i++) {
    const v = arr.get(i);
    if (v instanceof PDFRef) out.push(v);
  }
  return out;
}

function writeOne(doc: PDFDocument, page: PDFPage, note: PageNote, parent: PDFRef | null): PDFRef {
  {
    const dict = doc.context.obj({
      Type: 'Annot',
      Subtype: 'Text',
      // Readers size the icon themselves, but a sane rectangle keeps the
      // position honest for the ones that do not.
      Rect: [note.x, note.y - NOTE_SIZE, note.x + NOTE_SIZE, note.y],
      Contents: PDFHexString.fromText(note.text),
      Name: 'Comment',
      // Print, so the note is not silently dropped when the page is printed
      // with annotations turned on.
      F: 4,
      C: [1, 0.83, 0.25],
      M: PDFString.fromDate(new Date(note.written)),
      CreationDate: PDFString.fromDate(new Date(note.written)),
      // Closed, because a page of notes all sprung open is unreadable.
      Open: false,
    });
    if (note.author.trim()) dict.set(PDFName.of('T'), PDFHexString.fromText(note.author));
    if (parent) {
      dict.set(PDFName.of('IRT'), parent);
      // R rather than Group: this answers the note, it is not another view of
      // it. Readers thread on the first and merge on the second.
      dict.set(PDFName.of('RT'), PDFName.of('R'));
    }

    const ref = doc.context.register(dict);
    page.node.addAnnot(ref);
    return ref;
  }
}

/**
 * Reads the comments a document arrived with.
 *
 * Without this, replying would only ever work on notes made in the same
 * session, which is not what a comment thread is for: the point is answering
 * something somebody else wrote.
 *
 * Identity is the page and the position in that page's annotation list, which
 * is stable because every build starts again from the original bytes.
 */
export function readNotes(doc: PDFDocument): ExistingNote[] {
  const out: ExistingNote[] = [];
  const pages = doc.getPages();

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const refs = annotRefs(pages[pageIndex]);
    const indexByRef = new Map(refs.map((r, i) => [r.toString(), i]));

    for (let i = 0; i < refs.length; i++) {
      const dict = doc.context.lookup(refs[i]);
      if (!(dict instanceof PDFDict)) continue;
      const subtype = dict.lookup(PDFName.of('Subtype'));
      if (!(subtype instanceof PDFName) || subtype.asString() !== '/Text') continue;

      const rect = dict.lookup(PDFName.of('Rect'));
      let x = 0;
      let y = 0;
      if (rect instanceof PDFArray && rect.size() >= 4) {
        const n = (k: number): number => {
          const v = rect.lookup(k);
          return v instanceof PDFNumber ? v.asNumber() : 0;
        };
        x = Math.min(n(0), n(2));
        y = Math.max(n(1), n(3));
      }

      const irt = dict.get(PDFName.of('IRT'));
      const parent = irt instanceof PDFRef ? indexByRef.get(irt.toString()) : undefined;

      out.push({
        id: `${pageIndex}:${i}`,
        pageIndex,
        x,
        y,
        text: readText(dict, 'Contents'),
        author: readText(dict, 'T'),
        written: readDate(dict),
        replyTo: parent === undefined ? undefined : `${pageIndex}:${parent}`,
      });
    }
  }
  return out;
}

function readText(dict: PDFDict, key: string): string {
  const v = dict.lookup(PDFName.of(key));
  if (v instanceof PDFHexString || v instanceof PDFString) {
    try {
      return v.decodeText();
    } catch {
      return '';
    }
  }
  return '';
}

function readDate(dict: PDFDict): number {
  for (const key of ['M', 'CreationDate']) {
    const v = dict.lookup(PDFName.of(key));
    if (v instanceof PDFString) {
      try {
        return v.decodeDate().getTime();
      } catch {
        // A date a reader wrote in its own way is not worth failing over.
      }
    }
  }
  return 0;
}
