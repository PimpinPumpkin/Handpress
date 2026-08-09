# Handpress: working notes

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

## A page's text model must not depend on its render

`drawPage` reads the model before rendering, and `refreshRendered` no longer
throws models away. Both come from the same bug: the model used to be attached
after the render and skipped entirely when the render token had moved on, which
left a page drawn and looking fine with `p.model` null. Every line on it then
selected on click and refused to open an editor, silently, with nothing in the
console to say why. It showed up on long documents, where thumbnails keep the
render queue busy long enough for the window to be seconds wide.

## Gestures keep no state on the element

A page re-renders for reasons that have nothing to do with the pointer, and on a
long document that can happen between pressing and releasing the mouse: the box
the press landed on is replaced and the release lands on its new twin. Anything
remembered on the old element goes with it, and the click is lost. `makeDraggable`
therefore listens for move and release on the window and keeps its state in the
closure of the press.

## An open editor owns its page

`buildOverlay` refuses to run while an editor is open on that page. A page
re-renders for reasons that have nothing to do with what is being typed, and
replacing the boxes mid sentence takes the caret with them: the edit is lost and
the click that started it looks like it did nothing. For the same reason the
editor and its cover are mounted on the page container, not the overlay.

## The text layer is a copy of the page, not a reading of it

`buildTextLayer` places one span per line from the same model the editor uses, so
what can be selected is exactly what can be edited. Two details make it line up:
each span is scaled horizontally to the width the line was drawn at, because the
browser lays it out in a substitute face; and a real `<br>` follows each span,
because absolutely positioned elements are all one line as far as
`Selection.toString()` is concerned.

It is inert except in the select tool, and it sits above the overlay so that a
drag there reaches the words rather than the boxes drawn over them.

## Compression is decided by the drawn size, not the stored size

`compress.ts` asks how wide each image is painted on the page, using the fact
that an image XObject is always drawn into the unit square so the matrix in
effect is its size. Detail beyond what that placement can show is what gets
thrown away; an image already at or under the target is left untouched, because
redrawing it could only make it worse. Resource names come from the lexer
without their slash and from a `PDFName` with one, which is worth remembering:
the two failing to match made every image look undrawn and nothing was ever
compressed.

Redrawing needs a canvas, so `compress.ts` takes an injected `Recompressor` and
the browser half lives in `app/recompress.ts`. That keeps the engine testable
under Node, where the test stands in a fixed JPEG and checks which images were
chosen rather than the quality of a resize.

## Recovery keeps the document, not the edit list

`autosave.ts` writes the built bytes to IndexedDB a couple of seconds after the
last change. Serialising the edit list instead would mean serialising placed
images, merged documents and the undo stack, and restoring it would exercise a
path nothing else uses. Keeping the document means restoring is just opening a
file. The undo history goes, and the offer says so.

Failure is swallowed on purpose: private windows, a full disk and storage turned
off all end up in the same catch, and none of them is a reason to interrupt
somebody who is editing. Anything over 80 MB is not attempted, and says so.

## The zip is written here, and checked by something else

`zip.ts` is about eighty lines and has no dependencies. Entries are stored
rather than deflated: a PDF is already compressed, so deflating buys a percent
or two for the cost of carrying a compressor into the bundle. `tools/test-zip.ts`
hands its output to the system `unzip`, which verifies every CRC and the whole
central directory, because an archive only this code can read proves nothing.
The CRC table is checked against the standard `123456789` value first, so a
broken table is caught before anything else gets blamed.

## Encryption is written at revision 6 only, and checked by pdf.js

`encrypt.ts` writes AES-256 and nothing else. Revision 6 makes the file key
random rather than derived from the password, so there is no per object key and
no dependence on object numbers: the password wraps the key, the key encrypts
the document. `hash2B` is shared with the decryption side, and
`aesCbcEncryptNoPad` was already there.

Every string and stream is encrypted, so the save that follows must use
`useObjectStreams: false`. Strings inside an object stream are covered by the
encryption of the container and must not be encrypted twice; keeping every
object at the top level avoids the question entirely. The `/Encrypt` dictionary
is registered last, because it is the one thing that stays in the clear, and an
`/ID` is added if the document has none, since a reader is entitled to refuse an
encrypted file without one.

`tools/test-encrypt.ts` checks the result with pdf.js, which implements the same
handler independently. That is the point of the test: our own decryptor agreeing
with our own encryptor would prove only that the two halves match.

## A file the renderer can show is not always one the editor can rewrite

pdf.js and pdf-lib are different parsers with different tolerance for damage.
Two real documents in the pdf.js corpus render perfectly and cannot be loaded
for editing at all, and refusing them outright turned a file that could at least
be read into one that would not open. `decryptToBytes` now hands back anything
its own parser cannot read, and `LoadReport.canEdit` says which state the
document is in. Loading is not the same as being usable, so the check asks for
page zero: a broken page tree parses happily and throws the moment anything
wants a page.

## Text drawn more than once is one piece of text

A form XObject drawn several times on a page gives every appearance its own
line, all reading the same bytes. Editing any of them rewrites the text
everywhere it appears, because there is only one copy of it. `applyPatches`
keeps the first patch and reports the rest as a `shared-text` warning instead of
dropping them in silence, and the overlay marks such lines and says how many
copies there are before anyone types into one.

The same form can also be reached by more than one route, and a document whose
forms reference each other reaches the same one at several depths. Patches are
therefore gathered by the stream they land in rather than by the path taken to
get there, since writing a stream once per route throws away every write but the
last.

## The recogniser is served, not fetched

Tesseract fetches its worker, its wasm core and its language data from two
public CDNs unless told otherwise. `npm run ocr-assets` puts them in
`public/ocr` and `openRecogniser` points at that, so an app that promises never
to upload anything does not announce over the network that it is reading a
document, and works with no connection at all.

