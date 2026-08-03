/**
 * Applies text edits by rewriting content streams.
 *
 * Only the byte ranges of show-text operators are touched; every positioning,
 * font and colour operator around them is left exactly as the producer wrote it.
 *
 * The rule that keeps documents intact is that each replacement is *advance
 * neutral*: it leaves the text matrix precisely where the original operator did.
 * An operator whose text was removed still emits its original advance as a
 * positioning offset, so nothing downstream in the stream shifts. That is what
 * lets a line be rewritten without disturbing the rest of the page.
 */

import { PDFDict, PDFDocument, PDFFont, PDFName, PDFPage, PDFRef, StandardFonts } from 'pdf-lib';
import { encodeLiteralString } from './lexer';
import { coverageSpans, encodeText, missingChars, standardFontAlias, type EncodedPart, type LoadedFont } from './fonts';
import type { ShowOp, TextLine, TextSegment, WalkResult } from './content';
import { setPageContent } from './page';

export interface LineEdit {
  lineId: string;
  newText: string;
}

export interface EditWarning {
  lineId: string;
  kind: 'substituted-font' | 'unencodable' | 'stream-missing';
  detail: string;
}

interface Patch {
  start: number;
  end: number;
  bytes: Uint8Array;
}

/** A font usable for output, wrapping either the document's own font or a substitute. */
interface OutFont {
  resourceName: string;
  /** Encodes text, returning drawing parts and total advance in 1/1000 em. */
  encode(text: string, spaceWidth?: number): { parts: EncodedPart[]; width: number; glyphs: number } | null;
  substituted: boolean;
}

const enc = new TextEncoder();

function bytes(s: string): Uint8Array {
  return enc.encode(s);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Formats a number for a content stream without exponent notation. */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
}

/**
 * Distributes edited line text back across the line's styled segments.
 *
 * Unchanged text keeps its original segment, so a bold label stays bold when the
 * sentence after it is retyped. The changed span is assigned to the segment
 * where the change begins, which is what a person means by "keep typing in the
 * style I clicked into".
 */
export function mapTextToSegments(line: TextLine, newText: string): string[] {
  const segs = line.segments;
  if (segs.length === 1) return [newText];

  const oldText = line.text;
  const oldChars = [...oldText];
  const newChars = [...newText];

  let prefix = 0;
  while (prefix < oldChars.length && prefix < newChars.length && oldChars[prefix] === newChars[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < oldChars.length - prefix &&
    suffix < newChars.length - prefix &&
    oldChars[oldChars.length - 1 - suffix] === newChars[newChars.length - 1 - suffix]
  ) {
    suffix++;
  }

  const midNew = newChars.slice(prefix, newChars.length - suffix).join('');
  const oldSuffixStart = oldChars.length - suffix;
  const newSuffixStart = newChars.length - suffix;

  // The edit lands in the segment containing the first changed character.
  let target = segs.findIndex((s) => prefix >= s.start && prefix < s.end);
  if (target < 0) target = prefix >= oldChars.length ? segs.length - 1 : 0;

  const out: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    let text = '';

    const pa = Math.max(s.start, 0);
    const pb = Math.min(s.end, prefix);
    if (pb > pa) text += oldChars.slice(pa, pb).join('');

    if (i === target) text += midNew;

    const sa = Math.max(s.start, oldSuffixStart);
    const sb = Math.max(s.end, oldSuffixStart);
    if (sb > sa && s.end > oldSuffixStart) {
      const from = newSuffixStart + (sa - oldSuffixStart);
      const to = newSuffixStart + (Math.min(sb, oldChars.length) - oldSuffixStart);
      text += newChars.slice(from, to).join('');
    }

    out.push(text);
  }
  return out;
}

