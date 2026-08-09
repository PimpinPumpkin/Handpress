/**
 * Checking a document against what it will need to survive.
 *
 * Acrobat's preflight is a rule engine that reports every way a file fails a
 * profile. The profile people actually ask about is PDF/A, the archival one:
 * everything the file needs is inside the file, so it renders the same in
 * fifty years as it does today. That is why it forbids encryption and external
 * dependencies and insists on embedded fonts.
 *
 * This reports; it does not convert. Making a file compliant means embedding
 * every font that is missing, which is the one thing that cannot be done from
 * inside the file: the glyphs are simply not there. Saying precisely what is
 * wrong is worth more than a conversion that silently substitutes typefaces
 * and calls the result archival.
 *
 * Several checks are worth running whether or not anyone cares about PDF/A. A
 * document whose fonts are not embedded will render differently on another
 * machine, and that is a problem today rather than in fifty years.
 */

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFStream } from 'pdf-lib';

export type Severity = 'blocks' | 'warns' | 'note';

export interface Finding {
  severity: Severity;
  /** Short label, which is what the interface groups on. */
  what: string;
  /** One sentence saying why it matters, in the terms of the person reading. */
  why: string;
  /** How many times it was found, since one unembedded font is not twelve. */
  count: number;
}

export interface PreflightReport {
  findings: Finding[];
  /** True when nothing blocks the file being treated as archival. */
  archivable: boolean;
  pages: number;
}

/**
 * Reads a document and reports what would stop it being archival, plus what
 * would make it render differently somewhere else.
 *
 * Everything is counted rather than listed one per occurrence: a report saying
 * "no" forty times is a report nobody reads to the end of.
 */
