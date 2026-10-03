/** The deflate encoder: writes raw deflate data as RFC 1951 defines it, with zlib's ten levels. */
import { integerOption } from "./bytes.ts";
import { LsbWriter, codeLengths, reversedCodes } from "./huffman.ts";
import {
  CODE_LENGTH_ORDER,
  DISTANCE_BASE,
  DISTANCE_EXTRA,
  LENGTH_BASE,
  LENGTH_EXTRA,
} from "./inflate.ts";

/** Options every deflate writer takes. */
export interface DeflateOptions {
  /** 0 stores, 1 is fastest, 9 compresses most. Default: 6, as zlib. */
  level?: number;
}

const WINDOW = 32768;
const WINDOW_MASK = WINDOW - 1;
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
const MIN_MATCH = 3;
const MAX_MATCH = 258;
/** Symbols per block before it is written. */
const BLOCK_SYMBOLS = 16384;

/** zlib's tuning per level: when to search less, when to stop looking, chain depth, lazy matching. */
interface Tuning {
  good: number;
  lazy: number;
  nice: number;
  chain: number;
  lazyMatching: boolean;
}

/** zlib's `configuration_table`, levels 1 to 9. */
const TUNING: readonly Tuning[] = [
  { good: 0, lazy: 0, nice: 0, chain: 0, lazyMatching: false },
  { good: 4, lazy: 4, nice: 8, chain: 4, lazyMatching: false },
  { good: 4, lazy: 5, nice: 16, chain: 8, lazyMatching: false },
  { good: 4, lazy: 6, nice: 32, chain: 32, lazyMatching: false },
  { good: 4, lazy: 4, nice: 16, chain: 16, lazyMatching: true },
  { good: 8, lazy: 16, nice: 32, chain: 32, lazyMatching: true },
  { good: 8, lazy: 16, nice: 128, chain: 128, lazyMatching: true },
  { good: 8, lazy: 32, nice: 128, chain: 256, lazyMatching: true },
  { good: 32, lazy: 128, nice: 258, chain: 1024, lazyMatching: true },
  { good: 32, lazy: 258, nice: 258, chain: 4096, lazyMatching: true },
];

/** Length code (257 to 285) for each match length 3 to 258, at index `length`. */
const LENGTH_CODE = /* @__PURE__ */ (() => {
  const codes = new Uint16Array(MAX_MATCH + 1);
  for (let code = 0; code < 29; code++) {
    const end = code === 28 ? 259 : LENGTH_BASE[code + 1]!;
    for (let length = LENGTH_BASE[code]!; length < end; length++) codes[length] = 257 + code;
  }
  codes[258] = 285;
  return codes;
})();

/**
 * The distance code of a distance.
 *
 * @param distance - 1 to 32768.
 * @returns {number} 0 to 29.
 */
function distanceCode(distance: number): number {
  let code = 0;
  while (code < 29 && DISTANCE_BASE[code + 1]! <= distance) code++;
  return code;
}

/** Fixed literal and length code lengths, block type 1. */
const FIXED_LENGTHS = /* @__PURE__ */ (() => {
  const lengths = new Uint8Array(288);
  lengths.fill(8, 0, 144);
  lengths.fill(9, 144, 256);
  lengths.fill(7, 256, 280);
  lengths.fill(8, 280, 288);
  return lengths;
})();

/** Symbols collected for one block: a literal, or a length with its distance. */
class Block {
  /** Literal byte or length code 257 to 285, per symbol. */
  readonly codes = new Uint16Array(BLOCK_SYMBOLS + 1);
  /** Match length 3 to 258, or 0 for a literal. */
  readonly lengths = new Uint16Array(BLOCK_SYMBOLS + 1);
  /** Match distance, per symbol. */
  readonly distances = new Uint16Array(BLOCK_SYMBOLS + 1);
  count = 0;
  /** Input offset where the block starts, for a stored copy. */
  start = 0;
}

/**
 * Writes a run of one code length as code length symbols 16 to 18 with their extra values.
 *
 * @param value - The code length.
 * @param run - How many times it repeats.
 * @returns {number[]} Symbol and extra value pairs.
 */
