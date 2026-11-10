/** What the commands of `cli-commands.ts` do, loaded on their first call. */

import { readFileSync } from "node:fs";
import { base64 } from "@agntn/encodings/base64";
import { hex } from "@agntn/encodings/hex";
import type { Static, ToolResult } from "@agntn/tools";
import type { CliHost } from "@agntn/tools/cli";
import { DEFAULT_LIMIT } from "./core/bytes.ts";
import { CompressionError, shown } from "./core/errors.ts";
import { archiveOf, peel } from "./core/identify.ts";
import { create } from "./core/registry.ts";
import {
  compressFlags,
  type BYTE_FORMATS,
  type compressCommandSchema,
  type decompressCommandSchema,
  type identifyCommandSchema,
} from "./cli-commands.ts";
import { TOOL_LIMITS } from "./tool-contract.ts";
import {
  candidateOf,
  layerLines,
  peeledAnswer,
  rankedAnswer,
  type IdentifyDetails,
} from "./tool-operations.ts";

type ByteFormat = (typeof BYTE_FORMATS)[number];

/** Bytes these commands wrote themselves, so `runCli` has nothing left to print. */
const WRITTEN: ToolResult<null> = { content: [], details: null };

/**
 * Reads the file argument as `--from` says: `-` means stdin.
 *
 * @param path - The argument as typed.
 * @param from - raw, hex or base64.
 * @returns {Uint8Array} The bytes.
 */
function readSource(path: string, from: ByteFormat = "raw"): Uint8Array {
  try {
    const bytes = new Uint8Array(readFileSync(path === "-" ? 0 : path));
    if (from === "raw") return bytes;
    const text = new TextDecoder().decode(bytes).trim();
    return from === "hex" ? hex.decode(text) : base64.decode(text.replaceAll(/\s+/gu, ""));
  } catch (error) {
    const how = from === "raw" ? "" : ` as ${from}`;
    throw new CompressionError(
      `Cannot read ${path === "-" ? "stdin" : path}${how}: ${(error as Error).message}`,
    );
  }
}

/**
 * Writes bytes to stdout as `--to` says. Raw compressed bytes never go to a terminal.
 *
 * @param bytes - The bytes.
 * @param to - raw, hex or base64.
 * @param binary - Whether raw output is compressed data, which a terminal cannot show.
 */
function writeOutput(bytes: Uint8Array, to: ByteFormat, binary: boolean): void {
  if (to === "raw") {
    if (binary && process.stdout.isTTY) {
      throw new CompressionError(
        "Compressed data is not written to a terminal. Redirect it, or pass --to base64.",
      );
    }
    process.stdout.write(bytes);
  } else {
    process.stdout.write(`${to === "hex" ? hex.encode(bytes) : base64.encode(bytes)}\n`);
  }
}

/**
 * Compresses a file or stdin. A flag left out stays out, so the format's default holds.
 *
 * @param params - The parsed command line.
 * @returns {ToolResult<null>} Nothing left to print.
 */
export function compress(params: Readonly<Static<typeof compressCommandSchema>>): ToolResult<null> {
  const format = create(params.format);
  const names = Object.keys(compressFlags) as (keyof typeof compressFlags)[];
  const options = Object.fromEntries(
    names.flatMap((name) => (params[name] === undefined ? [] : [[name, params[name]] as const])),
  );
  const input = readSource(params.file, params.from);
  writeOutput(format.compress(input, options), params.to ?? "raw", true);
  return WRITTEN;
}

/**
 * Decompresses a file or stdin: the bytes on stdout, what the stream says about itself on stderr.
 *
 * @param params - The parsed command line.
 * @returns {ToolResult<null>} Nothing left to print.
 */
export function decompress(
  params: Readonly<Static<typeof decompressCommandSchema>>,
): ToolResult<null> {
  const format = create(params.format);
  const data = readSource(params.file, params.from);
  const { bytes, details } = format.decompress(data, {
    ...(params.container === undefined ? {} : { container: params.container }),
    ...(params.limit === undefined ? {} : { limit: params.limit }),
    partial: params.partial === true,
  });
  for (const [key, value] of Object.entries(details))
    process.stderr.write(`${key}: ${shown(value)}\n`);
  writeOutput(bytes, params.to ?? "raw", false);
  return WRITTEN;
}

/**
 * An answer that ends the command with exit code 1 and one line on stderr.
 *
 * @param text - The line.
 * @returns {ToolResult<null>} The failure.
 */
function failed(text: string): ToolResult<null> {
  return { content: [{ type: "text", text }], details: null, isError: true };
}

/**
 * Peels every layer: the list on stderr, the innermost bytes on stdout.
 *
 * @param data - The bytes.
 * @param depth - Most layers.
 * @returns {ToolResult<null>} Nothing left to print, or why the bytes are not the whole answer.
 */
function peelTo(data: Uint8Array, depth: number): ToolResult<null> {
  const layers = peel(data, { depth });
  if (layers.length > 0)
    process.stderr.write(`${layerLines(layers.map(candidateOf)).join("\n")}\n`);
  const inner = layers.findLast((layer) => layer.confirmed);
  if (!inner) {
    const archive = archiveOf(data);
    return failed(`No confirmed layer.${archive ? ` It starts like ${archive}.` : ""}`);
  }
  process.stdout.write(inner.bytes);
  return inner.limited
    ? failed(`Cut at the limit: that was only the first ${inner.bytes.length} bytes.`)
    : WRITTEN;
}

/**
 * Peels every layer into JSON. A missing or cut innermost layer fails, as it does without `--json`.
 *
 * @param data - The bytes.
 * @param options - Most layers, and most bytes one layer writes.
 * @returns {ToolResult<IdentifyDetails | null>} The layers and the innermost bytes, or the failure.
 */
export function peelJson(
  data: Uint8Array,
  options: Readonly<{ depth: number; limit: number }>,
): ToolResult<IdentifyDetails | null> {
  const limits = { ...TOOL_LIMITS, output: options.limit, shown: options.limit };
  const answer = peeledAnswer(data, { depth: options.depth, limits });
  const inner = answer.details.layers?.findLast((layer) => layer.confirmed);
  if (!inner) return { ...answer, isError: true };
  return inner.limited
    ? failed(`Cut at the limit: that was only the first ${inner.byteLength} bytes.`)
    : answer;
}

/**
 * Answers like `compressions_identify`, without its caps. Finding nothing is exit code 1.
 *
 * @param params - The parsed command line.
 * @param host - What `runCli` says about the call.
 * @returns {ToolResult<IdentifyDetails | null>} The candidates, the layers, or nothing to print.
 */
export function identify(
  params: Readonly<Static<typeof identifyCommandSchema>>,
  host: unknown,
): ToolResult<IdentifyDetails | null> {
  const data = readSource(params.file, params.from);
  const depth = params.depth ?? 10;
  if (params.peel === true) {
    const json = (host as CliHost | undefined)?.json === true;
    return json ? peelJson(data, { depth, limit: DEFAULT_LIMIT }) : peelTo(data, depth);
  }
  const answer = rankedAnswer(data, DEFAULT_LIMIT);
  return answer.details.candidates.length === 0 ? { ...answer, isError: true } : answer;
}
