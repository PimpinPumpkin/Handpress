/**
 * Paragraph detection and reflow.
 *
 * Editing one line of a paragraph and leaving the rest where they were is what
 * makes most PDF editors feel like patching rather than writing: delete a word
 * and the line ends early, add a sentence and it runs off the column. Reflow
 * treats the lines a paragraph is made of as one piece of text, re-breaks it
 * across those same lines, and writes each one back.
 *
 * It works within the lines the paragraph already occupies. Making room for a
 * new line would mean pushing everything below it down the page, which is a
 * different and far more dangerous operation; text that no longer fits is
 * refused instead, and the caller says so.
 */

import { encodeText, type LoadedFont } from './fonts';
import type { TextLine } from './content';

export interface Paragraph {
  /** Lines in reading order. The first is where an indent, if any, lives. */
  lines: TextLine[];
  /**
   * How far each line may run, in page units.
   *
   * Per line rather than one number for the paragraph, because real documents
   * are not wrapped to a single clean margin: justification, hyphenation and
   * manual breaks all leave lines whose evidence disagrees. Each line's own
   * evidence is the most faithful thing available for that line.
   */
  limits: number[];
}

/** Baselines closer together than this are the same line, not a new one. */
const SAME_LINE = 0.6;

/** How much two leadings may differ and still count as the same rhythm. */
const LEADING_TOLERANCE = 0.18;

/** How far a left edge may wander and still be the same column, in points. */
const EDGE_TOLERANCE = 1.5;

/**
 * How wide a column has to be, in ems, before its lines are treated as wrapped.
 *
 * A stack of short lines looks exactly like a wrapped paragraph from the
 * geometry alone: names in a list, times in a schedule and rows of a table all
 * sit under one another with even leading and a shared left edge. What they do
 * not have is a column wide enough to wrap in. Twelve ems is about eight words
 * of prose, and comfortably excludes a column of surnames.
 */
const MIN_COLUMN_EMS = 12;

/** Fewer words per line than this, and it is a list rather than prose. */
const MIN_WORDS_PER_LINE = 3;

/**
 * Groups lines into paragraphs.
 *
 * A paragraph here is deliberately conservative: same font and size throughout,
 * one writing direction, an even rhythm of baselines, and a shared left edge
 * apart from the first line, which may be indented. Anything less certain is
 * left as single lines, where the behaviour is what it always was.
 */
export function groupParagraphs(lines: TextLine[]): Paragraph[] {
  const usable = lines.filter((l) => l.editable && l.uniform && l.text.trim().length > 0);
  const out: Paragraph[] = [];

  let current: TextLine[] = [];
  let leading = 0;

  const flush = (): void => {
    if (current.length && wraps(current)) out.push({ lines: current, limits: lineLimits(current) });
    current = [];
    leading = 0;
  };

  for (const line of usable) {
    if (!current.length) {
      current = [line];
      continue;
    }

    const previous = current[current.length - 1];
    const gap = advanceBetween(previous, line);

    if (!continues(previous, line, gap, leading, current)) {
      flush();
      current = [line];
      continue;
    }

    if (!leading) leading = gap;
    current.push(line);
  }
  flush();

  return out;
}

/** Distance from one baseline to the next, measured across the writing direction. */
function advanceBetween(a: TextLine, b: TextLine): number {
  // The perpendicular coordinate is what identifies a baseline, so the step
  // between two lines is the change in it, whatever direction the text runs.
  const va = -a.startX * a.dirY + a.startY * a.dirX;
  const vb = -b.startX * b.dirY + b.startY * b.dirX;
  return va - vb;
}

