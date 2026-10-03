/**
 * Brotli, read as RFC 7932 defines it: meta-blocks of prefix coded commands with block switching,
 * context modeling, the four last distances and references into the static dictionary.
 */
import { base64 } from "@agntn/encodings/base64";
import { LsbReader, reverseBits } from "./bits.ts";
import { Output } from "./bytes.ts";
import { DICTIONARY_DEFLATED } from "./brotli-dictionary.ts";
import { LUT0, LUT1, LUT2, TRANSFORMS } from "./brotli-tables.ts";
import { defineCompression } from "./define.ts";
import { inflateInto } from "./inflate.ts";
import type { Compression, Details } from "./types.ts";

const ROOT_BITS = 10;
const CODE_LENGTH_ORDER = [1, 2, 3, 4, 0, 5, 17, 6, 16, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;
/** The fixed code of the code length code lengths, by four peeked bits: its length and value. */
const CODE_LENGTH_PREFIX_LENGTH = [2, 2, 2, 3, 2, 2, 2, 4, 2, 2, 2, 3, 2, 2, 2, 4] as const;
const CODE_LENGTH_PREFIX_VALUE = [0, 4, 3, 2, 0, 4, 3, 1, 0, 4, 3, 2, 0, 4, 3, 5] as const;
const BLOCK_LENGTH_BASE = [
  1, 5, 9, 13, 17, 25, 33, 41, 49, 65, 81, 97, 113, 145, 177, 209, 241, 305, 369, 497, 753, 1265,
  2289, 4337, 8433, 16625,
] as const;
const BLOCK_LENGTH_EXTRA = [
  2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 7, 8, 9, 10, 11, 12, 13, 24,
] as const;
const INSERT_BASE = [
  0, 1, 2, 3, 4, 5, 6, 8, 10, 14, 18, 26, 34, 50, 66, 98, 130, 194, 322, 578, 1090, 2114, 6210,
  22594,
] as const;
const INSERT_EXTRA = [
  0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 9, 10, 12, 14, 24,
] as const;
const COPY_BASE = [
  2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 18, 22, 30, 38, 54, 70, 102, 134, 198, 326, 582, 1094, 2118,
] as const;
const COPY_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 9, 10, 24,
] as const;
/** Insert and copy length code bases of the eleven groups of 64 insert-and-copy symbols. */
const COMMAND_GROUPS = [
  [0, 0],
  [0, 8],
  [0, 0],
  [0, 8],
  [8, 0],
  [8, 8],
  [0, 16],
  [16, 0],
  [8, 16],
  [16, 8],
  [16, 16],
] as const;
/** Which last distance and what delta each of the sixteen short distance codes means. */
const SHORT_INDEX = [0, 1, 2, 3, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1] as const;
const SHORT_DELTA = [0, 0, 0, 0, -1, 1, -2, 2, -3, 3, -1, 1, -2, 2, -3, 3] as const;
/** Bits of the word index per word length 0 to 24 in the static dictionary. */
const DICTIONARY_BITS = [
  0, 0, 0, 0, 10, 10, 11, 11, 10, 10, 10, 10, 10, 9, 9, 8, 7, 7, 8, 7, 7, 6, 6, 5, 5,
] as const;
/** A block count that never runs out, for a category with one block type. */
const ENDLESS = 1 << 28;

let dictionary: { bytes: Uint8Array; offsets: Int32Array } | undefined;

/**
 * The static dictionary, inflated on first use, with the offset of each word length.
 *
 * @returns {{ bytes: Uint8Array; offsets: Int32Array }} The dictionary and its offsets.
 */
function staticDictionary(): { bytes: Uint8Array; offsets: Int32Array } {
  if (dictionary) return dictionary;
  const out = new Output("brotli", 1 << 17);
  inflateInto(base64.decode(DICTIONARY_DEFLATED), 0, out);
  const offsets = new Int32Array(26);
  for (let length = 4; length < 25; length++) {
    offsets[length + 1] = offsets[length]! + length * (1 << DICTIONARY_BITS[length]!);
  }
  dictionary = { bytes: out.take(), offsets };
  return dictionary;
}

