/**
 * The .xz container, after The .xz File Format 1.2.1: streams of blocks, each with filters, LZMA2
 * data and a check, then an index and a footer.
 */
import { crc32, crc64 } from "@agntn/hashes/crc";
import { sha256 } from "@agntn/hashes/sha2";
import { concat, equalBytes, type Output } from "./bytes.ts";
import { ChecksumError, UnsupportedError } from "./errors.ts";
import type { LzmaEncoder } from "./lzma-encoder.ts";
import { decodeLzma2, encodeLzma2, lzma2DictionaryByte } from "./lzma2.ts";
import type { Details } from "./types.ts";

/** The checks an xz block can carry, by the names `xz --check` takes. */
export const XZ_CHECKS = ["none", "crc32", "crc64", "sha256"] as const;

/** An xz check. */
export type XzCheck = (typeof XZ_CHECKS)[number];

const MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] as const;
const CHECK_IDS: Readonly<Record<XzCheck, number>> = { none: 0, crc32: 1, crc64: 4, sha256: 10 };
/** Bytes of the check for each of the sixteen check ids. */
const CHECK_SIZES = [0, 4, 4, 4, 8, 8, 8, 16, 16, 16, 32, 32, 32, 64, 64, 64] as const;
const LZMA2 = 0x21;
const DELTA = 3;
const X86 = 4;
/** Filter names by id, for errors about the ones this package does not undo. */
const FILTER_NAMES: Readonly<Record<number, string>> = {
  5: "PowerPC",
  6: "IA-64",
  7: "ARM",
  8: "ARM-Thumb",
  9: "SPARC",
  10: "ARM64",
  11: "RISC-V",
};

/**
 * Reads a 32-bit little-endian integer.
 *
 * @param data - The bytes.
 * @param offset - Where it starts.
 * @returns {number} The unsigned value.
 */
function u32le(data: Uint8Array, offset: number): number {
  return (
    (data[offset]! |
      (data[offset + 1]! << 8) |
      (data[offset + 2]! << 16) |
      (data[offset + 3]! << 24)) >>>
    0
  );
}

/**
 * Writes a 32-bit little-endian integer.
 *
 * @param value - The unsigned value.
 * @returns {number[]} Four bytes.
 */
function le32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24];
}

/**
 * The CRC-32 of bytes as an unsigned integer, as xz stores it little-endian.
 *
 * @param bytes - The bytes.
 * @returns {number} The CRC.
 */
