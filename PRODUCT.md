# Product notes

Working file for decisions, open questions and things already ruled out. The
point of the last section is so we stop relitigating ideas we already thought
through and rejected for a reason.

Codebase notes live in CLAUDE.md. This file is about what to build and why.

---

## Positioning

A free, unlimited, browser-only PDF text editor. The wedge is that competitors
meter their free tiers because every operation costs them server CPU, and we have
no server, so we can be unlimited free at any scale and they structurally cannot
match it.

Primary audience is the casual editor who needs to fix a typo in a PDF a few
times a year. Not businesses, not compliance buyers. That decision is deliberate
and is revisited below.

---

## Decisions

| Date | Decision | Why |
| --- | --- | --- |
| 2026-08-03 | Everything runs client side, no upload, no account | It is the differentiator, the cost model and the privacy claim all at once. Anything that breaks it needs a very good reason. |
| 2026-08-03 | Output is rebuilt from the original file plus an edit list, every time | Makes undo exact and saving reproducible. |
| 2026-08-03 | Private repo for now | Open sourcing is still open, see below. |
| 2026-08-03 | No GitHub Pages | Not offered for private repos on the free plan, confirmed HTTP 422. CI builds and uploads the site as an artifact instead. |
| 2026-08-03 | Free with ads, plus a cheap ad-free tier | Matches what the audience expects from this category. |
| 2026-08-03 | No document storage as a paid feature | Contradicts the privacy claim, adds recurring cost, and makes us custodian of other people's medical and legal files. Gate OCR instead, which genuinely costs money to run. |
| 2026-08-03 | Self-signing yes, e-signature service no | Placing your own signature is client side and useful. Requesting signatures from others means audit trails, email, retention and SOC 2, which destroys the architecture and enters a funded market. |
| 2026-08-03 | Not targeting compliance buyers as the primary market | Owner does not have the domain knowledge or the appetite for that sales motion. Building for a customer you do not understand is a known failure mode. |

---

## Open questions

