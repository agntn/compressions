/**
 * Zstandard, read as RFC 8878 defines it: frames of raw, RLE and compressed blocks, Huffman coded
 * literals, FSE coded sequences and the XXH64 content checksum. Dictionaries are not supported.
 */
import { xxhash } from "@agntn/hashes/xxhash";
import type { Output } from "./bytes.ts";
import { defineCompression } from "./define.ts";
import { ChecksumError, UnsupportedError } from "./errors.ts";
import type { Compression, Details } from "./types.ts";

const MAGIC = 0xfd2fb528;
const BLOCK_MAX = 1 << 17;
/** Largest window this reader takes, as zstd's default limit for decoding: 2^27 bytes. */
const WINDOW_MAX = 1 << 27;

const LL_BASE = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128,
  256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536,
] as const;
const LL_BITS = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12,
  13, 14, 15, 16,
] as const;
const ML_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
  29, 30, 31, 32, 33, 34, 35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051,
  4099, 8195, 16387, 32771, 65539,
] as const;
const ML_BITS = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
  1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
] as const;
const LL_DEFAULT = [
  4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1,
  -1, -1, -1, -1,
] as const;
const ML_DEFAULT = [
  1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1,
] as const;
const OF_DEFAULT = [
  1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1,
] as const;

/** An FSE decoding table: per state, its symbol, how many bits to read and the base of the next state. */
interface FseTable {
  readonly log: number;
  readonly symbols: Uint8Array;
  readonly bits: Uint8Array;
  readonly base: Uint16Array;
}

/** A Huffman decoding table indexed by the next `log` bits. */
interface HuffmanTable {
  readonly log: number;
  readonly symbols: Uint8Array;
  readonly bits: Uint8Array;
}

/**
 * Reads bits backward, as zstd writes its entropy coded streams: from the end, after the
 * padding up to the highest set bit of the last byte.
 */
class BackwardReader {
  private readonly data: Uint8Array;
  private readonly start: number;
  /** Bits left, counted from `start`; below zero the stream ran out. */
  position: number;
  private readonly out: Output;

  /**
   * @param data - The input.
   * @param start - First byte of the stream.
   * @param end - Offset after its last byte.
   * @param out - The output, for errors.
   */
  constructor(data: Uint8Array, start: number, end: number, out: Output) {
    this.data = data;
    this.start = start;
    this.out = out;
    if (end <= start) throw out.fail("empty bitstream", start);
    const last = data[end - 1]!;
    if (last === 0) throw out.fail("bitstream ends with a zero byte", end - 1);
    this.position = (end - start - 1) * 8 + (31 - Math.clz32(last));
  }

  /**
   * Reads the bits just below `position` without moving it; bits before the start read as zero.
   *
   * @param n - How many, 0 to 24.
   * @returns {number} Their value.
   */
  peek(n: number): number {
    if (n === 0 || this.position <= 0) return 0;
    const low = this.position - n;
    const first = Math.max(low, 0);
    const at = this.start + (first >>> 3);
    const { data } = this;
    const word =
      (data[at] ?? 0) +
      (data[at + 1] ?? 0) * 0x100 +
      (data[at + 2] ?? 0) * 0x10000 +
      (data[at + 3] ?? 0) * 0x1000000;
    const value = Math.floor(word / (1 << (first & 7))) & ((1 << (this.position - first)) - 1);
    return low < 0 ? value << -low : value;
  }

  /**
   * Reads `n` bits and moves past them.
   *
   * @param n - How many, 0 to 31.
   * @returns {number} Their value.
   */
  bits(n: number): number {
    if (n > 24) {
      const high = this.bits(n - 16);
      return high * 0x10000 + this.bits(16);
    }
    const value = this.peek(n);
    this.position -= n;
    return value;
  }

  /**
   * Moves past `n` bits.
   *
   * @param n - How many.
   */
  skip(n: number): void {
    this.position -= n;
  }

  /**
   * Builds an error for a broken stream, with the output so far.
   *
   * @param message - What is wrong.
   * @returns {Error} The error, for the caller to throw.
   */
  failure(message: string): Error {
    return this.out.fail(message);
  }

  /** Throws unless every bit was read. */
  done(): void {
    if (this.position !== 0) throw this.out.fail("bitstream not read to its start");
  }
}

/**
 * Builds an FSE decoding table from normalized probabilities, as FSE_buildDTable does.
 *
 * @param probabilities - Per symbol: a count, or -1 for "less than one".
 * @param log - Accuracy log.
 * @returns {FseTable} The table.
 */
