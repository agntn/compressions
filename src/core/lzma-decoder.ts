/**
 * The LZMA decoder, after Igor Pavlov's specification (lzma-specification.txt in the LZMA SDK):
 * a range decoder over adaptive bit probabilities. LZMA2 drives it chunk by chunk.
 */
import type { Output } from "./bytes.ts";

export const PROBABILITY_BITS = 11;
export const PROBABILITY_INIT = 1 << (PROBABILITY_BITS - 1);
export const MOVE_BITS = 5;
export const STATES = 12;
export const POS_STATES_MAX = 16;
export const MATCH_MIN = 2;
export const END_POS_MODEL = 14;
export const FULL_DISTANCES = 128;
export const ALIGN_BITS = 4;

/**
 * The state after a literal.
 *
 * @param state - The state before, 0 to 11.
 * @returns {number} The state after.
 */
export function nextAfterLiteral(state: number): number {
  if (state < 4) return 0;
  return state < 10 ? state - 3 : state - 6;
}

/**
 * The state after a match with a new distance.
 *
 * @param state - The state before.
 * @returns {number} The state after.
 */
export function nextAfterMatch(state: number): number {
  return state < 7 ? 7 : 10;
}

/**
 * The state after a rep match.
 *
 * @param state - The state before.
 * @returns {number} The state after.
 */
export function nextAfterRep(state: number): number {
  return state < 7 ? 8 : 11;
}

/**
 * The state after a short rep, one byte from rep0.
 *
 * @param state - The state before.
 * @returns {number} The state after.
 */
export function nextAfterShortRep(state: number): number {
  return state < 7 ? 9 : 11;
}

/** lc, lp and pb from a properties byte. */
export interface LzmaProperties {
  lc: number;
  lp: number;
  pb: number;
}

/**
 * Reads lc, lp and pb from the properties byte.
 *
 * @param byte - `(pb * 5 + lp) * 9 + lc`.
 * @returns {LzmaProperties | undefined} The three, or nothing when the byte is out of range.
 */
export function readProperties(byte: number): LzmaProperties | undefined {
  if (byte >= 9 * 5 * 5) return undefined;
  return { lc: byte % 9, lp: Math.floor(byte / 9) % 5, pb: Math.floor(byte / 45) };
}

/** Probabilities of the length coder. */
class LengthProbabilities {
  readonly choice = new Uint16Array(2);
  readonly low = new Uint16Array(POS_STATES_MAX << 3);
  readonly mid = new Uint16Array(POS_STATES_MAX << 3);
  readonly high = new Uint16Array(256);

  reset(): void {
    for (const table of [this.choice, this.low, this.mid, this.high]) table.fill(PROBABILITY_INIT);
  }
}

/** The adaptive model both the decoder and the encoder keep. */
export class LzmaModel {
  lc = 3;
  lp = 0;
  pb = 2;
  literals = new Uint16Array(0x300 << 3);
  readonly isMatch = new Uint16Array(STATES << 4);
  readonly isRep = new Uint16Array(STATES);
  readonly isRepG0 = new Uint16Array(STATES);
  readonly isRepG1 = new Uint16Array(STATES);
  readonly isRepG2 = new Uint16Array(STATES);
  readonly isRep0Long = new Uint16Array(STATES << 4);
  readonly posSlot = new Uint16Array(4 << 6);
  readonly posSpecial = new Uint16Array(1 + FULL_DISTANCES - END_POS_MODEL);
  readonly align = new Uint16Array(1 << ALIGN_BITS);
  readonly length = new LengthProbabilities();
  readonly repLength = new LengthProbabilities();
  state = 0;
  rep0 = 0;
  rep1 = 0;
  rep2 = 0;
  rep3 = 0;

