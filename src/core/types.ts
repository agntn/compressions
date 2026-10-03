import type { BytesInput } from "./bytes.ts";

/**
 * The built-in formats, in listing order. A container around the same compression is an option of
 * its format, not a format of its own: gzip is `deflate` with `container: gzip`, xz is `lzma` with
 * `container: xz`.
 */
export const compressionFormats = [
  "deflate",
  "bzip2",
  "lzma",
  "zstd",
  "brotli",
  "lz4",
  "lzw",
] as const;

/** Name of a built-in format. Registered formats may use others. */
export type CompressionFormat = (typeof compressionFormats)[number] | (string & {});

/** Option descriptor for the CLI and the tool descriptions. */
export interface CompressionOption {
  name: string;
  type: "number" | "string" | "boolean";
  default?: number | string | boolean;
  description: string;
  /** The values a string option takes. */
  choices?: string[];
  /** Smallest value of a number option. */
  min?: number;
  /** Largest value of a number option. */
  max?: number;
  /** Whether `decompress` takes it too, as a container choice. Default: false, compress only. */
  decode?: boolean;
  /** Containers it applies to, when not all of them, such as gzip's file `name`. */
  containers?: string[];
}

/** One container of a format: raw, zlib or gzip for deflate. */
export interface CompressionContainer {
  /** Value of the `container` option. */
  name: string;
  /** Human-readable label, such as `gzip`. */
  label: string;
  /** Document that defines it. */
  standard: string;
  /** File extensions it usually comes with, dot included. */
  extensions: string[];
  /** The bytes every stream starts with, in hex; absent for a container without any. */
  magic?: string;
  /** The checksum a stream carries, such as `CRC-32`; absent for one without any. */
  checksum?: string;
}

/** Metadata about a format. */
export interface CompressionInfo {
  /** Registry name, such as `deflate`. */
  name: string;
  /** Human-readable label. */
  label: string;
  /** One-line description. */
  description: string;
  /** Document that defines the compression itself: an RFC, or the format's own specification. */
  standard: string;
  /** The containers, default first, each with its own extensions, magic and checksum. */
  containers: CompressionContainer[];
  /** Whether this package writes the format too, not only reads it. */
  compress: boolean;
  /** Options `compress` takes; the ones marked `decode` apply to decompressing too. */
  options: CompressionOption[];
}

/** Option values for `compress`, checked against the format's descriptors. */
export type CompressOptions = Readonly<Record<string, string | number | boolean | undefined>>;

/** Options `decompress` takes: the format's own marked `decode`, plus the limit and partial reading. */
export interface DecompressOptions {
  /** The container, for a format with several, such as `gzip` for `deflate`. */
  container?: string;
  /**
   * Most bytes to write before giving up with `LimitError`, so a small bomb can't fill memory.
   * Default: 256 MiB. `Infinity` turns it off.
   */
  limit?: number;
  /**
   * On a broken or truncated stream, return what came out before the damage instead of throwing,
   * with the error in `details.error`. Default: false.
   */
  partial?: boolean;
}

/** Facts a stream carried about itself, such as a gzip file name or the bytes after it. */
export interface Details {
  [key: string]: string | number | boolean;
}

/** What came out of a stream, with what else the stream said about itself. */
export interface Decompressed {
  /** Decompressed bytes. */
  bytes: Uint8Array;
  /**
   * Facts the stream carried: a gzip file name, the check xz used, the bytes after the stream
   * (`trailing`), how many members or frames, and `error` when `partial` cut it short.
   */
  details: Details;
}

/** A format the registry can create. */
export interface Compression {
  /** Registry name. */
  readonly name: string;
  /** Metadata. */
  info(): CompressionInfo;
  /**
   * Compresses text or bytes.
   * @param input - Text, read as UTF-8, or bytes.
   * @param options - Options from `info().options`.
   */
  compress(input: BytesInput, options?: CompressOptions): Uint8Array;
  /**
   * Decompresses a stream of this format.
   * @param data - The compressed bytes.
   * @param options - The container, the output limit and partial reading.
   */
  decompress(data: Uint8Array, options?: Readonly<DecompressOptions>): Decompressed;
}