function fseTable(probabilities: ArrayLike<number>, log: number): FseTable {
  const size = 1 << log;
  const symbols = new Uint8Array(size);
  const bits = new Uint8Array(size);
  const base = new Uint16Array(size);
  const next = new Uint16Array(probabilities.length);
  let high = size - 1;
  for (let symbol = 0; symbol < probabilities.length; symbol++) {
    if (probabilities[symbol] === -1) {
      symbols[high--] = symbol;
      next[symbol] = 1;
    } else {
      next[symbol] = probabilities[symbol]!;
    }
  }
  const step = (size >>> 1) + (size >>> 3) + 3;
  let position = 0;
  for (let symbol = 0; symbol < probabilities.length; symbol++) {
    for (let i = 0; i < probabilities[symbol]!; i++) {
      symbols[position] = symbol;
      do position = (position + step) & (size - 1);
      while (position > high);
    }
  }
  for (let state = 0; state < size; state++) {
    const value = next[symbols[state]!]!++;
    const n = log - (31 - Math.clz32(value));
    bits[state] = n;
    base[state] = (value << n) - size;
  }
  return { log, symbols, bits, base };
}

/**
 * The table a predefined mode builds, for the tests that hold it to RFC 8878 appendix A.
 *
 * @param kind - Which of the three.
 * @returns {FseTable} The table.
 */
export function predefinedTable(kind: "literalLengths" | "matchLengths" | "offsets"): FseTable {
  if (kind === "literalLengths") return fseTable(LL_DEFAULT, 6);
  return kind === "matchLengths" ? fseTable(ML_DEFAULT, 6) : fseTable(OF_DEFAULT, 5);
}

/**
 * A table that always gives one symbol and reads no bits, for the RLE mode.
 *
 * @param symbol - The symbol.
 * @returns {FseTable} The table.
 */
function rleTable(symbol: number): FseTable {
  return {
    log: 0,
    symbols: new Uint8Array([symbol]),
    bits: new Uint8Array(1),
    base: new Uint16Array(1),
  };
}

/** Reads bits forward, lowest first, as an FSE table description is written. */
class ForwardBits {
  private readonly data: Uint8Array;
  private readonly start: number;
  private readonly end: number;
  private readonly out: Output;
  /** Bit offset from the start of `data`. */
  bit: number;

  /**
   * @param data - The input.
   * @param start - First byte.
   * @param end - Offset it may not pass.
   * @param out - The output, for errors.
   */
  constructor(data: Uint8Array, start: number, end: number, out: Output) {
    this.data = data;
    this.start = start;
    this.end = end;
    this.out = out;
    this.bit = start * 8;
  }

  /**
   * Reads `n` bits without moving past them.
   *
   * @param n - How many, up to 16.
   * @returns {number} Their value.
   */
  peek(n: number): number {
    let value = 0;
    for (let i = 0; i < n; i++) {
      const at = this.bit + i;
      if (at >>> 3 >= this.end)
        throw this.out.fail("FSE table description runs past the block", this.start);
      value |= ((this.data[at >>> 3]! >>> (at & 7)) & 1) << i;
    }
    return value;
  }

  /**
   * Reads `n` bits.
   *
   * @param n - How many.
   * @returns {number} Their value.
   */
  take(n: number): number {
    const value = this.peek(n);
    this.bit += n;
    return value;
  }
}

/**
 * Reads one probability of an FSE table description, in the variable width the space left sets.
 *
 * @param bits - The reader.
 * @param threshold - Half the range the value can take.
 * @param remaining - Probability left to hand out, plus one.
 * @param width - Bits of the long form.
 * @returns {number} The probability: a count, or -1 for "less than one".
 */
function readProbability(
  bits: ForwardBits,
  threshold: number,
  remaining: number,
  width: number,
): number {
  const max = 2 * threshold - 1 - remaining;
  const low = bits.peek(width - 1);
  if (low < max) {
    bits.bit += width - 1;
    return low - 1;
  }
  const value = bits.take(width);
  return (value >= threshold ? value - max : value) - 1;
}

/**
 * Reads the run of zero probabilities after a zero: two-bit repeat counts, 3 meaning more follow.
 *
 * @param bits - The reader.
 * @returns {number} How many more zeros.
 */
function readZeroRun(bits: ForwardBits): number {
  let zeros = 0;
  for (let repeat = 3; repeat === 3; zeros += repeat) repeat = bits.take(2);
  return zeros;
}

/**
 * Reads an FSE table description, as FSE_readNCount does.
 *
 * @param data - The input.
 * @param start - Where it starts.
 * @param end - Offset it may not pass.
 * @param maxSymbol - Largest symbol the table may describe.
 * @param maxLog - Largest accuracy log allowed.
 * @param out - The output, for errors.
 * @returns {[FseTable, number]} The table and the offset after the description.
 */
