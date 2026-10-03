/** One contract for every tool surface; the schemas repeat it, the executors enforce it. */

/** Longest compressed or plain input a tool reads, in characters of its text form. */
export const MAX_INPUT_LENGTH = 4_000_000;

/** Most bytes a tool lets one stream decompress to, so a small bomb stays small. */
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Most decompressed bytes a tool shows in one answer by default, and at most. */
export const DEFAULT_SHOWN_BYTES = 16 * 1024;
export const MAX_SHOWN_BYTES = 1024 * 1024;

/** Longest format name a tool takes. */
export const MAX_NAME_LENGTH = 40;

/** Most layers `compressions_identify` peels, and most candidates it lists. */
export const MAX_LAYERS = 10;

/** How a tool reads text it compresses: as UTF-8, or as the bytes its hex or base64 spells. */
export const INPUT_FORMATS = ["utf8", "hex", "base64"] as const;

/** How a tool reads compressed data: bytes spelled in base64 or hex. */
export const DATA_FORMATS = ["base64", "hex"] as const;

/** How a tool writes decompressed bytes: `auto` picks UTF-8 for readable text and hex otherwise. */
export const OUTPUT_FORMATS = ["auto", "utf8", "hex", "base64"] as const;

/**
 * Every value the `container` option takes, across the formats. A literal list, so the schemas
 * load without the codecs; `test/mcp.test.ts` holds it to the registry.
 */
export const CONTAINERS = ["raw", "zlib", "gzip", "alone", "xz", "frame", "legacy"] as const;

/** Every value of xz's `check`; `test/mcp.test.ts` holds it to `XZ_CHECKS`. */
export const CHECKS = ["none", "crc32", "crc64", "sha256"] as const;

export type InputFormat = (typeof INPUT_FORMATS)[number];
export type DataFormat = (typeof DATA_FORMATS)[number];
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];
