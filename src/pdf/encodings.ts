/**
 * Character encoding tables for simple (single-byte) PDF fonts.
 *
 * Two directions matter: code -> Unicode to read existing text, and Unicode ->
 * code to write replacement text back using the document's own font. A code that
 * cannot be mapped is reported rather than guessed, so the caller can drop to a
 * substitute font instead of emitting a wrong glyph.
 */

/** Adobe Glyph List, restricted to the Latin set reachable from the standard encodings. */
const AGL_DATA =
  'space:20 exclam:21 quotedbl:22 numbersign:23 dollar:24 percent:25 ampersand:26 quotesingle:27 ' +
  'quoteright:2019 parenleft:28 parenright:29 asterisk:2a plus:2b comma:2c hyphen:2d period:2e slash:2f ' +
  'zero:30 one:31 two:32 three:33 four:34 five:35 six:36 seven:37 eight:38 nine:39 colon:3a semicolon:3b ' +
  'less:3c equal:3d greater:3e question:3f at:40 bracketleft:5b backslash:5c bracketright:5d ' +
  'asciicircum:5e underscore:5f grave:60 quoteleft:2018 braceleft:7b bar:7c braceright:7d asciitilde:7e ' +
  'exclamdown:a1 cent:a2 sterling:a3 fraction:2044 yen:a5 florin:192 section:a7 currency:a4 ' +
  'quotedblleft:201c guillemotleft:ab guilsinglleft:2039 guilsinglright:203a ' +
  'ff:fb00 fi:fb01 fl:fb02 ffi:fb03 ffl:fb04 ' +
  'endash:2013 dagger:2020 daggerdbl:2021 periodcentered:b7 paragraph:b6 bullet:2022 ' +
  'quotesinglbase:201a quotedblbase:201e quotedblright:201d guillemotright:bb ellipsis:2026 ' +
  'perthousand:2030 questiondown:bf acute:b4 circumflex:2c6 tilde:2dc macron:af breve:2d8 ' +
  'dotaccent:2d9 dieresis:a8 ring:2da cedilla:b8 hungarumlaut:2dd ogonek:2db caron:2c7 emdash:2014 ' +
  'AE:c6 ordfeminine:aa Lslash:141 Oslash:d8 OE:152 ordmasculine:ba ae:e6 dotlessi:131 lslash:142 ' +
  'oslash:f8 oe:153 germandbls:df Euro:20ac Scaron:160 scaron:161 Zcaron:17d zcaron:17e ' +
  'Ydieresis:178 trademark:2122 brokenbar:a6 copyright:a9 logicalnot:ac registered:ae degree:b0 ' +
  'plusminus:b1 twosuperior:b2 threesuperior:b3 mu:b5 onesuperior:b9 onequarter:bc onehalf:bd ' +
  'threequarters:be Agrave:c0 Aacute:c1 Acircumflex:c2 Atilde:c3 Adieresis:c4 Aring:c5 Ccedilla:c7 ' +
  'Egrave:c8 Eacute:c9 Ecircumflex:ca Edieresis:cb Igrave:cc Iacute:cd Icircumflex:ce Idieresis:cf ' +
  'Eth:d0 Ntilde:d1 Ograve:d2 Oacute:d3 Ocircumflex:d4 Otilde:d5 Odieresis:d6 multiply:d7 ' +
  'Ugrave:d9 Uacute:da Ucircumflex:db Udieresis:dc Yacute:dd Thorn:de agrave:e0 aacute:e1 ' +
  'acircumflex:e2 atilde:e3 adieresis:e4 aring:e5 ccedilla:e7 egrave:e8 eacute:e9 ecircumflex:ea ' +
  'edieresis:eb igrave:ec iacute:ed icircumflex:ee idieresis:ef eth:f0 ntilde:f1 ograve:f2 oacute:f3 ' +
  'ocircumflex:f4 otilde:f5 odieresis:f6 divide:f7 ugrave:f9 uacute:fa ucircumflex:fb udieresis:fc ' +
  'yacute:fd thorn:fe ydieresis:ff nbspace:a0 sfthyphen:ad Delta:2206 Omega:2126 pi:3c0 ' +
  'lozenge:25ca apple:f8ff notequal:2260 infinity:221e lessequal:2264 greaterequal:2265 ' +
  'partialdiff:2202 summation:2211 product:220f integral:222b radical:221a approxequal:2248 ' +
  'Idot:130 minus:2212 asciicircummonospace:5e';

