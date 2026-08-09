/**
 * Grouping loose vector paths into things a person would call objects.
 *
 * A PDF has no concept of a logo. What it has is a few dozen fills and strokes
 * in a row that happen to land in the same place, and the only reason anyone
 * reads them as one mark is that they look like one. Dragging a logo therefore
 * has to start by deciding which paths belong to it, which is what this does:
 * paths that are next to each other in the stream and next to each other on
 * the page are one object.
 *
 * The grouping is deliberately timid. A wrong split is a logo that moves in
 * two halves, which is obvious and undoable; a wrong merge is a drag that
 * takes half the page with it. Anything that cannot be moved safely is not
 * offered at all, which is why so much of this file is refusals.
 */

import type { PathOp, WalkResult } from './content';

/** A run of paths treated as one movable drawing. */
export interface Graphic {
  id: string;
  streamId: string;
  /** Byte range covering every path in the group, and only those paths. */
  start: number;
  end: number;
  /** Matrix in effect, for carrying a page-space move back into path space. */
  ctm: PathOp['ctm'];
  /** Number of paths this is made of, which is roughly how intricate it is. */
  count: number;
  /** Axis-aligned bounds in page space, PDF coordinates. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * How far apart two paths can be and still read as one drawing.
 *
 * The gap between the strokes of a letter is under a point; the gap between a
 * logo and the text beside it is several. Six is comfortably inside that, and
 * generous enough that a dotted rule or a dashed border still holds together.
 */
const JOIN_GAP = 6;

/**
 * The largest share of the page one movable object may cover.
 *
 * Above this it is background: a tint behind a table, a full bleed panel, a
 * border around everything. Those are not things anyone drags, and offering
 * them means a box over most of the page swallowing every click meant for what
 * is drawn on top of it.
 *
 * A sixth of the page sounds small until it is measured: on the Carfax that
 * keeps every logo and badge and drops exactly the two table tints, which at
 * a third of the page each would have covered most of what is worth clicking.
 */
const MAX_PAGE_SHARE = 0.15;

/** Smallest a group can be and still be worth offering, in points. */
const MIN_SIZE = 4;

/** Smallest a *single* path can be, which is held to a higher bar than a group. */
const MIN_LONE_SIZE = 10;

/**
 * How much of its own box a group has to actually draw in.
 *
 * Two crossing hairlines pass every other test here: each is small, they are
 * next to each other, and together they are a respectable 200pt square. They
 * are also a table, and the square is empty. Comparing what the paths cover
 * against what they enclose separates a drawing from a skeleton, and a table
 * of rules comes out at well under a hundredth.
 */
const MIN_DENSITY = 0.2;

/** True if two boxes touch or come within the joining distance of each other. */
function near(
  a: { x0: number; y0: number; x1: number; y1: number },
  b: { x0: number; y0: number; x1: number; y1: number },
): boolean {
  return (
    a.x0 - JOIN_GAP <= b.x1 && b.x0 - JOIN_GAP <= a.x1 && a.y0 - JOIN_GAP <= b.y1 && b.y0 - JOIN_GAP <= a.y1
  );
}

/**
 * Whether a translation can be wrapped around a byte range without leaking.
 *
 * The move is done by putting `cm` in front of the range and its inverse after
 * it, so the range has to end the graphics state where it started. Two things
 * break that. A `Q` that pops out past the start of the range takes the matrix
 * with it, and the inverse then applies to content that was never translated.
 * A `cm` at the range's own nesting level survives the range, and the inverse
 * then composes with it in the wrong order.
 */
function isBalanced(marks: Array<{ pos: number; op: 'q' | 'Q' | 'cm' }>, start: number, end: number): boolean {
  let depth = 0;
  for (const m of marks) {
    if (m.pos < start || m.pos >= end) continue;
    if (m.op === 'q') depth++;
    else if (m.op === 'Q') {
      depth--;
      if (depth < 0) return false;
    } else if (depth === 0) return false;
  }
  return depth === 0;
}

/**
 * Finds the movable drawings on a page.
 *
 * Paths join a group when they follow the previous one immediately in the
 * stream and land near it on the page. "Immediately" is strict: the walk
 * numbers every drawing operation on the page, so a break in that numbering
 * means text or an image was drawn in between, and a range that swallowed it
 * would move that too. It costs the odd logo with a word set inside it, which
 * is a group that never appears rather than one that misbehaves.
 */
export function findGraphics(walk: WalkResult, pageWidth: number, pageHeight: number): Graphic[] {
  const pageArea = Math.max(1, pageWidth * pageHeight);
  const groups: PathOp[][] = [];
  let open: PathOp[] | null = null;

  for (const path of walk.paths) {
    // A path big enough to be background is near everything, so left in the
    // sequence it drags the whole page into one group: on a document with a
    // tint behind the text, that was every logo on the page joined to the
    // tint and the group then thrown away for being too big. It ends the run
    // instead, and nothing joins across it, because a group whose bytes span
    // a background would move the background too.
    const area = (path.x1 - path.x0) * (path.y1 - path.y0);
    if (area / pageArea > MAX_PAGE_SHARE) {
      open = null;
      continue;
    }

    const last = open?.[open.length - 1];
    const joins =
      !!last &&
      last.streamId === path.streamId &&
      path.index === last.index + 1 &&
      path.depth === last.depth &&
      near(bounds(open!), path);
    if (joins) open!.push(path);
    else {
      open = [path];
      groups.push(open);
    }
  }

  const out: Graphic[] = [];
  for (const group of groups) {
    const box = bounds(group);
    const width = box.x1 - box.x0;
    const height = box.y1 - box.y0;
    const floor = group.length > 1 ? MIN_SIZE : MIN_LONE_SIZE;
    if (width < floor || height < floor) continue;
    if ((width * height) / pageArea > MAX_PAGE_SHARE) continue;

    // Overlapping paths count more than once, which is the right way round: a
    // drawing built up in layers is exactly what should qualify.
    const drawn = group.reduce((sum, p) => sum + (p.x1 - p.x0) * (p.y1 - p.y0), 0);
    if (drawn / Math.max(1e-6, width * height) < MIN_DENSITY) continue;

    const first = group[0];
    const start = first.start;
    const end = group[group.length - 1].end;
    const marks = walk.stateMarks.get(first.streamId) ?? [];
    if (!isBalanced(marks, start, end)) continue;

    out.push({
      id: `${first.streamId}:${start}`,
      streamId: first.streamId,
      start,
      end,
      ctm: first.ctm,
      count: group.length,
      ...box,
    });
  }

  // Smallest last, so hit testing that walks backwards finds the tightest fit
  // first. A crest inside a ruled box should be what a click on the crest gets.
  out.sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
  return out;
}

function bounds(paths: PathOp[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of paths) {
    if (p.x0 < x0) x0 = p.x0;
    if (p.y0 < y0) y0 = p.y0;
    if (p.x1 > x1) x1 = p.x1;
    if (p.y1 > y1) y1 = p.y1;
  }
  return { x0, y0, x1, y1 };
}
