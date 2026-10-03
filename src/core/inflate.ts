/** Inflate: reads raw deflate data as RFC 1951 defines it. zlib and gzip wrap it. */
import { LsbReader, lsbDecoder, readSymbol } from "./bits.ts";
import type { Output } from "./bytes.ts";

export const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
] as const;
export const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
] as const;
export const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
] as const;
export const DISTANCE_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
] as const;
/** Order the code length code lengths come in. */
export const CODE_LENGTH_ORDER = [
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
] as const;

type Decoder = { table: Int32Array; bits: number };

/** A bit reader that knows where this stream's output started, so a match can't reach before it. */
class InflateReader extends LsbReader {
  /** Output length when this stream started. */
  windowStart = 0;
}

let fixed: { literals: Decoder; distances: Decoder } | undefined;

/**
 * The fixed codes of block type 1, built on first use.
 *
 * @returns {{ literals: Decoder; distances: Decoder }} Both decoders.
 */
function fixedDecoders(): { literals: Decoder; distances: Decoder } {
  if (fixed) return fixed;
  const lengths = new Uint8Array(288);
  lengths.fill(8, 0, 144);
  lengths.fill(9, 144, 256);
  lengths.fill(7, 256, 280);
  lengths.fill(8, 280, 288);
  fixed = {
    literals: lsbDecoder(lengths, 288)!,
    distances: lsbDecoder(new Uint8Array(30).fill(5), 30)!,
  };
  return fixed;
}

/**
 * Reads the run-length coded code lengths of a dynamic block.
 *
 * @param reader - The bit reader.
 * @param codeLengths - The code length code.
 * @param count - Literal and distance lengths to read.
 * @returns {Uint8Array} The lengths.
 */
function readLengths(
  reader: InflateReader,
  codeLengths: Readonly<Decoder>,
  count: number,
): Uint8Array {
  const { out } = reader;
  const lengths = new Uint8Array(count);
  let index = 0;
  while (index < count) {
    const symbol = readSymbol(reader, codeLengths);
    if (symbol < 16) {
      lengths[index++] = symbol;
      continue;
    }
    if (symbol === 16 && index === 0)
      throw out.fail("repeat with no previous length", reader.byteOffset());
    const value = symbol === 16 ? lengths[index - 1]! : 0;
    const repeat =
      symbol === 16 ? 3 + reader.bits(2) : symbol === 17 ? 3 + reader.bits(3) : 11 + reader.bits(7);
    if (index + repeat > count)
      throw out.fail("code lengths run past their count", reader.byteOffset());
    lengths.fill(value, index, index + repeat);
    index += repeat;
  }
  return lengths;
}

/**
 * Reads the code lengths of a dynamic block and builds its two decoders.
 *
 * @param reader - The bit reader, after the block type.
 * @returns {{ literals: Decoder; distances: Decoder }} Both decoders.
 */
function dynamicDecoders(reader: InflateReader): { literals: Decoder; distances: Decoder } {
  const { out } = reader;
  const literalCount = reader.bits(5) + 257;
  const distanceCount = reader.bits(5) + 1;
  const codeLengthCount = reader.bits(4) + 4;
  if (literalCount > 286 || distanceCount > 30) {
    throw out.fail("too many length or distance codes", reader.byteOffset());
  }
  const codeLengthLengths = new Uint8Array(19);
  for (let i = 0; i < codeLengthCount; i++) {
    codeLengthLengths[CODE_LENGTH_ORDER[i]!] = reader.bits(3);
  }
  const codeLengths = lsbDecoder(codeLengthLengths, 19);
  if (!codeLengths) throw out.fail("over-subscribed code length code", reader.byteOffset());
  const lengths = readLengths(reader, codeLengths, literalCount + distanceCount);
  if (lengths[256] === 0) throw out.fail("no end-of-block code", reader.byteOffset());
  const literals = lsbDecoder(lengths.subarray(0, literalCount), literalCount);
  const distances = lsbDecoder(lengths.subarray(literalCount), distanceCount);
  if (!literals || !distances) {
    throw out.fail("over-subscribed literal or distance code", reader.byteOffset());
  }
  return { literals, distances };
}

/**
 * Decodes the symbols of one compressed block until its end-of-block code.
 *
 * @param reader - The bit reader.
 * @param literals - Literal and length decoder.
 * @param distances - Distance decoder.
 */
function inflateBlock(
  reader: InflateReader,
  literals: Readonly<Decoder>,
  distances: Readonly<Decoder>,
): void {
  const { out } = reader;
  for (;;) {
    const symbol = readSymbol(reader, literals);
    if (symbol < 256) {
      // Past the input the reader reads zeros; check before they turn into output.
      if (reader.pos > reader.data.length) reader.checkEnd();
      out.push(symbol);
    } else if (symbol === 256) {
      reader.checkEnd();
      return;
    } else {
      const lengthCode = symbol - 257;
      if (lengthCode >= 29) throw out.fail("invalid length code", reader.byteOffset());
      const length = LENGTH_BASE[lengthCode]! + reader.bits(LENGTH_EXTRA[lengthCode]!);
      const distanceCode = readSymbol(reader, distances);
      if (distanceCode >= 30) throw out.fail("invalid distance code", reader.byteOffset());
      const distance = DISTANCE_BASE[distanceCode]! + reader.bits(DISTANCE_EXTRA[distanceCode]!);
      if (reader.pos > reader.data.length) reader.checkEnd();
      if (distance > out.length - reader.windowStart) {
        throw out.fail(`distance ${distance} reaches before the start`, reader.byteOffset());
      }
      out.copy(distance, length);
    }
  }
}

/**
 * Inflates one raw deflate stream from `start` into `out`.
 *
 * @param data - The input.
 * @param start - Offset of the stream's first byte.
 * @param out - Receives the bytes.
 * @returns {number} Offset of the first byte after the stream, the final block rounded up to a
 * whole byte.
 */
export function inflateInto(data: Uint8Array, start: number, out: Output): number {
  const reader = new InflateReader(data, start, out);
  reader.windowStart = out.length;
  let last = 0;
  while (!last) {
    last = reader.bits(1);
    const type = reader.bits(2);
    if (type === 0) {
      reader.align();
      const offset = reader.byteOffset();
      reader.buf = 0;
      reader.count = 0;
      reader.pos = offset;
      if (offset + 4 > data.length) throw out.fail("unexpected end of data");
      const length = data[offset]! | (data[offset + 1]! << 8);
      const check = data[offset + 2]! | (data[offset + 3]! << 8);
      if ((length ^ 0xffff) !== check) {
        throw out.fail("stored block length does not match its complement", offset);
      }
      const from = offset + 4;
      if (from + length > data.length) {
        out.append(data.subarray(from));
        throw out.fail("unexpected end of data");
      }
      out.append(data.subarray(from, from + length));
      reader.pos = from + length;
    } else if (type === 1) {
      const { literals, distances } = fixedDecoders();
      inflateBlock(reader, literals, distances);
    } else if (type === 2) {
      const { literals, distances } = dynamicDecoders(reader);
      inflateBlock(reader, literals, distances);
    } else {
      throw out.fail("invalid block type 3", reader.byteOffset());
    }
  }
  reader.checkEnd();
  reader.align();
  return reader.byteOffset();
}
