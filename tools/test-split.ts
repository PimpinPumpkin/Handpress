/**
 * How a split groups pages into files.
 *
 * The interesting case is a chosen set with a gap in it. Cutting the flat list
 * by size would put pages 3 and 8 in one file and name it "page 3-8", which
 * says the file holds six pages when it holds two. So the gaps are cut first.
 *
 * The count matters as much as the grouping: the dialog says how many files
 * are coming before anything is written, and it says it by calling this. A
 * promise made by different arithmetic than the one that keeps it is a promise
 * that will eventually be wrong.
 */

import { splitChunks } from '../src/pdf/split';

interface Case {
  what: string;
  pages: number[];
  perFile: number;
  want: number[][];
}

/** Pages are given as page numbers here and converted, because that is how anyone reads them. */
const cases: Case[] = [
  {
    what: 'every page on its own',
    pages: [1, 2, 3, 4],
    perFile: 1,
    want: [[1], [2], [3], [4]],
  },
  {
    what: 'two at a time, evenly',
    pages: [1, 2, 3, 4],
    perFile: 2,
    want: [
      [1, 2],
      [3, 4],
    ],
  },
  {
    what: 'two at a time with an odd page left over',
    pages: [1, 2, 3, 4, 5],
    perFile: 2,
    want: [[1, 2], [3, 4], [5]],
  },
  {
    what: 'a gap splits a file even when the size would not',
    pages: [1, 2, 3, 8, 9, 10],
    perFile: 2,
    want: [[1, 2], [3], [8, 9], [10]],
  },
  {
    what: 'single pages scattered about',
    pages: [2, 5, 9],
    perFile: 3,
    want: [[2], [5], [9]],
  },
  {
    what: 'one run larger than the whole size',
    pages: [4, 5, 6, 7],
    perFile: 10,
    want: [[4, 5, 6, 7]],
  },
  {
    what: 'a size below one is still one',
    pages: [1, 2],
    perFile: 0,
    want: [[1], [2]],
  },
  {
    what: 'nothing chosen produces nothing',
    pages: [],
    perFile: 2,
    want: [],
  },
];

let pass = 0;
let fail = 0;

for (const c of cases) {
  const got = splitChunks(
    c.pages.map((n) => n - 1),
    c.perFile,
  ).map((chunk) => chunk.map((i) => i + 1));

  if (JSON.stringify(got) === JSON.stringify(c.want)) {
    pass++;
    continue;
  }
  console.log(`FAIL ${c.what}\n  want ${JSON.stringify(c.want)}\n  got  ${JSON.stringify(got)}`);
  fail++;
}

// Whatever the grouping, every chosen page belongs to exactly one file and
// keeps its order. A grouping that loses a page is worse than a badly named one.
for (const c of cases) {
  const flat = splitChunks(
    c.pages.map((n) => n - 1),
    c.perFile,
  ).flat();
  const want = c.pages.map((n) => n - 1);
  if (JSON.stringify(flat) !== JSON.stringify(want)) {
    console.log(`FAIL ${c.what}: pages went missing or moved`);
    fail++;
  } else {
    pass++;
  }
}

console.log(`\nsplit: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
