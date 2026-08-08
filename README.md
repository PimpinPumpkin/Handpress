# Vellum

A PDF text editor that runs entirely in the browser. Open a PDF, click a line of
text, retype it, save. There is no server, no upload and no account.

The gap this fills: plenty of free web tools will merge, split, rotate or
annotate a PDF, but almost none will let you edit the text that is already in
the file. The ones that do are either desktop apps or put a daily cap on it.

## How it works

Editing existing PDF text is harder than it looks, and most of Vellum is about
the two problems that make it hard.

### Finding the text

A PDF does not store paragraphs. It stores drawing instructions: set a font, set
a position, show these character codes. Vellum tokenises the page content stream
and replays the graphics and text state machines, so it knows where every run of
text lands on the page and, crucially, the exact byte range of the operator that
drew it. Editing then becomes a precise splice of the original stream rather than
a search and replace on something that was never text to begin with.

Text inside form XObjects is walked too, so headers, footers and stamped content
are editable.

### Writing it back

Two rules keep documents intact.

**Every replacement is advance neutral.** When a line is rewritten, the operator
carrying its text is replaced with the new text plus a correction offset, so the
text matrix ends up exactly where the original left it. Any other operator on
that line is replaced by a positioning offset equal to the advance it used to
produce. Nothing downstream in the stream shifts, which is what allows one line
to change without moving the rest of the page. Positioning, font and colour
operators are never touched.

**Fonts are checked per character before anything is written.** Embedded fonts
are nearly always subset to only the glyphs the document actually uses, so the
letter you just typed may genuinely not exist in the file. Vellum inverts the
font's ToUnicode CMap to get both a Unicode to character-code encoder and an
honest test of what the subset can draw. Characters the font has are written with
the document's own font. Characters it lacks are drawn with a substitute,
and only those characters, so one unusual letter never restyles the text around
it. The properties panel says when this happened.

For the substitute, Vellum prefers the real typeface. Press **Match fonts** and
it will look up the document's font by name among the ones installed on your
computer, and embed a subset of the genuine face rather than a lookalike. That
uses the Local Font Access API, so it is Chromium only and asks permission the
first time, because listing installed fonts is a fingerprinting signal. Decline
it, or use another browser, and substitutions fall back to a style-matched
standard font. Font data is read and embedded locally either way; nothing is
sent anywhere.

Some other details that turned out to matter:

- A space needs no glyph, only an advance. Fonts with no space glyph get a
  positioning offset instead, sized from the gaps measured in the document.
- Ligatures decode to several characters but are drawn by one glyph, so encoding
  matches greedily and longest-first.
- Word gaps written as offsets inside a `TJ` array are recovered as spaces, which
  many producers rely on instead of drawing spaces.
- A space is often drawn by an operator of its own, so operators that draw only
  whitespace are kept rather than filtered out. Dropping them welds the words on
  either side together.
- Font size may legally be negative, which flips the glyphs and makes text
  advance backwards. Positions are therefore measured along the direction text
  actually flows rather than along the page's x axis, which also makes rotated
  and sideways text work.
- Outlined and shadowed type is drawn in more than one pass over the same spot.
  Those passes are presented as one line and all of them receive the edit, or the
  old wording shows through from underneath.
- Lines whose font has no trustworthy character mapping are marked read only.
  Showing confident but wrong text and letting you edit it would corrupt the page.

### What you see is what you get

After each edit the page is rebuilt from the original file and re-rendered from
the resulting PDF. The canvas is never an approximation of the output; it is the
output. Edits are stored as a list against the original bytes and replayed on
every build, which keeps undo exact and saving reproducible.

### Redacting

Drag over text and those characters are removed from the file, with a black bar
painted over the region. The gap they leave is the same width as the text was,
so the words either side of a deleted name stay exactly where they were.

This is the real thing, not a rectangle. The test for it saves the file, reads
the bytes back and asserts the removed text can no longer be extracted, which is
the property that actually matters and the one the category most often fails.

### Erasing

