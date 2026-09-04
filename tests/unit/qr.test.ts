// Reading back what `lib/qr.ts` produced, with a reader written from the specification rather than
// from that file.
//
// The point of the exercise is that nothing here imports the encoder's internals. The reader below
// re-derives the mask functions, the function-pattern layout, the placement walk and the
// interleaving from the standard, so an encoder that is self-consistently wrong still fails: a
// shared helper would have agreed with itself.
//
// Two of the checks do not depend on transcribed tables at all, which matters because a table is
// exactly what is easy to get wrong twice:
//
//   · a Reed-Solomon codeword is **defined** by evaluating to zero at α^0…α^(n-1), so that is
//     asserted directly rather than compared against remembered generator coefficients.
//   · the block layout is cross-checked against the standard's total codeword count per version,
//     which is a number from a different table than the one being checked.

import { describe, it, expect } from 'vitest';
import { encodeQr, type QrMatrix } from '../../src/client/lib/qr';

// ============================================================
// GF(256), independently
// ============================================================

const EXP: number[] = [];
const LOG: number[] = [];
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x = x << 1;
    if (x > 255) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Total codewords (data + error correction) per version. A different table to the one under test. */
const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

/** Level M block layout, transcribed independently for the cross-check below. */
const LAYOUT: { ec: number; data: number[] }[] = [
  { ec: 0, data: [] },
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

const ALIGNMENT = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

// ============================================================
// The reader
// ============================================================

/** Which modules a reader knows carry no data, worked out from the version alone. */
function functionModules(version: number): boolean[][] {
  const size = 17 + 4 * version;
  const taken = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const claim = (r: number, c: number) => {
    if (r >= 0 && r < size && c >= 0 && c < size) taken[r][c] = true;
  };

  for (const [br, bc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) claim(br + dr, bc + dc);
  }
  for (let i = 0; i < size; i++) { claim(6, i); claim(i, 6); }

  for (const r of ALIGNMENT[version]) {
    for (const c of ALIGNMENT[version]) {
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) claim(r + dr, c + dc);
    }
  }

  claim(size - 8, 8);
  for (let i = 0; i < 9; i++) { claim(8, i); claim(i, 8); }
  for (let i = 0; i < 8; i++) { claim(8, size - 1 - i); claim(size - 1 - i, 8); }
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      claim(size - 11 + (i % 3), Math.floor(i / 3));
      claim(Math.floor(i / 3), size - 11 + (i % 3));
    }
  }
  return taken;
}

const MASK = [
  (r: number, c: number) => (r + c) % 2 === 0,
  (r: number, _c: number) => r % 2 === 0,
  (_r: number, c: number) => c % 3 === 0,
  (r: number, c: number) => (r + c) % 3 === 0,
  (r: number, c: number) => (((r / 2) | 0) + ((c / 3) | 0)) % 2 === 0,
  (r: number, c: number) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r: number, c: number) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r: number, c: number) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** The mask number the symbol declares, read out of the format information and un-XORed. */
function readMask({ size, modules }: QrMatrix): { mask: number; ecLevel: number } {
  let raw = 0;
  for (let i = 0; i < 15; i++) {
    let bit: boolean;
    if (i < 6) bit = modules[8][i];
    else if (i === 6) bit = modules[8][7];
    else if (i === 7) bit = modules[8][8];
    else if (i === 8) bit = modules[7][8];
    else bit = modules[14 - i][8];
    if (bit) raw |= 1 << (14 - i);
  }
  const bits = raw ^ 0x5412;
  return { ecLevel: (bits >>> 13) & 0b11, mask: (bits >>> 10) & 0b111 };
}

/** Every codeword in the symbol, in the order the walk lays them down. */
function readCodewords(qr: QrMatrix, version: number): number[] {
  const { size, modules } = qr;
  const { mask } = readMask(qr);
  const taken = functionModules(version);

  const bits: number[] = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (taken[row][col]) continue;
        const dark = MASK[mask](row, col) ? !modules[row][col] : modules[row][col];
        bits.push(dark ? 1 : 0);
      }
    }
    upward = !upward;
  }

  const codewords: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }
  return codewords;
}

/** Undo the interleaving: the codeword stream back into per-block data and error correction. */
function deinterleave(codewords: number[], version: number): { data: number[][]; ec: number[][] } {
  const { ec: ecCount, data: sizes } = LAYOUT[version];
  const data: number[][] = sizes.map(() => []);
  const ec: number[][] = sizes.map(() => []);

  let at = 0;
  for (let i = 0; i < Math.max(...sizes); i++) {
    for (let b = 0; b < sizes.length; b++) if (i < sizes[b]) data[b].push(codewords[at++]);
  }
  for (let i = 0; i < ecCount; i++) {
    for (let b = 0; b < sizes.length; b++) ec[b].push(codewords[at++]);
  }
  return { data, ec };
}

