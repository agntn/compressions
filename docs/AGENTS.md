# docs/

Docus site for `@agntn/compressions` at compressions.agntn.dev. Markdown lives in `content/`. The playground is a Vue page that imports the library into the browser. The one route that answers at request time is `/mcp`, the Docus MCP server with every tool of `compressions mcp` beside its own `list-pages` and `get-page`.

## Layout

```
docs/
├── DESIGN.md                      # the instruments this site owns and where it departs from the agntn design system
├── nuxt.config.ts                 # extends: ['docus'], cloudflare_module preset (Workers), @agntn/compressions, its /mcp and #tool-operations aliased to ../src
├── shiki-theme.ts                 # code block theme, every colour a --shiki-token-* variable from app.css
├── app/app.config.ts              # title, github, theme, the Nuxt UI variants in the instrument grammar
├── app/app.css                    # theme tokens, the shared `console-*` and `hero-*` grammar, `compressions-*` classes
├── app/components/                # Docus overrides: header, tabs, sidebar, table of contents, page links, surround, callout
├── app/components/content/        # MDC components (`::landing-home`, `::format-facts`, `::format-roster`), the landing instruments, Prose* overrides, CompressionsPlayground
├── app/components/OgImage/        # Docs.takumi and Landing.takumi override the Docus OG templates
├── app/assets/fonts.css           # @font-face for the TTFs served from public/fonts (site and OG images)
├── app/composables/               # useLandingSample (one clock for every live panel), useSubNavigation, useCopied, useRosterFlip
├── app/utils/                     # formats table (icons, blurbs, groups, containers, sample streams, anatomy, ratio over the library's info()), tools (the agent tools' text), tokens, roster, formatting
├── app/pages/playground.vue       # playground, own route outside the docs layout, its own useSeo and OG image
├── server/routes/sitemap.xml.ts   # Docus sitemap plus the Vue pages it cannot see
├── server/mcp/index.ts            # the Docus MCP handler at /mcp, named and versioned like `compressions mcp`
├── server/mcp/tools/              # one file per tool, each `compressionsMcpTool("<name>")`
├── server/utils/compressions-mcp.ts # a tool from `@agntn/compressions/mcp` with the worker's limits
├── public/                        # fonts, favicon.svg and the icons and manifest cut from it
├── content/index.md               # landing
├── content/1.guide/               # getting started, compressing, containers, checksums, identify, limits, CLI, agents, custom, playground
└── content/2.formats/             # overview, one page per format in listing order
```

## Commands

```bash
pnpm install          # from docs/, the repo root needs no install or build first
pnpm dev              # http://localhost:3000
pnpm build            # Cloudflare Workers output in .output/, content routes prerendered
pnpm deploy           # build, then wrangler deploy to compressions.agntn.dev
```

Deployment: Workers Builds with root directory `docs`. It installs `docs/` and nothing else, and that's enough, because the library comes from `../src` (next paragraph). Nitro preset `cloudflare_module`. Nuxt Content wants a D1 binding named `DB`. `wrangler.jsonc` carries it plus the `NUXT_SITE_URL` var. The database `agntn-compressions` lives in the EU jurisdiction, which is set at creation; the binding names it by id alone. Pull request previews get their own database, `agntn-compressions-preview`, also EU, through the `previews` block, so a preview build never writes to production. No KV binding. Nothing is fetched, so nothing is cached.

`@agntn/compressions` is an alias in `nuxt.config.ts` for `../src/index.ts`, and `#tool-operations` for `../src/tool-operations.ts`. Vite bundles the checkout's sources for the browser and Nitro gets the same alias for the prerender, so `dist/` and the root `node_modules` are never touched. Nothing under `src/` imports `node:*`. Two npm packages do sit in that graph: `@agntn/hashes` (`adler32`, `crc`, `sha2`, `xxhash`) for the checks the containers carry, and `@agntn/encodings` (`base64`, `hex`) for the brotli dictionary and the tool text. That's why `docs/package.json` pins both to the root's versions and `nuxt.config.ts` lists them in `vite.resolve.dedupe` and their subpaths in `vite.optimizeDeps.include`. Vite resolves a bare import in `../src` from the repo root upward, never from `docs/node_modules`. A new npm import under `src/` needs the same three entries or it breaks the deploy. Bump the pins together with the root's.