/** A canonical prefix code: a root table for the short codes, ranges per length for the rest. */
interface PrefixCode {
  /** The one symbol of a code with a single symbol, which reads no bits. */
  single: number;
  root: Int32Array;
  first: Int32Array;
  counts: Int32Array;
  offsets: Int32Array;
  sorted: Uint16Array;
}

/**
 * Fills the root table with the codes no longer than its index width.
 *
 * @param counts - Codes per length.
 * @param offsets - Where each length starts in `sorted`.
 * @param sorted - Symbols in code order.
 * @returns {{ root: Int32Array; first: Int32Array }} The root table and the first code of each length.
 */
function rootTable(
  counts: Int32Array,
  offsets: Int32Array,
  sorted: Uint16Array,
): { root: Int32Array; first: Int32Array } {
  const first = new Int32Array(16);
  const root = new Int32Array(1 << ROOT_BITS).fill(-1);
  let code = 0;
  for (let length = 1; length < 16; length++, code <<= 1) {
    first[length] = code;
    for (let k = 0; k < counts[length]!; k++, code++) {
      if (length > ROOT_BITS) continue;
      const reversed = reverseBits(code, length);
      const entry = (sorted[offsets[length]! + k]! << 4) | length;
      for (let index = reversed; index < root.length; index += 1 << length) root[index] = entry;
    }
  }
  return { root, first };
}

/**
 * Builds a canonical prefix code from code lengths.
 *
 * @param lengths - Code length per symbol, 0 for none.
 * @param reader - The bit reader, for errors.
 * @returns {PrefixCode} The code.
 */
function prefixCode(lengths: Uint8Array, reader: LsbReader): PrefixCode {
  const counts = new Int32Array(16);
  for (const length of lengths) counts[length]!++;
  counts[0] = 0;
  const used = counts.reduce((sum, count) => sum + count, 0);
  const empty = new Int32Array(0);
  if (used === 1)
    return {
      single: lengths.findIndex(Boolean),
      root: empty,
      first: empty,
      counts,
      offsets: empty,
      sorted: new Uint16Array(0),
    };
  const space = counts.reduce((left, count, length) => left - (count << (15 - length)), 1 << 15);
  if (space !== 0) throw reader.out.fail("prefix code is not complete", reader.byteOffset());
  const offsets = new Int32Array(17);
  for (let length = 1; length < 16; length++)
    offsets[length + 1] = offsets[length]! + counts[length]!;
  const sorted = new Uint16Array(used);
  const next = offsets.slice();
  lengths.forEach((length, symbol) => {
    if (length) sorted[next[length]!++] = symbol;
  });
  const { root, first } = rootTable(counts, offsets, sorted);
  return { single: -1, root, first, counts, offsets, sorted };
}

/**
 * Reads a symbol longer than the root table, one bit at a time against the canonical ranges.
 *
 * @param reader - The bit reader, with 15 bits loaded.
 * @param code - The code.
 * @returns {number} The symbol.
 */
function readLongSymbol(reader: LsbReader, code: Readonly<PrefixCode>): number {
  let value = 0;
  for (let length = 1; length < 16; length++) {
    value = (value << 1) | ((reader.buf >>> (length - 1)) & 1);
    const index = value - code.first[length]!;
    if (index < 0 || index >= code.counts[length]!) continue;
    reader.buf >>>= length;
    reader.count -= length;
    return code.sorted[code.offsets[length]! + index]!;
  }
  throw reader.out.fail("invalid prefix code", reader.byteOffset());
}

/**
 * Reads one symbol of a prefix code.
 *
 * @param reader - The bit reader.
 * @param code - The code.
 * @returns {number} The symbol.
 */
function readSymbol(reader: LsbReader, code: Readonly<PrefixCode>): number {
  if (code.single >= 0) return code.single;
  reader.need(15);
  const entry = code.root[reader.buf & ((1 << ROOT_BITS) - 1)]!;
  if (entry < 0) return readLongSymbol(reader, code);
  const length = entry & 15;
  reader.buf >>>= length;
  reader.count -= length;
  return entry >>> 4;
}

