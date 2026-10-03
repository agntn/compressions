/** Builds a format from its metadata and two functions, with the checks every format shares. */
import { compressedBytes, limitOption, Output, toBytes, type BytesInput } from "./bytes.ts";
import { CompressionError, DecompressError, InvalidOptionError } from "./errors.ts";
import type {
  Compression,
  CompressionInfo,
  CompressionOption,
  CompressOptions,
  Decompressed,
  DecompressOptions,
  Details,
} from "./types.ts";

/** What a format implements; `defineCompression` adds the checks. */
export interface CompressionSpec {
  info: CompressionInfo;
  /**
   * Compresses bytes; absent when the package only reads the format.
   * @param bytes - The input.
   * @param options - Checked options, `container` always set.
   */
  compress?: (
    bytes: Uint8Array,
    options: Readonly<CompressOptions & { container: string }>,
  ) => Uint8Array;
  /**
   * Decodes a stream into `out` and returns what the stream said about itself.
   * @param data - The compressed bytes.
   * @param out - Receives the bytes, with the caller's limit.
   * @param container - The checked container.
   */
  decompress: (data: Uint8Array, out: Output, container: string) => Details;
}

/** Keys of `decompress` options every format takes. */
const DECOMPRESS_KEYS = new Set(["limit", "partial"]);

/**
 * Checks a number option against its range.
 *
 * @param option - The descriptor.
 * @param value - The value as passed, already a number.
 */
function checkRange(option: CompressionOption, value: number): void {
  const min = option.min ?? Number.MIN_SAFE_INTEGER;
  const max = option.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new InvalidOptionError(option.name, value, `must be an integer from ${min} to ${max}`);
  }
}

/**
 * Checks one option value against its descriptor.
 *
 * @param option - The descriptor.
 * @param value - The value as passed.
 */
function checkValue(option: CompressionOption, value: unknown): void {
  if (typeof value !== option.type) {
    throw new InvalidOptionError(option.name, value, `must be a ${option.type}`);
  }
  if (option.choices && !option.choices.includes(String(value))) {
    throw new InvalidOptionError(option.name, value, `use one of ${option.choices.join(", ")}`);
  }
  if (option.type === "number") checkRange(option, value as number);
}

/**
 * Reads the container option, or the format's default one.
 *
 * @param info - The format's metadata.
 * @param value - The value as passed.
 * @returns {string} A container the format has.
 */
function containerOf(info: CompressionInfo, value: unknown): string {
  if (value === undefined) return info.containers[0]!.name;
  const names = info.containers.map((container) => container.name);
  if (typeof value === "string" && names.includes(value)) return value;
  throw new InvalidOptionError(
    "container",
    value,
    names.length > 1
      ? `${info.name} comes as ${names.join(", ")}`
      : `${info.name} has one container, ${names[0]}`,
  );
}

/**
 * Finds the descriptor of an option the call may pass, or explains why there is none.
 *
 * @param info - The format's metadata.
 * @param name - Option name.
 * @param value - Its value, for the error.
 * @param decoding - Whether only options marked `decode` count.
 * @param container - The chosen container.
 * @returns {CompressionOption} The descriptor.
 */
function declared(
  info: CompressionInfo,
  name: string,
  value: unknown,
  decoding: boolean,
  container: string,
): CompressionOption {
  const allowed = info.options.filter((entry) => !decoding || entry.decode === true);
  const option = allowed.find((entry) => entry.name === name);
  if (!option) {
    const names = allowed.map((entry) => entry.name);
    const reason =
      names.length > 0
        ? `${info.name} takes ${names.join(", ")}`
        : `${info.name} takes no options here`;
    throw new InvalidOptionError(name, value, reason);
  }
  if (option.containers && !option.containers.includes(container)) {
    throw new InvalidOptionError(
      name,
      value,
      `only ${option.containers.join(" and ")} takes it, not ${container}`,
    );
  }
  return option;
}

/**
 * Reads an options argument as its entries.
 *
 * @param options - Options as passed.
 * @returns {[string, unknown][]} The entries; none when it is absent.
 */
function optionEntries(options: unknown): [string, unknown][] {
  if (options === undefined) return [];
  if (typeof options !== "object" || options === null) {
    throw new InvalidOptionError("options", options, "must be an object");
  }
  return Object.entries(options);
}

/**
 * Checks option names, types and containers, so a misspelled option or one of another container
 * fails instead of being ignored.
 *
 * @param info - The format's metadata.
 * @param options - Options as passed.
 * @param decoding - Whether these are `decompress` options, which take only those marked `decode`.
 * @returns {CompressOptions & { container: string }} The options with the container filled in.
 */
function checkedOptions(
  info: CompressionInfo,
  options: unknown,
  decoding: boolean,
): CompressOptions & { container: string } {
  const entries = optionEntries(options);
  const container = containerOf(info, entries.find(([name]) => name === "container")?.[1]);
  const checked: Record<string, string | number | boolean> = { container };
  const skipped = (name: string, value: unknown): boolean =>
    value === undefined || name === "container" || (decoding && DECOMPRESS_KEYS.has(name));
  for (const [name, value] of entries) {
    if (skipped(name, value)) continue;
    checkValue(declared(info, name, value, decoding, container), value);
    checked[name] = value as string | number | boolean;
  }
  return checked as CompressOptions & { container: string };
}

/**
 * Builds a format.
 *
 * @param spec - Metadata and the two functions.
 * @returns {Compression} The format.
 */
export function defineCompression(spec: Readonly<CompressionSpec>): Compression {
  const { info } = spec;
  return {
    name: info.name,
    info: () => structuredClone(info),
    compress(input: BytesInput, options?: CompressOptions): Uint8Array {
      const checked = checkedOptions(info, options, false);
      if (!spec.compress) {
        throw new CompressionError(
          `${info.name}: this package reads ${info.label} but does not write it`,
        );
      }
      return spec.compress(toBytes(input), checked);
    },
    decompress(data: Uint8Array, options?: Readonly<DecompressOptions>): Decompressed {
      const bytes = compressedBytes(data);
      const { container } = checkedOptions(info, options, true);
      const out = new Output(info.name, limitOption(options?.limit));
      try {
        const details = spec.decompress(bytes, out, container);
        return { bytes: out.take(), details };
      } catch (error) {
        if (options?.partial !== true || !(error instanceof DecompressError)) throw error;
        return { bytes: error.partial, details: { error: error.message } };
      }
    },
  };
}
