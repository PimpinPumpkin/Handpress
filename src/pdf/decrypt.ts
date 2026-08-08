/**
 * The PDF standard security handler.
 *
 * Most "protected" PDFs in circulation are not password protected at all. They
 * carry an owner password that restricts printing or editing while the user
 * password is empty, which is why any viewer opens them without asking. They are
 * readable by everyone and writable by nobody, which is exactly the case worth
 * supporting: the user already has the file and can already read it.
 *
 * Decryption happens once at load, over the whole object graph, after which the
 * `/Encrypt` entry is dropped and the document behaves like any other. A file
 * that genuinely needs a password still needs one.
 */

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
  type PDFObject,
} from 'pdf-lib';
import { aesCbcDecrypt, aesCbcDecryptNoPad, aesCbcEncryptNoPad, md5, rc4, sha } from './crypto';
import { encodeHexString, encodeLiteralString, Lexer, Tok } from './lexer';

/** Padding string from the specification, used to extend short passwords. */
const PAD = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

type Cipher = 'rc4' | 'aes128' | 'aes256' | 'none';

export class DecryptionError extends Error {}

function concat(parts: Array<Uint8Array<ArrayBufferLike>>): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function stringBytes(obj: PDFObject | undefined): Uint8Array<ArrayBufferLike> | null {
  // asBytes resolves escape sequences, which matters because the O, U and UE
  // entries are raw binary written as literal strings.
  if (obj instanceof PDFHexString || obj instanceof PDFString) return obj.asBytes();
  return null;
}