The languages installed are whatever `OCR_LANGS` asked for, English always
included because it is the fallback and a fallback that is not installed is not
one. The script writes `lang/index.json` and the picker is built from that, so
the app can only offer what is actually there; it also deletes data for a
language that has been dropped, rather than letting it linger because it
happens to be on disk.

The paths handed to tesseract are absolute, resolved against `document.baseURI`.
The build uses a relative base so the site works from any path, but the worker
runs from a blob URL and resolves a relative path against the blob rather than
against the page, so it would ask for the core somewhere that does not exist.
Dev never showed this: there the base is `/` and the paths came out absolute
anyway. Verified by serving `dist` under a subpath.

A file the worker cannot fetch throws inside the worker, where nothing can
catch it, and `createWorker` then never settles. The files are asked for first
so a deploy that skipped `ocr-assets` says so rather than sitting on "Loading
the recogniser" forever. The check looks at the content type as well as the
status, because a dev server answers a missing file with index.html and a 200.

## The content policy is the privacy claim, checked

`public/_headers` carries `default-src 'self'` with no eval of any kind. The
whole pitch is that a document never leaves the machine it is opened on, and
this is the one place a browser will enforce that rather than take our word.

`blob:` is allowed in three places because three real things need it: tesseract
starts its worker from a blob, pdf.js is handed one, and printing loads the
built document into a frame as one. `style-src` needs `'unsafe-inline'` because
every box on a page is positioned with a style attribute. Nothing needs eval:
neither pdf.js nor its worker has used one since version 6, so `unsafe-eval` is
absent and should stay absent.

A policy nobody tested is a guess, so it was checked by serving the built site
with the real headers and driving every tool through it: open, edit, save,
print, split, outline and a full recognition run. No violations, and no request
to anything but its own origin.

## On a phone

Three things had to be true and none of them were.

A grid item's automatic minimum size is its min-content width, so the top bar,
which will not fold, widened the single column of `#app` and every row with it:
a 462px app inside a 375px window, with the save button and most of the toolbar
clipped off the right and no way to reach them. `#app > * { min-width: 0 }`
lets each row shrink and decide for itself what to do about not fitting. The
tool strip scrolls sideways, which is honest where a row of unreadable icons
would not be.

`touch-action: none` on `.line-box` exists so dragging a line moves it. Text
lines cover nearly all of a page, so on a touch screen that meant the document
could only be scrolled from its margins. Ordinary lines now allow panning and
lose drag-to-move on touch; things placed deliberately, a signature or added
text, keep it, because nudging one into place is most of the point. While a
region is being drawn the overlay takes `touch-action: none` for the opposite
reason: there the drag is the whole gesture.

The pages and properties columns become drawers over the document rather than
neighbours beside it. Sharing 375px three ways left the viewer 185px wide with
one open and zero with both. Positioning them takes them out of the grid, so
`.viewer-wrap` names its column rather than letting auto-placement drop it into
the empty one the sidebar left behind.

## The pinch that never let go

`watchPinch` tracked its fingers in a map and cleaned them up on pointerup
bound to the page. A finger that starts a pinch on the page can leave it before
it lifts, and a release over the toolbar never reached that listener, so the
pointer stayed in the map for the rest of the session. The next one finger drag
then counted two fingers and zoomed instead of scrolling. Release is watched on
the window now, with `blur` as a backstop.

## The hidden attribute needs help

`hidden` only carries `display: none` from the browser's own stylesheet, which
any `display` rule in ours outranks. `.thumbs` sets `display: flex`, so the
thumbnails stayed on screen while marked hidden and the outline drew underneath
them. There is now one `[hidden] { display: none !important }` rule near the
top of the stylesheet, which settles it for every element rather than one at a
time.

## The cover has to be bigger than the line

`openEditor` lays a patch of page colour over the original glyphs so only the
live text shows. Cut to the measured extent it leaves the tips of ascenders and
the tails of descenders visible around the edited text, and two sets of glyphs
half a pixel apart read as the wrong typeface rather than as a leftover. The
margin scales with the type so it is the same at every zoom.

## Freehand strokes are page content, not annotations

`InkStroke` is a list of points in page coordinates, drawn by `buildInk` as a
polyline smoothed through the midpoints of consecutive samples, which is the
same trick the signature pad uses: a midpoint is guaranteed to lie on the path,
so the curve goes through the drawing rather than near it. Round caps and joins,
because a pen has a round nib. A single point is drawn as a zero length line so
a tap leaves a dot, which an empty path does not.

Shapes are the same thing: `shapePoints` turns two corners into a list of
points, so line, arrow, box and oval all go through the pen's own path builder
and none of them needed new drawing code. An arrow retraces its tip on the way
to the second barb, since a stroke drawn over itself is invisible and it saves
carrying a second subpath. `closed` skips the smoothing, because a smoothed
rectangle has round corners.

Stroke alpha has no operator of its own, so anything less than opaque goes
through an `ExtGState` with `CA` and `ca` both set.

The stroke previews on a canvas of its own above the page while the pointer is
down. Nothing but pdf.js output of the real bytes may write to the page canvas.

`build()` has a guard that skips a page with no edits, and that guard has to
name every kind of edit there is. Ink was in `touchedPages` and then dropped
again on the next line, so strokes were recorded, counted, and never written.
Add a kind and this is the second place to change.

## A font's declared ascent is not how tall its letters are

`lineGeometry` put the top of every box at `baseline - font.ascent`, and fonts
routinely declare an ascent smaller than the glyphs they draw, or none at all.
The box then sat on the caps. There are floors of roughly the usual ascender
and descender now. The baseline is untouched: it is the one number here that
has to stay exact, because the editor and the text layer both position from it.