- **Name.** `Vellum` is too close to `Vela`. `Overtype` was the favourite until we
  found an actively promoted open source [OverType markdown editor](https://overtype.dev/)
  with the .dev domain and a Show HN behind it. Too close, in adjacent
  territory, and it would outrank us. Needs another pass with a bulk domain
  search rather than one at a time. Available from what we checked:
  `emendpdf.com`, `getovertype.com`, `overtype.net`. Neither is good enough yet.
- **Open source or not.** Argument for: the whole claim is "nothing is uploaded",
  and that is far more credible when anyone can read the code. Also gets other
  people fixing format edge cases, which matters for PDF specifically. Argument
  against: trivially forkable. Fork risk is low in an ad model because a fork does
  not inherit the traffic. Leaning yes, possibly engine open and app shell closed.
- **Whether direct monetisation is even the right frame.** See the note on
  business model below; the tool may be worth more as a credibility artifact than
  as an ad unit.

---

## Backlog

### Done

- Signed document detection and warning. A banner names the signer and the save
  message repeats it. Certification signatures are called out separately since
  those break on any change at all.
- Adding text. Click anywhere in Add text mode, type, and it is written into the
  page as real text with a standard font, chosen size and colour. Multi-line with
  normal leading. Verified to place exactly and shift nothing already on the page.

- Self-signing. Draw a signature or use a photograph of one, place it on the
  page, and it is flattened into the content stream as a real image rather than
  an annotation. Paper backgrounds are turned transparent so the page shows
  through the strokes.

- Filling interactive form fields. Fillable PDFs show their real fields as real
  controls: text boxes honour length limits, tick boxes toggle, dropdowns and
  radio groups offer their own options, and read-only fields are left alone.
  Values are written through the field itself rather than painted over the top,
  and appearance streams are regenerated so the result is not blank elsewhere.

- Dragging to reposition. Existing lines of text, added text and placed images
  can all be dragged. An existing line moves by text rise and a positioning
  offset rather than by rewriting the line matrix, so every following line stays
  exactly where the producer put it.

### Now

- Dragging images that were already in the document. Needs the walker to record
  image draws, which it does not yet do.
- OCR for scanned documents.

### Next

- Font matching ladder: look the document's font up by name, then verify the
  candidate by comparing outlines against the glyphs the embedded subset already
  contains. That verification step is what makes it objective rather than a
  guess, and it needs no OCR because typed PDFs tell us the font name outright.
- Landing pages targeting intent phrases. Ranking comes from page content, not
  from the brand name, so this is the actual growth work.

### Later

- Real redaction that removes the underlying characters rather than drawing a
  black box. Our engine is unusually suited to it and the category botches it
  constantly. Parked because it points at the professional market.
- Document comparison, batch operations, metadata scrubbing, Bates numbering.
  All feasible, all pointed at professional users.
- Offline PWA.

---

## Business model notes

Ad revenue is roughly $2 to $8 per thousand pageviews for a utility tool, with
PDF keywords at the better end because Adobe and DocuSign bid on that space. So
$2,000 a month needs somewhere around 300k to 800k pageviews a month.

The outcome distribution is heavily skewed and mostly determined by discovery,
not by quality:

- Most likely: never cracks search, tens to low hundreds of dollars a month.
- Decent: one keyword or one front page moment, several hundred to $1,500.
- Good: owns a couple of intent phrases, low thousands upward.

Carrying cost is roughly a domain plus nothing, since static hosting is free at
this scale, which is what justifies building it even at a low probability of the
good outcome.

**The number that matters most.** An ad impression is worth about $0.004. A paid
service job is worth $50 to $500. One customer of a paid niche service is worth
somewhere between twelve thousand and a hundred and twenty thousand pageviews
here. PDF editing has vastly more demand than any niche service, and still loses
on expected revenue, because free plus ads monetises about four orders of
magnitude worse per user. Business model dominates market size at this scale.
Worth remembering before assuming the bigger market is the better business.

---

## Promotion plan

Owner intends to contact Linux publications, relevant subreddits and Hacker News.

Honest weighting: Hacker News and Reddit are spikes, not traffic. They are worth
doing for the initial credibility and backlinks, not for sustained users. Linux
publications are a weaker fit than they appear, because that audience already
uses open tooling, blocks ads at a high rate, and is the least monetisable
segment available. They are still worth it for backlinks.

Sustained traffic is search, and search here means landing pages that answer the
exact question someone typed. That is the unglamorous work that decides whether
this makes money.

---

## Ruled out, with reasons

Kept so we do not rediscover these.

- **Document storage as the premium feature.** Contradicts the privacy claim,
  adds recurring cost, creates breach liability and GDPR obligations.
- **E-signature as a DocuSign competitor.** The product is the audit trail, not
  the drawing. Needs a server, email, retention and eventually SOC 2. Free does
  not work as a wedge there because the marginal cost is real, so giving it away
  bleeds money rather than costing nothing.
- **Compliance and legal market as the primary target.** Genuinely a good fit for
  the architecture, and a real willingness to pay, but it is a different sales
  motion and the owner is not that buyer. Revisit only as a productised offering,
  never as consulting.
- **A generic descriptive name like WebPDF.** Cannot rank for it, cannot own it,
  and trademark risk. Brand should be memorable; the SEO comes from page content.

---

## Adjacent idea, parked

Becoming a healthcare compliance consultant and using free tools as the
differentiator. Real market, high margin, and the client side architecture is a
genuine demonstrable story for it.

The catch is that it is a services business: time for money, does not scale,
needs sales and references, and carries advisory liability that wants insurance.
Tools are a nice slide in a pitch, not why anyone picks a compliance consultant.
It is also a completely different daily job from building software.

If this ever gets picked up, the version worth doing is productised rather than
consulting: sell an offline, nothing-leaves-your-network document suite to small
practices at a flat annual price. Keeps it a product business.
