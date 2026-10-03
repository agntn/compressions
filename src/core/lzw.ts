/**
 * LZW as Unix `compress` writes it (.Z): codes from 9 bits up to 16, least significant bit first,
 * with the code 256 that clears the table in block mode. After every change of width, and after a
 * clear, `compress` skips to the end of the current group of eight codes; decoder and encoder
 * here do the same, as ncompress does.
 */
import type { Output } from "./bytes.ts";
import { defineCompression } from "./define.ts";
import { UnsupportedError } from "./errors.ts";
import type { Compression, Details } from "./types.ts";

const CLEAR = 256;
const INIT_BITS = 9;

/**
 * Rounds a bit position up to the next group of eight codes, counted from where the width began.
 *
 * @param position - Bit position.
 * @param base - Bit position where the current width began.
 * @param bits - The current width.
 * @returns {number} The aligned position.
 */
function alignGroup(position: number, base: number, bits: number): number {
  const group = bits * 8;
  return base + Math.ceil((position - base) / group) * group;
}

/** The state of a .Z reader: the table, the code width and where the current group began. */
class LzwReader {
  private readonly data: Uint8Array;
  private readonly out: Output;
  private readonly maxBits: number;
  private readonly blockMode: boolean;
  private readonly maxCode: number;
  private readonly first: number;
  private readonly prefix: Uint16Array;
  private readonly suffix: Uint8Array;
  private readonly stack: Uint8Array;
  private bits = INIT_BITS;
  private position = 24;
  private base = 24;
  private free: number;
  private previous = -1;
  private last = 0;

  /**
   * @param data - The input, header included.
   * @param out - Receives the bytes.
   * @param maxBits - Widest code.
   * @param blockMode - Whether code 256 clears the table.
   */
  constructor(data: Uint8Array, out: Output, maxBits: number, blockMode: boolean) {
    this.blockMode = blockMode;
    this.data = data;
    this.out = out;
    this.maxBits = maxBits;
    this.maxCode = 1 << maxBits;
    this.prefix = new Uint16Array(this.maxCode);
    this.suffix = new Uint8Array(this.maxCode);
    for (let i = 0; i < 256; i++) this.suffix[i] = i;
    this.stack = new Uint8Array(this.maxCode);
    this.first = blockMode ? 257 : 256;
    this.free = this.first;
  }

  /**
   * The largest code the current width holds before it grows.
   *
   * @returns {number} The code.
   */
  private get limit(): number {
    return this.bits === this.maxBits ? this.maxCode : (1 << this.bits) - 1;
  }

  /**
   * Skips to the next group of eight codes and sets a new width.
   *
   * @param bits - The new width.
   */
  private regroup(bits: number): void {
    this.position = alignGroup(this.position, this.base, this.bits);
    this.base = this.position;
    this.bits = bits;
  }

  /**
   * Reads the next code.
   *
   * @returns {number} The code.
   */
  private code(): number {
    const { data, position } = this;
    const byte = position >>> 3;
    const word = data[byte]! | ((data[byte + 1] ?? 0) << 8) | ((data[byte + 2] ?? 0) << 16);
    this.position += this.bits;
    return (word >>> (position & 7)) & ((1 << this.bits) - 1);
  }

  /**
   * Writes what a code stands for and adds the next table entry.
   *
   * @param incoming - The code read.
   */
  private expand(incoming: number): void {
    let code = incoming;
    let top = this.maxCode;
    if (code >= this.free) {
      if (code > this.free)
        throw this.out.fail(`code ${code} is not in the table yet`, this.position >>> 3);
      this.stack[--top] = this.last;
      code = this.previous;
    }
    for (; code >= 256; code = this.prefix[code]!) this.stack[--top] = this.suffix[code]!;
    this.last = code;
    this.stack[--top] = code;
    this.out.append(this.stack.subarray(top));
    if (this.free < this.maxCode) {
      this.prefix[this.free] = this.previous;
      this.suffix[this.free++] = code;
    }
    this.previous = incoming;
  }

