/**
 * Drawing a piece of a page's own content, live, onto a canvas.
 *
 * Dragging used to float a rectangle of page pixels copied off the canvas.
 * That is wrong twice over: a drawing's box is a loose rectangle round a
 * shape, so most of what came with it was whatever the page had behind it, and
 * removing the copy to fix that left some shapes with no preview at all.
 *
 * The answer is the one every editor reaches: know what the object is and draw
 * it. A path group is a run of operators whose byte range is already known, so
 * replaying just that run into a 2D context gives exactly the object and
 * nothing else, at whatever position and moment is wanted. That is what makes
 * a drag feel attached to the thing being dragged rather than to a screenshot
 * of where it used to be.
 *
 * Only the operators a path group can contain are handled. Text and images
 * inside one are impossible by construction: the grouping refuses any run with
 * either drawn through it.
 */

import { Lexer, Tok, type Token } from '../pdf/lexer';
import { mul, type Matrix } from '../pdf/content';

/** Where the object should be drawn, and how page space maps to the canvas. */
export interface PaintTarget {
  ctx: CanvasRenderingContext2D;
  /** Page space to canvas space: scale, and the flip that puts y downwards. */
  toCanvas: (x: number, y: number) => [number, number];
  /** Points per canvas pixel, so line widths come out right. */
  scale: number;
}

interface PaintState {
  ctm: Matrix;
  fill: string;
  stroke: string;
  lineWidth: number;
  alpha: number;
  dash: number[];
}

function clone(s: PaintState): PaintState {
  return { ...s, ctm: [...s.ctm] as Matrix, dash: [...s.dash] };
}

const grey = (v: number): string => rgb(v, v, v);
const rgb = (r: number, g: number, b: number): string =>
  `rgb(${Math.round(Math.max(0, Math.min(1, r)) * 255)},${Math.round(Math.max(0, Math.min(1, g)) * 255)},${Math.round(
    Math.max(0, Math.min(1, b)) * 255,
  )})`;
const cmyk = (c: number, m: number, y: number, k: number): string =>
  rgb((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k));

/**
 * Replays a run of path operators onto a canvas.
 *
 * `baseCtm` is the matrix in force where the run begins, which the walk
 * already recorded: without it a group drawn inside a scaled block comes out
 * at the wrong size and in the wrong place, which is the same correction
 * moving one needs.
 */
