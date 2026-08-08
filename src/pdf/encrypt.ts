/**
 * Putting a password on a document.
 *
 * This writes the standard security handler at revision 6, which is AES-256 and
 * what every reader since Acrobat X understands. The older revisions are read
 * here (see `decrypt.ts`) because files in the wild use them, but nothing new
 * should be written with RC4 or a 128 bit key in 2026, so nothing is.
 *
 * Revision 6 is much simpler to write than what came before it: the file key is
 * random rather than derived from the password, so there is no per object key
 * and no dependence on object numbers. The password unlocks the file key, and
 * the file key encrypts everything.
 *
 * Every string and every stream is encrypted, which is why the save that
 * follows must not use object streams. Strings inside an object stream are
 * covered by the encryption of the stream that holds them and must not be
 * encrypted again; keeping every object at the top level avoids the question.
 */

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFObject,
} from 'pdf-lib';
import { aesCbcEncryptNoPad } from './crypto';
import { hash2B } from './decrypt';

/** What the owner of a document may let everyone else do with it. */
export interface Permissions {
  print: boolean;
  copy: boolean;
  modify: boolean;
  annotate: boolean;
}

export const ALL_ALLOWED: Permissions = { print: true, copy: true, modify: true, annotate: true };

export interface EncryptOptions {
  /** Password needed to open the document. Empty means anyone may open it. */
  userPassword: string;
  /**
   * Password needed to change the permissions.
   *
   * Defaults to the user password. Leaving the two the same is the honest
   * choice when no separate owner is meant, since a document whose owner
   * password is empty can be unlocked by anything that bothers to try.
   */
  ownerPassword?: string;
  permissions?: Permissions;
}

/**
 * Rewrites a document with every string and stream encrypted.
 *
 * The returned bytes are a complete PDF. The document handed in is modified in
 * the process, so callers should pass one they built for the purpose.
 */
export async function encrypt(bytes: Uint8Array, options: EncryptOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { throwOnInvalidObject: false, updateMetadata: false });

  const userPassword = utf8(options.userPassword);
  const ownerPassword = utf8(options.ownerPassword ?? options.userPassword);
  const permissionBits = permissionsToBits(options.permissions ?? ALL_ALLOWED);

  // The file key is random and never derived from the password, which is what
  // makes revision 6 straightforward: the passwords only wrap this key.
  const fileKey = random(32);

  const userValidation = random(8);
  const userKeySalt = random(8);
  const u = concat([
    await hash2B(userPassword, userValidation, new Uint8Array(0), 6),
    userValidation,
    userKeySalt,
  ]);
  const ue = await aesCbcEncryptNoPad(
    await hash2B(userPassword, userKeySalt, new Uint8Array(0), 6),
    new Uint8Array(16),
    fileKey,
  );

  // The owner entries are hashed over the user entry as well, which is what
  // ties the two together and stops one being lifted onto another document.
  const ownerValidation = random(8);
  const ownerKeySalt = random(8);
  const o = concat([await hash2B(ownerPassword, ownerValidation, u, 6), ownerValidation, ownerKeySalt]);
  const oe = await aesCbcEncryptNoPad(
    await hash2B(ownerPassword, ownerKeySalt, u, 6),
    new Uint8Array(16),
    fileKey,
  );

  const perms = await permissionsBlock(fileKey, permissionBits);

  await encryptEverything(doc, fileKey);

  const context = doc.context;
  const encryptDict = context.obj({
    Filter: 'Standard',
    V: 5,
    R: 6,
    Length: 256,
    CF: { StdCF: { CFM: 'AESV3', AuthEvent: 'DocOpen', Length: 32 } },
    StmF: 'StdCF',
    StrF: 'StdCF',
    P: permissionBits,
    EncryptMetadata: true,
  });
  encryptDict.set(PDFName.of('U'), PDFHexString.of(hex(u)));
  encryptDict.set(PDFName.of('UE'), PDFHexString.of(hex(ue)));
  encryptDict.set(PDFName.of('O'), PDFHexString.of(hex(o)));
  encryptDict.set(PDFName.of('OE'), PDFHexString.of(hex(oe)));
  encryptDict.set(PDFName.of('Perms'), PDFHexString.of(hex(perms)));

  // The encryption dictionary is itself never encrypted, so it is registered
  // after everything else has been.
  context.trailerInfo.Encrypt = context.register(encryptDict);

  // A file identifier is required once a document is encrypted, and readers
  // that find none are entitled to refuse it.
  if (!context.trailerInfo.ID) {
    const id = PDFHexString.of(hex(random(16)));
    context.trailerInfo.ID = context.obj([id, id]);
  }

  return doc.save({ useObjectStreams: false });
}

