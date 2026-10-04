/**
 * Tool executors behind the definitions in `tools.ts`, loaded on the first call.
 *
 * Each executor returns the text a caller reads plus the structured details the agent harnesses
 * attach to the call. An MCP client sees only the text, so every fact needed for a follow-up
 * call has to be in it. Arguments are checked here as well as in the schemas, since a caller can
 * reach an executor without them.
 */

import { base64 } from "@agntn/encodings/base64";
import { hex } from "@agntn/encodings/hex";
import { InvalidOptionError, quote } from "./core/errors.ts";
import { archiveOf, identify, peel, readable, type CompressionCandidate } from "./core/identify.ts";
import { create, formatInfos } from "./core/registry.ts";
import type { CompressionContainer, CompressionInfo, CompressionOption } from "./core/types.ts";
import {
  DATA_FORMATS,
  DEFAULT_SHOWN_BYTES,
  INPUT_FORMATS,
  MAX_INPUT_LENGTH,
  MAX_LAYERS,
  MAX_NAME_LENGTH,
  MAX_OUTPUT_BYTES,
  MAX_SHOWN_BYTES,
  OUTPUT_FORMATS,
  TOOL_LIMITS,
  type DataFormat,
  type InputFormat,
  type OutputFormat,
  type ToolLimits,
} from "./tool-contract.ts";

/** The contract the playground and the docs read, so a limit changes in one place. */
export {
  DATA_FORMATS,
  DEFAULT_SHOWN_BYTES,
  INPUT_FORMATS,
  MAX_INPUT_LENGTH,
  MAX_OUTPUT_BYTES,
  MAX_SHOWN_BYTES,
  OUTPUT_FORMATS,
};

/**
 * Text for the model plus details for the harness, shared by every tool surface.
 * A failure throws instead: Pi records every returned value as a successful call.
 */
export interface ToolResult<Details> {
  content: Array<{ type: "text"; text: string }>;
  details: Details;
}

export interface CompressDetails {
  format: string;
  /** Options the format compressed with, the container among them. */
  options: Record<string, string | number | boolean>;
  /** Compressed bytes, written as `dataFormat` says. */
  data: string;
  dataFormat: DataFormat;
  /** Bytes in. */
  inputLength: number;
  /** Bytes out. */
  outputLength: number;
}

export interface DecompressDetails {
  format: string;
  container: string;
  /** Format `value` is written in. */
  outputFormat: Exclude<OutputFormat, "auto">;
  /** The shown part of the decompressed bytes in `outputFormat`. */
  value: string;
  /** Offset of the shown part. */
  offset: number;
  /** Bytes shown. */
  shownLength: number;
  /** Bytes the stream decompressed to. */
  byteLength: number;
  /** What the stream said about itself. */
  details: Record<string, string | number | boolean>;
}

export interface IdentifyCandidate {
  format: string;
  container: string;
  confidence: number;
  reasons: string[];
  confirmed: boolean;
  /** Whether the output passed the limit, so the bytes stop there. */
  limited: boolean;
  byteLength: number;
  /** The start of the decompressed bytes: text when readable, else hex. */
  preview: string;
  /** How `preview` is written. */
  previewFormat: "utf8" | "hex";
  details: Record<string, string | number | boolean>;
}

export interface IdentifyDetails {
  /** Candidates, best first; empty with `peel`. */
  candidates: IdentifyCandidate[];
  /** With `peel`: the layers taken off, outermost first. */
  layers?: IdentifyCandidate[];
  /** With `peel`: the innermost bytes, written as base64. */
  data?: string;
  /** An archive format the bytes start like, which this package does not open. */
  archive?: string;
}

export interface InfoDetails {
  formats: CompressionInfo[];
}

/** Characters of decompressed text shown per candidate before it is cut. */
const PREVIEW_LENGTH = 200;

/**
 * Checks a string argument.
 *
 * @param name - Argument name, for the error.
 * @param value - The value as passed.
 * @param max - Longest allowed length.
 * @param min - Shortest allowed length.
 * @returns {string} The value.
 */
function stringArgument(name: string, value: unknown, max: number, min = 1): string {
  if (typeof value !== "string") throw new InvalidOptionError(name, value, "must be a string");
  if (value.length < min || value.length > max) {
    throw new InvalidOptionError(
      name,
      `${value.length} characters`,
      `must be ${min} to ${max} characters`,
    );
  }
  return value;
}

