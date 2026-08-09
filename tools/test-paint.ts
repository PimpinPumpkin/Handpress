/**
 * Replaying a run of path operators onto a canvas.
 *
 * This is what a drag draws, so what matters is that it draws the object and
 * only the object: the previous approach copied page pixels and brought
 * whatever was behind the shape along with it.
 *
 * There is no canvas under Node, so a recording context stands in. It captures
 * the calls rather than the pixels, which is the right level anyway: the
 * question is whether the operators were understood, not whether the browser
 * can rasterise.
 */

import { paintRange } from '../src/app/paint';
import type { Matrix } from '../src/pdf/content';

let pass = 0;
let fail = 0;
function check(what: string, ok: boolean, detail = ''): void {
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${what}${detail ? `: ${detail}` : ''}`);
  }
}

/** Records what was asked of it, standing in for a real 2D context. */
function recorder() {
  const calls: string[] = [];
  const path = {
    moveTo: (x: number, y: number) => calls.push(`moveTo ${x.toFixed(1)} ${y.toFixed(1)}`),
    lineTo: (x: number, y: number) => calls.push(`lineTo ${x.toFixed(1)} ${y.toFixed(1)}`),
    bezierCurveTo: (...a: number[]) => calls.push(`curve ${a.map((v) => v.toFixed(1)).join(' ')}`),
    closePath: () => calls.push('close'),
  };
  (globalThis as unknown as { Path2D: unknown }).Path2D = function Path2D() {
    return path;
  };
  const ctx = {
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    fill: (_p: unknown, rule?: string) => calls.push(`fill ${ctx.fillStyle}${rule === 'evenodd' ? ' evenodd' : ''}`),
    stroke: () => calls.push(`stroke ${ctx.strokeStyle} w${ctx.lineWidth.toFixed(2)}`),
    setLineDash: (d: number[]) => calls.push(`dash ${d.length}`),
  };
  return { calls, ctx: ctx as unknown as CanvasRenderingContext2D };
}

const identity: Matrix = [1, 0, 0, 1, 0, 0];
const enc = new TextEncoder();

function run(content: string, ctm: Matrix = identity) {
  const { calls, ctx } = recorder();
  const bytes = enc.encode(content);
  // Page space to canvas space, kept as a plain flip so positions are readable.
  paintRange(bytes, 0, bytes.length, ctm, {
    ctx,
    toCanvas: (x, y) => [x, 800 - y],
    scale: 1,
  });
  return calls;
}

/* ---------- a filled rectangle ---------- */
{
  const calls = run('1 0 0 rg 100 700 50 20 re f');
  check('a rectangle becomes four corners', calls.filter((c) => c.startsWith('lineTo')).length === 3, calls.join(' | '));
  check('it starts at the corner it was given', calls[0] === 'moveTo 100.0 100.0', calls[0]);
  check('and is filled in the colour that was set', calls.some((c) => c === 'fill rgb(255,0,0)'), calls.join(' | '));
}

/* ---------- a stroked path with a width ---------- */
{
  const calls = run('0 0 1 RG 3 w 10 10 m 20 20 l S');
  check('a stroke uses the stroke colour', calls.some((c) => c.startsWith('stroke rgb(0,0,255)')), calls.join(' | '));
  check('and the width it was given', calls.some((c) => c.includes('w3.00')), calls.join(' | '));
}

/* ---------- curves ---------- */
{
  const calls = run('0 0 m 10 10 20 20 30 30 c S');
  check('a full curve is one bezier', calls.filter((c) => c.startsWith('curve')).length === 1, calls.join(' | '));

  // v takes the current point as the first control point, y takes the end
  // point as the second. Getting either backwards bends the curve the wrong way.
  const vees = run('5 5 m 10 10 20 20 v S');
  check('v uses the current point as its first control', vees.some((c) => c.startsWith('curve 5.0 795.0')), vees.join(' | '));
  const wyes = run('5 5 m 10 10 20 20 y S');
  check('y repeats the end point as its second control', wyes.some((c) => /curve .* 20\.0 780\.0 20\.0 780\.0$/.test(c)), wyes.join(' | '));
}

/* ---------- the matrix the run starts under ---------- */
{
  // A group drawn inside a scaled block has to be drawn scaled, which is the
  // same correction moving one needs and the same one that got a drag wrong.
  const calls = run('0 0 0 rg 10 10 10 10 re f', [2, 0, 0, 2, 100, 100] as Matrix);
  check('the starting matrix is applied', calls[0] === 'moveTo 120.0 680.0', calls[0]);
}

/* ---------- q and Q ---------- */
{
  const calls = run('1 0 0 rg q 0 0 1 rg 0 0 5 5 re f Q 10 10 5 5 re f');
  const fills = calls.filter((c) => c.startsWith('fill'));
  check('a saved state is restored', fills[0] === 'fill rgb(0,0,255)' && fills[1] === 'fill rgb(255,0,0)', fills.join(' | '));
}

/* ---------- a clip inside the run is ignored ---------- */
{
  // The object is being drawn on its own, so there is nothing to cut it
  // against. Honouring the clip would hide it everywhere but where it started,
  // which is exactly the bug this whole area has been about.
  const calls = run('0 0 100 100 re W n 1 0 0 rg 10 10 20 20 re f');
  check('a clip does not stop the object being drawn', calls.some((c) => c.startsWith('fill')), calls.join(' | '));
}

/* ---------- even odd filling ---------- */
{
  const calls = run('0 g 0 0 10 10 re 2 2 6 6 re f*');
  check('an even odd fill says so', calls.some((c) => c.endsWith('evenodd')), calls.join(' | '));
}

console.log(`\npainting: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