export function paintRange(
  bytes: Uint8Array,
  start: number,
  end: number,
  baseCtm: Matrix,
  target: PaintTarget,
  initial?: { fill?: string; stroke?: string; lineWidth?: number; alpha?: number },
): void {
  let toks: Token[];
  try {
    toks = Lexer.tokenize(bytes.subarray(start, end));
  } catch {
    return;
  }

  const { ctx } = target;
  let gs: PaintState = {
    ctm: [...baseCtm] as Matrix,
    fill: initial?.fill ?? '#000',
    stroke: initial?.stroke ?? '#000',
    lineWidth: initial?.lineWidth ?? 1,
    alpha: initial?.alpha ?? 1,
    dash: [],
  };
  const stack: PaintState[] = [];

  let operands: Token[] = [];
  const nums = (): number[] => operands.filter((t) => t.kind === Tok.Num).map((t) => t.num!);

  // The path is built in canvas coordinates, since every point has to go
  // through both the content's own matrix and the page-to-canvas mapping.
  let path = new Path2D();
  let started = false;
  let cursor: [number, number] = [0, 0];

  const at = (x: number, y: number): [number, number] => {
    const px = gs.ctm[0] * x + gs.ctm[2] * y + gs.ctm[4];
    const py = gs.ctm[1] * x + gs.ctm[3] * y + gs.ctm[5];
    return target.toCanvas(px, py);
  };

  const paint = (fill: boolean, stroke: boolean, evenOdd: boolean): void => {
    ctx.globalAlpha = gs.alpha;
    if (fill) {
      ctx.fillStyle = gs.fill;
      ctx.fill(path, evenOdd ? 'evenodd' : 'nonzero');
    }
    if (stroke) {
      ctx.strokeStyle = gs.stroke;
      // A width of zero means the thinnest line the device can draw, which on
      // a canvas is one pixel rather than nothing at all.
      ctx.lineWidth = Math.max(0.35, gs.lineWidth / target.scale);
      ctx.setLineDash(gs.dash.map((d) => d / target.scale));
      ctx.stroke(path);
      ctx.setLineDash([]);
    }
    path = new Path2D();
    started = false;
  };

  for (const t of toks) {
    if (t.kind !== Tok.Op) {
      operands.push(t);
      continue;
    }
    const n = nums();

    switch (t.name) {
      case 'q':
        stack.push(clone(gs));
        break;
      case 'Q': {
        const prev = stack.pop();
        if (prev) gs = prev;
        break;
      }
      case 'cm':
        if (n.length >= 6) gs.ctm = mul(n.slice(-6) as Matrix, gs.ctm);
        break;

      case 'm':
        if (n.length >= 2) {
          cursor = at(n[n.length - 2], n[n.length - 1]);
          path.moveTo(cursor[0], cursor[1]);
          started = true;
        }
        break;
      case 'l':
        if (n.length >= 2 && started) {
          cursor = at(n[n.length - 2], n[n.length - 1]);
          path.lineTo(cursor[0], cursor[1]);
        }
        break;
      case 'c':
        if (n.length >= 6 && started) {
          const a = at(n[0], n[1]);
          const b = at(n[2], n[3]);
          cursor = at(n[4], n[5]);
          path.bezierCurveTo(a[0], a[1], b[0], b[1], cursor[0], cursor[1]);
        }
        break;
      case 'v':
        if (n.length >= 4 && started) {
          // The first control point is the current point itself.
          const b = at(n[0], n[1]);
          const to = at(n[2], n[3]);
          path.bezierCurveTo(cursor[0], cursor[1], b[0], b[1], to[0], to[1]);
          cursor = to;
        }
        break;
      case 'y':
        if (n.length >= 4 && started) {
          // The second control point is the end point.
          const a = at(n[0], n[1]);
          const to = at(n[2], n[3]);
          path.bezierCurveTo(a[0], a[1], to[0], to[1], to[0], to[1]);
          cursor = to;
        }
        break;
      case 're':
        if (n.length >= 4) {
          const [x, y, w, h] = n.slice(-4);
          const p0 = at(x, y);
          const p1 = at(x + w, y);
          const p2 = at(x + w, y + h);
          const p3 = at(x, y + h);
          path.moveTo(p0[0], p0[1]);
          path.lineTo(p1[0], p1[1]);
          path.lineTo(p2[0], p2[1]);
          path.lineTo(p3[0], p3[1]);
          path.closePath();
          started = true;
          cursor = p0;
        }
        break;
      case 'h':
        if (started) path.closePath();
        break;

      case 'W':
      case 'W*':
        // The clip is ignored on purpose. What is being drawn here is one
        // object on its own, so there is nothing for it to be cut against, and
        // applying it would hide the object at every position but its first.
        break;

      case 'S':
        paint(false, true, false);
        break;
      case 's':
        if (started) path.closePath();
        paint(false, true, false);
        break;
      case 'f':
      case 'F':
        paint(true, false, false);
        break;
      case 'f*':
        paint(true, false, true);
        break;
      case 'B':
        paint(true, true, false);
        break;
      case 'B*':
        paint(true, true, true);
        break;
      case 'b':
        if (started) path.closePath();
        paint(true, true, false);
        break;
      case 'b*':
        if (started) path.closePath();
        paint(true, true, true);
        break;
      case 'n':
        path = new Path2D();
        started = false;
        break;

      case 'g':
        if (n.length >= 1) gs.fill = grey(n[0]);
        break;
      case 'G':
        if (n.length >= 1) gs.stroke = grey(n[0]);
        break;
      case 'rg':
        if (n.length >= 3) gs.fill = rgb(n[0], n[1], n[2]);
        break;
      case 'RG':
        if (n.length >= 3) gs.stroke = rgb(n[0], n[1], n[2]);
        break;
      case 'k':
        if (n.length >= 4) gs.fill = cmyk(n[0], n[1], n[2], n[3]);
        break;
      case 'K':
        if (n.length >= 4) gs.stroke = cmyk(n[0], n[1], n[2], n[3]);
        break;
      case 'sc':
      case 'scn':
        if (n.length === 1) gs.fill = grey(n[0]);
        else if (n.length === 3) gs.fill = rgb(n[0], n[1], n[2]);
        else if (n.length === 4) gs.fill = cmyk(n[0], n[1], n[2], n[3]);
        break;
      case 'SC':
      case 'SCN':
        if (n.length === 1) gs.stroke = grey(n[0]);
        else if (n.length === 3) gs.stroke = rgb(n[0], n[1], n[2]);
        else if (n.length === 4) gs.stroke = cmyk(n[0], n[1], n[2], n[3]);
        break;
      case 'w':
        if (n.length >= 1) gs.lineWidth = n[n.length - 1];
        break;
      case 'd':
        gs.dash = n.filter((v) => v > 0);
        break;
      default:
        break;
    }
    operands = [];
  }

  ctx.globalAlpha = 1;
}