function runSymbols(value: number, run: number): number[] {
  const symbols: number[] = [];
  let left = run;
  if (value !== 0) {
    symbols.push(value, 0);
    left--;
  }
  const [code, min, max] = value === 0 ? [18, 11, 138] : [16, 3, 6];
  while (left >= min) {
    const take = Math.min(left, max);
    symbols.push(code, take - min);
    left -= take;
  }
  if (value === 0 && left >= 3) {
    symbols.push(17, left - 3);
    left = 0;
  }
  for (; left > 0; left--) symbols.push(value, 0);
  return symbols;
}

/**
 * Writes the code length sequence of a dynamic header as symbols 0 to 18 with their extra bits.
 *
 * @param lengths - Literal then distance code lengths.
 * @returns {number[]} Pairs of code length symbol and extra value.
 */
function runLengths(lengths: Uint8Array): number[] {
  const symbols: number[] = [];
  for (let i = 0; i < lengths.length;) {
    let run = 1;
    while (i + run < lengths.length && lengths[i + run] === lengths[i]) run++;
    symbols.push(...runSymbols(lengths[i]!, run));
    i += run;
  }
  return symbols;
}

const CODE_LENGTH_EXTRA = [2, 3, 7] as const;
const FIXED_DISTANCES = /* @__PURE__ */ new Uint8Array(30).fill(5);

/** The symbol counts of one block, and the extra bits its matches carry. */
interface BlockStatistics {
  literals: Uint32Array;
  distances: Uint32Array;
  /** Distance code per symbol, for the matches. */
  distanceCodes: Uint8Array;
  extraBits: number;
}

/**
 * Counts the symbols of a block.
 *
 * @param block - The symbols.
 * @returns {BlockStatistics} Their counts.
 */
function statistics(block: Readonly<Block>): BlockStatistics {
  const literals = new Uint32Array(286);
  const distances = new Uint32Array(30);
  const distanceCodes = new Uint8Array(block.count);
  let extraBits = 0;
  for (let i = 0; i < block.count; i++) {
    const code = block.codes[i]!;
    literals[code]!++;
    if (code <= 256) continue;
    const distance = distanceCode(block.distances[i]!);
    distanceCodes[i] = distance;
    distances[distance]!++;
    extraBits += LENGTH_EXTRA[code - 257]! + DISTANCE_EXTRA[distance]!;
  }
  literals[256] = 1;
  return { literals, distances, distanceCodes, extraBits };
}

/** A dynamic header: both codes and how the header writes them. */
interface DynamicHeader {
  literalLengths: Uint8Array;
  distanceLengths: Uint8Array;
  literalCount: number;
  distanceCount: number;
  sequence: readonly number[];
  codeLengthLengths: Uint8Array;
  codeLengthCount: number;
  /** Bits the header takes. */
  bits: number;
}

/**
 * Counts the used length of a code length array from the end, down to a minimum.
 *
 * @param lengths - Code lengths, or the code length code lengths read through `order`.
 * @param count - Full length.
 * @param min - Smallest count.
 * @param order - Order the header writes them in, when it is not the symbol order.
 * @returns {number} How many to write.
 */
function usedCount(
  lengths: Uint8Array,
  count: number,
  min: number,
  order?: readonly number[],
): number {
  let used = count;
  while (used > min && lengths[order ? order[used - 1]! : used - 1] === 0) used--;
  return used;
}

/**
 * Builds the dynamic codes of a block and its header.
 *
 * @param stats - The block's symbol counts.
 * @returns {DynamicHeader} The codes and the header.
 */
function dynamicHeader(stats: Readonly<BlockStatistics>): DynamicHeader {
  const literalLengths = codeLengths(stats.literals, 15);
  const distanceLengths = codeLengths(stats.distances, 15);
  const literalCount = usedCount(literalLengths, 286, 257);
  const distanceCount = usedCount(distanceLengths, 30, 1);
  const all = new Uint8Array(literalCount + distanceCount);
  all.set(literalLengths.subarray(0, literalCount));
  all.set(distanceLengths.subarray(0, distanceCount), literalCount);
  const sequence = runLengths(all);
  const frequencies = new Uint32Array(19);
  for (let i = 0; i < sequence.length; i += 2) frequencies[sequence[i]!]!++;
  const codeLengthLengths = codeLengths(frequencies, 7);
  const codeLengthCount = usedCount(codeLengthLengths, 19, 4, CODE_LENGTH_ORDER);
  let bits = 14 + 3 * codeLengthCount;
  for (let i = 0; i < sequence.length; i += 2) {
    const symbol = sequence[i]!;
    bits += codeLengthLengths[symbol]! + (CODE_LENGTH_EXTRA[symbol - 16] ?? 0);
  }
  return {
    literalLengths,
    distanceLengths,
    literalCount,
    distanceCount,
    sequence,
    codeLengthLengths,
    codeLengthCount,
    bits,
  };
}

