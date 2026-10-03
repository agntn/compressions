import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as zlib from "node:zlib";
import { describe, expect, it } from "vite-plus/test";
import { formatEntries } from "../build.config.ts";
import {
  CompressionError,
  InvalidOptionError,
  UnknownFormatError,
  archiveOf,
  compress,
  compressionFormats,
  create,
  decompress,
  defineCompression,
  deflate,
  formatInfos,
  formats,
  has,
  identify,
  lzma,
  peel,
  register,
  resolveFormat,
  version,
} from "../src/index.ts";
import * as root from "../src/index.ts";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
  exports: Record<string, unknown>;
};

describe("@agntn/compressions", () => {
  it("exports the manifest version", () => {
    expect(version).toBe(manifest.version);
  });

  it("lists the built-ins in a fixed order, one subpath and one export each", () => {
    expect(formats().slice(0, 7)).toEqual([...compressionFormats]);
    expect([...formatEntries]).toEqual([...compressionFormats]);
    const subpaths = Object.keys(manifest.exports).filter(
      (path) => !/^\.(?:\/ai|\/mcp)?$/u.test(path),
    );
    expect(subpaths).toEqual(compressionFormats.map((name) => `./${name}`));
  });

  it.each(compressionFormats.map((name) => [name]))(
    "%s subpath exports the root's own objects",
    async (name) => {
      const module = (await import(`../src/${name}.ts`)) as Record<string, unknown>;
      expect(module[name]).toBe(root[name as keyof typeof root]);
      for (const [key, value] of Object.entries(module))
        expect(value, key).toBe(root[key as keyof typeof root]);
    },
  );

  it("describes every container with a default first and every option with its scope", () => {
    for (const info of formatInfos()) {
      expect(info.containers.length).toBeGreaterThan(0);
      const container = info.options.find((option) => option.name === "container");
      if (info.containers.length > 1) {
        expect(container).toMatchObject({
          decode: true,
          default: info.containers[0]!.name,
          choices: info.containers.map((entry) => entry.name),
        });
      } else {
        expect(container).toBeUndefined();
      }
      for (const option of info.options) {
        for (const name of option.containers ?? [])
          expect(info.containers.map((entry) => entry.name)).toContain(name);
      }
    }
  });
});

describe("resolveFormat", () => {
  it("forgives case, dots and separators and knows the usual short names", () => {
    expect(resolveFormat("BZIP2")).toBe("bzip2");
    expect(resolveFormat(" Zstd ")).toBe("zstd");
    expect(resolveFormat("bz2")).toBe("bzip2");
    expect(resolveFormat(".zst")).toBe("zstd");
    expect(resolveFormat("br")).toBe("brotli");
    expect(resolveFormat("compress")).toBe("lzw");
  });

  it("points a container name at its format and container", () => {
    expect(() => resolveFormat("gzip")).toThrow(
      "gzip is a container, not a format: use deflate with container gzip",
    );
    expect(() => resolveFormat("xz")).toThrow("use lzma with container xz");
    expect(() => resolveFormat(".gz")).toThrow("use deflate with container gzip");
    expect(() => resolveFormat("zlib")).toThrow("use deflate with container zlib");
  });

  it("names the available formats when nothing matches", () => {
    expect(() => resolveFormat("rar")).toThrow(UnknownFormatError);
    expect(() => resolveFormat("rar")).toThrow(
      "Unknown format: rar. Available: deflate, bzip2, lzma, zstd, brotli, lz4, lzw",
    );
    expect(() => resolveFormat("a\u001B]0;x")).toThrow('Unknown format: "a\\u001b]0;x"');
  });
});

describe("the registry", () => {
  it("compresses and decompresses by name", () => {
    const packed = compress("deflate", "hello", { container: "zlib" });
    expect(
      new TextDecoder().decode(decompress("deflate", packed, { container: "zlib" }).bytes),
    ).toBe("hello");
  });

  it("refuses input that is not bytes or text", () => {
    expect(() => deflate.compress(42 as unknown as string)).toThrow(InvalidOptionError);
    expect(() => deflate.decompress("eJw=" as unknown as Uint8Array)).toThrow(
      "compressed data must be a Uint8Array",
    );
  });

  it("adds a format that identify then tries", () => {
    const reversed = defineCompression({
      info: {
        name: "reversed",
        label: "Reversed",
        description: "Bytes backward",
        standard: "none",
        containers: [{ name: "reversed", label: "Reversed", standard: "none", extensions: [] }],
        compress: true,
        options: [],
      },
      compress: (bytes) => bytes.toReversed(),
      decompress: (data, out) => {
        out.append(data.toReversed());
        return {};
      },
    });
    register(reversed);
    expect(has("reversed")).toBe(true);
    expect(
      new TextDecoder().decode(
        create("reversed").decompress(create("reversed").compress("abc")).bytes,
      ),
    ).toBe("abc");
    expect(() => create("reversed").compress("abc", { level: 1 })).toThrow(CompressionError);
  });
});