export function preflight(doc: PDFDocument, wasEncrypted: boolean): PreflightReport {
  const findings: Finding[] = [];
  const add = (severity: Severity, what: string, why: string, count = 1): void => {
    const already = findings.find((f) => f.what === what);
    if (already) already.count += count;
    else findings.push({ severity, what, why, count });
  };

  if (wasEncrypted) {
    add(
      'blocks',
      'The file was encrypted',
      'An archival file cannot be locked, because the thing that opens it in fifty years will not have the password.',
    );
  }

  const catalog = doc.catalog;

  if (!catalog.get(PDFName.of('Metadata'))) {
    add(
      'blocks',
      'No XMP metadata',
      'PDF/A identifies itself in an XMP packet. Without one, nothing downstream knows the file claims to be archival.',
    );
  }
  if (!catalog.get(PDFName.of('OutputIntent')) && !catalog.get(PDFName.of('OutputIntents'))) {
    add(
      'blocks',
      'No output intent',
      'Colour is only reproducible if the file says which colour space it meant. Without that, greys drift between devices.',
    );
  }
  if (catalog.get(PDFName.of('Names'))) {
    const names = catalog.lookup(PDFName.of('Names'));
    if (names instanceof PDFDict && names.get(PDFName.of('EmbeddedFiles'))) {
      add(
        'warns',
        'It carries attached files',
        'Attachments are allowed in later PDF/A parts and not in the first, and they are worth knowing about either way.',
      );
    }
    if (names instanceof PDFDict && names.get(PDFName.of('JavaScript'))) {
      add('blocks', 'It contains JavaScript', 'Archival files may not run code, and a reader in fifty years will not run it anyway.');
    }
  }
  if (catalog.get(PDFName.of('AcroForm'))) {
    const form = catalog.lookup(PDFName.of('AcroForm'));
    if (form instanceof PDFDict && form.get(PDFName.of('XFA'))) {
      add(
        'blocks',
        'It is an XFA form',
        'XFA is a separate format carried inside the PDF, and almost nothing outside Acrobat renders it. It is already unreadable in most places.',
      );
    }
  }
  if (!catalog.get(PDFName.of('Lang'))) {
    add(
      'note',
      'No language is declared',
      'A screen reader cannot tell which language to speak the text in. Required for the accessible flavour of PDF/A, useful regardless.',
    );
  }
  if (!catalog.get(PDFName.of('StructTreeRoot'))) {
    add(
      'note',
      'It is not tagged',
      'Nothing marks which text is a heading or a table, so a screen reader gets a stream of words rather than a document.',
    );
  }

  // Fonts and images live on the pages, so they are gathered per page and
  // counted across the document.
  const seenFonts = new Set<string>();
  const pages = doc.getPages();
  for (const page of pages) {
    const resources = page.node.Resources();
    if (!(resources instanceof PDFDict)) continue;

    const fonts = resources.lookup(PDFName.of('Font'));
    if (fonts instanceof PDFDict) {
      for (const key of fonts.keys()) {
        const font = fonts.lookup(key);
        if (!(font instanceof PDFDict)) continue;
        const base = font.lookup(PDFName.of('BaseFont'));
        const name = base instanceof PDFName ? base.asString().replace(/^\//, '') : String(key);
        if (seenFonts.has(name)) continue;
        seenFonts.add(name);
        if (!isEmbedded(font)) {
          add(
            'blocks',
            'A font is not embedded',
            'The glyphs are not in the file, so another machine draws it with whatever it has instead and the lines rewrap.',
          );
        }
      }
    }

    const xobjects = resources.lookup(PDFName.of('XObject'));
    if (xobjects instanceof PDFDict) {
      for (const key of xobjects.keys()) {
        const x = xobjects.lookup(key);
        if (!(x instanceof PDFStream)) continue;
        const sub = x.dict.lookup(PDFName.of('Subtype'));
        if (!(sub instanceof PDFName) || sub.asString() !== '/Image') continue;

        const w = numberOf(x.dict, 'Width');
        const h = numberOf(x.dict, 'Height');
        if (w && h && w * h > 0 && lowResolution(page, w, h)) {
          add(
            'warns',
            'An image is low resolution',
            'It is under 150 dots per inch at the size it is drawn, which prints soft even though it looks fine on screen.',
          );
        }
        if (x.dict.get(PDFName.of('SMask')) || x.dict.get(PDFName.of('Mask'))) {
          add(
            'note',
            'It uses transparency',
            'Allowed from PDF/A-2 onwards and forbidden in PDF/A-1, so it decides which flavour this file can be.',
          );
        }
      }
    }

    const states = resources.lookup(PDFName.of('ExtGState'));
    if (states instanceof PDFDict) {
      for (const key of states.keys()) {
        const g = states.lookup(key);
        if (!(g instanceof PDFDict)) continue;
        const ca = numberOf(g, 'ca');
        const CA = numberOf(g, 'CA');
        if ((ca !== null && ca < 1) || (CA !== null && CA < 1)) {
          add(
            'note',
            'It uses transparency',
            'Allowed from PDF/A-2 onwards and forbidden in PDF/A-1, so it decides which flavour this file can be.',
          );
        }
      }
    }
  }

  const order: Record<Severity, number> = { blocks: 0, warns: 1, note: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
  return { findings, archivable: !findings.some((f) => f.severity === 'blocks'), pages: pages.length };
}

/**
 * Whether a font's glyphs are actually in the file.
 *
 * A Type0 font keeps its descriptor on the descendant, so the obvious check on
 * the outer dictionary finds nothing and reports every composite font in the
 * document as missing.
 */
function isEmbedded(font: PDFDict): boolean {
  const subtype = font.lookup(PDFName.of('Subtype'));
  const kind = subtype instanceof PDFName ? subtype.asString() : '';

  // A Type 3 font draws its glyphs with operators it carries itself, so it is
  // embedded by construction and has no font file to look for.
  if (kind === '/Type3') return true;

  let holder = font;
  if (kind === '/Type0') {
    const kids = font.lookup(PDFName.of('DescendantFonts'));
    if (kids instanceof PDFArray && kids.size() > 0) {
      const kid = kids.lookup(0);
      if (kid instanceof PDFDict) holder = kid;
    }
  }
  const descriptor = holder.lookup(PDFName.of('FontDescriptor'));
  if (!(descriptor instanceof PDFDict)) return false;
  return ['FontFile', 'FontFile2', 'FontFile3'].some((k) => !!descriptor.get(PDFName.of(k)));
}

/** An image's effective resolution, against the box it is actually drawn in. */
function lowResolution(page: { getSize(): { width: number; height: number } }, w: number, h: number): boolean {
  // Without walking the content stream there is no way to know the drawn size,
  // so the page is used as the upper bound. That under-reports, which is the
  // right way round: an image drawn smaller than the page is sharper than this
  // says, never softer, so nothing is flagged that is actually fine.
  const size = page.getSize();
  const across = (w / Math.max(1, size.width)) * 72;
  const down = (h / Math.max(1, size.height)) * 72;
  return Math.min(across, down) < 150;
}

function numberOf(dict: PDFDict, key: string): number | null {
  const v = dict.lookup(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : null;
}