/**
 * Bits the symbols of a block take with given codes, extra bits included.
 *
 * @param stats - The block's symbol counts.
 * @param literals - Literal and length code lengths.
 * @param distances - Distance code lengths.
 * @returns {number} The size in bits.
 */
function symbolBits(
  stats: Readonly<BlockStatistics>,
  literals: Uint8Array,
  distances: Uint8Array,
): number {
  let bits = stats.extraBits;
  for (let code = 0; code < 286; code++) bits += stats.literals[code]! * literals[code]!;
  for (let code = 0; code < 30; code++) bits += stats.distances[code]! * distances[code]!;
  return bits;
}

/**
 * Writes the header of a dynamic block after its type.
 *
 * @param writer - The output.
 * @param header - The codes and the header.
 */
function writeDynamicHeader(writer: LsbWriter, header: Readonly<DynamicHeader>): void {
  writer.put(header.literalCount - 257, 5);
  writer.put(header.distanceCount - 1, 5);
  writer.put(header.codeLengthCount - 4, 4);
  for (let i = 0; i < header.codeLengthCount; i++) {
    writer.put(header.codeLengthLengths[CODE_LENGTH_ORDER[i]!]!, 3);
  }
  const codes = reversedCodes(header.codeLengthLengths);
  const { sequence } = header;
  for (let i = 0; i < sequence.length; i += 2) {
    const symbol = sequence[i]!;
    writer.put(codes[symbol]!, header.codeLengthLengths[symbol]!);
    if (symbol >= 16) writer.put(sequence[i + 1]!, CODE_LENGTH_EXTRA[symbol - 16]!);
  }
}

/**
 * Writes the symbols of a block with its codes, then the end of block.
 *
 * @param writer - The output.
 * @param block - The symbols.
 * @param stats - Their distance codes.
 * @param literals - Literal and length code lengths.
 * @param distances - Distance code lengths.
 */
function writeSymbols(
  writer: LsbWriter,
  block: Readonly<Block>,
  stats: Readonly<BlockStatistics>,
  literals: Uint8Array,
  distances: Uint8Array,
): void {
  const literalCodes = reversedCodes(literals);
  const distanceCodes = reversedCodes(distances);
  for (let i = 0; i < block.count; i++) {
    const code = block.codes[i]!;
    writer.put(literalCodes[code]!, literals[code]!);
    if (code <= 256) continue;
    const lengthIndex = code - 257;
    writer.put(block.lengths[i]! - LENGTH_BASE[lengthIndex]!, LENGTH_EXTRA[lengthIndex]!);
    const distance = stats.distanceCodes[i]!;
    writer.put(distanceCodes[distance]!, distances[distance]!);
    writer.put(block.distances[i]! - DISTANCE_BASE[distance]!, DISTANCE_EXTRA[distance]!);
  }
  writer.put(literalCodes[256]!, literals[256]!);
}

/**
 * Writes one block in whichever form is smallest: stored, fixed codes or dynamic codes.
 *
 * @param writer - The output.
 * @param block - The symbols.
 * @param input - The input, for a stored copy.
 * @param end - Input offset after the block.
 * @param last - Whether this is the final block.
 */
