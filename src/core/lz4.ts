/**
 * LZ4 in its two containers: `frame`, the LZ4 Frame Format 1.6.4 with XXH32 checks, and
 * `legacy`, the frames `lz4 -l` writes. Blocks follow the LZ4 Block Format description.
 */
import { xxhash } from "@agntn/hashes/xxhash";
import { concat, type Output } from "./bytes.ts";
import { defineCompression } from "./define.ts";
import { ChecksumError, UnsupportedError } from "./errors.ts";
import type { Compression, CompressOptions, Details } from "./types.ts";

/** The containers LZ4 comes in, default first. */
export const LZ4_CONTAINERS = ["frame", "legacy"] as const;

/** An LZ4 container. */
export type Lz4Container = (typeof LZ4_CONTAINERS)[number];

const FRAME_MAGIC = 0x184d2204;
const LEGACY_MAGIC = 0x184c2102;
const LEGACY_BLOCK = 8 << 20;
const MIN_MATCH = 4;
/** Block sizes by the BD byte's size id 4 to 7. */
const BLOCK_SIZES: Readonly<Record<number, number>> = {
  4: 1 << 16,
  5: 1 << 18,
  6: 1 << 20,
  7: 1 << 22,
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
 * XXH32 with seed 0 as an unsigned integer.
 *
 * @param bytes - The bytes.
 * @returns {number} The hash.
 */
function xxh32(bytes: Uint8Array): number {
  const digest = xxhash(bytes, 32);
  return ((digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!) >>> 0;
}

/**
 * Reads a length from its token nibble and, at 15, the bytes that extend it: each adds up to 255,
 * and 255 means another follows.
 *
 * @param nibble - The nibble from the token.
 * @param data - The input.
 * @param pos - Where extension bytes would start.
 * @param end - End of the block.
 * @param out - The output, for errors.
 * @returns {[number, number]} The length and the position after it.
 */
function readLength(
  nibble: number,
  data: Uint8Array,
  pos: number,
  end: number,
  out: Output,
): [number, number] {
  if (nibble !== 15) return [nibble, pos];
  let total = 15;
  let byte = 255;
  while (byte === 255) {
    if (pos >= end) throw out.fail("unexpected end of block");
    byte = data[pos++]!;
    total += byte;
  }
  return [total, pos];
}

/**
 * Decodes one LZ4 block into `out`.
 *
 * @param data - The input.
 * @param start - First byte of the block.
 * @param end - Offset after its last byte.
 * @param out - Receives the bytes.
 * @param floor - Output offset before which no match may reach.
 */
function decodeBlock(
  data: Uint8Array,
  start: number,
  end: number,
  out: Output,
  floor: number,
): void {
  let pos = start;
  while (pos < end) {
    const token = data[pos++]!;
    let literals: number;
    [literals, pos] = readLength(token >>> 4, data, pos, end, out);
    if (pos + literals > end) throw out.fail("literals run past the block", pos);
    out.append(data.subarray(pos, pos + literals));
    pos += literals;
    if (pos === end) return;
    if (pos + 2 > end) throw out.fail("unexpected end of block");
    const offset = data[pos]! | (data[pos + 1]! << 8);
    if (offset === 0 || offset > out.length - floor)
      throw out.fail(`match offset ${offset} reaches before the start`, pos);
    pos += 2;
    let length: number;
    [length, pos] = readLength(token & 15, data, pos, end, out);
    out.copy(offset, length + MIN_MATCH);
  }
  throw out.fail("block ends without its last literals", end);
}

/** Writes an LZ4 block: sequences of a token, literals, an offset and length bytes. */
class BlockWriter {
  readonly bytes: Uint8Array;
  length = 0;

  /**
   * @param size - Bytes the block will compress.
   */
  constructor(size: number) {
    this.bytes = new Uint8Array(size + Math.ceil(size / 255) + 16);
  }

  /**
   * Writes the bytes that extend a length past 15.
   *
   * @param value - What is left after 15.
   */
  private extend(value: number): void {
    for (; value >= 255; value -= 255) this.bytes[this.length++] = 255;
    this.bytes[this.length++] = value;
  }

  /**
   * Writes one sequence, or the last literals when `offset` is 0.
   *
   * @param literals - The literal bytes.
   * @param offset - Match offset, or 0 for none.
   * @param match - Match length, 4 or more.
   */
  sequence(literals: Uint8Array, offset: number, match: number): void {
    const extra = match - MIN_MATCH;
    const token = (Math.min(literals.length, 15) << 4) | (offset ? Math.min(extra, 15) : 0);
    this.bytes[this.length++] = token;
    if (literals.length >= 15) this.extend(literals.length - 15);
    this.bytes.set(literals, this.length);
    this.length += literals.length;
    if (!offset) return;
    this.bytes[this.length++] = offset & 0xff;
    this.bytes[this.length++] = offset >>> 8;
    if (extra >= 15) this.extend(extra - 15);
  }
}

/**
 * Compresses one block: greedy matches through a hash of four bytes, the last five bytes as
 * literals and no match starting in the last twelve, as the block format requires.
 *
 * @param input - All the input.
 * @param start - First byte of the block.
 * @param end - Offset after its last byte.
 * @returns {Uint8Array} The block.
 */
function encodeBlock(input: Uint8Array, start: number, end: number): Uint8Array {
  const table = new Int32Array(1 << 16).fill(-1);
  const writer = new BlockWriter(end - start);
  const word = (pos: number): number =>
    input[pos]! | (input[pos + 1]! << 8) | (input[pos + 2]! << 16) | (input[pos + 3]! << 24);
  let anchor = start;
  for (let pos = start; pos < end - 12;) {
    const h = Math.imul(word(pos), 2654435761) >>> 16;
    const candidate = table[h]!;
    table[h] = pos;
    if (candidate < start || pos - candidate > 65535 || word(candidate) !== word(pos)) {
      pos++;
      continue;
    }
    let length = MIN_MATCH;
    while (pos + length < end - 5 && input[candidate + length] === input[pos + length]) length++;
    writer.sequence(input.subarray(anchor, pos), pos - candidate, length);
    pos += length;
    anchor = pos;
  }
  writer.sequence(input.subarray(anchor, end), 0, 0);
  return writer.bytes.slice(0, writer.length);
}

/** What a frame descriptor says. */
interface FrameHeader {
  independent: boolean;
  blockChecksum: boolean;
  contentChecksum: boolean;
  blockSize: number;
  contentSize: number;
  /** Offset of the first block. */
  end: number;
}

/**
 * Refuses a frame version, reserved bits or a dictionary this reader does not take.
 *
 * @param flags - The FLG byte.
 * @param descriptor - The BD byte.
 * @param start - Offset of FLG, for errors.
 * @param out - The output, for errors.
 */
function checkFlags(flags: number, descriptor: number, start: number, out: Output): void {
  if (flags >>> 6 !== 1)
    throw new UnsupportedError("lz4", `frame version ${flags >>> 6}`, { offset: start });
  if (flags & 2 || descriptor & 0x8f) throw out.fail("reserved frame bits are set", start);
  if (flags & 1)
    throw new UnsupportedError("lz4", "frame needs a dictionary", {
      offset: start,
      partial: out.take(),
    });
}

/**
 * Reads and checks a frame descriptor.
 *
 * @param data - The input.
 * @param start - Offset of the FLG byte.
 * @param out - The output, for errors.
 * @returns {FrameHeader} What it says.
 */
function readHeader(data: Uint8Array, start: number, out: Output): FrameHeader {
  if (start + 3 > data.length) throw out.fail("unexpected end of data");
  const flags = data[start]!;
  const descriptor = data[start + 1]!;
  checkFlags(flags, descriptor, start, out);
  const blockSize = BLOCK_SIZES[(descriptor >>> 4) & 7];
  if (!blockSize) throw out.fail(`block size id ${(descriptor >>> 4) & 7}`, start + 1);
  const sized = (flags & 8) !== 0;
  const end = start + 2 + (sized ? 8 : 0);
  if (end >= data.length) throw out.fail("unexpected end of data");
  if (data[end] !== ((xxh32(data.subarray(start, end)) >>> 8) & 0xff)) {
    throw new ChecksumError("lz4", "frame descriptor checksum does not match", {
      offset: end,
      partial: out.take(),
    });
  }
  return {
    independent: (flags & 0x20) !== 0,
    blockChecksum: (flags & 0x10) !== 0,
    contentChecksum: (flags & 4) !== 0,
    blockSize,
    contentSize: sized ? u32le(data, start + 2) + u32le(data, start + 6) * 0x100000000 : -1,
    end: end + 1,
  };
}

/**
 * Checks a stored XXH32 against bytes.
 *
 * @param data - The input.
 * @param at - Offset of the stored checksum.
 * @param bytes - What it covers.
 * @param what - Which checksum, for the error.
 * @param out - The output, for errors.
 */
function checkXxh32(
  data: Uint8Array,
  at: number,
  bytes: Uint8Array,
  what: string,
  out: Output,
): void {
  if (at + 4 > data.length) throw out.fail("unexpected end of data");
  if (u32le(data, at) !== xxh32(bytes)) {
    throw new ChecksumError("lz4", `${what} does not match`, { offset: at, partial: out.take() });
  }
}

/**
 * Reads one block of a frame after its size word, and its checksum when the frame has them.
 *
 * @param data - The input.
 * @param offset - Offset of the block data.
 * @param word - The size word: size, and the top bit for an uncompressed block.
 * @param header - The frame descriptor.
 * @param out - Receives the bytes.
 * @param floor - Output offset no match may reach before.
 * @returns {number} Offset after the block.
 */
function readBlock(
  data: Uint8Array,
  offset: number,
  word: number,
  header: Readonly<FrameHeader>,
  out: Output,
  floor: number,
): number {
  const size = word & 0x7fffffff;
  if (size > header.blockSize) throw out.fail("block is bigger than the frame allows", offset - 4);
  if (offset + size > data.length) throw out.fail("unexpected end of data");
  const blockStart = out.length;
  if (word & 0x80000000) out.append(data.subarray(offset, offset + size));
  else decodeBlock(data, offset, offset + size, out, header.independent ? blockStart : floor);
  if (out.length - blockStart > header.blockSize)
    throw out.fail("block decodes past the frame's block size", offset);
  if (!header.blockChecksum) return offset + size;
  checkXxh32(data, offset + size, data.subarray(offset, offset + size), "block checksum", out);
  return offset + size + 4;
}

/**
 * Reads the blocks of a frame up to its end mark.
 *
 * @param data - The input.
 * @param header - The frame descriptor.
 * @param out - Receives the bytes.
 * @returns {number} Offset after the end mark.
 */
function readBlocks(data: Uint8Array, header: Readonly<FrameHeader>, out: Output): number {
  const from = out.length;
  let offset = header.end;
  for (;;) {
    if (offset + 4 > data.length) throw out.fail("unexpected end of data");
    const word = u32le(data, offset);
    if (word === 0) return offset + 4;
    offset = readBlock(data, offset + 4, word, header, out, from);
  }
}

/**
 * Reads an LZ4 frame from `start`, after its magic.
 *
 * @param data - The input.
 * @param start - Offset of the frame descriptor.
 * @param out - Receives the bytes.
 * @param details - Collects the first frame's flags and the frame count.
 * @returns {number} Offset after the frame.
 */
function readFrame(data: Uint8Array, start: number, out: Output, details: Details): number {
  const header = readHeader(data, start, out);
  const from = out.length;
  let offset = readBlocks(data, header, out);
  const content = out.bytes.subarray(from, out.length);
  if (header.contentSize >= 0 && content.length !== header.contentSize) {
    throw new ChecksumError("lz4", "content size does not match", { offset, partial: out.take() });
  }
  if (header.contentChecksum) {
    checkXxh32(data, offset, content, "content checksum", out);
    offset += 4;
  }
  const frames = (details["frames"] as number | undefined) ?? 0;
  if (frames === 0) {
    details["blockSize"] = header.blockSize;
    details["independent"] = header.independent;
    details["checksum"] = header.contentChecksum;
  }
  details["frames"] = frames + 1;
  return offset;
}

/**
 * Reads LZ4 frames and skippable frames in a row, as `lz4 -d` does.
 *
 * @param data - The input.
 * @param out - Receives the bytes.
 * @returns {Details} The first frame's flags, counts and trailing bytes.
 */
function decodeFrames(data: Uint8Array, out: Output): Details {
  const details: Details = {};
  let offset = 0;
  while (offset + 4 <= data.length) {
    const magic = u32le(data, offset);
    if (magic === FRAME_MAGIC) {
      offset = readFrame(data, offset + 4, out, details);
    } else if ((magic & 0xfffffff0) === 0x184d2a50) {
      if (offset + 8 > data.length) throw out.fail("unexpected end of data");
      offset += 8 + u32le(data, offset + 4);
      details["skipped"] = ((details["skipped"] as number | undefined) ?? 0) + 1;
    } else if (offset === 0) {
      throw out.fail("not an LZ4 frame", 0);
    } else {
      break;
    }
  }
  if (details["frames"] === undefined) throw out.fail("no LZ4 frame", offset);
  if (offset < data.length) details["trailing"] = data.length - Math.min(offset, data.length);
  return details;
}

/**
 * Whether a word after a legacy block starts something else: a new frame, or no block at all.
 *
 * @param word - The next four bytes, little-endian.
 * @returns {boolean} Whether the legacy frame ends there.
 */
function endsLegacy(word: number): boolean {
  return (
    word === FRAME_MAGIC ||
    (word & 0xfffffff0) === 0x184d2a50 ||
    word > LEGACY_BLOCK + LEGACY_BLOCK / 255 + 16
  );
}

/**
 * Reads a legacy frame: blocks of up to 8 MiB, each after its compressed size.
 *
 * @param data - The input.
 * @param out - Receives the bytes.
 * @returns {Details} Block count and trailing bytes.
 */
function decodeLegacy(data: Uint8Array, out: Output): Details {
  if (data.length < 4 || u32le(data, 0) !== LEGACY_MAGIC)
    throw out.fail("not a legacy LZ4 frame", 0);
  let offset = 4;
  let blocks = 0;
  while (offset + 4 <= data.length) {
    const size = u32le(data, offset);
    if (size === LEGACY_MAGIC) {
      offset += 4;
      continue;
    }
    if (endsLegacy(size)) break;
    offset += 4;
    if (offset + size > data.length) throw out.fail("unexpected end of data");
    decodeBlock(data, offset, offset + size, out, out.length);
    offset += size;
    blocks++;
  }
  const details: Details = { blocks };
  if (offset < data.length) details["trailing"] = data.length - offset;
  return details;
}

/**
 * Writes one LZ4 frame with independent 4 MiB blocks.
 *
 * @param input - The bytes.
 * @param options - Checked options.
 * @returns {Uint8Array} The frame.
 */
function encodeFrame(input: Uint8Array, options: CompressOptions): Uint8Array {
  const checksum = (options["checksum"] as boolean | undefined) ?? true;
  const blockSize = BLOCK_SIZES[7]!;
  const flags = 0x40 | 0x20 | (checksum ? 4 : 0);
  const descriptor = 7 << 4;
  const header = new Uint8Array([flags, descriptor]);
  const parts: Uint8Array[] = [
    new Uint8Array([...le32(FRAME_MAGIC), flags, descriptor, (xxh32(header) >>> 8) & 0xff]),
  ];
  for (let start = 0; start < input.length; start += blockSize) {
    const end = Math.min(start + blockSize, input.length);
    const block = encodeBlock(input, start, end);
    if (block.length >= end - start) {
      parts.push(new Uint8Array(le32((end - start) | 0x80000000)), input.subarray(start, end));
    } else {
      parts.push(new Uint8Array(le32(block.length)), block);
    }
  }
  parts.push(new Uint8Array(4));
  if (checksum) parts.push(new Uint8Array(le32(xxh32(input))));
  return concat(parts);
}

/**
 * Writes a legacy frame with blocks of 8 MiB.
 *
 * @param input - The bytes.
 * @returns {Uint8Array} The frame.
 */
function encodeLegacy(input: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array(le32(LEGACY_MAGIC))];
  for (let start = 0; start < input.length; start += LEGACY_BLOCK) {
    const block = encodeBlock(input, start, Math.min(start + LEGACY_BLOCK, input.length));
    parts.push(new Uint8Array(le32(block.length)), block);
  }
  return concat(parts);
}

export const lz4: Compression = defineCompression({
  info: {
    name: "lz4",
    label: "LZ4",
    description: "Byte-aligned LZ77 without entropy coding: fast to write and very fast to read",
    standard: "LZ4 Block Format (Yann Collet)",
    containers: [
      {
        name: "frame",
        label: "LZ4 frame",
        standard: "LZ4 Frame Format 1.6.4",
        extensions: [".lz4"],
        magic: "04224d18",
        checksum: "XXH32",
      },
      {
        name: "legacy",
        label: "LZ4 legacy frame",
        standard: "LZ4 Frame Format 1.6.4, legacy frame",
        extensions: [".lz4"],
        magic: "02214c18",
      },
    ],
    compress: true,
    options: [
      {
        name: "container",
        type: "string",
        default: "frame",
        choices: [...LZ4_CONTAINERS],
        decode: true,
        description: "frame as lz4 writes it, or legacy as lz4 -l does",
      },
      {
        name: "checksum",
        type: "boolean",
        default: true,
        containers: ["frame"],
        description: "XXH32 of the content after the last block",
      },
    ],
  },
  compress: (bytes, options) =>
    options.container === "legacy" ? encodeLegacy(bytes) : encodeFrame(bytes, options),
  decompress: (data, out, container) =>
    container === "legacy" ? decodeLegacy(data, out) : decodeFrames(data, out),
});
