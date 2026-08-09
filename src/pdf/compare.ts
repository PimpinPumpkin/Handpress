/**
 * Telling two versions of a document apart.
 *
 * The hard part is not the diff. It is that a PDF has no idea it is a version
 * of anything: pages can be inserted or removed, so page three of one file may
 * be page four of the other, and comparing them by number reports every page
 * after an insertion as completely rewritten. So pages are matched to each
 * other first, by how much text they share, and only then are their lines
 * compared.
 *
 * Lines rather than words, because that is the unit a person reads a change
 * in, and because a line already exists here as a thing with a position on the
 * page that can be jumped to and highlighted.
 */

/** One line's worth of difference. */
export interface Change {
  kind: 'added' | 'removed' | 'changed';
  /** Page in the document being looked at, or null when the line only exists in the other one. */
  page: number | null;
  /** Page in the other document, or null when the line is only in this one. */
  otherPage: number | null;
  /** Index of the line within its page, for finding it again. */
  line: number;
  /** What it says now. Empty for a line that was removed. */
  text: string;
  /** What it said before. Empty for a line that was added. */
  was: string;
}

export interface CompareReport {
  changes: Change[];
  /** Pages matched to each other, as pairs, with null for one that has no partner. */
  pages: Array<{ mine: number | null; theirs: number | null }>;
  added: number;
  removed: number;
  changed: number;
  /** Whole pages with no partner in the other file, counted separately. */
  pagesAdded: number;
  pagesRemoved: number;
  /** True when the two read identically, whatever their bytes say. */
  same: boolean;
}

/**
 * Normalised for comparison: what a reader would call the same line.
 *
 * Spacing only. Text pulled out of a PDF has spacing that depends on how the
 * producer drew it rather than on what it says, so two identical sentences
 * routinely differ by a space and reporting that is noise. Case is left alone,
 * because "Shall" becoming "shall" is a real edit in the kind of document
 * anybody compares two versions of.
 */
function key(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * How much two pages have in common, from 0 to 1.
 *
 * Counted over the lines they share rather than their order, because a page
 * whose paragraphs moved is still recognisably the same page, and the line
 * diff afterwards is what says what actually changed on it.
 */
function similarity(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const counts = new Map<string, number>();
  for (const line of a) {
    const k = key(line);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let shared = 0;
  for (const line of b) {
    const k = key(line);
    const have = counts.get(k) ?? 0;
    if (have > 0) {
      shared++;
      counts.set(k, have - 1);
    }
  }
  return (2 * shared) / (a.length + b.length);
}

/** Pages that plainly correspond, allowing for ones inserted or taken out. */
const PAGE_MATCH = 0.5;

/**
 * Matches the pages of two documents to each other.
 *
 * A longest common subsequence over pages, where two pages count as the same
 * when they share enough text. That handles an inserted page without reporting
 * every page after it as rewritten, which is the failure that makes a naive
 * comparison useless on anything real.
 */
export function alignPages(mine: string[][], theirs: string[][]): Array<{ mine: number | null; theirs: number | null }> {
  const n = mine.length;
  const m = theirs.length;
  const score: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const alike = similarity(mine[i], theirs[j]) >= PAGE_MATCH;
      score[i][j] = alike
        ? score[i + 1][j + 1] + 1
        : Math.max(score[i + 1][j], score[i][j + 1]);
    }
  }

  const out: Array<{ mine: number | null; theirs: number | null }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (similarity(mine[i], theirs[j]) >= PAGE_MATCH) {
      out.push({ mine: i, theirs: j });
      i++;
      j++;
    } else if (score[i + 1][j] >= score[i][j + 1]) {
      out.push({ mine: i, theirs: null });
      i++;
    } else {
      out.push({ mine: null, theirs: j });
      j++;
    }
  }
  while (i < n) out.push({ mine: i++, theirs: null });
  while (j < m) out.push({ mine: null, theirs: j++ });
  return out;
}

/**
 * The lines that differ between two pages.
 *
 * A removal immediately followed by an addition is reported as one line being
 * changed rather than two events, because that is what happened and what
 * somebody wants to read. Everything else is an outright addition or removal.
 */
export function diffLines(mine: string[], theirs: string[]): Array<Omit<Change, 'page' | 'otherPage'>> {
  const n = mine.length;
  const m = theirs.length;
  const score: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      score[i][j] = key(mine[i]) === key(theirs[j])
        ? score[i + 1][j + 1] + 1
        : Math.max(score[i + 1][j], score[i][j + 1]);
    }
  }

  const raw: Array<Omit<Change, 'page' | 'otherPage'>> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (key(mine[i]) === key(theirs[j])) {
      i++;
      j++;
    } else if (score[i + 1][j] >= score[i][j + 1]) {
      raw.push({ kind: 'added', line: i, text: mine[i], was: '' });
      i++;
    } else {
      raw.push({ kind: 'removed', line: i, text: '', was: theirs[j] });
      j++;
    }
  }
  while (i < n) {
    raw.push({ kind: 'added', line: i, text: mine[i], was: '' });
    i++;
  }
  while (j < m) {
    raw.push({ kind: 'removed', line: Math.min(i, n), text: '', was: theirs[j] });
    j++;
  }

  // A removal and an addition at the same place is a rewrite, not two events.
  const out: Array<Omit<Change, 'page' | 'otherPage'>> = [];
  for (let k = 0; k < raw.length; k++) {
    const here = raw[k];
    const next = raw[k + 1];
    // Adjacent in the walk is what makes them the same place. Comparing their
    // line numbers does not work: the two sides advance through different
    // documents, so a rewrite comes out as line 1 against line 2 and every
    // rewrite was reported as an unrelated addition and removal.
    if (here && next && here.kind === 'removed' && next.kind === 'added') {
      out.push({ kind: 'changed', line: next.line, text: next.text, was: here.was });
      k++;
      continue;
    }
    if (here && next && here.kind === 'added' && next.kind === 'removed') {
      out.push({ kind: 'changed', line: here.line, text: here.text, was: next.was });
      k++;
      continue;
    }
    out.push(here);
  }
  return out;
}

/** Compares two documents, page by matched page. */
export function compareDocuments(mine: string[][], theirs: string[][]): CompareReport {
  const pages = alignPages(mine, theirs);
  const changes: Change[] = [];

  for (const pair of pages) {
    const a = pair.mine === null ? [] : mine[pair.mine];
    const b = pair.theirs === null ? [] : theirs[pair.theirs];
    for (const change of diffLines(a, b)) {
      changes.push({ ...change, page: pair.mine, otherPage: pair.theirs });
    }
  }

  const added = changes.filter((c) => c.kind === 'added').length;
  const removed = changes.filter((c) => c.kind === 'removed').length;
  const changed = changes.filter((c) => c.kind === 'changed').length;
  // Counted separately, because a page with nothing written on it produces no
  // line changes at all and would otherwise be invisible: inserting a blank
  // page is a real difference between two versions even though no text moved.
  const pagesAdded = pages.filter((p) => p.mine !== null && p.theirs === null).length;
  const pagesRemoved = pages.filter((p) => p.mine === null && p.theirs !== null).length;
  return {
    changes,
    pages,
    added,
    removed,
    changed,
    pagesAdded,
    pagesRemoved,
    same: !changes.length && !pagesAdded && !pagesRemoved,
  };
}
