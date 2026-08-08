/**
 * Font analysis for editing.
 *
 * Editing text in place only works if the replacement characters can be encoded
 * with a font the page already carries. Embedded fonts are almost always subset
 * to the glyphs the document uses, so "can this font draw the letter I just
 * typed?" is a real question with a per-character answer.
 *
 * The ToUnicode CMap answers it. It maps character codes to Unicode for
 * copy/paste, and inverting it yields both a Unicode -> code encoder and an
 * honest coverage test: a character absent from the inverse is one the subset
 * very likely cannot draw.
 */

import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream } from 'pdf-lib';
import { Encodings, Font, type FontNames } from '@pdf-lib/standard-fonts';
import { Lexer, Tok, type Token } from './lexer';
import { baseEncodingByName, glyphNameToUnicode, StandardEncoding, WinAnsiEncoding } from './encodings';

export type FontFileKind = 'ttf' | 'cff' | 'type1' | 'otf' | 'none';

export interface LoadedFont {
  /** Name used in the content stream, without the slash (e.g. `F1`). */
  resourceName: string;
  ref: PDFRef | null;
  dict: PDFDict;
  subtype: string;
  baseFont: string;
  /** BaseFont with the `ABCDEF+` subset tag and style suffix removed. */
  family: string;
  bold: boolean;
  italic: boolean;
  serif: boolean;
  fixedPitch: boolean;
  symbolic: boolean;
  /** True for Type0 fonts, whose codes are two bytes wide. */
  twoByte: boolean;
  type3: boolean;
  /** Widths in 1/1000 em, keyed by character code (CID for Type0). */
  widths: Map<number, number>;
  missingWidth: number;
  /** code -> Unicode text. */
  toUnicode: Map<number, string>;
  /** Unicode text -> code. The editable character set of this font. */
  fromUnicode: Map<string, number>;
  /** True when `fromUnicode` came from a real ToUnicode CMap rather than a guess. */
  hasToUnicode: boolean;
  /**
   * Whether the decoded text can be trusted to be what a reader sees.
   *
   * Without a ToUnicode CMap or a recognised encoding, character codes are
   * guessed from a standard table and can decode to plausible-looking nonsense.
   * Editing text we cannot read would silently corrupt the page, so callers
   * treat these runs as read-only rather than showing a confident wrong answer.
   */
  decodeConfident: boolean;
  ascent: number;
  descent: number;
  capHeight: number;
  italicAngle: number;
  embedded: boolean;
  fontFileKind: FontFileKind;
  /** Set for Type3 fonts, whose glyph space is not 1/1000 em. */
  fontMatrix: number[] | null;
}

const SUBSET_TAG = /^[A-Z]{6}\+/;

function stripSubsetTag(name: string): string {
  return SUBSET_TAG.test(name) ? name.slice(7) : name;
}