Drag over anything to cover it. The fill colour is sampled from a ring around
the region rather than just above and below it, because a patch inside a tinted
panel has white paper above it and panel colour beside it, and picking the wrong
one leaves an obvious scar.

**This hides text rather than deleting it.** The characters underneath are still
in the file and can still be selected and copied out. That is why it is called
erase and not redaction, and the interface says so every time you use it. Real
redaction, which removes the operators that drew the text, is a separate job
still to be done.

### Notes

Click anywhere in note mode and type a comment. It is attached as a real `/Text`
annotation, which is what every other reader already understands: Acrobat,
Preview and the browser viewers show it as a note icon that opens the comment,
and a reviewer can reply to it. Drawing the words onto the page instead would
look similar and be useless, because nothing downstream would know it was a
comment rather than part of the document.

Notes drag to reposition, reopen for editing, and delete. Emptying the comment
removes the note, which is the only sensible reading of a note with nothing in
it. The marker Vellum draws stands in for the icon a reader will draw; the page
itself is not touched.

### Highlighting

Drag over anything to mark it. The colour is painted with a multiply blend, which
is what makes it read as a highlighter rather than a sticker: the words show
through the ink instead of being covered by it. The colour swatch beside the
button changes it, and a highlight is undone like any other edit.

### Reading a scan

**Read scan** finds every page that is a picture rather than text, runs
recognition on each, and writes what it finds back as invisible text sitting
exactly over the picture. The pages look identical, but their words can now be
searched, selected, copied and edited like any other text. Pages that already
have text are left alone, and a page that has been read once is not read again.

Each word is stretched horizontally to the width it occupies in the image, so a
selection follows the printed words instead of drifting further out of step along
the line. Words the recogniser is not reasonably sure of are left out rather than
written down wrong.

Recognition runs on this machine, in a worker; the page is never uploaded. The
recogniser itself and its language data are fetched from a CDN the first time
they are needed, so the first run on a new browser takes a few seconds longer.
One recogniser is started for the whole document rather than one per page,
because starting it costs more than reading a page does.

### Finding text

Cmd+F, or the box in the toolbar. Every hit is highlighted at once, Enter and
Shift+Enter step through them, and the count shows where you are.

Search runs against the text as it currently reads rather than as the file was
opened, so a word typed a moment ago is findable and one typed out is not. Text
added to a page is searched too, which is what makes a recognised scan findable
at all. A hit
is placed by walking the line's styled runs and interpolating within whichever
ones it covers; a line that mixes a bold label with body text is not evenly
spaced, so interpolating across the whole line would put the highlight in the
wrong place.

### Page operations

Pages can be rotated, deleted and reordered from the thumbnail rail, by dragging
one thumbnail onto another. **Add pages** appends the pages of other PDFs, and
**Extract** saves a range such as `1-3, 7, 10-` as a new file while leaving the
open document untouched.

A merged page is simply a plan entry naming a different source file, so pages
that arrived from elsewhere reorder, rotate and undo exactly like the rest.

These are held as a plan against the original document rather than applied as
they are made. That matters because every other edit is addressed by a page's
position in the original file, so rebuilding the page list eagerly would move
the ground out from under them. The plan is applied last, after all content
edits, and undoes like anything else.

### Moving things

Text and images already in the document can be dragged to a new place, as can
text you added and any signature you placed. Images can also be resized from a
corner handle or removed outright. A short threshold separates a drag from a click,
so a line still opens for editing when you simply click it.

Moving an existing line does not rewrite the line matrix, which would drag every
following line along with it. The move is expressed as text rise for the
perpendicular component and a positioning offset for the component along the
line, both of which are local to that one run. A line lands exactly where it was
dropped and nothing else on the page moves at all.

An image is placed entirely by its transformation matrix, so moving one means
composing a translation into that matrix. The shift wanted is in page space
while a matrix inserted there applies in the space the matrix maps from, so it
is carried back through the inverse of the matrix's linear part. Skipping that
step sends images on rotated or scaled pages off in the wrong direction.

### Images in and out

Drop a picture on the window and it becomes a PDF: one page, the size of the
image, so nothing is cropped to a paper size nobody asked for. Drop several and
they become one document, a page each, in the order they were dropped. Once it
is a page, every other tool here applies to it, recognition included.