  /**
   * Sets lc, lp and pb and resets every probability, the state and the reps.
   *
   * @param properties - lc, lp and pb.
   */
  reset(properties?: Readonly<LzmaProperties>): void {
    if (properties) {
      this.lc = properties.lc;
      this.lp = properties.lp;
      this.pb = properties.pb;
      const size = 0x300 << (this.lc + this.lp);
      if (this.literals.length !== size) this.literals = new Uint16Array(size);
    }
    for (const table of [
      this.literals,
      this.isMatch,
      this.isRep,
      this.isRepG0,
      this.isRepG1,
      this.isRepG2,
      this.isRep0Long,
      this.posSlot,
      this.posSpecial,
      this.align,
    ]) {
      table.fill(PROBABILITY_INIT);
    }
    this.length.reset();
    this.repLength.reset();
    this.state = 0;
    this.rep0 = 0;
    this.rep1 = 0;
    this.rep2 = 0;
    this.rep3 = 0;
  }
}

/** Range decoder over a slice of the input. */
class RangeDecoder {
  range = 0xffffffff;
  code = 0;
  pos: number;
  readonly data: Uint8Array;
  readonly end: number;
  readonly out: Output;

  /**
   * @param data - The input.
   * @param start - First byte of the range coded data.
   * @param end - Offset after its last byte.
   * @param out - The output, for errors.
   */
  constructor(data: Uint8Array, start: number, end: number, out: Output) {
    this.data = data;
    this.end = end;
    this.out = out;
    if (start + 5 > end) throw out.fail("unexpected end of data");
    if (data[start] !== 0) throw out.fail("range coder does not start with a zero byte", start);
    this.code =
      ((data[start + 1]! << 24) |
        (data[start + 2]! << 16) |
        (data[start + 3]! << 8) |
        data[start + 4]!) >>>
      0;
    this.pos = start + 5;
    if (this.code === this.range) throw out.fail("corrupted range coder state", start);
  }

  /** Loads a byte when the range gets small. */
  private normalize(): void {
    if (this.range < 0x1000000) {
      if (this.pos >= this.end) throw this.out.fail("unexpected end of data");
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.data[this.pos++]!) >>> 0;
    }
  }

  /**
   * Decodes one bit with an adaptive probability.
   *
   * @param probabilities - The table.
   * @param index - Which probability.
   * @returns {number} 0 or 1.
   */
  bit(probabilities: Uint16Array, index: number): number {
    const probability = probabilities[index]!;
    const bound = (this.range >>> PROBABILITY_BITS) * probability;
    let bit: number;
    if (this.code < bound) {
      this.range = bound;
      probabilities[index] = probability + (((1 << PROBABILITY_BITS) - probability) >>> MOVE_BITS);
      bit = 0;
    } else {
      this.range -= bound;
      this.code -= bound;
      probabilities[index] = probability - (probability >>> MOVE_BITS);
      bit = 1;
    }
    this.normalize();
    return bit;
  }

  /**
   * Decodes bits with fixed probability one half.
   *
   * @param count - How many.
   * @returns {number} Their value, first bit highest.
   */
  direct(count: number): number {
    let result = 0;
    for (; count > 0; count--) {
      this.range >>>= 1;
      let bit = 0;
      if (this.code >= this.range) {
        this.code -= this.range;
        bit = 1;
      }
      result = ((result << 1) | bit) >>> 0;
      this.normalize();
    }
    return result;
  }

  /**
   * Decodes a bit tree of `bits` levels, highest bit first.
   *
   * @param probabilities - The table.
   * @param offset - Where the tree starts in it.
   * @param bits - Levels.
   * @returns {number} The value.
   */
  tree(probabilities: Uint16Array, offset: number, bits: number): number {
    let m = 1;
    for (let i = 0; i < bits; i++) m = (m << 1) | this.bit(probabilities, offset + m);
    return m - (1 << bits);
  }

  /**
   * Decodes a bit tree of `bits` levels, lowest bit first.
   *
   * @param probabilities - The table.
   * @param offset - Where the tree starts in it.
   * @param bits - Levels.
   * @returns {number} The value.
   */
  reverseTree(probabilities: Uint16Array, offset: number, bits: number): number {
    let m = 1;
    let symbol = 0;
    for (let i = 0; i < bits; i++) {
      const bit = this.bit(probabilities, offset + m);
      m = (m << 1) | bit;
      symbol |= bit << i;
    }
    return symbol;
  }

  /**
   * Whether the coder ended clean: the code is zero after the last symbol.
   *
   * @returns {boolean} Whether it did.
   */
  finished(): boolean {
    return this.code === 0;
  }
}

