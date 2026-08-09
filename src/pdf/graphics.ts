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

import { canLift, type DrawState, type PathOp, type WalkResult } from './content';

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
  /** Enough state to draw the group again elsewhere in the stream. */
  state: DrawState;
  /**
   * Accumulated move applied on top of the bytes, set by the model only.
   *
   * The grouping itself never fills this in: it describes the document, and
   * the document has not changed. The model adds it when it shifts the box by
   * the edits it holds, so that a preview replaying the original bytes knows
   * to move what it draws by the same amount the box was moved.
   */
  moved?: { dx: number; dy: number };
  /**
   * A wider byte range to move instead, when the group is cut to its own shape.
   *
   * Nearly every small mark on a real page is drawn inside a clip a point or
   * two bigger than itself. Translating just the drawing then slides it out
   * from under its own clip and it vanishes, which is what moving the icons on
   * a report did. The clip cannot be widened from inside, because clipping only
   * ever intersects, so the fix is to move the whole q block that established
   * it: the clip travels with the drawing and cuts it in the same place.
   *
   * Only set when that block holds nothing but this group, since moving it
   * would move anything else inside it too.
   */
  block?: { start: number; end: number; ctm: PathOp['ctm'] };
  /**
   * Whether this can be lifted out of where it sits and drawn somewhere else.
   *
   * Changing what is in front of what moves an object's operators to the end
   * of the page or the start of it. An object drawn inside a clipping path
   * cannot go: the clip stays behind and the drawing spills out of the shape
   * it was cut to. Moving it where it is remains fine, which is why this is
   * separate from being offered at all.
   */
  canRelocate: boolean;
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

/**
 * How much room a clip has to leave before it is treated as harmless.
 *
 * Measured from a real report: the icons on it sit in clips 1.6pt bigger than
 * themselves and the logos in clips exactly their own size, so anything under
 * a few points means a drag of any distance slides the drawing out of view.
 */
const CLIP_ROOM = 6;

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
function isBalanced(
  marks: Array<{ pos: number; op: 'q' | 'Q' | 'cm' | 'clip' }>,
  start: number,
  end: number,
): boolean {
  let depth = 0;
  for (const m of marks) {
    if (m.pos < start || m.pos >= end) continue;
    if (m.op === 'q') depth++;
    else if (m.op === 'Q') {
      depth--;
      if (depth < 0) return false;
    } else if (m.op === 'cm' && depth === 0) return false;
  }
  return depth === 0;
}

/**
 * The innermost q...Q that encloses a byte range and holds nothing else.
 *
 * "Holds nothing else" is the whole safety of it: the range is only widened to
 * the block when every drawing operation inside that block belongs to the
 * group being moved. A block shared with a neighbour would take the neighbour
 * along, which is exactly the class of bug this file exists to avoid.
 */
function enclosingBlock(
  marks: Array<{ pos: number; op: 'q' | 'Q' | 'cm' | 'clip'; ctm?: PathOp['ctm'] }>,
  others: Array<{ start: number }>,
  start: number,
  end: number,
): { start: number; end: number; ctm: PathOp['ctm'] } | null {
  const opens: Array<{ pos: number; ctm?: PathOp['ctm'] }> = [];
  let found: { start: number; end: number; ctm: PathOp['ctm'] } | null = null;

  for (const m of marks) {
    if (m.op === 'q') {
      opens.push({ pos: m.pos, ctm: m.ctm });
      continue;
    }
    if (m.op !== 'Q') continue;
    const open = opens.pop();
    if (!open || !open.ctm) continue;
    // The tightest block that contains the whole group *and* a clip. The
    // innermost block around a drawing usually holds only its matrix, with the
    // clip a level further out, and bracketing that inner one moves the
    // drawing out from under a clip that stayed behind.
    const holdsClip = marks.some((k) => k.op === 'clip' && k.pos > open.pos && k.pos < m.pos);
    if (open.pos < start && m.pos >= end && holdsClip) {
      if (!found || open.pos > found.start) found = { start: open.pos, end: m.pos + 1, ctm: open.ctm };
    }
  }
  if (!found) return null;

  for (const op of others) {
    if (op.start > found.start && op.start < found.end && !(op.start >= start && op.start < end)) return null;
  }
  return found;
}

