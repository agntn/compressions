/**
 * deflate in its three containers: raw (RFC 1951), zlib (RFC 1950) with Adler-32, and gzip
 * (RFC 1952) with a header and CRC-32.
 */
import { adler32 } from "@agntn/hashes/adler32";
import { crc32 } from "@agntn/hashes/crc";
import { concat, type Output } from "./bytes.ts";
import { deflateRaw } from "./deflater.ts";
import { defineCompression } from "./define.ts";
import { ChecksumError, InvalidOptionError, UnsupportedError } from "./errors.ts";
import { inflateInto } from "./inflate.ts";
import type { Compression, CompressOptions, Details } from "./types.ts";

/** The containers deflate comes in, default first. */
export const DEFLATE_CONTAINERS = ["raw", "zlib", "gzip"] as const;

/** A deflate container. */
export type DeflateContainer = (typeof DEFLATE_CONTAINERS)[number];

/** gzip header flags, RFC 1952 section 2.3.1. */
const FTEXT = 1;
const FHCRC = 2;
const FEXTRA = 4;
const FNAME = 8;
const FCOMMENT = 16;

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
 * Reads a 32-bit big-endian integer.
 *
 * @param data - The bytes.
 * @param offset - Where it starts.
 * @returns {number} The unsigned value.
 */
function u32be(data: Uint8Array, offset: number): number {
  return (
    ((data[offset]! << 24) |
      (data[offset + 1]! << 16) |
      (data[offset + 2]! << 8) |
      data[offset + 3]!) >>>
    0
  );
}

/**
 * Reads a zero-terminated Latin-1 string, as gzip stores the name and the comment.
 *
 * @param data - The bytes.
 * @param start - Where it starts.
 * @param out - The output, for errors.
 * @returns {[string, number]} The text and the offset after its zero byte.
 */
function latin1(data: Uint8Array, start: number, out: Output): [string, number] {
  const end = data.indexOf(0, start);
  if (end === -1) throw out.fail("gzip header field has no terminating zero", start);
  let text = "";
  for (let i = start; i < end; i++) text += String.fromCodePoint(data[i]!);
  return [text, end + 1];
}

/**
 * Checks the fixed part of a gzip member header: magic, method and reserved flags.
 *
 * @param data - The input.
 * @param start - Offset of the member.
 * @param out - The output, for errors.
 */
function checkGzipStart(data: Uint8Array, start: number, out: Output): void {
  if (data.length - start < 18) throw out.fail("too short for a gzip member", start);
  if (data[start] !== 0x1f || data[start + 1] !== 0x8b) throw out.fail("not a gzip member", start);
  if (data[start + 2] !== 8) {
    throw new UnsupportedError(
      "deflate",
      `gzip compression method ${data[start + 2]} is not deflate`,
      {
        offset: start + 2,
        partial: out.take(),
      },
    );
  }
  if (data[start + 3]! & 0xe0) throw out.fail("reserved gzip flags are set", start + 3);
}

/**
 * Reads the optional fields of a gzip header: extra, name, comment and header CRC.
 *
 * @param data - The input.
 * @param start - Offset of the member.
 * @param out - The output, for errors.
 * @param fields - Collects what the header says.
 * @returns {number} Offset of the deflate data.
 */
function readGzipFields(data: Uint8Array, start: number, out: Output, fields: Details): number {
  const flags = data[start + 3]!;
  let offset = start + 10;
  if (flags & FEXTRA) {
    fields["extra"] = data[offset]! | (data[offset + 1]! << 8);
    offset += 2 + (fields["extra"] as number);
  }
  if (flags & FNAME) [fields["name"], offset] = latin1(data, offset, out);
  if (flags & FCOMMENT) [fields["comment"], offset] = latin1(data, offset, out);
  if (flags & FHCRC) {
    const stored = data[offset]! | (data[offset + 1]! << 8);
    if ((u32be(crc32(data.subarray(start, offset)), 0) & 0xffff) !== stored) {
      throw new ChecksumError("deflate", "gzip header CRC does not match", {
        offset,
        partial: out.take(),
      });
    }
    offset += 2;
  }
  if (offset > data.length) throw out.fail("unexpected end of data");
  const mtime = u32le(data, start + 4);
  if (mtime) fields["mtime"] = mtime;
  if (flags & FTEXT) fields["text"] = true;
  fields["os"] = data[start + 9]!;
  return offset;
}