function writeBlock(
  writer: LsbWriter,
  block: Readonly<Block>,
  input: Uint8Array,
  end: number,
  last: boolean,
): void {
  const stats = statistics(block);
  const header = dynamicHeader(stats);
  const dynamicBits =
    header.bits + symbolBits(stats, header.literalLengths, header.distanceLengths);
  const fixedBits = symbolBits(stats, FIXED_LENGTHS, FIXED_DISTANCES);
  const raw = end - block.start;
  const storedBits = (raw + 5 * Math.max(1, Math.ceil(raw / 65535))) * 8 + 7;
  if (storedBits <= Math.min(dynamicBits, fixedBits)) {
    writeStored(writer, input.subarray(block.start, end), last);
    return;
  }
  const fixed = fixedBits <= dynamicBits;
  writer.put(last ? 1 : 0, 1);
  writer.put(fixed ? 1 : 2, 2);
  if (fixed) {
    writeSymbols(writer, block, stats, FIXED_LENGTHS, FIXED_DISTANCES);
  } else {
    writeDynamicHeader(writer, header);
    writeSymbols(writer, block, stats, header.literalLengths, header.distanceLengths);
  }
}

/**
 * Writes bytes as stored blocks of at most 65535 bytes each.
 *
 * @param writer - The output.
 * @param bytes - The bytes.
 * @param last - Whether the final one ends the stream.
 */
function writeStored(writer: LsbWriter, bytes: Uint8Array, last: boolean): void {
  let offset = 0;
  do {
    const length = Math.min(65535, bytes.length - offset);
    const final = last && offset + length === bytes.length;
    writer.put(final ? 1 : 0, 1);
    writer.put(0, 2);
    writer.align();
    writer.put(length & 0xffff, 16);
    writer.put(~length & 0xffff, 16);
    writer.append(bytes.subarray(offset, offset + length));
    offset += length;
  } while (offset < bytes.length);
}

/** LZ77 over hash chains, with zlib's greedy and lazy matching, feeding blocks to a writer. */
class Deflater {
  private readonly input: Uint8Array;
  private readonly tuning: Readonly<Tuning>;
  private readonly writer: LsbWriter;
  private readonly head = new Int32Array(HASH_SIZE).fill(-1);
  private readonly previous = new Int32Array(WINDOW).fill(-1);
  private readonly block = new Block();
  /** Distance of the match `longest` found last. */
  private distance = 0;

  /**
   * @param input - The bytes.
   * @param tuning - The level's search settings.
   * @param writer - The output.
   */
  constructor(input: Uint8Array, tuning: Readonly<Tuning>, writer: LsbWriter) {
    this.input = input;
    this.tuning = tuning;
    this.writer = writer;
  }

  /**
   * Adds a position to the hash chains.
   *
   * @param pos - The position.
   * @returns {number} The previous position with the same hash, or -1.
   */
  private insert(pos: number): number {
    const { input } = this;
    if (pos + MIN_MATCH > input.length) return -1;
    const hash = ((input[pos]! << 10) ^ (input[pos + 1]! << 5) ^ input[pos + 2]!) & (HASH_SIZE - 1);
    const candidate = this.head[hash]!;
    this.previous[pos & WINDOW_MASK] = candidate;
    this.head[hash] = pos;
    return candidate;
  }

  /**
   * Finds the longest match at `pos` along its hash chain, longer than `best`.
   *
   * @param pos - Where the match would start.
   * @param first - The first chain entry.
   * @param best - Length to beat.
   * @returns {number} The match length found, or `best`; its distance goes to `distance`.
   */
  private longest(pos: number, first: number, best: number): number {
    const limit = Math.min(MAX_MATCH, this.input.length - pos);
    if (limit < MIN_MATCH) return best;
    const enough = Math.min(this.tuning.nice, limit);
    const stop = Math.max(pos - WINDOW, -1);
    let steps = best >= this.tuning.good ? this.tuning.chain >> 2 : this.tuning.chain;
    for (let candidate = first; candidate > stop && steps > 0; steps--) {
      const run = this.matchAt(pos, candidate, best, limit);
      if (run > best) {
        best = run;
        this.distance = pos - candidate;
        if (run >= enough) break;
      }
      const next = this.previous[candidate & WINDOW_MASK]!;
      candidate = next < candidate ? next : stop;
    }
    return best;
  }

