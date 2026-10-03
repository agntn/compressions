import { execFileSync, spawnSync } from "node:child_process";
import * as zlib from "node:zlib";
import { crc32 } from "@agntn/hashes/crc";
import { describe, expect, it } from "vite-plus/test";
import {
  ChecksumError,
  DecompressError,
  InvalidOptionError,
  LimitError,
  UnsupportedError,
  brotli,
  bzip2,
  compress,
  decompress,
  deflate,
  lz4,
  lzma,
  lzw,
  zstd,
  type Compression,
} from "../src/index.ts";
import { DICTIONARY_DEFLATED } from "../src/core/brotli-dictionary.ts";
import { TRANSFORMS } from "../src/core/brotli-tables.ts";
import { predefinedTable } from "../src/core/zstd.ts";
import { REFERENCES, referenceInputs } from "./fixtures/references.ts";
import { LITERAL_LENGTHS, MATCH_LENGTHS, OFFSETS } from "./fixtures/zstd-tables.ts";

const { text, noise } = referenceInputs();

/**
 * Deterministic bytes: glibc's old LCG, the top byte of each state.
 * @param length - How many.
 * @param seed - Start state.
 * @returns {Uint8Array} The bytes.
 */
function random(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    bytes[i] = state >>> 24;
  }
  return bytes;
}

const SAMPLES: Record<string, Uint8Array> = {
  empty: new Uint8Array(0),
  "one byte": new Uint8Array([65]),
  text,
  noise,
  "long run": new Uint8Array(300_000).fill(7),
  "random 70 KiB": random(70_000, 1),
  "four symbols": random(20_000, 2).map((byte) => byte & 3),
  "large text": new TextEncoder().encode(
    "Lorem ipsum dolor sit amet, consectetur. ".repeat(12_000),
  ),
};

/**
 * Compares bytes fast and names the first difference; `toEqual` walks a large array slowly.
 * @param actual - What came out.
 * @param expected - What should have.
 * @param label - Names the case in a failure.
 */
function expectBytes(actual: Uint8Array, expected: Uint8Array, label = ""): void {
  const length = Math.min(actual.length, expected.length);
  let at = 0;
  while (at < length && actual[at] === expected[at]) at++;
  expect({
    label,
    length: actual.length,
    firstDifference: at === length && actual.length === expected.length ? -1 : at,
  }).toEqual({
    label,
    length: expected.length,
    firstDifference: -1,
  });
}

const hasTool = (name: string): boolean =>
  spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0;

/** The formats this package writes, each container with its option sets. */
const WRITERS: Array<[Compression, string, Record<string, string | number | boolean>]> = [
  [deflate, "raw", { level: 0 }],
  [deflate, "raw", { level: 1 }],
  [deflate, "raw", { level: 6 }],
  [deflate, "zlib", { level: 9 }],
  [deflate, "gzip", { level: 4, name: "a.txt", mtime: 1_700_000_000 }],
  [bzip2, "bzip2", { level: 1 }],
  [bzip2, "bzip2", { level: 9 }],
  [lzma, "alone", { level: 0 }],
  [lzma, "alone", { level: 6 }],
  [lzma, "xz", { level: 6 }],
  [lzma, "xz", { level: 1, check: "sha256" }],
  [lzma, "xz", { level: 3, check: "none" }],
  [lz4, "frame", {}],
  [lz4, "frame", { checksum: false }],
  [lz4, "legacy", {}],
  [lzw, "compress", { bits: 12 }],
  [lzw, "compress", {}],
];

describe("round trips", () => {
  it.each(WRITERS)(
    "%s %s %o reads back what it wrote",
    { timeout: 60_000 },
    (format, container, options) => {
      for (const [name, sample] of Object.entries(SAMPLES)) {
        const multi = format.info().containers.length > 1 ? { container } : {};
        const packed = format.compress(sample, { ...multi, ...options });
        expectBytes(format.decompress(packed, multi).bytes, sample, name);
      }
    },
  );

  it("reads text as UTF-8", () => {
    const packed = compress("deflate", "zażółć", { container: "gzip" });
    expect(
      new TextDecoder().decode(decompress("deflate", packed, { container: "gzip" }).bytes),
    ).toBe("zażółć");
  });
});

