# Vellum: working notes

**Update the docs with every change.** README.md and this file are part of the
change, not a follow-up. No AI attribution in commits or repo text, and no
em-dashes anywhere.

## Layout

```
src/pdf/        the engine, no DOM dependencies
  lexer.ts      content stream tokeniser, keeps byte offsets, handles inline images
  encodings.ts  Standard/WinAnsi/MacRoman tables and glyph name to Unicode
  fonts.ts      font analysis, coverage, encode and decode
  content.ts    graphics and text state replay, produces ShowOps then TextLines
  page.ts       page content access, merges multi-stream /Contents
  writer.ts     applies edits by splicing content streams
src/app/        browser layer
  model.ts      document state, edit list, undo, build and refresh
  viewer.ts     canvas rendering, line overlay, inline editor
src/main.ts     UI wiring
tools/          headless tests that run against real PDFs
```

The engine is deliberately free of DOM access so it can be tested under Node with
`tsx`, which is how nearly all of its bugs were found.

## Invariants worth protecting

**Advance neutrality.** Any operator a replacement touches must leave the text
matrix where the original did. `buildLineFragment` appends a correction offset,
and blanked operators become pure advances via `neutralAdvance`. Break this and
edits will shove later text around the page.

**Line ids are positional.** A line id is `streamId:opIndex`, which only means
anything against one fixed version of the file. The text model is therefore
always derived from the original bytes, never from an edited rebuild, while the
canvas renders the edited bytes. Deriving both from the same edited copy silently
mismatches edits after the first one.

**ToUnicode is the coverage authority.** If a font has a ToUnicode CMap, a
character missing from its inverse is missing from the subset. Do not fall back
to assuming character code equals ASCII in that case; it writes a byte that draws
the wrong glyph or nothing. `asciiFallbackAllowed` guards this.

**Never edit text we cannot read.** `decodeConfident` is false when a font has no
ToUnicode and no recognised encoding. Those lines are read only in the UI and
refused by the writer.

## Geometry is measured along the text axis, not page x

`ShowOp` carries `dirX`/`dirY` (writing direction), `u` (position along it), `v`
(perpendicular, which identifies the baseline) and `uAdvance`. Grouping,
gap detection and the writer's inter-segment offsets all work in that frame.
The direction is signed by `Math.sign(fontSize * horizScale)` because a negative
font size is legal and reverses the flow. Comparing raw x coordinates instead
reads such lines end-first and inverts every gap.

## Things already tried that did not work

- Whole-line font substitution when one character is missing. It restyles text
  that was fine. Splitting into covered and uncovered runs is why `coverageSpans`
  exists.
- Treating a missing space glyph as an encoding failure. A space draws nothing,
  so it only needs an advance. This alone took editability from 65% to 97% on the
  first test document.
- Reading spaces only at operator boundaries. Word gaps inside a single `TJ`
  array are extremely common, and missing them made rewritten lines lose every
  space on reload.
- Filtering operators whose text is only whitespace. Mixed-size type draws the
  space between words as its own operator, so discarding it joined the words.
- Assuming one line is drawn once. Outlined type draws a stroke pass and a fill
  pass over the same spot; `mergeDuplicatePasses` folds them into one line with
  `overlays`, and the writer edits every pass.

## Testing

Point the tools at a folder of real PDFs from varied producers. Synthetic
fixtures will not surface the encoding and subsetting problems that matter. Do
not commit third-party PDFs to the repo; `public/sample.pdf` is gitignored and is
only a local dev convenience, loaded with `?sample=/sample.pdf` in dev builds.

## Font substitution tiers

When a character is not in the embedded subset, `FontResolver.substitute` tries,
in order: a real typeface from the `FontProvider` (the Match fonts button, backed
by `queryLocalFonts()` in `app/local-fonts.ts`), then a style-matched standard
font. The provider is optional everywhere, so nothing regresses when it is absent
or the permission is declined. fontkit is imported on demand, only when a real
font actually has to be embedded.

## Encryption runs before parsing, not after

`decryptToBytes` loads the file once to read `/Encrypt` and derive the key, then
rewrites the raw bytes with `preDecrypt`, then reloads. It cannot be done as a
pass over an already-parsed document: pdf-lib expands object streams during
`PDFParser.parseIndirectObject` and never assigns the container to the context,
so objects inside them are parsed out of ciphertext and the evidence is gone. An
earlier attempt to walk the object graph afterwards failed on exactly those files.

Strings inside object streams are covered by the encryption of the stream holding
them, so `preDecrypt` only touches strings in top-level object dictionaries, which
is naturally what scanning the file bytes gives.

## Rendering is serialised per page, through a chain

pdf.js refuses to render the same page twice at once, and two renders sharing one
canvas context interleave their save and restore pairs, which leaves a stray
transform behind and draws the page upside down. Every draw therefore joins that
page's `queue`, including the offscreen rasterising that recognition needs. It has
to be per page: one queue for the whole document deadlocks, because a render ends
up waiting on work sitting behind it in the same queue.

A failing job must not break the chain for everything behind it, so `enqueue`
keeps the tail resolved and hands the error only to its own caller.

Renders do not progress in a background tab, because pdf.js drives its canvas
loop with `requestAnimationFrame`. That is ordinary browser behaviour, but it
looks exactly like a hang when driving the app from a script, so front the tab
before concluding anything is stuck.

## Open work
- Reflow across lines, adding and deleting text blocks, recognition across a
  whole document rather than a page at a time.