function continues(
  previous: TextLine,
  line: TextLine,
  gap: number,
  leading: number,
  current: TextLine[],
): boolean {
  if (previous.font !== line.font || Math.abs(previous.fontSize - line.fontSize) > 0.01) return false;
  if (Math.abs(previous.dirX - line.dirX) > 0.001 || Math.abs(previous.dirY - line.dirY) > 0.001) return false;

  // Lines must step forward down the page by roughly one line height. A gap of
  // nothing means side by side columns, and a large one means a new block.
  if (gap <= SAME_LINE || gap > line.fontSize * 3) return false;
  if (leading && Math.abs(gap - leading) > leading * LEADING_TOLERANCE) return false;

  // Every line after the first shares a left edge. The first may be indented,
  // which is why the comparison is against the second line onwards.
  const reference = current.length >= 2 ? startAlong(current[1]) : startAlong(line);
  if (Math.abs(startAlong(line) - reference) > EDGE_TOLERANCE) return false;

  // A line may be indented relative to the first, never the other way round.
  // Centred text steps inward as it shortens, and reflowing it would silently
  // turn a centred title into a left aligned one.
  if (startAlong(line) > startAlong(current[0]) + EDGE_TOLERANCE) return false;

  // Whether the previous line was wrapped or ended on purpose. If the first
  // word of this line would have fitted on that one, the break was the
  // producer's decision and a new paragraph starts here. Asking the question
  // this way needs no tolerance: it is exactly what wrapping means.
  return !brokeOnPurpose(previous, line, current);
}

/**
 * Whether a run of lines is prose that wrapped, rather than a list that happens
 * to stack the same way.
 *
 * Geometry alone cannot tell the two apart, so this asks what the text is doing:
 * prose fills a wide column with several words to a line, and a list does not.
 */
function wraps(lines: TextLine[]): boolean {
  if (lines.length < 2) return true;

  const first = lines[0];
  let left = Infinity;
  let right = -Infinity;
  let words = 0;
  for (const line of lines) {
    left = Math.min(left, startAlong(line));
    right = Math.max(right, endAlong(line));
    words += line.text.trim().split(/\s+/).filter(Boolean).length;
  }

  if (right - left < first.fontSize * MIN_COLUMN_EMS) return false;
  return words / lines.length >= MIN_WORDS_PER_LINE;
}

/** A line's words joined by single spaces, the form every width is measured in. */
function normalise(text: string): string {
  return text.trim().split(/\s+/).join(' ');
}

/**
 * Whether the break between two lines was chosen rather than forced.
 *
 * A wrapped line stops because the next word would not fit. A line that ends
 * with room to spare for that word ended because the text did, which means the
 * line after it belongs to something else.
 */
function brokeOnPurpose(previous: TextLine, line: TextLine, current: TextLine[]): boolean {
  const horizScale = previous.ops[0]?.horizScale ?? 100;
  const width = (t: string): number | null => measure(previous.font, t, previous.fontSize, horizScale);

  const word = normalise(line.text).split(' ')[0] ?? '';
  const wordWidth = width(word);
  const space = width(' ');
  if (wordWidth === null || space === null) return false;

  const measuredEnd = (l: TextLine): number => {
    const own = width(normalise(l.text));
    return startAlong(l) + (own ?? endAlong(l) - startAlong(l));
  };

  let column = measuredEnd(line);
  for (const l of current) column = Math.max(column, measuredEnd(l));

  // A hundredth of a point of slack, for the same reason the wrap has it.
  return measuredEnd(previous) + space + wordWidth <= column + 0.01;
}

function startAlong(line: TextLine): number {
  return line.startX * line.dirX + line.startY * line.dirY;
}

function endAlong(line: TextLine): number {
  return line.endX * line.dirX + line.endY * line.dirY;
}


/**
 * How far each line is allowed to run.
 *
 * Measured in the same widths the wrap decisions use, never in the width the
 * line was drawn at. Justified text is drawn with stretched spaces, so its
 * drawn extent is wider than the same words set normally, and a limit taken
 * from it lets one more word onto every line of the paragraph.
 *
 * Each line but the last says two things: these words fitted, and the next
 * line's first word did not. That pair is the tightest honest bound there is,
 * and it is taken per line because justification, hyphenation and manual breaks
 * leave real paragraphs whose lines disagree about where the margin was.
 */
function lineLimits(lines: TextLine[]): number[] {
  const first = lines[0];
  const horizScale = first.ops[0]?.horizScale ?? 100;
  const width = (t: string): number | null => measure(first.font, t, first.fontSize, horizScale);
  const space = width(' ') ?? 0;

  // Measured on the line's words joined by single spaces, which is how the
  // rewrap will set them. A document that puts two spaces after a full stop
  // would otherwise report a wider line than the rewrap produces, and the
  // difference is about the width of the short word that then squeezes in.
  const ends = lines.map((line) => {
    const own = width(normalise(line.text));
    return startAlong(line) + (own ?? endAlong(line) - startAlong(line));
  });

  const limits = lines.map((_line, i) => {
    const next = lines[i + 1];
    if (!next) return Infinity;
    const word = next.text.trim().split(/\s+/)[0] ?? '';
    const w = width(word);
    if (w === null) return Infinity;
    // Just short of the width that would have taken the next word up.
    return Math.max(ends[i], ends[i] + space + w - 0.02);
  });

  // The last line has no following word to bound it, so it inherits the most
  // generous bound the rest of the paragraph produced.
  const known = limits.filter((l) => Number.isFinite(l));
  const fallback = known.length ? Math.max(...known) : Math.max(...ends);
  return limits.map((limit, i) => Math.max(Number.isFinite(limit) ? limit : fallback, ends[i]));
}

