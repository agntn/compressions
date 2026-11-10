import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as zlib from "node:zlib";
import { describe, expect, it } from "vite-plus/test";

const switches = new Set([
  "CI",
  "FORCE_COLOR",
  "NO_COLOR",
  "NODE_DISABLE_COLORS",
  "COMPRESSIONS_DIST",
  "TEST",
]);
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !switches.has(key))),
  TERM: "xterm-256color",
};

/**
 * Runs the CLI from source.
 * @param input - Bytes for stdin.
 * @param args - Arguments.
 * @returns {{ code: number | null; stdout: Buffer; stderr: string }} What it did.
 */
function runWith(input: string | Uint8Array | undefined, ...args: readonly string[]) {
  const { status, stderr, stdout } = spawnSync(process.execPath, ["src/cli.ts", ...args], {
    env,
    input,
    maxBuffer: 1 << 26,
  });
  return { code: status, stdout, stderr: stderr.toString() };
}

function run(...args: readonly string[]) {
  return runWith(undefined, ...args);
}

const TEXT = "Compress me from the command line. ".repeat(30);

describe("compressions CLI", () => {
  it("prints the usage and its errors without colors into a pipe", () => {
    const help = run("--help");
    const usage = run("compress", "--help");
    const unknown = run("nope");
    for (const name of ["compress", "decompress", "identify", "list", "mcp"])
      expect(help.stdout.toString()).toMatch(new RegExp(`^  ${name} `, "mu"));
    expect(usage.stdout.toString()).toContain(
      "USAGE compressions compress [OPTIONS] <FORMAT> <FILE>",
    );
    expect(unknown).toMatchObject({
      code: 1,
      stderr: 'Unknown command "nope"\nRun compressions --help for the commands\n',
    });
    for (const output of [help, usage, unknown])
      expect(output.stdout.toString() + output.stderr).not.toContain("\u001B");
  });

  it("compresses stdin into gzip that node:zlib reads, and back", () => {
    const packed = runWith(
      TEXT,
      "compress",
      "deflate",
      "-",
      "--container",
      "gzip",
      "--name",
      "cli.txt",
      "--level=9",
    );
    expect(packed.code).toBe(0);
    expect(zlib.gunzipSync(packed.stdout).toString()).toBe(TEXT);
    const back = runWith(packed.stdout, "decompress", "deflate", "-", "--container", "gzip");
    expect(back).toMatchObject({ code: 0, stderr: "name: cli.txt\nos: 255\nmembers: 1\n" });
    expect(back.stdout.toString()).toBe(TEXT);
  });

  it("reads and writes hex and base64", () => {
    const packed = runWith(TEXT, "compress", "lzma", "-", "--container", "xz", "--to", "base64");
    expect(packed.stdout.toString()).toMatch(/^\/Td6WFoAA[A-Za-z0-9+/=]+\n$/u);
    const hex = runWith(
      packed.stdout,
      "decompress",
      "lzma",
      "-",
      "--container",
      "xz",
      "--from",
      "base64",
      "-o",
      "hex",
    );
    expect(Buffer.from(hex.stdout.toString().trim(), "hex").toString()).toBe(TEXT);
  });

  it("names the format, then peels nested layers to stdout", () => {
    const inner = runWith(TEXT, "compress", "deflate", "-", "--container", "gzip").stdout;
    const outer = runWith(inner, "compress", "bzip2", "-").stdout;
    const ranked = runWith(outer, "identify", "-");
    expect(ranked.stdout.toString().split("\n").slice(0, 2)).toEqual([
      "1 candidate, best first:",
      expect.stringMatching(
        /^1\. bzip2 container bzip2, confidence 90: starts with its magic number/u,
      ),
    ]);
    const peeled = runWith(outer, "identify", "--peel", "-");
    expect(peeled.code).toBe(0);
    expect(peeled.stdout.toString()).toBe(TEXT);
    const listed = peeled.stderr.split("\n");
    expect(listed[0]).toBe("2 layers, outermost first:");
    expect(listed[1]).toMatch(/^1\. bzip2 container bzip2/u);
    expect(listed[3]).toMatch(/^2\. deflate container gzip/u);
    const plain = runWith(TEXT, "identify", "-");
    expect(plain).toMatchObject({
      code: 1,
      stderr: `No format decompresses these ${TEXT.length} bytes.\n`,
    });
    expect(plain.stdout).toHaveLength(0);
    expect(runWith(TEXT, "identify", "--peel", "-")).toMatchObject({
      code: 1,
      stderr: "No confirmed layer.\n",
    });
  });

  it("hands the candidates and the peeled layers over as JSON", () => {
    const inner = runWith(TEXT, "compress", "deflate", "-", "--container", "gzip").stdout;
    const outer = runWith(inner, "compress", "lzma", "-", "--container", "xz").stdout;
    const ranked: unknown = JSON.parse(runWith(outer, "identify", "-", "--json").stdout.toString());
    expect(ranked).toMatchObject({
      candidates: [{ format: "lzma", container: "xz", confidence: 90, confirmed: true }],
    });
    const peeled: unknown = JSON.parse(
      runWith(outer, "identify", "-", "--peel", "--json").stdout.toString(),
    );
    expect(peeled).toMatchObject({
      candidates: [],
      layers: [{ container: "xz" }, { container: "gzip" }],
      data: Buffer.from(TEXT).toString("base64"),
    });
  });

  it("lists the formats and shows one", () => {
    const names = ["deflate", "bzip2", "lzma", "zstd", "brotli", "lz4", "lzw"];
    const heads = run("list")
      .stdout.toString()
      .split("\n")
      .filter((line) => /^\w/u.test(line));
    expect(heads.map((line) => line.split(":")[0])).toEqual(names);
    const lzma = run("list", "lzma").stdout.toString();
    expect(lzma).toContain(
      "  container xz: xz, The .xz File Format 1.2.1, .xz .txz, magic fd377a585a00",
    );
    expect(lzma).toContain(
      "  option check (none, crc32, crc64, sha256): What xz stores after the block to check it, default crc64, xz only",
    );
    const listed: unknown = JSON.parse(run("list", "lzw", "--json").stdout.toString());
    expect(listed).toMatchObject({ formats: [{ name: "lzw", compress: true }] });
  });

  it("turns library errors into one line on stderr and exit code 1", () => {
    expect(runWith("x", "decompress", "gzip", "-")).toMatchObject({
      code: 1,
      stderr: "gzip is a container, not a format: use deflate with container gzip\n",
    });
    expect(runWith("x", "compress", "deflate", "-", "--check", "crc64")).toMatchObject({
      code: 1,
      stderr: "Invalid option check=crc64: deflate takes container, level, name, mtime\n",
    });
    expect(runWith("x", "compress", "deflate", "-", "--level", "high")).toMatchObject({
      code: 1,
      stderr: "Invalid arguments at --level: must be integer\n",
    });
    expect(runWith("zz", "decompress", "deflate", "-", "--from", "hex")).toMatchObject({
      code: 1,
      stderr: 'Cannot read stdin as hex: hex: "z" (U+007A) at index 0 is not a hex digit\n',
    });
    expect(runWith("x", "compress", "zstd", "-")).toMatchObject({
      code: 1,
      stderr: "zstd: this package reads Zstandard but does not write it\n",
    });
    expect(run("decompress", "deflate", "/nonexistent/file.gz")).toMatchObject({ code: 1 });
    expect(run("decompress", "deflate", "/nonexistent/file.gz").stderr).toMatch(
      /^Cannot read \/nonexistent\/file\.gz: ENOENT/u,
    );
  });

  it("stops at a cut stream, and writes the start of it with --partial", () => {
    const packed = runWith(TEXT, "compress", "deflate", "-", "--container", "gzip").stdout;
    const cut = packed.subarray(0, packed.length - 20);
    expect(runWith(cut, "decompress", "deflate", "-", "--container", "gzip")).toMatchObject({
      code: 1,
      stderr: "deflate: unexpected end of data\n",
    });
    const partial = runWith(cut, "decompress", "deflate", "-", "--container", "gzip", "--partial");
    expect(partial.code).toBe(0);
    expect(partial.stderr).toBe("error: deflate: unexpected end of data\n");
    expect(TEXT.startsWith(partial.stdout.toString())).toBe(true);
  });

  it("takes a dashed word for a mistyped option, and for a file name after --", () => {
    const takes = "takes --container, --limit, --partial, --from, --to (-o)";
    expect(run("decompress", "deflate", "-x.gz")).toMatchObject({
      code: 1,
      stderr: `Invalid arguments: unknown option "-x.gz"; ${takes}\n`,
    });
    expect(run("decompress", "deflate", "--limt", "9", "x.gz")).toMatchObject({
      code: 1,
      stderr: `Invalid arguments: unknown option "--limt"; ${takes}\n`,
    });
    expect(run("decompress", "deflate", "--", "-x.gz").stderr).toMatch(/^Cannot read -x\.gz/u);
  });

  it("keeps --json off the commands that write bytes", () => {
    expect(runWith("x", "compress", "deflate", "-", "--json")).toMatchObject({ code: 1 });
    expect(runWith("x", "compress", "deflate", "-", "--json").stdout).toHaveLength(0);
  });

  it("writes details from the stream escaped, so they cannot drive the terminal", () => {
    const ESC = String.fromCodePoint(27);
    const packed = runWith(
      "x",
      "compress",
      "deflate",
      "-",
      "--container",
      "gzip",
      "--name",
      `a${ESC}]0;pwned${String.fromCodePoint(7)}`,
    ).stdout;
    const { code, stderr } = runWith(packed, "decompress", "deflate", "-", "--container", "gzip");
    expect(code).toBe(0);
    expect(stderr).not.toContain(ESC);
    expect(stderr).toContain(String.raw`name: "a\u001b]0;pwned\u0007"`);
  });
});