function readFseTable(
  data: Uint8Array,
  start: number,
  end: number,
  maxSymbol: number,
  maxLog: number,
  out: Output,
): [FseTable, number] {
  const bits = new ForwardBits(data, start, end, out);
  const log = bits.take(4) + 5;
  if (log > maxLog) throw out.fail(`FSE accuracy log ${log} is too big`, start);
  const probabilities: number[] = [];
  let remaining = (1 << log) + 1;
  let threshold = 1 << log;
  let width = log + 1;
  while (remaining > 1 && probabilities.length <= maxSymbol) {
    const count = readProbability(bits, threshold, remaining, width);
    remaining -= Math.abs(count);
    probabilities.push(count);
    if (count === 0) probabilities.push(...Array.from({ length: readZeroRun(bits) }, () => 0));
    for (; remaining < threshold; threshold >>>= 1) width--;
  }
  if (remaining !== 1 || probabilities.length > maxSymbol + 1)
    throw out.fail("FSE table probabilities do not add up", start);
  return [fseTable(probabilities, log), (bits.bit + 7) >>> 3];
}

/**
 * Adds the implied last weight and checks the weights make a complete code.
 *
 * @param weights - The weights read, without the last one.
 * @param out - The output, for errors.
 * @returns {[number[], number]} All weights and the table log.
 */
function completeWeights(weights: readonly number[], out: Output): [number[], number] {
  if (weights.some((weight) => weight > 11)) throw out.fail("Huffman weight above 11");
  const total = weights.reduce((sum, weight) => sum + (weight > 0 ? 1 << (weight - 1) : 0), 0);
  if (total === 0) throw out.fail("Huffman weights are all zero");
  const log = 32 - Math.clz32(total);
  const rest = (1 << log) - total;
  if (rest & (rest - 1)) throw out.fail("Huffman weights do not complete a code");
  return [[...weights, 32 - Math.clz32(rest)], log];
}

/**
 * Builds a Huffman decoding table from weights, as HUF_readDTableX1 lays it out.
 *
 * @param read - Per symbol, 0 for none, else the weight; the last one is implied.
 * @param out - The output, for errors.
 * @returns {HuffmanTable} The table.
 */
function huffmanTable(read: readonly number[], out: Output): HuffmanTable {
  const [weights, log] = completeWeights(read, out);
  const size = 1 << log;
  const symbols = new Uint8Array(size);
  const bits = new Uint8Array(size);
  let position = 0;
  for (let weight = 1; weight <= log; weight++) {
    const span = 1 << (weight - 1);
    for (let symbol = 0; symbol < weights.length; symbol++) {
      if (weights[symbol] !== weight) continue;
      symbols.fill(symbol, position, position + span);
      bits.fill(log + 1 - weight, position, position + span);
      position += span;
    }
  }
  if (position !== size) throw out.fail("Huffman table does not fill");
  return { log, symbols, bits };
}

/**
 * Decodes the FSE coded Huffman weights: two states in turn until the stream runs out.
 *
 * @param data - The input.
 * @param start - First byte of the table description.
 * @param end - Offset after the weights.
 * @param out - The output, for errors.
 * @returns {number[]} The weights.
 */
function fseWeights(data: Uint8Array, start: number, end: number, out: Output): number[] {
  const [table, tableEnd] = readFseTable(data, start, end, 255, 6, out);
  const reader = new BackwardReader(data, tableEnd, end, out);
  const states = [reader.bits(table.log), reader.bits(table.log)];
  const weights: number[] = [];
  for (let turn = 0; weights.length < 255; turn ^= 1) {
    const state = states[turn]!;
    weights.push(table.symbols[state]!);
    states[turn] = table.base[state]! + reader.bits(table.bits[state]!);
    if (reader.position < 0) {
      weights.push(table.symbols[states[turn ^ 1]!]!);
      return weights;
    }
  }
  throw out.fail("too many Huffman weights", start);
}

/**
 * Reads a Huffman tree description: weights in 4 bits each, or FSE coded.
 *
 * @param data - The input.
 * @param start - Where it starts.
 * @param end - Offset it may not pass.
 * @param out - The output, for errors.
 * @returns {[HuffmanTable, number]} The table and the offset after the description.
 */
function readHuffmanTable(
  data: Uint8Array,
  start: number,
  end: number,
  out: Output,
): [HuffmanTable, number] {
  const header = data[start]!;
  const length = header >= 128 ? Math.ceil((header - 127) / 2) : header;
  if (start + 1 + length > end) throw out.fail("Huffman weights run past the block", start);
  if (header < 128)
    return [
      huffmanTable(fseWeights(data, start + 1, start + 1 + length, out), out),
      start + 1 + length,
    ];
  const weights = Array.from({ length: header - 127 }, (_, i) => {
    const byte = data[start + 1 + (i >>> 1)]!;
    return i & 1 ? byte & 15 : byte >>> 4;
  });
  return [huffmanTable(weights, out), start + 1 + length];
}

