/**
 * Content stream text walker.
 *
 * Replays the PDF graphics and text state machines to work out where every run
 * of text lands on the page, while recording the byte range of each show-text
 * operator. Position drives the UI; the byte range makes editing a precise
 * splice of the original stream rather than a guess.
 */

import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream } from 'pdf-lib';
import { Lexer, Tok, type Token } from './lexer';
import { codeWidth, decodeString, loadFont, type LoadedFont } from './fonts';

export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function mul(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

export function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** One show-text operator, located in both page space and stream bytes. */
export interface ShowOp {
  /** Identifies the stream this op lives in; edits are grouped per stream. */
  streamId: string;
  /** Sequence number across the whole page walk, in stream order. */
  index: number;
  /** Byte range covering operands and operator, splice-ready. */
  start: number;
  end: number;
  operator: 'Tj' | 'TJ' | "'" | '"';
  font: LoadedFont;
  fontResourceName: string;
  /** Font size from Tf, before any matrix scaling. */
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  horizScale: number;
  rise: number;
  renderMode: number;
  /** Text matrix in effect at the start of this operator. */
  textMatrix: Matrix;
  /** Current transformation matrix in effect. */
  ctm: Matrix;
  /** textMatrix combined with ctm: maps text space to page space. */
  toPage: Matrix;
  text: string;
  /** Advance produced by this operator, in unscaled text space units. */
  advance: number;
  fill: RGB;
  /** Effective on-page font size after matrix scaling. */
  effectiveSize: number;
  /** Baseline origin in page space (PDF coordinates, y up). */
  x: number;
  y: number;
  /**
   * Unit vector of the text's writing direction in page space.
   *
   * Text is not always left to right along the page's x axis. Rotated pages,
   * sideways table headers and mirrored transforms all produce runs whose
   * advance points somewhere else entirely, and comparing raw x coordinates
   * gets those backwards. Everything positional works along this axis instead.
   */
  dirX: number;
  dirY: number;
  /** Origin projected onto the writing direction, so it increases with reading order. */
  u: number;
  /** Distance this operator advances along the writing direction, in page units. */
  uAdvance: number;
  /** Origin projected onto the perpendicular, which identifies the baseline. */
  v: number;
}

interface TextState {
  font: LoadedFont | null;
  fontResourceName: string;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  horizScale: number;
  leading: number;
  rise: number;
  renderMode: number;
}

interface GState {
  ctm: Matrix;
  fill: RGB;
  text: TextState;
}

function cloneState(s: GState): GState {
  return { ctm: [...s.ctm] as Matrix, fill: { ...s.fill }, text: { ...s.text } };
}

function streamBytes(stream: PDFStream): Uint8Array | null {
  try {
    if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
    const anyStream = stream as unknown as { getContents?: () => Uint8Array };
    return anyStream.getContents ? anyStream.getContents() : null;
  } catch {
    return null;
  }
}

function cmykToRgb(c: number, m: number, y: number, k: number): RGB {
  return { r: (1 - c) * (1 - k), g: (1 - m) * (1 - k), b: (1 - y) * (1 - k) };
}

/**
 * One image drawn on the page.
 *
 * An image XObject is always painted into the unit square and positioned purely
 * by the transformation matrix in effect, so the matrix is the placement and
 * changing it is how the image moves or resizes.
 */
export interface ImageOp {
  streamId: string;
  index: number;
  /** Byte range covering the name operand and the Do operator. */
  start: number;
  end: number;
  name: string;
  ctm: Matrix;
  /** Axis-aligned bounds in page space, PDF coordinates. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface WalkResult {
  ops: ShowOp[];
  images: ImageOp[];
  /** Decoded bytes of every stream visited, keyed by streamId. */
  streams: Map<string, { bytes: Uint8Array; stream: PDFStream; ref: PDFRef | null }>;
  fonts: Map<string, LoadedFont>;
  /** Resource dictionary in scope for each stream, needed to add fallback fonts. */
  resources: Map<string, PDFDict | null>;
}

/** Replays a page's content streams and collects every show-text operator. */
export function walkPage(contentBytes: Uint8Array, resources: PDFDict | null, streamId = 'page'): WalkResult {
  const result: WalkResult = { ops: [], images: [], streams: new Map(), fonts: new Map(), resources: new Map() };
  const counter = { n: 0 };
  result.resources.set(streamId, resources);
  walkStream(contentBytes, resources, streamId, result, counter, IDENTITY, 0, new Set());
  return result;
}

function lookupFontDict(resources: PDFDict | null, name: string): { dict: PDFDict; ref: null } | null {
  if (!resources) return null;
  const fonts = resources.lookup(PDFName.of('Font'));
  if (!(fonts instanceof PDFDict)) return null;
  const f = fonts.lookup(PDFName.of(name));
  return f instanceof PDFDict ? { dict: f, ref: null } : null;
}

function walkStream(
  bytes: Uint8Array,
  resources: PDFDict | null,
  streamId: string,
  out: WalkResult,
  counter: { n: number },
  baseCtm: Matrix,
  depth: number,
  visited: Set<string>,
): void {
  let toks: Token[];
  try {
    toks = Lexer.tokenize(bytes);
  } catch {
    return;
  }

  const fontCache = new Map<string, LoadedFont>();
  const getFont = (name: string): LoadedFont | null => {
    const key = `${streamId}/${name}`;
    if (fontCache.has(name)) return fontCache.get(name)!;
    const found = lookupFontDict(resources, name);
    if (!found) return null;
    const font = loadFont(name, found.dict, found.ref);
    fontCache.set(name, font);
    out.fonts.set(key, font);
    return font;
  };

  let gs: GState = {
    ctm: [...baseCtm] as Matrix,
    fill: { r: 0, g: 0, b: 0 },
    text: {
      font: null,
      fontResourceName: '',
      fontSize: 0,
      charSpacing: 0,
      wordSpacing: 0,
      horizScale: 100,
      leading: 0,
      rise: 0,
      renderMode: 0,
    },
  };
  const stack: GState[] = [];

  let tm: Matrix = [...IDENTITY] as Matrix;
  let tlm: Matrix = [...IDENTITY] as Matrix;

  // Operand accumulator; reset after each operator.
  let operands: Token[] = [];
  let operandStart = -1;

  const nums = (): number[] => operands.filter((t) => t.kind === Tok.Num).map((t) => t.num!);

  const showText = (
    op: ShowOp['operator'],
    parts: Array<{ bytes?: Uint8Array; adjust?: number }>,
    opTok: Token,
  ): void => {
    const font = gs.text.font;
    const startTm: Matrix = [...tm] as Matrix;
    const th = gs.text.horizScale / 100;
    let advance = 0;
    let text = '';

    if (!font) {
      // Without a resolvable font the text cannot be measured or edited.
      return;
    }

    for (const part of parts) {
      if (part.adjust !== undefined) {
        advance += (-part.adjust / 1000) * gs.text.fontSize * th;
        // Many producers never draw a space glyph and open a gap with a
        // positioning offset instead. A gap this wide is a word space, not
        // kerning, and dropping it would lose the spaces from the text.
        const emGap = (-part.adjust / 1000) * th;
        if (emGap > 0.22 && text.length > 0 && !text.endsWith(' ')) text += ' ';
        continue;
      }
      if (!part.bytes) continue;
      const { text: t, codes } = decodeString(font, part.bytes);
      text += t;
      for (const code of codes) {
        const w0 = codeWidth(font, code) / 1000;
        // Word spacing applies only to single-byte code 32.
        const isWordBreak = !font.twoByte && code === 32;
        advance +=
          (w0 * gs.text.fontSize + gs.text.charSpacing + (isWordBreak ? gs.text.wordSpacing : 0)) * th;
      }
    }

    const trm = mul(
      [gs.text.fontSize * th, 0, 0, gs.text.fontSize, 0, gs.text.rise] as Matrix,
      mul(startTm, gs.ctm),
    );
    const toPage = mul(startTm, gs.ctm);
    // Effective size is the vertical scale of the rendering matrix.
    const effectiveSize = Math.hypot(trm[2], trm[3]) || gs.text.fontSize;

    // The writing direction is the text-space x axis mapped into page space,
    // signed by the direction text actually flows. A negative font size or
    // horizontal scale is legal and makes glyphs advance backwards, so without
    // that sign the run would be read end-first and every gap would invert.
    const dirScale = Math.hypot(toPage[0], toPage[1]) || 1;
    const flow = Math.sign(gs.text.fontSize * th) || 1;
    const dirX = (toPage[0] / dirScale) * flow;
    const dirY = (toPage[1] / dirScale) * flow;

    out.ops.push({
      streamId,
      index: counter.n++,
      start: operandStart >= 0 ? operandStart : opTok.start,
      end: opTok.end,
      operator: op,
      font,
      fontResourceName: gs.text.fontResourceName,
      fontSize: gs.text.fontSize,
      charSpacing: gs.text.charSpacing,
      wordSpacing: gs.text.wordSpacing,
      horizScale: gs.text.horizScale,
      rise: gs.text.rise,
      renderMode: gs.text.renderMode,
      textMatrix: startTm,
      ctm: [...gs.ctm] as Matrix,
      toPage,
      text,
      advance,
      fill: { ...gs.fill },
      effectiveSize,
      x: trm[4],
      y: trm[5],
      dirX,
      dirY,
      u: trm[4] * dirX + trm[5] * dirY,
      uAdvance: advance * dirScale * flow,
      v: -trm[4] * dirY + trm[5] * dirX,
    });

    tm = mul([1, 0, 0, 1, advance, 0] as Matrix, tm);
  };

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];

    if (t.kind !== Tok.Op) {
      if (operandStart < 0) operandStart = t.start;
      operands.push(t);
      continue;
    }

    const op = t.name!;
    const n = nums();

    switch (op) {
      case 'q':
        stack.push(cloneState(gs));
        break;
      case 'Q': {
        const prev = stack.pop();
        if (prev) gs = prev;
        break;
      }
      case 'cm':
        if (n.length >= 6) gs.ctm = mul(n.slice(-6) as Matrix, gs.ctm);
        break;

      case 'BT':
        tm = [...IDENTITY] as Matrix;
        tlm = [...IDENTITY] as Matrix;
        break;
      case 'ET':
        break;

      case 'Tf': {
        const nameTok = operands.find((o) => o.kind === Tok.Name);
        if (nameTok) {
          gs.text.fontResourceName = nameTok.name!;
          gs.text.font = getFont(nameTok.name!);
        }
        if (n.length >= 1) gs.text.fontSize = n[n.length - 1];
        break;
      }
      case 'Tc':
        if (n.length) gs.text.charSpacing = n[0];
        break;
      case 'Tw':
        if (n.length) gs.text.wordSpacing = n[0];
        break;
      case 'Tz':
        if (n.length) gs.text.horizScale = n[0];
        break;
      case 'TL':
        if (n.length) gs.text.leading = n[0];
        break;
      case 'Ts':
        if (n.length) gs.text.rise = n[0];
        break;
      case 'Tr':
        if (n.length) gs.text.renderMode = n[0];
        break;

      case 'Td':
        if (n.length >= 2) {
          tlm = mul([1, 0, 0, 1, n[0], n[1]] as Matrix, tlm);
          tm = [...tlm] as Matrix;
        }
        break;
      case 'TD':
        if (n.length >= 2) {
          gs.text.leading = -n[1];
          tlm = mul([1, 0, 0, 1, n[0], n[1]] as Matrix, tlm);
          tm = [...tlm] as Matrix;
        }
        break;
      case 'Tm':
        if (n.length >= 6) {
          tlm = n.slice(-6) as Matrix;
          tm = [...tlm] as Matrix;
        }
        break;
      case 'T*':
        tlm = mul([1, 0, 0, 1, 0, -gs.text.leading] as Matrix, tlm);
        tm = [...tlm] as Matrix;
        break;

      case 'Tj': {
        const s = operands.find((o) => o.kind === Tok.Str);
        if (s) showText('Tj', [{ bytes: s.bytes! }], t);
        break;
      }
      case "'": {
        tlm = mul([1, 0, 0, 1, 0, -gs.text.leading] as Matrix, tlm);
        tm = [...tlm] as Matrix;
        const s = operands.find((o) => o.kind === Tok.Str);
        if (s) showText("'", [{ bytes: s.bytes! }], t);
        break;
      }
      case '"': {
        if (n.length >= 2) {
          gs.text.wordSpacing = n[0];
          gs.text.charSpacing = n[1];
        }
        tlm = mul([1, 0, 0, 1, 0, -gs.text.leading] as Matrix, tlm);
        tm = [...tlm] as Matrix;
        const s = operands.find((o) => o.kind === Tok.Str);
        if (s) showText('"', [{ bytes: s.bytes! }], t);
        break;
      }
      case 'TJ': {
        const parts: Array<{ bytes?: Uint8Array; adjust?: number }> = [];
        for (const o of operands) {
          if (o.kind === Tok.Str) parts.push({ bytes: o.bytes! });
          else if (o.kind === Tok.Num) parts.push({ adjust: o.num! });
        }
        if (parts.length) showText('TJ', parts, t);
        break;
      }

      case 'g':
        if (n.length >= 1) gs.fill = { r: n[0], g: n[0], b: n[0] };
        break;
      case 'rg':
        if (n.length >= 3) gs.fill = { r: n[0], g: n[1], b: n[2] };
        break;
      case 'k':
        if (n.length >= 4) gs.fill = cmykToRgb(n[0], n[1], n[2], n[3]);
        break;
      case 'sc':
      case 'scn':
        if (n.length === 1) gs.fill = { r: n[0], g: n[0], b: n[0] };
        else if (n.length === 3) gs.fill = { r: n[0], g: n[1], b: n[2] };
        else if (n.length === 4) gs.fill = cmykToRgb(n[0], n[1], n[2], n[3]);
        break;

      case 'Do': {
        // Recurse into form XObjects so text inside them is editable too.
        const nameTok = operands.find((o) => o.kind === Tok.Name);
        if (nameTok && depth < 8 && resources) {
          const xobjs = resources.lookup(PDFName.of('XObject'));
          if (xobjs instanceof PDFDict) {
            const xo = xobjs.lookup(PDFName.of(nameTok.name!));
            if (xo instanceof PDFStream) {
              const sub = xo.dict.lookup(PDFName.of('Subtype'));
              const subName = sub instanceof PDFName ? sub.asString().replace(/^\//, '') : '';
              const isForm = subName === 'Form';

              if (subName === 'Image') {
                // The unit square carries the image, so its corners under the
                // current matrix are exactly where it lands on the page.
                const corners = [
                  applyMatrix(gs.ctm, 0, 0),
                  applyMatrix(gs.ctm, 1, 0),
                  applyMatrix(gs.ctm, 1, 1),
                  applyMatrix(gs.ctm, 0, 1),
                ];
                out.images.push({
                  streamId,
                  index: counter.n++,
                  start: operandStart >= 0 ? operandStart : t.start,
                  end: t.end,
                  name: nameTok.name!,
                  ctm: [...gs.ctm] as Matrix,
                  x0: Math.min(...corners.map((c) => c[0])),
                  x1: Math.max(...corners.map((c) => c[0])),
                  y0: Math.min(...corners.map((c) => c[1])),
                  y1: Math.max(...corners.map((c) => c[1])),
                });
              }
              const childId = `${streamId}>${nameTok.name}`;
              if (isForm && !visited.has(childId)) {
                visited.add(childId);
                const childBytes = streamBytes(xo);
                if (childBytes) {
                  let childCtm: Matrix = [...gs.ctm] as Matrix;
                  const mtx = xo.dict.lookup(PDFName.of('Matrix'));
                  if (mtx instanceof PDFArray && mtx.size() >= 6) {
                    const mv: number[] = [];
                    for (let k = 0; k < 6; k++) {
                      const v = mtx.lookup(k);
                      mv.push(v instanceof PDFNumber ? v.asNumber() : k === 0 || k === 3 ? 1 : 0);
                    }
                    childCtm = mul(mv as Matrix, childCtm);
                  }
                  const childResRaw = xo.dict.lookup(PDFName.of('Resources'));
                  const childRes = childResRaw instanceof PDFDict ? childResRaw : resources;
                  // `get` leaves the reference unresolved so the stream can be
                  // reassigned by ref when its bytes are rewritten.
                  const rawRef = xobjs.get(PDFName.of(nameTok.name!));
                  out.streams.set(childId, {
                    bytes: childBytes,
                    stream: xo,
                    ref: rawRef instanceof PDFRef ? rawRef : null,
                  });
                  out.resources.set(childId, childRes);
                  walkStream(childBytes, childRes, childId, out, counter, childCtm, depth + 1, visited);
                }
                visited.delete(childId);
              }
            }
          }
        }
        break;
      }

      default:
        break;
    }

    operands = [];
    operandStart = -1;
  }
}

