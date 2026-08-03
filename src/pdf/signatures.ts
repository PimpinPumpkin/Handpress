/**
 * Digital signature detection.
 *
 * Editing a signed PDF invalidates its signature, and saving rewrites the file
 * wholesale, which discards the incremental update history a signature depends
 * on. That is unavoidable for an editor, but doing it silently is not
 * acceptable: somebody could send out a contract believing it still carries a
 * valid signature when it no longer does.
 *
 * This only reads what the document declares about itself. It does not verify
 * anything cryptographically, so a name found here is a claim by the file, not
 * proof of who signed it. The UI wording needs to reflect that.
 */

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFString, PDFHexString } from 'pdf-lib';

export interface SignatureInfo {
  /** Name the signature dictionary claims, unverified. */
  name: string | null;
  reason: string | null;
  location: string | null;
  /** Signing time as the document states it. */
  signedAt: string | null;
  /**
   * True when this is a certification signature restricting what may change.
   * Those documents assert that any modification at all breaks them.
   */
  certification: boolean;
  /** Permitted changes for a certification signature: 1 none, 2 forms, 3 forms and annotations. */
  permittedChanges: number | null;
}

export interface SignatureReport {
  signatures: SignatureInfo[];
  /** Signature fields that exist but have not been signed. Harmless to edit. */
  emptyFields: number;
}

/**
 * Reads a text string, preferring UTF-8 when that is what the bytes actually are.
 *
 * PDF's own text encodings are UTF-16BE with a byte order mark, or PDFDocEncoding
 * otherwise. Plenty of producers write UTF-8 regardless, which PDFDocEncoding
 * turns into mojibake, so an unmarked string is decoded as UTF-8 when it is valid
 * UTF-8 and actually uses the high range. Pure ASCII decodes the same either way.
 */
function textOf(value: unknown): string | null {
  if (!(value instanceof PDFString || value instanceof PDFHexString)) return null;

  let text = value.decodeText();

  const bytes = value.asBytes();
  const hasBom = bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff;
  const hasHighBytes = bytes.some((b) => b >= 0x80);
  if (!hasBom && hasHighBytes) {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      // Not valid UTF-8, so the original decoding stands.
    }
  }

  const trimmed = text.trim();
  return trimmed.length ? trimmed : null;
}

/** Turns a PDF date such as `D:20240115103000+01'00'` into something readable. */
function readDate(value: unknown): string | null {
  const raw = textOf(value);
  if (!raw) return null;
  const m = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(raw);
  if (!m) return raw;
  const [, y, mo, d, h, min] = m;
  if (!mo || !d) return y;
  const date = `${y}-${mo}-${d}`;
  return h && min ? `${date} ${h}:${min}` : date;
}

function collectFields(fields: PDFArray, out: PDFDict[], depth = 0): void {
  if (depth > 12) return; // guard against a malformed cyclic field tree
  for (let i = 0; i < fields.size(); i++) {
    const field = fields.lookup(i);
    if (!(field instanceof PDFDict)) continue;
    out.push(field);
    const kids = field.lookup(PDFName.of('Kids'));
    if (kids instanceof PDFArray) collectFields(kids, out, depth + 1);
  }
}

/** Reads what a document declares about its own signatures. */
export function findSignatures(doc: PDFDocument): SignatureReport {
  const report: SignatureReport = { signatures: [], emptyFields: 0 };

  let certificationPerms: number | null = null;
  try {
    const perms = doc.catalog.lookup(PDFName.of('Perms'));
    if (perms instanceof PDFDict) {
      const docMDP = perms.lookup(PDFName.of('DocMDP'));
      if (docMDP instanceof PDFDict) {
        certificationPerms = 2;
        const refs = docMDP.lookup(PDFName.of('Reference'));
        if (refs instanceof PDFArray && refs.size() > 0) {
          const ref0 = refs.lookup(0);
          if (ref0 instanceof PDFDict) {
            const params = ref0.lookup(PDFName.of('TransformParams'));
            if (params instanceof PDFDict) {
              const p = params.lookup(PDFName.of('P'));
              if (p instanceof PDFNumber) certificationPerms = p.asNumber();
            }
          }
        }
      }
    }
  } catch {
    // A document that will not answer is treated as unsigned.
  }

  try {
    const acroForm = doc.catalog.lookup(PDFName.of('AcroForm'));
    if (!(acroForm instanceof PDFDict)) {
      return report;
    }
    const fields = acroForm.lookup(PDFName.of('Fields'));
    if (!(fields instanceof PDFArray)) return report;

    const all: PDFDict[] = [];
    collectFields(fields, all);

    for (const field of all) {
      const type = field.lookup(PDFName.of('FT'));
      if (!(type instanceof PDFName) || type.asString().replace(/^\//, '') !== 'Sig') continue;

      const value = field.lookup(PDFName.of('V'));
      if (!(value instanceof PDFDict)) {
        report.emptyFields++;
        continue;
      }

      report.signatures.push({
        name: textOf(value.lookup(PDFName.of('Name'))),
        reason: textOf(value.lookup(PDFName.of('Reason'))),
        location: textOf(value.lookup(PDFName.of('Location'))),
        signedAt: readDate(value.lookup(PDFName.of('M'))),
        certification: certificationPerms !== null,
        permittedChanges: certificationPerms,
      });
    }
  } catch {
    // Leave the report as it stands rather than blocking the document.
  }

  return report;
}

/** One sentence describing the risk, for the UI to show. */
export function describeSignatures(report: SignatureReport): string | null {
  const count = report.signatures.length;
  if (count === 0) return null;

  const named = report.signatures.map((s) => s.name).filter((n): n is string => !!n);
  const who = named.length ? ` by ${named.join(', ')}` : '';
  const certified = report.signatures.some((s) => s.certification);

  const subject = count === 1 ? 'This PDF is digitally signed' : `This PDF carries ${count} digital signatures`;
  const consequence = certified
    ? 'It is certified, so any change at all will break it.'
    : 'Saving an edited copy will invalidate the signature.';

  return `${subject}${who}. ${consequence} The original file is not touched.`;
}
