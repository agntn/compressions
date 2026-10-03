import { readFileSync } from "node:fs";
import { base64 } from "@agntn/encodings/base64";
import { hex } from "@agntn/encodings/hex";
import { CompressionError, InvalidOptionError } from "../core/errors.ts";

/** How the CLI reads and writes bytes: as they are, or spelled in hex or base64. */
export const BYTE_FORMATS = ["raw", "hex", "base64"] as const;

/**
 * Reads a file argument: `-` means stdin.
 *
 * @param path - The argument as typed.
 * @returns {Uint8Array} The bytes.
 */
export function readSource(path: string): Uint8Array {
  try {
    return new Uint8Array(readFileSync(path === "-" ? 0 : path));
  } catch (error) {
    throw new CompressionError(
      `Cannot read ${path === "-" ? "stdin" : path}: ${(error as Error).message}`,
    );
  }
}

/**
 * Turns what was read into bytes, as `--from` says.
 *
 * @param bytes - What was read.
 * @param from - raw, hex or base64.
 * @returns {Uint8Array} The bytes.
 */
export function fromFormat(bytes: Uint8Array, from: string): Uint8Array {
  if (from === "raw") return bytes;
  const text = new TextDecoder().decode(bytes).trim();
  if (from === "hex") return hex.decode(text);
  if (from === "base64") return base64.decode(text.replaceAll(/\s+/gu, ""));
  throw new InvalidOptionError("from", from, `use one of ${BYTE_FORMATS.join(", ")}`);
}

/**
 * Writes bytes to stdout, as `--to` says. Raw bytes that are not text never go to a terminal.
 *
 * @param bytes - The bytes.
 * @param to - raw, hex or base64.
 * @param binary - Whether raw output is compressed data, which a terminal cannot show.
 */
export function writeOutput(bytes: Uint8Array, to: string, binary: boolean): void {
  if (to === "hex") {
    process.stdout.write(`${hex.encode(bytes)}\n`);
  } else if (to === "base64") {
    process.stdout.write(`${base64.encode(bytes)}\n`);
  } else if (to === "raw") {
    if (binary && process.stdout.isTTY) {
      throw new CompressionError(
        "Compressed data is not written to a terminal. Redirect it, or pass --to base64.",
      );
    }
    process.stdout.write(bytes);
  } else {
    throw new InvalidOptionError("to", to, `use one of ${BYTE_FORMATS.join(", ")}`);
  }
}

/**
 * Reads the option flags the user typed. A flag left out stays out, so the format's own default
 * applies, and a flag the format does not take fails instead of being ignored.
 *
 * @param flags - Option flags the command defines.
 * @param args - Parsed arguments.
 * @param rawArgs - Arguments as typed.
 * @returns {Record<string, string | boolean>} The typed flags by option name, as citty parsed them.
 */
export function typedFlags(
  flags: readonly string[],
  args: Readonly<Record<string, unknown>>,
  rawArgs: readonly string[],
): Record<string, string | boolean> {
  const options: Record<string, string | boolean> = {};
  for (const name of flags) {
    const typed = rawArgs.some(
      (raw) => raw === `--${name}` || raw === `--no-${name}` || raw.startsWith(`--${name}=`),
    );
    if (typed) options[name] = args[name] as string | boolean;
  }
  return options;
}

/**
 * Reads an integer flag, which citty hands over as a string.
 *
 * @param name - Option name, for the error.
 * @param value - The flag as citty parsed it.
 * @returns {number} The integer.
 */
export function integerFlag(name: string, value: unknown): number {
  if (!/^\d+$/u.test(String(value)))
    throw new InvalidOptionError(name, value, "must be an integer");
  return Number(value);
}
