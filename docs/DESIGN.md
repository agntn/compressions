# Design system

The shared rules (direction, color roles, type, the `console-*` grammar, hero, docs chrome, density, motion, checks) live in the one agntn design system document, kept with the agntn skills until it ships in the shared package. This file records only what compressions owns and where it departs from the shared rules. It does not repeat them.

The instruments compressions owns:

| Instrument | Where | Object |
| --- | --- | --- |
| [LandingHero.vue](app/components/content/LandingHero.vue) | landing, first screen | hero zone, circuit `compress` into the stream |
| [LandingStream.vue](app/components/content/LandingStream.vue) | under the hero | the sample through one container, every byte of the stream coloured by what it's for |
| [LandingRotatingCode.vue](app/components/content/LandingRotatingCode.vue) | "Same call, every format" | `compress`, `decompress`, the round trip and `identify` for the sample, as a file |
| [LandingIdentify.vue](app/components/content/LandingIdentify.vue) | "A guess that shows its work" | identify console: the sample's stream through `compressions_identify`, the top three candidates and a tick per container that reads it |
| [LandingRegistry.vue](app/components/content/LandingRegistry.vue) | the registry section | every container as a grid of cells, one band per group (prefix codes, range coding, block sorting, byte aligned, dictionary codes), the walk's container and its format on the nodes |
| [LandingToolCall.vue](app/components/content/LandingToolCall.vue) | "N tools, one executor", N from `TOOLS` | one `compressions_decompress` call, full text in the dialog |
| [LandingCustom.vue](app/components/content/LandingCustom.vue) | "Your own format is one call" | `rle.ts`, a custom format as a file, folded |
| [LandingStart.vue](app/components/content/LandingStart.vue) | last section | install, first call, CLI and MCP lines |
| [FormatFacts.vue](app/components/content/FormatFacts.vue) | every format page (`::format-facts`) | format dossier: ID bar with position, reticle, readout, the sample through every container and back, options, access |
| [FormatRoster.vue](app/components/content/FormatRoster.vue) | `/formats` (`::format-roster`) | roster of the registry on `UTable`, sortable |
| [CompressionsPlayground.vue](app/components/content/CompressionsPlayground.vue) | `/playground` under the hero zone | request and response instruments for every tool |
| [Landing.takumi.vue](app/components/OgImage/Landing.takumi.vue), [Docs.takumi.vue](app/components/OgImage/Docs.takumi.vue) | OG images | the hero zone in 1200 by 600; a docs page as one instrument, a format page with its blurb, group, containers and who uses it |

Labels, standards, containers, magic numbers, checksums and options come from `create(name).info()` through [formats.ts](app/utils/formats.ts); icons, blurbs, groups and who uses a format live there too. Every tool text comes from `src/tool-operations.ts` itself.

## Anatomy