The box for an edited line is scaled by the ratio of measured widths, not by
adding their difference. The width a line was drawn at and the width its own
font measures are different numbers, so adding one to the other mixes two
scales and barely moves the box, which is why it looked unfixed twice.

## The commit path was not slow where it looked slow

Measured in Chrome, not assumed: rebuilding with pdf-lib is 3 to 27 ms and
handing the bytes back to pdf.js is 1 to 8 ms. Neither was the wait. The wait
was work `reload()` did on the way past and `refresh()` then discarded: five
pages probed for text, each forcing a `getTextContent` round trip and a full
font-name scan, plus a second whole-file `PDFDocument.load` to read signatures
and form fields. All of it is derived from the original bytes, which never
change, so it belongs in `open()` and now lives in `describe()`.

`drawPage` also cleared the visible canvas before an await, so every edit
blanked the page and filled it back in. It renders into a plate of its own and
blits once the render resolves and the token still matches. That makes the
token check load bearing rather than tidy: a superseded or failed render now
leaves the previous correct pixels alone instead of having already wiped them.

Do not add a predicted-pixel layer to make this faster. The canvas showing
pdf.js output of exactly the bytes `save()` would write is the whole
correctness story, and three independent judges ranked keeping it above both
alternatives that gave it up.

## A gap is drawn once, not twice

A space that stands for a positioning gap is a reading convenience: nothing in
the file drew it. The writer already reproduces the gap as a `TJ` offset, so
drawing the space as well counted it twice and slid everything after it along.
Changing one digit of a mileage moved the separator after it by a space width
and the VIN after that by two.

`groupLines` marks the segment with `syntheticTrailingSpace`, and clears it if
more text is added to that segment, so the writer can tell a space nothing drew
from one somebody typed. Corpus tests never caught this because they check that
*other lines* do not drift; this is drift inside the edited line.

## Type 3 fonts measure in their own units

A Type 3 font declares its glyph space with `/FontMatrix` and its `/Widths` are
in that space. Every other kind of font measures in 1/1000 em and the rest of
the engine assumes it, so a font at 1/2048 made every advance nearly twice what
it should be. That is a reading bug before it is a writing one: gaps between
runs were measured against inflated advances, so spaces that were there went
unnoticed. `codeWidth` scales by the matrix.

`encodeText` also refused Type 3 outright, on the grounds that a glyph is a
procedure and cannot be invented. True for a character the font never had, and
false for one it already has: writing that code draws the procedure already in
the file. Refusing all of it meant a document set in a Type 3 font was silently
redrawn in Helvetica the moment a word was changed, which is what a real Carfax
report did. Coverage decides now, the same as everywhere else, and anything
genuinely missing still falls through to substitution.

## Moving something shows its own pixels, not a promise

Any move rebuilds the document and hands it back to pdf.js before a pixel can
change. That is a few hundred milliseconds in which the outline has moved and
the artwork has not, which reads as the app being broken rather than busy.

`lift` copies the object's pixels off the canvas into a floating canvas, covers
the space it left with the page's own colour, and lets the copy follow the
pointer. It stays where it was dropped, so the move looks finished, and
`dropLifted` removes it once the page has really been redrawn underneath.

The copy is taken on the first movement rather than on the press, so a click
that was never a drag costs nothing. Cleanup is in a `finally` with an eight
second backstop: a copy left floating over a page that was never redrawn claims
a move that did not happen, which is a worse lie than a slow redraw. Note
markers are deliberately excluded, because a note is an annotation and its
marker is our own drawing rather than page pixels.

## A change to one page is not a reason to redraw the others

`refreshRendered` took an argument. Dragging an image on page one invalidated
every page in view and drew them all again before the image appeared where it
was dropped. Every caller that knows its page now says so.

## Added content must start from the page's own coordinates

Signatures, added text, erasures, highlights and redaction boxes are appended
after the page's own drawing, which means they inherit whatever transformation
the page left in effect. Nothing requires a content stream to put its matrix
back, and plenty of real files do not: a signature asked for at 150x60 at
(200, 500) arrived at 75x30 at (100, 250).

The original content is therefore wrapped in `q`/`Q` whenever anything is
appended. The leading `q` also absorbs a stream that restores more times than
it saves, which would otherwise underflow into our own state.
`tools/test-stamp-ctm.ts` builds pages that end mid-transformation and checks
where the stamp actually lands; with the wrap removed, three of its five cases
fail, which is the point of it.

## A logo is not an object until something decides it is

An image is placed by a matrix, so moving one is rewriting that matrix. A
drawing made of paths has no such handle: the coordinates are baked into the
path operators, and a logo is thirty of them in a row that a reader assembles
into one mark. Until this existed the mark at the top of a Carfax report was
not editable in any sense, because nothing in the editor believed it was a
thing.

`src/pdf/graphics.ts` groups paths that follow each other in the stream and
land near each other on the page, and `src/pdf/writer.ts` moves a group by
putting `1 0 0 1 dx dy cm` in front of its byte range and the exact inverse
after it. The inverse rather than a `Q`, because a `Q` would also discard any
colour or line width the run had set and the content after it inherits those.
The shift is carried back through the inverse of the group's own matrix, the
same correction an image needs.

Most of `graphics.ts` is refusals, and each one is a way the bracket leaks:

- **A background** is near everything, so left in the sequence it drags the
  whole page into one group. It ends the run and nothing joins across it.
- **A `Q` inside the run** pops out past the opening matrix, so the closing one
  would land on content that was never translated.
- **A `cm` at the run's own level** survives the run, and the inverse then
  composes with it in the wrong order.
- **Text or an image drawn through the run** would be swallowed by the byte
  range and moved along with it. Consecutive numbering in the walk is what
  proves nothing else was drawn in between.
- **A group that draws in under a fifth of its own box** is a skeleton, not a
  drawing: two crossing hairlines pass every other test here and are a table.

