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
import type { ImageOp, ShowOp, TextLine, TextSegment, WalkResult } from './content';
import { setPageContent } from './page';

export interface LineEdit {
  lineId: string;
  newText: string;
  /** Optional move, in page-space units. */
  dx?: number;
  dy?: number;
  /**
   * Character ranges to remove outright, for redaction.
   *
   * Unlike an ordinary text change these leave a gap of the same width, so the
   * words either side of a removed name stay exactly where they were.
   */
  redact?: Array<[number, number]>;
}

/**
 * An image stamped onto a page, which is how a signature is applied.
 *
 * Drawn into the page content rather than added as an annotation, so it is
 * flattened from the start: it cannot be moved or deleted by a reader, and it
 * survives printing and flattening by other software.
 */
export interface ImageStamp {
  id: string;
  /** PNG bytes, with transparency where the paper should show through. */
  png: Uint8Array;
  /** Bottom left corner in PDF page coordinates, y measured upwards. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A filled rectangle painted over the page.
 *
 * This covers content rather than deleting it. The characters underneath are
 * still in the file and can still be selected and copied out, which is exactly
 * why this is called erase and not redaction. Anything that must genuinely be
 * gone has to remove the operators that drew it.
 */
export interface RectFill {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: { r: number; g: number; b: number };
  /**
   * Draw multiplied against what is already there rather than over it.
   *
   * This is what makes a highlight a highlight: yellow laid opaquely over a
   * paragraph hides it, whereas multiplying darkens the paper and leaves the
   * text showing through exactly as a marker pen would.
   */
  blend?: boolean;
}

/** New text placed on a page that had none there before. */
export interface TextInsertion {
  id: string;
  /** Baseline origin in PDF page coordinates, y measured upwards. */
  x: number;
  y: number;
  size: number;
  color: { r: number; g: number; b: number };
  text: string;
  bold: boolean;
  italic: boolean;
  /**
   * Draw the glyphs invisibly, which is how a recognised text layer sits over a
   * scan: the words can be searched, selected and copied, while the page still
   * looks exactly like the picture it is.
   */
  invisible?: boolean;
  /**
   * Horizontal scaling as a percentage, used to stretch recognised words to the
   * width they occupy in the image so selection lines up with what is seen.
   */
  horizScale?: number;
}

/** A move or resize applied to an image already in the document. */
export interface ImageEdit {
  imageId: string;
  /** Move in page-space units. */
  dx: number;
  dy: number;
  /** Scale about the image's own lower-left corner. 1 leaves the size alone. */
  scale: number;
  /** True to remove the image from the page entirely. */
  remove?: boolean;
}

/** Describes the typeface a substitution needs. */
export interface FontRequest {
  /** Family name from the PDF, subset tag and style suffix removed. */
  family: string;
  bold: boolean;
  italic: boolean;
}

/**
 * Supplies real font files for substitutions, letting the caller source a closer
 * match than the standard fonts. Returning null falls back to a standard font.
 */
export interface FontProvider {
  fetch(req: FontRequest): Promise<Uint8Array | null>;
}

export interface EditWarning {
  lineId: string;
  kind: 'substituted-font' | 'unencodable' | 'stream-missing' | 'shared-text';
  detail: string;
}

interface Patch {
  start: number;
  end: number;
  bytes: Uint8Array;
  /** The line this patch came from, so a dropped one can be reported. */
  lineId?: string;
}

/** A font usable for output, wrapping either the document's own font or a substitute. */
interface OutFont {
  resourceName: string;
  /** Encodes text, returning drawing parts and total advance in 1/1000 em. */
  encode(text: string, spaceWidth?: number): { parts: EncodedPart[]; width: number; glyphs: number } | null;
  substituted: boolean;
  /** True when the substitute came from a real matching typeface. */
  local?: boolean;
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

/** Adds an image to a resource dictionary's XObject entry, returning its name. */
function addXObjectResource(resources: PDFDict, ref: PDFRef, preferred: string): string {
  let xobjects = resources.lookup(PDFName.of('XObject'));
  if (!(xobjects instanceof PDFDict)) {
    xobjects = resources.context.obj({}) as PDFDict;
    resources.set(PDFName.of('XObject'), xobjects);
  }
  const dict = xobjects as PDFDict;

  for (const [key, value] of dict.entries()) {
    if (value instanceof PDFRef && value === ref) return key.asString().replace(/^\//, '');
  }

  let name = preferred;
  let n = 0;
  while (dict.has(PDFName.of(name))) name = `${preferred}${++n}`;
  dict.set(PDFName.of(name), ref);
  return name;
}

/** Adds a graphics state to the resources and returns its name. */
function addExtGStateResource(resources: PDFDict, name: string, dict: PDFDict): string {
  let states = resources.lookup(PDFName.of('ExtGState'));
  if (!(states instanceof PDFDict)) {
    states = resources.context.obj({}) as PDFDict;
    resources.set(PDFName.of('ExtGState'), states);
  }
  const target = states as PDFDict;
  let unique = name;
  let n = 0;
  while (target.has(PDFName.of(unique)) && unique !== name) unique = `${name}${++n}`;
  if (!target.has(PDFName.of(unique))) target.set(PDFName.of(unique), dict);
  return unique;
}

/** Paints one rectangle, isolated so it cannot leak its state into the page. */
function buildRect(rect: RectFill, resources: PDFDict | null): Uint8Array {
  if (rect.width <= 0 || rect.height <= 0) return new Uint8Array(0);

  let blendPrefix = '';
  if (rect.blend && resources) {
    const gs = resources.context.obj({ Type: 'ExtGState', BM: 'Multiply' }) as PDFDict;
    blendPrefix = `/${addExtGStateResource(resources, 'VeMul', gs)} gs `;
  }

  return bytes(
    `\nq ${blendPrefix}${fmt(rect.color.r)} ${fmt(rect.color.g)} ${fmt(rect.color.b)} rg ` +
      `${fmt(rect.x)} ${fmt(rect.y)} ${fmt(rect.width)} ${fmt(rect.height)} re f Q\n`,
  );
}

/**
 * Builds the drawing operators for a stamped image.
 *
 * The transformation matrix carries the size, since an image XObject is always
 * drawn into the unit square. Wrapped in q/Q so it cannot leak that matrix into
 * whatever the page draws afterwards.
 */
async function buildStamp(
  stamp: ImageStamp,
  doc: PDFDocument,
  resources: PDFDict,
  cache: Map<string, string>,
  warn: (w: EditWarning) => void,
): Promise<Uint8Array> {
  let name = cache.get(stamp.id);
  if (!name) {
    try {
      const image = await doc.embedPng(stamp.png);
      name = addXObjectResource(resources, image.ref, 'VeIm');
      cache.set(stamp.id, name);
    } catch (e) {
      warn({ lineId: stamp.id, kind: 'stream-missing', detail: `could not embed the image: ${(e as Error).message}` });
      return new Uint8Array(0);
    }
  }
  return bytes(
    `\nq ${fmt(stamp.width)} 0 0 ${fmt(stamp.height)} ${fmt(stamp.x)} ${fmt(stamp.y)} cm /${name} Do Q\n`,
  );
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
  private embeddedCache = new Map<string, PDFFont | null>();
  private resourceNames = new Map<string, string>();
  private doc: PDFDocument;
  private provider: FontProvider | null;
  private fontkitReady = false;

  constructor(doc: PDFDocument, provider: FontProvider | null = null) {
    this.doc = doc;
    this.provider = provider;
  }

  /**
   * Embeds a real font file supplied by the provider, subset to what is used.
   * fontkit is loaded on demand so its cost is only paid when a document
   * actually needs a substitution.
   */
  private async embedProvided(font: LoadedFont): Promise<PDFFont | null> {
    if (!this.provider) return null;
    const key = `${font.family}|${font.bold}|${font.italic}`;
    const cached = this.embeddedCache.get(key);
    if (cached !== undefined) return cached;

    let embedded: PDFFont | null = null;
    try {
      const bytes = await this.provider.fetch({
        family: font.family || font.baseFont,
        bold: font.bold,
        italic: font.italic,
      });
      if (bytes) {
        if (!this.fontkitReady) {
          const fontkit = (await import('@pdf-lib/fontkit')).default;
          this.doc.registerFontkit(fontkit);
          this.fontkitReady = true;
        }
        embedded = await this.doc.embedFont(bytes, { subset: true });
      }
    } catch {
      embedded = null; // an unusable font file is not worth failing the edit over
    }
    this.embeddedCache.set(key, embedded);
    return embedded;
  }

  /** The document's own font, used whenever it can draw the text. */
  own(font: LoadedFont): OutFont {
    return {
      resourceName: font.resourceName,
      substituted: false,
      encode: (text, spaceWidth) => encodeText(font, text, spaceWidth),
    };
  }

  /**
   * A plain standard font, for text being added rather than replaced. Nothing in
   * the document implies a typeface for new text, so one of the built-in fonts
   * is used and no font file has to be embedded at all.
   */
  async standardFont(resources: PDFDict, bold: boolean, italic: boolean): Promise<OutFont | null> {
    const alias = `Helvetica${bold && italic ? 'BoldOblique' : bold ? 'Bold' : italic ? 'Oblique' : ''}`;
    let embedded = this.standardCache.get(alias);
    if (!embedded) {
      const std = (StandardFonts as Record<string, string>)[alias];
      if (!std) return null;
      embedded = await this.doc.embedFont(std as never);
      this.standardCache.set(alias, embedded);
    }

    const resKey = `${alias}@${resources.toString().length}`;
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
          return {
            parts: [{ bytes: f.encodeText(text).asBytes() }],
            width: f.widthOfTextAtSize(text, 1000),
            glyphs: [...text].length,
          };
        } catch {
          return null;
        }
      },
    };
  }

