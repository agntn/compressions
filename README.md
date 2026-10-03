# @agntn/compressions

[![npm version](https://npmx.dev/api/registry/badge/version/@agntn/compressions)](https://npmx.dev/package/@agntn/compressions)
[![npm downloads](https://npmx.dev/api/registry/badge/downloads/@agntn/compressions)](https://npmx.dev/package/@agntn/compressions)
[![license](https://npmx.dev/api/registry/badge/license/@agntn/compressions)](https://npmx.dev/package/@agntn/compressions)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/agntn/compressions)

🗜️ gzip, zlib, bzip2, xz, zstd, brotli, lz4 and good old `.Z`, written from the specs. Got a blob nobody labeled? It names the format, checks the checksum and opens it. From a shell, from code, from an agent.

> [!CAUTION]
> **Not audited.** This code has never had a security audit. Do not use it in production, with real funds or with sensitive data. It is meant for agents, puzzles and local experiments only. It comes as is, without warranty of any kind, and the authors are not liable for any loss, as the MIT license states. Anything that matters wants an audited library.

## Why?

A puzzle hands you 196 bytes that start with `42 5a 68`. You ask a model. It says gzip, probably. It's bzip2. And inside the bzip2 there's an xz, and inside that a gzip. Guessing is the model's job. Opening is this package's.

Everything is on [compressions.agntn.dev](https://compressions.agntn.dev), playground included.

## ✨ Features

- 🗜️ **Seven formats, eleven containers.** deflate as raw, zlib or gzip. bzip2. LZMA as `.lzma` or xz. zstd, brotli, LZ4 frame and legacy, Unix compress.
- 🧾 **Written from the specs.** RFC 1950 to 1952, 7932, 8878, the xz and LZ4 format docs. No zlib binding, no WASM.
- ✍️ **Writes five of them.** zstd and brotli only read. Their own CLIs write them better anyway.
- ✅ **Every checksum checked.** CRC-32, CRC-64, Adler-32, XXH32, XXH64, SHA-256. A wrong one is an error, not a warning.
- 🔍 **`identify` and `peel`.** Every container gets a real try. You get a ranking with reasons. Three layers deep? `peel` takes them off.
- 🩹 **Partial reads.** A stream cut in half still gives you the first half.
- 💣 **Bomb proof.** Output stops at a limit you set, 256 MiB by default.
- 🤖 **Agent tools.** Four of them. MCP, Pi, OMP or the AI SDK, pick your host.
- 🌐 **Runs anywhere.** Zero `node:*` imports in the library. Browsers, Workers, Node, all fine.

## 📦 Install

```bash
pnpm add @agntn/compressions
```

Node.js 26 or newer.

## 🚀 First call

```bash
npx @agntn/compressions identify mystery.bin --peel
```

```
 90 bzip2 --container bzip2  starts with its magic number; checksum matches; decodes to the last byte  124 bytes
 90 lzma --container xz  starts with its magic number; checksum matches; decodes to the last byte  65 bytes
100 deflate --container gzip  starts with its magic number; checksum matches; decodes to the last byte; decompresses to readable text  "meet me at the old lighthouse at midnight\n"
meet me at the old lighthouse at midnight
```

Three layers, outermost first, on stderr. The note itself goes to stdout. From here on it's just `compressions`. That's `pnpm exec compressions` in a project, or install it globally with `pnpm add -g @agntn/compressions`.

What if somebody flipped a bit?

```bash
compressions decompress deflate bad.gz --container gzip
```

```
deflate: gzip CRC-32 does not match at byte 57
```

Exit code 1. Want the bytes anyway? Add `--partial`. No key, no config, no network.

### Commands

| Command                                   | Does                                                |
| ----------------------------------------- | --------------------------------------------------- |
| `compressions compress <format> <file>`   | Compress a file or stdin                            |
| `compressions decompress <format> <file>` | Decompress it, what the stream says goes to stderr  |
| `compressions identify <file>`            | Rank the formats it opens in, or `--peel` them off  |
| `compressions list [format]`              | All of them, or one with its containers and options |
| `compressions mcp`                        | MCP server over stdio                               |

`-` reads stdin. `--from hex` and `--to base64` for when bytes travel as text. Compressed bytes never go to a terminal raw. Every flag for every format is in the [CLI guide](https://compressions.agntn.dev/guide/cli).

## 🧠 Library

```ts
import { compress, decompress, identify } from "@agntn/compressions";

const gz = compress("deflate", "hello world!", { container: "gzip" }); // 32 bytes
decompress("deflate", gz, { container: "gzip" }).details; // { os: 255, members: 1 }
compress("lzma", "hello world!", { container: "xz", check: "sha256" }); // 92 bytes
identify(gz)[0]; // { format: "deflate", container: "gzip", confidence: 100, … }
```

That's most of it, really. Pass a string and it's read as UTF-8. You always get a `Uint8Array` back. Broken stream, wrong checksum, too much output? Three different errors. Each one carries the bytes that made it out. More in [compressing](https://compressions.agntn.dev/guide/compressing), [containers](https://compressions.agntn.dev/guide/containers) and [identify](https://compressions.agntn.dev/guide/identify).

## 🗂️ Formats

| Format    | Containers as options   | Writes |
| --------- | ----------------------- | ------ |
| `deflate` | `raw`, `zlib`, `gzip`   | yes    |
| `bzip2`   |                         | yes    |
| `lzma`    | `alone` (`.lzma`), `xz` | yes    |
| `zstd`    |                         | no     |
| `brotli`  |                         | no     |
| `lz4`     | `frame`, `legacy`       | yes    |
| `lzw`     | Unix compress, `.Z`     | yes    |

gzip isn't a format here. It's deflate with `container: "gzip"`. Ask for `gzip` anyway and the error tells you exactly that. Only need deflate? `@agntn/compressions/deflate` and nothing else gets bundled. Levels, checks and the odd quirk live on [the formats page](https://compressions.agntn.dev/formats).

## 🤖 Agents

```bash
pi install npm:@agntn/compressions
omp install @agntn/compressions
```

```json
{
  "mcpServers": {
    "compressions": { "command": "npx", "args": ["-y", "@agntn/compressions", "mcp"] }
  }
}
```

Four tools: `compressions_compress`, `compressions_decompress`, `compressions_identify`, `compressions_info`. For the AI SDK, import them from `@agntn/compressions/ai`. Bytes travel as base64. A bomb stops at 64 MiB, and long output comes in windows. What the model reads back is in the [agents guide](https://compressions.agntn.dev/guide/agents).

## 🚫 What this does not do

Archives. A ZIP, a tar or a 7z holds files, and that's a different job. `identify` still names them, so you know what you're looking at. The data inside a ZIP entry is usually raw deflate, and that opens here. Need a digest? [@agntn/hashes](https://github.com/agntn/hashes). The blob came as base64? [@agntn/encodings](https://github.com/agntn/encodings) first.

## 🧩 Adding a format

Call `defineCompression` with the metadata and two functions, then `register`. There's a run-length one to steal in [custom formats](https://compressions.agntn.dev/guide/custom).

## 🛠️ Development

```bash
pnpm install
pnpm build       # dist/, the CLI and the subpaths
pnpm test        # RFC tables, frozen streams from gzip, bzip2, xz, zstd, brotli, lz4 and ncompress, round trips
pnpm lint        # vp lint and vp fmt --check
pnpm typecheck   # src, the extensions and the tests
```

## 💛 Thanks

Built with help from [Claude for Open Source](https://claude.com/contact-sales/claude-for-oss) and [Codex for Open Source](https://developers.openai.com/community/codex-for-oss). Big thanks to both for keeping small libraries like this one going.

## 📄 License

[MIT](./LICENSE)