function numberOf(dict: PDFDict, key: string, fallback: number): number {
  const v = dict.lookup(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : fallback;
}

/** Extends or truncates a password to the 32 bytes the older revisions expect. */
function padPassword(password: string): Uint8Array {
  const pw = new Uint8Array(32);
  let i = 0;
  for (; i < password.length && i < 32; i++) pw[i] = password.charCodeAt(i) & 0xff;
  for (let j = 0; i < 32; i++, j++) pw[i] = PAD[j];
  return pw;
}

/** Algorithm 2: the file encryption key for revisions 2 through 4. */
function legacyFileKey(
  password: string,
  ownerKey: Uint8Array<ArrayBufferLike>,
  permissions: number,
  idBytes: Uint8Array<ArrayBufferLike>,
  revision: number,
  keyLength: number,
  encryptMetadata: boolean,
): Uint8Array {
  const perms = new Uint8Array(4);
  new DataView(perms.buffer).setInt32(0, permissions | 0, true);

  const parts = [padPassword(password), ownerKey.subarray(0, 32), perms, idBytes];
  if (revision >= 4 && !encryptMetadata) parts.push(new Uint8Array([0xff, 0xff, 0xff, 0xff]));

  let key = md5(concat(parts));
  const n = revision === 2 ? 5 : Math.max(5, Math.min(16, keyLength >> 3));
  if (revision >= 3) {
    for (let i = 0; i < 50; i++) key = md5(key.subarray(0, n));
  }
  return key.subarray(0, n);
}

/**
 * Algorithm 2.B: the iterated hash introduced with revision 6.
 *
 * Deliberately expensive, mixing SHA-256, SHA-384 and SHA-512 with AES rounds,
 * and continuing for at least 64 rounds past a data-dependent stopping rule.
 */
export async function hash2B(
  password: Uint8Array<ArrayBufferLike>,
  salt: Uint8Array<ArrayBufferLike>,
  userData: Uint8Array<ArrayBufferLike>,
  revision: number,
): Promise<Uint8Array<ArrayBufferLike>> {
  let k = await sha(256, concat([password, salt, userData]));
  if (revision === 5) return k;

  for (let round = 0; ; round++) {
    const block = concat([password, k, userData]);
    const k1 = new Uint8Array(block.length * 64);
    for (let i = 0; i < 64; i++) k1.set(block, i * block.length);

    const e = await aesCbcEncryptNoPad(k.subarray(0, 16), k.subarray(16, 32), k1);

    let sum = 0;
    for (let i = 0; i < 16; i++) sum += e[i];
    const bits = ([256, 384, 512] as const)[sum % 3];
    k = await sha(bits, e);

    if (round >= 63 && e[e.length - 1] <= round - 31) break;
  }
  return k.subarray(0, 32);
}

export interface Handler {
  key: Uint8Array<ArrayBufferLike>;
  streamCipher: Cipher;
  stringCipher: Cipher;
  revision: number;
  /** Object number of the encryption dictionary, which is never encrypted. */
  encryptObjNum: number;
}

/** Derives the per-object key required by everything before revision 5. */
function objectKey(key: Uint8Array<ArrayBufferLike>, ref: PDFRef, aes: boolean): Uint8Array {
  const extra = aes ? 9 : 5;
  const buf = new Uint8Array(key.length + extra);
  buf.set(key);
  buf[key.length] = ref.objectNumber & 0xff;
  buf[key.length + 1] = (ref.objectNumber >> 8) & 0xff;
  buf[key.length + 2] = (ref.objectNumber >> 16) & 0xff;
  buf[key.length + 3] = ref.generationNumber & 0xff;
  buf[key.length + 4] = (ref.generationNumber >> 8) & 0xff;
  if (aes) buf.set([0x73, 0x41, 0x6c, 0x54], key.length + 5); // "sAlT"
  return md5(buf).subarray(0, Math.min(key.length + 5, 16));
}

async function decryptBytes(
  handler: Handler,
  cipher: Cipher,
  ref: PDFRef,
  data: Uint8Array<ArrayBufferLike>,
): Promise<Uint8Array<ArrayBufferLike>> {
  if (cipher === 'none' || data.length === 0) return data;

  if (cipher === 'aes256') {
    // Revision 5 and 6 use the file key directly, with no per-object mixing.
    const iv = data.subarray(0, 16);
    const body = data.subarray(16);
    if (body.length === 0) return new Uint8Array(0);
    try {
      return await aesCbcDecrypt(handler.key, iv, body);
    } catch {
      return await aesCbcDecryptNoPad(handler.key, iv, body.subarray(0, body.length - (body.length % 16)));
    }
  }

  if (cipher === 'aes128') {
    const key = objectKey(handler.key, ref, true);
    const iv = data.subarray(0, 16);
    const body = data.subarray(16);
    if (body.length === 0) return new Uint8Array(0);
    try {
      return await aesCbcDecrypt(key, iv, body);
    } catch {
      return await aesCbcDecryptNoPad(key, iv, body.subarray(0, body.length - (body.length % 16)));
    }
  }

  return rc4(objectKey(handler.key, ref, false), data);
}

function cipherFromCF(encrypt: PDFDict, filterName: string, version: number): Cipher {
  if (filterName === 'Identity') return 'none';
  const cf = encrypt.lookup(PDFName.of('CF'));
  if (cf instanceof PDFDict) {
    const entry = cf.lookup(PDFName.of(filterName));
    if (entry instanceof PDFDict) {
      const cfm = entry.lookup(PDFName.of('CFM'));
      const name = cfm instanceof PDFName ? cfm.asString().replace(/^\//, '') : '';
      if (name === 'AESV2') return 'aes128';
      if (name === 'AESV3') return 'aes256';
      if (name === 'None') return 'none';
      return 'rc4';
    }
  }
  return version >= 5 ? 'aes256' : 'rc4';
}

/**
 * Reads a document's encryption dictionary and derives its file key.
 *
 * Returns null when the document is not encrypted. Throws DecryptionError when
 * it genuinely needs a password, so the caller can say so plainly instead of
 * presenting a page of mojibake.
 */
export async function readHandler(doc: PDFDocument, password = ''): Promise<Handler | null> {
  const context = doc.context;
  const encryptRefOrDict = context.trailerInfo.Encrypt;
  if (!encryptRefOrDict) return null;

  const encrypt = context.lookup(encryptRefOrDict);
  if (!(encrypt instanceof PDFDict)) return null;

  const filter = encrypt.lookup(PDFName.of('Filter'));
  if (!(filter instanceof PDFName) || filter.asString().replace(/^\//, '') !== 'Standard') {
    throw new DecryptionError('This PDF uses a custom security handler that Vellum cannot read.');
  }

  const version = numberOf(encrypt, 'V', 0);
  const revision = numberOf(encrypt, 'R', 2);
  const keyLength = numberOf(encrypt, 'Length', 40);
  const permissions = numberOf(encrypt, 'P', -1);
  const encryptMetadataRaw = encrypt.lookup(PDFName.of('EncryptMetadata'));
  const encryptMetadata = String(encryptMetadataRaw ?? 'true') !== 'false';

  const ownerKey = stringBytes(encrypt.lookup(PDFName.of('O')));
  const userKey = stringBytes(encrypt.lookup(PDFName.of('U')));
  if (!ownerKey || !userKey) throw new DecryptionError('This PDF has a damaged encryption dictionary.');

  let idBytes: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  const id = context.trailerInfo.ID;
  if (id instanceof PDFArray && id.size() > 0) {
    idBytes = stringBytes(id.lookup(0)) ?? new Uint8Array(0);
  }

  let key: Uint8Array<ArrayBufferLike>;
  if (revision >= 5) {
    // The password is checked against a salted hash before deriving anything.
    const pwBytes = new TextEncoder().encode(password);
    const validationSalt = userKey.subarray(32, 40);
    const keySalt = userKey.subarray(40, 48);

    const check = await hash2B(pwBytes, validationSalt, new Uint8Array(0), revision);
    if (!check.subarray(0, 32).every((b, i) => b === userKey[i])) {
      throw new DecryptionError('This PDF needs a password to open.');
    }

    const intermediate = await hash2B(pwBytes, keySalt, new Uint8Array(0), revision);
    const ue = stringBytes(encrypt.lookup(PDFName.of('UE')));
    if (!ue) throw new DecryptionError('This PDF has a damaged encryption dictionary.');
    key = await aesCbcDecryptNoPad(intermediate, new Uint8Array(16), ue.subarray(0, 32));
  } else {
    key = legacyFileKey(password, ownerKey, permissions, idBytes, revision, keyLength, encryptMetadata);
  }

  const stmFilter = encrypt.lookup(PDFName.of('StmF'));
  const strFilter = encrypt.lookup(PDFName.of('StrF'));
  const stmName = stmFilter instanceof PDFName ? stmFilter.asString().replace(/^\//, '') : 'Identity';
  const strName = strFilter instanceof PDFName ? strFilter.asString().replace(/^\//, '') : 'Identity';

  return {
    key,
    revision,
    streamCipher: version >= 4 ? cipherFromCF(encrypt, stmName, version) : 'rc4',
    stringCipher: version >= 4 ? cipherFromCF(encrypt, strName, version) : 'rc4',
    encryptObjNum: encryptRefOrDict instanceof PDFRef ? encryptRefOrDict.objectNumber : -1,
  };
}

/**
 * Turns an encrypted PDF into an equivalent unencrypted one.
 *
 * Returns the original bytes untouched when the file was never encrypted.
 */
export async function decryptToBytes(
  bytes: Uint8Array,
  password = '',
): Promise<{ bytes: Uint8Array; wasEncrypted: boolean }> {
  const probe = await PDFDocument.load(bytes.slice(), {
    throwOnInvalidObject: false,
    updateMetadata: false,
    ignoreEncryption: true,
  });

  const handler = await readHandler(probe, password);
  if (!handler) return { bytes, wasEncrypted: false };

  const plain = await preDecrypt(bytes, handler);

  // Re-read the now readable bytes and drop the encryption entry, so everything
  // downstream sees an ordinary document.
  const doc = await PDFDocument.load(plain, {
    throwOnInvalidObject: false,
    updateMetadata: false,
    ignoreEncryption: true,
  });
  doc.context.trailerInfo.Encrypt = undefined;
  return { bytes: await doc.save({ useObjectStreams: false }), wasEncrypted: true };
}

/* ------------------------------------------------------ byte level pre-pass */

const OBJ_RE = /(\d+)\s+(\d+)\s+obj\b/g;

function indexOfSeq(hay: Uint8Array, needle: string, from: number, to: number): number {
  const n = needle.length;
  outer: for (let i = from; i <= to - n; i++) {
    for (let j = 0; j < n; j++) if (hay[i + j] !== needle.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

/**
 * Decrypts a document's streams and strings directly in the file bytes.
 *
 * This has to happen before the document is parsed. Objects stored inside
 * object streams are extracted during parsing, and a parser handed ciphertext
 * extracts nonsense that cannot be repaired afterwards, because the container it
 * came from is consumed and discarded. Working on the raw bytes sidesteps that
 * entirely: by the time anything is parsed, the file is already in the clear.
 *
 * Strings inside object streams are deliberately left alone. They are covered by
 * the encryption of the stream that contains them and are plaintext once it is
 * decrypted; touching them again would corrupt them.
 */
export async function preDecrypt(bytes: Uint8Array, handler: Handler): Promise<Uint8Array> {
  const text = new TextDecoder('latin1').decode(bytes);
  const patches: Array<{ start: number; end: number; bytes: Uint8Array }> = [];

  OBJ_RE.lastIndex = 0;
  const starts: Array<{ at: number; num: number; gen: number; bodyAt: number }> = [];
  for (let m = OBJ_RE.exec(text); m; m = OBJ_RE.exec(text)) {
    starts.push({ at: m.index, num: Number(m[1]), gen: Number(m[2]), bodyAt: m.index + m[0].length });
  }

  for (let i = 0; i < starts.length; i++) {
    const { num, gen, bodyAt } = starts[i];
    if (num === handler.encryptObjNum) continue; // the encryption dictionary is exempt
    const limit = i + 1 < starts.length ? starts[i + 1].at : bytes.length;
    const ref = PDFRef.of(num, gen);

    const endObj = indexOfSeq(bytes, 'endobj', bodyAt, limit);
    const objEnd = endObj >= 0 ? endObj : limit;

    const streamAt = indexOfSeq(bytes, 'stream', bodyAt, objEnd);
    const dictEnd = streamAt >= 0 ? streamAt : objEnd;

    // Strings live in the object's dictionary, ahead of any stream data.
    for (const tok of Lexer.tokenize(bytes.subarray(bodyAt, dictEnd))) {
      if (tok.kind !== Tok.Str || !tok.bytes || tok.bytes.length === 0) continue;
      const plain = await decryptBytes(handler, handler.stringCipher, ref, tok.bytes);
      patches.push({
        start: bodyAt + tok.start,
        end: bodyAt + tok.end,
        bytes: tok.hex ? encodeHexString(plain) : encodeLiteralString(plain),
      });
    }

    if (streamAt < 0) continue;

    // Stream data begins after the keyword and its end-of-line marker.
    let dataAt = streamAt + 'stream'.length;
    if (bytes[dataAt] === 0x0d) dataAt++;
    if (bytes[dataAt] === 0x0a) dataAt++;
    const endStream = indexOfSeq(bytes, 'endstream', dataAt, limit);
    if (endStream < 0) continue;

    let dataEnd = endStream;
    // Trim the end-of-line that precedes the keyword; it is not part of the data.
    if (dataEnd > dataAt && bytes[dataEnd - 1] === 0x0a) dataEnd--;
    if (dataEnd > dataAt && bytes[dataEnd - 1] === 0x0d) dataEnd--;
    if (dataEnd <= dataAt) continue;

    // Cross-reference streams are never encrypted.
    const head = text.slice(bodyAt, dictEnd);
    if (/\/Type\s*\/XRef\b/.test(head)) continue;

    const plain = await decryptBytes(handler, handler.streamCipher, ref, bytes.subarray(dataAt, dataEnd));
    patches.push({ start: dataAt, end: dataEnd, bytes: plain });
  }

  patches.sort((a, b) => a.start - b.start);
  const out: Uint8Array[] = [];
  let cursor = 0;
  for (const patch of patches) {
    if (patch.start < cursor) continue;
    out.push(bytes.subarray(cursor, patch.start), patch.bytes);
    cursor = patch.end;
  }
  out.push(bytes.subarray(cursor));

  const total = out.reduce((n, p) => n + p.length, 0);
  const merged = new Uint8Array(total);
  let o = 0;
  for (const p of out) {
    merged.set(p, o);
    o += p.length;
  }
  return merged;
}