const SIMPLE_SHAPES: Readonly<Record<number, readonly number[]>> = {
  1: [1],
  2: [1, 1],
  3: [1, 2, 2],
  4: [2, 2, 2, 2],
};

/**
 * Reads a simple prefix code: up to four symbols with lengths their count sets.
 *
 * @param reader - The bit reader, after the two HSKIP bits.
 * @param alphabet - Size of the alphabet as the stream counts it.
 * @param limit - Symbols that may occur.
 * @returns {PrefixCode} The code.
 */
function readSimpleCode(reader: LsbReader, alphabet: number, limit: number): PrefixCode {
  const width = Math.max(1, 32 - Math.clz32(alphabet - 1));
  const count = reader.bits(2) + 1;
  const symbols = Array.from({ length: count }, () => reader.bits(width));
  if (symbols.some((symbol) => symbol >= limit))
    throw reader.out.fail("simple prefix code symbol out of range", reader.byteOffset());
  if (new Set(symbols).size !== count)
    throw reader.out.fail("simple prefix code repeats a symbol", reader.byteOffset());
  const shape = count === 4 && reader.bits(1) ? [1, 2, 3, 3] : SIMPLE_SHAPES[count]!;
  const lengths = new Uint8Array(alphabet);
  symbols.forEach((symbol, i) => (lengths[symbol] = shape[i]!));
  return prefixCode(lengths, reader);
}

/**
 * Reads the code length code lengths of a complex prefix code, in their fixed order.
 *
 * @param reader - The bit reader.
 * @param skip - How many of the first ones are zero, from HSKIP.
 * @returns {PrefixCode} The code length code.
 */
function readCodeLengthCode(reader: LsbReader, skip: number): PrefixCode {
  const lengths = new Uint8Array(18);
  let space = 32;
  let nonzero = 0;
  for (let i = skip; i < 18 && space > 0; i++) {
    reader.need(4);
    const peek = reader.buf & 15;
    reader.buf >>>= CODE_LENGTH_PREFIX_LENGTH[peek]!;
    reader.count -= CODE_LENGTH_PREFIX_LENGTH[peek]!;
    const value = CODE_LENGTH_PREFIX_VALUE[peek]!;
    lengths[CODE_LENGTH_ORDER[i]!] = value;
    space -= value ? 32 >>> value : 0;
    nonzero += value ? 1 : 0;
  }
  if (nonzero !== 1 && space !== 0)
    throw reader.out.fail("code length code is not complete", reader.byteOffset());
  return prefixCode(lengths, reader);
}

/** The state of reading code lengths: the last nonzero length and the repeat run. */
interface LengthRun {
  previous: number;
  repeat: number;
  repeatLength: number;
}

/**
 * Applies a repeat code, 16 for the last nonzero length or 17 for zeros, whose counts build on
 * a repeat just before.
 *
 * @param reader - The bit reader.
 * @param code - 16 or 17.
 * @param run - The repeat state, changed in place.
 * @returns {number} How many more lengths it adds.
 */
function repeatLengths(reader: LsbReader, code: number, run: LengthRun): number {
  const extraBits = code === 16 ? 2 : 3;
  const value = code === 16 ? run.previous : 0;
  if (run.repeatLength !== value) {
    run.repeat = 0;
    run.repeatLength = value;
  }
  const old = run.repeat;
  if (run.repeat > 0) run.repeat = (run.repeat - 2) << extraBits;
  run.repeat += reader.bits(extraBits) + 3;
  return run.repeat - old;
}

/**
 * Reads one code length code symbol: a length, or a repeat of the last nonzero one or of zeros.
 *
 * @param reader - The bit reader.
 * @param codeLengthCode - The code length code.
 * @param run - The repeat state, changed in place.
 * @returns {[number, number]} The length and how many symbols take it.
 */
function lengthStep(
  reader: LsbReader,
  codeLengthCode: Readonly<PrefixCode>,
  run: LengthRun,
): [number, number] {
  const code = readSymbol(reader, codeLengthCode);
  if (code >= 16) {
    const count = repeatLengths(reader, code, run);
    return [run.repeatLength, count];
  }
  run.repeat = 0;
  if (code !== 0) run.previous = code;
  return [code, 1];
}