  /**
   * Measures a match, skipping candidates that cannot beat `best`.
   *
   * @param pos - Where the match would start.
   * @param candidate - Earlier position.
   * @param best - Length to beat.
   * @param limit - Longest match allowed.
   * @returns {number} The match length, or 0.
   */
  private matchAt(pos: number, candidate: number, best: number, limit: number): number {
    const { input } = this;
    if (input[candidate + best] !== input[pos + best] || input[candidate] !== input[pos]) return 0;
    let run = 1;
    while (run < limit && input[candidate + run] === input[pos + run]) run++;
    return run;
  }

  /**
   * Adds a literal to the block.
   *
   * @param byte - The literal.
   */
  private literal(byte: number): void {
    const { block } = this;
    block.codes[block.count] = byte;
    block.lengths[block.count++] = 0;
  }

  /**
   * Adds a match to the block.
   *
   * @param run - Its length.
   * @param distance - Its distance.
   */
  private match(run: number, distance: number): void {
    const { block } = this;
    block.codes[block.count] = LENGTH_CODE[run]!;
    block.lengths[block.count] = run;
    block.distances[block.count++] = distance;
  }

  /**
   * Writes the block once it is full, or when it is the last one.
   *
   * @param end - Input offset after the symbols in it.
   * @param last - Whether the input ends here.
   */
  flush(end: number, last: boolean): void {
    if (!last && this.block.count < BLOCK_SYMBOLS) return;
    writeBlock(this.writer, this.block, this.input, end, last);
    this.block.count = 0;
    this.block.start = end;
  }

  /** Greedy matching, as zlib's levels 1 to 3: take every match found. */
  greedy(): void {
    const { input } = this;
    let pos = 0;
    while (pos < input.length) {
      const run = this.longest(pos, this.insert(pos), MIN_MATCH - 1);
      if (run >= MIN_MATCH) {
        this.match(run, this.distance);
        const end = pos + run;
        if (run <= this.tuning.lazy) for (pos++; pos < end; pos++) this.insert(pos);
        pos = end;
      } else {
        this.literal(input[pos++]!);
      }
      this.flush(pos, false);
    }
  }

  /** Lazy matching, as zlib's levels 4 to 9: a match waits one byte for a longer one. */
  lazy(): void {
    const { input } = this;
    let pending = 0;
    let pendingDistance = 0;
    let waiting = false;
    for (let pos = 0; pos < input.length;) {
      const run = this.lazyRun(pos, pending);
      if (pending >= MIN_MATCH && run <= pending) {
        this.match(pending, pendingDistance);
        const end = pos - 1 + pending;
        for (pos++; pos < end; pos++) this.insert(pos);
        pending = 0;
        waiting = false;
      } else {
        if (waiting) this.literal(input[pos - 1]!);
        pending = run >= MIN_MATCH ? run : 0;
        pendingDistance = this.distance;
        waiting = true;
        pos++;
      }
      this.flush(pos - (waiting ? 1 : 0), false);
    }
    if (waiting) this.literal(input.at(-1)!);
  }

  /**
   * The match at `pos` the lazy matcher weighs against the one waiting.
   *
   * @param pos - The position.
   * @param pending - Length of the match waiting from the byte before.
   * @returns {number} The length found, below 3 for none.
   */
  private lazyRun(pos: number, pending: number): number {
    const candidate = this.insert(pos);
    if (candidate < 0 || pending >= this.tuning.lazy) return MIN_MATCH - 1;
    const run = this.longest(pos, candidate, pending >= MIN_MATCH ? pending : MIN_MATCH - 1);
    return run === MIN_MATCH && this.distance > 4096 ? MIN_MATCH - 1 : run;
  }
}

/**
 * Compresses bytes into one raw deflate stream.
 *
 * @param input - The bytes.
 * @param options - The level.
 * @returns {Uint8Array} The deflate data.
 */
export function deflateRaw(input: Uint8Array, options?: Readonly<DeflateOptions>): Uint8Array {
  const level = integerOption("level", options?.level, 0, 9, 6);
  const writer = new LsbWriter(Math.ceil(input.length / 2) + 64);
  if (level === 0) {
    writeStored(writer, input, true);
    return writer.finish();
  }
  const tuning = TUNING[level]!;
  const deflater = new Deflater(input, tuning, writer);
  if (tuning.lazyMatching) deflater.lazy();
  else deflater.greedy();
  deflater.flush(input.length, true);
  return writer.finish();
}
