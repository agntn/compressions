import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { compress, decompress } from "../src/index.ts";

const docs = (path: string): string =>
  readFileSync(new URL(`../docs/${path}`, import.meta.url), "utf8");

const hexBytes = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, "hex"));

const formatsSource = docs("app/utils/formats.ts");
const sample = /SAMPLE_INPUT = "([^"]+)"/u.exec(formatsSource)![1]!;

/**
 * The lines of `FILE` in `LandingCustom.vue`, read as the string literals they are.
 *
 * @returns {string[]} The lines.
 */
function customFile(): string[] {
  const source = docs("app/components/content/LandingCustom.vue");
  const body = /const FILE = \[\n([\s\S]*?)\n\] as const;/u.exec(source)![1]!;
  return [...body.matchAll(/^ {2}(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"),$/gmu)].map(
    ([, single, double]) => (single ?? double)!,
  );
}

describe("docs literals", () => {
  it("decompresses the read only samples to the landing's text", () => {
    for (const format of ["zstd", "brotli"]) {
      const hex = new RegExp(`${format}: "([0-9a-f]+)"`, "u").exec(formatsSource)![1]!;
      const { bytes } = decompress(format, hexBytes(hex));
      expect(new TextDecoder().decode(bytes)).toBe(sample);
      expect(docs(`content/2.formats/0${format === "zstd" ? 4 : 5}.${format}.md`)).toContain(hex);
    }
  });

  it("runs the run-length file the landing shows and the custom guide repeats", async () => {
    const lines = customFile();
    expect(lines.length).toBeGreaterThan(20);
    expect(docs("content/1.guide/09.custom.md")).toContain(lines.join("\n"));
    const dir = mkdtempSync(join(tmpdir(), "compressions-docs-"));
    const file = join(dir, "rle.ts");
    const index = pathToFileURL(new URL("../src/index.ts", import.meta.url).pathname).href;
    writeFileSync(
      file,
      `${lines.join("\n").replace('"@agntn/compressions"', JSON.stringify(index))}\nexport { rle };\n`,
    );
    await import(pathToFileURL(file).href);
    expect([...compress("rle", "aaaabbb")]).toEqual([4, 97, 3, 98]);
    expect(new TextDecoder().decode(decompress("rle", compress("rle", "aaaabbb")).bytes)).toBe(
      "aaaabbb",
    );
    expect(() => decompress("rle", Uint8Array.of(4, 97, 3))).toThrow(
      "rle: a run needs its length and its byte",
    );
  });

  it("quotes the gzip stream the guide and the CLI page decompress", () => {
    const gz = "1f8b08000000000000ffcb48cdc9c95728cf2fca495104006dc2b4030c000000";
    expect(
      Buffer.from(compress("deflate", "hello world!", { container: "gzip" })).toString("hex"),
    ).toBe(gz);
    expect(docs("content/1.guide/07.cli.md")).toContain(gz);
    const base64 = Buffer.from(hexBytes(gz)).toString("base64");
    for (const page of ["content/1.guide/08.agents.md", "content/1.guide/10.playground.md"]) {
      expect(docs(page)).toContain(base64);
    }
  });

  it("quotes the sizes the format pages state", () => {
    const text = "hello world!";
    const sizes: [string, Record<string, string | number | boolean>, number][] = [
      ["deflate", {}, 14],
      ["deflate", { container: "zlib" }, 20],
      ["deflate", { container: "gzip" }, 32],
      ["deflate", { level: 0 }, 17],
      ["bzip2", {}, 49],
      ["lzma", {}, 30],
      ["lzma", { container: "xz", check: "none" }, 60],
      ["lzma", { container: "xz", check: "crc32" }, 64],
      ["lzma", { container: "xz" }, 68],
      ["lzma", { container: "xz", check: "sha256" }, 92],
      ["lz4", {}, 31],
      ["lz4", { container: "legacy" }, 21],
      ["lz4", { checksum: false }, 27],
      ["lzw", {}, 17],
    ];
    for (const [format, options, size] of sizes) {
      expect(compress(format, text, options).length, `${format} ${JSON.stringify(options)}`).toBe(
        size,
      );
    }
    const gz = compress("deflate", text, {
      container: "gzip",
      name: "notes.txt",
      mtime: 1700000000,
    });
    expect(decompress("deflate", gz, { container: "gzip" }).details).toEqual({
      name: "notes.txt",
      mtime: 1700000000,
      os: 255,
      members: 1,
    });
  });
});