describe("outside readers take what this package writes", () => {
  it.each(Object.entries(SAMPLES))(
    "node:zlib inflates deflate, zlib and gzip of %s",
    { timeout: 60_000 },
    (_, sample) => {
      for (const level of [0, 1, 6, 9]) {
        expectBytes(
          new Uint8Array(zlib.inflateRawSync(deflate.compress(sample, { level }))),
          sample,
          `raw ${level}`,
        );
        expectBytes(
          new Uint8Array(zlib.inflateSync(deflate.compress(sample, { container: "zlib", level }))),
          sample,
          `zlib ${level}`,
        );
        expectBytes(
          new Uint8Array(zlib.gunzipSync(deflate.compress(sample, { container: "gzip", level }))),
          sample,
          `gzip ${level}`,
        );
      }
    },
  );

  const tools: Array<[string, string[], Compression, Record<string, string | number | boolean>]> = [
    ["bzip2", ["-dc"], bzip2, {}],
    ["xz", ["-dc"], lzma, { container: "xz" }],
    ["xz", ["-dc", "--format=lzma"], lzma, { container: "alone" }],
    ["lz4", ["-dc"], lz4, {}],
    ["lz4", ["-dc"], lz4, { container: "legacy" }],
    ["gzip", ["-dc"], lzw, {}],
  ];
  it.each(tools)(
    "%s %s reads it, when installed",
    { timeout: 60_000 },
    (tool, args, format, options) => {
      if (!hasTool(tool)) return;
      for (const [name, sample] of Object.entries(SAMPLES)) {
        if (tool === "lz4" && options["container"] === "legacy" && sample.length === 0) continue;
        const packed = format.compress(sample, options);
        const read = new Uint8Array(
          execFileSync(tool, args, { input: packed, maxBuffer: 1 << 28 }),
        );
        expectBytes(read, sample, `${tool} on ${name}`);
      }
    },
  );
});

describe("streams written by the reference tools", () => {
  it.each(REFERENCES.map((reference) => [reference.tool, reference.input, reference] as const))(
    "%s on %s",
    (_, input, reference) => {
      const data = Uint8Array.fromBase64(reference.data);
      const format = { deflate, bzip2, lzma, zstd, brotli, lz4, lzw }[
        reference.format as "deflate"
      ];
      const expected = input === "text" ? text : noise;
      expectBytes(format.decompress(data, { container: reference.container }).bytes, expected);
    },
  );

  it(
    "node:zlib gzip, zlib, raw deflate, brotli and zstd at every level",
    { timeout: 120_000 },
    () => {
      for (const sample of [text, noise, SAMPLES["large text"]!, SAMPLES["random 70 KiB"]!]) {
        for (const level of [1, 6, 9]) {
          expectBytes(
            deflate.decompress(zlib.gzipSync(sample, { level }), { container: "gzip" }).bytes,
            sample,
          );
          expectBytes(
            deflate.decompress(zlib.deflateSync(sample, { level }), { container: "zlib" }).bytes,
            sample,
          );
          expectBytes(deflate.decompress(zlib.deflateRawSync(sample, { level })).bytes, sample);
        }
        for (const quality of [0, 5, 11]) {
          for (const lgwin of [10, 18, 24]) {
            const params = {
              [zlib.constants.BROTLI_PARAM_QUALITY]: quality,
              [zlib.constants.BROTLI_PARAM_LGWIN]: lgwin,
            };
            expectBytes(
              brotli.decompress(zlib.brotliCompressSync(sample, { params })).bytes,
              sample,
              `brotli ${quality} ${lgwin}`,
            );
          }
        }
        for (const level of [-5, 1, 3, 19]) {
          const params = {
            [zlib.constants.ZSTD_c_compressionLevel]: level,
            [zlib.constants.ZSTD_c_checksumFlag]: 1,
          };
          expectBytes(
            zstd.decompress(zlib.zstdCompressSync(sample, { params })).bytes,
            sample,
            `zstd ${level}`,
          );
        }
      }
    },
  );

  it("names what the streams carried", () => {
    const named = REFERENCES.find(
      (reference) => reference.tool === "gzip -1 (with name)" && reference.input === "text",
    )!;
    expect(
      deflate.decompress(Uint8Array.fromBase64(named.data), { container: "gzip" }).details,
    ).toMatchObject({
      name: "fixture.txt",
      members: 1,
    });
    const sha = REFERENCES.find((reference) => reference.tool === "xz -9e --check=sha256")!;
    expect(lzma.decompress(Uint8Array.fromBase64(sha.data), { container: "xz" }).details).toEqual({
      check: "sha256",
      blocks: 1,
    });
    const alone = REFERENCES.find((reference) => reference.container === "alone")!;
    expect(lzma.decompress(Uint8Array.fromBase64(alone.data)).details).toMatchObject({
      properties: "lc=3 lp=0 pb=2",
      dictionary: 8 << 20,
    });
  });
});

