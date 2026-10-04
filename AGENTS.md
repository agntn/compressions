# AGENTS.md

Keep AGENTS.md updated with project status.

`@agntn/compressions` compresses, decompresses and identifies compressed data: deflate (raw, zlib, gzip), bzip2, LZMA (.lzma and xz), Zstandard, Brotli, LZ4 (frame and legacy) and Unix compress (.Z). A container is an option of its format, not a format of its own. zstd and brotli are read only. A library, the `compressions` CLI, an MCP server, Pi and OMP extensions and AI SDK tools. Docs at compressions.agntn.dev, from `docs/` (see `docs/AGENTS.md`).

## Domain

- Every codec is written here from its spec: RFC 1950, 1951 and 1952, the bzip2 1.0.8 sources as the format's only spec, the LZMA SDK's `lzma-specification.txt`, The .xz File Format 1.2.1, RFC 8878, RFC 7932, the LZ4 block and frame format docs and ncompress 5.0. No zlib binding, no WASM, no codec library, by design. The checksums come from `@agntn/hashes` (`./adler32`, `./crc`, `./sha2`, `./xxhash`), base64 and hex from `@agntn/encodings`, each from its subpath.
- The registry (`create`, `compress`, `decompress`, `formats`, `formatInfos`, `register`, `resolveFormat`) holds `Compression` objects that `defineCompression` builds from `info` and two functions. It checks options against `info().options` (choices, `min`/`max`, options scoped to `containers`, and on `decompress` only options marked `decode`), fills `container` with the first one, and returns `{ bytes, details }`.
- `UnknownFormatError` points a container name at its family: `gzip`, `zlib`, `xz` and friends say which format and container to use. `ALIASES` in `src/core/registry.ts` maps `bz2`, `zst`, `br`, `compress` and the like to their format.
- Decoding writes into `Output` (`src/core/bytes.ts`), which writes up to the caller's `limit` (default 256 MiB) and no further: a match, run or block that crosses it is cut there, so `LimitError.partial` holds exactly the first `limit` bytes. It starts at most at 64 MiB, and a size a stream claims never throws early. `out.fail()` builds a `DecompressError` that carries everything written so far; `partial: true` returns those bytes with `details.error` instead of throwing. A format writes only output it actually decoded: inflate checks for the end before it writes, LZMA2 decodes a cut chunk as far as it goes.
- Errors: `CompressionError` is the base. `DecompressError` (with `format`, `offset`, `partial`), `ChecksumError` (a checksum or a stored size), `LimitError`, `UnsupportedError` (a valid stream this package does not do: a zstd or LZ4 dictionary, a zlib preset dictionary, xz filters other than delta and x86, randomized bzip2 blocks), `UnknownFormatError`, `InvalidOptionError`. The CLI prints any `CompressionError` as one line with exit 1 and the MCP adapter turns it into a tool error.
- Writers: deflate is LZ77 with lazy matching, zlib's levels, and per block whichever of stored, fixed or dynamic is smallest. bzip2 sorts with prefix doubling and uses 2 to 6 Huffman tables. LZMA uses hash chains, rep matches and lazy parsing, LZMA2 chunks of at most 2 MiB unpacked and 64 KiB packed, one xz block. LZ4 writes 4 MiB independent blocks. LZW writes 10 to 16 bits and never sends a clear code; it reads 9 bits too, widened like gzip and ncompress.
- x86 BCJ mirrors `simple/x86.c` of xz 5.8. The brotli dictionary ships deflated and in base64 in `src/core/brotli-dictionary.ts` and inflates on first use; its CRC-32 is held to the RFC's in `test/codecs.test.ts`. `src/core/brotli-tables.ts` and `test/fixtures/zstd-tables.ts` come from the RFC text.
- `identify` tries every probe in `PROBES` (`src/core/identify.ts`) whose start fits: a magic number, a header that checks out (zlib, .lzma), or nothing for raw deflate and brotli, which count only when they decode to the last byte and give bytes back. It scores the evidence and marks a candidate `confirmed` for a magic number, or a checked header with a checksum or clean readable text. `peel` goes on while the best candidate is confirmed. `archiveOf` names ZIP, 7-Zip, RAR, tar, cabinet, lzip and PNG. A registered custom format has no probe, so `identify` never tries it.
- Tool limits live in `src/tool-contract.ts` and are checked twice, in the schema and in the executor: input up to 4,000,000 characters, output up to 64 MiB, 16 KiB shown by default and 1 MiB at most, 10 layers. A host with less memory passes tighter `ToolLimits` through `callTool()`, and the executors check those instead; the schemas keep the contract's. `CONTAINERS` and `CHECKS` repeat the option values so the schemas load without the codecs, and `test/mcp.test.ts` holds them to the registry. The executors pass a format only the options it takes for that direction and name the rest in the reply, since strict function calling fills every field.
- Test vectors: round trips through every container, `node:zlib` both ways for deflate, zstd and brotli, the installed CLIs when present, streams frozen in `test/fixtures/references.ts` (gzip 1.15, bzip2 1.0.8, XZ Utils 5.8.4, zstd 1.5.7, lz4 1.10.0, brotli 1.2.0, ncompress 1.0.2), broken and cut streams, limits, and the RFC tables. A new format gets the same: a frozen outside reference and its spec's tables.
- `test/docs.test.ts` holds the docs to the library: the read only samples on the landing, the run-length file on the landing and in the custom guide, and the vectors quoted in `docs/content/`.
- `test/bundle.test.ts` bundles every format subpath with rolldown and fails when one pulls in another format or the registry. `test/index.test.ts` loads the library with `node:` imports blocked, as a browser would.