/**
 * Checks a member's CRC-32 and size against what came out.
 *
 * @param data - The input.
 * @param end - Offset after the member's deflate data.
 * @param member - What the member decompressed to.
 * @param out - The output, for errors.
 */
function checkGzipTrailer(data: Uint8Array, end: number, member: Uint8Array, out: Output): void {
  if (end + 8 > data.length) throw out.fail("gzip member ends before its CRC-32 and size");
  if (u32le(data, end) !== u32be(crc32(member), 0)) {
    throw new ChecksumError("deflate", "gzip CRC-32 does not match", {
      offset: end,
      partial: out.take(),
    });
  }
  if (u32le(data, end + 4) !== member.length % 0x1_0000_0000) {
    throw new ChecksumError("deflate", "gzip size does not match", {
      offset: end + 4,
      partial: out.take(),
    });
  }
}

/**
 * Reads one gzip member from `start`: header, deflate data, CRC-32 and size.
 *
 * @param data - The input.
 * @param start - Offset of the member's first byte.
 * @param out - Receives the bytes.
 * @param details - Collects the header fields of the first member and the member count.
 * @returns {number} Offset after the member.
 */
function gunzipMember(data: Uint8Array, start: number, out: Output, details: Details): number {
  checkGzipStart(data, start, out);
  const fields: Details = {};
  const offset = readGzipFields(data, start, out, fields);
  const members = (details["members"] as number | undefined) ?? 0;
  if (members === 0) Object.assign(details, fields);
  const from = out.length;
  const end = inflateInto(data, offset, out);
  checkGzipTrailer(data, end, out.bytes.subarray(from, out.length), out);
  details["members"] = members + 1;
  return end + 8;
}

/**
 * Reads gzip: every member in a row, as gunzip does, and counts what follows as trailing bytes.
 *
 * @param data - The input.
 * @param out - Receives the bytes.
 * @returns {Details} Header fields of the first member and the counts.
 */
function gunzip(data: Uint8Array, out: Output): Details {
  const details: Details = {};
  let offset = gunzipMember(data, 0, out, details);
  while (offset + 1 < data.length && data[offset] === 0x1f && data[offset + 1] === 0x8b) {
    offset = gunzipMember(data, offset, out, details);
  }
  // gzip pads tapes with zeros after the last member; anything else is trailing data.
  let end = data.length;
  while (end > offset && data[end - 1] === 0) end--;
  if (end > offset) details["trailing"] = data.length - offset;
  return details;
}

/**
 * Reads zlib: the two header bytes, deflate data, then Adler-32.
 *
 * @param data - The input.
 * @param out - Receives the bytes.
 * @returns {Details} The level the header names and any trailing bytes.
 */
function unzlib(data: Uint8Array, out: Output): Details {
  if (data.length < 6) throw out.fail("too short for a zlib stream", 0);
  const cmf = data[0]!;
  const flg = data[1]!;
  if ((cmf & 15) !== 8) throw out.fail(`zlib compression method ${cmf & 15} is not deflate`, 0);
  if (cmf >>> 4 > 7) throw out.fail(`zlib window of 2^${(cmf >>> 4) + 8} bytes is too big`, 0);
  if (((cmf << 8) | flg) % 31 !== 0) throw out.fail("zlib header check bits are wrong", 1);
  if (flg & 0x20) {
    throw new UnsupportedError("deflate", "zlib stream needs a preset dictionary", { offset: 1 });
  }
  const end = inflateInto(data, 2, out);
  if (end + 4 > data.length) throw out.fail("zlib stream ends before its Adler-32");
  if (u32be(data, end) !== u32be(adler32(out.bytes.subarray(0, out.length)), 0)) {
    throw new ChecksumError("deflate", "zlib Adler-32 does not match", {
      offset: end,
      partial: out.take(),
    });
  }
  const details: Details = { level: ["fastest", "fast", "default", "best"][flg >>> 6]! };
  if (end + 4 < data.length) details["trailing"] = data.length - end - 4;
  return details;
}

/**
 * Writes the name of a gzip header: Latin-1, then a zero byte.
 *
 * @param name - The file name.
 * @returns {number[]} Its bytes.
 */