/**
 * Groups show operators into visual lines.
 *
 * Editing works line-at-a-time: a line is rewritten as a whole, which avoids
 * having to reconcile per-word kerning offsets inside the original stream.
 */
/**
 * A stretch of a line sharing one font, size and colour.
 *
 * Lines routinely mix fonts: a bold label followed by regular body text, or a
 * bullet drawn from a symbol font. Each font is usually subset to just the
 * glyphs it draws, so a line has no single "the font": encoding decisions are
 * made per segment, and typed characters inherit the segment they land in.
 */
export interface TextSegment {
  ops: ShowOp[];
  text: string;
  font: LoadedFont;
  fontSize: number;
  fill: RGB;
  /** Start and end along the line's writing direction, in page units. */
  u0: number;
  u1: number;
  /** Character offsets of this segment within the parent line's text. */
  start: number;
  end: number;
  /**
   * Width in 1/1000 em of the gaps that read as spaces in this segment.
   *
   * Many producers never draw a space glyph, positioning words with offsets
   * instead. Reproducing the measured gap keeps those spaces the width the
   * document actually used, rather than a guess that can collapse.
   */
  spaceWidth?: number;
}

export interface TextLine {
  id: string;
  streamId: string;
  ops: ShowOp[];
  segments: TextSegment[];
  text: string;
  /** Axis-aligned bounding box in page space, PDF coordinates (y up). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Baseline start and end in page space, following the writing direction. */
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  /** Writing direction as a unit vector in page space. */
  dirX: number;
  dirY: number;
  baselineY: number;
  fontSize: number;
  font: LoadedFont;
  fill: RGB;
  /** False when the line mixes fonts, sizes or colours. */
  uniform: boolean;
  /**
   * Whether this line may be edited. False when any of its fonts has no
   * trustworthy Unicode mapping, since the text shown would not be the text
   * stored and an edit would corrupt the page.
   */
  editable: boolean;
  /**
   * Further copies of this same line drawn in additional passes.
   *
   * Outlined and shadowed type is drawn more than once at the same spot, for
   * instance a stroke pass under a fill pass. They are one line to a reader, so
   * they are presented as one and every pass receives the same edit; rewriting
   * only one would leave the old wording showing through as a ghost.
   */
  overlays: TextLine[];
}

