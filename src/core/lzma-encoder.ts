/**
 * An LZMA encoder: hash chains find matches, the four reps are checked at every position, and a
 * one step lazy look decides between a match and a literal. No price optimizer, so it lands
 * between `xz -1` and `xz -6` in size, and every stream decodes with xz.
 */
import {
  ALIGN_BITS,
  END_POS_MODEL,
  LzmaModel,
  MATCH_MIN,
  MOVE_BITS,
  PROBABILITY_BITS,
  nextAfterLiteral,
  nextAfterMatch,
  nextAfterRep,
  nextAfterShortRep,
} from "./lzma-decoder.ts";

const MATCH_MAX = 273;
const HASH_BITS = 16;
const HASH_SIZE = 1 << HASH_BITS;

/** Range encoder writing into a growing buffer. */
export class RangeEncoder {
  bytes: Uint8Array;
  length = 0;
  private low = 0;
  private range = 0xffffffff;
  private cache = 0;
  private cacheSize = 1;

  /**
   * @param hint - Expected size.
   */
  constructor(hint = 1 << 16) {
    this.bytes = new Uint8Array(Math.max(hint, 64));
  }

  /**
   * Appends one byte.
   *
   * @param byte - The byte.
   */
  private write(byte: number): void {
    if (this.length === this.bytes.length) {
      const grown = new Uint8Array(this.bytes.length * 2);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes[this.length++] = byte;
  }

  /** Moves the top byte of `low` out, carrying into the bytes held back. */
  private shiftLow(): void {
    if (this.low < 0xff000000 || this.low >= 0x100000000) {
      const carry = this.low >= 0x100000000 ? 1 : 0;
      let temp = this.cache;
      do {
        this.write((temp + carry) & 0xff);
        temp = 0xff;
      } while (--this.cacheSize !== 0);
      this.cache = Math.floor(this.low / 0x1000000) & 0xff;
    }
    this.cacheSize++;
    this.low = (this.low % 0x1000000) * 256;
  }

  /**
   * Encodes one bit with an adaptive probability.
   *
   * @param probabilities - The table.
   * @param index - Which probability.
   * @param bit - 0 or 1.
   */
  bit(probabilities: Uint16Array, index: number, bit: number): void {
    const probability = probabilities[index]!;
    const bound = (this.range >>> PROBABILITY_BITS) * probability;
    if (bit === 0) {
      this.range = bound;
      probabilities[index] = probability + (((1 << PROBABILITY_BITS) - probability) >>> MOVE_BITS);
    } else {
      this.low += bound;
      this.range -= bound;
      probabilities[index] = probability - (probability >>> MOVE_BITS);
    }
    while (this.range < 0x1000000) {
      this.range = (this.range << 8) >>> 0;
      this.shiftLow();
    }
  }

  /**
   * Encodes bits with probability one half, highest first.
   *
   * @param value - The bits.
   * @param count - How many.
   */
  direct(value: number, count: number): void {
    for (let i = count - 1; i >= 0; i--) {
      this.range >>>= 1;
      if ((value >>> i) & 1) this.low += this.range;
      while (this.range < 0x1000000) {
        this.range = (this.range << 8) >>> 0;
        this.shiftLow();
      }
    }
  }

  /**
   * Encodes a bit tree, highest bit first.
   *
   * @param probabilities - The table.
   * @param offset - Where the tree starts.
   * @param bits - Levels.
   * @param value - The value.
   */
  tree(probabilities: Uint16Array, offset: number, bits: number, value: number): void {
    let m = 1;
    for (let i = bits - 1; i >= 0; i--) {
      const bit = (value >>> i) & 1;
      this.bit(probabilities, offset + m, bit);
      m = (m << 1) | bit;
    }
  }

  /**
   * Encodes a bit tree, lowest bit first.
   *
   * @param probabilities - The table.
   * @param offset - Where the tree starts.
   * @param bits - Levels.
   * @param value - The value.
   */
  reverseTree(probabilities: Uint16Array, offset: number, bits: number, value: number): void {
    let m = 1;
    for (let i = 0; i < bits; i++) {
      const bit = (value >>> i) & 1;
      this.bit(probabilities, offset + m, bit);
      m = (m << 1) | bit;
    }
  }

  /**
   * Bytes the coder will hold once flushed, the ones held back for a carry included.
   *
   * @returns {number} An upper bound on the flushed size.
   */
  pending(): number {
    return this.length + this.cacheSize + 4;
  }

  /**
   * Flushes the coder and copies out its bytes.
   *
   * @returns {Uint8Array} The range coded data.
   */
  finish(): Uint8Array {
    for (let i = 0; i < 5; i++) this.shiftLow();
    return this.bytes.slice(0, this.length);
  }
}

/**
 * The position slot of a distance.
 *
 * @param distance - Distance minus 1.
 * @returns {number} The slot, 0 to 63.
 */
function positionSlot(distance: number): number {
  if (distance < 4) return distance;
  const bits = 31 - Math.clz32(distance);
  return (bits << 1) | ((distance >>> (bits - 1)) & 1);
}

/** An LZMA encoder over one input, kept across LZMA2 chunks. */
export class LzmaEncoder {
  readonly model = new LzmaModel();
  private readonly input: Uint8Array;
  private readonly dictionarySize: number;
  private readonly head = new Int32Array(HASH_SIZE).fill(-1);
  private readonly previous: Int32Array;
  private readonly windowMask: number;
  private readonly chain: number;
  private readonly nice: number;
  /** Next position not yet in the hash chains. */
  private inserted = 0;