function crcOf(bytes: Uint8Array): number {
  const digest = crc32(bytes);
  return ((digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!) >>> 0;
}

/**
 * Checks a stored CRC-32 of a stream structure.
 *
 * @param data - The input.
 * @param at - Offset of the stored CRC.
 * @param covered - What it covers.
 * @param what - Which structure, for the error.
 * @param out - The output, for errors.
 */
function checkCrc(
  data: Uint8Array,
  at: number,
  covered: Uint8Array,
  what: string,
  out: Output,
): void {
  if (at + 4 > data.length) throw out.fail("unexpected end of data");
  if (u32le(data, at) !== crcOf(covered)) {
    throw new ChecksumError("lzma", `xz ${what} CRC-32 does not match`, {
      offset: at,
      partial: out.take(),
    });
  }
}

/**
 * Reads a variable-length integer as xz writes them, seven bits per byte, lowest first.
 *
 * @param data - The input.
 * @param offset - Where it starts.
 * @param end - Offset it may not reach.
 * @param out - The output, for errors.
 * @returns {[number, number]} The value and the offset after it.
 */
function vli(data: Uint8Array, offset: number, end: number, out: Output): [number, number] {
  let value = 0;
  for (let i = 0; i < 9 && offset + i < end; i++) {
    const byte = data[offset + i]!;
    value += (byte & 0x7f) * 2 ** (7 * i);
    if (byte & 0x80) continue;
    if (i > 0 && byte === 0) throw out.fail("integer with a needless zero byte", offset + i);
    return [value, offset + i + 1];
  }
  throw out.fail("integer runs past its field", offset);
}

/**
 * Writes a variable-length integer.
 *
 * @param value - Non-negative integer.
 * @returns {number[]} Its bytes.
 */
function vliBytes(value: number): number[] {
  const bytes: number[] = [];
  for (; value >= 0x80; value = Math.floor(value / 0x80)) bytes.push((value % 0x80) | 0x80);
  bytes.push(value);
  return bytes;
}

/**
 * Undoes the delta filter in place.
 *
 * @param bytes - The block's output.
 * @param distance - Delta distance, 1 to 256.
 */
function undoDelta(bytes: Uint8Array, distance: number): void {
  for (let i = distance; i < bytes.length; i++)
    bytes[i] = (bytes[i]! + bytes[i - distance]!) & 0xff;
}

/** Which byte of the target to test next, by the mask of recent opcodes, as xz 5.8 has it. */
const X86_BIT_NUMBER = [0, 1, 2, 2, 3] as const;

/**
 * Whether a byte is 0x00 or 0xff, the top byte of a near call or jump target.
 *
 * @param byte - The byte.
 * @returns {boolean} Whether it is.
 */
function test86(byte: number): boolean {
  return byte === 0 || byte === 0xff;
}

/**
 * Turns the absolute target of one x86 call or jump back into the relative one it was.
 *
 * @param bytes - The block's output.
 * @param i - Offset of the E8 or E9 opcode.
 * @param position - Its position in the stream.
 * @param mask - The filter's mask of recent opcodes.
 */
function convertX86(bytes: Uint8Array, i: number, position: number, mask: number): void {
  let source =
    (bytes[i + 1]! | (bytes[i + 2]! << 8) | (bytes[i + 3]! << 16) | (bytes[i + 4]! << 24)) >>> 0;
  let destination = (source - (position + 5)) >>> 0;
  while (mask !== 0) {
    const shift = 24 - X86_BIT_NUMBER[mask >>> 1]! * 8;
    if (!test86((destination >>> shift) & 0xff)) break;
    source = (destination ^ (2 ** (shift + 8) - 1)) >>> 0;
    destination = (source - (position + 5)) >>> 0;
  }
  const top = destination & 0x01000000 ? 0xff : 0;
  bytes[i + 1] = destination & 0xff;
  bytes[i + 2] = (destination >>> 8) & 0xff;
  bytes[i + 3] = (destination >>> 16) & 0xff;
  bytes[i + 4] = top;
}

/**
 * Ages the mask of recent opcodes by the bytes since the last one.
 *
 * @param mask - The mask.
 * @param gap - Bytes since the last E8 or E9.
 * @returns {number} The new mask.
 */
function ageMask(mask: number, gap: number): number {
  if (gap > 5) return 0;
  for (let i = 0; i < gap; i++) mask = (mask & 0x77) << 1;
  return mask;
}

/**
 * Undoes the x86 branch filter in place, as xz's `simple/x86.c` decodes it.
 *
 * @param bytes - The block's output.
 * @param start - The filter's start offset, usually 0.
 */
function undoX86(bytes: Uint8Array, start: number): void {
  let mask = 0;
  let previous = -5;
  for (let i = 0; i + 5 <= bytes.length; i++) {
    if (bytes[i] !== 0xe8 && bytes[i] !== 0xe9) continue;
    mask = ageMask(mask, i - previous);
    previous = i;
    const top = bytes[i + 4]!;
    if (test86(top) && mask >>> 1 <= 4 && mask >>> 1 !== 3) {
      convertX86(bytes, i, start + i, mask);
      i += 4;
      mask = 0;
    } else {
      mask |= test86(top) ? 0x11 : 1;
    }
  }
}

/** A filter of an xz block before LZMA2. */
interface Filter {
  id: number;
  properties: Uint8Array;
}

/** What a block header says. */
interface BlockHeader {
  /** Offset of the compressed data. */
  dataStart: number;
  compressedSize: number;
  uncompressedSize: number;
  filters: ReadonlyArray<Readonly<Filter>>;
}

/**
 * The name of a filter for messages.
 *
 * @param id - Filter id.
 * @returns {string} Such as `ARM`, or the id in hex.
 */
function filterName(id: number): string {
  if (id === LZMA2) return "LZMA2";
  return FILTER_NAMES[id] ?? `0x${id.toString(16)}`;
}

/**
 * Refuses a filter this reader cannot undo, or one in the wrong place.
 *
 * @param id - Filter id.
 * @param last - Whether it is the last filter, which must be LZMA2.
 * @param offset - Where its entry starts, for errors.
 * @param out - The output, for errors.
 */
function checkFilter(id: number, last: boolean, offset: number, out: Output): void {
  const supported = last ? id === LZMA2 : id === DELTA || id === X86;
  if (supported) return;
  const where =
    last === (id === LZMA2) ? "" : last ? " as the last filter" : " before the last filter";
  throw new UnsupportedError("lzma", `xz ${filterName(id)} filter${where}`, {
    offset,
    partial: out.take(),
  });
}

/**
 * Reads one filter entry of a block header.
 *
 * @param data - The input.
 * @param offset - Where it starts.
 * @param end - End of the header fields.
 * @param last - Whether it must be LZMA2.
 * @param out - The output, for errors.
 * @returns {[Filter, number]} The filter and the offset after it.
 */
function readFilter(
  data: Uint8Array,
  offset: number,
  end: number,
  last: boolean,
  out: Output,
): [Filter, number] {
  const [id, at] = vli(data, offset, end, out);
  const [length, from] = vli(data, at, end, out);
  if (from + length > end) throw out.fail("filter properties run past the header", from);
  checkFilter(id, last, offset, out);
  const properties = data.subarray(from, from + length);
  if (last && (length !== 1 || properties[0]! > 40))
    throw out.fail("LZMA2 filter properties out of range", from);
  return [{ id, properties }, from + length];
}

/**
 * Reads and checks a block header.
 *
 * @param data - The input.
 * @param start - Offset of its size byte.
 * @param out - The output, for errors.
 * @returns {BlockHeader} What it says.
 */
function readBlockHeader(data: Uint8Array, start: number, out: Output): BlockHeader {
  const size = (data[start]! + 1) * 4;
  const end = start + size - 4;
  if (start + size > data.length) throw out.fail("unexpected end of data");
  checkCrc(data, end, data.subarray(start, end), "block header", out);
  const flags = data[start + 1]!;
  if (flags & 0x3c)
    throw new UnsupportedError("lzma", "reserved xz block flags are set", { offset: start + 1 });
  let offset = start + 2;
  let compressedSize = -1;
  let uncompressedSize = -1;
  if (flags & 0x40) [compressedSize, offset] = vli(data, offset, end, out);
  if (flags & 0x80) [uncompressedSize, offset] = vli(data, offset, end, out);
  const filters: Filter[] = [];
  for (let i = 0; i <= (flags & 3); i++) {
    let filter: Filter;
    [filter, offset] = readFilter(data, offset, end, i === (flags & 3), out);
    filters.push(filter);
  }
  if (data.subarray(offset, end).some(Boolean))
    throw out.fail("xz block header padding is not zero", offset);
  return {
    dataStart: start + size,
    compressedSize,
    uncompressedSize,
    filters: filters.slice(0, -1),
  };
}

/**
 * Undoes a block's filters, last applied first.
 *
 * @param block - The block's output, changed in place.
 * @param filters - The filters before LZMA2.
 * @param out - The output, for errors.
 */
function undoFilters(
  block: Uint8Array,
  filters: ReadonlyArray<Readonly<Filter>>,
  out: Output,
): void {
  for (const { id, properties } of filters.toReversed()) {
    if (id === DELTA && properties.length === 1) undoDelta(block, properties[0]! + 1);
    else if (id === X86 && (properties.length === 0 || properties.length === 4))
      undoX86(block, properties.length === 4 ? u32le(properties, 0) : 0);
    else throw out.fail(`filter 0x${id.toString(16)} properties out of range`);
  }
}

/**
 * The check of a block's output in the stream's check type, as the stream stores it.
 *
 * @param check - Check id.
 * @param block - The block's output.
 * @returns {Uint8Array | undefined} The check, or nothing for one this package does not compute.
 */
function blockCheck(check: number, block: Uint8Array): Uint8Array | undefined {
  if (check === CHECK_IDS.crc32) return crc32(block).toReversed();
  if (check === CHECK_IDS.crc64) return crc64(block).toReversed();
  if (check === CHECK_IDS.sha256) return sha256(block);
  return check === CHECK_IDS.none ? new Uint8Array(0) : undefined;
}

/**
 * Decodes a block's LZMA2 data and checks its sizes against the header.
 *
 * @param data - The input.
 * @param header - The block header.
 * @param out - Receives the bytes.
 * @returns {number} Offset after the compressed data.
 */
function readBlockData(data: Uint8Array, header: Readonly<BlockHeader>, out: Output): number {
  const from = out.length;
  const known = header.compressedSize >= 0;
  const limit = known ? header.dataStart + header.compressedSize : data.length;
  if (limit > data.length) throw out.fail("unexpected end of data");
  const end = decodeLzma2(data, header.dataStart, limit, out);
  if (known && end !== limit) throw out.fail("xz block compressed size does not match", end);
  if (header.uncompressedSize >= 0 && out.length - from !== header.uncompressedSize) {
    throw out.fail("xz block uncompressed size does not match", end);
  }
  return end;
}

/**
 * Checks the check after a block.
 *
 * @param data - The input.
 * @param at - Offset of the check.
 * @param check - The stream's check id.
 * @param block - The block's output.
 * @param out - The output, for errors.
 * @returns {number} Offset after the check.
 */
function checkBlock(
  data: Uint8Array,
  at: number,
  check: number,
  block: Uint8Array,
  out: Output,
): number {
  const size = CHECK_SIZES[check]!;
  if (at + size > data.length) throw out.fail("unexpected end of data");
  const expected = blockCheck(check, block);
  if (expected && !equalBytes(data.subarray(at, at + size), expected)) {
    throw new ChecksumError("lzma", "xz block check does not match", {
      offset: at,
      partial: out.take(),
    });
  }
  return at + size;
}

/**
 * Reads one block: header, LZMA2 data, padding and check.
 *
 * @param data - The input.
 * @param start - Offset of the block header.
 * @param out - Receives the bytes.
 * @param check - The stream's check id.
 * @returns {[number, number, number]} Offset after the block, its unpadded size and its output size.
 */
function readBlock(
  data: Uint8Array,
  start: number,
  out: Output,
  check: number,
): [number, number, number] {
  const header = readBlockHeader(data, start, out);
  const from = out.length;
  const dataEnd = readBlockData(data, header, out);
  const block = out.bytes.subarray(from, out.length);
  undoFilters(block, header.filters, out);
  const padded = dataEnd + ((4 - ((dataEnd - start) % 4)) % 4);
  if (data.subarray(dataEnd, padded).some(Boolean))
    throw out.fail("xz block padding is not zero", dataEnd);
  const end = checkBlock(data, padded, check, block, out);
  return [end, dataEnd - start + CHECK_SIZES[check]!, block.length];
}

/**
 * Reads the index after the blocks and checks it against them.
 *
 * @param data - The input.
 * @param start - Offset of its zero byte.
 * @param records - Unpadded and output size of each block.
 * @param out - The output, for errors.
 * @returns {number} Offset after the index.
 */
function readIndex(
  data: Uint8Array,
  start: number,
  records: ReadonlyArray<readonly [number, number]>,
  out: Output,
): number {
  let [count, offset] = vli(data, start + 1, data.length, out);
  if (count !== records.length) throw out.fail("xz index lists another number of blocks", offset);
  for (const [unpadded, size] of records) {
    let a: number;
    let b: number;
    [a, offset] = vli(data, offset, data.length, out);
    [b, offset] = vli(data, offset, data.length, out);
    if (a !== unpadded || b !== size) throw out.fail("xz index does not match the blocks", offset);
  }
  const padded = offset + ((4 - ((offset - start) % 4)) % 4);
  if (data.subarray(offset, padded).some(Boolean))
    throw out.fail("xz index padding is not zero", offset);
  checkCrc(data, padded, data.subarray(start, padded), "index", out);
  return padded + 4;
}

/**
 * Reads and checks a stream footer.
 *
 * @param data - The input.
 * @param offset - Offset of the footer.
 * @param indexSize - Bytes of the index, CRC included.
 * @param flags - The stream flags from the header.
 * @param out - The output, for errors.
 */
function readFooter(
  data: Uint8Array,
  offset: number,
  indexSize: number,
  flags: Uint8Array,
  out: Output,
): void {
  if (offset + 12 > data.length) throw out.fail("unexpected end of data");
  checkCrc(data, offset, data.subarray(offset + 4, offset + 10), "stream footer", out);
  if ((u32le(data, offset + 4) + 1) * 4 !== indexSize)
    throw out.fail("xz backward size does not match the index", offset + 4);
  if (!equalBytes(data.subarray(offset + 8, offset + 10), flags))
    throw out.fail("xz footer flags differ from the header", offset + 8);
  if (data[offset + 10] !== 0x59 || data[offset + 11] !== 0x5a)
    throw out.fail("xz footer magic is missing", offset + 10);
}

/**
 * Reads and checks a stream header.
 *
 * @param data - The input.
 * @param start - Offset of the stream.
 * @param out - The output, for errors.
 * @returns {Uint8Array} The two stream flag bytes.
 */
function readStreamHeader(data: Uint8Array, start: number, out: Output): Uint8Array {
  if (data.length - start < 24) throw out.fail("too short for an xz stream", start);
  if (!MAGIC.every((byte, i) => data[start + i] === byte))
    throw out.fail("not an xz stream", start);
  const flags = data.subarray(start + 6, start + 8);
  checkCrc(data, start + 8, flags, "stream header", out);
  if (flags[0] !== 0 || flags[1]! > 15)
    throw new UnsupportedError("lzma", "reserved xz stream flags are set", { offset: start + 6 });
  return flags;
}

/**
 * Reads one stream: header, blocks, index and footer.
 *
 * @param data - The input.
 * @param start - Offset of the stream.
 * @param out - Receives the bytes.
 * @param details - Collects the first stream's check and the block count.
 * @returns {number} Offset after the stream.
 */
function readStream(data: Uint8Array, start: number, out: Output, details: Details): number {
  const flags = readStreamHeader(data, start, out);
  const check = flags[1]!;
  details["check"] ??=
    Object.entries(CHECK_IDS).find(([, id]) => id === check)?.[0] ?? `id ${check}`;
  const records: Array<[number, number]> = [];
  let offset = start + 12;
  while (offset < data.length && data[offset] !== 0) {
    const [end, unpadded, size] = readBlock(data, offset, out, check);
    records.push([unpadded, size]);
    offset = end;
  }
  if (offset >= data.length) throw out.fail("unexpected end of data");
  const end = readIndex(data, offset, records, out);
  readFooter(data, end, end - offset, flags, out);
  details["blocks"] = Number(details["blocks"] ?? 0) + records.length;
  return end + 12;
}

/**
 * Finds the next stream after zero padding in groups of four, or nothing.
 *
 * @param data - The input.
 * @param offset - Offset after a stream.
 * @returns {number} Offset of the padding's end.
 */
function skipPadding(data: Uint8Array, offset: number): number {
  let next = offset;
  while (next < data.length && data[next] === 0) next++;
  return (next - offset) % 4 === 0 ? next : offset;
}

/**
 * Reads every xz stream in a row with the zero padding between them.
 *
 * @param data - The input.
 * @param out - Receives the bytes.
 * @returns {Details} The check, block and stream counts, trailing bytes.
 */
export function decodeXz(data: Uint8Array, out: Output): Details {
  const details: Details = {};
  let streams = 0;
  let offset = 0;
  do {
    offset = skipPadding(data, readStream(data, offset, out, details));
    streams++;
  } while (offset < data.length && MAGIC.every((byte, i) => data[offset + i] === byte));
  if (streams > 1) details["streams"] = streams;
  if (offset < data.length) details["trailing"] = data.length - offset;
  return details;
}

/**
 * Writes an xz stream with one block, or none for empty input.
 *
 * @param input - The bytes.
 * @param encoder - The LZMA encoder over the input.
 * @param dictionary - Its dictionary size, for the filter properties.
 * @param check - The block check.
 * @returns {Uint8Array} The stream.
 */
export function encodeXz(
  input: Uint8Array,
  encoder: LzmaEncoder,
  dictionary: number,
  check: XzCheck,
): Uint8Array {
  const id = CHECK_IDS[check];
  const flags = new Uint8Array([0, id]);
  const parts: Uint8Array[] = [new Uint8Array([...MAGIC, 0, id, ...le32(crcOf(flags))])];
  const records: number[] = [];
  if (input.length > 0) {
    const header = new Uint8Array([2, 0, LZMA2, 1, lzma2DictionaryByte(dictionary), 0, 0, 0]);
    const chunks = encodeLzma2(input, encoder);
    const padding = new Uint8Array((4 - (chunks.length % 4)) % 4);
    const digest = blockCheck(id, input)!;
    parts.push(header, new Uint8Array(le32(crcOf(header))), chunks, padding, digest);
    records.push(header.length + 4 + chunks.length + digest.length, input.length);
  }
  const index = [0, ...vliBytes(records.length / 2), ...records.flatMap(vliBytes)];
  while (index.length % 4 !== 0) index.push(0);
  const indexBytes = new Uint8Array(index);
  const backward = new Uint8Array([...le32((indexBytes.length + 4) / 4 - 1), 0, id]);
  parts.push(
    indexBytes,
    new Uint8Array(le32(crcOf(indexBytes))),
    new Uint8Array(le32(crcOf(backward))),
    backward,
    new Uint8Array([0x59, 0x5a]),
  );
  return concat(parts);
}