/**
 * Reads the symbol code lengths of a complex prefix code.
 *
 * @param reader - The bit reader.
 * @param alphabet - Size of the alphabet.
 * @param codeLengthCode - The code length code.
 * @returns {Uint8Array} The code lengths.
 */
function readSymbolLengths(
  reader: LsbReader,
  alphabet: number,
  codeLengthCode: Readonly<PrefixCode>,
): Uint8Array {
  const lengths = new Uint8Array(alphabet);
  const run: LengthRun = { previous: 8, repeat: 0, repeatLength: 0 };
  let left = 1 << 15;
  for (let symbol = 0; symbol < alphabet && left > 0;) {
    const [length, count] = lengthStep(reader, codeLengthCode, run);
    if (symbol + count > alphabet)
      throw reader.out.fail("code lengths run past the alphabet", reader.byteOffset());
    lengths.fill(length, symbol, symbol + count);
    symbol += count;
    left -= length ? count << (15 - length) : 0;
  }
  if (left !== 0) throw reader.out.fail("prefix code is not complete", reader.byteOffset());
  return lengths;
}

/**
 * Reads a prefix code description, simple or complex, for an alphabet.
 *
 * @param reader - The bit reader.
 * @param alphabet - Size of the alphabet as the stream counts it.
 * @param limit - Symbols that may occur, which is smaller for distance codes.
 * @returns {PrefixCode} The code.
 */
function readPrefixCode(reader: LsbReader, alphabet: number, limit = alphabet): PrefixCode {
  const skip = reader.bits(2);
  if (skip === 1) return readSimpleCode(reader, alphabet, limit);
  const lengths = readSymbolLengths(reader, alphabet, readCodeLengthCode(reader, skip));
  if (lengths.subarray(limit).some(Boolean))
    throw reader.out.fail("prefix code uses a symbol out of range", reader.byteOffset());
  return prefixCode(lengths, reader);
}

/**
 * Reads a count of 1 to 256 as the stream writes NBLTYPES and NTREES.
 *
 * @param reader - The bit reader.
 * @returns {number} The count.
 */
function readCount(reader: LsbReader): number {
  if (!reader.bits(1)) return 1;
  const bits = reader.bits(3);
  return bits === 0 ? 2 : (1 << bits) + reader.bits(bits) + 1;
}

/**
 * Reads a block count.
 *
 * @param reader - The bit reader.
 * @param code - The block count code.
 * @returns {number} The count.
 */
function readBlockLength(reader: LsbReader, code: Readonly<PrefixCode>): number {
  const symbol = readSymbol(reader, code);
  return BLOCK_LENGTH_BASE[symbol]! + reader.bits(BLOCK_LENGTH_EXTRA[symbol]!);
}

/** Block switching state of one category: literals, commands or distances. */
interface Blocks {
  types: number;
  typeCode?: PrefixCode;
  lengthCode?: PrefixCode;
  type: number;
  previous: number;
  left: number;
}

/**
 * Reads the block switching header of one category.
 *
 * @param reader - The bit reader.
 * @returns {Blocks} Its state.
 */
function readBlocks(reader: LsbReader): Blocks {
  const types = readCount(reader);
  if (types < 2) return { types, type: 0, previous: 1, left: ENDLESS };
  const typeCode = readPrefixCode(reader, types + 2);
  const lengthCode = readPrefixCode(reader, 26);
  return {
    types,
    typeCode,
    lengthCode,
    type: 0,
    previous: 1,
    left: readBlockLength(reader, lengthCode),
  };
}

/**
 * Switches to the next block of a category when the current one ran out.
 *
 * @param reader - The bit reader.
 * @param blocks - The category's state.
 */
function nextBlock(reader: LsbReader, blocks: Blocks): void {
  if (blocks.left > 0) {
    blocks.left--;
    return;
  }
  const symbol = readSymbol(reader, blocks.typeCode!);
  let type = symbol === 0 ? blocks.previous : symbol === 1 ? blocks.type + 1 : symbol - 2;
  if (type >= blocks.types) type -= blocks.types;
  blocks.previous = blocks.type;
  blocks.type = type;
  blocks.left = readBlockLength(reader, blocks.lengthCode!) - 1;
}