`tools/test-graphics.ts` builds pages for each of those, and
`tools/test-graphic-move.ts --list` moves the widest drawing on page one of
every file in a corpus and checks that exactly one thing moved and every text
run stayed put. A moved drawing keeps its place in the painting order, so one
taken from the top of a page and dropped into the middle can end up behind
something drawn later. That is the file's ordering, not a bug.

## What covers what is a byte order, and a clip is not a yes or no

A PDF has no z index. What is in front is whatever was drawn last, so bringing
an object forward means lifting its operators out of the middle of the page and
emitting them at the end of it. The hard part is not the order. An object's
operators carry none of the state it was drawn under: a logo's paths say where
its corners are and nothing about what colour they were, because the colour was
set further up the stream by content that is nowhere near it any more. So
`stateProlog` in `src/pdf/writer.ts` re-emits the matrix, the fill and stroke
colour, the line width, the dash and the ExtGState before the object's own
bytes. Without it a logo brought to the front arrives as a black shape.

Colour is carried as RGB rather than as the operators that set it, so a spot or
ICC colour comes back as its RGB equivalent. That is invisible on screen and
real on a press, and it is the trade for not reimplementing colour space
resolution in order to move a logo forward.

The page content is assembled as `back + q + page + Q + added + front`, so
"behind" really is behind the page's own drawing and "in front" is ahead of
added ink too.

**The clip mistake, which is worth not repeating.** The first version refused
to relocate anything drawn under a clipping path, on the sound reasoning that
the clip stays behind and the drawing would spill out of it. On real documents
that refused everything: nearly every page opens by clipping to its own box
before drawing a single thing. Worse, the refusal was silent and it happened
*after* the in-place move had been skipped, so dragging a logo and then
bringing it to the front put it back where it started and reported two edits.

The walker now tracks the clip as a rectangle and intersects it, and
`canLift` asks whether the clip actually reaches the object. A page-sized clip
reaches nothing. A clip built from anything but a single `re` is recorded as
unknowable and still refuses, because the bounding box of a triangle is bigger
than the triangle. `tools/test-zorder.ts` has a case for each of the three.

Hit testing had to change with it: drawings and images are laid into the
overlay biggest first, so the smallest thing under the pointer is on top and
gets the click. Before that, a logo dragged onto a full width panel became
unreachable, and right clicking it offered to rearrange the panel.

## A drawing cut to its own shape vanishes when it is moved

This was the single worst bug in the object editing: dragging any small icon on
a real report made it disappear. Nearly every mark on a real page is drawn
inside a clip a point or two bigger than itself. The Carfax icons sit in 20pt
clips with 1.6pt of room; its two logos sit in clips exactly their own size.
Translating only the drawing slides it out from under its own clip, and
clipping only ever intersects, so it cannot be widened from inside.

The fix is to bracket the `q` block that established the clip, so the clip
travels with the drawing. Three things had to be right:

- **Which block.** The innermost block around a drawing usually holds only its
  matrix, with the clip a level further out, so `stateMarks` records where
  clips are set and `enclosingBlock` takes the innermost block that contains
  one. Widening is refused if the block holds any other drawing operation.
- **Which matrix.** The translation is inserted in front of the block, so it
  applies in the space the matrix *at the block* maps from, not the one in
  force further inside it. Using the inner one scaled every move by whatever
  the block had already scaled by: a 180pt drag came out as 126.
- **When there is no block**, the move is held inside the clip rather than
  allowed to disappear. Zero always has to be allowed, because a clip smaller
  than the drawing it cuts gives a lower bound above zero and an upper bound
  below it, and a clamp that took those literally shoved the drawing the
  opposite way to the drag.

`tools/test-graphic-move.ts` asserts, for the tightest clipped group on every
corpus document, that the drawing is still there afterwards and no worse cut
than it was.

Related: a drawing's drag no longer floats a lifted copy. The copy is a
rectangle of page *pixels*, and a drawing's box is a loose rectangle around a
shape, so dragging a circle floated a square of everything behind the circle.
An image is its rectangle and keeps the copy.

## The page is held as pieces, so dragging composites instead of rendering

Every earlier attempt did its work when the drag began, and no amount of care
makes that instant: a render is a render, whether it copies pixels or draws the
object properly. Acrobat does not render on drag. It holds the page as objects
and recomposites.

`src/app/scene.ts` does the same. Once a page is on screen, it is taken apart
in the background into the whole page plus up to three pictures per object:
the object alone, on a transparent background so the copy that follows the
pointer is the object and not a white card with the object on it; a **hole**,
the page without that one object, cropped to its box; and an **over layer**,
everything the page draws after the object, full page on a transparent
ground. A drag is then four drawImage calls into the page canvas itself: the
page, the hole over the object's spot, the object at the pointer's offset,
and the over layer on top. No rendering happens during the gesture at all.

**The truth needs an echo.** The correct composite can put the copy behind
content drawn later, which is right and reads as the drag having stopped
drawing: the fox on a real report, dragged into an illustration painted after
it, simply vanished mid-gesture. So while the object is in hand, `stageMove`
draws it once more at 45% on top of everything. Where nothing covers it,
blending it over its own opaque pixels changes nothing; where something does,
it shows through as a ghost. The drop repaints without the echo, so what
settles is the true order alone.

**An over layer is a full page of pixels, so it is never built eagerly.** The
first version rendered one per object at scene build, and a report with
sixteen objects on every page held a quarter of a gigabyte per page: the tab
did not slow down, it died, and a dead renderer answers nothing, which looks
exactly like a freeze. `Scene.primeOver` renders the layer when the object is
actually grabbed, from the scene's own pdf.js document, which stays open for
that purpose and is released by `Scene.destroy`. Only the most recent layer
is kept, the viewer holds at most four scenes at once, and every path that
drops a scene goes through `clearScenes`, because a scene that falls out of
the map without destroy() leaks a worker-side document per edit. The build
itself was measured, not guessed: 141ms for the heaviest real page, with the
scene document holding a copy of just the one page, since pdf-lib serialises
every object in a context whether referenced or not, and raw streams instead
of deflate, since nothing in a document that lives for milliseconds deserves
compression.