/** Mode, length and payload out of a block-joined data stream. */
function readPayload(data: number[][], version: number): string {
  const bytes = data.flat();
  let bit = 0;
  const take = (n: number) => {
    let out = 0;
    for (let i = 0; i < n; i++, bit++) out = (out << 1) | ((bytes[bit >> 3] >>> (7 - (bit & 7))) & 1);
    return out;
  };
  const mode = take(4);
  expect(mode).toBe(0b0100); // byte mode
  const length = take(version < 10 ? 8 : 16);
  const payload = new Uint8Array(length);
  for (let i = 0; i < length; i++) payload[i] = take(8);
  return new TextDecoder().decode(payload);
}

/** The defining property of a Reed-Solomon codeword: it vanishes at α^0 … α^(n-1). */
function isValidCodeword(block: number[], ecCount: number): boolean {
  for (let i = 0; i < ecCount; i++) {
    let sum = 0;
    for (const byte of block) sum = mul(sum, EXP[i]) ^ byte;
    if (sum !== 0) return false;
  }
  return true;
}

function versionOf(qr: QrMatrix): number {
  return (qr.size - 17) / 4;
}

/** The 15 format bits as written around the top-left finder. */
function formatBits({ modules }: QrMatrix): number {
  let raw = 0;
  for (let i = 0; i < 15; i++) {
    let bit: boolean;
    if (i < 6) bit = modules[8][i];
    else if (i === 6) bit = modules[8][7];
    else if (i === 7) bit = modules[8][8];
    else if (i === 8) bit = modules[7][8];
    else bit = modules[14 - i][8];
    if (bit) raw |= 1 << (14 - i);
  }
  return raw;
}

/** The same 15 bits from the other copy: seven up the bottom-left, eight across the top-right. */
function secondFormatBits({ size, modules }: QrMatrix): number {
  let raw = 0;
  for (let i = 0; i < 15; i++) {
    const bit = i < 7 ? modules[size - 1 - i][8] : modules[8][size - 15 + i];
    if (bit) raw |= 1 << (14 - i);
  }
  return raw;
}

/** Both copies of the 18-bit version information, for versions 7 and up. */
function versionBits({ size, modules }: QrMatrix): [number, number] {
  let bottomLeft = 0;
  let topRight = 0;
  for (let i = 0; i < 18; i++) {
    const row = Math.floor(i / 3);
    const col = i % 3;
    if (modules[size - 11 + col][row]) bottomLeft |= 1 << i;
    if (modules[row][size - 11 + col]) topRight |= 1 << i;
  }
  return [bottomLeft, topRight];
}

/** The whole reader, end to end. */
function decode(qr: QrMatrix): string {
  const version = versionOf(qr);
  const codewords = readCodewords(qr, version);
  const { data, ec } = deinterleave(codewords, version);
  for (let b = 0; b < data.length; b++) {
    expect(isValidCodeword([...data[b], ...ec[b]], LAYOUT[version].ec)).toBe(true);
  }
  return readPayload(data, version);
}

// ============================================================

