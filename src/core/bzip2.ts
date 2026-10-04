/**
 * bzip2, after Julian Seward's reference code and Joe Tsai's format notes: run-length coding,
 * the Burrows-Wheeler transform, move-to-front and Huffman codes in up to six tables.
 */
import { crc32 } from "@agntn/hashes/crc";
import { MsbReader } from "./bits.ts";
import type { Output } from "./bytes.ts";
import { defineCompression } from "./define.ts";
import { ChecksumError, UnsupportedError } from "./errors.ts";
import { codeLengths } from "./huffman.ts";
import type { Compression, Details } from "./types.ts";

const BLOCK_MAGIC_HIGH = 0x314159;
const BLOCK_MAGIC_LOW = 0x265359;
const END_MAGIC_HIGH = 0x177245;
const END_MAGIC_LOW = 0x385090;
const GROUP_SIZE = 50;
const MAX_GROUPS = 6;
const MAX_CODE_LENGTH = 20;
/** Longest code the encoder writes, as the reference encoder limits it. */
const WRITE_CODE_LENGTH = 17;

/**
 * Reads a block's checksum as an unsigned integer.
 *
 * @param bytes - The block's output.
 * @returns {number} CRC-32/BZIP2.
 */
function blockCrc(bytes: Uint8Array): number {
  const digest = crc32(bytes, "bzip2");
  return ((digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!) >>> 0;
}

/** A Huffman table in the reference decoder's form: limits, bases and symbols by code. */
interface Table {
  min: number;
  max: number;
  limit: Int32Array;
  base: Int32Array;
  perm: Uint16Array;
}

/**
 * Builds a decoding table from code lengths.
 *
 * @param lengths - Code length per symbol, 1 to 20.
 * @param count - Symbols in the alphabet.
 * @returns {Table} The table.
 */
function decodingTable(lengths: Uint8Array, count: number): Table {
  let min = MAX_CODE_LENGTH;
  let max = 0;
  for (let i = 0; i < count; i++) {
    min = Math.min(min, lengths[i]!);
    max = Math.max(max, lengths[i]!);
  }
  const perm = new Uint16Array(count);
  let index = 0;
  for (let length = min; length <= max; length++) {
    for (let symbol = 0; symbol < count; symbol++)
      if (lengths[symbol] === length) perm[index++] = symbol;
  }
  const base = new Int32Array(MAX_CODE_LENGTH + 2);
  const limit = new Int32Array(MAX_CODE_LENGTH + 2).fill(-1);
  const perLength = new Int32Array(MAX_CODE_LENGTH + 2);
  for (let i = 0; i < count; i++) perLength[lengths[i]!]!++;
  let code = 0;
  let seen = 0;
  for (let length = min; length <= max; length++) {
    base[length] = code - seen;
    code += perLength[length]!;
    seen += perLength[length]!;
    limit[length] = code - 1;
    code <<= 1;
  }
  return { min, max, limit, base, perm };
}

/**
 * Reads one symbol through a table.
 *
 * @param reader - The bit reader.
 * @param table - The table.
 * @returns {number} The symbol.
 */
function readSymbol(reader: MsbReader, table: Readonly<Table>): number {
  let length = table.min;
  let code = reader.bits(length);
  while (length <= table.max) {
    if (code <= table.limit[length]!) return table.perm[code - table.base[length]!]!;
    code = (code << 1) | reader.bit();
    length++;
  }
  throw reader.out.fail("invalid Huffman code", reader.byteOffset());
}

/**
 * Reads which of the 256 byte values the block uses, as sixteen ranges of sixteen.
 *
 * @param reader - The bit reader.
 * @returns {number[]} The used byte values, in order.
 */
function readSymbolMap(reader: MsbReader): number[] {
  const used = reader.bits(16);
  const symbols: number[] = [];
  for (let range = 0; range < 16; range++) {
    if (!(used & (0x8000 >>> range))) continue;
    const bits = reader.bits(16);
    for (let j = 0; j < 16; j++) if (bits & (0x8000 >>> j)) symbols.push(range * 16 + j);
  }
  if (symbols.length === 0) throw reader.out.fail("block uses no symbols", reader.byteOffset());
  return symbols;
}

/**
 * Reads the move-to-front coded selectors: which table each group of 50 symbols uses.
 *
 * @param reader - The bit reader.
 * @param groups - How many tables there are.
 * @returns {Uint8Array} The selectors.
 */
function readSelectors(reader: MsbReader, groups: number): Uint8Array {
  const count = reader.bits(15);
  if (count === 0) throw reader.out.fail("no selectors", reader.byteOffset());
  const order = [0, 1, 2, 3, 4, 5].slice(0, groups);
  const selectors = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    let index = 0;
    for (; reader.bit(); index++) {
      if (index + 1 >= groups) throw reader.out.fail("selector out of range", reader.byteOffset());
    }
    const [value] = order.splice(index, 1);
    order.unshift(value!);
    selectors[i] = value!;
  }
  return selectors;
}

