import { toToolkitTools } from "@agntn/tools/toolkit";
import { defineMcpHandler, getMcpTools } from "@nuxtjs/mcp-toolkit/server";
import { limitedTools } from "../../../src/mcp.ts";
import { serverInfo } from "../../../src/server-info.ts";

/** What one call fits in a 128 MB isolate: a ten layer peel at these limits peaks under 48 MB of heap. */
const WORKER_LIMITS = { input: 262_144, output: 4 * 1024 * 1024, shown: 256 * 1024 } as const;

const compressionMcpTools = toToolkitTools(serverInfo, limitedTools(WORKER_LIMITS));

/** Introduces itself like `compressions mcp`, and serves its tools after the Docus page tools. */
export default defineMcpHandler({
  ...serverInfo,
  tools: async (event) => [...(await getMcpTools({ event })), ...compressionMcpTools],
});
