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

## Operators must be separated, not just concatenated

A replacement fragment is spliced in where a show operator was, and the bytes
before it are whatever the producer wrote. `Td` followed immediately by a number
lexes as one token called `Td-22.25`, because `-` is a regular character and does
not end a keyword. That silently swallowed both the positioning and the move, and
a dragged line landed at the end of the line above it. `buildLineFragment` now
starts with a space. Documents whose previous operator ended in `)` or `]` were
unaffected, which is why the single page sample never showed it.

## Known reading quirk: neighbouring runs can merge after an edit

Two runs whose baselines differ by less than a point are one line as far as
`groupLines` is concerned once the horizontal gap between them closes. Making a
line longer can therefore pull the run beside it into the same line on the next
read. `tools/test-multi.ts` reports this on `sample-multi.pdf`, where the title
and the ISSN sit 0.9pt apart. The file itself is correct: the ISSN run is still
drawn at exactly its original x. Do not chase it as a writer bug.

## Notes are annotations, not page content

`src/pdf/notes.ts` attaches `/Text` annotations to the page object; nothing about
a note goes through the content stream or the writer. That is why the canvas
never shows one: readers draw their own icon and popup, so the overlay draws a
marker to stand in for it while the document is open. Comment text is written as
a hex string, which is UTF-16 and can therefore carry any language; a literal
string would be stuck with the document's own encoding.

The note editor is appended to the page container rather than the overlay,
because the overlay is discarded and rebuilt on every rebuild of the document
and took a half typed comment with it.

## Wrap decisions are measured, never taken from the drawn extent

`paragraphs.ts` decides where a line breaks by measuring text in the document's
own font. The width a line was *drawn* at is not the same number: justified text
is drawn with stretched spaces, so its drawn extent is wider than the same words
set normally, and a column taken from it lets one more word onto every line. Both
sides of every comparison are measured, on words joined by single spaces, because
a document that puts two spaces after a full stop would otherwise report a wider
line than the rewrap produces.

The column edge comes from the paragraph's own breaks rather than a guessed
margin: each wrapped line says the column reached at least that far and that the
next line's first word did not fit. Those bounds are kept per line, since
justification, hyphenation and manual breaks leave real paragraphs whose lines
disagree about where the margin was.

Geometry alone cannot tell prose from a list: names, times and table rows stack
with even leading and a shared left edge exactly like wrapped text. `wraps()`
asks what the text is doing instead, and requires a column at least twelve ems
wide with at least three words to a line.

## An open editor owns its page

`buildOverlay` refuses to run while an editor is open on that page. A page
re-renders for reasons that have nothing to do with what is being typed, and
replacing the boxes mid sentence takes the caret with them: the edit is lost and
the click that started it looks like it did nothing. For the same reason the
editor and its cover are mounted on the page container, not the overlay.

## Open work
- Reflow across lines, adding and deleting text blocks, replies on a note,
  recognition in languages other than English.