/**
 * Checks an enum argument.
 *
 * @param name - Argument name.
 * @param value - The value as passed.
 * @param allowed - Allowed values.
 * @param fallback - Value when it is absent.
 * @returns {T} The value.
 */
function enumArgument<T extends string>(
  name: string,
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined) return fallback;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value))
    return value as T;
  throw new InvalidOptionError(name, value, `use one of ${allowed.join(", ")}`);
}

/**
 * Checks an integer argument.
 *
 * @param name - Argument name.
 * @param value - The value as passed.
 * @param min - Smallest value.
 * @param max - Largest value.
 * @param fallback - Value when it is absent.
 * @returns {number} The value.
 */
function integerArgument(
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
 * Reads bytes spelled in hex or base64.
 *
 * @param name - Argument name, for the error.
 * @param text - The text.
 * @param format - hex or base64.
 * @returns {Uint8Array} The bytes.
 */
function bytesOf(name: string, text: string, format: DataFormat | InputFormat): Uint8Array {
  if (format === "utf8") return new TextEncoder().encode(text);
  try {
    return format === "hex" ? hex.decode(text) : base64.decode(text.replaceAll(/\s+/gu, ""));
  } catch (error) {
    throw new InvalidOptionError(
      name,
      `${text.length} characters`,
      `is not ${format}: ${(error as Error).message}`,
    );
  }
}

/**
 * Reads the `options` argument: an object, or nothing.
 *
 * @param value - The argument.
 * @returns {Record<string, unknown>} The options.
 */
function optionsArgument(value: unknown): Record<string, unknown> {
  const options = value ?? {};
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new InvalidOptionError("options", options, "must be an object");
  }
  return options as Record<string, unknown>;
}

/**
 * Splits tool options into the ones the format takes for the chosen container and the rest.
 * Strict function calling fills every field of the schema, and `options` holds the fields of
 * every format, so deflate gets xz's `check`. The library would refuse them; the tool takes what
 * applies and names the rest, a value another format takes as `container=xz`.
 *
 * @param info - The format's metadata.
 * @param options - The options object from the call.
 * @param decoding - Whether only options marked `decode` apply.
 * @returns {{ taken: Record<string, string | number | boolean>; ignored: string[] }} Options to pass, names left out.
 */
