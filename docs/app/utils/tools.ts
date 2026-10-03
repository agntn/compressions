import {
  compressionsCompress,
  compressionsDecompress,
  compressionsIdentify,
  compressionsInfo,
  type CompressDetails,
  type DecompressDetails,
  type IdentifyDetails,
  type InfoDetails,
  type ToolResult,
} from "#tool-operations";

/** Every agent tool, in the order every surface lists them. Same names over MCP, Pi, OMP and the AI SDK. */
export const TOOLS = [
  "compressions_compress",
  "compressions_decompress",
  "compressions_identify",
  "compressions_info",
] as const;

export type ToolName = (typeof TOOLS)[number];

export type ToolDetails = CompressDetails | DecompressDetails | IdentifyDetails | InfoDetails;

/**
 * Runs one tool's executor, the one the MCP server runs.
 *
 * @param {ToolName} name - The tool.
 * @param {Record<string, unknown>} params - Its arguments.
 * @returns {ToolResult<ToolDetails>} Text and details.
 */
export function runTool(name: ToolName, params: Readonly<Record<string, unknown>>): ToolResult<ToolDetails> {
  switch (name) {
    case "compressions_compress":
      return compressionsCompress(params);
    case "compressions_decompress":
      return compressionsDecompress(params);
    case "compressions_identify":
      return compressionsIdentify(params);
    case "compressions_info":
      return compressionsInfo(params);
  }
}

/**
 * The text a tool hands a model.
 *
 * @param {ToolName} name - The tool.
 * @param {Record<string, unknown>} params - Its arguments.
 * @returns {string} `content[0].text`.
 */
export function toolText(name: ToolName, params: Readonly<Record<string, unknown>>): string {
  return runTool(name, params).content[0]!.text;
}

/**
 * The text and candidates `compressions_identify` hands a model.
 *
 * @param {string} data - Compressed bytes in base64.
 * @returns {{ text: string; candidates: IdentifyDetails["candidates"] }} The answer.
 */
export function identifyAnswer(data: string): { text: string; candidates: IdentifyDetails["candidates"] } {
  const result = compressionsIdentify({ data });
  return { text: result.content[0]!.text, candidates: result.details.candidates };
}

/**
 * A candidate's preview as a row shows it: text quoted, hex as it is.
 *
 * @param {{ preview: string; previewFormat: "utf8" | "hex" }} candidate - The candidate.
 * @returns {string} The preview.
 */
export function previewText(candidate: Readonly<{ preview: string; previewFormat: "utf8" | "hex" }>): string {
  return candidate.previewFormat === "utf8" ? JSON.stringify(candidate.preview) : candidate.preview;
}
