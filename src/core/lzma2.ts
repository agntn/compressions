/** LZMA2: LZMA in chunks of up to 2 MiB, each compressed or stored, as xz blocks carry it. */
import { concat, type Output } from "./bytes.ts";
import { LzmaModel, decodeLzma, readProperties } from "./lzma-decoder.ts";
import { LzmaEncoder, RangeEncoder } from "./lzma-encoder.ts";

/** Most uncompressed bytes in one LZMA2 chunk. */
const CHUNK_UNPACKED = 1 << 21;
/** Most compressed bytes in one LZMA2 chunk, with room for the symbol that crosses it. */
const CHUNK_BUDGET = (1 << 16) - 256;
/** Most bytes in one uncompressed LZMA2 chunk. */
const CHUNK_STORED = 1 << 16;

/**
 * The dictionary size an LZMA2 properties byte names.
 *
 * @param byte - 0 to 40.
 * @returns {number} The size in bytes.
 */
export function lzma2Dictionary(byte: number): number {
  return byte === 40 ? 0xffffffff : (2 | (byte & 1)) * 2 ** (Math.floor(byte / 2) + 11);
}

/**
 * The smallest LZMA2 dictionary properties byte that covers a size.
 *
 * @param size - Dictionary size in bytes.
 * @returns {number} 0 to 40.
 */
export function lzma2DictionaryByte(size: number): number {
  let byte = 0;
  while (byte < 40 && lzma2Dictionary(byte) < size) byte++;
  return byte;
}

/** Reads LZMA2 chunks, keeping what each chunk needs reset before the next may come. */
class Lzma2Reader {
  private readonly data: Uint8Array;
  private readonly end: number;
  private readonly out: Output;
  private readonly model = new LzmaModel();
  private dictionaryStart: number;
  private needDictionary = true;
  private needProperties = true;
  private needState = true;

  /**
   * @param data - The input.
   * @param end - Offset after the block's compressed data.
   * @param out - Receives the bytes.
   */
  constructor(data: Uint8Array, end: number, out: Output) {
    this.data = data;
    this.end = end;
    this.out = out;
    this.dictionaryStart = out.length;
  }

  /**
   * Reads chunks from `offset` until the end chunk.
   *
   * @param offset - First chunk.
   * @returns {number} Offset after the end chunk.
   */
  run(offset: number): number {
    for (;;) {
      if (offset >= this.end) throw this.out.fail("unexpected end of data");
      const control = this.data[offset]!;
      if (control === 0) return offset + 1;
      this.resetDictionary(control, offset);
      offset = control < 0x80 ? this.stored(control, offset) : this.compressed(control, offset);
    }
  }

  /**
   * Resets the dictionary when the control byte says so, and refuses a chunk that needs one.
   *
   * @param control - The control byte.
   * @param offset - Its offset, for errors.
   */
  private resetDictionary(control: number, offset: number): void {
    if (control >= 0xe0 || control === 1) {
      this.dictionaryStart = this.out.length;
      this.needDictionary = false;
      if (control === 1) this.needProperties = true;
    } else if (this.needDictionary) {
      throw this.out.fail("first LZMA2 chunk does not reset the dictionary", offset);
    }
  }

  /**
   * Copies an uncompressed chunk.
   *
   * @param control - 1 or 2.
   * @param offset - Offset of the control byte.
   * @returns {number} Offset after the chunk.
   */
  private stored(control: number, offset: number): number {
    const { data, out } = this;
    if (control > 2) throw out.fail(`LZMA2 control byte ${control}`, offset);
    if (offset + 3 > this.end) throw out.fail("unexpected end of data");
    const size = ((data[offset + 1]! << 8) | data[offset + 2]!) + 1;
    if (offset + 3 + size > this.end) throw out.fail("unexpected end of data");
    out.append(data.subarray(offset + 3, offset + 3 + size));
    this.needState = true;
    return offset + 3 + size;
  }

  /**
   * Applies the reset a compressed chunk asks for: properties, state, or none.
   *
   * @param control - The control byte.
   * @param offset - Offset after the chunk header without properties.
   * @returns {number} Offset of the range coded data.
   */
  private resetModel(control: number, offset: number): number {
    const { out } = this;
    if (control >= 0xc0) {
      const properties = readProperties(this.data[offset] ?? 0xff);
      if (!properties || properties.lc + properties.lp > 4)
        throw out.fail("LZMA2 properties out of range", offset);
      this.model.reset(properties);
      this.needProperties = false;
      this.needState = false;
      return offset + 1;
    }
    if (this.needProperties)
      throw out.fail("LZMA2 chunk without the properties it needs", offset - 5);
    if (control >= 0xa0) this.model.reset();
    else if (this.needState)
      throw out.fail("LZMA2 chunk without the state reset it needs", offset - 5);
    this.needState = false;
    return offset;
  }