function pickOptions(
  info: CompressionInfo,
  options: Readonly<Record<string, unknown>>,
  decoding: boolean,
): { taken: Record<string, string | number | boolean>; ignored: string[] } {
  const declared = info.options.filter((option) => !decoding || option.decode === true);
  const container = chosenContainer(info, options["container"]);
  const taken: Record<string, string | number | boolean> = {};
  const ignored: string[] = [];
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null) continue;
    const option = declared.find((entry) => entry.name === key);
    const verdict = option ? fits(option, container, value) : "absent";
    if (verdict === "absent") ignored.push(key);
    else if (verdict === "other value")
      ignored.push(`${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
    else taken[key] = value as string | number | boolean;
  }
  return { taken, ignored };
}

/**
 * The container a call picked, when the format has it, else the format's default.
 *
 * @param info - The format's metadata.
 * @param value - The `container` option as passed.
 * @returns {string} The container.
 */
function chosenContainer(info: CompressionInfo, value: unknown): string {
  const match = info.containers.find((entry) => entry.name === value);
  return (match ?? info.containers[0]!).name;
}

/**
 * Whether an option value belongs to the chosen container and its choices.
 *
 * @param option - The descriptor.
 * @param container - The chosen container.
 * @param value - The value as passed.
 * @returns {"fits" | "absent" | "other value"} `absent` when another container takes it.
 */
function fits(
  option: CompressionOption,
  container: string,
  value: unknown,
): "fits" | "absent" | "other value" {
  if (option.containers && !option.containers.includes(container)) return "absent";
  if (option.choices && (typeof value !== "string" || !option.choices.includes(value)))
    return "other value";
  return "fits";
}

/**
 * Names the options left out.
 *
 * @param name - Registry name.
 * @param ignored - Option names left out.
 * @returns {string} A line to append, or nothing.
 */
function ignoredNote(name: string, ignored: readonly string[]): string {
  return ignored.length > 0 ? `\nIgnored, ${name} does not take here: ${ignored.join(", ")}` : "";
}

/**
 * Writes the facts a stream carried on one line.
 *
 * @param details - The facts.
 * @returns {string} Such as `name "a.txt", members 1`, or empty.
 */
function detailLine(details: Readonly<Record<string, string | number | boolean>>): string {
  return Object.entries(details)
    .map(([key, value]) => `${key} ${typeof value === "string" ? quote(value) : String(value)}`)
    .join(", ");
}

/**
 * Compresses text or bytes.
 *
 * @param params - Tool arguments.
 * @param limits - The limits to enforce, the tool contract's unless the host asks for less.
 * @returns {ToolResult<CompressDetails>} The compressed bytes in base64 or hex.
 */
export function compressionsCompress(
  params: Readonly<Record<string, unknown>>,
  limits: ToolLimits = TOOL_LIMITS,
): ToolResult<CompressDetails> {
  const name = stringArgument("format", params["format"], MAX_NAME_LENGTH);
  const input = stringArgument("input", params["input"], limits.input, 0);
  const inputFormat = enumArgument("inputFormat", params["inputFormat"], INPUT_FORMATS, "utf8");
  const dataFormat = enumArgument("dataFormat", params["dataFormat"], DATA_FORMATS, "base64");
  const format = create(name);
  const info = format.info();
  const { taken, ignored } = pickOptions(info, optionsArgument(params["options"]), false);
  const bytes = bytesOf("input", input, inputFormat);
  const compressed = format.compress(bytes, taken);
  const data = dataFormat === "hex" ? hex.encode(compressed) : base64.encode(compressed);
  const options = { container: info.containers[0]!.name, ...taken };
  const label = Object.entries(options)
    .map(([key, value]) => `${key} ${String(value)}`)
    .join(", ");
  return {
    content: [
      {
        type: "text",
        text: `${info.name} (${label}): ${bytes.length} → ${compressed.length} bytes, as ${dataFormat}:\n${data}${ignoredNote(info.name, ignored)}`,
      },
    ],
    details: {
      format: info.name,
      options,
      data,
      dataFormat,
      inputLength: bytes.length,
      outputLength: compressed.length,
    },
  };
}

/**
 * Writes bytes as the caller asked, or as text when they read as text.
 *
 * @param bytes - The bytes.
 * @param wanted - The requested format.
 * @returns {[Exclude<OutputFormat, "auto">, string]} The format used and the value.
 */
function written(bytes: Uint8Array, wanted: OutputFormat): [Exclude<OutputFormat, "auto">, string] {
  const format = wanted === "auto" ? (readable(bytes) ? "utf8" : "hex") : wanted;
  if (format === "utf8") {
    try {
      return [format, new TextDecoder("utf-8", { fatal: true }).decode(bytes)];
    } catch {
      throw new InvalidOptionError(
        "outputFormat",
        "utf8",
        "the bytes are not valid UTF-8; use hex or base64",
      );
    }
  }
  return [format, format === "hex" ? hex.encode(bytes) : base64.encode(bytes)];
}

/**
 * Decompresses bytes in a named format and shows a window of the result.
 *
 * @param params - Tool arguments.
 * @param limits - The limits to enforce, the tool contract's unless the host asks for less.
 * @returns {ToolResult<DecompressDetails>} The bytes as text, hex or base64.
 */
export function compressionsDecompress(
  params: Readonly<Record<string, unknown>>,
  limits: ToolLimits = TOOL_LIMITS,
): ToolResult<DecompressDetails> {
  const name = stringArgument("format", params["format"], MAX_NAME_LENGTH);
  const dataFormat = enumArgument("dataFormat", params["dataFormat"], DATA_FORMATS, "base64");
  const data = bytesOf("data", stringArgument("data", params["data"], limits.input), dataFormat);
  const wanted = enumArgument("outputFormat", params["outputFormat"], OUTPUT_FORMATS, "auto");
  const offset = integerArgument("offset", params["offset"], 0, limits.output, 0);
  const length = integerArgument(
    "length",
    params["length"],
    1,
    limits.shown,
    Math.min(DEFAULT_SHOWN_BYTES, limits.shown),
  );
  const partial = params["partial"] === true;
  const format = create(name);
  const info = format.info();
  const { taken, ignored } = pickOptions(info, optionsArgument(params["options"]), true);
  const container = (taken["container"] as string | undefined) ?? info.containers[0]!.name;
  const { bytes, details } = format.decompress(data, {
    container,
    limit: limits.output,
    partial,
  });
  const window = bytes.subarray(offset, offset + length);
  const [outputFormat, value] = written(window, wanted);
  const extra = detailLine(details);
  const range =
    window.length === bytes.length
      ? `${bytes.length} bytes`
      : `${bytes.length} bytes, showing ${offset} to ${offset + window.length}; pass offset for the rest`;
  const header = `${info.name} (container ${container}) → ${range}, as ${outputFormat}${extra ? ` (${extra})` : ""}:`;
  return {
    content: [
      {
        type: "text",
        text: `${header}\n${outputFormat === "utf8" ? quote(value) : value}${ignoredNote(info.name, ignored)}`,
      },
    ],
    details: {
      format: info.name,
      container,
      outputFormat,
      value,
      offset,
      shownLength: window.length,
      byteLength: bytes.length,
      details,
    },
  };
}

/**
 * Writes a candidate for the answer.
 *
 * @param candidate - The candidate.
 * @returns {IdentifyCandidate} Its tool shape.
 */
function candidateOf(candidate: CompressionCandidate): IdentifyCandidate {
  const head = candidate.bytes.subarray(0, PREVIEW_LENGTH);
  const text = readable(head);
  const preview = text
    ? new TextDecoder().decode(head)
    : hex.encode(head.subarray(0, PREVIEW_LENGTH / 2));
  return {
    format: candidate.format,
    container: candidate.container,
    confidence: candidate.confidence,
    reasons: candidate.reasons,
    confirmed: candidate.confirmed,
    limited: candidate.limited,
    byteLength: candidate.bytes.length,
    preview,
    previewFormat: text ? "utf8" : "hex",
    details: candidate.details,
  };
}

/**
 * Writes a candidate on two lines.
 *
 * @param candidate - The candidate.
 * @param index - Its place, from 1.
 * @returns {string} The lines.
 */
function candidateText(candidate: IdentifyCandidate, index: number): string {
  const extra = detailLine(candidate.details);
  const mark = candidate.confirmed ? "" : ", unconfirmed";
  return `${index}. ${candidate.format} container ${candidate.container}, confidence ${candidate.confidence}${mark}: ${candidate.reasons.join("; ")}${extra ? ` (${extra})` : ""}\n   ${candidate.byteLength} bytes, ${candidate.previewFormat === "utf8" ? `text ${quote(candidate.preview)}` : `hex ${candidate.preview}`}`;
}

/**
 * Says that nothing decompressed, naming an archive the bytes start like.
 *
 * @param length - Bytes looked at.
 * @param archive - The archive format, when one fits.
 * @param what - What was not found.
 * @returns {string} The sentence.
 */
function nothingFound(length: number, archive: string | undefined, what: string): string {
  const note = archive ? ` They start like ${archive}, which this package does not open.` : "";
  return `${what} ${length} bytes.${note}`;
}

/**
 * Heads the innermost bytes, saying when the limit cut them.
 *
 * @param length - How many bytes the layer gave.
 * @param limited - Whether the limit cut it.
 * @returns {string} The line.
 */
function innermostLine(length: number, limited: boolean): string {
  const size = limited ? `the first ${length} bytes, cut at the limit,` : `${length} bytes`;
  return `Innermost, ${size} as base64:`;
}

/**
 * Peels every layer it can confirm, and hands the innermost bytes on.
 *
 * @param data - The bytes.
 * @param depth - Most layers.
 * @param archive - An archive format the bytes start like.
 * @param limits - The limits to enforce.
 * @returns {ToolResult<IdentifyDetails>} The layers.
 */
function peelLayers(
  data: Uint8Array,
  depth: number,
  archive: string | undefined,
  limits: ToolLimits,
): ToolResult<IdentifyDetails> {
  const peeled = peel(data, { limit: limits.output, depth });
  const layers = peeled.map(candidateOf);
  const innermost = peeled.findLast((layer) => layer.confirmed);
  const encoded = innermost ? base64.encode(innermost.bytes.subarray(0, limits.shown)) : undefined;
  const lines =
    layers.length === 0
      ? [nothingFound(data.length, archive, "No compression layer found in")]
      : [
          `${layers.length} ${layers.length === 1 ? "layer" : "layers"}, outermost first:`,
          ...layers.map((layer, index) => candidateText(layer, index + 1)),
        ];
  if (innermost && encoded)
    lines.push(innermostLine(innermost.bytes.length, innermost.limited), encoded);
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: {
      candidates: [],
      layers,
      ...(encoded ? { data: encoded } : {}),
      ...(archive ? { archive } : {}),
    },
  };
}

/**
 * Lists what compressed some bytes, or peels every layer.
 *
 * @param params - Tool arguments.
 * @param limits - The limits to enforce, the tool contract's unless the host asks for less.
 * @returns {ToolResult<IdentifyDetails>} The candidates or the layers.
 */
export function compressionsIdentify(
  params: Readonly<Record<string, unknown>>,
  limits: ToolLimits = TOOL_LIMITS,
): ToolResult<IdentifyDetails> {
  const dataFormat = enumArgument("dataFormat", params["dataFormat"], DATA_FORMATS, "base64");
  const data = bytesOf("data", stringArgument("data", params["data"], limits.input), dataFormat);
  const archive = archiveOf(data);
  if (params["peel"] === true) {
    return peelLayers(
      data,
      integerArgument("depth", params["depth"], 1, MAX_LAYERS, MAX_LAYERS),
      archive,
      limits,
    );
  }
  const candidates = identify(data, { limit: limits.output }).slice(0, MAX_LAYERS).map(candidateOf);
  const listed = candidates
    .map((candidate, index) => candidateText(candidate, index + 1))
    .join("\n");
  const cut = candidates.some((candidate) => candidate.limited)
    ? " For a candidate cut at the limit, set partial to take the bytes under it."
    : "";
  const text =
    candidates.length === 0
      ? nothingFound(data.length, archive, "No format decompresses these")
      : `${candidates.length} ${candidates.length === 1 ? "candidate" : "candidates"}, best first:\n${listed}\nNext: compressions_decompress with the format and container, or set peel for nested layers.${cut}`;
  return {
    content: [{ type: "text", text }],
    details: { candidates, ...(archive ? { archive } : {}) },
  };
}

/**
 * Writes one container of a format on a line.
 *
 * @param container - The container.
 * @returns {string} The line.
 */
function containerLine(container: CompressionContainer): string {
  const facts = [
    container.standard,
    container.extensions.join(" "),
    container.magic ? `magic ${container.magic}` : "no magic number",
    container.checksum ? `checksum ${container.checksum}` : "no checksum",
  ].filter(Boolean);
  return `  container ${container.name}: ${container.label}, ${facts.join(", ")}`;
}

/**
 * Writes one option of a format on a line.
 *
 * @param option - The option.
 * @returns {string} The line.
 */
function optionLine(option: CompressionOption): string {
  const range = option.min === undefined ? "" : ` (${option.min} to ${option.max})`;
  const values = option.choices ? ` (${option.choices.join(", ")})` : range;
  const fallback = option.default === undefined ? "" : `, default ${String(option.default)}`;
  const scope = option.containers ? `, ${option.containers.join(" and ")} only` : "";
  const both = option.decode ? ", decompress too" : "";
  return `  option ${option.name}${values}: ${option.description}${fallback}${scope}${both}`;
}

/**
 * Writes one format with its containers and options.
 *
 * @param info - The format's metadata.
 * @returns {string} The description.
 */
function infoText(info: CompressionInfo): string {
  const does = info.compress ? "Compresses and decompresses." : "Decompresses only.";
  return [
    `${info.name}: ${info.label}, ${info.standard}. ${info.description}. ${does}`,
    ...info.containers.map(containerLine),
    ...info.options.map(optionLine),
  ].join("\n");
}

/**
 * Lists the formats, or shows one.
 *
 * @param params - Tool arguments.
 * @returns {ToolResult<InfoDetails>} The formats.
 */
export function compressionsInfo(
  params: Readonly<Record<string, unknown>>,
): ToolResult<InfoDetails> {
  const name = params["format"];
  const infos =
    name === undefined
      ? formatInfos()
      : [create(stringArgument("format", name, MAX_NAME_LENGTH)).info()];
  return {
    content: [{ type: "text", text: infos.map(infoText).join("\n") }],
    details: { formats: infos },
  };
}