  /**
   * @param input - All the input; matches may reach back into any part already encoded.
   * @param dictionarySize - Farthest a match may reach.
   * @param chain - Hash chain steps per search.
   * @param nice - Match length that ends a search early.
   */
  constructor(input: Uint8Array, dictionarySize: number, chain: number, nice: number) {
    this.input = input;
    this.dictionarySize = dictionarySize;
    this.chain = chain;
    this.nice = nice;
    let window = 1;
    while (window < Math.min(dictionarySize, Math.max(input.length, 1))) window <<= 1;
    this.previous = new Int32Array(window).fill(-1);
    this.windowMask = window - 1;
    this.model.reset({ lc: 3, lp: 0, pb: 2 });
  }

  /**
   * Adds positions to the hash chains, up to `to`.
   *
   * @param to - First position not to add.
   */
  private insertUntil(to: number): void {
    const { input } = this;
    for (let pos = this.inserted; pos < to && pos + 3 <= input.length; pos++) {
      const hash = this.hash(pos);
      this.previous[pos & this.windowMask] = this.head[hash]!;
      this.head[hash] = pos;
    }
    this.inserted = Math.max(this.inserted, to);
  }

  /**
   * Counts equal bytes at two positions.
   *
   * @param a - First position.
   * @param b - Earlier position.
   * @param limit - Most bytes to count.
   * @returns {number} The match length.
   */
  private matchLength(a: number, b: number, limit: number): number {
    const { input } = this;
    let length = 0;
    while (length < limit && input[a + length] === input[b + length]) length++;
    return length;
  }

  /**
   * The hash of the three bytes at a position.
   *
   * @param pos - The position.
   * @returns {number} The hash.
   */
  private hash(pos: number): number {
    const { input } = this;
    return (
      ((input[pos]! << 8) ^ (input[pos + 1]! << 4) ^ (input[pos + 2]! * 0x9e3779b1)) &
      (HASH_SIZE - 1)
    );
  }

  /**
   * Finds the longest match at `pos` in the hash chains, without adding `pos`.
   *
   * @param pos - Where the match would start.
   * @param limit - Longest match allowed.
   * @param floor - Earliest position a match may start at.
   * @returns {[number, number]} Length and distance minus 1, or length 0.
   */
  private longest(pos: number, limit: number, floor: number): [number, number] {
    if (limit < 3 || pos + 3 > this.input.length) return [0, 0];
    const stop = Math.max(floor, pos - this.dictionarySize, pos - this.windowMask);
    const enough = Math.min(this.nice, limit);
    let best = 0;
    let distance = 0;
    let candidate = this.head[this.hash(pos)]!;
    // Every chain entry is an earlier position: `insertUntil` runs to `pos` first.
    for (let steps = this.chain; candidate >= stop && steps > 0; steps--) {
      const length =
        this.input[candidate + best] === this.input[pos + best]
          ? this.matchLength(pos, candidate, limit)
          : 0;
      if (length > best) {
        best = length;
        distance = pos - candidate - 1;
        if (length >= enough) break;
      }
      const next = this.previous[candidate & this.windowMask]!;
      candidate = next < candidate ? next : -1;
    }
    return [best, distance];
  }