/**
 * Encrypts every string and stream in the document.
 *
 * Each gets its own random initialisation vector, written in front of the
 * ciphertext, which is what the format expects and what stops two identical
 * strings looking identical on disk.
 */
async function encryptEverything(doc: PDFDocument, key: Uint8Array): Promise<void> {
  const seen = new Set<PDFObject>();

  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    // The identifier lives in the trailer and stays in the clear.
    void ref;
    await walk(object);
  }

  async function walk(object: PDFObject): Promise<void> {
    if (seen.has(object)) return;
    seen.add(object);

    if (object instanceof PDFRawStream) {
      const encrypted = await encryptBytes(key, object.getContents());
      (object as unknown as { contents: Uint8Array }).contents = encrypted;
      object.dict.set(PDFName.of('Length'), PDFNumber.of(encrypted.length));
      await walkDict(object.dict);
      return;
    }

    if (object instanceof PDFStream) {
      await walkDict(object.dict);
      return;
    }

    if (object instanceof PDFDict) {
      await walkDict(object);
      return;
    }

    if (object instanceof PDFArray) {
      await walkArray(object);
    }
  }

  async function walkDict(dict: PDFDict): Promise<void> {
    for (const [name, value] of dict.entries()) {
      if (value instanceof PDFString || value instanceof PDFHexString) {
        dict.set(name, PDFHexString.of(hex(await encryptBytes(key, stringBytes(value)))));
      } else if (!(value instanceof PDFRef)) {
        await walk(value);
      }
    }
  }

  async function walkArray(array: PDFArray): Promise<void> {
    for (let i = 0; i < array.size(); i++) {
      const value = array.get(i);
      if (value instanceof PDFString || value instanceof PDFHexString) {
        array.set(i, PDFHexString.of(hex(await encryptBytes(key, stringBytes(value)))));
      } else if (value && !(value instanceof PDFRef)) {
        await walk(value);
      }
    }
  }
}

/** AES-256-CBC with a random initialisation vector written in front. */
async function encryptBytes(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const iv = random(16);
  // Padding is required, and is the one place the no-padding helper is wrong,
  // so the block is built by hand: PKCS#7, always at least one full block.
  const padding = 16 - (data.length % 16);
  const padded = new Uint8Array(data.length + padding);
  padded.set(data);
  padded.fill(padding, data.length);
  return concat([iv, await aesCbcEncryptNoPad(key, iv, padded)]);
}

/**
 * The permissions block, which a reader decrypts to check that the permissions
 * it was handed in the clear are the ones the owner actually set.
 */
async function permissionsBlock(key: Uint8Array, permissions: number): Promise<Uint8Array> {
  const block = new Uint8Array(16);
  const view = new DataView(block.buffer);
  view.setInt32(0, permissions, true);
  view.setUint32(4, 0xffffffff, true);
  block[8] = 0x54; // 'T', metadata is encrypted
  block[9] = 0x61; // 'a'
  block[10] = 0x64; // 'd'
  block[11] = 0x62; // 'b'
  block.set(random(4), 12);
  // A single block with no chaining, which is what the format asks for here.
  return aesCbcEncryptNoPad(key, new Uint8Array(16), block);
}

/**
 * Permission flags, as the format's oddly shaped integer.
 *
 * Bits are numbered from one and the low two are reserved and always set, which
 * is why the constant starts life as every bit on rather than zero.
 */
function permissionsToBits(permissions: Permissions): number {
  let bits = -1; // every bit set, then the ones being denied are cleared
  if (!permissions.print) bits &= ~(1 << 2);
  if (!permissions.modify) bits &= ~(1 << 3);
  if (!permissions.copy) bits &= ~(1 << 4);
  if (!permissions.annotate) bits &= ~(1 << 5);
  if (!permissions.print) bits &= ~(1 << 11); // high quality printing
  return bits;
}

function stringBytes(value: PDFString | PDFHexString): Uint8Array {
  if (value instanceof PDFHexString) {
    const text = value.toString().replace(/[<>]/g, '');
    const out = new Uint8Array(Math.floor(text.length / 2));
    for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  const raw = value.toString().slice(1, -1);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i) & 0xff;
  return out;
}

function utf8(text: string): Uint8Array {
  // The format wants passwords normalised and capped at 127 bytes.
  return new TextEncoder().encode(text).subarray(0, 127);
}

function random(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
