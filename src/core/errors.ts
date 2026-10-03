/** Characters that break a line or change how one reads: controls, format characters such as
 * bidi overrides, and the Unicode line and paragraph separators. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const UNESCAPED_BY_JSON = /[\u0080-\u009F\u2028\u2029\p{Cf}]/gu;

/**
 * Writes text as a JSON string that is safe on one line: JSON escapes C0 controls, and this
 * also escapes C1 controls, U+2028, U+2029 and format characters, which JSON leaves literal.
 *
 * @param text - Any text.
 * @returns {string} The quoted text.
 */
export function quote(text: string): string {
  return JSON.stringify(text).replaceAll(UNESCAPED_BY_JSON, (character) =>
    character
      .split("")
      .map((unit) => `\\u${unit.codePointAt(0)!.toString(16).padStart(4, "0")}`)
      .join(""),
  );
}

/**
 * Shows a caller's value inside an error message. A value with a line break, a control or a
 * format character is quoted: these messages reach a model as they are, and a raw line break
 * would add a line that reads as the tool's own answer. The error's fields keep the raw value.
 *
 * @param value - The value as the caller passed it.
 * @returns {string} The value as it appears in the message.
 */
export function shown(value: unknown): string {
  const text = String(value);
  return UNSAFE.test(text) ? quote(text) : text;
}

/** Base error for @agntn/compressions. */
export class CompressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompressionError";
  }
}

/** Where a broken stream stopped, and what came out of it before that. */
export interface DecompressErrorOptions {
  /** Offset in the compressed input where reading failed, when one byte is at fault. */
  offset?: number;
  /** Bytes decompressed before the failure. */
  partial?: Uint8Array;
}

/** Input that is not a valid stream of the format it was read as. */
export class DecompressError extends CompressionError {
  /** Registry name of the format. */
  readonly format: string;
  /** Offset in the compressed input where reading failed, when one byte is at fault. */
  readonly offset: number | undefined;
  /** Everything decompressed before the failure; `partial: true` returns it instead of throwing. */
  readonly partial: Uint8Array;

  constructor(format: string, message: string, options: Readonly<DecompressErrorOptions> = {}) {
    super(
      options.offset === undefined
        ? `${format}: ${message}`
        : `${format}: ${message} at byte ${options.offset}`,
    );
    this.name = "DecompressError";
    this.format = format;
    this.offset = options.offset;
    this.partial = options.partial ?? new Uint8Array(0);
  }
}

/** A stream that decompressed, but whose stored checksum or size does not match. */
export class ChecksumError extends DecompressError {
  constructor(format: string, message: string, options: Readonly<DecompressErrorOptions> = {}) {
    super(format, message, options);
    this.name = "ChecksumError";
  }
}

/** A valid stream using a feature this package does not implement, such as a zstd dictionary. */
export class UnsupportedError extends DecompressError {
  constructor(format: string, message: string, options: Readonly<DecompressErrorOptions> = {}) {
    super(format, message, options);
    this.name = "UnsupportedError";
  }
}

/** A stream that would decompress past the `limit` the caller set. */
export class LimitError extends DecompressError {
  /** The limit in bytes. */
  readonly limit: number;

  constructor(format: string, limit: number, options: Readonly<DecompressErrorOptions> = {}) {
    super(format, `output passes the limit of ${limit} bytes`, options);
    this.name = "LimitError";
    this.limit = limit;
  }
}

/** Format not found in the registry. */
export class UnknownFormatError extends CompressionError {
  readonly format: string;
  /** Names that were registered when the lookup failed. */
  readonly available: readonly string[];

  /**
   * @param format - The name as typed.
   * @param available - Registered names.
   * @param container - The format and container the name stands for, when it names a container.
   */
  constructor(
    format: string,
    available: readonly string[] = [],
    container?: readonly [string, string],
  ) {
    super(
      container
        ? `${shown(format)} is a container, not a format: use ${container[0]} with container ${container[1]}`
        : available.length > 0
          ? `Unknown format: ${shown(format)}. Available: ${available.join(", ")}`
          : `Unknown format: ${shown(format)}`,
    );
    this.name = "UnknownFormatError";
    this.format = format;
    this.available = available;
  }
}

/** Invalid option value. */
export class InvalidOptionError extends CompressionError {
  readonly option: string;
  readonly value: unknown;
  readonly reason: string;

  constructor(option: string, value: unknown, reason: string) {
    super(`Invalid option ${shown(option)}=${shown(value)}: ${reason}`);
    this.name = "InvalidOptionError";
    this.option = option;
    this.value = value;
    this.reason = reason;
  }
}

/**
 * Normalizes any thrown value into a CompressionError.
 *
 * @param error - The thrown value.
 * @param format - Format the failure belongs to, prefixed to a foreign message.
 * @returns {CompressionError} The same error when it already is one, otherwise a wrapped copy.
 */
export function normalizeError(error: unknown, format?: string): CompressionError {
  if (error instanceof CompressionError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new CompressionError(format ? `[${format}] ${message}` : message);
}
