# Handpress against Acrobat

What Acrobat Pro does, what Handpress does, and what it deliberately will not
do. Written to be argued with: if a row is wrong, the row is the bug.

Acrobat Pro is the comparison because Acrobat Reader does very little of this.
Reader can view, fill forms, sign, comment and search; everything else in the
editing columns is Pro only, at roughly £15 to £20 a month.

**Confidence.** The Handpress column is from this repository and its tests. The
Acrobat column is from knowledge of the product rather than from testing a
current install, so treat it as approximately right rather than audited, and
check anything you are about to rely on.

## The thing that is actually different

| | Acrobat | Handpress |
| --- | --- | --- |
| Where the document goes | Desktop app, or Adobe's servers for the web version and cloud features | Never leaves the browser tab |
| Account | Adobe ID for most of it | None |
| Price | Subscription | Free |
| Source | Closed | AGPL |
| Works offline | Desktop yes | Yes, once loaded |
| Runs on a locked-down machine | Needs an install | A URL |

## Text

| Feature | Acrobat | Handpress |
| --- | --- | --- |
| Edit existing text in place | Yes | Yes |
| Keep the document's own embedded font | Yes | Yes, including Type 3 |
| Reflow a paragraph after an edit | Yes, across the whole flow | Within a paragraph only |
| Add a text box | Yes | Yes |
| Font matching for characters the subset lacks | Yes | Yes, local fonts then a standard face |
| Change font, size, colour of existing text | Yes | No, an edit keeps the run's own styling |
| Spell check | Yes | No |
| Find and replace | Yes | Find only |

## Marking up

| Feature | Acrobat | Handpress |
| --- | --- | --- |
| Freehand pen | Yes | Yes, any width, any opacity |
| Eraser for ink | Yes | Yes, strokes only |
| Line, arrow, rectangle, oval | Yes | Yes |
| Polygon, polyline, cloud | Yes | No |
| Highlight, underline, strikethrough of text | Yes, as annotations | Highlight only, drawn onto the page |
| Sticky note comment | Yes | Yes |
| Text callout box | Yes | No |
| Reply to a comment, comment threads | Yes | No |
| Comment list, filter, summarise | Yes | No |
| Stamps | Yes, a library | Signatures only |
| Measuring tools | Yes | No |

**A real difference in kind.** Acrobat's markup is *annotations*: separate
objects a reader can hide, filter or delete, which is what makes threads and
review workflows possible. Handpress draws onto the page itself, so what is
drawn cannot be switched off, and there is nothing to reply to. Sticky notes
are the exception and are real annotations. Neither is better; they answer
different questions. Handpress is not a review tool.

## Pages

| Feature | Acrobat | Handpress |
| --- | --- | --- |
| Reorder, rotate, delete | Yes | Yes |
| Insert a blank page | Yes | Yes |
| Merge documents | Yes | Yes |
| Split | Yes | Yes, by size or by range |
| Extract | Yes | Yes |
| Crop | Yes | No |
| Headers, footers, page numbers, watermarks, Bates | Yes | No |

## Documents

| Feature | Acrobat | Handpress |
| --- | --- | --- |
| OCR a scan | Yes, many languages | Yes, eight installed, more at build time |
| Compress | Yes | Yes |
| Password protect | Yes, AES-256 | Yes, AES-256 |
| Open a password protected file | Yes | Yes |
| Permissions and restrictions | Yes, granular | Unlocks them; does not write them |
| Redact so the text is gone | Yes | Yes |
| Print | Yes | Yes |
| Fill forms | Yes | Yes |
| Create form fields | Yes | No |
| Digital signature, certificate based | Yes | Reads and warns; cannot sign |
| Drawn or typed signature | Yes | Yes |
| Export to Word, Excel, PowerPoint | Yes | No |
| Export to image | Yes | Yes, page as PNG |
| Compare two documents | Yes | No |
| Accessibility tagging and checking | Yes | No |
| PDF/A and preflight | Yes | No |
| Actions, batch processing | Yes | No |
| Cloud storage, sharing, review links | Yes | No, by design |

## Where Handpress is ahead

- Redaction that deletes rather than covers is the default and is the headline.
  The failure mode of drawing a black box over text is a recurring cause of
  real leaks, and several free tools still call that redaction.
- Nothing is uploaded, so there is no retention window, no processor, and
  nothing to put in a data protection assessment.
- No account, no install, no licence check.

## Where Acrobat is ahead, honestly

- Comment threads and review, which Handpress does not attempt.
- Export to Office formats, which is a whole reconstruction problem.
- Form creation, accessibility, preflight, Bates numbering: the professional
  publishing and compliance work.
- Reflow across a whole document rather than within one paragraph.
- It has been doing this since 1993 and has seen more broken files than this
  will ever see.

## Not planned

Cloud storage, review links, and anything that requires a server. Not because
they are hard, but because the moment a document leaves the browser the only
claim this makes stops being true.