export function groupLines(ops: ShowOp[]): TextLine[] {
  // Whitespace-only operators are kept: a space is frequently drawn by its own
  // operator, and discarding it silently welds the words either side together.
  // They simply may not begin or constitute a line, which is handled below.
  const visible = ops.filter((o) => o.text.length > 0 && o.renderMode !== 3 && o.renderMode !== 7);
  const lines: TextLine[] = [];

  let current: ShowOp[] = [];

  const sameStyle = (a: ShowOp, b: ShowOp): boolean =>
    a.font === b.font &&
    Math.abs(a.effectiveSize - b.effectiveSize) < 0.01 &&
    a.fill.r === b.fill.r &&
    a.fill.g === b.fill.g &&
    a.fill.b === b.fill.b;

  const flush = (): void => {
    if (!current.length) return;
    // Runs that drew nothing but whitespace are not a line of text.
    if (current.every((o) => o.text.trim().length === 0)) {
      current = [];
      return;
    }
    const first = current[0];
    const sizes = current.map((o) => o.effectiveSize);
    const fontSize = sizes.reduce((a, b) => a + b, 0) / sizes.length;

    let text = '';
    let prev: ShowOp | null = null;
    const segments: TextSegment[] = [];
    let gapWidths: number[] = [];

    // Uses the median gap so one wide column break cannot skew word spacing.
    const applyGapWidth = (seg: TextSegment): void => {
      if (gapWidths.length) {
        const sorted = [...gapWidths].sort((a, b) => a - b);
        seg.spaceWidth = sorted[Math.floor(sorted.length / 2)];
      }
      gapWidths = [];
    };

    let uMin = Infinity;
    let uMax = -Infinity;

    for (const o of current) {
      const uEnd = o.u + o.uAdvance;
      uMin = Math.min(uMin, o.u, uEnd);
      uMax = Math.max(uMax, o.u, uEnd);

      // A visible gap reads as a space even when the stream never stored one.
      let lead = '';
      let leadPerMille = 0;
      if (prev) {
        const gap = o.u - (prev.u + prev.uAdvance);
        if (gap > o.effectiveSize * 0.22 && !/\s$/.test(text) && !/^\s/.test(o.text)) {
          lead = ' ';
          if (o.effectiveSize > 0) leadPerMille = (gap / o.effectiveSize) * 1000;
        }
      }

      const last = segments[segments.length - 1];
      if (last && prev && sameStyle(prev, o)) {
        last.text += lead + o.text;
        last.ops.push(o);
        last.u1 = uEnd;
        last.end = text.length + lead.length + o.text.length;
        if (leadPerMille > 0) gapWidths.push(leadPerMille);
      } else {
        // A synthetic space belongs to the segment it follows, so a new segment
        // starts after it rather than owning a space it never drew.
        if (last && lead) {
          last.text += lead;
          last.end += lead.length;
          if (leadPerMille > 0) gapWidths.push(leadPerMille);
        }
        if (last) applyGapWidth(last);
        segments.push({
          ops: [o],
          text: o.text,
          font: o.font,
          fontSize: o.effectiveSize,
          fill: { ...o.fill },
          u0: o.u,
          u1: uEnd,
          start: text.length + lead.length,
          end: text.length + lead.length + o.text.length,
        });
      }

      text += lead + o.text;
      prev = o;
    }

    if (segments.length) applyGapWidth(segments[segments.length - 1]);

    const ascent = (first.font.ascent / 1000) * fontSize;
    const descent = (first.font.descent / 1000) * fontSize;

    // Endpoints are reconstructed along the writing direction, so they stay
    // correct for rotated and mirrored text where page x means nothing.
    const dirX = first.dirX;
    const dirY = first.dirY;
    const perpX = -dirY;
    const perpY = dirX;
    const startX = uMin * dirX + first.v * perpX;
    const startY = uMin * dirY + first.v * perpY;
    const endX = uMax * dirX + first.v * perpX;
    const endY = uMax * dirY + first.v * perpY;

    // The box spans the baseline plus the font's ascent and descent either side.
    const corners = [
      [startX + perpX * descent, startY + perpY * descent],
      [startX + perpX * ascent, startY + perpY * ascent],
      [endX + perpX * descent, endY + perpY * descent],
      [endX + perpX * ascent, endY + perpY * ascent],
    ];

    lines.push({
      id: `${first.streamId}:${first.index}`,
      streamId: first.streamId,
      ops: [...current],
      segments,
      text,
      x0: Math.min(...corners.map((c) => c[0])),
      x1: Math.max(...corners.map((c) => c[0])),
      y0: Math.min(...corners.map((c) => c[1])),
      y1: Math.max(...corners.map((c) => c[1])),
      startX,
      startY,
      endX,
      endY,
      dirX,
      dirY,
      baselineY: startY,
      fontSize,
      font: first.font,
      fill: first.fill,
      uniform: segments.length === 1,
      editable: segments.every((sg) => sg.font.decodeConfident),
      overlays: [],
    });
    current = [];
  };

  for (const op of visible) {
    if (!current.length) {
      // A line never starts with whitespace; that space belongs to the gap
      // between lines, not to the text of the next one.
      if (op.text.trim().length === 0) continue;
      current.push(op);
      continue;
    }
    const prev = current[current.length - 1];
    const sameStream = prev.streamId === op.streamId;
    // Runs must share a writing direction before their positions are comparable.
    const sameDirection = Math.abs(op.dirX - prev.dirX) < 0.01 && Math.abs(op.dirY - prev.dirY) < 0.01;
    const sameBaseline = sameDirection && Math.abs(op.v - prev.v) <= Math.max(1.2, prev.effectiveSize * 0.28);
    const gap = sameDirection ? op.u - (prev.u + prev.uAdvance) : Infinity;
    // Runs far apart along the line are separate columns, not one line.
    const adjacent = gap > -prev.effectiveSize * 1.5 && gap < prev.effectiveSize * 2.2;

    if (sameStream && sameBaseline && adjacent) {
      current.push(op);
    } else {
      flush();
      current.push(op);
    }
  }
  flush();

  return mergeDuplicatePasses(lines);
}

/**
 * Folds lines that draw the same text at the same place into one.
 *
 * Two passes over identical text is how outlined and shadowed type is made. The
 * reader sees one line, so the editor offers one, and the extra passes ride
 * along as overlays so an edit reaches all of them.
 */
function mergeDuplicatePasses(lines: TextLine[]): TextLine[] {
  const out: TextLine[] = [];

  for (const line of lines) {
    const twin = out.find(
      (candidate) =>
        candidate.streamId === line.streamId &&
        candidate.text === line.text &&
        Math.abs(candidate.startX - line.startX) < 0.6 &&
        Math.abs(candidate.startY - line.startY) < 0.6 &&
        Math.abs(candidate.x1 - line.x1) < 0.6 &&
        Math.abs(candidate.fontSize - line.fontSize) < 0.1,
    );
    if (twin) twin.overlays.push(line);
    else out.push(line);
  }

  return out;
}