describe("streams in a row and what follows them", () => {
  it("reads every gzip member, as gunzip does, and counts the trailing bytes", () => {
    const two = new Uint8Array([...zlib.gzipSync("one "), ...zlib.gzipSync("two")]);
    expect(new TextDecoder().decode(deflate.decompress(two, { container: "gzip" }).bytes)).toBe(
      "one two",
    );
    expect(deflate.decompress(two, { container: "gzip" }).details["members"]).toBe(2);
    const trailing = new Uint8Array([...zlib.gzipSync("x"), 1, 2, 3]);
    expect(deflate.decompress(trailing, { container: "gzip" }).details["trailing"]).toBe(3);
    const zeros = new Uint8Array([...zlib.gzipSync("x"), 0, 0, 0, 0]);
    expect(deflate.decompress(zeros, { container: "gzip" }).details).not.toHaveProperty("trailing");
  });

  it("reads concatenated bzip2, xz, zstd and lz4 streams", () => {
    const join = (format: Readonly<Compression>, options: Readonly<Record<string, string>>) =>
      new Uint8Array([...format.compress("ab", options), ...format.compress("cd", options)]);
    expect(new TextDecoder().decode(bzip2.decompress(join(bzip2, {})).bytes)).toBe("abcd");
    expect(
      new TextDecoder().decode(
        lzma.decompress(join(lzma, { container: "xz" }), { container: "xz" }).bytes,
      ),
    ).toBe("abcd");
    expect(new TextDecoder().decode(lz4.decompress(join(lz4, {})).bytes)).toBe("abcd");
    const frames = new Uint8Array([...zlib.zstdCompressSync("ab"), ...zlib.zstdCompressSync("cd")]);
    expect(zstd.decompress(frames).details).toMatchObject({ frames: 2 });
  });

  it("skips skippable frames in zstd and lz4", () => {
    const skippable = new Uint8Array([0x50, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 9, 9, 9]);
    expect(
      new TextDecoder().decode(
        zstd.decompress(new Uint8Array([...skippable, ...zlib.zstdCompressSync("hi")])).bytes,
      ),
    ).toBe("hi");
    expect(
      new TextDecoder().decode(
        lz4.decompress(new Uint8Array([...lz4.compress("hi"), ...skippable])).bytes,
      ),
    ).toBe("hi");
  });
});