function gzipName(name: string): number[] {
  const bytes: number[] = [];
  for (const character of name) {
    const code = character.codePointAt(0)!;
    if (code === 0 || code > 0xff) {
      throw new InvalidOptionError(
        "name",
        name,
        "gzip stores the name in Latin-1, without zero bytes",
      );
    }
    bytes.push(code);
  }
  bytes.push(0);
  return bytes;
}

/**
 * Writes a gzip member around raw deflate data.
 *
 * @param bytes - The input.
 * @param options - Level, file name and modification time.
 * @returns {Uint8Array} The gzip member.
 */
function gzip(bytes: Uint8Array, options: CompressOptions): Uint8Array {
  const level = (options["level"] as number | undefined) ?? 6;
  const name = options["name"] as string | undefined;
  const mtime = (options["mtime"] as number | undefined) ?? 0;
  const extraFlags = level === 9 ? 2 : level === 1 ? 4 : 0;
  const header = [
    0x1f,
    0x8b,
    8,
    name ? FNAME : 0,
    mtime & 0xff,
    (mtime >>> 8) & 0xff,
    (mtime >>> 16) & 0xff,
    mtime >>> 24,
    extraFlags,
    255,
    ...(name ? gzipName(name) : []),
  ];
  const crc = crc32(bytes);
  const size = bytes.length % 0x1_0000_0000;
  const trailer = [
    crc[3]!,
    crc[2]!,
    crc[1]!,
    crc[0]!,
    size & 0xff,
    (size >>> 8) & 0xff,
    (size >>> 16) & 0xff,
    size >>> 24,
  ];
  return concat([new Uint8Array(header), deflateRaw(bytes, { level }), new Uint8Array(trailer)]);
}

/**
 * Writes a zlib stream around raw deflate data.
 *
 * @param bytes - The input.
 * @param level - 0 to 9.
 * @returns {Uint8Array} The zlib stream.
 */
function zlib(bytes: Uint8Array, level: number): Uint8Array {
  const flevel = level < 2 ? 0 : level < 6 ? 1 : level === 6 ? 2 : 3;
  const cmf = 0x78;
  let flg = flevel << 6;
  flg += 31 - ((cmf * 256 + flg) % 31);
  return concat([new Uint8Array([cmf, flg]), deflateRaw(bytes, { level }), adler32(bytes)]);
}

export const deflate: Compression = defineCompression({
  info: {
    name: "deflate",
    label: "deflate",
    description: "LZ77 with Huffman codes: gzip files, zlib streams, PNG, HTTP and ZIP entries",
    standard: "RFC 1951",
    containers: [
      { name: "raw", label: "raw deflate", standard: "RFC 1951", extensions: [] },
      {
        name: "zlib",
        label: "zlib",
        standard: "RFC 1950",
        extensions: [".zz", ".zlib"],
        checksum: "Adler-32",
      },
      {
        name: "gzip",
        label: "gzip",
        standard: "RFC 1952",
        extensions: [".gz", ".tgz"],
        magic: "1f8b08",
        checksum: "CRC-32",
      },
    ],
    compress: true,
    options: [
      {
        name: "container",
        type: "string",
        default: "raw",
        choices: [...DEFLATE_CONTAINERS],
        decode: true,
        description: "raw deflate, a zlib stream or a gzip file",
      },
      {
        name: "level",
        type: "number",
        default: 6,
        min: 0,
        max: 9,
        description: "0 stores, 1 is fastest, 9 is smallest",
      },
      {
        name: "name",
        type: "string",
        containers: ["gzip"],
        description: "File name in the gzip header",
      },
      {
        name: "mtime",
        type: "number",
        min: 0,
        max: 0xffffffff,
        default: 0,
        containers: ["gzip"],
        description: "Modification time in the gzip header, Unix seconds; 0 leaves it out",
      },
    ],
  },
  compress(bytes, options) {
    const level = (options["level"] as number | undefined) ?? 6;
    if (options.container === "gzip") return gzip(bytes, options);
    if (options.container === "zlib") return zlib(bytes, level);
    return deflateRaw(bytes, { level });
  },
  decompress(data, out, container) {
    if (container === "gzip") return gunzip(data, out);
    if (container === "zlib") return unzlib(data, out);
    const end = inflateInto(data, 0, out);
    return end < data.length ? { trailing: data.length - end } : {};
  },
});
