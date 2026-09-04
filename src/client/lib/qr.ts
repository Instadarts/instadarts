// A QR encoder, so a phone can be pointed at the pairing code instead of made to type it.
//
// Written here rather than taken from a package, which is a deliberate trade: this is a solved,
// rigidly specified problem, and the cost of owning it is that the spec has to be got right once.
// The gain is that the one thing a camera phone is unambiguously good at costs the project no
// dependency at all. See `tests/unit/qr.test.ts`, which reads the matrix back with an independently
// written reader rather than trusting this file's own idea of what it produced.
//
// **Scope, on purpose.** Byte mode, error correction level M, versions 1 to 10. That is 213 bytes,
// against a payload — `https://host:port/scorer?code=ABC123` — that is realistically under 60. The
// unsupported half of the spec (numeric, alphanumeric and kanji modes; ECI; versions 11 to 40;
// structured append) is absent rather than stubbed, because a mode nothing calls is a mode nothing
// tests. `encodeQr` returns null when a payload will not fit, and the caller shows the code alone.
//
// Level M corrects roughly 15% of the symbol. That is the usual choice for a URL and the right one
// here: this is read off a bright screen at arm's length, not off a printed label on a crate.
//
// Terms, since they are the spec's and not obvious: a **codeword** is one byte. A **module** is one
// square of the matrix. **Function patterns** are the fixed furniture — finders, timing, alignment —
// which carry no data and must be skipped when data is placed and never masked.

/** One encoded symbol. `modules[row][col]`, true meaning dark. */
export interface QrMatrix {
  /** Modules per side. Always `17 + 4 * version`, so 21 at version 1 and 57 at version 10. */
  size: number;
  modules: boolean[][];
}

/** Versions we implement, smallest first. Index 0 is unused so `BLOCKS[v]` reads by version. */
const MIN_VERSION = 1;
const MAX_VERSION = 10;

/**
 * How each version's data is split into error-correction blocks, at level M.
 *
 * `ec` is the error-correction codewords **per block**; `data` lists the data codewords in each
 * block, in order. Two different lengths in one version is normal and is why interleaving exists:
 * version 8 is two blocks of 38 and two of 39.
 *
 * These are transcribed from the standard's table rather than derived. The invariant that catches a
 * typo is that `sum(data) + ec * data.length` must equal the version's total codeword count, and
 * the test asserts exactly that for all ten.
 */
const BLOCKS: { ec: number; data: number[] }[] = [
  { ec: 0, data: [] }, // version 0 does not exist
  { ec: 10, data: [16] },
  { ec: 16, data: [28] },
  { ec: 26, data: [44] },
  { ec: 18, data: [32, 32] },
  { ec: 24, data: [43, 43] },
  { ec: 16, data: [27, 27, 27, 27] },
  { ec: 18, data: [31, 31, 31, 31] },
  { ec: 22, data: [38, 38, 39, 39] },
  { ec: 22, data: [36, 36, 36, 37, 37] },
  { ec: 26, data: [43, 43, 43, 43, 44] },
];

/**
 * Where alignment patterns are centred, per version. Every pairing of these coordinates gets one,
 * except the three that would sit on a finder pattern.
 *
 * Version 1 has none, which is why it is empty rather than absent.
 */
const ALIGNMENT: number[][] = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

/**
 * Bits of padding after the last codeword, per version.
 *
 * The matrix is not a whole number of codewords: versions 2 to 6 have seven modules left over. They
 * are written as zeroes and carry nothing — but they are still masked, so they cannot simply be
 * skipped.
 */
const REMAINDER_BITS = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0];

/** Level M, as the two bits that go into the format information. */
const EC_LEVEL_M = 0b00;

// ============================================================
// GF(256) — the arithmetic error correction is done in
// ============================================================
//
// The field is GF(2^8) modulo 0x11D, the primitive polynomial the QR standard names, with 2 as the
// generator. Multiplication is done by adding logarithms, which is why both tables exist; addition
// in this field is XOR, which is why there is no table for it.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    // Reduce modulo the primitive polynomial the moment the value leaves eight bits.
    if (x & 0x100) x ^= 0x11d;
  }
  // The top half repeats the bottom, so a sum of two logarithms never has to be reduced by hand.
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/**
 * The generator polynomial for `degree` error-correction codewords: (x - 2^0)(x - 2^1)…
 *
 * Built up rather than tabulated. The published tables for each degree are what the test checks
 * this against, since a wrong generator produces a symbol that looks perfectly well-formed and
 * fails to correct anything.
 */
function generatorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** The remainder of `data` divided by the generator — which is exactly the EC codewords. */
function errorCorrection(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = generatorPoly(ecCount);
  const remainder = new Uint8Array(ecCount);

  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.copyWithin(0, 1);
    remainder[ecCount - 1] = 0;
    for (let i = 0; i < ecCount; i++) remainder[i] ^= gfMul(gen[i + 1], factor);
  }
  return remainder;
}

// ============================================================
// Bits in, codewords out
// ============================================================

/** A bit string being built up. QR is bit-oriented and its fields do not land on byte boundaries. */
class BitBuffer {
  private bits: number[] = [];

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }

  get length(): number {
    return this.bits.length;
  }

  /** Zero-padded up to a whole number of bytes. */
  toBytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, i) => {
      if (bit) out[i >> 3] |= 0x80 >>> (i & 7);
    });
    return out;
  }
}

/**
 * The smallest version whose data capacity holds `byteLength` bytes in byte mode, or null.
 *
 * The header is four bits of mode plus the character count, and the count field widens from 8 bits
 * to 16 at version 10 — which is why capacity is worked out here rather than tabulated: the same
 * table would otherwise need two columns and a note.
 */
function chooseVersion(byteLength: number): number | null {
  for (let version = MIN_VERSION; version <= MAX_VERSION; version++) {
    const dataCodewords = BLOCKS[version].data.reduce((sum, n) => sum + n, 0);
    const headerBits = 4 + (version < 10 ? 8 : 16);
    if (byteLength * 8 + headerBits <= dataCodewords * 8) return version;
  }
  return null;
}

/** Mode indicator, length, payload, terminator, and the alternating pad the spec specifies. */
function buildCodewords(bytes: Uint8Array, version: number): Uint8Array {
  const dataCodewords = BLOCKS[version].data.reduce((sum, n) => sum + n, 0);
  const buffer = new BitBuffer();

  buffer.push(0b0100, 4); // byte mode
  buffer.push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) buffer.push(byte, 8);

  // Terminator: up to four zero bits, fewer if the capacity is nearly full.
  buffer.push(0, Math.min(4, dataCodewords * 8 - buffer.length));
  // Then to a byte boundary.
  if (buffer.length % 8 !== 0) buffer.push(0, 8 - (buffer.length % 8));

  const out = new Uint8Array(dataCodewords);
  out.set(buffer.toBytes());
  // The two pad codewords the standard names, alternating, for whatever capacity is left over.
  for (let i = buffer.length / 8; i < dataCodewords; i++) {
    out[i] = (i - buffer.length / 8) % 2 === 0 ? 0xec : 0x11;
  }
  return out;
}

/**
 * Split into blocks, compute each block's EC, and interleave both.
 *
 * Interleaving is what makes the error correction worth having: a scratch or a thumb over the symbol
 * damages a contiguous run of modules, and spreading each block through the whole means that run is
 * shared between blocks instead of destroying one of them.
 */
function interleave(codewords: Uint8Array, version: number): Uint8Array {
  const { ec: ecCount, data: layout } = BLOCKS[version];

  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const size of layout) {
    const block = codewords.subarray(offset, offset + size);
    offset += size;
    dataBlocks.push(block);
    ecBlocks.push(errorCorrection(block, ecCount));
  }

  const out: number[] = [];
  // Data first, one codeword from each block in turn. Shorter blocks simply run out, which is why
  // the loop runs to the longest and skips rather than assuming a rectangle.
  const longest = Math.max(...layout);
  for (let i = 0; i < longest; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
  }
  // Then every block's EC, the same way. These are all the same length.
  for (let i = 0; i < ecCount; i++) {
    for (const block of ecBlocks) out.push(block[i]);
  }
  return new Uint8Array(out);
}

// ============================================================
// The matrix
// ============================================================

/**
 * The fixed furniture, and a parallel record of which modules it occupies.
 *
 * The second matrix is not redundant with "is this module dark": a light module of a finder pattern
 * is still not somewhere data may go, and still must not be masked.
 */