/**
 * Decodes one Huffman coded stream of `count` literals.
 *
 * @param data - The input.
 * @param start - First byte of the stream.
 * @param end - Offset after it.
 * @param table - The Huffman table.
 * @param literals - Receives the literals at their place.
 * @param out - The output, for errors.
 */
function decodeHuffmanStream(
  data: Uint8Array,
  start: number,
  end: number,
  table: Readonly<HuffmanTable>,
  literals: Uint8Array,
  out: Output,
): void {
  const reader = new BackwardReader(data, start, end, out);
  for (let i = 0; i < literals.length; i++) {
    const index = reader.peek(table.log);
    literals[i] = table.symbols[index]!;
    reader.skip(table.bits[index]!);
  }
  reader.done();
}

/** Tables and offsets a frame carries from one block to the next. */
interface FrameState {
  huffman?: HuffmanTable;
  literalLengths?: FseTable;
  offsets?: FseTable;
  matchLengths?: FseTable;
  reps: [number, number, number];
  windowSize: number;
  frameStart: number;
}

/**
 * Reads the literals of a raw or RLE literals section.
 *
 * @param data - The input.
 * @param start - Where the section starts.
 * @param end - End of the block.
 * @param out - The output, for errors.
 * @returns {[Uint8Array, number]} The literals and the offset after the section.
 */
function plainLiterals(
  data: Uint8Array,
  start: number,
  end: number,
  out: Output,
): [Uint8Array, number] {
  const first = data[start]!;
  const format = (first >>> 2) & 3;
  const header = format === 1 ? 2 : format === 3 ? 3 : 1;
  const value = first | (data[start + 1]! << 8) | (data[start + 2]! << 16);
  const size = header === 1 ? first >>> 3 : (value >>> 4) & ((1 << (header * 8 - 4)) - 1);
  const from = start + header;
  const rle = (first & 3) === 1;
  if (from + (rle ? 1 : size) > end) throw out.fail("literals run past the block", start);
  if (rle) return [new Uint8Array(size).fill(data[from]!), from + 1];
  return [data.slice(from, from + size), from + size];
}

/**
 * Reads the sizes in a compressed literals header.
 *
 * @param data - The input.
 * @param start - Where the section starts.
 * @param end - End of the block.
 * @param out - The output, for errors.
 * @returns {{ size: number; compressed: number; streams: number; header: number }} The sizes and the stream count.
 */
function literalsHeader(
  data: Uint8Array,
  start: number,
  end: number,
  out: Output,
): { size: number; compressed: number; streams: number; header: number } {
  const format = (data[start]! >>> 2) & 3;
  const header = [3, 3, 4, 5][format]!;
  const sizeBits = [10, 10, 14, 18][format]!;
  if (start + header > end) throw out.fail("literals header runs past the block", start);
  let value = 0;
  for (let i = header - 1; i >= 0; i--) value = value * 256 + data[start + i]!;
  value = Math.floor(value / 16);
  const size = value % 2 ** sizeBits;
  const compressed = Math.floor(value / 2 ** sizeBits);
  if (size > BLOCK_MAX) throw out.fail("literals larger than a block", start);
  if (start + header + compressed > end) throw out.fail("literals run past the block", start);
  return { size, compressed, streams: format === 0 ? 1 : 4, header };
}

/**
 * Decodes the four Huffman streams after their jump table.
 *
 * @param data - The input.
 * @param pos - Offset of the jump table.
 * @param end - End of the literals section.
 * @param table - The Huffman table.
 * @param literals - Receives the literals.
 * @param out - The output, for errors.
 */
function fourStreams(
  data: Uint8Array,
  pos: number,
  end: number,
  table: Readonly<HuffmanTable>,
  literals: Uint8Array,
  out: Output,
): void {
  if (pos + 6 > end) throw out.fail("jump table runs past the literals", pos);
  const lengths = [0, 2, 4].map((at) => data[pos + at]! | (data[pos + at + 1]! << 8));
  const segment = Math.ceil(literals.length / 4);
  if (literals.length < 3 * segment) throw out.fail("too few literals for four streams", pos);
  let at = pos + 6;
  for (let i = 0; i < 4; i++) {
    const length = lengths[i] ?? end - at;
    if (length < 0 || at + length > end)
      throw out.fail("literal streams run past their section", at);
    decodeHuffmanStream(
      data,
      at,
      at + length,
      table,
      literals.subarray(i * segment, i < 3 ? (i + 1) * segment : literals.length),
      out,
    );
    at += length;
  }
}

