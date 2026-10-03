import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { sanitizeLine } from "@agntn/tools";
import { registerOmpTools, type OmpRenderers, type OmpResultView } from "@agntn/tools/omp";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import type * as CompressionTools from "../../../dist/tools.d.mts";

/** Longest value a status line shows, cut before `sanitizeLine`, which is slow on long escapes. */
const PREVIEW_LENGTH = 40;

const sourceModulePath = fileURLToPath(new URL("../../../src/tools.ts", import.meta.url));

/**
 * Both specifiers stay literal: compiled OMP resolves bare imports only where it sees them.
 *
 * @returns {Promise<typeof CompressionTools>} The definitions and the executor loader.
 */
function loadTools(): Promise<typeof CompressionTools> {
  return (
    existsSync(sourceModulePath)
      ? import("../../../src/tools.ts")
      : import("../../../dist/tools.mjs")
  ) as Promise<typeof CompressionTools>;
}

/**
 * Shortens a value for a status line, then sanitizes it.
 *
 * @param value - Any argument or result value.
 * @returns {string} At most `PREVIEW_LENGTH` clean characters.
 */
export function preview(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  const cut = text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH - 1)}…` : text;
  return sanitizeLine(cut);
}

/**
 * Reads one field of a result's details.
 *
 * @param result - Tool result from the host.
 * @param key - Field name.
 * @returns {unknown} The value, or `undefined`.
 */
function detail(result: OmpResultView, key: string): unknown {
  const { details } = result;
  return typeof details === "object" && details !== null
    ? (details as Record<string, unknown>)[key]
    : undefined;
}

const renderers: Readonly<Record<string, OmpRenderers>> = {
  compressions_compress: {
    describeCall: (args) => `${preview(args["format"])} ${preview(args["input"])}`,
    describeResult: (result) => {
      const input = detail(result, "inputLength");
      const output = detail(result, "outputLength");
      return typeof input === "number" && typeof output === "number"
        ? [`${input} → ${output} bytes`]
        : [];
    },
  },
  compressions_decompress: {
    describeCall: (args) => `${preview(args["format"])} ${preview(args["data"])}`,
    describeResult: (result) => {
      const value = detail(result, "value");
      const length = detail(result, "byteLength");
      return value === undefined ? [] : [`${String(length)} bytes`, preview(value)];
    },
  },
  compressions_identify: {
    describeCall: (args) => preview(args["data"]),
    describeResult: (result) => {
      const layers = detail(result, "layers");
      const candidates = Array.isArray(layers) ? layers : detail(result, "candidates");
      if (!Array.isArray(candidates)) return [];
      return candidates
        .slice(0, 3)
        .map(
          (candidate: Readonly<{ format?: unknown; container?: unknown; confidence?: unknown }>) =>
            preview(
              `${String(candidate.format)} ${String(candidate.container)} ${String(candidate.confidence)}`,
            ),
        );
    },
  },
  compressions_info: {
    describeCall: (args) => preview(args["format"] ?? ""),
    describeResult: (result) => {
      const formats = detail(result, "formats");
      return Array.isArray(formats) ? [`${formats.length} formats`] : [];
    },
  },
};

/**
 * Registers the compression tools; the executors load on the first call.
 *
 * @param pi - OMP extension API supplied by the host.
 */
export default async function compressionsExtension(pi: ExtensionAPI): Promise<void> {
  pi.setLabel("Compressions");
  const { compressionTools } = await loadTools();
  registerOmpTools(pi, compressionTools, { Text: pi.pi.Text, renderers });
}