const AGL = new Map<string, number>();
for (const pair of AGL_DATA.split(' ')) {
  if (!pair) continue;
  const i = pair.lastIndexOf(':');
  AGL.set(pair.slice(0, i), parseInt(pair.slice(i + 1), 16));
}
// ASCII letters and digits carry their own names.
for (let c = 0x41; c <= 0x5a; c++) AGL.set(String.fromCharCode(c), c);
for (let c = 0x61; c <= 0x7a; c++) AGL.set(String.fromCharCode(c), c);

/**
 * Resolves a PDF glyph name to a Unicode code point, or -1 when the name carries
 * no reliable Unicode meaning (subset names like `g42`, `cid7`, `index12`).
 */
export function glyphNameToUnicode(name: string): number {
  const direct = AGL.get(name);
  if (direct !== undefined) return direct;

  // uniXXXX / uXXXX[XX] forms are defined by the AGL algorithm.
  let m = /^uni([0-9A-Fa-f]{4})/.exec(name);
  if (m) return parseInt(m[1], 16);
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) return parseInt(m[1], 16);

  // A trailing variant suffix (Arial.sc, one.oldstyle) still identifies the base glyph.
  const dot = name.indexOf('.');
  if (dot > 0) return glyphNameToUnicode(name.slice(0, dot));

  // Single character names map to themselves.
  if (name.length === 1) return name.charCodeAt(0);

  return -1;
}

function buildTable(spec: Record<number, string>): (string | undefined)[] {
  const table: (string | undefined)[] = new Array(256);
  for (const [k, v] of Object.entries(spec)) table[Number(k)] = v;
  return table;
}

/** ASCII range shared by StandardEncoding and WinAnsiEncoding, differences applied after. */
function asciiBase(): Record<number, string> {
  const names = (
    'space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright ' +
    'asterisk plus comma hyphen period slash zero one two three four five six seven eight nine ' +
    'colon semicolon less equal greater question at'
  ).split(' ');
  const out: Record<number, string> = {};
  names.forEach((n, i) => (out[32 + i] = n));
  for (let c = 0x41; c <= 0x5a; c++) out[c] = String.fromCharCode(c);
  out[91] = 'bracketleft';
  out[92] = 'backslash';
  out[93] = 'bracketright';
  out[94] = 'asciicircum';
  out[95] = 'underscore';
  out[96] = 'grave';
  for (let c = 0x61; c <= 0x7a; c++) out[c] = String.fromCharCode(c);
  out[123] = 'braceleft';
  out[124] = 'bar';
  out[125] = 'braceright';
  out[126] = 'asciitilde';
  return out;
}

const STANDARD_SPEC: Record<number, string> = {
  ...asciiBase(),
  39: 'quoteright',
  96: 'quoteleft',
  161: 'exclamdown', 162: 'cent', 163: 'sterling', 164: 'fraction', 165: 'yen', 166: 'florin',
  167: 'section', 168: 'currency', 169: 'quotesingle', 170: 'quotedblleft', 171: 'guillemotleft',
  172: 'guilsinglleft', 173: 'guilsinglright', 174: 'fi', 175: 'fl', 177: 'endash', 178: 'dagger',
  179: 'daggerdbl', 180: 'periodcentered', 182: 'paragraph', 183: 'bullet', 184: 'quotesinglbase',
  185: 'quotedblbase', 186: 'quotedblright', 187: 'guillemotright', 188: 'ellipsis',
  189: 'perthousand', 191: 'questiondown', 193: 'grave', 194: 'acute', 195: 'circumflex',
  196: 'tilde', 197: 'macron', 198: 'breve', 199: 'dotaccent', 200: 'dieresis', 202: 'ring',
  203: 'cedilla', 205: 'hungarumlaut', 206: 'ogonek', 207: 'caron', 208: 'emdash', 225: 'AE',
  227: 'ordfeminine', 232: 'Lslash', 233: 'Oslash', 234: 'OE', 235: 'ordmasculine', 241: 'ae',
  245: 'dotlessi', 248: 'lslash', 249: 'oslash', 250: 'oe', 251: 'germandbls',
};

