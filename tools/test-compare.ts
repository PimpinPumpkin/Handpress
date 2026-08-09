/**
 * Comparing two versions of a document.
 *
 * The diff itself is ordinary. What is worth testing is the thing that makes a
 * comparison useful or useless on a real pair of files: a page inserted into
 * one of them. Compared by page number, every page after the insertion reads
 * as completely rewritten, and a report saying "everything changed" is a
 * report nobody can act on.
 */

import { alignPages, compareDocuments, diffLines } from '../src/pdf/compare';

let pass = 0;
let fail = 0;
function check(what: string, ok: boolean, detail = ''): void {
  if (ok) pass++;
  else {
    fail++;
    console.log(`FAIL ${what}${detail ? `: ${detail}` : ''}`);
  }
}

/* ---------- lines ---------- */
{
  const same = diffLines(['one', 'two', 'three'], ['one', 'two', 'three']);
  check('identical pages have no changes', same.length === 0, JSON.stringify(same));

  const added = diffLines(['one', 'two', 'three'], ['one', 'three']);
  check('an added line is one change', added.length === 1 && added[0].kind === 'added', JSON.stringify(added));
  check('and carries what it says', added[0]?.text === 'two', added[0]?.text);

  const removed = diffLines(['one', 'three'], ['one', 'two', 'three']);
  check('a removed line is one change', removed.length === 1 && removed[0].kind === 'removed', JSON.stringify(removed));
  check('and carries what it said', removed[0]?.was === 'two', removed[0]?.was);

  // A rewrite is one event, not a removal plus an addition. Reporting two is
  // technically true and useless to read.
  const edited = diffLines(['one', 'TWO', 'three'], ['one', 'two ish', 'three']);
  check('a rewritten line is one change', edited.length === 1 && edited[0].kind === 'changed', JSON.stringify(edited));
  check('with both sides of it', edited[0]?.was === 'two ish' && edited[0]?.text === 'TWO', JSON.stringify(edited[0]));
}

/* ---------- spacing is not a change, but case is ---------- */
{
  // Text pulled out of a PDF has spacing that depends on how it was drawn, so
  // a difference of one space is noise.
  const spacing = diffLines(['The  Quick   Brown'], ['The Quick Brown']);
  check('spacing alone is not a change', spacing.length === 0, JSON.stringify(spacing));

  // Case is not noise. "Shall" becoming "shall" is a real edit in the kind of
  // document anybody compares two versions of.
  const cased = diffLines(['The Shall Clause'], ['The shall Clause']);
  check('a change of case is a change', cased.length === 1, JSON.stringify(cased));
}

/* ---------- pages, which is the part that matters ---------- */
{
  const mine = [['a1', 'a2'], ['NEW PAGE'], ['b1', 'b2'], ['c1', 'c2']];
  const theirs = [['a1', 'a2'], ['b1', 'b2'], ['c1', 'c2']];
  const pairs = alignPages(mine, theirs);

  check('the inserted page is matched to nothing', pairs.some((p) => p.mine === 1 && p.theirs === null), JSON.stringify(pairs));
  check(
    'and the pages after it still line up',
    pairs.some((p) => p.mine === 2 && p.theirs === 1) && pairs.some((p) => p.mine === 3 && p.theirs === 2),
    JSON.stringify(pairs),
  );

  const report = compareDocuments(mine, theirs);
  // The whole point: one new page, and nothing else reported as touched.
  check('only the new page is reported', report.changes.length === 1, JSON.stringify(report.changes));
  check('as an addition', report.changes[0]?.kind === 'added' && report.changes[0]?.page === 1);
  check('and the counts agree', report.added === 1 && report.removed === 0 && report.changed === 0);
}

/* ---------- a page taken out ---------- */
{
  const mine = [['a1'], ['c1']];
  const theirs = [['a1'], ['b1'], ['c1']];
  const report = compareDocuments(mine, theirs);
  check('a deleted page is one removal', report.removed === 1 && report.added === 0, JSON.stringify(report.changes));
  check('and points at the page it came from', report.changes[0]?.otherPage === 1, String(report.changes[0]?.otherPage));
}

/* ---------- identical documents ---------- */
{
  const doc = [['a1', 'a2'], ['b1']];
  const report = compareDocuments(doc, doc.map((p) => [...p]));
  check('two identical documents read as the same', report.same, JSON.stringify(report.changes));
}

/* ---------- an edit inside a page after an insertion ---------- */
{
  // Both things at once, which is the realistic case and the one where a
  // naive comparison drowns the real edit in noise.
  const mine = [['intro'], ['inserted'], ['body one', 'body two rewritten', 'body three']];
  const theirs = [['intro'], ['body one', 'body two', 'body three']];
  const report = compareDocuments(mine, theirs);
  check('the insertion and the edit are both found', report.changes.length === 2, JSON.stringify(report.changes));
  check('the page is an addition', report.changes.some((c) => c.kind === 'added' && c.text === 'inserted'));
  check(
    'and the edit is a change on the matched page',
    report.changes.some((c) => c.kind === 'changed' && c.page === 2 && c.otherPage === 1),
    JSON.stringify(report.changes),
  );
}

/* ---------- a blank page, which has no text to differ ---------- */
{
  // Inserting a page with nothing on it produces no line changes at all, so
  // without counting pages separately it is invisible: two files a page apart
  // would report as identical.
  const mine = [['a1'], [], ['b1']];
  const theirs = [['a1'], ['b1']];
  const report = compareDocuments(mine, theirs);
  check('a blank page inserted is noticed', !report.same, JSON.stringify(report));
  check('and counted as a page', report.pagesAdded === 1 && report.pagesRemoved === 0, JSON.stringify(report.pages));
  check('without inventing line changes', report.changes.length === 0, JSON.stringify(report.changes));
}

/* ---------- a wholly different document ---------- */
{
  const mine = [['completely', 'different', 'words']];
  const theirs = [['nothing', 'alike', 'here']];
  const report = compareDocuments(mine, theirs);
  check('two unrelated pages are not matched to each other', !report.same);
  check(
    'and are reported as one page gone and one arrived',
    report.changes.every((c) => c.kind === 'added' || c.kind === 'removed') ||
      report.changes.some((c) => c.kind === 'changed'),
    JSON.stringify(report.changes.map((c) => c.kind)),
  );
}

console.log(`\ncompare: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