const root = fileURLToPath(new URL("..", import.meta.url));

/* Writes the module URLs the child loaded to `file` on exit; stderr cuts them at about 146 KB. */
function recordLoads(file: string) {
  return `data:text/javascript,${encodeURIComponent(`
  import { writeFileSync } from "node:fs";
  import { registerHooks } from "node:module";
  const loaded = [];
  registerHooks({
    load(url, context, nextLoad) {
      loaded.push(url);
      return nextLoad(url, context);
    },
  });
  process.on("exit", () => writeFileSync(${JSON.stringify(file)}, JSON.stringify(loaded)));
`)}`;
}

const initialize = `${JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "compressions-test", version: "1.0.0" },
  },
})}\n`;

/**
 * Runs `mcp` from a built bin, answers one initialize request and tells where the server came
 * from. stdin closes after the request, so the server exits on its own.
 * @param base - Package root the bin sits in.
 * @param extraEnv - Environment on top of the shared one.
 * @returns {{ code: number | null, from: string, name: string | undefined, stderr: string }} The
 * exit code, where the server came from, the server name from the reply and stderr.
 */
function serve(base: string, extraEnv: Readonly<Record<string, string>> = {}) {
  const record = mkdtempSync(join(tmpdir(), "compressions-loaded-"));
  const file = join(record, "loaded.json");
  let child;
  let loaded: unknown = [];
  try {
    child = spawnSync(
      process.execPath,
      ["--import", recordLoads(file), join(base, "dist/cli.mjs"), "mcp"],
      { encoding: "utf8", env: { ...env, ...extraEnv }, input: initialize, timeout: 20_000 },
    );
    if (existsSync(file)) loaded = JSON.parse(readFileSync(file, "utf8"));
  } finally {
    rmSync(record, { recursive: true, force: true });
  }
  const { status, stderr, stdout } = child;
  const urls = Array.isArray(loaded) ? loaded.filter((url) => typeof url === "string") : [];
  const source = urls.includes(pathToFileURL(join(base, "src/mcp.ts")).href);
  const bundle = urls.some((url) => url.endsWith("/@agntn/tools/dist/mcp.mjs"));
  let from: "bundle" | "source" | "unknown" = "unknown";
  if (source) from = "source";
  else if (bundle) from = "bundle";
  const name = /"serverInfo":\{"name":"([^"]+)"/.exec(stdout)?.[1];
  return { code: status, from, name, stderr };
}