describe("identify", () => {
  const text = new TextEncoder().encode("Identify me, please. ".repeat(40));

  it.each([
    ["deflate", "gzip"],
    ["deflate", "zlib"],
    ["bzip2", "bzip2"],
    ["lzma", "xz"],
    ["lzma", "alone"],
    ["lz4", "frame"],
    ["lz4", "legacy"],
    ["lzw", "compress"],
  ])("puts %s %s first, confirmed, for what it wrote", (format, container) => {
    const options = create(format).info().containers.length > 1 ? { container } : {};
    const [best] = identify(create(format).compress(text, options));
    expect(best).toMatchObject({ format, container, confirmed: true });
    expect(best!.bytes).toEqual(text);
  });

  it("finds zstd and brotli from node:zlib, brotli by decoding to the last byte", () => {
    expect(identify(zlib.zstdCompressSync(text))[0]).toMatchObject({
      format: "zstd",
      confirmed: true,
    });
    const [best] = identify(zlib.brotliCompressSync(text));
    expect(best).toMatchObject({ format: "brotli", container: "brotli", confirmed: false });
    expect(best!.reasons).toEqual([
      "decodes to the last byte",
      "decompresses to readable text",
      "comes out longer than it went in",
    ]);
  });

  it("ranks a magic number with a checksum above a guess", () => {
    const [best, ...rest] = identify(deflate.compress(text, { container: "gzip" }));
    expect(best!.confidence).toBe(100);
    expect(best!.reasons).toEqual([
      "starts with its magic number",
      "checksum matches",
      "decodes to the last byte",
      "decompresses to readable text",
      "comes out longer than it went in",
    ]);
    for (const candidate of rest) expect(candidate.confidence).toBeLessThan(best!.confidence);
  });

  it("finds nothing in plain text and names archives it does not open", () => {
    expect(identify(text)).toEqual([]);
    expect(archiveOf(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]))).toBe("a ZIP archive");
    expect(archiveOf(text)).toBeUndefined();
  });

  it("peels layers outermost first and stops at plain data", () => {
    const inner = deflate.compress(text, { container: "gzip" });
    const middle = lzma.compress(inner, { container: "xz" });
    const outer = create("bzip2").compress(middle);
    const layers = peel(outer);
    expect(layers.map((layer) => [layer.format, layer.container])).toEqual([
      ["bzip2", "bzip2"],
      ["lzma", "xz"],
      ["deflate", "gzip"],
    ]);
    expect(layers.at(-1)!.bytes).toEqual(text);
    expect(peel(outer, { depth: 1 })).toHaveLength(1);
    expect(peel(text)).toEqual([]);
  });

  it("peels what the reference tools wrote, gzip inside xz inside zstd", () => {
    for (const tool of ["gzip", "xz", "zstd"]) {
      if (
        execFileSync("sh", ["-c", `command -v ${tool} || true`], { encoding: "utf8" }).trim() === ""
      )
        return;
    }
    const nested = execFileSync("sh", ["-c", "gzip -c | xz -c | zstd -q -c"], { input: text });
    expect(peel(nested).map((layer) => layer.container)).toEqual(["zstd", "xz", "gzip"]);
  });
});

describe("the library graph", () => {
  it("loads and runs every format with node: imports blocked, as a browser would", () => {
    const script = `
      import { registerHooks } from "node:module";
      registerHooks({
        resolve(specifier, context, next) {
          if (specifier.startsWith("node:") && !context.parentURL?.includes("/node_modules/")) {
            throw new Error("node import " + specifier + " from " + context.parentURL);
          }
          return next(specifier, context);
        },
      });
      const lib = await import(${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)});
      const text = new TextEncoder().encode("browser ".repeat(100));
      for (const name of lib.formats()) {
        const format = lib.create(name);
        const containers = format.info().containers;
        if (!format.info().compress) continue;
        for (const { name: container } of containers) {
          const options = containers.length > 1 ? { container } : {};
          const back = format.decompress(format.compress(text, options), options).bytes;
          if (back.length !== text.length) throw new Error(name + " " + container);
        }
      }
      console.log(lib.brotli.decompress(Uint8Array.from([0x8f, 0x00, 0x80, 0x68, 0x69, 0x03])).bytes.length);
    `;
    expect(
      execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
      }).trim(),
    ).toBe("2");
  });
});