  /**
   * Finds the longest match at one of the four last distances.
   *
   * @param pos - Where the match would start.
   * @param limit - Longest match allowed.
   * @param reach - How far back the dictionary goes from `pos`.
   * @returns {[number, number]} Length and which rep, or length 0.
   */
  private bestRep(pos: number, limit: number, reach: number): [number, number] {
    const { model } = this;
    const reps = [model.rep0, model.rep1, model.rep2, model.rep3];
    let best = 0;
    let index = 0;
    for (let i = 0; i < 4 && limit >= MATCH_MIN; i++) {
      const length = reps[i]! < reach ? this.matchLength(pos, pos - reps[i]! - 1, limit) : 0;
      if (length > best) {
        best = length;
        index = i;
      }
    }
    return [best, index];
  }

  /**
   * Encodes the bytes from `from` to `to`, matches reaching no further back than `floor`.
   *
   * @param rc - The range encoder of this chunk.
   * @param from - First position.
   * @param to - Position after the last.
   * @param floor - Where the dictionary starts.
   * @param budget - Stop once the coder would hold this many bytes, for LZMA2's 64 KiB chunks.
   * @returns {number} The position after the last byte encoded.
   */
  encode(rc: RangeEncoder, from: number, to: number, floor: number, budget = Infinity): number {
    let pos = from;
    while (pos < to && rc.pending() < budget) pos = this.step(rc, pos, to, floor);
    return pos;
  }

  /**
   * Encodes the next symbol at `pos`: a rep match, a match, a short rep or a literal.
   *
   * @param rc - The range encoder.
   * @param pos - The position.
   * @param to - Position after the last to encode.
   * @param floor - Where the dictionary starts.
   * @returns {number} The position after the symbol.
   */
  private step(rc: RangeEncoder, pos: number, to: number, floor: number): number {
    const limit = Math.min(MATCH_MAX, to - pos);
    const [repLength, repIndex] = this.bestRep(pos, limit, pos - floor);
    this.insertUntil(pos);
    const [mainLength, mainDistance] = this.longest(pos, limit, floor);
    this.insertUntil(pos + 1);
    if (repLength >= MATCH_MIN && repLength + 1 >= mainLength) {
      this.encodeRep(rc, pos, repIndex, repLength);
      this.insertUntil(pos + repLength);
      return pos + repLength;
    }
    if (this.worthMatch(pos, mainLength, mainDistance, to, floor)) {
      this.encodeMatch(rc, pos, mainDistance, mainLength);
      this.insertUntil(pos + mainLength);
      return pos + mainLength;
    }
    const reach = pos - floor;
    const short =
      mainLength < 2 &&
      reach > this.model.rep0 &&
      this.input[pos] === this.input[pos - this.model.rep0 - 1];
    if (short) this.encodeShortRep(rc, pos);
    else this.encodeLiteral(rc, pos, floor);
    return pos + 1;
  }

  /**
   * Whether to take the match at `pos` now: long enough, near enough for length 2, and not
   * beaten by more than one byte at the next position.
   *
   * @param pos - The position.
   * @param length - The match length.
   * @param distance - Its distance minus 1.
   * @param to - Position after the last to encode.
   * @param floor - Where the dictionary starts.
   * @returns {boolean} Whether to take it.
   */
  private worthMatch(
    pos: number,
    length: number,
    distance: number,
    to: number,
    floor: number,
  ): boolean {
    if (length < 2 || (length === 2 && distance >= 128)) return false;
    const [next] = this.longest(pos + 1, Math.min(MATCH_MAX, to - pos - 1), floor);
    return next <= length + 1;
  }

  /**
   * Encodes the byte at `pos` as a literal.
   *
   * @param rc - The range encoder.
   * @param pos - Its position.
   * @param floor - Where the dictionary starts, for the context.
   */
  private encodeLiteral(rc: RangeEncoder, pos: number, floor: number): void {
    const { input, model } = this;
    const position = pos - floor;
    const posState = position & ((1 << model.pb) - 1);
    rc.bit(model.isMatch, (model.state << 4) + posState, 0);
    const previous = position > 0 ? input[pos - 1]! : 0;
    const base =
      0x300 * (((position & ((1 << model.lp) - 1)) << model.lc) + (previous >>> (8 - model.lc)));
    const symbol = input[pos]!;
    let context = 1;
    let i = 7;
    if (model.state >= 7) {
      const match = input[pos - model.rep0 - 1]!;
      for (; i >= 0; i--) {
        const matchBit = (match >>> i) & 1;
        const bit = (symbol >>> i) & 1;
        rc.bit(model.literals, base + ((1 + matchBit) << 8) + context, bit);
        context = (context << 1) | bit;
        if (matchBit !== bit) {
          i--;
          break;
        }
      }
    }
    for (; i >= 0; i--) {
      const bit = (symbol >>> i) & 1;
      rc.bit(model.literals, base + context, bit);
      context = (context << 1) | bit;
    }
    model.state = nextAfterLiteral(model.state);
  }