/**
 * Decodes a match or rep length.
 *
 * @param rc - The range decoder.
 * @param lengths - The length probabilities.
 * @param posState - Low bits of the position.
 * @returns {number} Length minus 2, 0 to 271.
 */
function decodeLength(rc: RangeDecoder, lengths: LengthProbabilities, posState: number): number {
  if (rc.bit(lengths.choice, 0) === 0) return rc.tree(lengths.low, posState << 3, 3);
  if (rc.bit(lengths.choice, 1) === 0) return 8 + rc.tree(lengths.mid, posState << 3, 3);
  return 16 + rc.tree(lengths.high, 0, 8);
}

/**
 * Decodes a match distance.
 *
 * @param rc - The range decoder.
 * @param model - The model.
 * @param length - Length minus 2.
 * @returns {number} Distance minus 1; 0xffffffff is the end marker.
 */
function decodeDistance(rc: RangeDecoder, model: LzmaModel, length: number): number {
  const lengthState = Math.min(length, 3);
  const slot = rc.tree(model.posSlot, lengthState << 6, 6);
  if (slot < 4) return slot;
  const directBits = (slot >>> 1) - 1;
  let distance = ((2 | (slot & 1)) << directBits) >>> 0;
  if (slot < END_POS_MODEL) {
    return distance + rc.reverseTree(model.posSpecial, distance - slot, directBits);
  }
  distance = (distance + (rc.direct(directBits - ALIGN_BITS) << ALIGN_BITS)) >>> 0;
  return (distance + rc.reverseTree(model.align, 0, ALIGN_BITS)) >>> 0;
}

/** Where a decode stopped. */
export interface LzmaRun {
  /** Offset after the last byte the range decoder read. */
  end: number;
  /** Whether it stopped at an end marker. */
  marker: boolean;
}

/** What `decodeRep` and `decodeMatch` return besides a length: an end marker or a short rep. */
const END_MARKER = -1;
const SHORT_REP = 0;

/**
 * Decodes a literal, matched against the byte at rep0 after a match.
 *
 * @param rc - The range decoder.
 * @param model - The model.
 * @param out - Receives the byte.
 * @param position - Position since the dictionary start.
 */
function decodeLiteral(rc: RangeDecoder, model: LzmaModel, out: Output, position: number): void {
  const previous = position > 0 ? out.bytes[out.length - 1]! : 0;
  const base =
    0x300 * (((position & ((1 << model.lp) - 1)) << model.lc) + (previous >>> (8 - model.lc)));
  let symbol = 1;
  if (model.state >= 7) {
    let match = out.bytes[out.length - model.rep0 - 1]!;
    let matching = true;
    while (symbol < 0x100 && matching) {
      const matchBit = (match >>> 7) & 1;
      match <<= 1;
      const bit = rc.bit(model.literals, base + ((1 + matchBit) << 8) + symbol);
      symbol = (symbol << 1) | bit;
      matching = matchBit === bit;
    }
  }
  while (symbol < 0x100) symbol = (symbol << 1) | rc.bit(model.literals, base + symbol);
  out.push(symbol & 0xff);
  model.state = nextAfterLiteral(model.state);
}

/**
 * Decodes which of the four last distances a rep match takes and moves it to the front.
 *
 * @param rc - The range decoder.
 * @param model - The model.
 */
function chooseRep(rc: RangeDecoder, model: LzmaModel): void {
  const { state } = model;
  let distance: number;
  if (rc.bit(model.isRepG1, state) === 0) {
    distance = model.rep1;
  } else if (rc.bit(model.isRepG2, state) === 0) {
    distance = model.rep2;
    model.rep2 = model.rep1;
  } else {
    distance = model.rep3;
    model.rep3 = model.rep2;
    model.rep2 = model.rep1;
  }
  model.rep1 = model.rep0;
  model.rep0 = distance;
}

/**
 * Decodes a rep match after its isRep bit.
 *
 * @param rc - The range decoder.
 * @param model - The model.
 * @param posState - Low bits of the position.
 * @returns {number} Length minus 2, or `SHORT_REP` minus one for a one-byte copy.
 */