function num(dict: PDFDict, key: string, fallback: number): number {
  const v = dict.lookup(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : fallback;
}

/** Reads a stream's decoded bytes, tolerating filters pdf-lib cannot handle. */
function streamBytes(stream: PDFStream | undefined): Uint8Array | null {
  if (!stream) return null;
  try {
    if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
    // Already-decoded content streams expose their contents directly.
    const anyStream = stream as unknown as { getContents?: () => Uint8Array };
    return anyStream.getContents ? anyStream.getContents() : null;
  } catch {
    return null;
  }
}

function bytesToCode(b: Uint8Array): number {
  let v = 0;
  for (const byte of b) v = (v << 8) | byte;
  return v >>> 0;
}

function utf16beToString(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
  if (b.length === 1) s = String.fromCharCode(b[0]);
  return s;
}

/**
 * Parses the subset of CMap syntax used by ToUnicode streams. CMaps are written
 * in PDF object syntax, so the content-stream lexer reads them directly.
 */
function parseToUnicodeCMap(bytes: Uint8Array): Map<number, string> {
  const map = new Map<number, string>();
  let toks: Token[];
  try {
    toks = Lexer.tokenize(bytes);
  } catch {
    return map;
  }

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind !== Tok.Op) continue;

    if (t.name === 'beginbfchar') {
      let j = i + 1;
      while (j < toks.length && !(toks[j].kind === Tok.Op && toks[j].name === 'endbfchar')) {
        const src = toks[j];
        const dst = toks[j + 1];
        if (src?.kind === Tok.Str && dst?.kind === Tok.Str) {
          map.set(bytesToCode(src.bytes!), utf16beToString(dst.bytes!));
          j += 2;
        } else if (src?.kind === Tok.Str && dst?.kind === Tok.Name) {
          const u = glyphNameToUnicode(dst.name!);
          if (u >= 0) map.set(bytesToCode(src.bytes!), String.fromCodePoint(u));
          j += 2;
        } else {
          j++;
        }
      }
      i = j;
      continue;
    }

    if (t.name === 'beginbfrange') {
      let j = i + 1;
      while (j < toks.length && !(toks[j].kind === Tok.Op && toks[j].name === 'endbfrange')) {
        const lo = toks[j];
        const hi = toks[j + 1];
        const dst = toks[j + 2];
        if (lo?.kind !== Tok.Str || hi?.kind !== Tok.Str || !dst) {
          j++;
          continue;
        }
        const loCode = bytesToCode(lo.bytes!);
        const hiCode = bytesToCode(hi.bytes!);
        // Guard against absurd ranges from malformed files.
        const span = Math.min(hiCode - loCode, 0xffff);

        if (dst.kind === Tok.Str) {
          const base = dst.bytes!;
          for (let k = 0; k <= span; k++) {
            // Only the final UTF-16 unit increments across a bfrange.
            const copy = Uint8Array.from(base);
            if (copy.length >= 2) {
              const last = ((copy[copy.length - 2] << 8) | copy[copy.length - 1]) + k;
              copy[copy.length - 2] = (last >> 8) & 0xff;
              copy[copy.length - 1] = last & 0xff;
            } else if (copy.length === 1) {
              copy[0] = (copy[0] + k) & 0xff;
            }
            map.set(loCode + k, utf16beToString(copy));
          }
          j += 3;
        } else if (dst.kind === Tok.ArrayOpen) {
          let k = 0;
          let m = j + 3;
          while (m < toks.length && toks[m].kind !== Tok.ArrayClose) {
            if (toks[m].kind === Tok.Str) map.set(loCode + k++, utf16beToString(toks[m].bytes!));
            m++;
          }
          j = m + 1;
        } else {
          j += 3;
        }
      }
      i = j;
    }
  }
  return map;
}