describe('QR encoding', () => {
  it('round-trips the pairing url it exists for', () => {
    const url = 'http://192.168.1.50:3000/scorer?code=K7QM2P';
    const qr = encodeQr(url)!;
    expect(qr).not.toBeNull();
    expect(decode(qr)).toBe(url);
  });

  it('round-trips at every version it claims to support', () => {
    // One payload per version, sized to land just inside that version's byte capacity.
    const capacities = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
    for (let version = 1; version <= 10; version++) {
      const text = 'A'.repeat(capacities[version - 1]);
      const qr = encodeQr(text)!;
      expect(qr, `version ${version} should encode`).not.toBeNull();
      expect(versionOf(qr), `${text.length} bytes should pick version ${version}`).toBe(version);
      expect(decode(qr)).toBe(text);
    }
  });

  it('picks the smallest version that fits, and refuses what does not', () => {
    expect(versionOf(encodeQr('A'.repeat(14))!)).toBe(1);
    expect(versionOf(encodeQr('A'.repeat(15))!)).toBe(2);
    expect(versionOf(encodeQr('A'.repeat(213))!)).toBe(10);
    // Past version 10 is a real answer, not a throw: the caller shows the code on its own.
    expect(encodeQr('A'.repeat(214))).toBeNull();
  });

  it('counts a multi-byte character by its utf-8 length, not its js length', () => {
    // Two js characters, four utf-8 bytes. A length taken from `text.length` would encode a symbol
    // claiming two bytes and lose half the payload.
    const text = '🎯';
    expect(text.length).toBe(2);
    expect(decode(encodeQr(text)!)).toBe(text);
  });

  it('declares error correction level M', () => {
    // 0b00 is the level's two-bit code. Getting this wrong makes every symbol unreadable, since a
    // reader uses it to work out the block layout before it can touch the data.
    expect(readMask(encodeQr('hello')!).ecLevel).toBe(0b00);
  });

  it('block layout agrees with the standard total codeword count', () => {
    // The cross-check that catches a mistyped table: these totals come from a different table than
    // the block sizes, so a wrong block size cannot satisfy both.
    for (let version = 1; version <= 10; version++) {
      const { ec, data } = LAYOUT[version];
      const total = data.reduce((sum, n) => sum + n, 0) + ec * data.length;
      expect(total, `version ${version}`).toBe(TOTAL_CODEWORDS[version]);
    }
  });

  it('places the three finder patterns and the dark module', () => {
    const { size, modules } = encodeQr('http://example.com/scorer?code=ABC123')!;
    for (const [br, bc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
      for (let dr = 0; dr < 7; dr++) {
        for (let dc = 0; dc < 7; dc++) {
          const ring = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
          expect(modules[br + dr][bc + dc], `finder at ${br},${bc} offset ${dr},${dc}`).toBe(ring !== 2);
        }
      }
    }
    // Always dark, in every symbol of every version.
    expect(modules[size - 8][8]).toBe(true);
  });

  it('alternates the timing patterns', () => {
    const { size, modules } = encodeQr('timing')!;
    for (let i = 8; i < size - 8; i++) {
      expect(modules[6][i], `row timing at ${i}`).toBe(i % 2 === 0);
      expect(modules[i][6], `column timing at ${i}`).toBe(i % 2 === 0);
    }
  });

  // The reader above extracts the mask from the format information but never checks its BCH digits,
  // and only ever looks at the first of the two copies. A real scanner does both — so a symbol that
  // round-trips here could still be rejected by a phone. These close that gap.

  it('writes format information that is a valid BCH codeword', () => {
    // Divisibility by the generator is what "valid BCH" means, so this is checked by dividing
    // rather than by comparing against a remembered table of the 32 legal format strings.
    const raw = formatBits(encodeQr('http://192.168.1.50:3000/scorer?code=K7QM2P')!) ^ 0x5412;
    let remainder = raw;
    for (let bit = 14; bit >= 10; bit--) {
      if ((remainder >>> bit) & 1) remainder ^= 0x537 << (bit - 10);
    }
    expect(remainder, 'format information must divide by the BCH generator').toBe(0);
  });

  it('writes both copies of the format information identically', () => {
    // A scanner may read either copy; a symbol where they disagree is one that works on some
    // phones and not others, which is the worst way for this to be wrong.
    for (const text of ['short', 'A'.repeat(120), 'A'.repeat(213)]) {
      const qr = encodeQr(text)!;
      expect(formatBits(qr), `${text.length} bytes`).toBe(secondFormatBits(qr));
    }
  });

  it('writes version information that is a valid BCH codeword, in both copies', () => {
    // Only versions 7 and up carry it at all.
    for (const bytes of [122, 152, 180, 213]) {
      const qr = encodeQr('A'.repeat(bytes))!;
      const version = versionOf(qr);
      expect(version).toBeGreaterThanOrEqual(7);

      const [first, second] = versionBits(qr);
      expect(first, `version ${version} copies disagree`).toBe(second);
      expect(first >>> 12, `version ${version} should state its own number`).toBe(version);

      let remainder = first;
      for (let bit = 17; bit >= 12; bit--) {
        if ((remainder >>> bit) & 1) remainder ^= 0x1f25 << (bit - 12);
      }
      expect(remainder, `version ${version} information must divide by its BCH generator`).toBe(0);
    }
  });

  it('is square, and sized by its version', () => {
    const qr = encodeQr('size')!;
    expect(qr.modules).toHaveLength(qr.size);
    for (const row of qr.modules) expect(row).toHaveLength(qr.size);
    expect(qr.size).toBe(17 + 4 * versionOf(qr));
  });
});