const WINANSI_SPEC: Record<number, string> = {
  ...asciiBase(),
  128: 'Euro', 130: 'quotesinglbase', 131: 'florin', 132: 'quotedblbase', 133: 'ellipsis',
  134: 'dagger', 135: 'daggerdbl', 136: 'circumflex', 137: 'perthousand', 138: 'Scaron',
  139: 'guilsinglleft', 140: 'OE', 142: 'Zcaron', 145: 'quoteleft', 146: 'quoteright',
  147: 'quotedblleft', 148: 'quotedblright', 149: 'bullet', 150: 'endash', 151: 'emdash',
  152: 'tilde', 153: 'trademark', 154: 'scaron', 155: 'guilsinglright', 156: 'oe', 158: 'zcaron',
  159: 'Ydieresis', 160: 'space', 161: 'exclamdown', 162: 'cent', 163: 'sterling', 164: 'currency',
  165: 'yen', 166: 'brokenbar', 167: 'section', 168: 'dieresis', 169: 'copyright',
  170: 'ordfeminine', 171: 'guillemotleft', 172: 'logicalnot', 173: 'hyphen', 174: 'registered',
  175: 'macron', 176: 'degree', 177: 'plusminus', 178: 'twosuperior', 179: 'threesuperior',
  180: 'acute', 181: 'mu', 182: 'paragraph', 183: 'periodcentered', 184: 'cedilla',
  185: 'onesuperior', 186: 'ordmasculine', 187: 'guillemotright', 188: 'onequarter', 189: 'onehalf',
  190: 'threequarters', 191: 'questiondown', 192: 'Agrave', 193: 'Aacute', 194: 'Acircumflex',
  195: 'Atilde', 196: 'Adieresis', 197: 'Aring', 198: 'AE', 199: 'Ccedilla', 200: 'Egrave',
  201: 'Eacute', 202: 'Ecircumflex', 203: 'Edieresis', 204: 'Igrave', 205: 'Iacute',
  206: 'Icircumflex', 207: 'Idieresis', 208: 'Eth', 209: 'Ntilde', 210: 'Ograve', 211: 'Oacute',
  212: 'Ocircumflex', 213: 'Otilde', 214: 'Odieresis', 215: 'multiply', 216: 'Oslash',
  217: 'Ugrave', 218: 'Uacute', 219: 'Ucircumflex', 220: 'Udieresis', 221: 'Yacute', 222: 'Thorn',
  223: 'germandbls', 224: 'agrave', 225: 'aacute', 226: 'acircumflex', 227: 'atilde',
  228: 'adieresis', 229: 'aring', 230: 'ae', 231: 'ccedilla', 232: 'egrave', 233: 'eacute',
  234: 'ecircumflex', 235: 'edieresis', 236: 'igrave', 237: 'iacute', 238: 'icircumflex',
  239: 'idieresis', 240: 'eth', 241: 'ntilde', 242: 'ograve', 243: 'oacute', 244: 'ocircumflex',
  245: 'otilde', 246: 'odieresis', 247: 'divide', 248: 'oslash', 249: 'ugrave', 250: 'uacute',
  251: 'ucircumflex', 252: 'udieresis', 253: 'yacute', 254: 'thorn', 255: 'ydieresis',
};

