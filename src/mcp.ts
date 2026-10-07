import { indexTools, invokeTool, ToolInputError, wireSchema } from "@agntn/tools";
import {
  createMcpServer as createToolServer,
  errorResult,
  toolAnnotations,
} from "@agntn/tools/mcp";
import type { CallToolResult, Server, Tool } from "@modelcontextprotocol/server";
import { serverInfo } from "./server-info.ts";
import type { ToolLimits } from "./tool-contract.ts";
import { compressionTools, type CompressionCallContext } from "./tools.ts";

/** The `tools/list` entries shared by `compressions mcp` and the MCP server of the docs site. */
export const toolListings: readonly Tool[] = compressionTools.map((tool) => ({
  name: tool.name,
  title: tool.title,
  description: tool.description,
  inputSchema: { ...wireSchema(tool), type: "object" },
  annotations: toolAnnotations(tool),
}));

const toolsByName = indexTools(compressionTools);

/** What a host running the tools for someone else can add to a call. */
export interface CallToolOptions {
  /** Passed to the tool as is; the synchronous executors finish within their limits anyway. */
  readonly signal?: Readonly<AbortSignal>;
  /** Limits below the tool contract, for a host with less memory than a desktop. */
  readonly limits?: ToolLimits;
}

/**
 * Runs one tool as `tools/call` of `compressions mcp` does: errors as results, never a throw.
 *
 * @param {string} name - The tool's name, such as `compressions_decompress`.
 * @param {Readonly<Record<string, unknown>>} args - The arguments the client sent.
 * @param {CallToolOptions} [options] - A signal, and limits tighter than the tool contract.
 * @returns {Promise<CallToolResult>} The tool's text, or the sanitized error.
 */
export async function callTool(
  name: string,
  args: Readonly<Record<string, unknown>>,
  options: Readonly<CallToolOptions> = {},
): Promise<CallToolResult> {
  const tool = toolsByName.get(name);
  if (!tool) return errorResult(`Unknown compressions tool: ${JSON.stringify(name)}`);
  const context: CompressionCallContext = {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  };
  try {
    const result = await invokeTool(tool, args, context);
    return {
      content: result.content,
      ...(result.isError === undefined ? {} : { isError: result.isError }),
    };
  } catch (error) {
    if (error instanceof ToolInputError) return errorResult(...error.lines);
    return errorResult(
      `${tool.name} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Creates an unconnected MCP server exposing the compression tools.
 *
 * @returns {Server} Unconnected MCP server.
 */
export function createMcpServer(): Server {
  return createToolServer(serverInfo, compressionTools);
}
