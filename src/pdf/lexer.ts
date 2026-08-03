/**
 * Tokenizer for PDF content streams.
 *
 * Byte offsets of every token are preserved: rewriting text means splicing exact
 * ranges of the original stream back together, so anything we do not understand
 * survives untouched.
 */

export const Tok = {
  Num: 0,
  Name: 1,
  /** literal ( ) or hex < > */
  Str: 2,
  ArrayOpen: 3,
  ArrayClose: 4,
  DictOpen: 5,
  DictClose: 6,
  Op: 7,
  InlineImage: 8,
  EOF: 9,
} as const;

export type Tok = (typeof Tok)[keyof typeof Tok];

export interface Token {
  kind: Tok;
  /** byte offset of the first byte of the token */
  start: number;
  /** byte offset one past the last byte of the token */
  end: number;
  num?: number;
  /** decoded name (without the leading slash) or operator keyword */
  name?: string;
  /** decoded raw bytes of a string token */
  bytes?: Uint8Array;
  /** true when a Str token was written as <hex> rather than (literal) */
  hex?: boolean;
}

const WS = new Uint8Array(256);
for (const c of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) WS[c] = 1;

const DELIM = new Uint8Array(256);
for (const c of [0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]) DELIM[c] = 1;

function isRegular(c: number): boolean {
  return !WS[c] && !DELIM[c];
}

