import { globSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const docsDir = fileURLToPath(new URL("../docs/", import.meta.url));

/** Import statements start a line, so a snippet quoting `from "nuxt"` in a string never counts. */
const SPECIFIER =
  /^\s*(?:import|export|\})\b[^"'\n]*?\bfrom\s*["']([@a-z][^"'\s]*)["']|^\s*import\s*["']([@a-z][^"'\s]*)["']|\bimport\s*\(\s*["']([@a-z][^"'\s]*)["']/gmu;

/**
 * The package a bare specifier names, without its subpath.
 *
 * @param specifier - What the import statement quotes.
 * @returns {string} `@scope/name` or `name`.
 */
function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

/**
 * Every package the site's own sources import.
 *
 * @returns {Set<string>} Package names, without `node:` builtins and the library alias.
 */
function importedPackages(): Set<string> {
  const files = globSync(["app/**/*.{ts,vue}", "server/**/*.ts", "*.ts"], { cwd: docsDir });
  const names = new Set<string>();
  for (const file of files) {
    for (const match of readFileSync(`${docsDir}${file}`, "utf8").matchAll(SPECIFIER)) {
      const name = packageName(match[1] ?? match[2] ?? match[3] ?? "");
      if (!name.startsWith("node:") && name !== "@agntn/compressions") names.add(name);
    }
  }
  return names;
}

describe("docs dependencies", () => {
  it("declares every package the site imports, since the workspace hoists nothing", () => {
    const manifest = JSON.parse(readFileSync(`${docsDir}package.json`, "utf8")) as {
      readonly dependencies?: Readonly<Record<string, string>>;
      readonly devDependencies?: Readonly<Record<string, string>>;
    };
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ]);
    const imported = importedPackages();
    expect(imported).toContain("nuxt");
    expect([...imported].filter((name) => !declared.has(name))).toEqual([]);
  });
});

const srcDir = new URL("../src/", import.meta.url);

/** One import or re-export, `type` marking one the compiler erases. */
const IMPORT = /^(?:import|export)(\s+type)?\s[\w\s{},*$]*?\bfrom\s*"([^"]+)"/gmu;

/**
 * The packages a source graph imports at run time, walked from its roots through relative imports.
 *
 * @param roots - Entry files, relative to `src/`.
 * @returns {Set<string>} Every bare specifier reached, subpath included.
 */
function runtimeImports(roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const found = new Set<string>();
  const queue = roots.map((root) => new URL(root, srcDir).href);
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, erased, specifier = ""] of readFileSync(new URL(file), "utf8").matchAll(IMPORT)) {
      if (erased !== undefined) continue;
      if (specifier.startsWith(".")) queue.push(new URL(specifier, file).href);
      else found.add(specifier);
    }
  }
  return found;
}

/**
 * The string literals of the array `docs/nuxt.config.ts` writes right after a key.
 *
 * @param key - The key, colon included.
 * @returns {string[]} The literals.
 */
function nuxtList(key: string): string[] {
  const config = readFileSync(`${docsDir}nuxt.config.ts`, "utf8");
  const start = config.indexOf(key);
  const list = start === -1 ? "" : config.slice(start, config.indexOf("]", start));
  return [...list.matchAll(/"([^"]+)"/gu)].map((match) => match[1] ?? "");
}

describe("the source the site bundles from ../src", () => {
  const manifest = JSON.parse(readFileSync(`${docsDir}package.json`, "utf8")) as {
    readonly dependencies?: Readonly<Record<string, string>>;
  };
  const declared = Object.keys(manifest.dependencies ?? {});
  const dedupe = nuxtList("dedupe:");

  it("finds what the browser imports declared, deduped and prebundled, or the deploy breaks", () => {
    const browser = runtimeImports(["index.ts", "tool-operations.ts"]);
    expect(browser).toContain("@agntn/hashes/crc");
    const include = nuxtList("include:");
    const missing = [...browser].filter(
      (specifier) =>
        !include.includes(specifier) ||
        !dedupe.includes(packageName(specifier)) ||
        !declared.includes(packageName(specifier)),
    );
    expect(missing).toEqual([]);
  });

  it("finds what the worker's MCP server imports declared and deduped", () => {
    const worker = runtimeImports(["mcp.ts", "server-info.ts"]);
    expect(worker).toContain("@agntn/tools");
    const missing = [...worker].filter(
      (specifier) =>
        !dedupe.includes(packageName(specifier)) || !declared.includes(packageName(specifier)),
    );
    expect(missing).toEqual([]);
  });

  it("imports node: builtins only in the CLI, which the site never loads", () => {
    const files = readdirSync(srcDir, { recursive: true, encoding: "utf8" }).filter((file) =>
      file.endsWith(".ts"),
    );
    const users = files.filter((file) =>
      /\bfrom\s*"node:|import\(\s*"node:/u.test(readFileSync(new URL(file, srcDir), "utf8")),
    );
    expect(users.sort()).toEqual(["cli-operations.ts", "cli.ts"]);
  });

  it("builds on the Node.js major engines asks for, which Workers Builds reads from .node-version", () => {
    const root = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      readonly engines: { readonly node: string };
    };
    const pinned = readFileSync(new URL("../.node-version", import.meta.url), "utf8");
    expect(/^v?(\d+)\./u.exec(pinned)?.[1]).toBe(/(\d+)/u.exec(root.engines.node)?.[1]);
  });
});