/**
 * Reads the run-length coded entries of a context map.
 *
 * @param reader - The bit reader.
 * @param size - Entries in the map.
 * @param trees - How many trees the map points to.
 * @returns {Uint8Array} The entries, still move-to-front coded when the stream says so.
 */
function readContextEntries(reader: LsbReader, size: number, trees: number): Uint8Array {
  const map = new Uint8Array(size);
  const runLengthMax = reader.bits(1) ? reader.bits(4) + 1 : 0;
  const code = readPrefixCode(reader, trees + runLengthMax);
  for (let i = 0; i < size;) {
    const symbol = readSymbol(reader, code);
    const run = symbol > 0 && symbol <= runLengthMax ? (1 << symbol) + reader.bits(symbol) : 1;
    if (i + run > size)
      throw reader.out.fail("context map run passes its size", reader.byteOffset());
    if (symbol > runLengthMax) map[i] = symbol - runLengthMax;
    i += run;
  }
  return map;
}

/**
 * Undoes move-to-front coding in place.
 *
 * @param map - The entries.
 */
function inverseMoveToFront(map: Uint8Array): void {
  const order = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0; i < map.length; i++) {
    const value = order[map[i]!]!;
    order.splice(map[i]!, 1);
    order.unshift(value);
    map[i] = value;
  }
}

/**
 * Reads a context map: run-length coded zeros, then an optional inverse move-to-front.
 *
 * @param reader - The bit reader.
 * @param size - Entries in the map.
 * @returns {[Uint8Array, number]} The map and how many trees it points to.
 */
function readContextMap(reader: LsbReader, size: number): [Uint8Array, number] {
  const trees = readCount(reader);
  if (trees < 2) return [new Uint8Array(size), trees];
  const map = readContextEntries(reader, size, trees);
  if (reader.bits(1)) inverseMoveToFront(map);
  if (map.some((value) => value >= trees))
    throw reader.out.fail("context map points past its trees", reader.byteOffset());
  return [map, trees];
}

/**
 * Upper-cases one character of a dictionary word as RFC 7932 does, UTF-8 by its lead byte.
 *
 * @param word - The word's bytes.
 * @param at - Where the character starts.
 * @returns {number} How many bytes the character takes.
 */
function ferment(word: Uint8Array, at: number): number {
  const byte = word[at]!;
  if (byte < 192) {
    if (byte >= 97 && byte <= 122) word[at] = byte ^ 32;
    return 1;
  }
  if (byte < 224) {
    if (at + 1 < word.length) word[at + 1]! ^= 32;
    return 2;
  }
  if (at + 2 < word.length) word[at + 2]! ^= 5;
  return 3;
}

/**
 * Writes a dictionary word with one of the 121 transforms.
 *
 * @param out - Receives the bytes.
 * @param length - Word length, 4 to 24.
 * @param index - Word index in its length.
 * @param transform - Transform id, 0 to 120.
 */
function writeWord(out: Output, length: number, index: number, transform: number): void {
  const { bytes, offsets } = staticDictionary();
  const start = offsets[length]! + index * length;
  let word = bytes.slice(start, start + length);
  const [prefix, type, suffix] = TRANSFORMS[transform]!;
  if (type >= 12) word = word.subarray(0, Math.max(0, length - (type - 11)));
  else if (type >= 3) word = word.subarray(Math.min(length, type - 2));
  if (type === 1 && word.length > 0) ferment(word, 0);
  if (type === 2) for (let i = 0; i < word.length;) i += ferment(word, i);
  for (const character of prefix) out.push(character.codePointAt(0)!);
  out.append(word);
  for (const character of suffix) out.push(character.codePointAt(0)!);
}

/** Decoder state that lives across meta-blocks. */
interface StreamState {
  window: number;
  distances: [number, number, number, number];
}

