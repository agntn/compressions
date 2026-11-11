import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const docs = new URL("../docs/", import.meta.url);

const read = (path: string): string => readFileSync(new URL(path, docs), "utf8");

/**
 * Every file under a docs directory whose name ends in one of the extensions.
 *
 * @param directory - The directory, relative to `docs/`, with a trailing slash.
 * @param extensions - The endings to keep.
 * @returns {string[]} Paths relative to `docs/`.
 */
function filesIn(directory: string, extensions: readonly string[]): string[] {
  return readdirSync(new URL(directory, docs), { recursive: true, encoding: "utf8" })
    .filter((file) => extensions.some((extension) => file.endsWith(extension)))
    .map((file) => `${directory}${file}`)
    .sort();
}

/**
 * The string literals of the array a docs file writes right after a marker.
 *
 * @param path - The file, relative to `docs/`.
 * @param marker - The text just before the array.
 * @returns {string[]} The literals, in source order.
 */
function literalsAfter(path: string, marker: string): string[] {
  const source = read(path);
  const start = source.indexOf(marker);
  const list = start === -1 ? "" : source.slice(start, source.indexOf("]", start));
  return [...list.matchAll(/"([^"]+)"/gu)].map((match) => match[1] ?? "");
}

const routes = readdirSync(new URL("app/pages/", docs))
  .filter((file) => file.endsWith(".vue"))
  .map((file) => `/${file.slice(0, -".vue".length)}`)
  .sort();

const pages = filesIn("content/", [".md"]);

describe("the site's Vue pages", () => {
  it("hands every one to the sitemap, which reads only content/", () => {
    expect(routes).toContain("/playground");
    expect(literalsAfter("server/api/__sitemap__/pages.ts", "const PAGES =").sort()).toEqual(
      routes,
    );
  });

  it("keeps every one out of agent discovery, where its markdown twin would 404", () => {
    expect(literalsAfter("nuxt.config.ts", "excludePrefixes:").sort()).toEqual(routes);
  });

  it("links every one from a section of llms.txt", () => {
    const config = read("nuxt.config.ts");
    const linked = (route: string): boolean =>
      config.includes(`href: "https://compressions.agntn.dev${route}"`);
    expect(routes.filter((route) => !linked(route))).toEqual([]);
  });
});

describe("the site's components", () => {
  const sources = filesIn("app/", [".ts", ".vue"]);

  it("draw nothing from Math.random, so the server and the browser render one page", () => {
    expect(sources.filter((file) => read(file).includes("Math.random"))).toEqual([]);
  });

  it("render what a visitor types as text, never through v-html", () => {
    expect(sources.filter((file) => read(file).includes("v-html"))).toEqual([]);
  });

  it("give every guide page a sidebar icon, since the frontmatter one is ignored", () => {
    const icons = read("app/composables/useSubNavigation.ts");
    const paths = pages
      .filter((file) => file.startsWith("content/1.guide/"))
      .map((file) => file.replace(/^content\/1\.guide\/\d+\.(.+)\.md$/u, "/guide/$1"))
      .map((path) => (path === "/guide/index" ? "/guide" : path));
    expect(paths.filter((path) => !icons.includes(`"${path}":`))).toEqual([]);
  });
});

describe("the worker", () => {
  it("logs nothing, so a tool argument never lands in Workers Logs", () => {
    const sources = filesIn("server/", [".ts"]);
    expect(sources).toContain("server/mcp/index.ts");
    expect(sources.filter((file) => /\bconsole\./u.test(read(file)))).toEqual([]);
  });
});

describe("the content pages", () => {
  it("keep ': ' out of a description, which YAML reads as a mapping and drops the page", () => {
    const broken = pages.filter((file) =>
      /^description:\s*[^\s"'].*:\s/mu.test(/^---\n([\s\S]*?)\n---/u.exec(read(file))?.[1] ?? ""),
    );
    expect(broken).toEqual([]);
  });

  it("state no count, which only the components read live from the library", () => {
    const count =
      /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+) (?:formats|containers|writers|checksums|variants|groups)\b/iu;
    expect(pages.filter((file) => count.test(read(file)))).toEqual([]);
  });

  it("start no list item with bold, which crashes the /llms-full.txt serializer", () => {
    expect(pages.filter((file) => /^\s*[-*+] \*\*/mu.test(read(file)))).toEqual([]);
  });
});