**The over layer is what keeps a drag in the painting order.** A copy floated
on a layer above the page pops over content the object was naturally behind,
which reads as the object jumping the queue the moment it is touched. With
the layer, what covered the object at rest keeps covering it while it moves.
The layer cannot be a render of the suffix bytes alone, because they lean on
state the earlier bytes set up, so the earlier bytes stay and only their
marks are taken away: paths, images, inline images and whole form invocations
are blanked outright, since none of them leaves state behind, and text
becomes a pure advance through the writer's own `neutralAdvance`, so the text
matrix ends up exactly where the skipped operators would have left it. The
layer is skipped when nothing later draws, and then the copy riding on top is
also the truth.

**Why holes rather than a backdrop with the objects removed.** The first
design flattened the page-minus-objects into one backdrop and blitted every
tile back on top, and that ordering cannot be made right from outside, not
even by compositing in byte order: a caption the page draws over a band lives
in the flattened backdrop, so the band's tile covered it, and dragging
*anything* blanked the text on every panel at once. Held mid-drag in a real
browser, the header and footer bands were empty blue. A hole is a real render
of the true content minus one object, so everything behind and in front of
that object is right by construction, and nothing else is redrawn at all.

Everything goes into **one** document: the page itself, untouched, is the
backdrop, and each object appends its two cropped pages sharing the original's
resources. One document load and a page render each. A document load per
object is the difference between a second and a minute on a page with twenty
marks on it.

A tile keeps its clip, or a logo cut to its own shape would show itself uncut
the moment the page composites rather than renders, which is a change appearing
at rest that nobody asked for.

The scene is keyed on the zoom it was built at and cleared on rebuild, since a
picture rendered for one zoom is the wrong number of pixels for another.

**Three rules learned by getting them wrong, all visible only in a real drag:**

- **Build from the bytes on screen, not the ones the file arrived as.** A scene
  built from the original is missing everything added since, so shapes drawn in
  this session vanished for as long as a drag lasted and came back when it
  ended.
- **Let the page describe itself.** Handing in geometry from the model cuts
  tiles to where objects *used to be*, because the model's coordinates are the
  original document's with edits accounted for separately. It drifts further
  every time the same object is moved. `buildScene` walks the bytes it is given
  and finds the objects itself.
- **Match tiles by position, not by name.** The scene numbers objects as the
  rendered page has them and the selection numbers them as the original
  document does; those two schemes have no reason to agree. Position is what
  both agree about.

**A tile is bigger than its object.** A path's bounds are its points, and a
stroked shape is drawn half a line width outside them all the way round. Cut to
the points, an ellipse comes back with slivers shaved off its widest parts,
which is precisely where the stroke reaches furthest. `strokeReach` carries the
line width through the object's own matrix, since the width is in the space
that matrix maps from. The grown box is what the tile is cropped and drawn at;
the object's own box is kept alongside as `hx0..hy1`, because that is what the
selection knows it by and matching one against the other compares two different
measurements.

**A scene build can outlive the page it describes.** A build is a whole
document load plus a render per object, which is longer than a drag. So a
build started before a drop lands after the rebuild has cleared the map, and
installs a scene made from bytes nobody is looking at any more: the moved
object's tile is at its old position, every later ensureScene sees a scene at
the right zoom and keeps it, and the next drag of anything composites the
moved object back where it used to be. `sceneEpoch` is bumped by everything
that changes what a page shows, in `refreshRendered` because undo and the
page operations refresh directly without passing through `rebuild`, and in
`load` because a new document's page numbers are the old one's. A build that
comes home to a different epoch is thrown away and started again from the
bytes as they now are.

And one invariant: every object must have its hole and its tile. Missing
either, a drag cannot erase the object or cannot show it moving, and from the
outside that is an object flickering out of existence. If either render fails
there is no scene at all, and the drag falls back to drawing the object
itself. The over layer is the one optional picture, because losing it only
costs the painting order, not the object.

**A drop opens a window where every cached thing is one move behind.** The
model changes at the drop, the rebuild lands half a second later, and the
scene takes seconds more. A drag started inside that window used to stage
against the pre-drop scene, lose it when the rebuild cleared the map, and
then every repaint quietly returned on finding nothing: the object simply
stopped drawing until release, and clicking away then back "fixed" it by
waiting the window out. Four rules close it. `rebuild` invalidates scenes
synchronously at entry, before anything is awaited. A scene entry carries the
epoch it was built for and `stage` refuses a mismatch, sending the drag down
the fallback path instead. The drag carries its scene with it, so a mid-drag
clear cannot silence it. And the drop advances the world it can reach right
away: the box's own position, the bounds used for tile matching, the image
edit snapshot and the graphic's accumulated move, so the fallback previews
from geometry that matches what is on screen.

**The fallback path has to tell the same story as the scene.** Two bugs lived
there, both only visible in the window after a drop while the next scene is
still building. A graphic's fallback preview replays the original bytes, and
`graphicsOn` shifts the box by the accumulated move without saying so, so
after one move every fallback preview drew a whole move's distance behind its
own outline; the shift now rides on the graphic as `moved` and the replay
adds it. And an image's preview returned quietly when the hover-warmed
picture was not cached yet, so a fast drag picked up nothing at all; it now
falls back to copying the page's own pixels, background and all, which is
worse than the real picture and far better than an invisible drag.

**A real bug this found.** `findGraphics` inferred "nothing else is drawn
inside this range" from consecutive numbering, and on one corpus document that
was wrong: a group came out straddling fifty-six show operators, so taking it
off the page would have taken every word with it. The property is now checked
directly against the bytes instead of inferred.

