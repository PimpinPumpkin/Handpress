/**
 * Measuring, which is arithmetic plus one decision about scale.
 *
 * The arithmetic lives in the viewer, which needs a DOM, so the same sums are
 * done here against known shapes. What is worth checking is not that a square
 * is a square: it is that calibrating changes every later reading by exactly
 * the ratio asked for, and that area scales by the square of it, which is the
 * part that is easy to get wrong and impossible to notice by eye.
 */

let pass = 0;
let fail = 0;
function check(what: string, ok: boolean, detail = ''): void {
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${what}${detail ? `: ${detail}` : ''}`);
  }
}

const distance = (a: { x: number; y: number }, b: { x: number; y: number }, scale: number): number =>
  Math.hypot(b.x - a.x, b.y - a.y) * scale;

const area = (points: Array<{ x: number; y: number }>, scale: number): number => {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum / 2) * scale * scale;
};

const near = (a: number, b: number, tol = 1e-6): boolean => Math.abs(a - b) < tol;

/* ---------- uncalibrated, a point is a point ---------- */
{
  check('a horizontal run measures its length', near(distance({ x: 0, y: 0 }, { x: 100, y: 0 }, 1), 100));
  check('a diagonal uses both axes', near(distance({ x: 0, y: 0 }, { x: 3, y: 4 }, 1), 5));
}

/* ---------- area, including a shape wound the other way ---------- */
{
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  check('a square is its side squared', near(area(square, 1), 100));
  // Winding must not make an area negative, and the shoelace formula says it
  // does unless the sign is thrown away.
  check('and is the same wound the other way', near(area([...square].reverse(), 1), 100));

  const triangle = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 0, y: 10 },
  ];
  check('a triangle is half its box', near(area(triangle, 1), 50));

  // An L, which is the shape that catches a formula that only handles convex.
  const ell = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 4 },
    { x: 4, y: 4 },
    { x: 4, y: 10 },
    { x: 0, y: 10 },
  ];
  check('a concave shape is not its bounding box', near(area(ell, 1), 64), String(area(ell, 1)));
}

/* ---------- calibration ---------- */
{
  // A 200pt line said to be 10 metres makes one point 0.05m.
  const raw = distance({ x: 0, y: 0 }, { x: 200, y: 0 }, 1);
  const scale = 10 / raw;
  check('the scale is the ratio asked for', near(scale, 0.05));
  check('the calibrated line reads what it was told', near(distance({ x: 0, y: 0 }, { x: 200, y: 0 }, scale), 10));
  check('and half of it reads half', near(distance({ x: 0, y: 0 }, { x: 100, y: 0 }, scale), 5));

  // Area scales by the square, which is the one that surprises people: a
  // scale of 0.05 makes a 200pt square 100 square metres, not 10.
  check(
    'area scales by the square of it',
    near(area([{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 }], scale), 100),
    String(area([{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 }], scale)),
  );
}

/* ---------- perimeter of a closed run ---------- */
{
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  let total = 0;
  for (let i = 0; i + 1 < square.length; i++) total += distance(square[i], square[i + 1], 1);
  total += distance(square[square.length - 1], square[0], 1);
  check('a closed run includes the side back to the start', near(total, 40), String(total));
}

console.log(`\nmeasuring: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
