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

## Open work

- Encrypted PDFs. All the locked files tested so far open with an empty user
  password, so RC4 and AES decryption plus writing out unencrypted would cover
  them. This is the single biggest coverage gap.
- Reflow across lines, adding and deleting text blocks, OCR for scans.