  /**
   * A replacement font for characters the document's own font lacks. A real
   * matching typeface from the provider is preferred; a style-matched standard
   * font is the fallback.
   */
  async substitute(font: LoadedFont, resources: PDFDict): Promise<OutFont | null> {
    const provided = await this.embedProvided(font);

    const alias = standardFontAlias(font) ?? 'Helvetica';
    const key = provided ? `local:${font.family}|${font.bold}|${font.italic}` : alias;

    let embedded = provided ?? this.standardCache.get(alias) ?? null;
    if (!embedded) {
      const std = (StandardFonts as Record<string, string>)[alias];
      if (!std) return null;
      embedded = await this.doc.embedFont(std as never);
      this.standardCache.set(alias, embedded);
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
      local: provided !== null,
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
  move: { dx: number; dy: number } = { dx: 0, dy: 0 },
  redact: Array<[number, number]> = [],
): Promise<Uint8Array | null> {
  const first = line.ops[0];
  // A leading space, because the operator before this one may end in a keyword
  // rather than a delimiter. `Td` followed straight by `-22.25` lexes as one
  // token named `Td-22.25`, which silently loses both the positioning and the
  // move: a dragged line then landed at the end of the previous line instead.
  const chunks: Uint8Array[] = [bytes(' ')];
  const th = first.horizScale / 100;

  let drawnAdvance = 0;

  // A move is expressed in the text's own frame: distance along the writing
  // direction, and distance perpendicular to it. Perpendicular movement uses
  // text rise, which shifts the baseline without touching the line matrix, so
  // every following line stays exactly where the producer put it.
  const scaleAlong = Math.hypot(first.toPage[0], first.toPage[1]) || 1;
  const scaleUp = Math.hypot(first.toPage[2], first.toPage[3]) || 1;
  const alongText = (move.dx * first.dirX + move.dy * first.dirY) / scaleAlong;
  const riseText = (-move.dx * first.dirY + move.dy * first.dirX) / scaleUp;

  if (Math.abs(riseText) > 1e-6) {
    chunks.push(bytes(`${fmt(first.rise + riseText)} Ts `));
  }
  if (Math.abs(alongText) > 1e-6 && first.fontSize !== 0) {
    chunks.push(bytes(`[${fmt((-alongText * 1000) / (first.fontSize * th))}]TJ `));
    drawnAdvance += alongText;
  }
  let currentFontName = first.fontResourceName;
  let currentFontSize = first.fontSize;
  let currentFill = { ...first.fill };
  let wroteAnything = false;

  for (let i = 0; i < line.segments.length; i++) {
    const seg = line.segments[i];
    let text = segTexts[i] ?? '';
    if (!text) continue;

    // The space that stands for the gap before the next segment is not drawn.
    // Nothing drew it in the original, and the gap below is emitted as a
    // positioning offset, so drawing it too counts the gap twice and slides
    // everything after it along. Changing one digit of a mileage moved the
    // separator and the VIN after it by a space width each.
    const nextText = segTexts[i + 1] ?? '';
    if (seg.syntheticTrailingSpace && text.endsWith(' ') && i + 1 < line.segments.length && nextText) {
      text = text.slice(0, -1);
      if (!text) continue;
    }

    // Preserve the horizontal gap the producer left before this segment, so
    // columns and tabs survive while edited text still reflows naturally.
    if (i > 0 && wroteAnything) {
      const prev = line.segments[i - 1];
      const scale = Math.hypot(seg.ops[0].toPage[0], seg.ops[0].toPage[1]) || 1;
      // Measured along the writing direction, so this stays correct for rotated
      // and mirrored text where a page-x difference would have the wrong sign.
      const gapPage = seg.u0 - prev.u1;
      if (Math.abs(gapPage) > 0.01) {
        const gapText = gapPage / scale;
        chunks.push(bytes(`[${fmt((-gapText * 1000) / (currentFontSize * th))}]TJ `));
        drawnAdvance += gapText;
      }
    }

    const segOp = seg.ops[0];
    const sizeForSeg = segOp.fontSize;

    // Redacted characters are dropped but their width is kept as a positioning
    // offset, so removing a name does not slide the rest of the line leftwards.
    const pieces: Array<{ text: string; gap: boolean }> = [];
    if (redact.length) {
      const chars = [...text];
      let cursor = 0;
      const local = redact
        .map(([a, b]) => [a - seg.start, b - seg.start] as [number, number])
        .filter(([a, b]) => b > 0 && a < chars.length)
        .map(([a, b]) => [Math.max(0, a), Math.min(chars.length, b)] as [number, number])
        .sort((x, y) => x[0] - y[0]);
      for (const [a, b] of local) {
        if (a > cursor) pieces.push({ text: chars.slice(cursor, a).join(''), gap: false });
        pieces.push({ text: chars.slice(a, b).join(''), gap: true });
        cursor = b;
      }
      if (cursor < chars.length) pieces.push({ text: chars.slice(cursor).join(''), gap: false });
    } else {
      pieces.push({ text, gap: false });
    }

    for (const piece of pieces) {
      if (!piece.text) continue;

      if (piece.gap) {
        // Measured with the segment's own font so the gap matches what was there.
        const measured = resolver.own(seg.font).encode(piece.text, spaceWidthFor(seg));
        const emWidth = measured ? measured.width : piece.text.length * 500;
        chunks.push(bytes(`[${fmt(-emWidth)}]TJ `));
        drawnAdvance += (emWidth / 1000) * currentFontSize * th;
        continue;
      }

    // Only the characters the document's own font cannot draw are substituted,
    // so a single unusual character never restyles the text around it.
    for (const span of coverageSpans(seg.font, piece.text)) {
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
            )}; drew that with ${sub.local ? `${seg.font.family} from this computer` : standardFontAlias(seg.font)}`,
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
  }

  // Restore the state this operator found, so the rest of the stream is unaffected.
  if (Math.abs(riseText) > 1e-6) {
    chunks.push(bytes(`${fmt(first.rise)} Ts `));
  }
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

/**
 * Builds the drawing operators for inserted text.
 *
 * Wrapped in q/Q and appended after everything else, so it draws on top and
 * cannot disturb the graphics state the rest of the page set up. Newlines
 * advance the baseline by a line and a fifth, matching normal leading.
 */
async function buildInsertion(
  insertion: TextInsertion,
  resolver: FontResolver,
  resources: PDFDict,
  warn: (w: EditWarning) => void,
): Promise<Uint8Array> {
  const font = await resolver.standardFont(resources, insertion.bold, insertion.italic);
  if (!font) {
    warn({ lineId: insertion.id, kind: 'unencodable', detail: 'could not embed a font for the added text' });
    return new Uint8Array(0);
  }

  const chunks: Uint8Array[] = [bytes('\nq BT ')];
  chunks.push(bytes(`/${font.resourceName} ${fmt(insertion.size)} Tf `));
  chunks.push(
    bytes(`${fmt(insertion.color.r)} ${fmt(insertion.color.g)} ${fmt(insertion.color.b)} rg `),
  );
  // Render mode 3 draws nothing while still laying the glyphs down for
  // selection, searching and copying.
  if (insertion.invisible) chunks.push(bytes('3 Tr '));
  if (insertion.horizScale && Math.abs(insertion.horizScale - 100) > 0.5) {
    chunks.push(bytes(`${fmt(insertion.horizScale)} Tz `));
  }

  const lines = insertion.text.split('\n');
  const leading = insertion.size * 1.2;
  let drew = false;

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (!text) continue;
    const encoded = font.encode(text);
    if (!encoded) {
      warn({
        lineId: insertion.id,
        kind: 'unencodable',
        detail: 'some added characters are outside the standard font and were dropped',
      });
      continue;
    }
    chunks.push(bytes(`1 0 0 1 ${fmt(insertion.x)} ${fmt(insertion.y - i * leading)} Tm `));
    chunks.push(tjArray(encoded.parts));
    chunks.push(bytes(' '));
    drew = true;
  }

  chunks.push(bytes('ET Q\n'));
  return drew ? concatBytes(chunks) : new Uint8Array(0);
}

/**
 * Rewrites an image's draw so it lands somewhere else, or at a different size.
 *
 * The placement of an image is entirely its transformation matrix, so the draw
 * is wrapped in its own q/Q with an extra matrix in front. The wanted shift is
 * in page space, but a matrix inserted here applies in the space the current
 * matrix maps from, so it is carried back through the inverse of that matrix's
 * linear part. Without that step an image on a rotated or scaled page moves in
 * the wrong direction and by the wrong distance.
 */
function buildImageEdit(image: ImageOp, edit: ImageEdit): Uint8Array {
  if (edit.remove) return new Uint8Array(0);

  const [a, b, c, d] = image.ctm;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) {
    // A degenerate matrix cannot be inverted; leaving the draw alone is safest.
    return bytes(`/${image.name} Do`);
  }

  const ux = (d * edit.dx - c * edit.dy) / det;
  const uy = (-b * edit.dx + a * edit.dy) / det;
  const s = edit.scale > 0 ? edit.scale : 1;

  // Scaling happens about the image's own origin, then the translation is
  // applied, so a resize grows from the corner the user is not dragging.
  return bytes(`q ${fmt(s)} 0 0 ${fmt(s)} ${fmt(ux)} ${fmt(uy)} cm /${image.name} Do Q`);
}

/**
 * Splices replacements into a stream.
 *
 * Two patches can cover the same bytes, and it is not a mistake in the caller:
 * a form XObject drawn several times on a page produces a line for each place
 * it appears, all reading from the one stream. Editing any of them rewrites the
 * text everywhere it is drawn, because there is only one copy of it. The first
 * patch wins and the rest are reported, so nothing is lost in silence.
 */
function applyPatches(
  source: Uint8Array,
  patches: Patch[],
  onDropped?: (patch: Patch) => void,
): Uint8Array {
  const sorted = [...patches].sort((a, b) => a.start - b.start);
  const out: Uint8Array[] = [];
  let cursor = 0;
  for (const p of sorted) {
    if (p.start < cursor) {
      onDropped?.(p);
      continue;
    }
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
  fontProvider: FontProvider | null = null,
  insertions: TextInsertion[] = [],
  stamps: ImageStamp[] = [],
  imageEdits: ImageEdit[] = [],
  rects: RectFill[] = [],
): Promise<ApplyResult> {
  const warnings: EditWarning[] = [];
  const warn = (w: EditWarning): void => {
    warnings.push(w);
  };
  const resolver = new FontResolver(doc, fontProvider);
  const byId = new Map(lines.map((l) => [l.id, l]));
  const patchesByStream = new Map<string, Patch[]>();
  let editedLines = 0;

  for (const edit of edits) {
    const line = byId.get(edit.lineId);
    if (!line) continue;
    const move = { dx: edit.dx ?? 0, dy: edit.dy ?? 0 };
    const moved = Math.abs(move.dx) > 1e-6 || Math.abs(move.dy) > 1e-6;
    const redacted = (edit.redact?.length ?? 0) > 0;
    if (edit.newText === line.text && !moved && !redacted) continue;
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
    const fragment = await buildLineFragment(line, segTexts, resolver, resources, warn, move, edit.redact ?? []);
    if (!fragment) continue; // warned already; leave this line untouched

    const list = patchesByStream.get(line.streamId) ?? [];
    list.push({ start: line.ops[0].start, end: line.ops[0].end, bytes: fragment, lineId: line.id });
    for (let i = 1; i < line.ops.length; i++) {
      list.push({ start: line.ops[i].start, end: line.ops[i].end, bytes: neutralAdvance(line.ops[i]) });
    }

    // Additional drawing passes of the same line get the same replacement, or
    // the old wording would still show through from underneath.
    for (const overlay of line.overlays) {
      const overlayTexts = mapTextToSegments(overlay, edit.newText);
      const overlayResources = walk.resources.get(overlay.streamId) ?? null;
      const overlayFragment = await buildLineFragment(overlay, overlayTexts, resolver, overlayResources, warn, move);
      if (!overlayFragment) continue;
      const overlayList = overlay.streamId === line.streamId ? list : (patchesByStream.get(overlay.streamId) ?? []);
      overlayList.push({
        start: overlay.ops[0].start,
        end: overlay.ops[0].end,
        bytes: overlayFragment,
        lineId: line.id,
      });
      for (let i = 1; i < overlay.ops.length; i++) {
        overlayList.push({ start: overlay.ops[i].start, end: overlay.ops[i].end, bytes: neutralAdvance(overlay.ops[i]) });
      }
      if (overlay.streamId !== line.streamId) patchesByStream.set(overlay.streamId, overlayList);
    }

    patchesByStream.set(line.streamId, list);
    editedLines++;
  }

  // Images already on the page are repositioned in place, by rewriting the
  // single operator that draws each one.
  if (imageEdits.length) {
    const byId = new Map(walk.images.map((im) => [`${im.streamId}:${im.index}`, im]));
    for (const edit of imageEdits) {
      const image = byId.get(edit.imageId);
      if (!image) continue;
      const list = patchesByStream.get(image.streamId) ?? [];
      list.push({ start: image.start, end: image.end, bytes: buildImageEdit(image, edit) });
      patchesByStream.set(image.streamId, list);
      editedLines++;
    }
  }

  // Added text is drawn after everything else so it sits on top, and it is
  // built here so it lands in the same rewrite as any edits to the page.
  let addedTail: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  if (insertions.length || stamps.length || rects.length) {
    const pageResources = walk.resources.get('page') ?? null;
    if (pageResources) {
      const built: Uint8Array[] = [];
      // Erasures go down first, then images, then text. That ordering is what
      // lets somebody cover something up and then write over the top of it.
      for (const rect of rects) built.push(buildRect(rect, pageResources));
      const imageCache = new Map<string, string>();
      for (const stamp of stamps) {
        built.push(await buildStamp(stamp, doc, pageResources, imageCache, warn));
      }
      for (const insertion of insertions) {
        if (!insertion.text.trim()) continue;
        built.push(await buildInsertion(insertion, resolver, pageResources, warn));
      }
      addedTail = concatBytes(built);
    } else {
      warn({ lineId: 'page', kind: 'stream-missing', detail: 'page has no resource dictionary for added content' });
    }
  }

  // A form drawn more than once gives every appearance its own line, all of
  // them reading the same bytes. Rewriting one rewrites all, so the caller is
  // told rather than left wondering where the other edits went.
  const reportShared = (patch: Patch): void => {
    warn({
      lineId: patch.lineId ?? 'page',
      kind: 'shared-text',
      detail:
        'That text is drawn more than once from the same place in the file, so every copy of it now reads the same.',
    });
  };

  const pagePatches = patchesByStream.get('page') ?? [];
  if (pagePatches.length || addedTail.length) {
    const patched = applyPatches(pageContentBytes, pagePatches, reportShared);
    // Anything added goes after the page's own drawing, which means it inherits
    // whatever transformation the page left in effect. Plenty of real files end
    // with a scale or a translation still applied, because nothing required
    // them to put it back, and a signature placed halfway down the page then
    // landed somewhere else at the wrong size.
    //
    // Wrapping the original in q/Q gives the added content the page's default
    // coordinates. The extra q also absorbs a stream that restores more times
    // than it saves, which would otherwise underflow into our own state.
    setPageContent(
      doc,
      page,
      addedTail.length
        ? concatBytes([bytes('q\n'), patched, bytes('\nQ\n'), addedTail])
        : patched,
    );
  }

  // Patches are gathered by the stream they land in, not by the path taken to
  // reach it. A form can be reached by more than one route, and a document
  // whose forms reference each other reaches the same one at several depths;
  // writing it once per route means every write but the last is thrown away.
  const byStream = new Map<string, { streamId: string; patches: Patch[] }>();
  for (const [streamId, patches] of patchesByStream) {
    if (streamId === 'page') continue; // handled above, together with added text
    const entry = walk.streams.get(streamId);
    if (!entry || !entry.ref) {
      warn({ lineId: streamId, kind: 'stream-missing', detail: 'could not write back form XObject' });
      continue;
    }
    const key = `${entry.ref.objectNumber} ${entry.ref.generationNumber}`;
    const existing = byStream.get(key);
    if (existing) existing.patches.push(...patches);
    else byStream.set(key, { streamId, patches: [...patches] });
  }

  for (const { streamId, patches } of byStream.values()) {
    const entry = walk.streams.get(streamId);
    if (!entry?.ref) continue; // already reported above
    const updated = applyPatches(entry.bytes, patches, reportShared);
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