/**
 * Reads the delta coded code lengths of one table.
 *
 * @param reader - The bit reader.
 * @param alphabet - Symbols in the table.
 * @returns {Table} The decoding table.
 */
function readTable(reader: MsbReader, alphabet: number): Table {
  const lengths = new Uint8Array(alphabet);
  let length = reader.bits(5);
  for (let symbol = 0; symbol < alphabet; symbol++) {
    for (;;) {
      if (length < 1 || length > MAX_CODE_LENGTH)
        throw reader.out.fail("code length out of range", reader.byteOffset());
      if (!reader.bit()) break;
      length += reader.bit() ? -1 : 1;
    }
    lengths[symbol] = length;
  }
  return decodingTable(lengths, alphabet);
}

/** The last column of the sorted rotations, as the Huffman stage gives it. */
interface Column {
  bytes: Uint8Array;
  counts: Int32Array;
  length: number;
}

/** Huffman, then the zero runs and move-to-front, into the BWT's last column. */
class ColumnReader {
  readonly column: Column;
  private readonly reader: MsbReader;
  private readonly mtf: Uint8Array;
  private readonly blockSize: number;
  private run = 0;
  private weight = 1;

  /**
   * @param reader - The bit reader.
   * @param symbols - The byte values the block uses.
   * @param blockSize - Most bytes the block may hold.
   */
  constructor(reader: MsbReader, symbols: readonly number[], blockSize: number) {
    this.reader = reader;
    this.mtf = Uint8Array.from(symbols);
    this.blockSize = blockSize;
    this.column = { bytes: new Uint8Array(blockSize), counts: new Int32Array(256), length: 0 };
  }

  /**
   * Reads symbols through the selected tables until the end of block symbol.
   *
   * @param tables - The Huffman tables.
   * @param selectors - The table of each group of 50.
   * @returns {Column} The column.
   */
  read(tables: ReadonlyArray<Readonly<Table>>, selectors: Uint8Array): Column {
    const end = this.mtf.length + 1;
    let group = 0;
    let symbol = -1;
    while (symbol !== end) {
      if (group >= selectors.length)
        throw this.reader.out.fail("ran out of selectors", this.reader.byteOffset());
      const table = tables[selectors[group++]!]!;
      for (let left = GROUP_SIZE; left > 0 && symbol !== end; left--) {
        symbol = readSymbol(this.reader, table);
        this.take(symbol, end);
      }
    }
    return this.column;
  }

  /**
   * Adds one symbol: a run digit, or a move-to-front index after the run it ends.
   *
   * @param symbol - The symbol.
   * @param end - The end of block symbol.
   */
  private take(symbol: number, end: number): void {
    if (symbol <= 1) {
      this.run += this.weight << symbol;
      this.weight <<= 1;
      if (this.run > this.blockSize)
        throw this.reader.out.fail("run passes the block size", this.reader.byteOffset());
      return;
    }
    this.flushRun();
    if (symbol !== end) this.push(symbol - 1);
  }

  /** Writes the pending run of the front byte. */
  private flushRun(): void {
    const { column, run } = this;
    if (run === 0) return;
    if (column.length + run > this.blockSize)
      throw this.reader.out.fail("block passes its size", this.reader.byteOffset());
    const byte = this.mtf[0]!;
    column.bytes.fill(byte, column.length, column.length + run);
    column.counts[byte]! += run;
    column.length += run;
    this.run = 0;
    this.weight = 1;
  }