describe("broken streams", () => {
  const flipped = (bytes: Uint8Array, at: number): Uint8Array => {
    const copy = bytes.slice();
    copy[at]! ^= 0x01;
    return copy;
  };

  it.each([
    ["gzip CRC-32", deflate, { container: "gzip" }, -8],
    ["gzip size", deflate, { container: "gzip" }, -4],
    ["zlib Adler-32", deflate, { container: "zlib" }, -1],
    ["bzip2 stream CRC", bzip2, {}, -2],
    ["lz4 content checksum", lz4, {}, -1],
  ] as const)("refuses a wrong %s with ChecksumError", (_, format, options, at) => {
    const packed = format.compress(text, options);
    expect(() => format.decompress(flipped(packed, packed.length + at), options)).toThrow(
      ChecksumError,
    );
  });

  it("refuses a wrong xz block check", () => {
    const packed = lzma.compress(text, { container: "xz" });
    const index = (new DataView(packed.buffer).getUint32(packed.length - 8, true) + 1) * 4;
    const checkEnd = packed.length - 12 - index;
    expect(() => lzma.decompress(flipped(packed, checkEnd - 1), { container: "xz" })).toThrow(
      "xz block check does not match",
    );
  });

  it("refuses a wrong zstd checksum", () => {
    const packed = new Uint8Array(
      zlib.zstdCompressSync(text, { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }),
    );
    expect(() => zstd.decompress(flipped(packed, packed.length - 1))).toThrow(ChecksumError);
  });

  const cutCases: Array<[string, Compression, Uint8Array]> = [
    ["deflate", deflate, deflate.compress(SAMPLES["large text"]!, { container: "gzip" })],
    ["bzip2", bzip2, bzip2.compress(SAMPLES["large text"]!, { level: 1 })],
    ["lzma", lzma, lzma.compress(SAMPLES["large text"]!, { container: "xz" })],
    ["zstd", zstd, new Uint8Array(zlib.zstdCompressSync(SAMPLES["random 70 KiB"]!))],
    ["brotli", brotli, new Uint8Array(zlib.brotliCompressSync(SAMPLES["large text"]!))],
    ["lz4", lz4, lz4.compress(SAMPLES["large text"]!)],
  ];
  it.each(cutCases)(
    "%s fails on a cut stream, and partial gives back a true start of it",
    (name, format, packed) => {
      const container = { deflate: "gzip", lzma: "xz" }[name as "deflate"];
      const options = container ? { container } : {};
      const cut = packed.subarray(0, Math.floor(packed.length / 2));
      const original = name === "zstd" ? SAMPLES["random 70 KiB"]! : SAMPLES["large text"]!;
      expect(() => format.decompress(cut, options)).toThrow("unexpected end of data");
      const { bytes, details } = format.decompress(cut, { ...options, partial: true });
      expect(details["error"]).toMatch(/unexpected end of data/u);
      expectBytes(bytes, original.subarray(0, bytes.length), name);
      if (["deflate", "bzip2", "lzma"].includes(name)) expect(bytes.length).toBeGreaterThan(0);
    },
  );

  it("reads a cut .Z file as a shorter one, since LZW has no end marker", () => {
    const packed = lzw.compress(SAMPLES["large text"]!);
    const { bytes } = lzw.decompress(packed.subarray(0, packed.length >> 1));
    expect(bytes.length).toBeGreaterThan(0);
    expectBytes(bytes, SAMPLES["large text"]!.subarray(0, bytes.length));
  });

  it("stops at the limit with LimitError, before writing a bomb out", () => {
    const bomb = deflate.compress(new Uint8Array(10_000_000), { container: "gzip", level: 9 });
    expect(bomb.length).toBeLessThan(20_000);
    expect(() => deflate.decompress(bomb, { container: "gzip", limit: 1_000_000 })).toThrow(
      LimitError,
    );
    expect(
      deflate.decompress(bomb, { container: "gzip", limit: Number.POSITIVE_INFINITY }).bytes.length,
    ).toBe(10_000_000);
    const partial = deflate.decompress(bomb, {
      container: "gzip",
      limit: 1_000_000,
      partial: true,
    });
    expect(partial.bytes.length).toBeLessThanOrEqual(1_000_000);
    expect(partial.details["error"]).toBe("deflate: output passes the limit of 1000000 bytes");
    expect(() => deflate.decompress(bomb, { container: "gzip", limit: -1 })).toThrow(
      InvalidOptionError,
    );
  });

  it("names what it does not support", () => {
    const dictionary = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x01, 0x58, 7, 1, 0, 0, 0]);
    expect(() => zstd.decompress(dictionary)).toThrow(UnsupportedError);
    expect(() => zstd.decompress(dictionary)).toThrow("frame needs dictionary 7");
    expect(() =>
      deflate.decompress(new Uint8Array([0x78, 0xbb, 0, 0, 0, 0, 1, 0, 0, 0]), {
        container: "zlib",
      }),
    ).toThrow("zlib stream needs a preset dictionary");
    if (hasTool("xz")) {
      const arm = new Uint8Array(execFileSync("xz", ["--arm", "--lzma2", "-c"], { input: text }));
      expect(() => lzma.decompress(arm, { container: "xz" })).toThrow("xz ARM filter");
    }
    expect(() => zstd.compress("x")).toThrow("this package reads Zstandard but does not write it");
    expect(() => brotli.compress("x")).toThrow("this package reads Brotli but does not write it");
  });

  it("refuses data that is not the format", () => {
    for (const format of [deflate, bzip2, lzma, zstd, lz4, lzw]) {
      const container = format.info().containers.at(-1)!.name;
      const options = format.info().containers.length > 1 ? { container } : {};
      expect(() => format.decompress(text, options)).toThrow(DecompressError);
    }
  });
});

