import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { rolldown } from "vite/rolldown";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { formatEntries } from "../build.config.ts";

const root = join(import.meta.dirname, "..");
let packed = "";

const entries = [...formatEntries];

/** A string only that format's code carries, so finding it elsewhere means a leak. */
const markers: Record<(typeof entries)[number], string> = {
  deflate: "gzip CRC-32 does not match",
  bzip2: "randomized blocks",
  lzma: "xz block check does not match",
  zstd: "treeless literals",
  brotli: "large window brotli",
  lz4: "not a legacy LZ4 frame",
  lzw: "is not in the table yet",
};

/** What a format can throw. `UnknownFormatError` belongs to the registry and stays at the root. */
const errorClasses = [
  "CompressionError",
  "DecompressError",
  "ChecksumError",
  "UnsupportedError",
  "LimitError",
  "InvalidOptionError",
];

/** Strings of the registry and `identify`, which no format subpath should load. */
const registryMarkers = ["is a container, not a format", "decodes to the last byte"];

/**
 * Builds the current source with `build.config.ts` into a directory inside the repo, never an
 * old `dist`; inside the repo so the bundle resolves the `@agntn` siblings from `node_modules`.
 */
beforeAll(() => {
  packed = mkdtempSync(join(root, "node_modules/.cache-compressions-bundle-"));
  const script = `
    import { build } from "obuild";
    import config from "./build.config.ts";
    const outDir = ${JSON.stringify(packed)};
    await build({
      ...config,
      cwd: ${JSON.stringify(root)},
      entries: config.entries.map((entry) => ({ ...entry, outDir, dts: false })),
    });
  `;
  const { status, stderr } = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
  });
  if (status !== 0) throw new Error(`obuild failed:\n${stderr}`);
}, 60_000);

afterAll(() => {
  if (packed) rmSync(packed, { recursive: true, force: true });
});

/**
 * Bundles a consumer of everything one built entry exports, minified.
 *
 * @param entry - Entry file name without extension.
 * @returns {Promise<string>} The bundle.
 */
async function bundle(entry: string): Promise<string> {
  const input = join(packed, `consumer-${entry}.mjs`);
  writeFileSync(input, `export * from ${JSON.stringify(join(packed, `${entry}.mjs`))};\n`);
  const build = await rolldown({ input, platform: "node", logLevel: "silent" });
  const { output } = await build.generate({ format: "esm", minify: true });
  return output.map((chunk) => ("code" in chunk ? chunk.code : "")).join("\n");
}

/* The exports of one built entry, by file name without extension. */
async function load(entry: string): Promise<Record<string, unknown>> {
  const url = pathToFileURL(join(packed, `${entry}.mjs`)).href;
  return (await import(url)) as Record<string, unknown>;
}

describe("format subpaths", () => {
  it.each(entries)("%s carries its own format and no other", async (format) => {
    const code = await bundle(format);
    expect(code).toContain(markers[format]);
    for (const [other, marker] of Object.entries(markers)) {
      if (other === format) continue;
      expect(code, `${format} pulled in ${other}`).not.toContain(marker);
    }
    for (const marker of registryMarkers) expect(code).not.toContain(marker);
  });

  it.each(entries)("%s hands out the root's error classes, so instanceof works", async (format) => {
    const [subpath, root] = await Promise.all([load(format), load("index")]);
    for (const name of errorClasses) expect(subpath[name], name).toBe(root[name]);
    expect(subpath).not.toHaveProperty("UnknownFormatError");
  });

  it("keeps the brotli dictionary out of every subpath but brotli", async () => {
    for (const format of entries) {
      const code = await bundle(format);
      expect(code.length, format).toBeLessThan(format === "brotli" ? 140_000 : 40_000);
    }
  });

  it("keeps the root entry whole: the registry and every format", async () => {
    const code = await bundle("index");
    for (const marker of [...Object.values(markers), ...registryMarkers])
      expect(code).toContain(marker);
  });
});