Finding one ends the run rather than discarding the group. Throwing it away
takes an object that was perfectly movable in two halves and makes it
unselectable, which is a worse answer than two objects. The whole-range check
stays as a backstop that should now never fire.

## Dragging draws the object, it does not copy pixels

The first version floated a rectangle of page pixels lifted off the canvas.
That is wrong twice: a drawing's box is a loose rectangle round a shape, so
most of what came along was whatever the page had behind it, and removing the
copy to fix that left shapes with no preview at all.

`src/app/paint.ts` replays a run of path operators onto a 2D context. A path
group's byte range and starting matrix are already known, so replaying just
that run gives exactly the object and nothing else. Ink needs no replay at all
since it is already a list of points.

Three things in it that are easy to get wrong, all pinned by
`tools/test-paint.ts`:

- `v` takes the *current* point as its first control point and `y` repeats the
  *end* point as its second. Swapping them bends curves the wrong way.
- The matrix in force where the run begins has to be applied, or a group inside
  a scaled block draws at the wrong size in the wrong place. Same correction
  moving one needs.
- A clip inside the run is ignored on purpose. The object is being drawn on its
  own with nothing to cut it against, and honouring it would hide the object
  everywhere but where it started.

An image cannot replay operators, because the operator is `Do` and the pixels
are behind a filter and a colour space. So `imagePicture` copies the page,
replaces its content with the single operator that draws that image, crops to
its box and renders that with pdf.js. Resources are untouched, so no colour
space, mask or decode array is left dangling, and the renderer does what it
already does well. It is cached per image and warmed on hover, so the cost lands
before the drag rather than during it.

The original stays on the page under the moving copy until the drag is let go,
which is why the layer is slightly transparent. Hiding it would mean rendering
the page without the object, which is a full page render per drag.

## A selection is a set, even when it holds one thing

`picked` is the last thing touched, which is what the panel describes; the set
is what the keyboard moves and deletes, and what a drag moves when the thing
dragged is itself in the set: the drop goes through the same `nudgeOne` the
arrow keys use, so dragging three things and nudging three things produce the
same edits and the same undo. Membership is checked by box element identity,
not by re-deriving the pick key, because `data-pick` stores the id raw while
selectors escape it, and comparing the two spellings is a bug that only shows
on ids with punctuation in them. Shift, command or control add to it,
and a band drawn on bare page takes everything it overlaps rather than only
what is wholly inside, because a band round a group rarely clears their edges.

The Select tool only starts a band when the press landed on the overlay itself.
A press on an object belongs to that object, so it stays clickable and
draggable in that mode: a select tool that could only draw bands would be a
worse edit mode, not a better one.

That intent lived in the code and was undone by a stylesheet. Every tool that
drags a region across the page puts `erasing` on the overlay, and that class
turns off pointer events on every `.line-box` so nothing intercepts the drag.
The Select tool was added to the same list, which made every drawing, image and
stroke unselectable in the one mode whose entire purpose is selecting them. It
has its own `picking` class now. A mode that wants the cursor or the touch
behaviour of another mode does not want the rest of it.

Watch for automatic semicolon insertion when refactoring these: `return` with
the expression on the next line returns undefined, and every nudge silently did
nothing until the expression was bracketed.

## A selection is what makes an object an object

Everything before this was hover and drag: nothing stayed chosen, so there was
nothing for the keyboard to act on and nothing for the panel to follow. Every
box now carries `data-pick="kind:id"`, `pick()` records what is chosen, and
`restorePick` puts it back after a rebuild, since a rebuild throws away every
box on the page and a nudge would otherwise let go of what it just moved.

Two things worth keeping straight. The keyboard handler ignores events whose
target is editable, because arrow keys in a text editor move the caret and
Delete deletes a character. And clicking a line of text opens that editor, so
arrow-nudge is unreachable for text by design: the status line says "editing
this line" rather than promising a nudge the editor immediately takes back.

Deleting a line of the document's own text is refused. That is redaction, which
has its own tool and its own warning.

## Comparing is page alignment first, diff second

`src/pdf/compare.ts`. The diff is ordinary; what makes a comparison useful on a
real pair of files is that pages are matched to each other by shared text
before anything is compared. Compared by page number, one inserted page makes
every page after it read as completely rewritten.

Three things learned building it:

- **Case is not noise, spacing is.** Extracted text has spacing that depends on
  how the producer drew it, so a one space difference is meaningless. Folding
  case as well was wrong: "Shall" becoming "shall" is a real edit in exactly
  the documents people compare.
- **Pair a rewrite by adjacency, not by line number.** The two sides advance
  through different documents, so a rewritten line comes out as line 1 against
  line 2, and matching on the number reported every rewrite as an unrelated
  addition plus removal.
- **Count whole pages separately.** A blank page inserted has no text to
  differ, so without that the two files read as identical.

## Bates numbering cannot be worked out from the page index

It runs on across a whole set of documents, so the counter comes into
`stampEveryPage` and the next value goes back out; `batch.ts` threads it from
one file to the next. It advances only when a page is actually stamped, so an
unreadable page does not consume a number and leave a gap in a sequence whose
whole purpose is that there are none.

## Preflight reports and does not convert

Making a file archival means embedding fonts whose glyphs are not in the file,
which cannot be done from inside it. A conversion that substitutes typefaces
and calls the result archival is worse than a list of what is wrong.

Two things in `src/pdf/preflight.ts` are worth not breaking. A Type0 font keeps
its descriptor on the descendant, so the obvious check on the outer dictionary
reports every composite font in the document as missing. And a Type 3 font
carries its glyphs as operators, so it is embedded by construction and has no
font file to look for.