const MACROMAN_SPEC: Record<number, string> = {
  ...asciiBase(),
  128: 'Adieresis', 129: 'Aring', 130: 'Ccedilla', 131: 'Eacute', 132: 'Ntilde', 133: 'Odieresis',
  134: 'Udieresis', 135: 'aacute', 136: 'agrave', 137: 'acircumflex', 138: 'adieresis',
  139: 'atilde', 140: 'aring', 141: 'ccedilla', 142: 'eacute', 143: 'egrave', 144: 'ecircumflex',
  145: 'edieresis', 146: 'iacute', 147: 'igrave', 148: 'icircumflex', 149: 'idieresis',
  150: 'ntilde', 151: 'oacute', 152: 'ograve', 153: 'ocircumflex', 154: 'odieresis', 155: 'otilde',
  156: 'uacute', 157: 'ugrave', 158: 'ucircumflex', 159: 'udieresis', 160: 'dagger', 161: 'degree',
  162: 'cent', 163: 'sterling', 164: 'section', 165: 'bullet', 166: 'paragraph',
  167: 'germandbls', 168: 'registered', 169: 'copyright', 170: 'trademark', 171: 'acute',
  172: 'dieresis', 173: 'notequal', 174: 'AE', 175: 'Oslash', 176: 'infinity', 177: 'plusminus',
  178: 'lessequal', 179: 'greaterequal', 180: 'yen', 181: 'mu', 182: 'partialdiff',
  183: 'summation', 184: 'product', 185: 'pi', 186: 'integral', 187: 'ordfeminine',
  188: 'ordmasculine', 189: 'Omega', 190: 'ae', 191: 'oslash', 192: 'questiondown',
  193: 'exclamdown', 194: 'logicalnot', 195: 'radical', 196: 'florin', 197: 'approxequal',
  198: 'Delta', 199: 'guillemotleft', 200: 'guillemotright', 201: 'ellipsis', 202: 'space',
  203: 'Agrave', 204: 'Atilde', 205: 'Otilde', 206: 'OE', 207: 'oe', 208: 'endash', 209: 'emdash',
  210: 'quotedblleft', 211: 'quotedblright', 212: 'quoteleft', 213: 'quoteright', 214: 'divide',
  215: 'lozenge', 216: 'ydieresis', 217: 'Ydieresis', 218: 'fraction', 219: 'currency',
  220: 'guilsinglleft', 221: 'guilsinglright', 222: 'fi', 223: 'fl', 224: 'daggerdbl',
  225: 'periodcentered', 226: 'quotesinglbase', 227: 'quotedblbase', 228: 'perthousand',
  229: 'Acircumflex', 230: 'Ecircumflex', 231: 'Aacute', 232: 'Edieresis', 233: 'Egrave',
  234: 'Iacute', 235: 'Icircumflex', 236: 'Idieresis', 237: 'Igrave', 238: 'Oacute',
  239: 'Ocircumflex', 240: 'apple', 241: 'Ograve', 242: 'Uacute', 243: 'Ucircumflex',
  244: 'Ugrave', 245: 'dotlessi', 246: 'circumflex', 247: 'tilde', 248: 'macron', 249: 'breve',
  250: 'dotaccent', 251: 'ring', 252: 'cedilla', 253: 'hungarumlaut', 254: 'ogonek', 255: 'caron',
};

export const StandardEncoding = buildTable(STANDARD_SPEC);
export const WinAnsiEncoding = buildTable(WINANSI_SPEC);
export const MacRomanEncoding = buildTable(MACROMAN_SPEC);

export function baseEncodingByName(name: string | undefined): (string | undefined)[] | null {
  switch (name) {
    case 'WinAnsiEncoding':
      return WinAnsiEncoding;
    case 'MacRomanEncoding':
      return MacRomanEncoding;
    case 'StandardEncoding':
    case 'MacExpertEncoding': // not modelled; Standard is a closer guess than nothing
      return StandardEncoding;
    default:
      return null;
  }
}
