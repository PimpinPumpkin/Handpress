/**
 * Matching a document's fonts against the ones installed on this computer.
 *
 * When an embedded font is subset, characters it never used have no glyph, and
 * anything newly typed has to be drawn with something else. A standard font is
 * the safe fallback but rarely looks like the original. If the real typeface
 * happens to be installed locally, using it makes the substitution invisible.
 *
 * The Local Font Access API is Chromium only and asks the user for permission,
 * because enumerating installed fonts is a fingerprinting signal. It is
 * therefore strictly opt in, and everything degrades to the standard fallback
 * when it is unavailable or declined. Font data is read in the page and embedded
 * into the output; nothing is sent anywhere.
 */

import type { FontRequest, FontProvider } from '../pdf/writer';

interface FontDataLike {
  postscriptName: string;
  fullName: string;
  family: string;
  style: string;
  blob(): Promise<Blob>;
}

type QueryLocalFonts = () => Promise<FontDataLike[]>;

export function localFontsSupported(): boolean {
  return typeof (window as unknown as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts === 'function';
}

/** Strips spaces, punctuation and case so `Inter Tight` matches `InterTight`. */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function styleScore(style: string, wantBold: boolean, wantItalic: boolean): number {
  const s = style.toLowerCase();
  const isItalic = /italic|oblique/.test(s);
  const isBold = /bold|black|heavy|semibold|demibold/.test(s);
  // An exact match on both axes wins; a wrong axis is worse than a missing one.
  let score = 0;
  score += isItalic === wantItalic ? 2 : -2;
  score += isBold === wantBold ? 2 : -2;
  if (/regular|book|roman/.test(s) && !wantBold && !wantItalic) score += 1;
  return score;
}

export class LocalFontProvider implements FontProvider {
  private index = new Map<string, FontDataLike[]>();
  private cache = new Map<string, Uint8Array | null>();
  private ready = false;

  /**
   * Asks for permission and builds the family index. Returns false when the API
   * is missing or the user declines, in which case the caller carries on with
   * standard fonts.
   */
  async enable(): Promise<boolean> {
    if (this.ready) return true;
    const q = (window as unknown as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts;
    if (!q) return false;

    let fonts: FontDataLike[];
    try {
      fonts = await q();
    } catch {
      return false; // declined, or blocked by permissions policy
    }

    for (const f of fonts) {
      const key = normalize(f.family);
      const list = this.index.get(key);
      if (list) list.push(f);
      else this.index.set(key, [f]);
    }
    this.ready = this.index.size > 0;
    return this.ready;
  }

  get enabled(): boolean {
    return this.ready;
  }

  /** Number of distinct families available, for status reporting. */
  get familyCount(): number {
    return this.index.size;
  }

  async fetch(req: FontRequest): Promise<Uint8Array | null> {
    if (!this.ready) return null;

    const key = `${normalize(req.family)}|${req.bold}|${req.italic}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    let candidates = this.index.get(normalize(req.family));

    // Fall back to a family whose name starts the same way, which catches
    // `InterTight` against an installed `Inter Tight Display` and similar.
    if (!candidates) {
      const want = normalize(req.family);
      if (want.length >= 4) {
        for (const [k, v] of this.index) {
          if (k.startsWith(want) || want.startsWith(k)) {
            candidates = v;
            break;
          }
        }
      }
    }
    if (!candidates || !candidates.length) {
      this.cache.set(key, null);
      return null;
    }

    const best = [...candidates].sort(
      (a, b) => styleScore(b.style, req.bold, req.italic) - styleScore(a.style, req.bold, req.italic),
    )[0];

    try {
      const blob = await best.blob();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      this.cache.set(key, bytes);
      return bytes;
    } catch {
      this.cache.set(key, null);
      return null;
    }
  }
}
