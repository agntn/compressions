/** Byte helpers every codec shares: input reading, a growing output with a limit, option checks. */
import { DecompressError, InvalidOptionError, LimitError } from "./errors.ts";

/** What a codec compresses: bytes, or text it reads as UTF-8. */
export type BytesInput = Uint8Array | string;

/** Most bytes a decoder writes when the caller sets no `limit`: 256 MiB. */
export const DEFAULT_LIMIT = 256 * 1024 * 1024;

/**
 * Reads the input of `compress` as bytes.
 *
 * @param input - Bytes, or text read as UTF-8.
 * @returns {Uint8Array} The bytes.
 */
export function toBytes(input: BytesInput): Uint8Array {
  if (typeof input === "string") return new TextEncoder().encode(input);
  if (input instanceof Uint8Array) return input;
  throw new InvalidOptionError("input", typeof input, "must be a Uint8Array or a string");
}

/**
 * Checks the compressed input of `decompress`.
 *
 * @param data - What the caller passed.
 * @returns {Uint8Array} The same bytes.
 */
export function compressedBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  throw new InvalidOptionError(
    "data",
    data === null ? "null" : typeof data,
    "compressed data must be a Uint8Array",
  );
}

/**
 * Reads an integer option inside a range, or its default.
 *
 * @param name - Option name, for the error.
 * @param value - The value as passed.
 * @param min - Smallest allowed value.
 * @param max - Largest allowed value.
 * @param fallback - Value when it is absent.
 * @returns {number} The value.
 */
export function integerOption(
  name: string,
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new InvalidOptionError(name, value, `must be an integer from ${min} to ${max}`);
  }
  return value;
}

/**
 * Reads the `limit` option: a positive integer, `Infinity`, or the default.
 *
 * @param value - The value as passed.
 * @returns {number} Most bytes to write.
 */
export function limitOption(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (value === Number.POSITIVE_INFINITY) return value;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new InvalidOptionError("limit", value, "must be a non-negative integer or Infinity");
  }
  return value;
}

/**
 * A byte buffer that grows as a decoder writes and stops at a limit. Decoders write into `bytes`
 * directly after `reserve`, which keeps the hot loops on a plain typed array.
 */
export class Output {
  /** The buffer; only the first `length` bytes hold output. */
  bytes: Uint8Array;
  /** Bytes written so far. */
  length = 0;
  /** Most bytes this output may hold. */
  readonly limit: number;
  /** Format name for errors. */
  readonly format: string;

  /**
   * @param format - Format name for errors.
   * @param limit - Most bytes the output may hold.
   * @param hint - Expected size, when the stream states one.
   */
  constructor(format: string, limit: number, hint = 0) {
    this.format = format;
    this.limit = limit;
    this.bytes = new Uint8Array(Math.max(1024, Math.min(hint, limit, 1 << 26)));
  }

  /**
   * Makes room for `count` more bytes, or throws `LimitError` past the limit.
   *
   * @param count - Bytes about to be written.
   */
  reserve(count: number): void {
    const needed = this.length + count;
    if (needed > this.limit) {
      throw new LimitError(this.format, this.limit, { partial: this.take() });
    }
    if (needed <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < needed) size *= 2;
    const grown = new Uint8Array(Math.min(size, Math.max(needed, this.limit)));
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
  }

  /**
   * Appends one byte.
   *
   * @param byte - The byte.
   */
  push(byte: number): void {
    if (this.length === this.bytes.length || this.length >= this.limit) this.reserve(1);
    this.bytes[this.length++] = byte;
  }

  /**
   * Appends bytes.
   *
   * @param chunk - The bytes.
   */
  append(chunk: Uint8Array): void {
    this.reserve(chunk.length);
    this.bytes.set(chunk, this.length);
    this.length += chunk.length;
  }

  /**
   * Appends one byte `count` times.
   *
   * @param byte - The byte.
   * @param count - How many times.
   */
  copyByte(byte: number, count: number): void {
    this.reserve(count);
    this.bytes.fill(byte, this.length, this.length + count);
    this.length += count;
  }

  /**
   * Copies `count` bytes from `distance` back, one at a time so an overlap repeats the run, as
   * every LZ77 format means it.
   *
   * @param distance - How far back the match starts, at least 1.
   * @param count - How many bytes to copy.
   */
  copy(distance: number, count: number): void {
    this.reserve(count);
    const out = this.bytes;
    let to = this.length;
    let from = to - distance;
    if (distance >= count) {
      out.copyWithin(to, from, from + count);
    } else {
      const end = to + count;
      while (to < end) out[to++] = out[from++]!;
    }
    this.length += count;
  }

  /**
   * Copies out what was written.
   *
   * @returns {Uint8Array} A fresh array of `length` bytes.
   */
  take(): Uint8Array {
    return this.bytes.slice(0, this.length);
  }

  /**
   * Builds the error for a broken stream, carrying what came out so far.
   *
   * @param message - What is wrong.
   * @param offset - Where in the input, when one byte is at fault.
   * @returns {DecompressError} The error, for the caller to throw.
   */
  fail(message: string, offset?: number): DecompressError {
    return new DecompressError(this.format, message, { offset, partial: this.take() });
  }
}

/**
 * Joins byte arrays.
 *
 * @param parts - The arrays in order.
 * @returns {Uint8Array} One array.
 */
export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Whether two byte arrays hold the same bytes.
 *
 * @param a - First array.
 * @param b - Second array.
 * @returns {boolean} Whether they are equal.
 */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Writes bytes as lowercase hex, for messages and details.
 *
 * @param bytes - The bytes.
 * @returns {string} The hex.
 */
export function hexOf(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += byte.toString(16).padStart(2, "0");
  return text;
}