/** One compressed meta-block: its block switching, context maps and prefix codes. */
class MetaBlock {
  private readonly reader: LsbReader;
  private readonly out: Output;
  private readonly stream: StreamState;
  private readonly end: number;
  private readonly literalBlocks: Blocks;
  private readonly commandBlocks: Blocks;
  private readonly distanceBlocks: Blocks;
  private readonly postfix: number;
  private readonly direct: number;
  private readonly modes: Uint8Array;
  private readonly literalMap: Uint8Array;
  private readonly distanceMap: Uint8Array;
  private readonly literalCodes: PrefixCode[];
  private readonly commandCodes: PrefixCode[];
  private readonly distanceCodes: PrefixCode[];

  /**
   * Reads the meta-block header after its length fields.
   *
   * @param reader - The bit reader.
   * @param out - Receives the bytes.
   * @param length - Bytes the meta-block holds.
   * @param stream - State across meta-blocks.
   */
  constructor(reader: LsbReader, out: Output, length: number, stream: StreamState) {
    this.reader = reader;
    this.out = out;
    this.stream = stream;
    this.end = out.length + length;
    this.literalBlocks = readBlocks(reader);
    this.commandBlocks = readBlocks(reader);
    this.distanceBlocks = readBlocks(reader);
    this.postfix = reader.bits(2);
    this.direct = reader.bits(4) << this.postfix;
    this.modes = Uint8Array.from({ length: this.literalBlocks.types }, () => reader.bits(2));
    let trees: number;
    [this.literalMap, trees] = readContextMap(reader, this.literalBlocks.types << 6);
    let distanceTrees: number;
    [this.distanceMap, distanceTrees] = readContextMap(reader, this.distanceBlocks.types << 2);
    this.literalCodes = Array.from({ length: trees }, () => readPrefixCode(reader, 256));
    this.commandCodes = Array.from({ length: this.commandBlocks.types }, () =>
      readPrefixCode(reader, 704),
    );
    const alphabet = 16 + this.direct + (48 << this.postfix);
    const limit = 16 + this.direct + (24 << (this.postfix + 1));
    this.distanceCodes = Array.from({ length: distanceTrees }, () =>
      readPrefixCode(reader, alphabet, limit),
    );
  }

  /** Reads commands until the meta-block is full. */
  run(): void {
    while (this.out.length < this.end) {
      nextBlock(this.reader, this.commandBlocks);
      const command = readSymbol(this.reader, this.commandCodes[this.commandBlocks.type]!);
      const [insertBase, copyBase] = COMMAND_GROUPS[command >>> 6]!;
      const insertCode = insertBase + ((command >>> 3) & 7);
      const copyCode = copyBase + (command & 7);
      const insert = INSERT_BASE[insertCode]! + this.reader.bits(INSERT_EXTRA[insertCode]!);
      const copy = COPY_BASE[copyCode]! + this.reader.bits(COPY_EXTRA[copyCode]!);
      this.literals(insert);
      if (this.out.length >= this.end) return;
      const code = command >= 128 ? this.distanceCode(copy) : 0;
      this.backReference(this.distance(code), code, copy);
      this.reader.checkEnd();
    }
  }

  /**
   * Reads literals, each through the tree its context picks.
   *
   * @param count - How many.
   */
  private literals(count: number): void {
    const { out, reader, literalBlocks } = this;
    if (out.length + count > this.end)
      throw out.fail("insert runs past the meta-block", reader.byteOffset());
    for (let i = 0; i < count; i++) {
      nextBlock(reader, literalBlocks);
      const context = literalContext(this.modes[literalBlocks.type]!, out);
      out.push(
        readSymbol(
          reader,
          this.literalCodes[this.literalMap[(literalBlocks.type << 6) + context]!]!,
        ),
      );
    }
    reader.checkEnd();
  }

  /**
   * Reads a distance code through the tree the copy length picks.
   *
   * @param copy - The copy length.
   * @returns {number} The distance code.
   */
  private distanceCode(copy: number): number {
    nextBlock(this.reader, this.distanceBlocks);
    const context = copy > 4 ? 3 : copy - 2;
    return readSymbol(
      this.reader,
      this.distanceCodes[this.distanceMap[(this.distanceBlocks.type << 2) + context]!]!,
    );
  }

