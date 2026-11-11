import type { ToolkitTool } from "@agntn/tools/toolkit";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Client as SiteClient } from "../docs/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { InMemoryTransport as SiteTransport } from "../docs/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js";
import { McpServer } from "../docs/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js";
import type { CallToolResult } from "../docs/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { deflate } from "../src/index.ts";
import { callTool, createMcpServer, toolListings } from "../src/mcp.ts";

/* The toolkit's entry pulls in Nitro, so the handler gets its options back and two page tools. */
vi.mock(
  "../docs/node_modules/@nuxtjs/mcp-toolkit/dist/runtime/server/mcp/definitions/index.js",
  () => ({
    defineMcpHandler: (options: unknown) => options,
    getMcpTools: async () => [{ name: "list-pages" }, { name: "get-page" }],
  }),
);

const openConnections: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(openConnections.splice(0).map((connection) => connection.close()));
});

/* What `server/mcp/index.ts` serves for one request, Docus page tools included. */
async function docsTools(): Promise<ReadonlyArray<Readonly<ToolkitTool>>> {
  const { default: handler } = await import("../docs/server/mcp/index.ts");
  const { tools } = handler;
  if (typeof tools !== "function") throw new TypeError("the handler should resolve its tools");
  return (await tools(undefined as never)) as ToolkitTool[];
}