  /**
   * Encodes a match or rep length.
   *
   * @param rc - The range encoder.
   * @param rep - Whether it is a rep length.
   * @param length - The length, 2 to 273.
   * @param posState - Low bits of the position.
   */
  private encodeLength(rc: RangeEncoder, rep: boolean, length: number, posState: number): void {
    const probabilities = rep ? this.model.repLength : this.model.length;
    const value = length - MATCH_MIN;
    if (value < 8) {
      rc.bit(probabilities.choice, 0, 0);
      rc.tree(probabilities.low, posState << 3, 3, value);
    } else if (value < 16) {
      rc.bit(probabilities.choice, 0, 1);
      rc.bit(probabilities.choice, 1, 0);
      rc.tree(probabilities.mid, posState << 3, 3, value - 8);
    } else {
      rc.bit(probabilities.choice, 0, 1);
      rc.bit(probabilities.choice, 1, 1);
      rc.tree(probabilities.high, 0, 8, value - 16);
    }
  }

  /**
   * Encodes a match with a new distance.
   *
   * @param rc - The range encoder.
   * @param pos - Its position.
   * @param distance - Distance minus 1.
   * @param length - Its length.
   */
  private encodeMatch(rc: RangeEncoder, pos: number, distance: number, length: number): void {
    const { model } = this;
    const posState = pos & ((1 << model.pb) - 1);
    rc.bit(model.isMatch, (model.state << 4) + posState, 1);
    rc.bit(model.isRep, model.state, 0);
    this.encodeLength(rc, false, length, posState);
    const slot = positionSlot(distance);
    rc.tree(model.posSlot, Math.min(length - MATCH_MIN, 3) << 6, 6, slot);
    if (slot >= 4) {
      const footer = (slot >>> 1) - 1;
      const base = (2 | (slot & 1)) << footer;
      const reduced = distance - base;
      if (slot < END_POS_MODEL) {
        rc.reverseTree(model.posSpecial, base - slot, footer, reduced);
      } else {
        rc.direct(reduced >>> ALIGN_BITS, footer - ALIGN_BITS);
        rc.reverseTree(model.align, 0, ALIGN_BITS, reduced & ((1 << ALIGN_BITS) - 1));
      }
    }
    model.rep3 = model.rep2;
    model.rep2 = model.rep1;
    model.rep1 = model.rep0;
    model.rep0 = distance;
    model.state = nextAfterMatch(model.state);
  }

  /**
   * Encodes a match at one of the four last distances.
   *
   * @param rc - The range encoder.
   * @param pos - Its position.
   * @param index - Which rep, 0 to 3.
   * @param length - Its length.
   */
  private encodeRep(rc: RangeEncoder, pos: number, index: number, length: number): void {
    const { model } = this;
    const posState = pos & ((1 << model.pb) - 1);
    rc.bit(model.isMatch, (model.state << 4) + posState, 1);
    rc.bit(model.isRep, model.state, 1);
    if (index === 0) {
      rc.bit(model.isRepG0, model.state, 0);
      rc.bit(model.isRep0Long, (model.state << 4) + posState, 1);
    } else {
      rc.bit(model.isRepG0, model.state, 1);
      if (index === 1) {
        rc.bit(model.isRepG1, model.state, 0);
        [model.rep0, model.rep1] = [model.rep1, model.rep0];
      } else {
        rc.bit(model.isRepG1, model.state, 1);
        rc.bit(model.isRepG2, model.state, index === 2 ? 0 : 1);
        const distance = index === 2 ? model.rep2 : model.rep3;
        if (index === 3) model.rep3 = model.rep2;
        model.rep2 = model.rep1;
        model.rep1 = model.rep0;
        model.rep0 = distance;
      }
    }
    this.encodeLength(rc, true, length, posState);
    model.state = nextAfterRep(model.state);
  }

  /**
   * Encodes one byte as a copy from rep0.
   *
   * @param rc - The range encoder.
   * @param pos - Its position.
   */
  private encodeShortRep(rc: RangeEncoder, pos: number): void {
    const { model } = this;
    const posState = pos & ((1 << model.pb) - 1);
    rc.bit(model.isMatch, (model.state << 4) + posState, 1);
    rc.bit(model.isRep, model.state, 1);
    rc.bit(model.isRepG0, model.state, 0);
    rc.bit(model.isRep0Long, (model.state << 4) + posState, 0);
    model.state = nextAfterShortRep(model.state);
  }
}