The root `.node-version` is the only place Workers Builds takes Node.js 26 from. Its build image reads `NODE_VERSION`, `.nvmrc` or `.node-version`, never `engines` in `package.json`, and falls back to Node.js 24 without them (Cloudflare build image docs; build `fac3512a` ran on 24.18.0 the one time the file was gone). Keep it.

`pnpm-workspace.yaml` exempts `@agntn/*` from `minimumReleaseAge`, since a clean frozen install rejects a sibling released less than a day ago.

Two resolution traps, both because the repo root is its own pnpm workspace:

- `pnpm-workspace.yaml` sets `shamefullyHoist: true`. Without it `docs/node_modules` holds only direct dependencies, Node walks up to the root `node_modules`, and the server bundle can end up with a second copy of Vue.
- `nuxt.config.ts` pins `workspaceDir` to `docs/`, disables devtools and telemetry, and adds `../src` to `vite.server.fs.allow`, since `pnpm dev` couldn't load the library otherwise.

## MCP

`@agntn/compressions/mcp` is a third alias, for `../src/mcp.ts`. A file in `server/mcp/tools/` names one tool and nothing else: `compressionsMcpTool()` takes the name, prose, schema and annotations from `toolListings` and runs `callTool()` from there, so a tool changed in `src/` changes here without an edit. A new tool in `src/tools.ts` needs one more file here, and `test/docs-mcp.test.ts` fails until it has one.

`@nuxtjs/mcp-toolkit` wants Zod and validates with it before the handler runs. A Zod error echoes the client's keys as they came and reads differently from `compressions mcp`. So the Zod schema is `z.looseObject({})`, which passes any object, and its `_zod.toJSONSchema` hook returns the wire schema from `toolListings`, so `tools/list` still shows the real one. `callTool` then checks the arguments the way stdio does. The one difference: a call with no `arguments` at all fails Zod's object check, where stdio reads it as `{}`.

`WORKER_LIMITS` in `server/utils/compressions-mcp.ts` holds a call to 262,144 input characters, 4 MiB of output and 256 KiB shown. An isolate gets 128 MB. Under Node at the contract's 64 MiB, a gzip bomb took 135 MB on top of the baseline, `identify` 200 MB and a two layer `peel` 305 MB, and 2.9 MB of random bytes compressed to base64 ran out of a 128 MB V8 heap: `radix2` in `@agntn/encodings` builds its string one character at a time. At the worker's limits a ten layer `peel` of 4 MiB layers holds 40 MB of buffers and the heap stays under 48 MB. Raise a limit only after the same measurement. The tool descriptions keep saying 64 MiB; the error names the limit that hit.

`src/mcp.ts` imports `@agntn/tools` and `@modelcontextprotocol/server`. Both are dependencies here, pinned to the root's versions and listed in `vite.resolve.dedupe`. They run on the worker only, so they stay out of `optimizeDeps`. On the `cloudflare_module` preset the toolkit hands its server to `createMcpHandler` from `agents`, which tells an SDK v1 server apart with `instanceof`. pnpm installs one copy of `@modelcontextprotocol/sdk` per `zod` peer it resolves, so the toolkit and `agents` can each get their own and every request fails with "createMcpHandler received an unsupported server". `nitro.alias` points every import of the SDK at the copy in `docs/node_modules`. Keep it until both resolve the same one; `.output/server` should hold one `class McpServer`.

The worker decompresses whatever an MCP client sends it and keeps none of it. Workers Logs record the invocation, not the body; keep it that way, no `console` call with tool arguments. The pages still compute everything in the tab, which is what the footer promises.

## Live values