- **Stream.** Bar `Call compress("<format>", "<sample>", { container })`, or `decompress("<format>", bytes)` for the two read only formats, meta `<container> · 03 / 07`. The subject band's left column holds the container (reticle, `Format / <container>`, label, blurb; every sample's name block hidden in the same cell, so the band keeps one height) and under it the board: rule `Stream [ every byte it wrote, by what it's for ]` with copy, an `In` row with the sample, an `Out` row with a legend of magic, header, data and check bytes and their counts, then one cell per byte in hex, coloured by its segment. The grid keeps room for the widest stream in the walk, so the band never jumps. Readout: size in and out, ratio in the accent with whether it reads back, checksum, who wrote it (this page, or the format's own CLI), file extensions; a tick per container with the sample's format open. Footer: link to the format page, previous and next.
- **Identify.** Bar `Call compressions_identify("<base64>")`, meta `ranked`. Subject: `Guess / <score>`, the best candidate and whether it's the container that wrote the stream, the reasons as a sentence. Readout: three rows always (an empty one says `no other reading`), each the format and container, what it decompresses to (quoted text or hex) and its score as a badge, the sample's own container on the accent edge; a tick per container, open where it reads the stream. `03 Full tool response` is the `compressions_identify` text.
- **Format dossier.** ID bar with the name and `01 / 07`, meta `<n> containers · reads and writes` (or `reads only`). Subject: reticle, `Format / <group>`, label, blurb. Readout: ratio in the accent (or `reads only`), checksums, standard, who uses it; a tick per format with the group open. Bands `Containers [ "<sample>" through each, computed here ]` (a row per container: its tag, label, extensions, magic and checksum, then the size, the first bytes, whether it reads back and what decompressing reported), `Options [ as info() declares them ]` where there are any, and `Access [ library · CLI · playground ]` as leads (the subpath import, the CLI line, the playground, a `Kin` lead to the rest of the group), then `03 Full tool response` with the `compressions_info` text.
- **Registry.** Bar `Call formats()`, meta the count of formats and containers. One band per group under a rule title with its size and what the group does (the sentence hides under 640px), then a cell per container (glyph, name, node): the walk's container a filled node on an accent edge, the rest of its format an accent outlined node, everything else quiet.
- **Roster.** Columns format (glyph, label, boxed name), containers, ratio on a few lines of text at the defaults (none for a format this package only reads), checksums, options (bright for `container`), the standard behind a leader with the whole text in the tooltip.
- **Playground.** Request: every tool as a lead, fields as `USelectMenu`, `UTextarea`, `UInput` and `UCheckbox` with variant `none` in the readout, option fields only for a format and container that declare them, `partial` and `peel` as checkboxes, one chip per container as `UButton` variant `chip` (sample streams for identify, the nested one included), CLI and tool JSON with copy. Response: a subject band per answer kind (compressed bytes with size and ratio, decompressed value with what the stream said about itself, a ranking with a `decompress` button that carries the bytes along, the peeled layers outermost first with a `guess` badge on an unbacked last one, listing rows, one format's containers and options, error), `03 Full tool response`, footer to the format page and the guide.

## Motion

| Change | Motion |
| --- | --- |
| landing sample advances (4.2 s, paused on hover and focus) | ruler cursor once, scan and reticle arcs, readout rows slide in, stream bytes drop in 4 ms apart, file name rolls, circuit runs once |
| playground answer changes | cursor and scan once per answer text, 250 ms after the form stops changing |
| reduced motion | no walk; manual previous and next still work |

## Differences

Departures from the shared rules, recorded for the shared package:

- The hero instrument is a byte stream, not a record dossier: the domain is bytes with a layout, so the first screen shows which of them are magic, header, data and check. It works for every container, the ones without a magic number or a checksum included, where they simply show no such bytes.
- The walk goes over containers, not formats. gzip, zlib and raw deflate are one format and three very different streams, and the point of the page is that they're one call.
- The registry groups by mechanism, not by format. Most formats have one container, so a band per format would be a band of single cells.
- One docs section for the formats, no tabs: seven entries, far under the point where a section splits. Containers get a heading on their format's page.
- No network call anywhere: every instrument computes in the browser from the library, and every footer that names locality says `no network`. The two read only samples are literals a CLI wrote once, not a fetch.
- The version comes from the root `package.json`; there's no data version.
- The OG images ship local Figtree and Fira Code TTFs, the keys mechanism.
- There's no `public/image.png`, since `package.json` points Pi at no image.

## Checks

Beyond the shared checks: `/`, `/formats`, `/formats/deflate`, `/formats/zstd` and `/playground` with a deep link for every tool (`?op=compress&format=lzma&container=xz&input=hello`, `?op=decompress&format=deflate&container=gzip&data=H4sIAAAAAAAA%2F8tIzcnJVyjPL8pJUQQAbcK0AwwAAAA%3D`, `?op=identify&data=H4sIAAAAAAAA%2F8tIzcnJVyjPL8pJUQQAbcK0AwwAAAA%3D`, the nested sample with `&peel=true`, `?op=info&format=lz4`) at 1440, 1024 and 390 px, no horizontal scroll at 320 px, and `/llms-full.txt` answering 200.
