/**
 * Cryptographic primitives for the PDF standard security handler.
 *
 * PDF encryption predates anything modern: the older revisions are built on MD5
 * and RC4, which no platform exposes any more, so they are implemented here.
 * AES and the SHA-2 family come from Web Crypto, which exists in both browsers
 * and Node.
 *
 * Nothing here is used to protect anything. It exists only to read files the
 * user already possesses and can already open.
 */

const subtle: SubtleCrypto = globalThis.crypto.subtle;

/* ------------------------------------------------------------------ MD5 */

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K = new Int32Array(64);
for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

export function md5(input: Uint8Array<ArrayBufferLike>): Uint8Array {
  const len = input.length;
  // Message plus a 0x80 terminator plus the 64-bit length, padded to 64 bytes.
  const paddedLen = ((len + 8) >> 6 << 6) + 64;
  const buf = new Uint8Array(paddedLen);
  buf.set(input);
  buf[len] = 0x80;
  const bitLen = len * 8;
  const view = new DataView(buf.buffer);
  view.setUint32(paddedLen - 8, bitLen >>> 0, true);
  view.setUint32(paddedLen - 4, Math.floor(bitLen / 4294967296), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const m = new Int32Array(16);
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getInt32(off + i * 4, true);

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const tmp = d;
      d = c;
      c = b;
      const sum = (a + f + MD5_K[i] + m[g]) | 0;
      const rot = MD5_S[i];
      b = (b + ((sum << rot) | (sum >>> (32 - rot)))) | 0;
      a = tmp;
    }

    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setInt32(0, a0, true);
  ov.setInt32(4, b0, true);
  ov.setInt32(8, c0, true);
  ov.setInt32(12, d0, true);
  return out;
}

/* ------------------------------------------------------------------ RC4 */

export function rc4(key: Uint8Array<ArrayBufferLike>, data: Uint8Array<ArrayBufferLike>): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;

  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    const t = s[i];
    s[i] = s[j];
    s[j] = t;
  }

  const out = new Uint8Array(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    const t = s[i];
    s[i] = s[j];
    s[j] = t;
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

/* ------------------------------------------------------------------ SHA-2 */

export async function sha(bits: 256 | 384 | 512, data: Uint8Array<ArrayBufferLike>): Promise<Uint8Array> {
  const digest = await subtle.digest(`SHA-${bits}`, data as BufferSource);
  return new Uint8Array(digest);
}

/* ------------------------------------------------------------------ AES */

async function importAesKey(key: Uint8Array<ArrayBufferLike>, usage: KeyUsage): Promise<CryptoKey> {
  return subtle.importKey('raw', key as BufferSource, { name: 'AES-CBC' }, false, [usage]);
}

/** AES-CBC decryption where the data carries standard padding. */
export async function aesCbcDecrypt(
  key: Uint8Array<ArrayBufferLike>,
  iv: Uint8Array<ArrayBufferLike>,
  data: Uint8Array<ArrayBufferLike>,
): Promise<Uint8Array> {
  const k = await importAesKey(key, 'decrypt');
  const out = await subtle.decrypt({ name: 'AES-CBC', iv: iv as BufferSource }, k, data as BufferSource);
  return new Uint8Array(out);
}

/**
 * AES-CBC encryption with no padding. Web Crypto always appends a padding
 * block, so the extra block is discarded; the input must be block aligned.
 */
export async function aesCbcEncryptNoPad(
  key: Uint8Array<ArrayBufferLike>,
  iv: Uint8Array<ArrayBufferLike>,
  data: Uint8Array<ArrayBufferLike>,
): Promise<Uint8Array> {
  const k = await importAesKey(key, 'encrypt');
  const out = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv: iv as BufferSource }, k, data as BufferSource));
  return out.subarray(0, out.length - 16);
}

/**
 * AES-CBC decryption of unpadded data.
 *
 * Web Crypto insists on validating and stripping padding, so a synthetic final
 * block is appended that decrypts to exactly one full block of padding. That
 * block is built by encrypting `0x10 * 16` XOR the last ciphertext block, which
 * is what CBC would have produced had the data been padded in the first place.
 */
export async function aesCbcDecryptNoPad(
  key: Uint8Array<ArrayBufferLike>,
  iv: Uint8Array<ArrayBufferLike>,
  data: Uint8Array<ArrayBufferLike>,
): Promise<Uint8Array> {
  if (data.length === 0) return new Uint8Array(0);

  const lastBlock = data.subarray(data.length - 16);
  const target = new Uint8Array(16);
  for (let i = 0; i < 16; i++) target[i] = 0x10 ^ lastBlock[i];

  const encKey = await importAesKey(key, 'encrypt');
  const enc = new Uint8Array(
    await subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) as BufferSource }, encKey, target as BufferSource),
  );
  const synthetic = enc.subarray(0, 16);

  const combined = new Uint8Array(data.length + 16);
  combined.set(data);
  combined.set(synthetic, data.length);

  const k = await importAesKey(key, 'decrypt');
  const out = await subtle.decrypt({ name: 'AES-CBC', iv: iv as BufferSource }, k, combined as BufferSource);
  return new Uint8Array(out);
}