Image resolution is judged against the page rather than the box the image is
drawn in, which under-reports. That is the right way round: an image drawn
smaller than the page is sharper than this says, never softer, so nothing is
flagged that is actually fine.

The rates over 384 real documents are the sanity check: 99% no output intent,
23% a font not embedded, 16% low resolution, 3% JavaScript, 1% XFA. A rule
firing on nearly everything is a rule that is wrong, not a corpus that is.

## Comment threads never needed a server

This was assumed to need one for a while and it does not. A reply is an
annotation carrying `/IRT` at the comment it answers and `/RT /R` to say the
relationship is a reply; that is the specification's mechanism, which is what
Acrobat uses, so nothing proprietary and nothing remote is involved.
`src/pdf/notes.ts` writes parents before replies and resolves chains of any
depth, falling back to writing an orphan as a comment of its own rather than
losing it.

`readNotes` is the other half and the more important one: without reading the
comments a document arrived with, replying only ever works on comments made in
the same session, which is not what a thread is for. Identity is the page plus
the position in that page's annotation list, which is stable because every
build starts again from the original bytes.

What does need a server is shared review: links, tracking who has commented,
merging several people's comments. Do not confuse the two again.

## A batch is a recipe with no per-document decisions in it

`src/app/batch.ts` opens each file, applies the recipe, and zips the results.
The rule for what belongs in a recipe is that it needs no decision about a
particular page or sentence; anything else is an edit and would quietly do the
wrong thing to file forty.

Two things it does that the single-document path does not. The recogniser is
opened once for the whole run, because starting it costs tens of megabytes of
wasm and several seconds, and doing that per file is the difference between a
batch that finishes and one nobody waits for. And it rasterises offscreen
rather than through the viewer, which has no canvas here and would serialise
every document behind one queue.

Each document holds a pdf.js worker, so each is closed in a `finally`. Forty
left open is forty threads.

## A spell checker is judged on what it does not flag

The lookup is the easy part. A PDF is a poor source of prose, and the naive
version flagged 23.7% of a dense paper with every one correct: web addresses,
acronyms, surnames, and figure labels the producer drew without spaces. The
filters in `src/pdf/spell.ts` take that under 3%, and they are the feature.

Findings worth keeping:

- The word list is Webster's Second, a *headword* list: "computer" but not
  "computers", and with arbitrary holes ("box" and "has" are both absent while
  "boxwood" and "hasten" are there). Endings are stripped at lookup rather than
  the list being expanded fivefold, and the supplement covers the holes.
- A word that divides cleanly into other words is a run-together label, not a
  mistake, but only above eleven characters: below that the rule swallowed
  "docment" (doc, ment) and "definately" (define, ately).
- Suggestions must count a swap of two neighbours as one edit. Plain
  Levenshtein makes "recieve" two edits from "receive", so a cap of one throws
  away the two commonest typos there are, and suggested "relieve" instead.
- Among equally near suggestions, prefer the ones made of the same letters.
  Without that "the" came seventh for "teh", behind five substitutions.
- A capitalised word with no near match is a name. That quietens a whole
  bibliography, and a real typo almost always has a correction one edit away.

`tools/test-spell.ts` is mostly negative cases for that reason.

## Restyling is the one place the styling rule is broken on purpose

Every other path keeps a run's font, size and colour exactly as the producer
wrote them. `LineStyle` on a `LineEdit` overrides them for one line, and the
thing that has to survive is advance neutrality: Times at 18pt is not the width
Helvetica at 12 was, so `buildLineFragment`'s closing correction is what stops a
resized line pushing everything after it along. `tools/test-restyle.ts` watches
the two lines below the edited one for exactly that.

A chosen family skips coverage checking entirely, because coverage is a
question about the document's own font and that is no longer the font being
used. Only the three standard families are offered, so nothing has to be
embedded for a change of typeface.

## A watermark, a header, a footer and page numbers are one feature

They differ only in size, angle, opacity and where they sit, so
`stampEveryPage` in `src/app/model.ts` builds all four and the presets in
`main.ts` are the only difference between them. Building them separately would
have been four sets of bugs about where text lands on a page whose size is not
the one before it.

Two things live in the writer for this. Rotation goes in the *text* matrix, not
the page matrix, and is applied about the origin before the origin is moved
into place, so the words pivot on their own start rather than swinging in from
a corner; a rotation written into the page matrix would turn everything drawn
after it too. Transparency is a graphics state rather than an operator, so
faint text gets its own ExtGState inside the stamp's `q`, which is what stops
it leaking on to the rest of the page.

`behind` puts a stamp in the same back zone as an object sent to the back, so
there is one answer to what is underneath rather than two that disagree.

Cropping is a `/CropBox` on the page plan entry, alongside rotation, and is
held inside the media box because a crop box reaching outside it is invalid and
readers disagree about what to do with one. Nothing outside is deleted, which
is worth saying in the interface every time: `tools/test-crop.ts` asserts the
content stream is byte-identical after a crop.

## Every edit used to redraw the whole document

`onEdited` called `renderThumbs`, which rasterised every page in the document,
and `refresh` destroyed the pdf.js worker and started a new one. So committing
one word to one line meant: rebuild the file, boot a worker, reparse the whole
document, redraw the visible pages, and rasterise twenty-three thumbnails. On
a real document that is the second between letting go of an image and seeing
it move.

Thumbnails now draw when they scroll into view, like the pages already did, and
the worker is kept across reloads and released in `close()` when a different
document is opened. `close()` matters: without it a reused worker leaks a
thread per file opened in a session.

Not measured before and after in a browser. A Node benchmark of the same calls
is misleading here, because pdf.js runs on a fake worker there and never pays
the startup this was about.

## Grid items fall into the first free column