  /**
   * Moves a byte to the front and writes it.
   *
   * @param index - Its place in the move-to-front list.
   */
  private push(index: number): void {
    const { column, mtf } = this;
    if (column.length >= this.blockSize)
      throw this.reader.out.fail("block passes its size", this.reader.byteOffset());
    const byte = mtf[index]!;
    mtf.copyWithin(1, 0, index);
    mtf[0] = byte;
    column.bytes[column.length++] = byte;
    column.counts[byte]!++;
  }
}

/**
 * Inverts the BWT: each entry holds its byte and, above it, where the next one is.
 *
 * @param column - The last column.
 * @returns {Uint32Array} The links.
 */
function links(column: Readonly<Column>): Uint32Array {
  const next = new Uint32Array(column.length);
  const starts = new Int32Array(256);
  for (let byte = 0, sum = 0; byte < 256; byte++) {
    starts[byte] = sum;
    sum += column.counts[byte]!;
  }
  for (let i = 0; i < column.length; i++) {
    const byte = column.bytes[i]!;
    next[i]! |= byte;
    next[starts[byte]!++]! |= i << 8;
  }
  return next;
}

/**
 * Walks the BWT links from the origin and undoes the first run-length coding: four equal bytes,
 * then a count of more.
 *
 * @param next - The links.
 * @param origin - Where the unrotated block sorts.
 * @param out - Receives the bytes.
 */
function writeBlockBytes(next: Uint32Array, origin: number, out: Output): void {
  let position = next[origin]! >>> 8;
  let previous = -1;
  let same = 0;
  for (let i = 0; i < next.length; i++) {
    const entry = next[position]!;
    const byte = entry & 0xff;
    position = entry >>> 8;
    if (same === 4) {
      out.copyByte(previous, byte);
      same = 0;
      previous = -1;
    } else {
      out.push(byte);
      same = byte === previous ? same + 1 : 1;
      previous = byte;
    }
  }
}

/**
 * Reads one block from after its magic and writes what it holds.
 *
 * @param reader - The bit reader.
 * @param out - Receives the bytes.
 * @param blockSize - Most bytes a block may hold, from the stream header.
 * @returns {number} The block's CRC as stored.
 */
function readBlock(reader: MsbReader, out: Output, blockSize: number): number {
  const storedCrc = reader.bits32();
  if (reader.bit()) {
    throw new UnsupportedError("bzip2", "randomized blocks, written by bzip2 before 0.9.5", {
      offset: reader.byteOffset(),
      partial: out.take(),
    });
  }
  const origin = reader.bits(24);
  const symbols = readSymbolMap(reader);
  const groups = reader.bits(3);
  if (groups < 2 || groups > MAX_GROUPS)
    throw out.fail(`${groups} Huffman tables`, reader.byteOffset());
  const selectors = readSelectors(reader, groups);
  const tables = Array.from({ length: groups }, () => readTable(reader, symbols.length + 2));
  const column = new ColumnReader(reader, symbols, blockSize).read(tables, selectors);
  if (origin >= column.length) throw out.fail("BWT origin past the block", reader.byteOffset());
  const from = out.length;
  writeBlockBytes(links(column), origin, out);
  if (blockCrc(out.bytes.subarray(from, out.length)) !== storedCrc) {
    throw new ChecksumError("bzip2", "block CRC does not match", {
      offset: reader.byteOffset(),
      partial: out.take(),
    });
  }
  return storedCrc;
}

/**
 * Reads one stream: the header, every block and the end of stream with the combined CRC.
 *
 * @param data - The input.
 * @param start - Offset of the stream.
 * @param out - Receives the bytes.
 * @returns {[number, number, number]} Offset after the stream, its level and its block count.
 */