/** Builds code -> Unicode for a simple font from its Encoding entry. */
function simpleEncodingMap(
  fontDict: PDFDict,
  symbolic: boolean,
): { map: Map<number, string>; explicit: boolean } {
  const out = new Map<number, string>();
  const enc = fontDict.lookup(PDFName.of('Encoding'));

  let base: (string | undefined)[] | null = null;
  let differences: PDFArray | null = null;

  if (enc instanceof PDFName) {
    base = baseEncodingByName(enc.asString().replace(/^\//, ''));
  } else if (enc instanceof PDFDict) {
    const be = enc.lookup(PDFName.of('BaseEncoding'));
    if (be instanceof PDFName) base = baseEncodingByName(be.asString().replace(/^\//, ''));
    const diff = enc.lookup(PDFName.of('Differences'));
    if (diff instanceof PDFArray) differences = diff;
  }

  // An explicitly named encoding, or differences that resolve to real glyph
  // names, mean the mapping is stated by the file rather than assumed.
  const namedBase = base !== null;

  // A symbolic font with no stated encoding uses its font-internal one, which we
  // cannot read here; leaving it empty correctly reports zero coverage.
  if (!base && !differences && symbolic) return { map: out, explicit: false };
  if (!base) base = StandardEncoding;

  for (let code = 0; code < 256; code++) {
    const name = base[code];
    if (!name) continue;
    const u = glyphNameToUnicode(name);
    if (u >= 0) out.set(code, String.fromCodePoint(u));
  }

  let diffResolved = 0;
  let diffTotal = 0;
  if (differences) {
    let code = 0;
    for (let i = 0; i < differences.size(); i++) {
      const item = differences.lookup(i);
      if (item instanceof PDFNumber) {
        code = item.asNumber();
      } else if (item instanceof PDFName) {
        const u = glyphNameToUnicode(item.asString().replace(/^\//, ''));
        diffTotal++;
        if (u >= 0) {
          out.set(code, String.fromCodePoint(u));
          diffResolved++;
        } else {
          out.delete(code); // named but unmappable: treat as not editable
        }
        code++;
      }
    }
  }

  // Differences carrying mostly unresolvable names (subset names like `g42`)
  // mean the file is using a private encoding we cannot interpret.
  const diffOk = diffTotal === 0 || diffResolved / diffTotal >= 0.8;
  return { map: out, explicit: (namedBase || diffTotal > 0) && diffOk };
}

function parseSimpleWidths(fontDict: PDFDict): { widths: Map<number, number>; missing: number } {
  const widths = new Map<number, number>();
  const arr = fontDict.lookup(PDFName.of('Widths'));
  const first = num(fontDict, 'FirstChar', 0);
  if (arr instanceof PDFArray) {
    for (let i = 0; i < arr.size(); i++) {
      const w = arr.lookup(i);
      if (w instanceof PDFNumber) widths.set(first + i, w.asNumber());
    }
  }
  const fd = fontDict.lookup(PDFName.of('FontDescriptor'));
  const missing = fd instanceof PDFDict ? num(fd, 'MissingWidth', 0) : 0;
  return { widths, missing };
}

/** Parses the CID font `W` array: `[ c [w...] | cFirst cLast w ]`. */
function parseCIDWidths(cidFont: PDFDict): Map<number, number> {
  const widths = new Map<number, number>();
  const w = cidFont.lookup(PDFName.of('W'));
  if (!(w instanceof PDFArray)) return widths;

  let i = 0;
  while (i < w.size()) {
    const a = w.lookup(i);
    if (!(a instanceof PDFNumber)) break;
    const next = w.lookup(i + 1);
    if (next instanceof PDFArray) {
      const start = a.asNumber();
      for (let k = 0; k < next.size(); k++) {
        const v = next.lookup(k);
        if (v instanceof PDFNumber) widths.set(start + k, v.asNumber());
      }
      i += 2;
    } else if (next instanceof PDFNumber) {
      const third = w.lookup(i + 2);
      if (third instanceof PDFNumber) {
        const lo = a.asNumber();
        const hi = Math.min(next.asNumber(), lo + 65535);
        const val = third.asNumber();
        for (let c = lo; c <= hi; c++) widths.set(c, val);
      }
      i += 3;
    } else {
      i++;
    }
  }
  return widths;
}

function detectFontFile(descriptor: PDFDict | null): { embedded: boolean; kind: FontFileKind } {
  if (!descriptor) return { embedded: false, kind: 'none' };
  if (descriptor.lookup(PDFName.of('FontFile2'))) return { embedded: true, kind: 'ttf' };
  if (descriptor.lookup(PDFName.of('FontFile'))) return { embedded: true, kind: 'type1' };
  const ff3 = descriptor.lookup(PDFName.of('FontFile3'));
  if (ff3) {
    const sub = ff3 instanceof PDFStream ? ff3.dict.lookup(PDFName.of('Subtype')) : null;
    const name = sub instanceof PDFName ? sub.asString() : '';
    return { embedded: true, kind: name.includes('OpenType') ? 'otf' : 'cff' };
  }
  return { embedded: false, kind: 'none' };
}

/** Loads one font resource into an analysed, editable form. */
export function loadFont(resourceName: string, dict: PDFDict, ref: PDFRef | null): LoadedFont {
  const subtypeRaw = dict.lookup(PDFName.of('Subtype'));
  const subtype = subtypeRaw instanceof PDFName ? subtypeRaw.asString().replace(/^\//, '') : 'Type1';
  const baseRaw = dict.lookup(PDFName.of('BaseFont'));
  const baseFont = baseRaw instanceof PDFName ? baseRaw.asString().replace(/^\//, '') : '';
  const twoByte = subtype === 'Type0';
  const type3 = subtype === 'Type3';

  // A Type0 font delegates metrics and the descriptor to its descendant CID font.
  let metricsDict = dict;
  if (twoByte) {
    const desc = dict.lookup(PDFName.of('DescendantFonts'));
    if (desc instanceof PDFArray && desc.size() > 0) {
      const d0 = desc.lookup(0);
      if (d0 instanceof PDFDict) metricsDict = d0;
    }
  }

  const fdRaw = metricsDict.lookup(PDFName.of('FontDescriptor'));
  const descriptor = fdRaw instanceof PDFDict ? fdRaw : null;

  const flags = descriptor ? num(descriptor, 'Flags', 0) : 0;
  const italicAngle = descriptor ? num(descriptor, 'ItalicAngle', 0) : 0;
  const weight = descriptor ? num(descriptor, 'FontWeight', 0) : 0;
  const nameHint = stripSubsetTag(baseFont).toLowerCase();

  const bold =
    weight >= 600 ||
    (flags & (1 << 18)) !== 0 ||
    /bold|black|heavy|semibold|demibold/.test(nameHint);
  const italic = italicAngle !== 0 || (flags & (1 << 6)) !== 0 || /italic|oblique/.test(nameHint);
  const serif = (flags & (1 << 1)) !== 0 || /times|serif|georgia|garamond|book|roman|minion/.test(nameHint);
  const fixedPitch = (flags & 1) !== 0 || /mono|courier|consol/.test(nameHint);
  const symbolic = (flags & (1 << 2)) !== 0 && (flags & (1 << 5)) === 0;

  let widths: Map<number, number>;
  let missingWidth = 0;
  if (twoByte) {
    widths = parseCIDWidths(metricsDict);
    missingWidth = num(metricsDict, 'DW', 1000);
  } else {
    const parsed = parseSimpleWidths(dict);
    widths = parsed.widths;
    missingWidth = parsed.missing;
  }

  const tuStream = dict.lookup(PDFName.of('ToUnicode'));
  const tuBytes = tuStream instanceof PDFStream ? streamBytes(tuStream) : null;
  const toUnicode = tuBytes ? parseToUnicodeCMap(tuBytes) : new Map<number, string>();
  const hasToUnicode = toUnicode.size > 0;

  let encodingExplicit = false;
  if (!hasToUnicode && !twoByte && !type3) {
    const simple = simpleEncodingMap(dict, symbolic);
    for (const [code, text] of simple.map) toUnicode.set(code, text);
    encodingExplicit = simple.explicit;
  }

  // Invert to get the encoder. Lower codes win so the canonical code is chosen
  // when a subset maps several codes to the same character.
  const fromUnicode = new Map<string, number>();
  const sortedCodes = [...toUnicode.keys()].sort((a, b) => a - b);
  for (const code of sortedCodes) {
    const text = toUnicode.get(code)!;
    if (!text || text.length === 0) continue;
    if (!fromUnicode.has(text)) fromUnicode.set(text, code);
  }

  let fontMatrix: number[] | null = null;
  if (type3) {
    const fm = dict.lookup(PDFName.of('FontMatrix'));
    if (fm instanceof PDFArray) {
      fontMatrix = [];
      for (let i = 0; i < fm.size(); i++) {
        const v = fm.lookup(i);
        fontMatrix.push(v instanceof PDFNumber ? v.asNumber() : 0);
      }
    }
  }

  const { embedded, kind } = detectFontFile(descriptor);

  return {
    resourceName,
    ref,
    dict,
    subtype,
    baseFont,
    family: stripSubsetTag(baseFont).replace(/[-,](Bold|Italic|Oblique|Regular|Roman|Light|Medium|Semibold|BoldItalic|BoldOblique)+$/i, ''),
    bold,
    italic,
    serif,
    fixedPitch,
    symbolic,
    twoByte,
    type3,
    widths,
    missingWidth,
    toUnicode,
    fromUnicode,
    hasToUnicode,
    decodeConfident: hasToUnicode || (!type3 && !twoByte && !symbolic && encodingExplicit),
    ascent: descriptor ? num(descriptor, 'Ascent', 750) : 750,
    descent: descriptor ? num(descriptor, 'Descent', -250) : -250,
    capHeight: descriptor ? num(descriptor, 'CapHeight', 700) : 700,
    italicAngle,
    embedded,
    fontFileKind: kind,
    fontMatrix,
  };
}

/** Width of one character code, in 1/1000 em. */
export function codeWidth(font: LoadedFont, code: number): number {
  const w = font.widths.get(code);
  if (w !== undefined) return w;
  if (font.twoByte) return font.missingWidth || 1000;
  return font.missingWidth || defaultStandardWidth(font, code);
}

/**
 * The width of a character in a font that did not say.
 *
 * Non-embedded standard fonts often omit `Widths`, because a reader is
 * expected to already know the metrics of the fourteen fonts every reader has.
 * We know them too: they ship with pdf-lib, so they are looked up rather than
 * guessed. This used to average them, which read as plausible and was out by
 * eight per cent over a line of ordinary prose, and every position measured
 * along that line was out with it.
 *
 * The rough table survives for the fonts that match none of the fourteen and
 * carry no widths of their own, where a plausible number is all there is.
 */
function defaultStandardWidth(font: LoadedFont, code: number): number {
  const ch = font.toUnicode.get(code) ?? '';
  const metrics = standardMetrics(font);
  if (metrics && ch) {
    const point = ch.codePointAt(0) ?? 0;
    if (Encodings.WinAnsi.canEncodeUnicodeCodePoint(point)) {
      const { name } = Encodings.WinAnsi.encodeUnicodeCodePoint(point);
      const width = metrics.getWidthOfGlyph(String(name));
      if (typeof width === 'number' && width > 0) return width;
    }
  }

  if (font.fixedPitch) return 600;
  if (ch === ' ') return font.serif ? 250 : 278;
  if (/[ilj.,;:'!|]/.test(ch)) return 278;
  if (/[A-Z]/.test(ch)) return 667;
  if (/[mwMW]/.test(ch)) return 889;
  return font.serif ? 500 : 556;
}

/** Names as `@pdf-lib/standard-fonts` spells them, which is not how we do. */
const STANDARD_METRIC_NAMES: Record<string, string> = {
  Helvetica: 'Helvetica',
  HelveticaBold: 'Helvetica-Bold',
  HelveticaOblique: 'Helvetica-Oblique',
  HelveticaBoldOblique: 'Helvetica-BoldOblique',
  Courier: 'Courier',
  CourierBold: 'Courier-Bold',
  CourierOblique: 'Courier-Oblique',
  CourierBoldOblique: 'Courier-BoldOblique',
  TimesRoman: 'Times-Roman',
  TimesRomanBold: 'Times-Bold',
  TimesRomanItalic: 'Times-Italic',
  TimesRomanBoldItalic: 'Times-BoldItalic',
};

type StandardFont = ReturnType<typeof Font.load>;

const metricsCache = new Map<string, StandardFont | null>();

/** The real metrics for whichever of the fourteen this font is, if it is one. */
function standardMetrics(font: LoadedFont): StandardFont | null {
  const alias = standardFontAlias(font);
  const name = alias ? STANDARD_METRIC_NAMES[alias] : undefined;
  if (!name) return null;
  const cached = metricsCache.get(name);
  if (cached !== undefined) return cached;
  let loaded: StandardFont | null = null;
  try {
    loaded = Font.load(name as FontNames);
  } catch {
    loaded = null;
  }
  metricsCache.set(name, loaded);
  return loaded;
}

/** A run of glyph codes, or a pure horizontal advance with nothing drawn. */
export type EncodedPart = { bytes: Uint8Array } | { offset: number };

export interface EncodedText {
  parts: EncodedPart[];
  /** Total advance in 1/1000 em, excluding character and word spacing. */
  width: number;
  /** Number of glyphs drawn, which is what character spacing multiplies. */
  glyphs: number;
}

/**
 * Whether a character code may be assumed to equal its ASCII value.
 *
 * Only safe for simple fonts with no ToUnicode CMap, where coverage was inferred
 * from a standard encoding and is likely incomplete. When a ToUnicode CMap does
 * exist it is authoritative: a character missing from it is missing from the
 * subset, and writing its ASCII code would draw whatever glyph happens to live
 * at that code instead - or nothing at all.
 */
function asciiFallbackAllowed(font: LoadedFont): boolean {
  return !font.twoByte && !font.hasToUnicode;
}

/** Longest ligature key in `fromUnicode`, so greedy matching knows how far to look. */
function maxKeyLength(font: LoadedFont): number {
  let max = 1;
  for (const key of font.fromUnicode.keys()) if (key.length > max) max = key.length;
  return Math.min(max, 4);
}

function packCodes(font: LoadedFont, codes: number[]): Uint8Array {
  const bytes = new Uint8Array(font.twoByte ? codes.length * 2 : codes.length);
  if (font.twoByte) {
    codes.forEach((c, i) => {
      bytes[i * 2] = (c >> 8) & 0xff;
      bytes[i * 2 + 1] = c & 0xff;
    });
  } else {
    codes.forEach((c, i) => (bytes[i] = c & 0xff));
  }
  return bytes;
}

/**
 * Encodes text using the font's own glyphs.
 *
 * Two details make this work on real documents. Ligatures decode to several
 * characters ("fi") but are drawn by a single glyph, so matching is greedy and
 * longest-first. And a space draws nothing at all - only its advance matters -
 * so a font with no space glyph gets a positioning offset instead of failing,
 * which is exactly what PDF producers themselves emit.
 *
 * Returns null only when a visible character has no glyph, meaning the caller
 * should substitute a different font rather than draw the wrong thing.
 */
export function encodeText(font: LoadedFont, text: string, spaceWidth?: number): EncodedText | null {
  if (font.type3) return null; // Type3 glyphs are procedures, not re-encodable

  const parts: EncodedPart[] = [];
  let pending: number[] = [];
  let width = 0;
  let glyphs = 0;
  const maxKey = maxKeyLength(font);

  const flushPending = (): void => {
    if (pending.length) {
      parts.push({ bytes: packCodes(font, pending) });
      pending = [];
    }
  };

  const chars = [...text];
  let i = 0;
  while (i < chars.length) {
    let code: number | undefined;
    let consumed = 1;

    for (let len = Math.min(maxKey, chars.length - i); len >= 1; len--) {
      const found = font.fromUnicode.get(chars.slice(i, i + len).join(''));
      if (found !== undefined) {
        code = found;
        consumed = len;
        break;
      }
    }

    if (code === undefined && chars[i] === ' ') {
      // Emit the advance directly; a space has no visible glyph to miss.
      const w = spaceWidth ?? font.widths.get(32) ?? 250;
      flushPending();
      parts.push({ offset: w });
      width += w;
      i += 1;
      continue;
    }

    if (code === undefined && asciiFallbackAllowed(font) && chars[i].charCodeAt(0) < 128) {
      const ascii = chars[i].charCodeAt(0);
      if (font.widths.has(ascii)) {
        code = ascii;
        consumed = 1;
      }
    }

    if (code === undefined) return null;

    pending.push(code);
    glyphs++;
    width += codeWidth(font, code);
    i += consumed;
  }

  flushPending();
  return { parts, width, glyphs };
}


/** A stretch of text and whether this font can draw it. */
export interface CoverageSpan {
  text: string;
  covered: boolean;
}

/**
 * Splits text into runs this font can and cannot draw.
 *
 * Substituting a whole line because one character is missing changes the look of
 * text that was perfectly fine. Splitting keeps every covered character in the
 * document's own font and limits the substitute to the characters that actually
 * need it.
 */
export function coverageSpans(font: LoadedFont, text: string): CoverageSpan[] {
  const out: CoverageSpan[] = [];
  const maxKey = maxKeyLength(font);
  const chars = [...text];
  let i = 0;

  const push = (chunk: string, covered: boolean): void => {
    const last = out[out.length - 1];
    if (last && last.covered === covered) last.text += chunk;
    else out.push({ text: chunk, covered });
  };

  while (i < chars.length) {
    if (chars[i] === ' ') {
      // A space needs no glyph, so it joins whichever run it borders.
      push(' ', out.length ? out[out.length - 1].covered : true);
      i++;
      continue;
    }
    let matched = 0;
    for (let len = Math.min(maxKey, chars.length - i); len >= 1; len--) {
      if (font.fromUnicode.has(chars.slice(i, i + len).join(''))) {
        matched = len;
        break;
      }
    }
    if (matched) {
      push(chars.slice(i, i + matched).join(''), true);
      i += matched;
      continue;
    }
    if (asciiFallbackAllowed(font) && chars[i].charCodeAt(0) < 128 && font.widths.has(chars[i].charCodeAt(0))) {
      push(chars[i], true);
      i++;
      continue;
    }
    push(chars[i], false);
    i++;
  }
  return out;
}

/** Characters in `text` this font cannot draw. Spaces never count as missing. */
export function missingChars(font: LoadedFont, text: string): string[] {
  const out = new Set<string>();
  const maxKey = maxKeyLength(font);
  const chars = [...text];
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === ' ') {
      i++;
      continue;
    }
    let hit = false;
    for (let len = Math.min(maxKey, chars.length - i); len >= 1; len--) {
      if (font.fromUnicode.has(chars.slice(i, i + len).join(''))) {
        i += len;
        hit = true;
        break;
      }
    }
    if (hit) continue;
    if (asciiFallbackAllowed(font) && chars[i].charCodeAt(0) < 128 && font.widths.has(chars[i].charCodeAt(0))) {
      i++;
      continue;
    }
    out.add(chars[i]);
    i++;
  }
  return [...out];
}

/** Decodes a show-text operand into text plus the codes it contained. */
export function decodeString(font: LoadedFont, bytes: Uint8Array): { text: string; codes: number[] } {
  const codes: number[] = [];
  let text = '';
  if (font.twoByte) {
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = (bytes[i] << 8) | bytes[i + 1];
      codes.push(code);
      text += font.toUnicode.get(code) ?? '';
    }
  } else {
    for (const b of bytes) {
      codes.push(b);
      text += font.toUnicode.get(b) ?? '';
    }
  }
  return { text, codes };
}

/** Maps a font to one of the 14 standard PDF fonts when it is a known clone. */
export function standardFontAlias(font: LoadedFont): string | null {
  const n = stripSubsetTag(font.baseFont).toLowerCase().replace(/[^a-z]/g, '');
  const isHelv = /^(helvetica|arial|arialmt|liberationsans|nimbussans|segoeui|calibri|verdana|tahoma)/.test(n);
  const isTimes = /^(times|timesnewroman|timesnewromanpsmt|liberationserif|nimbusroman|georgia|cambria)/.test(n);
  const isCourier = /^(courier|couriernew|liberationmono|nimbusmono|consolas)/.test(n);

  // Names match pdf-lib's StandardFonts keys so the caller can embed directly.
  const suffix = font.bold && font.italic ? 'BoldOblique' : font.bold ? 'Bold' : font.italic ? 'Oblique' : '';
  const times = `TimesRoman${font.bold && font.italic ? 'BoldItalic' : font.bold ? 'Bold' : font.italic ? 'Italic' : ''}`;

  if (isHelv) return 'Helvetica' + suffix;
  if (isCourier) return 'Courier' + suffix;
  if (isTimes) return times;
  if (font.fixedPitch) return 'Courier' + suffix;
  if (font.serif) return times;
  return 'Helvetica' + suffix;
}

export const WinAnsiTable = WinAnsiEncoding;