  /**
   * Decodes a compressed chunk.
   *
   * @param control - 0x80 to 0xff.
   * @param offset - Offset of the control byte.
   * @returns {number} Offset after the chunk.
   */
  private compressed(control: number, offset: number): number {
    const { data, out } = this;
    if (offset + 5 > this.end) throw out.fail("unexpected end of data");
    const size = (control & 0x1f) * 0x10000 + ((data[offset + 1]! << 8) | data[offset + 2]!) + 1;
    const packed = ((data[offset + 3]! << 8) | data[offset + 4]!) + 1;
    const start = this.resetModel(control, offset + 5);
    if (start + packed > this.end) {
      // Cut short: decode what is there, so the error carries everything before the cut.
      decodeLzma(this.model, data, start, this.end, out, size, this.dictionaryStart, false);
      throw out.fail("unexpected end of data");
    }
    const run = decodeLzma(
      this.model,
      data,
      start,
      start + packed,
      out,
      size,
      this.dictionaryStart,
      false,
    );
    if (run.end !== start + packed)
      throw out.fail("LZMA2 chunk size does not match its data", start);
    return start + packed;
  }
}

/**
 * Decodes LZMA2 chunks from `start` until the end chunk.
 *
 * @param data - The input.
 * @param start - First chunk.
 * @param end - Offset after the block's compressed data.
 * @param out - Receives the bytes.
 * @returns {number} Offset after the end chunk.
 */
export function decodeLzma2(data: Uint8Array, start: number, end: number, out: Output): number {
  return new Lzma2Reader(data, end, out).run(start);
}

/**
 * Writes the header of a compressed chunk.
 *
 * @param reset - What it resets: 3 dictionary, 2 properties, 1 state, 0 nothing.
 * @param size - Uncompressed bytes.
 * @param packed - Compressed bytes.
 * @returns {Uint8Array} The header, with the properties byte when it resets them.
 */
function chunkHeader(reset: number, size: number, packed: number): Uint8Array {
  const header = [
    0x80 | (reset << 5) | ((size - 1) >>> 16),
    ((size - 1) >>> 8) & 0xff,
    (size - 1) & 0xff,
    (packed - 1) >>> 8,
    (packed - 1) & 0xff,
  ];
  return new Uint8Array(reset >= 2 ? [...header, 0x5d] : header);
}

/**
 * Writes LZMA2 chunks: up to 2 MiB of input each, cut where the compressed side nears 64 KiB, and
 * uncompressed chunks where LZMA does not shrink the data.
 *
 * @param input - The bytes.
 * @param encoder - The encoder over the input, its dictionary and search set.
 * @returns {Uint8Array} The chunks and the end byte.
 */
export function encodeLzma2(input: Uint8Array, encoder: LzmaEncoder): Uint8Array {
  const parts: Uint8Array[] = [];
  /** What the next LZMA chunk must reset: 3 dictionary, 2 properties, 1 state, 0 nothing. */
  let reset = 3;
  let from = 0;
  while (from < input.length) {
    if (reset >= 1) encoder.model.reset();
    const rc = new RangeEncoder(1 << 16);
    const to = encoder.encode(
      rc,
      from,
      Math.min(from + CHUNK_UNPACKED, input.length),
      0,
      CHUNK_BUDGET,
    );
    const packed = rc.finish();
    if (packed.length < to - from) {
      parts.push(chunkHeader(reset, to - from, packed.length), packed);
      reset = 0;
    } else {
      parts.push(...storedChunks(input.subarray(from, to), from === 0));
      reset = from === 0 ? 2 : Math.max(reset, 1);
    }
    from = to;
  }
  parts.push(new Uint8Array([0]));
  return concat(parts);
}

/**
 * Writes bytes as uncompressed chunks of at most 64 KiB.
 *
 * @param bytes - The bytes.
 * @param first - Whether they open the stream, so the first chunk resets the dictionary.
 * @returns {Uint8Array[]} Headers and data in turn.
 */
function storedChunks(bytes: Uint8Array, first: boolean): Uint8Array[] {
  const parts: Uint8Array[] = [];
  for (let start = 0; start < bytes.length; start += CHUNK_STORED) {
    const piece = bytes.subarray(start, start + CHUNK_STORED);
    const control = first && start === 0 ? 1 : 2;
    parts.push(
      new Uint8Array([control, (piece.length - 1) >>> 8, (piece.length - 1) & 0xff]),
      piece,
    );
  }
  return parts;
}
