/** Bit readers: least significant bit first (deflate, brotli, lzw) and most significant first (bzip2). */
import type { Output } from "./bytes.ts";

/**
 * Reads bits least significant first, as deflate, brotli and Unix compress pack them. Past the end
 * it reads zeros for a few bytes, so a peek for the longest code works on the last short one;
 * `checkEnd` turns a read that really went past the input into an error.
 */
export class LsbReader {
  /** The input. */
  readonly data: Uint8Array;
  /** Index of the next byte to load. */
  pos: number;
  /** Loaded bits, the next one lowest. */
  buf = 0;
  /** How many bits `buf` holds. */
  count = 0;
  /** Where errors go, with the output so far. */
  readonly out: Output;

  /**
   * @param data - The input.
   * @param start - Offset of the first byte to read.
   * @param out - The output, for errors.
   */
  constructor(data: Uint8Array, start: number, out: Output) {
    this.data = data;
    this.pos = start;
    this.out = out;
  }

  /**
   * Loads bytes until `buf` holds at least `n` bits, at most 24.
   *
   * @param n - Bits needed, 0 to 24.
   */
  need(n: number): void {
    while (this.count < n) {
      const { pos } = this;
      if (pos < this.data.length) this.buf |= this.data[pos]! << this.count;
      else if (pos >= this.data.length + 4) throw this.out.fail("unexpected end of data");
      this.pos = pos + 1;
      this.count += 8;
    }
  }

  /**
   * Takes `n` bits, the first one lowest.
   *
   * @param n - Bits to take, 0 to 24.
   * @returns {number} Their value.
   */
  bits(n: number): number {
    if (n === 0) return 0;
    this.need(n);
    const value = this.buf & ((1 << n) - 1);
    this.buf >>>= n;
    this.count -= n;
    return value;
  }

  /**
   * Drops the bits up to the next byte boundary.
   */
  align(): void {
    const drop = this.count & 7;
    this.buf >>>= drop;
    this.count -= drop;
  }

  /**
   * The offset of the next unread byte, once aligned: what was loaded but not used goes back.
   *
   * @returns {number} The byte offset.
   */
  byteOffset(): number {
    return this.pos - (this.count >>> 3);
  }

  /**
   * Bits read so far from `start`, counting the ones loaded but not used as unread.
   *
   * @returns {number} The bit offset into `data`.
   */
  bitOffset(): number {
    return this.pos * 8 - this.count;
  }

  /**
   * Throws when the bits taken so far run past the input: the zeros read there were never written.
   */
  checkEnd(): void {
    if (this.pos > this.data.length && this.bitOffset() > this.data.length * 8) {
      throw this.out.fail("unexpected end of data");
    }
  }
}

/**
 * Reads bits most significant first, as bzip2 packs them.
 */
export class MsbReader {
  /** The input. */
  readonly data: Uint8Array;
  /** Index of the next byte to load. */
  pos: number;
  /** Loaded bits, the next one highest of the `count` low bits. */
  buf = 0;
  /** How many bits `buf` holds. */
  count = 0;
  /** Where errors go, with the output so far. */
  readonly out: Output;

  /**
   * @param data - The input.
   * @param start - Offset of the first byte to read.
   * @param out - The output, for errors.
   */
  constructor(data: Uint8Array, start: number, out: Output) {
    this.data = data;
    this.pos = start;
    this.out = out;
  }

  /**
   * Takes `n` bits, the first one highest.
   *
   * @param n - Bits to take, 1 to 24.
   * @returns {number} Their value.
   */
  bits(n: number): number {
    while (this.count < n) {
      if (this.pos >= this.data.length) throw this.out.fail("unexpected end of data");
      this.buf = ((this.buf << 8) | this.data[this.pos++]!) >>> 0;
      this.count += 8;
    }
    this.count -= n;
    return (this.buf >>> this.count) & ((1 << n) - 1);
  }

  /**
   * Takes one bit.
   *
   * @returns {number} 0 or 1.
   */
  bit(): number {
    if (this.count === 0) {
      if (this.pos >= this.data.length) throw this.out.fail("unexpected end of data");
      this.buf = this.data[this.pos++]!;
      this.count = 8;
    }
    this.count--;
    return (this.buf >>> this.count) & 1;
  }

  /**
   * Takes 32 bits as an unsigned integer.
   *
   * @returns {number} The value.
   */
  bits32(): number {
    return ((this.bits(16) << 16) | this.bits(16)) >>> 0;
  }

  /**
   * Drops the bits up to the next byte boundary.
   */
  align(): void {
    this.count -= this.count & 7;
  }

  /**
   * The offset of the next unread byte once aligned.
   *
   * @returns {number} The byte offset.
   */
  byteOffset(): number {
    return this.pos - (this.count >>> 3);
  }
}

/**
 * Builds a decoding table for a prefix code given as code lengths, for a reader that takes the
 * code's bits first bit lowest (deflate, brotli). Each entry holds `symbol << 4 | length`; an
 * entry for a bit pattern no code starts with is -1. An over-subscribed set is refused, an
 * incomplete one decodes the codes it has.
 *
 * @param lengths - Code length per symbol, 0 for none.
 * @param count - How many symbols of `lengths` to use.
 * @returns {{ table: Int32Array; bits: number } | undefined} The table and its index width, or
 * nothing when the lengths over-subscribe the code space.
 */
export function lsbDecoder(
  lengths: ArrayLike<number>,
  count: number,
): { table: Int32Array; bits: number } | undefined {
  let max = 0;
  const counts = new Uint16Array(16);
  for (let symbol = 0; symbol < count; symbol++) {
    const length = lengths[symbol]!;
    counts[length]!++;
    if (length > max) max = length;
  }
  counts[0] = 0;
  let left = 1;
  for (let length = 1; length <= 15; length++) {
    left = left * 2 - counts[length]!;
    if (left < 0) return undefined;
  }
  const bits = Math.max(max, 1);
  const table = new Int32Array(1 << bits).fill(-1);
  const next = new Uint16Array(16);
  let code = 0;
  for (let length = 1; length <= 15; length++) {
    code = (code + counts[length - 1]!) << 1;
    next[length] = code;
  }
  for (let symbol = 0; symbol < count; symbol++) {
    const length = lengths[symbol]!;
    if (length === 0) continue;
    const reversed = reverseBits(next[length]!++, length);
    const entry = (symbol << 4) | length;
    for (let index = reversed; index < table.length; index += 1 << length) table[index] = entry;
  }
  return { table, bits };
}

/**
 * Reverses the low `length` bits of a code.
 *
 * @param code - The code.
 * @param length - How many bits it has.
 * @returns {number} The bits in the other order.
 */
export function reverseBits(code: number, length: number): number {
  let reversed = 0;
  for (let i = 0; i < length; i++) {
    reversed = (reversed << 1) | (code & 1);
    code >>>= 1;
  }
  return reversed;
}

/**
 * Reads one symbol through a table from `lsbDecoder`.
 *
 * @param reader - The bit reader.
 * @param decoder - The table and its width.
 * @param decoder.table - Entries of `symbol << 4 | length`.
 * @param decoder.bits - Index width.
 * @returns {number} The symbol.
 */
export function readSymbol(
  reader: LsbReader,
  decoder: Readonly<{ table: Int32Array; bits: number }>,
): number {
  reader.need(decoder.bits);
  const entry = decoder.table[reader.buf & ((1 << decoder.bits) - 1)]!;
  if (entry < 0) throw reader.out.fail("invalid prefix code", reader.byteOffset());
  const length = entry & 15;
  reader.buf >>>= length;
  reader.count -= length;
  return entry >>> 4;
}
