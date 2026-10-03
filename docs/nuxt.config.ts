import { resolve } from "node:path";
import { compressionsTheme } from "./shiki-theme";

/** Bundled from the checkout's sources: a deploy needs neither dist/ nor the root node_modules. */
const librarySource = resolve(import.meta.dirname, "../src");

export default defineNuxtConfig({
  extends: ["docus"],
  /** The repo root is its own pnpm workspace; Nuxt must not treat it as this site's. */
  workspaceDir: import.meta.dirname,
  alias: {
    "@agntn/compressions": resolve(librarySource, "index.ts"),
    /** The text the agent tools answer with; it imports nothing beyond the library. */
    "#tool-operations": resolve(librarySource, "tool-operations.ts"),
  },
  vite: {
    build: { target: "es2024" },
    resolve: {
      /** `../src` imports them; Vite would look for them from the repo root upward. */
      dedupe: ["@agntn/hashes", "@agntn/encodings"],
    },
    optimizeDeps: {
      include: [
        "@agntn/hashes/adler32",
        "@agntn/hashes/crc",
        "@agntn/hashes/sha2",
        "@agntn/hashes/xxhash",
        "@agntn/encodings/base64",
        "@agntn/encodings/hex",
      ],
    },
    server: {
      /** Dev serves the library from outside the workspace, which Vite refuses without this. */
      fs: { allow: [resolve(librarySource, "..")] },
    },
  },
  devtools: { enabled: false },
  telemetry: false,
  site: {
    url: "https://compressions.agntn.dev",
    name: "@agntn/compressions",
  },
  llms: {
    domain: "https://compressions.agntn.dev",
    title: "@agntn/compressions",
    description:
      "Compress, decompress and identify gzip, zlib, raw deflate, bzip2, xz, .lzma, zstd, brotli, lz4 and Unix compress, written from the specs, as a library, a CLI, an MCP server and Pi and OMP extensions. Computed locally.",
    sections: [
      {
        title: "Playground",
        description: "Compress, decompress, identify and list the formats, in the browser.",
        links: [
          {
            title: "Playground",
            href: "https://compressions.agntn.dev/playground",
            description: "The library running in the page: compressions_compress, compressions_decompress, compressions_identify and compressions_info.",
          },
        ],
      },
    ],
  },
  /** Docus pages define their own OG images; the alt text is the one thing they leave unset. */
  ogImage: {
    defaults: {
      alt: "@agntn/compressions: compress, decompress and identify, computed locally",
    },
  },
  icon: {
    clientBundle: {
      icons: [
        "lucide:archive",
        "lucide:arrow-down",
        "lucide:arrow-left",
        "lucide:arrow-right",
        "lucide:arrow-right-left",
        "lucide:arrow-up",
        "lucide:arrow-up-right",
        "lucide:book-a",
        "lucide:book-open",
        "lucide:bot",
        "lucide:check",
        "lucide:check-circle",
        "lucide:chevron-down",
        "lucide:chevron-left",
        "lucide:chevron-right",
        "lucide:chevrons-up-down",
        "lucide:circle-alert",
        "lucide:circle-check",
        "lucide:circle-x",
        "lucide:copy",
        "lucide:expand",
        "lucide:external-link",
        "lucide:file-archive",
        "lucide:flask-conical",
        "lucide:gauge",
        "lucide:globe",
        "lucide:layers",
        "lucide:library",
        "lucide:link",
        "lucide:package",
        "lucide:plus",
        "lucide:puzzle",
        "lucide:rotate-ccw",
        "lucide:scale",
        "lucide:scan-search",
        "lucide:shield-alert",
        "lucide:shield-check",
        "lucide:shuffle",
        "lucide:terminal",
        "lucide:text",
        "lucide:x",
        "lucide:zap",
        "simple-icons:github",
        "simple-icons:npm",
        "vscode-icons:file-type-js",
        "vscode-icons:file-type-json",
        "vscode-icons:file-type-shell",
        "vscode-icons:file-type-typescript",
      ],
    },
  },
  colorMode: {
    preference: "dark",
  },
  app: {
    head: {
      link: [
        { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
        { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon.png" },
        { rel: "manifest", href: "/site.webmanifest" },
      ],
      meta: [
        { name: "theme-color", media: "(prefers-color-scheme: dark)", content: "#0b0d10" },
        { name: "theme-color", media: "(prefers-color-scheme: light)", content: "#eef1f4" },
        { name: "apple-mobile-web-app-title", content: "compressions" },
        { name: "author", content: "oritwoen" },
        { property: "og:locale", content: "en_US" },
      ],
    },
  },
  /** Docus ships an MCP endpoint that wants the Cloudflare Agents SDK on Workers. Not needed. */
  mcp: {
    enabled: false,
  },
  nitro: {
    preset: "cloudflare_module",
    compatibilityDate: "2026-09-03",
    /** Nitro compiles the server bundle for ES2019 unless told otherwise; the library uses BigInt. */
    esbuild: { options: { target: "es2024" } },
    prerender: {
      crawlLinks: true,
      routes: ["/", "/playground", "/sitemap.xml", "/robots.txt", "/llms.txt", "/llms-full.txt"],
    },
    cloudflare: {
      deployConfig: true,
      nodeCompat: true,
    },
  },
  compatibilityDate: "2026-09-03",
  /** Fonts live in public/fonts and app/assets/fonts.css, where nuxt-og-image reads them from. */
  css: ["~/assets/fonts.css"],
  fonts: {
    families: [
      { name: "Figtree", provider: "local", weights: [400, 500] },
      { name: "Fira Code", provider: "local", weights: [400, 500] },
    ],
  },
  content: {
    database: {
      type: "d1",
      bindingName: "DB",
    },
    build: {
      markdown: {
        highlight: {
          theme: {
            default: compressionsTheme,
            light: compressionsTheme,
            dark: compressionsTheme,
          },
        },
      },
    },
  },
});