/**
 * Width of a string in page units, in a line's own font.
 *
 * Measured with the font the document actually uses rather than an approximation,
 * because a wrap decision made against the wrong metrics is wrong by a whole word
 * at the end of every line.
 */
export function measure(font: LoadedFont, text: string, fontSize: number, horizScale: number): number | null {
  if (!text) return 0;
  const encoded = encodeText(font, text);
  if (!encoded) return null;
  return (encoded.width / 1000) * fontSize * (horizScale / 100);
}

export interface ReflowResult {
  /** New text for each line of the paragraph, in order. Trailing lines may be empty. */
  texts: string[];
}

/**
 * Re-breaks a paragraph's text across the lines it already has.
 *
 * Each line is wrapped against its own available width, so a first line indent
 * or a hanging indent survives instead of being flattened. Returns null when the
 * text needs more lines than the paragraph owns, which is the caller's cue to
 * refuse the edit rather than write over whatever comes next.
 */
export function reflow(paragraph: Paragraph, text: string, from = 0): ReflowResult | null {
  const first = paragraph.lines[0];
  const horizScale = first.ops[0]?.horizScale ?? 100;
  const width = (s: string): number | null => measure(first.font, s, first.fontSize, horizScale);

  const spaceWidth = width(' ');
  if (spaceWidth === null) return null;

  const words = text.split(/\s+/).filter(Boolean);
  const texts: string[] = [];
  let index = 0;

  // Text with no spaces to break at cannot be wrapped this way at all. Chinese,
  // Japanese and Korean break between characters under rules of their own, and
  // treating a whole paragraph as one word would pile it onto the first line.
  const widest = Math.max(
    ...paragraph.limits.slice(from).map((limit, i) => limit - startAlong(paragraph.lines[from + i])),
  );
  for (const word of words) {
    const w = width(word);
    if (w === null) return null;
    if (w > widest + 0.01) return null;
  }

  for (let i = from; i < paragraph.lines.length; i++) {
    const line = paragraph.lines[i];
    const available = paragraph.limits[i] - startAlong(line);

    // The last line takes whatever is left, since there is nowhere else for it
    // to go and refusing on the final word would be needlessly brittle.
    const isLast = i === paragraph.lines.length - 1;
    let current = '';
    let currentWidth = 0;

    while (index < words.length) {
      const word = words[index];
      const wordWidth = width(word);
      if (wordWidth === null) return null;
      const candidate = current ? currentWidth + spaceWidth + wordWidth : wordWidth;
      // A hundredth of a point of slack, because widths are accumulated word by
      // word here and glyph by glyph when the line was measured, and a fit that
      // is exact to thirteen decimal places must not turn on the fourteenth.
      // A single word too wide for the column still has to go somewhere.
      if (current && candidate > available + 0.01 && !isLast) break;
      current = current ? `${current} ${word}` : word;
      currentWidth = candidate;
      index++;
    }

    texts.push(current);
  }

  // Anything still unplaced would need a line the paragraph does not have.
  if (index < words.length) return null;
  return { texts };
}

/** The paragraph's text as one string, using each line's current wording. */
export function paragraphText(paragraph: Paragraph, textOf: (line: TextLine) => string): string {
  return paragraph.lines
    .map((line) => textOf(line).trim())
    .filter((s) => s.length > 0)
    .join(' ');
}

/** Finds the paragraph a line belongs to, or null when it stands alone. */
export function paragraphOf(paragraphs: Paragraph[], lineId: string): Paragraph | null {
  for (const paragraph of paragraphs) {
    if (paragraph.lines.length > 1 && paragraph.lines.some((l) => l.id === lineId)) return paragraph;
  }
  return null;
}