/**
 * Reads the literals section of a compressed block.
 *
 * @param data - The input.
 * @param start - Where the section starts.
 * @param end - End of the block.
 * @param state - The frame's carried tables.
 * @param out - The output, for errors.
 * @returns {[Uint8Array, number]} The literals and the offset after the section.
 */
function readLiterals(
  data: Uint8Array,
  start: number,
  end: number,
  state: FrameState,
  out: Output,
): [Uint8Array, number] {
  const type = data[start]! & 3;
  if (type <= 1) return plainLiterals(data, start, end, out);
  const { size, compressed, streams, header } = literalsHeader(data, start, end, out);
  let pos = start + header;
  const sectionEnd = pos + compressed;
  if (type === 2) [state.huffman, pos] = readHuffmanTable(data, pos, sectionEnd, out);
  if (!state.huffman) throw out.fail("treeless literals with no earlier Huffman table", start);
  const literals = new Uint8Array(size);
  if (streams === 1) decodeHuffmanStream(data, pos, sectionEnd, state.huffman, literals, out);
  else fourStreams(data, pos, sectionEnd, state.huffman, literals, out);
  return [literals, sectionEnd];
}

/** One sequence table's mode inputs: its default distribution, limits and the table before. */
interface TableKind {
  defaults: readonly number[];
  log: number;
  maxSymbol: number;
  maxLog: number;
}

const LITERAL_LENGTH_KIND: TableKind = { defaults: LL_DEFAULT, log: 6, maxSymbol: 35, maxLog: 9 };
const OFFSET_KIND: TableKind = { defaults: OF_DEFAULT, log: 5, maxSymbol: 31, maxLog: 8 };
const MATCH_LENGTH_KIND: TableKind = { defaults: ML_DEFAULT, log: 6, maxSymbol: 52, maxLog: 9 };

/**
 * Reads one of the three sequence tables by its mode.
 *
 * @param mode - 0 predefined, 1 RLE, 2 FSE coded, 3 repeat.
 * @param data - The input.
 * @param pos - Where its description starts.
 * @param end - End of the block.
 * @param kind - Which table.
 * @param previous - The table the previous block used.
 * @param out - The output, for errors.
 * @returns {[FseTable, number]} The table and the offset after its description.
 */
function sequenceTable(
  mode: number,
  data: Uint8Array,
  pos: number,
  end: number,
  kind: Readonly<TableKind>,
  previous: FseTable | undefined,
  out: Output,
): [FseTable, number] {
  if (mode === 0) return [fseTable(kind.defaults, kind.log), pos];
  if (mode === 2) return readFseTable(data, pos, end, kind.maxSymbol, kind.maxLog, out);
  if (mode === 3) {
    if (!previous) throw out.fail("repeat mode with no earlier table", pos);
    return [previous, pos];
  }
  if (pos >= end || data[pos]! > kind.maxSymbol) throw out.fail("RLE symbol out of range", pos);
  return [rleTable(data[pos]!), pos + 1];
}

/**
 * Reads the sequence count.
 *
 * @param data - The input.
 * @param pos - Where it starts.
 * @returns {[number, number]} The count and the offset after it.
 */
function sequenceCount(data: Uint8Array, pos: number): [number, number] {
  const first = data[pos]!;
  if (first < 128) return [first, pos + 1];
  if (first < 255) return [((first - 128) << 8) + data[pos + 1]!, pos + 2];
  return [data[pos + 1]! + (data[pos + 2]! << 8) + 0x7f00, pos + 3];
}

/**
 * Turns an offset value into a distance, moving the three repeat offsets as RFC 8878 says.
 *
 * @param state - The frame state whose repeat offsets change.
 * @param offsetValue - The decoded offset value.
 * @param literalLength - The sequence's literal length, which shifts the repeat codes when 0.
 * @param out - The output, for errors.
 * @returns {number} The distance.
 */
function applyOffset(
  state: FrameState,
  offsetValue: number,
  literalLength: number,
  out: Output,
): number {
  const { reps } = state;
  if (offsetValue > 3) {
    reps.unshift(offsetValue - 3);
    reps.length = 3;
    return reps[0];
  }
  const index = offsetValue - 1 + (literalLength === 0 ? 1 : 0);
  if (index === 0) return reps[0];
  const offset = index === 3 ? reps[0] - 1 : reps[index]!;
  if (offset === 0) throw out.fail("repeat offset of zero");
  if (index !== 1) reps[2] = reps[1];
  reps[1] = reps[0];
  reps[0] = offset;
  return offset;
}

/** The three FSE states of the sequence decoder and their tables. */
class SequenceDecoder {
  private readonly reader: BackwardReader;
  private readonly tables: readonly [FseTable, FseTable, FseTable];
  private readonly states: [number, number, number];