/** Adds a standard font to a resource dictionary and returns its new resource name. */
function addFontResource(resources: PDFDict, ref: PDFRef, preferred: string): string {
  let fontDict = resources.lookup(PDFName.of('Font'));
  if (!(fontDict instanceof PDFDict)) {
    fontDict = resources.context.obj({}) as PDFDict;
    resources.set(PDFName.of('Font'), fontDict);
  }
  const dict = fontDict as PDFDict;

  // Reuse the entry if this exact font was already added.
  for (const [key, value] of dict.entries()) {
    if (value instanceof PDFRef && value === ref) return key.asString().replace(/^\//, '');
  }

  let name = preferred;
  let n = 0;
  while (dict.has(PDFName.of(name))) name = `${preferred}${++n}`;
  dict.set(PDFName.of(name), ref);
  return name;
}

class FontResolver {
  private standardCache = new Map<string, PDFFont>();
  private resourceNames = new Map<string, string>();
  private doc: PDFDocument;

  constructor(doc: PDFDocument) {
    this.doc = doc;
  }

  /** The document's own font, used whenever it can draw the text. */
  own(font: LoadedFont): OutFont {
    return {
      resourceName: font.resourceName,
      substituted: false,
      encode: (text, spaceWidth) => encodeText(font, text, spaceWidth),
    };
  }

  /** A standard font matched to the original's style, for characters it lacks. */
  async substitute(font: LoadedFont, resources: PDFDict): Promise<OutFont | null> {
    const alias = standardFontAlias(font) ?? 'Helvetica';
    const key = alias;
    let embedded = this.standardCache.get(key);
    if (!embedded) {
      const std = (StandardFonts as Record<string, string>)[alias];
      if (!std) return null;
      embedded = await this.doc.embedFont(std as never);
      this.standardCache.set(key, embedded);
    }

    const resKey = `${key}@${resources.toString().length}`;
    let resourceName = this.resourceNames.get(resKey);
    if (!resourceName) {
      resourceName = addFontResource(resources, embedded.ref, 'VeF');
      this.resourceNames.set(resKey, resourceName);
    }

    const f = embedded;
    return {
      resourceName,
      substituted: true,
      encode: (text) => {
        try {
          const hex = f.encodeText(text);
          const b = hex.asBytes();
          // Metrics are queried at 1000pt so the result is already per-mille.
          return { parts: [{ bytes: b }], width: f.widthOfTextAtSize(text, 1000), glyphs: [...text].length };
        } catch {
          return null;
        }
      },
    };
  }
}

/** Serialises encoded parts as a TJ array. */
function tjArray(parts: EncodedPart[]): Uint8Array {
  const chunks: Uint8Array[] = [bytes('[')];
  for (const p of parts) {
    if ('bytes' in p) chunks.push(encodeLiteralString(p.bytes));
    else chunks.push(bytes(fmt(-p.offset)));
    chunks.push(bytes(' '));
  }
  chunks.push(bytes(']TJ'));
  return concatBytes(chunks);
}

/**
 * Advance contributed by character spacing, in unscaled text space units.
 * Glyph and offset advances are already accounted for by the encoder's `width`,
 * so only the per-glyph spacing term is added here.
 */
function spacingAdvance(glyphs: number, charSpacing: number, horizScale: number): number {
  return charSpacing * (horizScale / 100) * glyphs;
}

/**
 * Builds the replacement bytes for the operator that carries a line's text.
 * Everything the line draws is emitted here; the line's other operators become
 * pure advances.
 */
async function buildLineFragment(
  line: TextLine,
  segTexts: string[],
  resolver: FontResolver,
  resources: PDFDict | null,
  warn: (w: EditWarning) => void,
): Promise<Uint8Array | null> {
  const first = line.ops[0];
  const chunks: Uint8Array[] = [];
  const th = first.horizScale / 100;

  let drawnAdvance = 0;
  let currentFontName = first.fontResourceName;
  let currentFontSize = first.fontSize;
  let currentFill = { ...first.fill };
  let wroteAnything = false;

  for (let i = 0; i < line.segments.length; i++) {
    const seg = line.segments[i];
    const text = segTexts[i] ?? '';
    if (!text) continue;

    // Preserve the horizontal gap the producer left before this segment, so
    // columns and tabs survive while edited text still reflows naturally.
    if (i > 0 && wroteAnything) {
      const prev = line.segments[i - 1];
      const scale = Math.hypot(seg.ops[0].toPage[0], seg.ops[0].toPage[1]) || 1;
      const gapPage = seg.x0 - prev.x1;
      if (Math.abs(gapPage) > 0.01) {
        const gapText = gapPage / scale;
        chunks.push(bytes(`[${fmt((-gapText * 1000) / (currentFontSize * th))}]TJ `));
        drawnAdvance += gapText;
      }
    }

    const segOp = seg.ops[0];
    const sizeForSeg = segOp.fontSize;

    // Only the characters the document's own font cannot draw are substituted,
    // so a single unusual character never restyles the text around it.
    for (const span of coverageSpans(seg.font, text)) {
      let out: OutFont = resolver.own(seg.font);
      let encoded = span.covered ? out.encode(span.text, spaceWidthFor(seg)) : null;

      if (!encoded) {
        const sub = resources ? await resolver.substitute(seg.font, resources) : null;
        const subEncoded = sub ? sub.encode(span.text) : null;
        if (sub && subEncoded) {
          out = sub;
          encoded = subEncoded;
          warn({
            lineId: line.id,
            kind: 'substituted-font',
            detail: `${seg.font.family || seg.font.baseFont || 'font'} has no glyph for ${JSON.stringify(
              missingChars(seg.font, span.text).join(''),
            )}; drew that with ${standardFontAlias(seg.font)}`,
          });
        } else {
          warn({
            lineId: line.id,
            kind: 'unencodable',
            detail: `cannot encode ${JSON.stringify(missingChars(seg.font, span.text).join(''))}`,
          });
          return null;
        }
      }

      if (out.resourceName !== currentFontName || sizeForSeg !== currentFontSize) {
        chunks.push(bytes(`/${out.resourceName} ${fmt(sizeForSeg)} Tf `));
        currentFontName = out.resourceName;
        currentFontSize = sizeForSeg;
      }

      const fill = seg.fill;
      if (fill.r !== currentFill.r || fill.g !== currentFill.g || fill.b !== currentFill.b) {
        chunks.push(bytes(`${fmt(fill.r)} ${fmt(fill.g)} ${fmt(fill.b)} rg `));
        currentFill = { ...fill };
      }

      chunks.push(tjArray(encoded.parts));
      chunks.push(bytes(' '));
      drawnAdvance +=
        (encoded.width / 1000) * currentFontSize * th +
        spacingAdvance(encoded.glyphs ?? 0, segOp.charSpacing, segOp.horizScale);
      wroteAnything = true;
    }
  }

  // Restore the state this operator found, so the rest of the stream is unaffected.
  if (currentFontName !== first.fontResourceName || currentFontSize !== first.fontSize) {
    chunks.push(bytes(`/${first.fontResourceName} ${fmt(first.fontSize)} Tf `));
  }
  if (
    currentFill.r !== first.fill.r ||
    currentFill.g !== first.fill.g ||
    currentFill.b !== first.fill.b
  ) {
    chunks.push(bytes(`${fmt(first.fill.r)} ${fmt(first.fill.g)} ${fmt(first.fill.b)} rg `));
  }

  // Match the advance the original operator produced, so nothing downstream moves.
  const correction = first.advance - drawnAdvance;
  if (Math.abs(correction) > 1e-6 && first.fontSize !== 0) {
    chunks.push(bytes(`[${fmt((-correction * 1000) / (first.fontSize * th))}]TJ`));
  }

  return concatBytes(chunks);
}

/**
 * Width of a space for this segment, used when the font has no space glyph.
 * The gap actually measured in the document beats any default, since that is
 * the spacing the reader will compare against.
 */
function spaceWidthFor(seg: TextSegment): number | undefined {
  if (seg.font.fromUnicode.has(' ')) return undefined; // a real glyph exists
  if (seg.spaceWidth && seg.spaceWidth > 0) return seg.spaceWidth;
  return seg.font.widths.get(32) ?? 250;
}

/** Replaces an operator with a pure advance equal to the one it produced. */
function neutralAdvance(op: ShowOp): Uint8Array {
  if (op.fontSize === 0 || Math.abs(op.advance) < 1e-6) return new Uint8Array(0);
  const th = op.horizScale / 100;
  return bytes(`[${fmt((-op.advance * 1000) / (op.fontSize * th))}]TJ`);
}

function applyPatches(source: Uint8Array, patches: Patch[]): Uint8Array {
  const sorted = [...patches].sort((a, b) => a.start - b.start);
  const out: Uint8Array[] = [];
  let cursor = 0;
  for (const p of sorted) {
    if (p.start < cursor) continue; // overlapping patch; first one wins
    out.push(source.subarray(cursor, p.start));
    out.push(p.bytes);
    cursor = p.end;
  }
  out.push(source.subarray(cursor));
  return concatBytes(out);
}

export interface ApplyResult {
  warnings: EditWarning[];
  editedLines: number;
}

/**
 * Applies line edits to one page, rewriting the affected content streams.
 * Streams the edits never touch are left byte-identical.
 */
export async function applyEdits(
  doc: PDFDocument,
  page: PDFPage,
  walk: WalkResult,
  lines: TextLine[],
  edits: LineEdit[],
  pageContentBytes: Uint8Array,
): Promise<ApplyResult> {
  const warnings: EditWarning[] = [];
  const warn = (w: EditWarning): void => {
    warnings.push(w);
  };
  const resolver = new FontResolver(doc);
  const byId = new Map(lines.map((l) => [l.id, l]));
  const patchesByStream = new Map<string, Patch[]>();
  let editedLines = 0;

  for (const edit of edits) {
    const line = byId.get(edit.lineId);
    if (!line) continue;
    if (edit.newText === line.text) continue;
    if (!line.editable) {
      warn({
        lineId: line.id,
        kind: 'unencodable',
        detail: 'font has no reliable character mapping; left unchanged',
      });
      continue;
    }

    const resources = walk.resources.get(line.streamId) ?? null;
    const segTexts = mapTextToSegments(line, edit.newText);
    const fragment = await buildLineFragment(line, segTexts, resolver, resources, warn);
    if (!fragment) continue; // warned already; leave this line untouched

    const list = patchesByStream.get(line.streamId) ?? [];
    list.push({ start: line.ops[0].start, end: line.ops[0].end, bytes: fragment });
    for (let i = 1; i < line.ops.length; i++) {
      list.push({ start: line.ops[i].start, end: line.ops[i].end, bytes: neutralAdvance(line.ops[i]) });
    }
    patchesByStream.set(line.streamId, list);
    editedLines++;
  }

  for (const [streamId, patches] of patchesByStream) {
    if (streamId === 'page') {
      setPageContent(doc, page, applyPatches(pageContentBytes, patches));
      continue;
    }
    const entry = walk.streams.get(streamId);
    if (!entry || !entry.ref) {
      warn({ lineId: streamId, kind: 'stream-missing', detail: 'could not write back form XObject' });
      continue;
    }
    const updated = applyPatches(entry.bytes, patches);
    const newStream = doc.context.flateStream(updated);
    for (const [key, value] of entry.stream.dict.entries()) {
      const name = key.asString().replace(/^\//, '');
      if (name === 'Length' || name === 'Filter' || name === 'DecodeParms' || name === 'DL') continue;
      newStream.dict.set(key, value);
    }
    doc.context.assign(entry.ref, newStream);
  }

  return { warnings, editedLines };
}