function decodeRep(rc: RangeDecoder, model: LzmaModel, posState: number): number {
  const { state } = model;
  if (rc.bit(model.isRepG0, state) !== 0) {
    chooseRep(rc, model);
  } else if (rc.bit(model.isRep0Long, (state << 4) + posState) === 0) {
    model.state = nextAfterShortRep(state);
    return SHORT_REP - 1;
  }
  model.state = nextAfterRep(state);
  return decodeLength(rc, model.repLength, posState);
}

/**
 * Decodes a match with a new distance after its isRep bit.
 *
 * @param rc - The range decoder.
 * @param model - The model.
 * @param posState - Low bits of the position.
 * @returns {number} Length minus 2, or `END_MARKER` minus one at the end marker.
 */
function decodeMatch(rc: RangeDecoder, model: LzmaModel, posState: number): number {
  model.rep3 = model.rep2;
  model.rep2 = model.rep1;
  model.rep1 = model.rep0;
  const length = decodeLength(rc, model.length, posState);
  model.state = nextAfterMatch(model.state);
  model.rep0 = decodeDistance(rc, model, length);
  return model.rep0 === 0xffffffff ? END_MARKER - 1 : length;
}

/**
 * Decodes LZMA symbols into `out` until `size` bytes came out (when known) or an end marker.
 *
 * @param model - The model, carried over between LZMA2 chunks.
 * @param data - The input.
 * @param start - First byte of the range coded data.
 * @param end - Offset after its last byte.
 * @param out - Receives the bytes.
 * @param size - Bytes to decode; -1 when only an end marker ends the stream.
 * @param dictionaryStart - Output offset before which no match may reach.
 * @param allowMarker - Whether an end marker may come before `size` bytes.
 * @returns {LzmaRun} Where it stopped.
 */
export function decodeLzma(
  model: LzmaModel,
  data: Uint8Array,
  start: number,
  end: number,
  out: Output,
  size: number,
  dictionaryStart: number,
  allowMarker: boolean,
): LzmaRun {
  const rc = new RangeDecoder(data, start, end, out);
  const target = size < 0 ? Number.POSITIVE_INFINITY : out.length + size;
  const posMask = (1 << model.pb) - 1;
  while (out.length < target) {
    const position = out.length - dictionaryStart;
    const posState = position & posMask;
    if (rc.bit(model.isMatch, (model.state << 4) + posState) === 0) {
      decodeLiteral(rc, model, out, position);
      continue;
    }
    const isRep = rc.bit(model.isRep, model.state) !== 0;
    const length = isRep ? decodeRep(rc, model, posState) : decodeMatch(rc, model, posState);
    if (length === END_MARKER - 1) return endAtMarker(rc, out, allowMarker);
    copyMatch(
      model,
      out,
      position,
      length === SHORT_REP - 1 ? 1 : length + MATCH_MIN,
      target,
      rc.pos,
    );
  }
  if (!rc.finished()) throw out.fail("range coder did not end clean", rc.pos);
  return { end: rc.pos, marker: false };
}

/**
 * Copies a match from rep0, refusing one that reaches before the start or past the size.
 *
 * @param model - The model, with the match distance in rep0.
 * @param out - The output.
 * @param position - Position since the dictionary start.
 * @param count - Bytes to copy.
 * @param target - Output length the stream stops at.
 * @param at - Input offset, for errors.
 */
function copyMatch(
  model: LzmaModel,
  out: Output,
  position: number,
  count: number,
  target: number,
  at: number,
): void {
  if (model.rep0 >= position)
    throw out.fail(`distance ${model.rep0 + 1} reaches before the start`, at);
  if (count > target - out.length) throw out.fail("match runs past the stated size", at);
  out.copy(model.rep0 + 1, count);
}

/**
 * Ends a decode at an end marker, when one may come there.
 *
 * @param rc - The range decoder.
 * @param out - The output, for errors.
 * @param allowMarker - Whether a marker may end this stream.
 * @returns {LzmaRun} Where it stopped.
 */
function endAtMarker(rc: RangeDecoder, out: Output, allowMarker: boolean): LzmaRun {
  if (!allowMarker) throw out.fail("end marker where none may be", rc.pos);
  if (!rc.finished()) throw out.fail("data after the end marker", rc.pos);
  return { end: rc.pos, marker: true };
}