  /**
   * @param reader - The backward reader over the sequence bitstream.
   * @param tables - Literal length, offset and match length tables.
   */
  constructor(reader: BackwardReader, tables: Readonly<[FseTable, FseTable, FseTable]>) {
    this.reader = reader;
    this.tables = tables;
    this.states = [
      reader.bits(tables[0].log),
      reader.bits(tables[1].log),
      reader.bits(tables[2].log),
    ];
  }

  /**
   * Decodes one sequence: offset value, match length, literal length.
   *
   * @returns {[number, number, number]} Offset value, match length and literal length.
   */
  next(): [number, number, number] {
    const [ll, of, ml] = this.states;
    const llCode = this.tables[0].symbols[ll]!;
    const ofCode = this.tables[1].symbols[of]!;
    const mlCode = this.tables[2].symbols[ml]!;
    if (llCode > 35 || mlCode > 52) throw this.reader.failure("sequence code out of range");
    const offsetValue = 2 ** ofCode + this.reader.bits(ofCode);
    const matchLength = ML_BASE[mlCode]! + this.reader.bits(ML_BITS[mlCode]!);
    const literalLength = LL_BASE[llCode]! + this.reader.bits(LL_BITS[llCode]!);
    return [offsetValue, matchLength, literalLength];
  }

  /** Moves the states on, in RFC 8878's order: literal length, match length, offset. */
  update(): void {
    for (const index of [0, 2, 1]) {
      const table = this.tables[index]!;
      const state = this.states[index]!;
      this.states[index] = table.base[state]! + this.reader.bits(table.bits[state]!);
    }
  }
}

/** The literals of a block and how many sequences took so far. */
interface LiteralCursor {
  bytes: Uint8Array;
  used: number;
}

/**
 * Executes one sequence: copies its literals, then its match.
 *
 * @param out - The output.
 * @param literals - The block's literals and how many are used.
 * @param state - The frame's window.
 * @param sequence - Offset, match length and literal length.
 */
function execute(
  out: Output,
  literals: LiteralCursor,
  state: FrameState,
  sequence: Readonly<[number, number, number]>,
): void {
  const [offset, matchLength, literalLength] = sequence;
  if (literals.used + literalLength > literals.bytes.length)
    throw out.fail("sequence takes more literals than there are");
  out.append(literals.bytes.subarray(literals.used, literals.used + literalLength));
  literals.used += literalLength;
  if (offset > Math.min(out.length - state.frameStart, state.windowSize))
    throw out.fail(`offset ${offset} reaches before the window`);
  out.copy(offset, matchLength);
}

/**
 * Reads the three sequence tables after the modes byte.
 *
 * @param data - The input.
 * @param pos - Offset of the modes byte.
 * @param end - End of the block.
 * @param state - The frame's carried tables, updated.
 * @param out - The output, for errors.
 * @returns {[[FseTable, FseTable, FseTable], number]} The tables and the offset of the bitstream.
 */
function sequenceTables(
  data: Uint8Array,
  pos: number,
  end: number,
  state: FrameState,
  out: Output,
): [[FseTable, FseTable, FseTable], number] {
  const modes = data[pos]!;
  if (modes & 3) throw out.fail("reserved sequence mode bits are set", pos);
  let at = pos + 1;
  [state.literalLengths, at] = sequenceTable(
    modes >>> 6,
    data,
    at,
    end,
    LITERAL_LENGTH_KIND,
    state.literalLengths,
    out,
  );
  [state.offsets, at] = sequenceTable(
    (modes >>> 4) & 3,
    data,
    at,
    end,
    OFFSET_KIND,
    state.offsets,
    out,
  );
  [state.matchLengths, at] = sequenceTable(
    (modes >>> 2) & 3,
    data,
    at,
    end,
    MATCH_LENGTH_KIND,
    state.matchLengths,
    out,
  );
  return [[state.literalLengths, state.offsets, state.matchLengths], at];
}

/**
 * Decodes the sequences of a compressed block and executes them into `out`.
 *
 * @param data - The input.
 * @param start - Where the sequences section starts.
 * @param end - End of the block.
 * @param literals - The block's literals.
 * @param state - The frame's carried tables and offsets.
 * @param out - Receives the bytes.
 */
function executeSequences(
  data: Uint8Array,
  start: number,
  end: number,
  literals: Uint8Array,
  state: FrameState,
  out: Output,
): void {
  if (start >= end) throw out.fail("sequences section is missing", start);
  const [count, pos] = sequenceCount(data, start);
  const used: LiteralCursor = { bytes: literals, used: 0 };
  if (count === 0 && pos !== end) throw out.fail("bytes after an empty sequences section", pos);
  if (count > 0) {
    const [tables, at] = sequenceTables(data, pos, end, state, out);
    const reader = new BackwardReader(data, at, end, out);
    const decoder = new SequenceDecoder(reader, tables);
    for (let i = 0; i < count; i++) {
      const [offsetValue, matchLength, literalLength] = decoder.next();
      const offset = applyOffset(state, offsetValue, literalLength, out);
      if (i < count - 1) decoder.update();
      execute(out, used, state, [offset, matchLength, literalLength]);
    }
    reader.done();
  }
  out.append(literals.subarray(used.used));
}