- Every value on the landing, in the roster and on the format pages comes from the library at render time. `FORMATS` in `app/utils/formats.ts` maps the built-in names through `create(name).info()`, and `VARIANTS` lists every format with each of its containers. A format added to the library needs one line in `BUILTINS`, `PRESENTATION` and `GROUP_OF`; the types require all three, and dev warns when `BUILTINS` drifts from `formats()`.
- `useLandingSample` compresses `SAMPLE_INPUT`, `hello world!` four times, through every container for the stream panel, the round trip file, the identify console and the tool call. Four times, so every LZ77 format finds a match and the stream comes out shorter than the text.
- zstd and brotli are read only. Their samples are `READ_ONLY_SAMPLES`, streams `zstd` 1.5.7 and `brotli` 1.2.0 wrote for `SAMPLE_INPUT`; `test/docs.test.ts` holds them to it. A new sample goes through the same test.
- `anatomy()` splits a stream into magic, header, data and check bytes from the container's layout, for the stream panel's colours. `ratio()` compresses a fixed text of a few lines at each writer's defaults for the roster.
- Every text a tool would hand a model, in the `03 Full tool response` rows and the playground, comes from `src/tool-operations.ts` through the `#tool-operations` alias. The page runs the executors the MCP server runs, not a copy. `src/tool-operations.ts` re-exports `INPUT_FORMATS`, `OUTPUT_FORMATS` and the limits for the playground.
- Counts in prose (the headline, the OG image, the SEO description, the playground) come from `FORMATS.length`, `VARIANTS.length`, `WRITER_COUNT`, `CHECKSUM_COUNT` and `GROUPS` through `spellOut`. Frontmatter and `content/` can't call a function, so they never state a count. `::format-roster` goes where a list would.
- The samples are deterministic, so SSR and the client agree and hydration doesn't flicker. Keep it that way. No `Math.random`, no clock inside a computed.
- `CompressionsPlayground.vue` reads the deep link through a `watch(route.query)` registered in `onMounted` that fires once. A prerendered page hydrates with an empty `route.query` and Nuxt restores the address only afterwards. It writes state back with `router.replace` on every change and runs a call 250 ms after the form stops changing.
- The playground catches `CompressionError` and shows the class name and the message. Anything else is a bug in the library and belongs there, not in a try/catch here.
- The run-length file on the landing (`LandingCustom.vue`) and in `content/1.guide/09.custom.md` is a literal. `test/docs.test.ts` runs it against the library and checks its comments; touch one, touch both.

## SEO

- `seo.schema` in `app/app.config.ts` emits the landing JSON-LD: `WebSite`, the agntn `Organization` as publisher, and a free `SoftwareApplication` with `sameAs` on GitHub and npm.
- `server/routes/sitemap.xml.ts` wraps the Docus sitemap and appends the Vue pages listed in `PAGES`; a new page under `app/pages/` goes there too.
- `public/favicon.svg` is the source, the PNGs and the `.ico` are cut from it with ImageMagick.

## OG images

- `app/components/OgImage/Docs.takumi.vue` and `Landing.takumi.vue` override the Docus templates and are rendered by Takumi at build time. Takumi has no CSS variables, so the theme colours are repeated there as literals. A format page's card is built from its `info()`, not from the description.
- `app/assets/fonts.css` declares the Figtree and Fira Code TTFs in `public/fonts`, which is where nuxt-og-image reads them.
- Descriptions go without commas and without a trailing period: Docus puts them in the OG file name, where a comma is a separator and `..png` is skipped without a word. A `: ` in a frontmatter description is a YAML mapping and the page vanishes from the prerender.

## Constraints

- Text a visitor types into the playground is rendered as text, through interpolation or a `<pre>`. Never `v-html`, never evaluate.
- The sidebar takes a guide page's icon from `NAV_ICONS` in `app/composables/useSubNavigation.ts`, not from its frontmatter, so a new page goes there too.
- Every vector quoted in `content/` came out of the library in `src/`. Check a new one the same way, and against an outside reference where one exists.
- No bold run at the start of a list item in `content/`. With remark-mdc 3.11.1 and mdast-util-to-markdown 2.1.3 the `/llms-full.txt` serializer recursed until the stack ran out on `- **A matching checksum.** …` in the identify guide, and the prerender logged a 500 for that file while every page rendered fine. Check `curl -s -o /dev/null -w '%{http_code}' localhost:<port>/llms-full.txt` after adding emphasis to a list.
- The site makes no network request for its own work and stays that way. The footer says so.