function readStream(data: Uint8Array, start: number, out: Output): [number, number, number] {
  const digit = data[start + 3] ?? 0;
  if (!isStreamStart(data, start)) throw out.fail("not a bzip2 stream", start);
  const reader = new MsbReader(data, start + 4, out);
  let combined = 0;
  let blocks = 0;
  for (;;) {
    const high = reader.bits(24);
    const low = reader.bits(24);
    if (high === END_MAGIC_HIGH && low === END_MAGIC_LOW) break;
    if (high !== BLOCK_MAGIC_HIGH || low !== BLOCK_MAGIC_LOW)
      throw out.fail("no block or end-of-stream magic", reader.byteOffset());
    const crc = readBlock(reader, out, (digit - 0x30) * 100000);
    combined = (((combined << 1) | (combined >>> 31)) ^ crc) >>> 0;
    blocks++;
  }
  if (reader.bits32() !== combined) {
    throw new ChecksumError("bzip2", "stream CRC does not match", {
      offset: reader.byteOffset(),
      partial: out.take(),
    });
  }
  reader.align();
  return [reader.byteOffset(), digit - 0x30, blocks];
}

/**
 * Whether a bzip2 stream starts here: `BZh` and a block size digit.
 *
 * @param data - The input.
 * @param offset - Where to look.
 * @returns {boolean} Whether one does.
 */
function isStreamStart(data: Uint8Array, offset: number): boolean {
  const digit = data[offset + 3] ?? 0;
  return (
    data[offset] === 0x42 &&
    data[offset + 1] === 0x5a &&
    data[offset + 2] === 0x68 &&
    digit >= 0x31 &&
    digit <= 0x39
  );
}

/**
 * Reads every bzip2 stream in a row, as bunzip2 does.
 *
 * @param data - The input.
 * @param out - Receives the bytes.
 * @returns {Details} Block size, block and stream counts, trailing bytes.
 */
function decompress(data: Uint8Array, out: Output): Details {
  let [offset, level, blocks] = readStream(data, 0, out);
  let streams = 1;
  while (isStreamStart(data, offset)) {
    const [end, , more] = readStream(data, offset, out);
    offset = end;
    blocks += more;
    streams++;
  }
  const details: Details = { level, blocks };
  if (streams > 1) details["streams"] = streams;
  if (offset < data.length) details["trailing"] = data.length - offset;
  return details;
}

/** Writes bits most significant first into a growing buffer. */
class MsbWriter {
  bytes = new Uint8Array(1 << 16);
  length = 0;
  private buf = 0;
  private count = 0;

  /**
   * Writes the low `n` bits of `value`, highest first.
   *
   * @param value - The bits.
   * @param n - How many, 1 to 24.
   */
  put(value: number, n: number): void {
    this.buf = ((this.buf << n) | (value & ((1 << n) - 1))) >>> 0;
    this.count += n;
    while (this.count >= 8) {
      if (this.length === this.bytes.length) {
        const grown = new Uint8Array(this.bytes.length * 2);
        grown.set(this.bytes);
        this.bytes = grown;
      }
      this.count -= 8;
      this.bytes[this.length++] = (this.buf >>> this.count) & 0xff;
    }
    this.buf &= (1 << this.count) - 1;
  }

  /**
   * Writes 32 bits.
   *
   * @param value - Unsigned 32-bit value.
   */
  put32(value: number): void {
    this.put(value >>> 16, 16);
    this.put(value & 0xffff, 16);
  }

  /**
   * Pads the last byte with zeros and copies out the bytes.
   *
   * @returns {Uint8Array} The stream.
   */
  finish(): Uint8Array {
    if (this.count > 0) this.put(0, 8 - this.count);
    return this.bytes.slice(0, this.length);
  }
}

/** Rotations sorted by their first `k` bytes: the order, and each rotation's rank class. */
interface Sorted {
  order: Int32Array;
  rank: Int32Array;
  classes: number;
}

/**
 * Sorts the rotations of a block by their first byte, with a counting sort.
 *
 * @param block - The block.
 * @returns {Sorted} The order and the rank of each rotation.
 */
function sortByByte(block: Uint8Array): Sorted {
  const n = block.length;
  const order = new Int32Array(n);
  const rank = new Int32Array(n);
  const counts = new Int32Array(257);
  for (const byte of block) counts[byte + 1]!++;
  for (let i = 1; i < 257; i++) counts[i]! += counts[i - 1]!;
  for (let i = 0; i < n; i++) order[counts[block[i]!]!++] = i;
  let classes = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0 && block[order[i]!] !== block[order[i - 1]!]) classes++;
    rank[order[i]!] = classes;
  }
  return { order, rank, classes: classes + 1 };
}