/** What a frame header says. */
interface FrameHeader {
  windowSize: number;
  contentSize: number;
  checksum: boolean;
  /** Offset of the first block. */
  end: number;
}

/**
 * Reads a little-endian integer of 0 to 8 bytes.
 *
 * @param data - The input.
 * @param at - Where it starts.
 * @param size - How many bytes.
 * @returns {number} The value.
 */
function littleEndian(data: Uint8Array, at: number, size: number): number {
  let value = 0;
  for (let i = size - 1; i >= 0; i--) value = value * 256 + data[at + i]!;
  return value;
}

/**
 * Reads the frame content size field, which stores 256 less in its two-byte form.
 *
 * @param data - The input.
 * @param at - Where the field starts.
 * @param size - Its size: 0, 1, 2, 4 or 8.
 * @returns {number} The content size, or -1 when the frame does not say.
 */
function contentSizeOf(data: Uint8Array, at: number, size: number): number {
  if (size === 0) return -1;
  return littleEndian(data, at, size) + (size === 2 ? 256 : 0);
}

/**
 * The window size a window descriptor byte names.
 *
 * @param byte - Exponent in the top five bits, mantissa in the low three.
 * @returns {number} The size in bytes.
 */
function windowOf(byte: number): number {
  const base = 2 ** (10 + (byte >>> 3));
  return base + (base / 8) * (byte & 7);
}

/**
 * Reads a frame header: descriptor, window, dictionary id and content size.
 *
 * @param data - The input.
 * @param start - Offset of the frame header descriptor.
 * @param out - The output, for errors.
 * @returns {FrameHeader} What it says.
 */
function readFrameHeader(data: Uint8Array, start: number, out: Output): FrameHeader {
  const descriptor = data[start] ?? 0;
  if (descriptor & 8) throw out.fail("reserved frame header bit is set", start);
  const single = (descriptor & 0x20) !== 0;
  const windowByte = data[start + 1]!;
  let pos = start + (single ? 1 : 2);
  const dictionaryBytes = [0, 1, 2, 4][descriptor & 3]!;
  const sizeBytes = [single ? 1 : 0, 2, 4, 8][descriptor >>> 6]!;
  if (pos + dictionaryBytes + sizeBytes > data.length) throw out.fail("unexpected end of data");
  const dictionary = littleEndian(data, pos, dictionaryBytes);
  if (dictionary !== 0)
    throw new UnsupportedError("zstd", `frame needs dictionary ${dictionary}`, {
      offset: start,
      partial: out.take(),
    });
  pos += dictionaryBytes;
  const contentSize = contentSizeOf(data, pos, sizeBytes);
  const windowSize = single ? contentSize : windowOf(windowByte);
  if (windowSize > WINDOW_MAX) {
    throw new UnsupportedError(
      "zstd",
      `window of ${windowSize} bytes is past the 128 MiB this reader takes`,
      { offset: start, partial: out.take() },
    );
  }
  return { windowSize, contentSize, checksum: (descriptor & 4) !== 0, end: pos + sizeBytes };
}

/**
 * Reads one block after its header.
 *
 * @param data - The input.
 * @param pos - Offset of the block content.
 * @param header - The block header: last flag, type and size.
 * @param state - The frame's carried tables.
 * @param out - Receives the bytes.
 * @returns {number} Offset after the block.
 */
function readBlock(
  data: Uint8Array,
  pos: number,
  header: number,
  state: FrameState,
  out: Output,
): number {
  const type = (header >>> 1) & 3;
  const size = header >>> 3;
  const blockMax = Math.min(state.windowSize, BLOCK_MAX);
  const stored = type === 1 ? 1 : size;
  if (size > blockMax) throw out.fail("block is bigger than the window allows", pos - 3);
  if (pos + stored > data.length) throw out.fail("unexpected end of data");
  if (type === 3) throw out.fail("reserved block type", pos - 3);
  const before = out.length;
  if (type === 0) out.append(data.subarray(pos, pos + size));
  else if (type === 1) out.copyByte(data[pos]!, size);
  else executeCompressed(data, pos, pos + size, state, out);
  if (out.length - before > blockMax)
    throw out.fail("block decodes past the window's block size", pos);
  return pos + stored;
}