/* An SDK client on every compression tool of the docs, through the SDK copy the worker runs. */
async function siteClient(): Promise<SiteClient> {
  const server = new McpServer({ name: "compressions-docs", version: "0.0.0" });
  for (const tool of await docsTools()) {
    if (!tool.name.startsWith("compressions_")) continue;
    const handler = tool.handler as (args: unknown) => Promise<CallToolResult>;
    server.registerTool(tool.name, tool as never, handler);
  }
  const [clientTransport, serverTransport] = SiteTransport.createLinkedPair();
  const client = new SiteClient({ name: "compressions-docs-test", version: "0.0.0" });
  openConnections.push(client, server);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** Calls that cover a plain answer, a codec failure, a schema miss and an unknown tool. */
const CALLS: ReadonlyArray<[string, Record<string, unknown>]> = [
  [
    "compressions_compress",
    { format: "deflate", input: "hello world!", options: { container: "gzip" } },
  ],
  ["compressions_decompress", { format: "deflate", data: base64(deflate.compress("hi")) }],
  ["compressions_decompress", { format: "deflate", data: "AA==", options: { container: "gzip" } }],
  ["compressions_compress", { format: "deflate", input: "x", levle: 9 }],
  ["compressions_identify", { data: base64(deflate.compress("peel me", { container: "gzip" })) }],
  ["compressions_info", { format: "lzma" }],
  ["compressions_nope", {}],
];

/** Tighter than the tool contract, as a host with less memory passes them. */
const SMALL = { input: 64, output: 1024, shown: 8 };

describe("docs MCP tools", () => {
  it("serves every tool `compressions mcp` lists after the Docus page tools", async () => {
    expect((await docsTools()).map((tool) => tool.name)).toEqual([
      "list-pages",
      "get-page",
      ...toolListings.map((tool) => tool.name),
    ]);
    const listed = (await (await siteClient()).listTools()).tools;
    /* SDK v1 adds `$schema` to every listed schema; the rest is the listing as written. */
    const schemas = listed.map(({ name, inputSchema }) => ({
      name,
      schema: { ...inputSchema, $schema: undefined },
    }));
    expect(schemas).toEqual(
      toolListings.map(({ name, inputSchema }) => ({ name, schema: inputSchema })),
    );
  });

  it("lists and answers exactly as the stdio server does", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: "compressions-docs-test", version: "1.0.0" });
    openConnections.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const site = await siteClient();

    const { tools } = await client.listTools();
    expect(toolListings).toEqual(tools);
    for (const [name, args] of CALLS) {
      const viaServer = await client.callTool({ name, arguments: args });
      expect(await callTool(name, args), name).toEqual(viaServer);
      if (name === "compressions_nope") continue;
      expect(await site.callTool({ name, arguments: args }), name).toEqual(viaServer);
    }
  });

  it("answers a bad key in the library's sanitized words, not Zod's", async () => {
    const site = await siteClient();
    const args = { format: "deflate", input: "x", "a\u202Eb": 1 };
    const served = await site.callTool({ name: "compressions_compress", arguments: args });
    expect(served.isError).toBe(true);
    expect(served.content).toEqual((await callTool("compressions_compress", args)).content);
    expect(JSON.stringify(served.content)).not.toContain("\u202E");
  });

  it("holds a call to the worker's limits, not the tool contract's", async () => {
    const site = await siteClient();
    const args = { format: "deflate", input: "x".repeat(262_145) };
    const served = await site.callTool({ name: "compressions_compress", arguments: args });
    expect(served.isError).toBe(true);
    expect(served.content).toEqual([
      {
        type: "text",
        text: "compressions_compress failed: Invalid option input=262145 characters: must be 0 to 262144 characters",
      },
    ]);
    expect((await callTool("compressions_compress", args)).isError).toBeFalsy();
  });

  it("reads a call without arguments as `{}`, like `compressions mcp`", async () => {
    const client = await siteClient();
    const served = await client.callTool({ name: "compressions_info" });
    expect(served.isError).toBeFalsy();
    expect(served.content).toEqual((await callTool("compressions_info", {})).content);

    const required = await client.callTool({ name: "compressions_identify" });
    expect(required.isError).toBe(true);
    expect(required.content).toEqual((await callTool("compressions_identify", {})).content);
  });

  it("holds a call to the host's limits when it passes tighter ones", async () => {
    const packed = deflate.compress(new Uint8Array(4096));
    const bomb = base64(packed);
    const decompress = { format: "deflate", data: bomb };
    expect(await callTool("compressions_decompress", decompress, { limits: SMALL })).toEqual({
      content: [
        {
          type: "text",
          text: "compressions_decompress failed: deflate: output passes the limit of 1024 bytes",
        },
      ],
      isError: true,
    });
    const shown = await callTool(
      "compressions_decompress",
      { format: "deflate", data: base64(deflate.compress("0123456789")) },
      { limits: SMALL },
    );
    expect(shown.content).toEqual([
      {
        type: "text",
        text: 'deflate (container raw) → 10 bytes, showing 0 to 8; pass offset for the rest, as utf8:\n"01234567"',
      },
    ]);
    const long = await callTool(
      "compressions_compress",
      { format: "deflate", input: "x".repeat(65) },
      { limits: SMALL },
    );
    expect(long.isError).toBe(true);
    expect(long.content).toEqual([
      {
        type: "text",
        text: "compressions_compress failed: Invalid option input=65 characters: must be 0 to 64 characters",
      },
    ]);
    const peeled = await callTool(
      "compressions_identify",
      { data: bomb, peel: true },
      { limits: SMALL },
    );
    const [layer] = (peeled.content[0] as { text: string }).text.split("\n").slice(1);
    expect(layer).toBe(
      "1. deflate container raw, confidence 5, unconfirmed: output passes the limit of 1024 bytes, cut there; comes out longer than it went in",
    );
    const cut = deflate.compress("a".repeat(2000), { container: "gzip" });
    const identified = await callTool(
      "compressions_identify",
      { data: base64(cut) },
      { limits: SMALL },
    );
    expect((identified.content[0] as { text: string }).text.split("\n")).toEqual([
      "1 candidate, best first:",
      "1. deflate container gzip, confidence 65: starts with its magic number; output passes the limit of 1024 bytes, cut there; decompresses to readable text; comes out longer than it went in",
      `   1024 bytes, text "${"a".repeat(200)}"`,
      "Next: compressions_decompress with the format and container, or set peel for nested layers. For a candidate cut at the limit, set partial to take the bytes under it.",
    ]);
    const cutPeel = await callTool(
      "compressions_identify",
      { data: base64(cut), peel: true },
      { limits: SMALL },
    );
    expect((cutPeel.content[0] as { text: string }).text.split("\n").slice(-2)).toEqual([
      "Innermost, 1024 bytes, cut at the limit. The first 8 as base64:",
      base64(new TextEncoder().encode("a".repeat(8))),
    ]);
    const unbounded = await callTool("compressions_identify", { data: bomb, peel: true });
    expect((unbounded.content[0] as { text: string }).text).toMatch(/^1 layer,/u);
  });
});