/**
 * Doubles the sorted prefix from `k` to `2k` bytes: a stable counting sort by the first half of
 * an order already sorted by the second half, then new rank classes.
 *
 * @param sorted - Rotations sorted by `k` bytes, changed in place.
 * @param k - Bytes sorted so far.
 */
function doubleSort(sorted: Sorted, k: number): void {
  const { order, rank } = sorted;
  const n = order.length;
  const second = order.map((position) => (position - k + n) % n);
  const counts = new Int32Array(sorted.classes + 1);
  for (let i = 0; i < n; i++) counts[rank[i]! + 1]!++;
  for (let i = 1; i <= sorted.classes; i++) counts[i]! += counts[i - 1]!;
  for (const position of second) order[counts[rank[position]!]!++] = position;
  const next = new Int32Array(n);
  let classes = 0;
  for (let i = 1; i < n; i++) {
    const a = order[i - 1]!;
    const b = order[i]!;
    if (rank[a] !== rank[b] || rank[(a + k) % n] !== rank[(b + k) % n]) classes++;
    next[b] = classes;
  }
  sorted.rank = next;
  sorted.classes = classes + 1;
}

/**
 * Sorts the cyclic rotations of a block by prefix doubling, and writes the last column of the
 * sorted rotations.
 *
 * @param block - The block after run-length coding.
 * @returns {{ column: Uint8Array; origin: number }} The last column and where the unrotated block sorts.
 */
function bwt(block: Uint8Array): { column: Uint8Array; origin: number } {
  const n = block.length;
  const sorted = sortByByte(block);
  for (let k = 1; k < n && sorted.classes < n; k <<= 1) doubleSort(sorted, k);
  const column = new Uint8Array(n);
  let origin = 0;
  sorted.order.forEach((start, i) => {
    if (start === 0) origin = i;
    column[i] = block[(start + n - 1) % n]!;
  });
  return { column, origin };
}

/**
 * Move-to-front codes the last column, with runs of zeros in bijective base 2 as RUNA (0) and
 * RUNB (1), and ends with the end of block symbol.
 *
 * @param column - The last column.
 * @param symbols - The byte values the block uses.
 * @returns {Uint16Array} The symbols.
 */
function mtfCode(column: Uint8Array, symbols: readonly number[]): Uint16Array {
  const mtf = Uint8Array.from(symbols);
  const coded: number[] = [];
  let zeros = 0;
  const flush = (): void => {
    for (; zeros > 0; zeros >>>= 1) coded.push(--zeros & 1);
  };
  for (const byte of column) {
    const position = mtf.indexOf(byte);
    if (position === 0) {
      zeros++;
      continue;
    }
    flush();
    mtf.copyWithin(1, 0, position);
    mtf[0] = byte;
    coded.push(position + 1);
  }
  flush();
  coded.push(symbols.length + 1);
  return Uint16Array.from(coded);
}

/**
 * The starting cost tables: equal slices of the symbol frequencies, as the reference encoder
 * makes them.
 *
 * @param coded - The symbols.
 * @param alphabet - Symbols in the alphabet.
 * @param groups - How many tables.
 * @returns {Uint8Array[]} One cost table per group.
 */
function initialTables(coded: Uint16Array, alphabet: number, groups: number): Uint8Array[] {
  const frequencies = new Uint32Array(alphabet);
  for (const symbol of coded) frequencies[symbol]!++;
  const tables: Uint8Array[] = [];
  let remaining = coded.length;
  let low = 0;
  for (let part = groups; part > 0; part--) {
    let high = low - 1;
    let sum = 0;
    while (sum < remaining / part && high < alphabet - 1) sum += frequencies[++high]!;
    if (high > low && part !== groups && part !== 1 && (groups - part) % 2 === 1)
      sum -= frequencies[high--]!;
    tables.push(new Uint8Array(alphabet).fill(15).fill(0, low, high + 1));
    low = high + 1;
    remaining -= sum;
  }
  return tables;
}

