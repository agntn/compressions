/** Vercel AI SDK tool surface over the shared compression tool definitions. */

import { toAiTool, type AiToolOutput } from "@agntn/tools/ai";
import type { Static } from "@agntn/tools";
import type { Tool } from "ai";
import type {
  CompressDetails,
  DecompressDetails,
  IdentifyDetails,
  InfoDetails,
} from "./tool-operations.ts";
import {
  compressSchema,
  compressTool,
  decompressSchema,
  decompressTool,
  identifySchema,
  identifyTool,
  infoSchema,
  infoTool,
} from "./tools.ts";

export const compressionsCompressTool: Tool<
  Static<typeof compressSchema>,
  AiToolOutput<CompressDetails>
> = toAiTool(compressTool);

export const compressionsDecompressTool: Tool<
  Static<typeof decompressSchema>,
  AiToolOutput<DecompressDetails>
> = toAiTool(decompressTool);

export const compressionsIdentifyTool: Tool<
  Static<typeof identifySchema>,
  AiToolOutput<IdentifyDetails>
> = toAiTool(identifyTool);

export const compressionsInfoTool: Tool<
  Static<typeof infoSchema>,
  AiToolOutput<InfoDetails>
> = toAiTool(infoTool);

/** Every compression tool, keyed by the name MCP, Pi and OMP use for it. */
export const compressionAiTools = {
  compressions_compress: compressionsCompressTool,
  compressions_decompress: compressionsDecompressTool,
  compressions_identify: compressionsIdentifyTool,
  compressions_info: compressionsInfoTool,
};
