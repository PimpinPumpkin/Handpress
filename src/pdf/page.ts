/**
 * Page-level content access.
 *
 * A page's `/Contents` may be a single stream or an array of streams that the
 * viewer concatenates. Editing is far simpler against one buffer, so arrays are
 * merged up front and written back as a single stream.
 */

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFPage,
  PDFRawStream,
  PDFStream,
  decodePDFRawStream,
} from 'pdf-lib';

export interface PageContent {
  bytes: Uint8Array;
  resources: PDFDict | null;
  /** True when several streams were concatenated to build `bytes`. */
  merged: boolean;
  mediaBox: { x: number; y: number; width: number; height: number };
  rotation: number;
}

function decode(stream: PDFStream): Uint8Array | null {
  try {
    if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
    const anyStream = stream as unknown as { getContents?: () => Uint8Array };
    return anyStream.getContents ? anyStream.getContents() : null;
  } catch {
    return null;
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  // A newline between streams prevents an operator at a boundary from fusing
  // with the next stream's first token.
  const total = parts.reduce((a, p) => a + p.length + 1, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
    out[o++] = 0x0a;
  }
  return out;
}

export function getPageContent(page: PDFPage): PageContent {
  const node = page.node;
  const contents = node.Contents();
  const parts: Uint8Array[] = [];
  let merged = false;

  if (contents instanceof PDFArray) {
    merged = contents.size() > 1;
    for (let i = 0; i < contents.size(); i++) {
      const s = contents.lookup(i);
      if (s instanceof PDFStream) {
        const b = decode(s);
        if (b) parts.push(b);
      }
    }
  } else if (contents instanceof PDFStream) {
    const b = decode(contents);
    if (b) parts.push(b);
  }

  // Both of these ask pdf-lib to walk the page tree, and both throw outright on
  // a damaged one: a `/Resources` that is a stream, a missing `/MediaBox`, a
  // `/Parent` chain that loops or points at the wrong kind of object. None of
  // that should take a document down. A page with no resources is a page with
  // no editable text, and a page with no media box gets the size everything
  // else assumes.
  let resources: PDFDict | null = null;
  try {
    const resRaw = node.Resources();
    if (resRaw instanceof PDFDict) resources = resRaw;
  } catch {
    resources = null;
  }

  let mb = { x: 0, y: 0, width: 612, height: 792 };
  try {
    mb = page.getMediaBox();
  } catch {
    // Left at US Letter, which is what a reader falls back to as well.
  }
  const rotRaw = node.lookup(PDFName.of('Rotate'));
  const rotation = rotRaw instanceof PDFNumber ? ((rotRaw.asNumber() % 360) + 360) % 360 : 0;

  return {
    bytes: parts.length === 1 ? parts[0] : concat(parts),
    resources,
    merged,
    mediaBox: { x: mb.x, y: mb.y, width: mb.width, height: mb.height },
    rotation,
  };
}

/** Replaces a page's content streams with a single new stream. */
export function setPageContent(doc: PDFDocument, page: PDFPage, bytes: Uint8Array): void {
  const stream = doc.context.flateStream(bytes);
  const ref = doc.context.register(stream);
  page.node.set(PDFName.of('Contents'), ref);
}

/** Replaces the bytes of a form XObject stream, preserving its other dict entries. */
export function replaceStreamBytes(doc: PDFDocument, target: PDFStream, bytes: Uint8Array): void {
  const newStream = doc.context.flateStream(bytes);
  // Carry over every entry the original declared apart from the ones that
  // describe the old encoding, so BBox/Matrix/Resources survive.
  const skip = new Set(['Length', 'Filter', 'DecodeParms', 'DL']);
  for (const [key, value] of target.dict.entries()) {
    const name = key.asString().replace(/^\//, '');
    if (skip.has(name)) continue;
    newStream.dict.set(key, value);
  }
  const anyTarget = target as unknown as { dict: PDFDict };
  // Swap the contents in place by mutating the original object's dict and data.
  const ctx = doc.context;
  const ref = ctx.getObjectRef(target as never);
  if (ref) {
    ctx.assign(ref, newStream);
  } else {
    anyTarget.dict = newStream.dict;
  }
}