**Page as image** goes the other way, writing the page on screen out as a PNG at
twice its size, which is about 150 dots per inch: sharp enough to read and to
print small, without producing a file nobody can email.

### Selecting and copying

A canvas has no text in it, so a rendered page cannot be selected or copied out,
which is the first thing most people try. The **Select** tool lays an invisible
copy of the page's words over the canvas at their real positions, so the browser
does the selecting, the copying and the reading aloud, and all of it agrees with
what is drawn.

Each line is scaled horizontally to cover exactly the width it was drawn at. The
browser is laying the text out in a substitute face at a slightly different
width, and without that correction the highlight drifts further from the words
with every character. Line breaks are real elements, because absolutely
positioned spans are otherwise all one line as far as a copy is concerned.

### Reflow

Editing one line of a paragraph and leaving the rest where they were is what
makes most PDF editors feel like patching rather than writing: delete a word and
the line ends early, add a sentence and it runs off the column. Vellum treats the
lines a paragraph is made of as one piece of text, re-breaks it from the edited
line onwards, and writes each line back.

The lines above the edit are left alone. They wrapped correctly and nobody
changed them, so rewriting them would move text the user did not touch.

Wrapping is measured with the document's own font, and the column edge is worked
out from the paragraph's own breaks: every wrapped line says the column reached
at least that far, and that the next line's first word did not fit. Re-breaking a
paragraph's own words reproduces its own lines on 203 of 203 paragraphs found
across the pdf.js corpus.

What it will not do is make room. Text that needs a line the paragraph does not
have is refused, because finding that line would mean pushing the rest of the
page down. Paragraph detection is deliberately conservative: same font and size,
an even rhythm of baselines, a shared left edge, and a column wide enough to be
prose rather than a list of names. Anything less certain is edited a line at a
time, exactly as before.

### Adding text

Text can also be added where the page had none. It is written as real text with
a standard font at the chosen size and colour, not as an annotation stuck on
top, so it copies, searches and prints like the rest of the document.

It can be placed anywhere, including over text the page already has. That is
where a signature usually belongs, on the printed line that asks for it.

### Filling forms

A fillable PDF already knows where its boxes are, what they are called and what
belongs in them, so those fields are offered as real controls rather than as
free text. Text boxes honour their length limits, tick boxes toggle, dropdowns
and radio groups offer their own options, and fields the form marks read-only
are left alone.

The value goes into the field itself, not on top of it, so whoever sent the form
can read the answers back. Each field's appearance stream is regenerated on save,
which is the step most tools skip and the reason filled forms so often open
blank somewhere else.

### Signing

A signature can be drawn with a mouse, pen or finger, or taken from a photograph
of one on paper. Either way it is trimmed to the ink and given a transparent
background, so what lands on the page is the handwriting rather than a white box.

It is drawn into the page content rather than attached as an annotation, which
means it is flattened from the start: a reader cannot drag it off or delete it,
and it survives printing and any later flattening.

This is signing in the everyday sense of putting your name on a form. It is not
an e-signature service, and it makes no claim to be. There is no audit trail, no
identity check and no certificate, because all of those need a server and a
trusted third party.

### Signed documents

Editing a signed PDF invalidates its signature, and saving rewrites the file,
which discards the incremental update history a signature depends on. That is
unavoidable for an editor, so signed documents are flagged on open with the name
the file claims, and again when saving. Nothing is verified cryptographically;
the wording says as much.

### Permission-locked files

Most "protected" PDFs are not password protected at all. They carry an owner
password restricting printing or editing while the user password is empty, which
is why any viewer opens them without asking. Vellum unlocks those on the way in
and the copy you save is not locked.

Decryption has to happen before parsing rather than after. Objects stored inside
object streams are extracted while the document is read, and a parser handed
ciphertext extracts nonsense that cannot be repaired later, because the container
it came from is consumed in the process. So the file is decrypted at the byte
level first, and everything downstream sees an ordinary document. All four
handler families are covered: RC4 40 and 128 bit, AES-128 and AES-256.