/**
 * A run that answered the initialize request.
 * @param from - Where the server has to come from.
 * @returns {{ code: number, from: string, name: string }} The fields `serve` has to match.
 */
function served(from: "bundle" | "source") {
  return { code: 0, from, name: "compressions" };
}

describe.skipIf(!existsSync(join(root, "dist/cli.mjs")))(
  "compressions mcp from the built bin",
  () => {
    it("serves the live source inside a checkout", () => {
      expect(serve(root)).toMatchObject(served("source"));
    });

    it("keeps the bundle under COMPRESSIONS_DIST=1", () => {
      expect(serve(root, { COMPRESSIONS_DIST: "1" })).toMatchObject(served("bundle"));
    });

    it("keeps the bundle when the package sits under node_modules", () => {
      // Node refuses to strip types there, so a copy that ships `src` still takes the bundle.
      const cache = join(root, "node_modules/.cache");
      mkdirSync(cache, { recursive: true });
      const nested = mkdtempSync(join(cache, "compressions-cli-"));
      try {
        for (const entry of ["dist", "src", "package.json"]) {
          cpSync(join(root, entry), join(nested, entry), { recursive: true });
        }
        expect(serve(nested)).toMatchObject(served("bundle"));
      } finally {
        rmSync(nested, { recursive: true, force: true });
      }
    });

    it("keeps the bundle in a package that ships no src", () => {
      const packaged = mkdtempSync(join(tmpdir(), "compressions-cli-"));
      try {
        for (const entry of ["dist", "extensions", "package.json"]) {
          cpSync(join(root, entry), join(packaged, entry), { recursive: true });
        }
        symlinkSync(join(root, "node_modules"), join(packaged, "node_modules"), "dir");
        expect(serve(packaged)).toMatchObject(served("bundle"));
      } finally {
        rmSync(packaged, { recursive: true, force: true });
      }
    });
  },
);