  /**
   * Turns a distance code into a distance: one of the last four with a delta, a direct one, or
   * one with extra bits and a postfix.
   *
   * @param code - The distance code.
   * @returns {number} The distance.
   */
  private distance(code: number): number {
    const { direct, postfix } = this;
    if (code < 16) {
      const distance = this.stream.distances[SHORT_INDEX[code]!]! + SHORT_DELTA[code]!;
      if (distance <= 0) throw this.out.fail("distance below one", this.reader.byteOffset());
      return distance;
    }
    if (code < 16 + direct) return code - 15;
    const value = code - direct - 16;
    const bits = 1 + (value >>> (postfix + 1));
    const offset = ((2 + ((value >>> postfix) & 1)) << bits) - 4;
    return (
      ((offset + this.reader.bits(bits)) << postfix) + (value & ((1 << postfix) - 1)) + direct + 1
    );
  }

  /**
   * Copies from the output, or past the window writes a dictionary word.
   *
   * @param distance - The distance.
   * @param code - The distance code; only codes past 0 go into the last four.
   * @param copy - The copy length, or the word length.
   */
  private backReference(distance: number, code: number, copy: number): void {
    const { out, reader } = this;
    const reach = Math.min(this.stream.window, out.length);
    if (distance > reach) {
      this.word(distance - reach - 1, copy);
      return;
    }
    if (code !== 0)
      this.stream.distances = [
        distance,
        ...this.stream.distances.slice(0, 3),
      ] as StreamState["distances"];
    if (out.length + copy > this.end)
      throw out.fail("copy runs past the meta-block", reader.byteOffset());
    out.copy(distance, copy);
  }

  /**
   * Writes a dictionary word with its transform.
   *
   * @param id - Word index and transform, as the distance past the window gives them.
   * @param length - The word length.
   */
  private word(id: number, length: number): void {
    const { out, reader } = this;
    if (length < 4 || length > 24)
      throw out.fail(`dictionary word of length ${length}`, reader.byteOffset());
    const bits = DICTIONARY_BITS[length]!;
    const transform = Math.floor(id / 2 ** bits);
    if (transform >= TRANSFORMS.length)
      throw out.fail("dictionary transform out of range", reader.byteOffset());
    const before = out.length;
    writeWord(out, length, id % 2 ** bits, transform);
    if (out.length <= this.end) return;
    out.length = before;
    throw out.fail("dictionary word runs past the meta-block", reader.byteOffset());
  }
}

/**
 * The context of the next literal from the two bytes before it, by the block's context mode.
 *
 * @param mode - 0 LSB6, 1 MSB6, 2 UTF8, 3 signed.
 * @param out - The output so far.
 * @returns {number} The context, 0 to 63.
 */
function literalContext(mode: number, out: Output): number {
  const p1 = out.length > 0 ? out.bytes[out.length - 1]! : 0;
  const p2 = out.length > 1 ? out.bytes[out.length - 2]! : 0;
  if (mode === 0) return p1 & 0x3f;
  if (mode === 1) return p1 >>> 2;
  return mode === 2 ? LUT0[p1]! | LUT1[p2]! : (LUT2[p1]! << 3) | LUT2[p2]!;
}

/**
 * Reads the window size from the stream header.
 *
 * @param reader - The bit reader at the start.
 * @returns {number} WBITS, 10 to 24.
 */
function readWindowBits(reader: LsbReader): number {
  if (!reader.bits(1)) return 16;
  const n = reader.bits(3);
  if (n !== 0) return 17 + n;
  const m = reader.bits(3);
  if (m === 1) throw reader.out.fail("large window brotli is not RFC 7932", 0);
  return m === 0 ? 17 : 8 + m;
}

/**
 * Skips to the next byte boundary, refusing padding bits that are not zero.
 *
 * @param reader - The bit reader.
 * @returns {number} The byte offset there.
 */
function alignZero(reader: LsbReader): number {
  if (reader.bits((8 - (reader.bitOffset() & 7)) & 7))
    throw reader.out.fail("padding bits are not zero", reader.byteOffset());
  return reader.byteOffset();
}

