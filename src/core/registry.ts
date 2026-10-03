import { builtins } from "./builtins.ts";
import type { BytesInput } from "./bytes.ts";
import { UnknownFormatError } from "./errors.ts";
import type {
  Compression,
  CompressionInfo,
  CompressOptions,
  Decompressed,
  DecompressOptions,
} from "./types.ts";

let entries: Map<string, Compression> | undefined;

/**
 * The format map, seeded with the built-ins on first use. Importing the package mutates no shared
 * state, which is what `sideEffects: false` promises.
 *
 * @returns {Map<string, Compression>} Registered formats by name.
 */
function registry(): Map<string, Compression> {
  entries ??= new Map(builtins.map((format) => [format.name, format] as const));
  return entries;
}

/**
 * Registers a format under its `name`, replacing any format with the same name.
 *
 * @param format - The format.
 */
export function register(format: Compression): void {
  registry().set(format.name, format);
}

/**
 * Lists the registered format names: the built-ins in listing order, then registrations.
 *
 * @returns {string[]} Registered names.
 */
export function formats(): string[] {
  return [...registry().keys()];
}

/**
 * Checks whether a format is registered.
 *
 * @param name - Exact registry name.
 * @returns {boolean} Whether the name is registered.
 */
export function has(name: string): boolean {
  return registry().has(name);
}

/** Names people type for a built-in, by their spelling without separators. */
const ALIASES: Readonly<Record<string, string>> = {
  bz2: "bzip2",
  bz: "bzip2",
  zst: "zstd",
  zstandard: "zstd",
  br: "brotli",
  compress: "lzw",
  z: "lzw",
};

/**
 * Spells a name without case, spaces, hyphens, underscores or a leading dot.
 *
 * @param name - Name as typed.
 * @returns {string} The bare spelling.
 */
function bare(name: string): string {
  return name
    .toLowerCase()
    .replace(/^\./u, "")
    .replaceAll(/[\s_-]+/gu, "");
}

/**
 * Finds which format a container name belongs to, so `gzip` points at `deflate`.
 *
 * @param name - Bare name as typed.
 * @returns {[string, string] | undefined} The format and the container, when one matches.
 */
export function containerOwner(name: string): [string, string] | undefined {
  const wanted = bare(name);
  for (const format of formats()) {
    const info = registry().get(format)!.info();
    if (info.containers.length < 2) continue;
    const container = info.containers.find(
      (entry) =>
        bare(entry.name) === wanted ||
        bare(entry.label) === wanted ||
        entry.extensions.some((extension) => bare(extension) === wanted),
    );
    if (container) return [format, container.name];
  }
  return undefined;
}

/**
 * Finds the registry name for a name as a person types it: the exact name, then any registered
 * name with the same bare spelling, then a known alias such as `bz2` or `zst`. A container
 * name such as `gzip` is not a format: the error names the format and container to use.
 *
 * @param name - Name as typed.
 * @returns {string} The registry name.
 */
export function resolveFormat(name: string): string {
  const trimmed = name.trim();
  if (has(trimmed)) return trimmed;
  const wanted = bare(trimmed);
  const match = formats().find((entry) => bare(entry) === wanted);
  if (match) return match;
  const alias = ALIASES[wanted];
  if (alias && has(alias)) return alias;
  throw new UnknownFormatError(name, formats(), containerOwner(trimmed));
}

/**
 * Creates a format by name, as `resolveFormat` reads it.
 *
 * @param name - Format name.
 * @returns {Compression} The format.
 */
export function create(name: string): Compression {
  return registry().get(resolveFormat(name))!;
}

/**
 * Compresses text or bytes in a format.
 *
 * @param name - Format name, such as `deflate`.
 * @param input - Text, read as UTF-8, or bytes.
 * @param options - Options the format takes, such as `container` and `level`.
 * @returns {Uint8Array} The compressed bytes.
 */
export function compress(name: string, input: BytesInput, options?: CompressOptions): Uint8Array {
  return create(name).compress(input, options);
}

/**
 * Decompresses bytes in a format.
 *
 * @param name - Format name.
 * @param data - The compressed bytes.
 * @param options - The container, the output limit and partial reading.
 * @returns {Decompressed} The bytes and what the stream said about itself.
 */
export function decompress(
  name: string,
  data: Uint8Array,
  options?: Readonly<DecompressOptions>,
): Decompressed {
  return create(name).decompress(data, options);
}

/**
 * Reads the metadata of every registered format.
 *
 * @returns {CompressionInfo[]} The metadata in listing order.
 */
export function formatInfos(): CompressionInfo[] {
  return formats().map((name) => registry().get(name)!.info());
}