Twice now: hide the sidebar and panel, or position them, and the document lands
in the empty first column of `.workspace`, because absolute and `display: none`
both take an item out of the grid and auto-placement then puts the next item in
the first free cell. `.viewer-wrap` names `grid-column: 2` once, globally, so
neither the mobile drawers nor the empty-state can move it.

## A stalled render is almost always a hidden tab

pdf.js drives its canvas loop on `requestAnimationFrame`, which browsers
throttle to a standstill in a tab that is not visible. `viewer.load` awaits
`renderPage(0)`, so a hidden tab leaves the whole open stuck: the busy pill
says "Opening…" forever, no line boxes appear, and Save and Print stay
disabled because `syncEditState` is never reached.

It looks exactly like a deadlock and it is not one. Check
`document.visibilityState` before investigating anything else. This has now
cost two separate debugging sessions, one of which got as far as blaming the
production build and then a rename.

## Printing goes through the PDF, not through the page

`window.print()` on this app prints the app: toolbar, sidebar, and a canvas
cropped to the window. Cmd+P is intercepted and the built bytes are handed to
the browser's own PDF viewer in an offscreen frame.

Offscreen rather than `display: none`, because a frame that was never rendered
has nothing to print. The source is set before the frame is attached, and the
load handler ignores `about:blank` and anything after the first: a frame fires
load for the empty document it starts with too, and printing that one prints a
blank sheet, which is exactly what happened first time.

There is no way to ask a browser whether it will print a PDF from a frame, so
if nothing has printed after three seconds the document opens in a tab instead.
The `@media print` block in the stylesheet is only for a browser that prints
the page regardless of all this.

## A blank page is a plan entry from nowhere

`PagePlanEntry.doc` is `-1` (`BLANK_PAGE`) for a page that came from no file.
`build` makes it at the size of the last real page before it, so a blank page
in an A4 document is A4 rather than US Letter appearing in the middle of
something that was never letter-sized.

The affordance lives in the gaps between thumbnails rather than floating over
the document, because a gap says exactly where the page goes and a button over
a page does not: before this one, or after it? The gaps are also why the
thumbnail render loop asks for `.thumb` by class instead of indexing children.

## Clicking somewhere is intent, not an edit

Placing added text used to add an empty piece of text to the document and then
open an editor over it. A click followed by Escape left that empty text behind:
counted as an edit, sitting in the undo history, and invisible, because it had
nothing to draw. The box is now a draft held by the viewer, and `commit` adds it
only if something was typed into it. `draftInsertion` says which kind the open
editor is; `openInsertionEditor` closes any previous editor first, so it carries
the flag across that call deliberately.

Notes work the same way and had the same fault. A draft note is drawn straight
away so it is visibly there while its comment is typed, but it joins the
document only when the comment does; abandoning one rebuilds the page to take
the marker back. Editing a note that already exists still goes through
`setNoteText`, where emptying it removes it.

## The fourteen standard fonts have real metrics, so use them

A non-embedded standard font usually omits `Widths`, because every reader is
expected to already know the metrics of the fourteen fonts every reader has.
Those metrics ship with pdf-lib, in `@pdf-lib/standard-fonts`, and are already
in the bundle. `defaultStandardWidth` used to average them into a plausible
guess, which was eight per cent wide over a line of ordinary prose. Everything
measured along a line inherited that: a search hit fifteen points into the
wrong word, and the line's own recorded extent too long by the same amount.

The rough table is still there for fonts that match none of the fourteen and
carry no widths of their own, where a plausible number is all there is.

Positions within a run now come from the width of the text before them rather
than from how many characters it is, scaled to the run's drawn extent so
kerning and a justified line's stretched spaces still land where they were
drawn. `charPosition` in `content.ts` is the one implementation; the viewer had
grown a second copy.

## A locked file can be opened, not just refused

`Protect` writes documents that need a password, and until now opening one only
reported that it needed a password, with no way to give it. `openFile` takes an
optional password, a wrong one re-asks rather than starting over, and the file
is held only while the question is on screen. The password is passed to
`decryptToBytes` and never stored.

The copy saved afterwards is not locked, which is said on opening. Handing back
an unprotected file without mentioning it would be worse than useless.

## Read only means the tools are off, not just the save

A document whose page tree pdf-lib cannot read still renders through pdf.js, so
it opens and can be read. Everything that writes a PDF back out goes through
the parser that failed, so all of it fails: the `WRITERS` list in `main.ts` is
turned off together rather than left to fail one tool at a time, each in its
own words. One of them was reporting `_this.catalog.Pages is not a function` to
whoever pressed Compress.

What still works is selecting and copying text and saving a page as a picture,
both of which go through pdf.js. The notice says that and nothing more:
splitting and extracting sound like exports but rebuild the file, which is the
thing that cannot be done.

## A line can be edited off the page

Text drawn past the edge is clipped by every reader there is, so a line made
too long loses its end and looks like text that simply stopped. The edit still
applies, since refusing it would be worse than letting somebody see what they
did and undo it, but `lastOverflow` says how far over it went and the status
line says so.

Two things make that measurement honest. It measures the change rather than the
width, because a line drawn with kerning ends somewhere its glyph widths do not
predict, and adding the difference between old text and new to where the line
actually ends cancels an error that would otherwise be the whole answer. And it
counts only what the edit itself put over the edge: files exist whose text
already runs off the paper, and blaming somebody for the document they were
given is how a warning gets ignored. Both halves are checked by
`tools/test-overflow.ts`, which found 150 false alarms in the first version.

## Open work
- Reflow across paragraphs rather than within one, adding and deleting text
  blocks, replies on a note, recognising a page that mixes two scripts.
- A paragraph that shrinks leaves the blank line where it was. Closing the gap
  means moving everything below it, and a page is a fixed arrangement of things
  that are not all part of the paragraph, so this is the behaviour rather than
  a defect. It is worth revisiting only with a way to know what may move.
