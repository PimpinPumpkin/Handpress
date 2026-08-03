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
- Lines whose font has no trustworthy character mapping are marked read only.
  Showing confident but wrong text and letting you edit it would corrupt the page.

### What you see is what you get

After each edit the page is rebuilt from the original file and re-rendered from
the resulting PDF. The canvas is never an approximation of the output; it is the
output. Edits are stored as a list against the original bytes and replayed on
every build, which keeps undo exact and saving reproducible.

## Limitations

- **Encrypted PDFs are not supported yet.** This includes permission-locked files
  that open without a password, which are common for statements and forms.
- **Scanned PDFs have no text to edit.** They need OCR first. Vellum detects this
  and says so rather than showing an empty page.
- Editing is line at a time. There is no reflow across lines, and no adding or
  deleting text boxes yet.
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

| Corpus | Text-bearing files | At least 99% editable in place |
| --- | --- | --- |
| Everyday documents | 47 | 47 (100%) |
| pdf.js regression corpus | 500 | 492 (98%) |
| veraPDF corpus | 747 | 747 (100%) |

Text extraction sits at a median 0% deviation from pdf.js across the pdf.js
corpus. Edit round trips pass 241 of 258 attempted on that corpus; most of the
remainder are deliberately corrupted files, which now degrade to "nothing to
edit here" rather than failing.

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
