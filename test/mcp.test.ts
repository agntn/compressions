import { existsSync } from "node:fs";
import * as zlib from "node:zlib";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { compressionAiTools } from "../src/ai.ts";
import { XZ_CHECKS, deflate, formatInfos, lzma } from "../src/index.ts";
import { createMcpServer } from "../src/mcp.ts";
import { serverInfo } from "../src/server-info.ts";
import { CHECKS, CONTAINERS, DEFAULT_SHOWN_BYTES } from "../src/tool-contract.ts";
import { compressionTools } from "../src/tools.ts";

const openConnections: Array<{ close(): Promise<void> }> = [];

async function connectTestClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client({ name: "compressions-test", version: "1.0.0" });
  openConnections.push(client, server);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

afterEach(async () => {
  await Promise.all(openConnections.splice(0).map((connection) => connection.close()));
});

/**
 * Calls a tool and returns its text and whether it failed.
 * @param name - Tool name.
 * @param args - Arguments.
 * @returns {Promise<{ isError: boolean; text: string }>} The result.
 */
async function call(
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<{ isError: boolean; text: string }> {
  const client = await connectTestClient();
  const response = await client.callTool({ name, arguments: args });
  const [part] = response.content as Array<{ text: string }>;
  return { isError: response.isError === true, text: part?.text ?? "" };
}

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

describe("compressions MCP server", () => {
  it("introduces itself with a description and icons the site serves", async () => {
    const client = await connectTestClient();

    expect(client.getServerVersion()).toEqual(serverInfo);
    for (const icon of serverInfo.icons) {
      const file = new URL(`../docs/public${new URL(icon.src).pathname}`, import.meta.url);
      expect(existsSync(file), icon.src).toBe(true);
    }
  });

  it("advertises every tool as read-only, in one order on every surface", async () => {
    const client = await connectTestClient();
    const { tools } = await client.listTools();
    const names = [
      "compressions_compress",
      "compressions_decompress",
      "compressions_identify",
      "compressions_info",
    ];
    expect(tools.map((tool) => tool.name)).toEqual(names);
    expect(compressionTools.map((tool) => tool.name)).toEqual(names);
    expect(Object.keys(compressionAiTools)).toEqual(names);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      });
    }
  });

  it("keeps the literal lists of the schemas in step with the registry", () => {
    const containers = formatInfos().flatMap((info) =>
      info.containers.length > 1 ? info.containers.map((entry) => entry.name) : [],
    );
    expect([...CONTAINERS].toSorted()).toEqual(containers.toSorted());
    expect([...CHECKS]).toEqual([...XZ_CHECKS]);
  });

  it("compresses text into gzip that node:zlib reads, and names the options it used", async () => {
    const answer = await call("compressions_compress", {
      format: "deflate",
      input: "Hello, MCP",
      options: { container: "gzip", level: 9, name: "hi.txt" },
    });
    expect(answer.isError).toBe(false);
    const [header, data] = answer.text.split("\n");
    expect(header).toBe(
      "deflate (container gzip, level 9, name hi.txt): 10 → 37 bytes, as base64:",
    );
    expect(zlib.gunzipSync(Buffer.from(data!, "base64")).toString()).toBe("Hello, MCP");
  });

  it("takes only the options of the chosen format and container, and names the rest", async () => {
    const answer = await call("compressions_compress", {
      format: "deflate",
      input: "x",
      dataFormat: "hex",
      options: {
        container: "zlib",
        level: 6,
        name: "a",
        mtime: 1,
        check: "crc64",
        checksum: true,
        bits: 12,
      },
    });
    expect(answer.isError).toBe(false);
    const hex = Buffer.from(deflate.compress("x", { container: "zlib" })).toString("hex");
    expect(answer.text).toBe(
      `deflate (container zlib, level 6): 1 → 9 bytes, as hex:\n${hex}\nIgnored, deflate does not take here: name, mtime, check, checksum, bits`,
    );
  });

  it("decompresses, verifies and shows a window of a long result", async () => {
    const text = "0123456789".repeat(5000);
    const data = base64(lzma.compress(text, { container: "xz" }));
    const whole = await call("compressions_decompress", {
      format: "lzma",
      data,
      options: { container: "xz" },
    });
    expect(whole.text.split("\n")[0]).toBe(
      `lzma (container xz) → 50000 bytes, showing 0 to ${DEFAULT_SHOWN_BYTES}; pass offset for the rest, as utf8 (check "crc64", blocks 1):`,
    );
    const window = await call("compressions_decompress", {
      format: "lzma",
      data,
      options: { container: "xz" },
      offset: 49_990,
      length: 100,
    });
    expect(window.text).toBe(
      'lzma (container xz) → 50000 bytes, showing 49990 to 50000; pass offset for the rest, as utf8 (check "crc64", blocks 1):\n"0123456789"',
    );
    const hex = await call("compressions_decompress", {
      format: "zstd",
      data: base64(zlib.zstdCompressSync(Buffer.from([0, 1, 2]))),
      outputFormat: "auto",
    });
    expect(hex.text.split("\n")[1]).toBe("000102");
  });

  it("fails a call on a damaged stream, and shows the start with partial", async () => {
    const packed = deflate.compress("A long enough sentence to be cut in half. ".repeat(100), {
      container: "gzip",
    });
    const cut = base64(packed.subarray(0, packed.length - 30));
    const failed = await call("compressions_decompress", {
      format: "deflate",
      data: cut,
      options: { container: "gzip" },
    });
    expect(failed).toEqual({
      isError: true,
      text: "compressions_decompress failed: deflate: unexpected end of data",
    });
    const partial = await call("compressions_decompress", {
      format: "deflate",
      data: cut,
      options: { container: "gzip" },
      partial: true,
    });
    expect(partial.isError).toBe(false);
    expect(partial.text).toMatch(
      /^deflate \(container gzip\) → \d+ bytes, as utf8 \(error "deflate: unexpected end of data"\):\n"A long enough/u,
    );
  });

  it("points a container named as a format at its format", async () => {
    expect(await call("compressions_decompress", { format: "gzip", data: "AA==" })).toEqual({
      isError: true,
      text: "compressions_decompress failed: gzip is a container, not a format: use deflate with container gzip",
    });
  });

  it("stops a bomb at the tool limit", async () => {
    const bomb = base64(deflate.compress(new Uint8Array(70 * 1024 * 1024), { level: 9 }));
    const answer = await call("compressions_decompress", { format: "deflate", data: bomb });
    expect(answer).toEqual({
      isError: true,
      text: "compressions_decompress failed: deflate: output passes the limit of 67108864 bytes",
    });
  }, 60_000);

  it("ranks candidates and peels layers", async () => {
    const inner = deflate.compress("peel me ".repeat(20), { container: "gzip" });
    const outer = lzma.compress(inner, { container: "xz" });
    const ranked = await call("compressions_identify", { data: base64(inner) });
    expect(ranked.text.split("\n")[0]).toBe("1 candidate, best first:");
    expect(ranked.text).toContain(
      "1. deflate container gzip, confidence 100: starts with its magic number; checksum matches",
    );
    const peeled = await call("compressions_identify", { data: base64(outer), peel: true });
    expect(peeled.text.split("\n").slice(0, 2)).toEqual([
      "2 layers, outermost first:",
      expect.stringMatching(/^1\. lzma container xz, confidence 90/u),
    ]);
    // A binary layer reads as hex, never as a quoted string a model would take for text.
    expect(peeled.text).toContain(`${inner.length} bytes, hex 1f8b08`);
    expect(peeled.text).toContain(`160 bytes, text "peel me peel me`);
    expect(peeled.text).toContain(
      `Innermost, 160 bytes as base64:\n${base64(new TextEncoder().encode("peel me ".repeat(20)))}`,
    );
    const none = await call("compressions_identify", {
      data: base64(new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3])),
    });
    expect(none.text).toBe(
      "No format decompresses these 7 bytes. They start like a ZIP archive, which this package does not open.",
    );
  });

  it("lists the formats and shows one", async () => {
    const all = await call("compressions_info", {});
    expect(all.text.split("\n").filter((line) => !line.startsWith(" "))).toHaveLength(7);
    const one = await call("compressions_info", { format: "lzma" });
    expect(one.text).toContain(
      "  container xz: xz, The .xz File Format 1.2.1, .xz .txz, magic fd377a585a00",
    );
    expect(one.text).toContain(
      "  option check (none, crc32, crc64, sha256): What xz stores after the block to check it, default crc64, xz only",
    );
  });

  it("refuses arguments the schema rejects and escapes values in errors", async () => {
    expect((await call("compressions_decompress", { format: "deflate" })).isError).toBe(true);
    expect(
      (await call("compressions_compress", { format: "deflate", input: "x", extra: 1 })).isError,
    ).toBe(true);
    const bad = await call("compressions_decompress", { format: "deflate", data: "%%%" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(
      /^compressions_decompress failed: Invalid option data=3 characters: is not base64/u,
    );
  });
});
