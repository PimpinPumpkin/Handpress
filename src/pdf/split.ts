/**
 * Which pages end up in which file when a document is cut apart.
 *
 * Page arithmetic and nothing else, so both the split itself and the interface
 * that promises what the split will do can use it, and so it can be tested
 * without a browser.
 */

/**
 * Groups pages into the files a split would produce.
 *
 * Cuts at every gap before cutting by size, so no file spans one: a chosen
 * 1-3 and 8-10 taken two at a time gives 1-2, 3, 8-9, 10, not 1-2, 3-8, 9-10,
 * which would name a file for a range it does not contain.
 *
 * Shared with the interface, so the count it promises before the split is the
 * count the split produces.
 */
export function splitChunks(pages: number[], perFile: number): number[][] {
  const size = Math.max(1, Math.floor(perFile));
  const runs: number[][] = [];
  for (const page of pages) {
    const last = runs[runs.length - 1];
    if (last && page === last[last.length - 1] + 1) last.push(page);
    else runs.push([page]);
  }

  const chunks: number[][] = [];
  for (const run of runs) {
    for (let start = 0; start < run.length; start += size) chunks.push(run.slice(start, start + size));
  }
  return chunks;
}