function hexVal(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

export class Lexer {
  private pos = 0;
  private readonly buf: Uint8Array;

  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  /** Reads every token to EOF. */
  static tokenize(buf: Uint8Array): Token[] {
    const lex = new Lexer(buf);
    const out: Token[] = [];
    for (;;) {
      const t = lex.next();
      if (t.kind === Tok.EOF) break;
      out.push(t);
    }
    return out;
  }

  private skipWs(): void {
    const b = this.buf;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (WS[c]) {
        this.pos++;
      } else if (c === 0x25) {
        // comment runs to end of line
        while (this.pos < b.length && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos++;
      } else {
        break;
      }
    }
  }

  next(): Token {
    this.skipWs();
    const b = this.buf;
    const start = this.pos;
    if (this.pos >= b.length) return { kind: Tok.EOF, start, end: start };

    const c = b[this.pos];

    if (c === 0x2f) return this.readName();
    if (c === 0x28) return this.readLiteralString();
    if (c === 0x5b) {
      this.pos++;
      return { kind: Tok.ArrayOpen, start, end: this.pos };
    }
    if (c === 0x5d) {
      this.pos++;
      return { kind: Tok.ArrayClose, start, end: this.pos };
    }
    if (c === 0x3c) {
      if (b[this.pos + 1] === 0x3c) {
        this.pos += 2;
        return { kind: Tok.DictOpen, start, end: this.pos };
      }
      return this.readHexString();
    }
    if (c === 0x3e) {
      if (b[this.pos + 1] === 0x3e) {
        this.pos += 2;
        return { kind: Tok.DictClose, start, end: this.pos };
      }
      this.pos++; // stray '>', skip
      return this.next();
    }
    if (c === 0x7b || c === 0x7d) {
      // PostScript procedure braces (type 4 functions); treat as operators
      this.pos++;
      return { kind: Tok.Op, start, end: this.pos, name: String.fromCharCode(c) };
    }

    if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) {
      return this.readNumber();
    }

    return this.readOperator();
  }

  private readNumber(): Token {
    const b = this.buf;
    const start = this.pos;
    while (this.pos < b.length && isRegular(b[this.pos])) this.pos++;
    let s = '';
    for (let i = start; i < this.pos; i++) s += String.fromCharCode(b[i]);
    const n = parseFloat(s);
    // A malformed numeric-looking token degrades to an operator rather than NaN.
    if (Number.isNaN(n)) return { kind: Tok.Op, start, end: this.pos, name: s };
    return { kind: Tok.Num, start, end: this.pos, num: n };
  }

  private readName(): Token {
    const b = this.buf;
    const start = this.pos;
    this.pos++; // slash
    let name = '';
    while (this.pos < b.length && isRegular(b[this.pos])) {
      let ch = b[this.pos];
      if (ch === 0x23 && this.pos + 2 < b.length) {
        const h1 = hexVal(b[this.pos + 1]);
        const h2 = hexVal(b[this.pos + 2]);
        if (h1 >= 0 && h2 >= 0) {
          ch = (h1 << 4) | h2;
          this.pos += 2;
        }
      }
      name += String.fromCharCode(ch);
      this.pos++;
    }
    return { kind: Tok.Name, start, end: this.pos, name };
  }

  private readOperator(): Token {
    const b = this.buf;
    const start = this.pos;
    while (this.pos < b.length && isRegular(b[this.pos])) this.pos++;
    if (this.pos === start) this.pos++; // never stall on an unexpected delimiter
    let name = '';
    for (let i = start; i < this.pos; i++) name += String.fromCharCode(b[i]);
    if (name === 'BI') return this.readInlineImage(start);
    return { kind: Tok.Op, start, end: this.pos, name };
  }

  /**
   * Inline images carry raw binary between ID and EI that must not be tokenized;
   * the whole BI..EI run is consumed as one opaque token.
   */
  private readInlineImage(start: number): Token {
    const b = this.buf;
    // find ID
    while (this.pos < b.length - 1) {
      if (b[this.pos] === 0x49 /* I */ && b[this.pos + 1] === 0x44 /* D */) {
        this.pos += 2;
        break;
      }
      this.pos++;
    }
    if (this.pos < b.length && WS[b[this.pos]]) this.pos++; // single whitespace after ID
    // scan for whitespace-delimited EI followed by whitespace/EOF
    while (this.pos < b.length - 1) {
      if (
        b[this.pos] === 0x45 /* E */ &&
        b[this.pos + 1] === 0x49 /* I */ &&
        (this.pos === 0 || WS[b[this.pos - 1]]) &&
        (this.pos + 2 >= b.length || WS[b[this.pos + 2]] || DELIM[b[this.pos + 2]])
      ) {
        this.pos += 2;
        return { kind: Tok.InlineImage, start, end: this.pos };
      }
      this.pos++;
    }
    this.pos = b.length;
    return { kind: Tok.InlineImage, start, end: this.pos };
  }

  private readLiteralString(): Token {
    const b = this.buf;
    const start = this.pos;
    this.pos++; // '('
    const out: number[] = [];
    let depth = 1;
    while (this.pos < b.length) {
      let c = b[this.pos++];
      if (c === 0x5c /* backslash */) {
        if (this.pos >= b.length) break;
        c = b[this.pos++];
        switch (c) {
          case 0x6e: out.push(0x0a); break; // n
          case 0x72: out.push(0x0d); break; // r
          case 0x74: out.push(0x09); break; // t
          case 0x62: out.push(0x08); break; // b
          case 0x66: out.push(0x0c); break; // f
          case 0x28: out.push(0x28); break;
          case 0x29: out.push(0x29); break;
          case 0x5c: out.push(0x5c); break;
          case 0x0d: // line continuation
            if (b[this.pos] === 0x0a) this.pos++;
            break;
          case 0x0a:
            break;
          default:
            if (c >= 0x30 && c <= 0x37) {
              let v = c - 0x30;
              for (let k = 0; k < 2; k++) {
                const d = b[this.pos];
                if (d >= 0x30 && d <= 0x37) {
                  v = v * 8 + (d - 0x30);
                  this.pos++;
                } else break;
              }
              out.push(v & 0xff);
            } else {
              out.push(c);
            }
        }
        continue;
      }
      if (c === 0x28) {
        depth++;
        out.push(c);
        continue;
      }
      if (c === 0x29) {
        depth--;
        if (depth === 0) break;
        out.push(c);
        continue;
      }
      out.push(c);
    }
    return { kind: Tok.Str, start, end: this.pos, bytes: Uint8Array.from(out), hex: false };
  }

  private readHexString(): Token {
    const b = this.buf;
    const start = this.pos;
    this.pos++; // '<'
    const out: number[] = [];
    let hi = -1;
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 0x3e) break;
      const v = hexVal(c);
      if (v < 0) continue;
      if (hi < 0) hi = v;
      else {
        out.push((hi << 4) | v);
        hi = -1;
      }
    }
    if (hi >= 0) out.push(hi << 4); // odd digit count pads with 0
    return { kind: Tok.Str, start, end: this.pos, bytes: Uint8Array.from(out), hex: true };
  }
}

/** Escapes bytes into a PDF literal string, including the surrounding parens. */
export function encodeLiteralString(bytes: Uint8Array): Uint8Array {
  const out: number[] = [0x28];
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) {
      out.push(0x5c, b);
    } else if (b < 0x20 || b > 0x7e) {
      // octal escape keeps the stream 7-bit clean and avoids EOL mangling
      out.push(0x5c);
      const oct = b.toString(8).padStart(3, '0');
      for (const ch of oct) out.push(ch.charCodeAt(0));
    } else {
      out.push(b);
    }
  }
  out.push(0x29);
  return Uint8Array.from(out);
}

const HEX = '0123456789ABCDEF';

/** Encodes bytes as a PDF hex string, including the surrounding angle brackets. */
export function encodeHexString(bytes: Uint8Array): Uint8Array {
  const out: number[] = [0x3c];
  for (const b of bytes) {
    out.push(HEX.charCodeAt(b >> 4), HEX.charCodeAt(b & 0x0f));
  }
  out.push(0x3e);
  return Uint8Array.from(out);
}