/**
 * Reads a compressed block: literals, then sequences.
 *
 * @param data - The input.
 * @param start - Offset of the block content.
 * @param end - End of the block.
 * @param state - The frame's carried tables.
 * @param out - Receives the bytes.
 */
function executeCompressed(
  data: Uint8Array,
  start: number,
  end: number,
  state: FrameState,
  out: Output,
): void {
  const [literals, after] = readLiterals(data, start, end, state, out);
  executeSequences(data, after, end, literals, state, out);
}

/**
 * Checks the content size and the content checksum at the end of a frame.
 *
 * @param data - The input.
 * @param pos - Offset after the last block.
 * @param header - The frame header.
 * @param content - What the frame decompressed to.
 * @param out - The output, for errors.
 * @returns {number} Offset after the frame.
 */
function checkFrame(
  data: Uint8Array,
  pos: number,
  header: Readonly<FrameHeader>,
  content: Uint8Array,
  out: Output,
): number {
  if (header.contentSize >= 0 && content.length !== header.contentSize) {
    throw new ChecksumError("zstd", "frame content size does not match", {
      offset: pos,
      partial: out.take(),
    });
  }
  if (!header.checksum) return pos;
  if (pos + 4 > data.length) throw out.fail("unexpected end of data");
  const digest = xxhash(content, 64);
  if (
    !digest
      .subarray(4)
      .toReversed()
      .every((byte, i) => data[pos + i] === byte)
  ) {
    throw new ChecksumError("zstd", "content checksum does not match", {
      offset: pos,
      partial: out.take(),
    });
  }
  return pos + 4;
}

/**
 * Reads one frame from after its magic.
 *
 * @param data - The input.
 * @param start - Offset of the frame header descriptor.
 * @param out - Receives the bytes.
 * @param details - Collects the first frame's window and checksum flag, and the frame count.
 * @returns {number} Offset after the frame.
 */
function readFrame(data: Uint8Array, start: number, out: Output, details: Details): number {
  const header = readFrameHeader(data, start, out);
  if (header.contentSize > out.limit - out.length) out.reserve(header.contentSize);
  const state: FrameState = {
    reps: [1, 4, 8],
    windowSize: header.windowSize,
    frameStart: out.length,
  };
  let pos = header.end;
  for (let last = 0; !last;) {
    if (pos + 3 > data.length) throw out.fail("unexpected end of data");
    const block = data[pos]! | (data[pos + 1]! << 8) | (data[pos + 2]! << 16);
    last = block & 1;
    pos = readBlock(data, pos + 3, block, state, out);
  }
  pos = checkFrame(data, pos, header, out.bytes.subarray(state.frameStart, out.length), out);
  details["window"] ??= header.windowSize;
  details["checksum"] ??= header.checksum;
  details["frames"] = Number(details["frames"] ?? 0) + 1;
  return pos;
}

/**
 * Reads zstd frames and skippable frames in a row, as `zstd -d` does.
 *
 * @param data - The input.
 * @param out - Receives the bytes.
 * @returns {Details} The first frame's window and checksum flag, counts, trailing bytes.
 */
function decompress(data: Uint8Array, out: Output): Details {
  const details: Details = {};
  let pos = 0;
  while (pos + 4 <= data.length) {
    const magic =
      (data[pos]! | (data[pos + 1]! << 8) | (data[pos + 2]! << 16) | (data[pos + 3]! << 24)) >>> 0;
    if (magic === MAGIC) {
      pos = readFrame(data, pos + 4, out, details);
    } else if ((magic & 0xfffffff0) === 0x184d2a50) {
      if (pos + 8 > data.length) throw out.fail("unexpected end of data");
      pos +=
        8 +
        ((data[pos + 4]! |
          (data[pos + 5]! << 8) |
          (data[pos + 6]! << 16) |
          (data[pos + 7]! << 24)) >>>
          0);
      details["skipped"] = ((details["skipped"] as number | undefined) ?? 0) + 1;
    } else if (pos === 0) {
      throw out.fail("not a zstd frame", 0);
    } else {
      break;
    }
  }
  if (details["frames"] === undefined) throw out.fail("no zstd frame", pos);
  if (pos < data.length) details["trailing"] = data.length - Math.min(pos, data.length);
  return details;
}

export const zstd: Compression = defineCompression({
  info: {
    name: "zstd",
    label: "Zstandard",
    description:
      "LZ77 with Huffman literals and FSE coded sequences: zstd files, and what Linux and HTTP use now",
    standard: "RFC 8878",
    containers: [
      {
        name: "zstd",
        label: "Zstandard frame",
        standard: "RFC 8878",
        extensions: [".zst", ".tzst"],
        magic: "28b52ffd",
        checksum: "XXH64, low 32 bits",
      },
    ],
    compress: false,
    options: [],
  },
  decompress: (data, out) => decompress(data, out),
});