/**
 * Picks the cheapest table for each group of 50 symbols, and counts the symbols per table.
 *
 * @param coded - The symbols.
 * @param tables - Code lengths per table.
 * @param selectors - Receives the choice per group.
 * @returns {Uint32Array[]} Symbol counts per table.
 */
function assignGroups(
  coded: Uint16Array,
  tables: readonly Uint8Array[],
  selectors: Uint8Array,
): Uint32Array[] {
  const tallies = tables.map(() => new Uint32Array(tables[0]!.length));
  for (let s = 0; s < selectors.length; s++) {
    const group = coded.subarray(s * GROUP_SIZE, (s + 1) * GROUP_SIZE);
    const costs = tables.map((table) => group.reduce((sum, symbol) => sum + table[symbol]!, 0));
    const best = costs.indexOf(Math.min(...costs));
    selectors[s] = best;
    for (const symbol of group) tallies[best]![symbol]!++;
  }
  return tallies;
}

/**
 * Builds the Huffman tables and selectors: equal slices first, then four rounds of assigning
 * groups and rebuilding codes from what each table got.
 *
 * @param coded - The symbols.
 * @param alphabet - Symbols in the alphabet.
 * @returns {{ tables: Uint8Array[]; selectors: Uint8Array }} Code lengths per table and the selectors.
 */
function huffmanTables(
  coded: Uint16Array,
  alphabet: number,
): { tables: Uint8Array[]; selectors: Uint8Array } {
  const count = coded.length;
  const groups = count < 200 ? 2 : count < 600 ? 3 : count < 1200 ? 4 : count < 2400 ? 5 : 6;
  let tables = initialTables(coded, alphabet, groups);
  const selectors = new Uint8Array(Math.ceil(count / GROUP_SIZE));
  for (let pass = 0; pass < 4; pass++) {
    const tallies = assignGroups(coded, tables, selectors);
    tables = tallies.map((tally) =>
      codeLengths(
        tally.map((value) => value * 2 + 1),
        WRITE_CODE_LENGTH,
      ),
    );
  }
  return { tables, selectors };
}

/**
 * Writes the map of byte values a block uses.
 *
 * @param writer - The output.
 * @param inUse - One flag per byte value.
 */
function writeSymbolMap(writer: MsbWriter, inUse: Uint8Array): void {
  let used = 0;
  for (let range = 0; range < 16; range++)
    if (inUse.subarray(range * 16, range * 16 + 16).some(Boolean)) used |= 0x8000 >>> range;
  writer.put(used, 16);
  for (let range = 0; range < 16; range++) {
    if (!(used & (0x8000 >>> range))) continue;
    let bits = 0;
    for (let j = 0; j < 16; j++) if (inUse[range * 16 + j]) bits |= 0x8000 >>> j;
    writer.put(bits, 16);
  }
}

/**
 * Writes the selectors, move-to-front coded in unary.
 *
 * @param writer - The output.
 * @param selectors - The table of each group.
 * @param groups - How many tables.
 */
function writeSelectors(writer: MsbWriter, selectors: Uint8Array, groups: number): void {
  writer.put(groups, 3);
  writer.put(selectors.length, 15);
  const order = Array.from({ length: groups }, (_, i) => i);
  for (const selector of selectors) {
    const position = order.indexOf(selector);
    for (let i = 0; i < position; i++) writer.put(1, 1);
    writer.put(0, 1);
    order.splice(position, 1);
    order.unshift(selector);
  }
}

/**
 * Writes the code lengths of a table, each as a delta from the one before.
 *
 * @param writer - The output.
 * @param table - Code lengths.
 */
function writeTable(writer: MsbWriter, table: Uint8Array): void {
  let current = table[0]!;
  writer.put(current, 5);
  for (const target of table) {
    for (; current < target; current++) writer.put(2, 2);
    for (; current > target; current--) writer.put(3, 2);
    writer.put(0, 1);
  }
}

/**
 * Assigns canonical codes to code lengths, most significant bit first.
 *
 * @param table - Code lengths.
 * @returns {Uint32Array} The code per symbol.
 */