describe("options", () => {
  it("checks names, types, ranges and containers", () => {
    expect(() => deflate.compress("x", { levl: 1 })).toThrow(
      "deflate takes container, level, name, mtime",
    );
    expect(() => deflate.compress("x", { level: 10 })).toThrow(InvalidOptionError);
    expect(() => deflate.compress("x", { level: "9" })).toThrow("must be a number");
    expect(() => deflate.compress("x", { name: "a.txt" })).toThrow("only gzip takes it, not raw");
    expect(() => deflate.compress("x", { container: "xz" })).toThrow(
      "deflate comes as raw, zlib, gzip",
    );
    expect(() => lzma.compress("x", { check: "crc64" })).toThrow("only xz takes it, not alone");
    expect(() => deflate.decompress(new Uint8Array(1), { level: 6 } as never)).toThrow(
      "deflate takes container",
    );
    expect(() => lzw.compress("x", { bits: 9 })).toThrow(InvalidOptionError);
    expect(() => deflate.compress("x", { container: "gzip", name: "Ω" })).toThrow("Latin-1");
  });

  it("writes the gzip header fields it was given", () => {
    const packed = deflate.compress("x", {
      container: "gzip",
      name: "notes.txt",
      mtime: 1_700_000_000,
    });
    expect(deflate.decompress(packed, { container: "gzip" }).details).toMatchObject({
      name: "notes.txt",
      mtime: 1_700_000_000,
      os: 255,
    });
    expect(Array.from(packed.subarray(0, 4))).toEqual([0x1f, 0x8b, 8, 8]);
  });

  it("writes the zlib level hint and the xz check it was asked for", () => {
    expect(
      Array.from(deflate.compress("x", { container: "zlib", level: 9 }).subarray(0, 2)),
    ).toEqual([0x78, 0xda]);
    expect(
      Array.from(deflate.compress("x", { container: "zlib", level: 1 }).subarray(0, 2)),
    ).toEqual([0x78, 0x01]);
    expect(Array.from(deflate.compress("x", { container: "zlib" }).subarray(0, 2))).toEqual([
      0x78, 0x9c,
    ]);
    for (const check of ["none", "crc32", "crc64", "sha256"] as const) {
      expect(
        lzma.decompress(lzma.compress("x", { container: "xz", check }), { container: "xz" })
          .details["check"],
      ).toBe(check);
    }
  });
});

describe("tables from the specifications", () => {
  it.each([
    ["literalLengths", LITERAL_LENGTHS],
    ["matchLengths", MATCH_LENGTHS],
    ["offsets", OFFSETS],
  ] as const)("builds the zstd %s table RFC 8878 appendix A prints", (kind, rows) => {
    const table = predefinedTable(kind);
    const built = rows.map((_, state) => [
      table.symbols[state],
      table.bits[state],
      table.base[state],
    ]);
    expect(built).toEqual(rows);
  });

  it("holds the brotli dictionary to the CRC-32 RFC 7932 states", () => {
    const out = deflate.decompress(Uint8Array.fromBase64(DICTIONARY_DEFLATED));
    expect(out.bytes.length).toBe(122_784);
    expect(crc32(out.bytes).toHex()).toBe("5136cb04");
  });

  it("holds the 121 brotli transforms to the CRC-32 RFC 7932 states", () => {
    const bytes: number[] = [];
    for (const [prefix, type, suffix] of TRANSFORMS) {
      for (const character of prefix) bytes.push(character.codePointAt(0)!);
      bytes.push(0, type);
      for (const character of suffix) bytes.push(character.codePointAt(0)!);
      bytes.push(0);
    }
    expect(TRANSFORMS).toHaveLength(121);
    expect(bytes).toHaveLength(648);
    expect(crc32(Uint8Array.from(bytes)).toHex()).toBe("3d965f81");
  });

  it("reads brotli dictionary words with their transforms", () => {
    const words = "The information about Government, DEVELOPMENT and the WORLD. Über pages of the ";
    const packed = zlib.brotliCompressSync(words, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
      },
    });
    expect(packed.length).toBeLessThan(words.length);
    expect(new TextDecoder().decode(brotli.decompress(packed).bytes)).toBe(words);
  });
});