/**
 * The smallest run of whole q...Q blocks that covers a byte range.
 *
 * Plenty of producers wrap every path of an icon in its own block: q, clip,
 * draw, Q, again and again. A range from the first path to the last then
 * closes brackets it never opened and reads as unbalanced, and those icons
 * were never offered at all: on a real report the Twitter mark could not be
 * moved while its neighbour, drawn as one block, could. The blocks are what
 * the producer treated as the unit, so the range is widened to cover them
 * whole, and a move then carries every path's own clip and matrix inside it.
 */
function blockSpan(
  marks: Array<{ pos: number; op: 'q' | 'Q' | 'cm' | 'clip'; ctm?: PathOp['ctm'] }>,
  start: number,
  end: number,
): { start: number; end: number; ctm?: PathOp['ctm'] } | null {
  const opens: Array<{ pos: number; ctm?: PathOp['ctm'] }> = [];
  const pairs: Array<{ open: number; close: number; ctm?: PathOp['ctm'] }> = [];
  for (const m of marks) {
    if (m.op === 'q') opens.push({ pos: m.pos, ctm: m.ctm });
    else if (m.op === 'Q') {
      const open = opens.pop();
      if (open) pairs.push({ open: open.pos, close: m.pos, ctm: open.ctm });
    }
  }

  let s = start;
  let e = end;
  // A block with exactly one foot inside the range pulls the edge out until
  // it is covered whole. Well nested, so this settles; the guard is for
  // streams that are not.
  for (let guard = 0; guard < 32; guard++) {
    let grew = false;
    for (const b of pairs) {
      const openInside = b.open >= s && b.open < e;
      const closeInside = b.close >= s && b.close < e;
      if (openInside === closeInside) continue;
      if (b.open < s) {
        s = b.open;
        grew = true;
      }
      if (b.close >= e) {
        e = b.close + 1;
        grew = true;
      }
    }
    if (!grew) break;
  }

  // The matrix the widened range starts under. When the start moved to a q,
  // it is the one recorded there; a start that never moved keeps the caller's
  // own matrix, which the caller substitutes for the missing one.
  if (s === start) return { start: s, end: e };
  const at = pairs.find((b) => b.open === s);
  if (!at?.ctm) return null;
  return { start: s, end: e, ctm: at.ctm };
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

  // Everything on the page that is not a path, in stream order. A group's byte
  // range covers everything between its first path and its last, so a word or
  // a picture drawn in the middle of a run would be carried along by any move.
  // Consecutive numbering was supposed to rule that out and on one real
  // document it did not, so the gap between one path and the next is checked
  // against the bytes. Finding one ends the run rather than discarding it:
  // dropping the group outright takes an object that was perfectly movable in
  // two halves and makes it unselectable, which is a worse answer than two
  // objects.
  const foreign = [...walk.ops, ...walk.images]
    .map((o) => ({ streamId: o.streamId, start: o.start }))
    .sort((a, b) => a.start - b.start);
  const intervenes = (streamId: string, from: number, to: number): boolean =>
    from < to && foreign.some((o) => o.streamId === streamId && o.start >= from && o.start < to);

  // A matrix set at the paths' own level between two of them also ends the
  // run. A range across it would bracket the matrix inside the translation,
  // which the balance check refuses later anyway; ending the run instead
  // keeps both sides offerable. This is not hypothetical: moving a group
  // writes exactly such a cm at its edges, and a moved group that landed
  // next to a bystander used to join it, straddle its own bracket, and turn
  // unmovable for good after one move. Matrices inside deeper blocks are
  // fine, so each cm is recorded with the q-depth it occurs at.
  const cmMarks = new Map<string, Array<{ pos: number; depth: number }>>();
  for (const [sid, ms] of walk.stateMarks) {
    let d = 0;
    const list: Array<{ pos: number; depth: number }> = [];
    for (const m of ms) {
      if (m.op === 'q') d++;
      else if (m.op === 'Q') d = Math.max(0, d - 1);
      else if (m.op === 'cm') list.push({ pos: m.pos, depth: d });
    }
    cmMarks.set(sid, list);
  }
  const cmBreaks = (streamId: string, from: number, to: number, below: number): boolean =>
    from < to && (cmMarks.get(streamId) ?? []).some((c) => c.pos >= from && c.pos < to && c.depth < below);

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
      !intervenes(path.streamId, last.end, path.start) &&
      !cmBreaks(path.streamId, last.end, path.start, path.depth) &&
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

    // A run whose paths each sit in their own q...Q reads as unbalanced from
    // inside the first block to inside the last. Those are exactly the icons
    // a producer stamps out clip-by-clip, so instead of refusing, the range
    // is widened to cover the blocks whole and moved through the same block
    // machinery a tight clip already uses. Everything inside the widened
    // range must belong to the group, or the widening is quietly a merge.
    let span: { start: number; end: number; ctm?: PathOp['ctm'] } | null = null;
    if (!isBalanced(marks, start, end)) {
      span = blockSpan(marks, start, end);

      // The clip has to travel too. When each path carries its clip inside
      // its own block the span already holds them all, but plenty of files
      // put one shared clip a level further out: q, clip, then the blocks.
      // Moving just the blocks slid the drawing out from under that clip and
      // it came back cut, which the corpus caught on five documents at once.
      // The span widens to the block that holds the clip, or the group is
      // refused the way it always was.
      const clipHere = first.state.clip;
      const tightHere =
        !!clipHere &&
        Math.min(
          box.x0 - clipHere.x0,
          clipHere.x1 - box.x1,
          box.y0 - clipHere.y0,
          clipHere.y1 - box.y1,
        ) < CLIP_ROOM;
      if (span && tightHere) {
        const holdsClip = marks.some((k) => k.op === 'clip' && k.pos > span!.start && k.pos < span!.end);
        if (!holdsClip) {
          span = enclosingBlock(marks, [...walk.ops, ...walk.images, ...walk.paths], span.start, span.end);
        }
      }

      const inSpan = (op: { streamId: string; start: number }): boolean =>
        !!span && op.streamId === first.streamId && op.start >= span.start && op.start < span.end;
      const clean =
        !!span &&
        isBalanced(marks, span.start, span.end) &&
        !walk.ops.some(inSpan) &&
        !walk.images.some(inSpan) &&
        !walk.forms.some(inSpan) &&
        !walk.paths.some((p2) => inSpan(p2) && !group.includes(p2));
      if (!clean) continue;
    }

    // A backstop. Runs are already ended at anything drawn through them, so
    // this should never fire; it is here because the cost of it being wrong
    // once is a drag that takes fifty-six words of the page along with it.
    const swallows = (op: { streamId: string; start: number }): boolean =>
      op.streamId === first.streamId && op.start >= start && op.start < end;
    if (walk.ops.some(swallows) || walk.images.some(swallows)) continue;

    // Only worth widening when the clip is tight enough to matter. A page
    // sized clip cuts nothing and the narrower range is the safer one.
    const clip = first.state.clip;
    const tight =
      !!clip &&
      Math.min(box.x0 - clip.x0, clip.x1 - box.x1, box.y0 - clip.y0, clip.y1 - box.y1) < CLIP_ROOM;
    const block = span
      ? { start: span.start, end: span.end, ctm: span.ctm ?? first.ctm }
      : tight && first.streamId === 'page'
        ? enclosingBlock(marks, [...walk.ops, ...walk.images, ...walk.paths], start, end) ?? undefined
        : undefined;

    out.push({
      id: `${first.streamId}:${start}`,
      streamId: first.streamId,
      start,
      end,
      block,
      ctm: first.ctm,
      count: group.length,
      state: first.state,
      // Judged against the whole group's box, not one path's: a clip that cuts
      // any part of the drawing is a clip that cuts the drawing.
      canRelocate: canLift(first.state, box),
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