/**
 * Moves the reader to a byte offset, dropping what it had loaded.
 *
 * @param reader - The bit reader.
 * @param offset - The byte offset.
 */
function seek(reader: LsbReader, offset: number): void {
  reader.buf = 0;
  reader.count = 0;
  reader.pos = offset;
}

/**
 * Reads a length of `count` nibbles or bytes, refusing a needless zero at the top.
 *
 * @param reader - The bit reader.
 * @param count - How many parts.
 * @param width - Bits per part: 4 or 8.
 * @param min - Parts below which a zero top part is fine.
 * @returns {number} The value.
 */
function readLength(reader: LsbReader, count: number, width: number, min: number): number {
  let value = 0;
  for (let i = 0; i < count; i++) {
    const part = reader.bits(width);
    if (i + 1 === count && count > min && part === 0)
      throw reader.out.fail("length has a needless zero at the top", reader.byteOffset());
    value += part * 2 ** (width * i);
  }
  return value;
}

/**
 * Skips a metadata meta-block.
 *
 * @param reader - The bit reader, after MNIBBLES.
 */
function skipMetadata(reader: LsbReader): void {
  if (reader.bits(1)) throw reader.out.fail("reserved metadata bit is set", reader.byteOffset());
  const bytes = reader.bits(2);
  const skip = bytes === 0 ? 0 : readLength(reader, bytes, 8, 1) + 1;
  const at = alignZero(reader);
  if (at + skip > reader.data.length) throw reader.out.fail("unexpected end of data");
  seek(reader, at + skip);
}

/**
 * Copies an uncompressed meta-block.
 *
 * @param reader - The bit reader, after ISUNCOMPRESSED.
 * @param length - Its length.
 */
function copyUncompressed(reader: LsbReader, length: number): void {
  const at = alignZero(reader);
  const { data, out } = reader;
  out.append(data.subarray(at, at + length));
  if (at + length > data.length) throw out.fail("unexpected end of data");
  seek(reader, at + length);
}

/**
 * Reads one meta-block header and its content.
 *
 * @param reader - The bit reader.
 * @param stream - State across meta-blocks.
 * @returns {[boolean, boolean]} Whether it was the last one, and whether it held data.
 */
function readMetaBlock(reader: LsbReader, stream: StreamState): [boolean, boolean] {
  const last = reader.bits(1) === 1;
  if (last && reader.bits(1)) return [true, false];
  const nibbles = reader.bits(2);
  if (nibbles === 3) {
    skipMetadata(reader);
    return [last, false];
  }
  const length = readLength(reader, nibbles + 4, 4, 4) + 1;
  if (!last && reader.bits(1)) copyUncompressed(reader, length);
  else new MetaBlock(reader, reader.out, length, stream).run();
  return [last, true];
}

/**
 * Reads a brotli stream.
 *
 * @param data - The input.
 * @param out - Receives the bytes.
 * @returns {Details} The window, meta-block count and trailing bytes.
 */
function decompress(data: Uint8Array, out: Output): Details {
  const reader = new LsbReader(data, 0, out);
  const stream: StreamState = {
    window: (1 << readWindowBits(reader)) - 16,
    distances: [4, 11, 15, 16],
  };
  let blocks = 0;
  for (let last = false; !last;) {
    let held: boolean;
    [last, held] = readMetaBlock(reader, stream);
    if (held) blocks++;
  }
  reader.checkEnd();
  const end = alignZero(reader);
  const details: Details = { window: stream.window, metaBlocks: blocks };
  if (end < data.length) details["trailing"] = data.length - end;
  return details;
}

export const brotli: Compression = defineCompression({
  info: {
    name: "brotli",
    label: "Brotli",
    description:
      "LZ77 with context modeling and a built-in dictionary of web words: HTTP and WOFF2",
    standard: "RFC 7932",
    containers: [
      { name: "brotli", label: "Brotli stream", standard: "RFC 7932", extensions: [".br"] },
    ],
    compress: false,
    options: [],
  },
  decompress: (data, out) => decompress(data, out),
});
