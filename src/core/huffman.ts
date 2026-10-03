/** Prefix codes for the encoders: code lengths under a limit, and the codes those lengths give. */

/**
 * Lists the symbols that occur, adding the lowest unused ones until there are two, sorted by
 * frequency and then by symbol.
 *
 * @param frequencies - How often each symbol occurs.
 * @returns {number[]} The symbols, rarest first.
 */
function usedSymbols(frequencies: ArrayLike<number>): number[] {
  const symbols: number[] = [];
  for (let symbol = 0; symbol < frequencies.length; symbol++)
    if (frequencies[symbol]! > 0) symbols.push(symbol);
  for (let symbol = 0; symbols.length < 2 && symbol < frequencies.length; symbol++) {
    if (!symbols.includes(symbol)) symbols.push(symbol);
  }
  return symbols.sort((a, b) => frequencies[a]! - frequencies[b]! || a - b);
}

/**
 * Counts how many leaves end at each depth of a Huffman tree, built with two queues over leaves
 * already in order of weight.
 *
 * @param weights - Leaf weights, ascending.
 * @param size - Length of the count array to return.
 * @returns {Uint32Array} Leaves per depth.
 */
function depthCounts(weights: readonly number[], size: number): Uint32Array {
  const n = weights.length;
  const nodes = new Float64Array(2 * n - 1);
  const parents = new Int32Array(2 * n - 1);
  nodes.set(weights);
  let leaf = 0;
  let inner = n;
  const pick = (next: number): number =>
    leaf < n && (inner >= next || nodes[leaf]! <= nodes[inner]!) ? leaf++ : inner++;
  for (let next = n; next < 2 * n - 1; next++) {
    const a = pick(next);
    const b = pick(next);
    nodes[next] = nodes[a]! + nodes[b]!;
    parents[a] = next;
    parents[b] = next;
  }
  const depths = new Uint8Array(2 * n - 1);
  const perLength = new Uint32Array(Math.max(size, n) + 1);
  for (let node = 2 * n - 3; node >= 0; node--) depths[node] = depths[parents[node]!]! + 1;
  for (let i = 0; i < n; i++) perLength[depths[i]!]!++;
  return perLength;
}

/**
 * Folds the leaves past `limit` back in and keeps the code complete, as miniz does.
 *
 * @param perLength - Leaves per depth, changed in place.
 * @param limit - Longest code allowed.
 */
function limitDepths(perLength: Uint32Array, limit: number): void {
  let overflow = false;
  for (let length = limit + 1; length < perLength.length; length++) {
    if (perLength[length]) overflow = true;
    perLength[limit]! += perLength[length]!;
    perLength[length] = 0;
  }
  if (!overflow) return;
  let total = 0;
  for (let length = 1; length <= limit; length++)
    total += perLength[length]! * 2 ** (limit - length);
  for (; total !== 2 ** limit; total--) {
    perLength[limit]!--;
    let length = limit - 1;
    while (length > 0 && !perLength[length]) length--;
    perLength[length]!--;
    perLength[length + 1]! += 2;
  }
}

/**
 * Builds code lengths for symbol frequencies, none longer than `limit`. A symbol with frequency 0
 * gets length 0. When fewer than two symbols occur, the lowest unused ones are added, so a decoder
 * always sees a complete code with at least one bit per symbol.
 *
 * @param frequencies - How often each symbol occurs.
 * @param limit - Longest code allowed.
 * @returns {Uint8Array} The length of each symbol's code.
 */
export function codeLengths(frequencies: ArrayLike<number>, limit: number): Uint8Array {
  const lengths = new Uint8Array(frequencies.length);
  const symbols = usedSymbols(frequencies);
  if (symbols.length < 2) {
    for (const symbol of symbols) lengths[symbol] = 1;
    return lengths;
  }
  const perLength = depthCounts(
    symbols.map((symbol) => frequencies[symbol]!),
    limit,
  );
  limitDepths(perLength, limit);
  // The most frequent symbols take the shortest codes.
  let index = symbols.length - 1;
  for (let length = 1; length <= limit; length++) {
    for (let k = perLength[length]!; k > 0; k--) lengths[symbols[index--]!] = length;
  }
  return lengths;
}

/**
 * Assigns canonical codes to code lengths, as deflate and brotli do, each reversed so a writer
 * that puts the lowest bit first sends the code's first bit first.
 *
 * @param lengths - Code length per symbol.
 * @returns {Uint16Array} The reversed code per symbol.
 */
export function reversedCodes(lengths: ArrayLike<number>): Uint16Array {
  const counts = new Uint16Array(16);
  for (let i = 0; i < lengths.length; i++) counts[lengths[i]!]!++;
  counts[0] = 0;
  const next = new Uint16Array(16);
  let code = 0;
  for (let length = 1; length <= 15; length++) {
    code = (code + counts[length - 1]!) << 1;
    next[length] = code;
  }
  const codes = new Uint16Array(lengths.length);
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const length = lengths[symbol]!;
    if (length === 0) continue;
    let value = next[length]!++;
    let reversed = 0;
    for (let i = 0; i < length; i++) {
      reversed = (reversed << 1) | (value & 1);
      value >>>= 1;
    }
    codes[symbol] = reversed;
  }
  return codes;
}

/** Writes bits least significant first into a growing buffer. */
export class LsbWriter {
  /** The buffer; the first `length` bytes are written. */
  bytes: Uint8Array;
  /** Whole bytes written. */
  length = 0;
  /** Bits not yet a whole byte, lowest first. */
  private buf = 0;
  /** How many bits `buf` holds. */
  private count = 0;

  /**
   * @param hint - Expected output size.
   */
  constructor(hint = 1024) {
    this.bytes = new Uint8Array(Math.max(hint, 64));
  }

  /**
   * Makes room for `count` more bytes.
   *
   * @param count - Bytes about to be written.
   */
  private reserve(count: number): void {
    if (this.length + count <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < this.length + count) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
  }

  /**
   * Writes `n` bits of `value`, lowest first.
   *
   * @param value - The bits.
   * @param n - How many, 0 to 16.
   */
  put(value: number, n: number): void {
    this.buf |= value << this.count;
    this.count += n;
    if (this.count >= 8) {
      this.reserve(3);
      while (this.count >= 8) {
        this.bytes[this.length++] = this.buf & 0xff;
        this.buf >>>= 8;
        this.count -= 8;
      }
    }
  }

  /**
   * Pads with zero bits to the next byte boundary.
   */
  align(): void {
    if (this.count > 0) this.put(0, 8 - this.count);
  }

  /**
   * Writes whole bytes after `align`.
   *
   * @param chunk - The bytes.
   */
  append(chunk: Uint8Array): void {
    this.align();
    this.reserve(chunk.length);
    this.bytes.set(chunk, this.length);
    this.length += chunk.length;
  }

  /**
   * Copies out what was written, the last partial byte padded.
   *
   * @returns {Uint8Array} The bytes.
   */
  finish(): Uint8Array {
    this.align();
    return this.bytes.slice(0, this.length);
  }
}
