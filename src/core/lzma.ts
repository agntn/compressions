/**
 * LZMA in its two containers: `alone`, the .lzma files of LZMA Utils, and `xz`, the .xz format
 * with LZMA2 chunks, filters and a check per block (the xz file format 1.2.1 specification).
 */
import { concat, type Output } from "./bytes.ts";
import { defineCompression } from "./define.ts";
import { InvalidOptionError } from "./errors.ts";
import { LzmaModel, decodeLzma, readProperties } from "./lzma-decoder.ts";
import { LzmaEncoder, RangeEncoder } from "./lzma-encoder.ts";
import type { Compression, CompressOptions, Details } from "./types.ts";
import { XZ_CHECKS, decodeXz, encodeXz, type XzCheck } from "./xz.ts";

/** The containers LZMA comes in, default first. */
export const LZMA_CONTAINERS = ["alone", "xz"] as const;

/** An LZMA container. */
export type LzmaContainer = (typeof LZMA_CONTAINERS)[number];

export { XZ_CHECKS, type XzCheck } from "./xz.ts";
/** Dictionary size per level, as xz's presets set it. */
const DICTIONARY_SIZES = [18, 20, 21, 22, 22, 23, 23, 24, 25, 26].map((bits) => 2 ** bits);
/** Hash chain depth and nice length per level. */
const SEARCH = [
  [4, 16],
  [8, 32],
  [16, 48],
  [24, 64],
  [32, 64],
  [48, 96],
  [64, 128],
  [128, 192],
  [256, 273],
  [512, 273],
] as const;

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

// ---- alone ----

/**
 * Reads a .lzma file: properties, dictionary size, the size or -1, then the range coded data.
 *
 * @param data - The input.
 * @param out - Receives the bytes.
 * @returns {Details} Properties, dictionary size and trailing bytes.
 */
function decodeAlone(data: Uint8Array, out: Output): Details {
  if (data.length < 13) throw out.fail("too short for a .lzma header", 0);
  const properties = readProperties(data[0]!);
  if (!properties) throw out.fail("properties byte out of range", 0);
  const dictionary = u32le(data, 1);
  const low = u32le(data, 5);
  const high = u32le(data, 9);
  let size = -1;
  if (!(low === 0xffffffff && high === 0xffffffff)) {
    if (high > 0x1fffff) throw out.fail("stated size is past 2^53", 5);
    size = high * 0x100000000 + low;
  }
  const model = new LzmaModel();
  model.reset(properties);
  const run = decodeLzma(model, data, 13, data.length, out, size, 0, size < 0);
  const details: Details = {
    properties: `lc=${properties.lc} lp=${properties.lp} pb=${properties.pb}`,
    dictionary,
  };
  if (run.end < data.length) details["trailing"] = data.length - run.end;
  return details;
}

/**
 * Builds the encoder a level asks for.
 *
 * @param input - The bytes.
 * @param level - 0 to 9.
 * @returns {LzmaEncoder} The encoder.
 */
function encoderFor(input: Uint8Array, level: number): LzmaEncoder {
  const [chain, nice] = SEARCH[level]!;
  return new LzmaEncoder(input, DICTIONARY_SIZES[level]!, chain, nice);
}

/**
 * Writes a .lzma file with the size in its header and no end marker.
 *
 * @param input - The bytes.
 * @param level - 0 to 9.
 * @returns {Uint8Array} The file.
 */
function encodeAlone(input: Uint8Array, level: number): Uint8Array {
  const rc = new RangeEncoder(input.length / 2 + 64);
  encoderFor(input, level).encode(rc, 0, input.length, 0);
  const size = input.length;
  const header = [
    0x5d,
    ...le32(DICTIONARY_SIZES[level]!),
    ...le32(size % 0x100000000),
    ...le32(Math.floor(size / 0x100000000)),
  ];
  return concat([new Uint8Array(header), rc.finish()]);
}

/**
 * Reads the level option.
 *
 * @param options - Checked options.
 * @returns {number} 0 to 9.
 */
function levelOf(options: CompressOptions): number {
  return (options["level"] as number | undefined) ?? 6;
}

export const lzma: Compression = defineCompression({
  info: {
    name: "lzma",
    label: "LZMA",
    description: "LZ77 with a range coder over adaptive bit models: xz files and the older .lzma",
    standard: "LZMA SDK lzma-specification.txt (Igor Pavlov)",
    containers: [
      {
        name: "alone",
        label: ".lzma",
        standard: "LZMA Utils .lzma (lzma_alone)",
        extensions: [".lzma"],
        magic: "5d",
      },
      {
        name: "xz",
        label: "xz",
        standard: "The .xz File Format 1.2.1",
        extensions: [".xz", ".txz"],
        magic: "fd377a585a00",
        checksum: "CRC-64 by default; CRC-32, SHA-256 or none",
      },
    ],
    compress: true,
    options: [
      {
        name: "container",
        type: "string",
        default: "alone",
        choices: [...LZMA_CONTAINERS],
        decode: true,
        description: "alone for a .lzma file, xz for an .xz file",
      },
      {
        name: "level",
        type: "number",
        default: 6,
        min: 0,
        max: 9,
        description: "Dictionary size and search depth, as xz's presets: 0 is 256 KiB, 9 is 64 MiB",
      },
      {
        name: "check",
        type: "string",
        default: "crc64",
        choices: [...XZ_CHECKS],
        containers: ["xz"],
        description: "What xz stores after the block to check it",
      },
    ],
  },
  compress(bytes, options) {
    if (options.container === "xz") {
      const level = levelOf(options);
      const check = (options["check"] as XzCheck | undefined) ?? "crc64";
      return encodeXz(bytes, encoderFor(bytes, level), DICTIONARY_SIZES[level]!, check);
    }
    if (options["check"] !== undefined)
      throw new InvalidOptionError("check", options["check"], "only xz takes it");
    return encodeAlone(bytes, levelOf(options));
  },
  decompress(data, out, container) {
    return container === "xz" ? decodeXz(data, out) : decodeAlone(data, out);
  },
});