function functionPatterns(version: number): { modules: boolean[][]; reserved: boolean[][] } {
  const size = 17 + 4 * version;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

  const set = (row: number, col: number, dark: boolean) => {
    modules[row][col] = dark;
    reserved[row][col] = true;
  };

  // Three finder patterns, each with the light separator that surrounds it. Drawn one module wider
  // in every direction so the separator falls out of the same loop; the out-of-range writes are
  // dropped rather than guarded at each call site.
  for (const [baseRow, baseCol] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const row = baseRow + dr;
        const col = baseCol + dc;
        if (row < 0 || row >= size || col < 0 || col >= size) continue;
        const ring = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
        // Rings 0-1 are the dark centre, ring 2 the light gap, ring 3 the dark border.
        set(row, col, ring !== 2 && ring <= 3);
      }
    }
  }

  // Timing patterns: alternating modules joining the finders, starting dark.
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  // Alignment patterns at every pairing of the version's coordinates, except the three corners
  // already occupied by a finder.
  const centres = ALIGNMENT[version];
  for (const row of centres) {
    for (const col of centres) {
      const onFinder =
        (row <= 8 && col <= 8) ||
        (row <= 8 && col >= size - 9) ||
        (row >= size - 9 && col <= 8);
      if (onFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          set(row + dr, col + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  // The one module that is always dark, and is not part of anything else.
  set(size - 8, 8, true);

  // Where the format information will go. Reserved now, written once a mask has been chosen.
  for (let i = 0; i < 9; i++) {
    if (i !== 6) { reserved[8][i] = true; reserved[i][8] = true; }
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }

  // Version information, for versions 7 and up: two 3×6 blocks by the top-right and bottom-left
  // finders, holding the version number and its BCH check bits.
  if (version >= 7) {
    const bits = versionInfoBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const row = Math.floor(i / 3);
      const col = i % 3;
      set(size - 11 + col, row, dark);
      set(row, size - 11 + col, dark);
    }
  }

  return { modules, reserved };
}

/**
 * The 18-bit version information: six bits of version, then a BCH(18,6) remainder.
 *
 * Unlike the format information there is no final XOR — the version number is large enough that the
 * all-zero case the mask exists to avoid cannot arise.
 */
function versionInfoBits(version: number): number {
  let remainder = version;
  for (let i = 0; i < 12; i++) {
    remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  }
  return (version << 12) | remainder;
}

/**
 * The 15-bit format information: EC level and mask, a BCH(15,5) remainder, and a fixed XOR.
 *
 * The XOR is what stops an all-light symbol: without it, level M with mask 0 would encode as fifteen
 * zeroes and leave a reader nothing to synchronise on.
 */
function formatInfoBits(mask: number): number {
  const data = (EC_LEVEL_M << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i++) {
    remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  }
  return ((data << 10) | remainder) ^ 0x5412;
}

/** The eight mask patterns, by number. True means this module is inverted. */
const MASKS: ((row: number, col: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/**
 * Lay the codewords into the matrix, two columns at a time from the bottom right.
 *
 * The walk is the spec's: upward then downward in alternating strips, right module before left
 * within each row, skipping anything a function pattern already owns. Column 6 is skipped entirely —
 * it is the vertical timing pattern, and the strips are counted as though it were not there.
 */
function placeData(modules: boolean[][], reserved: boolean[][], bits: Uint8Array, size: number): void {
  let bitIndex = 0;
  const nextBit = (): boolean => {
    if (bitIndex >= bits.length * 8) return false; // remainder bits: written, carrying nothing
    const bit = (bits[bitIndex >> 3] >>> (7 - (bitIndex & 7))) & 1;
    bitIndex++;
    return bit === 1;
  };

  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // step over the timing column
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (reserved[row][col]) continue;
        modules[row][col] = nextBit();
      }
    }
    upward = !upward;
  }
}

/** Write the format information for a chosen mask, in both of the places it is duplicated. */
function placeFormatInfo(modules: boolean[][], size: number, mask: number): void {
  const bits = formatInfoBits(mask);
  for (let i = 0; i < 15; i++) {
    // **Most significant bit first.** The standard numbers these 14 down to 0 and puts bit 14 at
    // the first position of each copy, so walking the positions forward means walking the bits
    // backward. Getting this the other way round produces a symbol that looks entirely correct,
    // whose fifteen format modules are all individually plausible, and which no phone can read:
    // a scanner reads them in the standard's order, fails the BCH check, and gives up.
    const dark = ((bits >>> (14 - i)) & 1) === 1;
    // The copy around the top-left finder, which is split by the timing pattern.
    if (i < 6) modules[8][i] = dark;
    else if (i === 6) modules[8][7] = dark;
    else if (i === 7) modules[8][8] = dark;
    else if (i === 8) modules[7][8] = dark;
    else modules[14 - i][8] = dark;

    // The copy split between the other two finders: seven modules climbing from the bottom edge,
    // then eight running to the right edge. Seven and not eight — the module directly above that
    // column is the always-dark one, which is function furniture rather than a format bit, and
    // writing a fifteenth bit here would put a light module where every symbol has a dark one.
    if (i < 7) modules[size - 1 - i][8] = dark;
    else modules[8][size - 15 + i] = dark;
  }
}

/**
 * How bad a masked symbol is, by the standard's four rules. Lower is better.
 *
 * The rules exist to keep a reader from being confused: long same-coloured runs and 2×2 blocks make
 * the grid hard to lock onto, the 1:1:3:1:1 pattern of rule three is the finder pattern's own
 * signature appearing where there is no finder, and rule four pushes the symbol towards half dark.
 */
function penalty(modules: boolean[][], size: number): number {
  let score = 0;

  // Rules one and three, along every row and every column.
  for (let i = 0; i < size; i++) {
    for (const line of [modules[i], modules.map((row) => row[i])]) {
      let runColour = line[0];
      let runLength = 1;
      for (let j = 1; j < size; j++) {
        if (line[j] === runColour) {
          runLength++;
        } else {
          if (runLength >= 5) score += 3 + (runLength - 5);
          runColour = line[j];
          runLength = 1;
        }
      }
      if (runLength >= 5) score += 3 + (runLength - 5);

      // 1:1:3:1:1 with four light modules on one side, in either direction.
      for (let j = 0; j + 11 <= size; j++) {
        const window = line.slice(j, j + 11);
        if (matches(window, FINDER_LIKE) || matches(window, FINDER_LIKE_REVERSED)) score += 40;
      }
    }
  }

  // Rule two: every 2×2 of one colour.
  for (let row = 0; row + 1 < size; row++) {
    for (let col = 0; col + 1 < size; col++) {
      const first = modules[row][col];
      if (modules[row][col + 1] === first && modules[row + 1][col] === first && modules[row + 1][col + 1] === first) {
        score += 3;
      }
    }
  }

  // Rule four: how far the proportion of dark modules is from half, in steps of 5%.
  let dark = 0;
  for (const row of modules) for (const module of row) if (module) dark++;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

const FINDER_LIKE = [true, false, true, true, true, false, true, false, false, false, false];
const FINDER_LIKE_REVERSED = [false, false, false, false, true, false, true, true, true, false, true];

function matches(window: boolean[], pattern: boolean[]): boolean {
  for (let i = 0; i < pattern.length; i++) if (window[i] !== pattern[i]) return false;
  return true;
}

// ============================================================
// The one thing this module is for
// ============================================================

/**
 * Encode `text` as a QR symbol, or null if it will not fit in the versions implemented here.
 *
 * Null is a real answer rather than a failure: a deployment reached at an unusually long address
 * pushes the payload past version 10, and the caller's job then is to show the pairing code on its
 * own — which still works, and is what happened before this file existed.
 */
export function encodeQr(text: string): QrMatrix | null {
  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length);
  if (version === null) return null;

  const size = 17 + 4 * version;
  const codewords = interleave(buildCodewords(bytes, version), version);

  // The remainder bits ride along as zeroes: `placeData` reads past the end and gets false, which is
  // what the spec asks for, and they are then masked like any other module.
  const withRemainder = new Uint8Array(codewords.length + Math.ceil(REMAINDER_BITS[version] / 8));
  withRemainder.set(codewords);

  const { modules: base, reserved } = functionPatterns(version);
  placeData(base, reserved, withRemainder, size);

  // Every mask is applied to a fresh copy and scored; the best one wins. Eight full evaluations is
  // more work than choosing analytically, and it is what the standard actually specifies.
  let best: { modules: boolean[][]; score: number } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = base.map((row) => [...row]);
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        if (!reserved[row][col] && MASKS[mask](row, col)) candidate[row][col] = !candidate[row][col];
      }
    }
    placeFormatInfo(candidate, size, mask);
    const score = penalty(candidate, size);
    if (!best || score < best.score) best = { modules: candidate, score };
  }

  return { size, modules: best!.modules };
}
