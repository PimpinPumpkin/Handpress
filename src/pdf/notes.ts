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

import { PDFDocument, PDFHexString, PDFName, PDFPage, PDFString } from 'pdf-lib';

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
export function addNotes(doc: PDFDocument, page: PDFPage, notes: PageNote[]): void {
  for (const note of notes) {
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

    page.node.addAnnot(doc.context.register(dict));
  }
}