  /** Reads codes until the bits run out. */
  run(): void {
    const total = this.data.length * 8;
    while (this.position + this.bits <= total) {
      // As ncompress and gzip read it: with a maximum of 9 this widens to 10 bits once the table fills.
      if (this.free > this.limit) {
        this.regroup(this.bits + 1);
        continue;
      }
      const code = this.code();
      if (this.previous === -1) this.start(code);
      else if (code === CLEAR && this.blockMode) this.clear();
      else this.expand(code);
    }
  }

  /**
   * Takes the first code, which must be a byte.
   *
   * @param code - The code.
   */
  private start(code: number): void {
    if (code >= 256) throw this.out.fail(`first code ${code} is not a byte`, 3);
    this.out.push(code);
    this.previous = code;
    this.last = code;
  }

  /** Empties the table and goes back to nine bits. */
  private clear(): void {
    this.free = this.first - 1;
    this.regroup(INIT_BITS);
  }
}

/**
 * Reads a .Z file.
 *
 * @param data - The input.
 * @param out - Receives the bytes.
 * @returns {Details} Maximum code width and block mode.
 */
function decompress(data: Uint8Array, out: Output): Details {
  if (data.length < 3 || data[0] !== 0x1f || data[1] !== 0x9d)
    throw out.fail("not a compress (.Z) file", 0);
  const flags = data[2]!;
  const maxBits = flags & 0x1f;
  const blockMode = (flags & 0x80) !== 0;
  if (flags & 0x60) throw new UnsupportedError("lzw", "reserved .Z flags are set", { offset: 2 });
  if (maxBits < INIT_BITS || maxBits > 16) throw out.fail(`maximum code width ${maxBits}`, 2);
  new LzwReader(data, out, maxBits, blockMode).run();
  return { bits: maxBits, blockMode };
}

/**
 * Writes a .Z file in block mode. The table fills and stays as it is, which every decoder reads;
 * compress's clear on a falling ratio is left out.
 *
 * @param input - The bytes.
 * @param maxBits - Widest code, 10 to 16.
 * @returns {Uint8Array} The file.
 */
function compress(input: Uint8Array, maxBits: number): Uint8Array {
  const out = new Uint8Array(3 + Math.ceil((input.length * maxBits) / 8) + maxBits * 2 + 8);
  out[0] = 0x1f;
  out[1] = 0x9d;
  out[2] = 0x80 | maxBits;
  const maxCode = 1 << maxBits;
  const table = new Map<number, number>();
  let position = 24;
  let base = 24;
  let bits = INIT_BITS;
  let free = 257;
  const put = (code: number): void => {
    const byte = position >>> 3;
    const value = code << (position & 7);
    out[byte]! |= value & 0xff;
    out[byte + 1]! |= (value >>> 8) & 0xff;
    out[byte + 2]! |= (value >>> 16) & 0xff;
    position += bits;
  };
  if (input.length === 0) return out.slice(0, 3);
  let current = input[0]!;
  for (let i = 1; i < input.length; i++) {
    const byte = input[i]!;
    const key = current * 256 + byte;
    const found = table.get(key);
    if (found !== undefined) {
      current = found;
      continue;
    }
    put(current);
    if (free >= 1 << bits && bits < maxBits) {
      position = alignGroup(position, base, bits);
      base = position;
      bits++;
    }
    if (free < maxCode) table.set(key, free++);
    current = byte;
  }
  put(current);
  return out.slice(0, Math.ceil(position / 8));
}

export const lzw: Compression = defineCompression({
  info: {
    name: "lzw",
    label: "Unix compress (LZW)",
    description:
      "Lempel-Ziv-Welch with codes of 9 to 16 bits, as the compress command writes .Z files",
    standard: "ncompress 5.0 (compress 4.2)",
    containers: [
      {
        name: "compress",
        label: "compress (.Z)",
        standard: "ncompress 5.0 (compress 4.2)",
        extensions: [".Z", ".taz"],
        magic: "1f9d",
      },
    ],
    compress: true,
    options: [
      {
        name: "bits",
        type: "number",
        default: 16,
        min: 10,
        max: 16,
        description:
          "Widest code, 10 to 16, as compress -b takes it; 9 reads differently in gzip and ncompress",
      },
    ],
  },
  compress: (bytes, options) => compress(bytes, (options["bits"] as number | undefined) ?? 16),
  decompress: (data, out) => decompress(data, out),
});