## Status

- Node.js 26 is the minimum and the only version CI tests and releases on.
- Not published yet. The first release goes through `pnpm release` and the Publish workflow with GitHub Actions OIDC trusted publishing, without a long-lived registry token.
- A failed Publish run is recovered with `gh workflow run publish.yml --ref main -f tag=vX.Y.Z`, not a rerun, as in the sibling packages. `test/release.test.ts` pins that ref.
- Each tool is declared once in `src/tools.ts` with `defineTool` from `@agntn/tools`, and the MCP server, both extensions and `src/ai.ts` take that list through its adapters. `toolListings` and `callTool()` in `src/mcp.ts` also run the remote server at `compressions.agntn.dev/mcp`, where a new tool needs a file in `docs/server/mcp/tools/` (see `docs/AGENTS.md`). Schemas take `Type` from `@agntn/tools`, never from `typebox`.
- A tool executor throws when it can't answer. The MCP adapter turns the throw into a sanitized `isError` result.
- A local MCP server needs a restart, not `pnpm build`: inside a checkout `dist/cli.mjs` loads the `mcp` command from `src/` (see Conventions).
- The CLI never writes raw compressed bytes to a terminal. Decompressed bytes go to stdout, what the stream says about itself to stderr.
- `pnpm release` and the Publish workflow build before `pnpm test`, as CI does.
- Linting and formatting consume the shared `@agntn/ox` policy. The allow list of `prefer-readonly-parameter-types` in `vite.config.ts` names the classes that are mutated by design (readers, writers, `Output`, the coders).
- `pnpm-workspace.yaml` exempts `@agntn/*` from `minimumReleaseAge`.

## Stack

- **Runtime**: Node.js >= 26
- **Language**: TypeScript (strict)
- **Toolchain**: Vite+ (`vp`), one `vite.config.ts` for test, lint and fmt
- **Build**: obuild from `build.config.ts`, one bundle for every entry and format subpath, chunks under `dist/_chunks/`
- **Test**: `vp test` (bundled Vitest, API from `vite-plus/test`)
- **Lint**: `vp lint` + `vp fmt` (Oxlint + Oxfmt) through `@agntn/ox`
- **Typecheck**: tsc (native TypeScript 7)
- **Release**: changelogen
- **Package manager**: pnpm

## Scripts

- `pnpm dev` - `obuild --stub`, so `dist` re-exports `src`
- `pnpm build` - production build
- `pnpm test` - run tests once
- `pnpm test:watch` - run tests in watch mode
- `pnpm lint` - build, lint + format check
- `pnpm fmt` - auto-fix lint + format
- `pnpm typecheck` - type checking of src, the extensions and the tests
- `pnpm release` - build, test against that build, and release, in CI's order

## Structure

```
src/core/                - codecs, registry, identify, errors, types, Output
src/<format>.ts          - one subpath per format: deflate, bzip2, lzma, zstd, brotli, lz4, lzw
src/tools.ts             - the tool definitions; tool-operations.ts runs them, tool-contract.ts holds the limits
src/commands/            - compress, decompress, identify, list, mcp
docs/                    - Docus site for compressions.agntn.dev
test/                    - tests
test/fixtures/           - Pi and OMP extension test hosts, frozen streams of other implementations, RFC 8878 tables
packages/omp/extensions/ - OMP extension sources shipped with the package
packages/pi/extensions/  - Pi extension sources shipped with the package
dist/                    - build output (generated)
```

## Conventions

- ESM only (`"type": "module"`)
- Exports use `.d.mts` / `.mjs` extensions
- Strict TypeScript (all strict checks enabled)
- No `as any`, `@ts-ignore`, or `@ts-expect-error`
- Nothing under `src/` outside `src/cli.ts` and `src/commands/` imports `node:*`
- Local MCP from source: `src/cli.ts` imports the `mcp` command from a runtime URL of `src/commands/mcp.ts` when the bin is built, `COMPRESSIONS_DIST` is not `1`, the path has no `node_modules` segment and the file exists. Otherwise it takes the bundled command. Relative imports end in `.ts` and `erasableSyntaxOnly` holds, or plain Node cannot run `src/`.
- Pull requests and issues use short, freeform descriptions focused on why a change is needed or what went wrong.