A file that genuinely needs a password still needs one, and says so.

## Limitations

- **Scanned PDFs have no text to edit** until they are read. Vellum detects this
  and says so rather than showing an empty page, and **Read scan** adds the text
  layer a page at a time.
- Editing existing text is line at a time, with no reflow across lines.
- Text drawn with Type 3 fonts is read only.

## Running it

```bash
npm install
npm run dev
```

Build a static bundle with `npm run build`, then check it with `npm run preview`.
The output in `dist` is plain files with no backend, so it can be dropped on any
static host.

CI typechecks and builds every push and uploads `dist` as a workflow artifact.
It does not publish anywhere: GitHub Pages is not available for private repos on
the free plan. To get a live URL, either make the repo public and add a Pages
workflow, or point Cloudflare Pages or Netlify at it with build command
`npm run build` and output directory `dist`.

## Tests

The PDF engine is tested headlessly against a folder of real PDFs, which matters
far more than synthetic fixtures: the failure modes here come from the variety of
real producers.

### Where it stands

Measured across roughly 3,900 PDFs from three sources: a local folder of
everyday documents, the Mozilla pdf.js regression corpus (974 files, real-world
edge cases attached to real bugs) and the veraPDF corpus (2,907 files, systematic
specification tests).

Edit round trips over everyday documents: 48 of 48 attempted, including four
permission-locked files that are unlocked first.

| Corpus | Text-bearing files | At least 99% editable in place |
| --- | --- | --- |
| Everyday documents | 47 | 47 (100%) |
| pdf.js regression corpus | 500 | 492 (98%) |
| veraPDF corpus | 747 | 747 (100%) |

Of 97 documents in the pdf.js corpus carrying interactive forms, 89 fill and read
back correctly, covering text, tick box, radio, dropdown and list fields.

Text extraction sits at a median 0% deviation from pdf.js across the pdf.js
corpus. Edit round trips pass 246 of 258 attempted there, and 11 of the 12
remaining are deliberately corrupted files that now degrade to "nothing to edit
here" rather than failing. The twelfth is a form whose line grouping shifts by
one when two elements sit a single point apart vertically; it changes what counts
as a line, not what the file contains.

That corpus paid for itself. It is where the backwards-text, dropped-space and
ghost-outline bugs below came from, none of which appear in ordinary documents.

Worth being clear that no PDF equivalent of Acid3 exists. veraPDF and Isartor
test validators against PDF/A, not editing fidelity. The closest thing to a
compliance score for this kind of tool is the round-trip test below: change a
line, save, reload, and assert that every other line is identical in text and
position to a hundredth of a point.

```bash
# Text extraction and per-font editability, compared against pdf.js
npx tsx tools/test-engine.ts --list /path/to/pdf-list.txt

# Edit one line, save, reload, verify the edit landed and nothing else moved
npx tsx tools/test-edit.ts --list /path/to/pdf-list.txt

# Several edits on one page at once
npx tsx tools/test-multi.ts --list /path/to/pdf-list.txt
```

Each takes either a list file with one path per line, or paths as arguments. Set
`ANON=1` to label documents by index instead of filename, which matters when the
corpus is someone's own documents.

Good corpora to point them at, all free:

- [pdf-association/pdf-corpora](https://github.com/pdf-association/pdf-corpora),
  an index of the rest, and the right starting point.
- [Mozilla pdf.js test files](https://github.com/mozilla/pdf.js/tree/master/test/pdfs),
  the highest value per megabyte: every file is attached to a real bug.
- [veraPDF corpus](https://github.com/veraPDF/veraPDF-corpus) and the
  [Isartor suite](https://pdfa.org/resource/isartor-test-suite/) for systematic
  specification violations.
- [Ghent Workgroup suites](https://www.gwg.org/workflow-tools-downloads/test-suites/)
  for font and prepress stress.
- [GovDocs1](https://digitalcorpora.org/corpora/files) and the Common Crawl PDF
  sets for producer variety at scale.

## Licence

Private project. pdf.js is Apache 2.0 and pdf-lib is MIT.