function canonicalCodes(table: Uint8Array): Uint32Array {
  const codes = new Uint32Array(table.length);
  let code = 0;
  for (let length = 1; length <= WRITE_CODE_LENGTH; length++, code <<= 1) {
    for (let symbol = 0; symbol < table.length; symbol++)
      if (table[symbol] === length) codes[symbol] = code++;
  }
  return codes;
}

/**
 * Writes one block: its CRC, the BWT, move-to-front with zero runs, and the Huffman tables.
 *
 * @param writer - The output.
 * @param block - The block after run-length coding.
 * @param crc - CRC of the block's bytes before run-length coding.
 */
function writeBlock(writer: MsbWriter, block: Uint8Array, crc: number): void {
  const { column, origin } = bwt(block);
  const inUse = new Uint8Array(256);
  for (const byte of block) inUse[byte] = 1;
  const symbols = [...inUse.keys()].filter((byte) => inUse[byte]);
  const coded = mtfCode(column, symbols);
  const { tables, selectors } = huffmanTables(coded, symbols.length + 2);
  writer.put(BLOCK_MAGIC_HIGH, 24);
  writer.put(BLOCK_MAGIC_LOW, 24);
  writer.put32(crc);
  writer.put(0, 1);
  writer.put(origin, 24);
  writeSymbolMap(writer, inUse);
  writeSelectors(writer, selectors, tables.length);
  for (const table of tables) writeTable(writer, table);
  const codes = tables.map(canonicalCodes);
  selectors.forEach((selector, s) => {
    const table = tables[selector]!;
    const code = codes[selector]!;
    for (const symbol of coded.subarray(s * GROUP_SIZE, (s + 1) * GROUP_SIZE))
      writer.put(code[symbol]!, table[symbol]!);
  });
}

/**
 * Compresses into one bzip2 stream.
 *
 * @param input - The bytes.
 * @param level - 1 to 9, the block size in hundreds of kilobytes.
 * @returns {Uint8Array} The stream.
 */
function compress(input: Uint8Array, level: number): Uint8Array {
  const writer = new MsbWriter();
  writer.put(0x425a68, 24);
  writer.put(0x30 + level, 8);
  const limit = level * 100000 - 19;
  const block = new Uint8Array(level * 100000);
  let combined = 0;
  let position = 0;
  while (position < input.length) {
    // Run-length code as much input as fits: four equal bytes, then how many more follow.
    let size = 0;
    const start = position;
    while (position < input.length && size < limit) {
      const byte = input[position]!;
      let run = 1;
      while (run < 255 && position + run < input.length && input[position + run] === byte) run++;
      if (run >= 4) {
        block.fill(byte, size, size + 4);
        block[size + 4] = run - 4;
        size += 5;
      } else {
        block.fill(byte, size, size + run);
        size += run;
      }
      position += run;
    }
    const crc = blockCrc(input.subarray(start, position));
    combined = (((combined << 1) | (combined >>> 31)) ^ crc) >>> 0;
    writeBlock(writer, block.slice(0, size), crc);
  }
  writer.put(END_MAGIC_HIGH, 24);
  writer.put(END_MAGIC_LOW, 24);
  writer.put32(combined);
  return writer.finish();
}

export const bzip2: Compression = defineCompression({
  info: {
    name: "bzip2",
    label: "bzip2",
    description:
      "Burrows-Wheeler transform, move-to-front and Huffman codes: slow, and small on text",
    standard: "bzip2 1.0.8 (Julian Seward)",
    containers: [
      {
        name: "bzip2",
        label: "bzip2",
        standard: "bzip2 1.0.8 (Julian Seward)",
        extensions: [".bz2", ".tbz2"],
        magic: "425a68",
        checksum: "CRC-32/BZIP2",
      },
    ],
    compress: true,
    options: [
      {
        name: "level",
        type: "number",
        default: 9,
        min: 1,
        max: 9,
        description: "Block size in hundreds of kilobytes, 1 to 9",
      },
    ],
  },
  compress: (bytes, options) => compress(bytes, (options["level"] as number | undefined) ?? 9),
  decompress: (data, out) => decompress(data, out),
});
