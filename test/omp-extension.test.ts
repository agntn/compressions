import { ToolInputError, wireSchema } from "@agntn/tools";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";

/** Compiled OMP injects no TUI barrel, so loading it has to fail the test. */
vi.mock("@oh-my-pi/pi-coding-agent/tui", () => {
  throw new Error("The OMP host does not inject the TUI barrel");
});

import compressionsExtension from "../packages/omp/extensions/compressions.ts";
import { compressionTools } from "../src/tools.ts";
import {
  ompTestTheme as theme,
  ompToolContext,
  registerOmpExtension,
} from "./fixtures/omp-host.ts";

const CONTROL_BYTES = /\p{Cc}/u;

async function registerTool(name: string): Promise<ToolDefinition> {
  return (await registerOmpExtension(compressionsExtension)).tool(name);
}

function renderedText(component: unknown): string {
  return (component as { text: string }).text;
}

describe("omp compressions extension", () => {
  it("registers every tool as read-approval tools under one label", async () => {
    const host = await registerOmpExtension(compressionsExtension);

    expect([...host.tools.keys()]).toEqual(compressionTools.map((tool) => tool.name));
    expect(host.labels).toEqual(["Compressions"]);
    for (const definition of compressionTools) {
      const tool = host.tool(definition.name);
      expect(tool.approval).toBe("read");
      expect(tool.parameters).toEqual(wireSchema(definition));
    }
  });

  it("refuses arguments the schema rejects", async () => {
    const tool = await registerTool("compressions_compress");

    await expect(
      tool.execute("call-1", { format: "deflate" }, undefined, undefined, ompToolContext),
    ).rejects.toBeInstanceOf(ToolInputError);
  });

  it("executes against the library and returns structured details", async () => {
    const tool = await registerTool("compressions_compress");

    const result = await tool.execute(
      "call-1",
      { format: "deflate", input: "Hello", options: { level: 0 } },
      undefined,
      undefined,
      ompToolContext,
    );

    expect(result.details).toEqual({
      format: "deflate",
      options: { container: "raw", level: 0 },
      data: "AQUA+v9IZWxsbw==",
      dataFormat: "base64",
      inputLength: 5,
      outputLength: 10,
    });
  });

  it("draws the call with the format and a preview of the data", async () => {
    const tool = await registerTool("compressions_decompress");

    const text = renderedText(
      tool.renderCall?.(
        { format: "deflate", data: "AQUA+v9IZWxsbw==" },
        { expanded: false, isPartial: false },
        theme,
      ),
    );

    expect(text).toBe("success:status.done accent(Decompress): muted(deflate AQUA+v9IZWxsbw==)");
  });

  it("sanitizes model arguments and cuts long ones before sanitizing", async () => {
    const tool = await registerTool("compressions_identify");
    const hostile = { data: "\u001B]0;evil\u0007a\u2028b\u202Ec\nnext" };

    const text = renderedText(
      tool.renderCall?.(hostile, { expanded: false, isPartial: false }, theme),
    );
    expect(text).not.toMatch(CONTROL_BYTES);
    expect(text).not.toMatch(/[\u2028\u202E]/u);

    const started = performance.now();
    tool.renderCall?.(
      { data: "\u001B]".repeat(100_000) },
      { expanded: false, isPartial: true },
      theme,
    );
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("survives arguments that violate the declared types", async () => {
    const tool = await registerTool("compressions_compress");

    const text = renderedText(
      tool.renderCall?.(
        { format: 42, input: { a: 1 } },
        { expanded: false, isPartial: true },
        theme,
      ),
    );

    expect(text).toBe('muted:status.pending accent(Compress): muted(42 {"a":1})');
  });

  it("summarizes results and sanitizes their data", async () => {
    const decode = await registerTool("compressions_decompress");
    const identify = await registerTool("compressions_identify");

    const decoded = renderedText(
      decode.renderResult?.(
        {
          content: [{ type: "text" as const, text: "ok" }],
          details: { value: "evil\u001B[31m\u009Bline", byteLength: 9 },
        },
        { expanded: false, isPartial: false },
        theme,
      ),
    );
    expect(decoded).not.toMatch(CONTROL_BYTES);
    expect(decoded).toContain("9 bytes");

    const ranked = renderedText(
      identify.renderResult?.(
        {
          content: [{ type: "text" as const, text: "ok" }],
          details: {
            candidates: [
              { format: "deflate", container: "gzip", confidence: 100 },
              { format: "brotli", container: "brotli", confidence: 25 },
            ],
          },
        },
        { expanded: false, isPartial: false },
        theme,
      ),
    );
    expect(ranked).toContain("deflate gzip 100");
  });

  it("marks an error result with the error icon and no meta", async () => {
    const tool = await registerTool("compressions_info");
    const result = { content: [{ type: "text" as const, text: "boom" }], isError: true };

    const text = renderedText(
      tool.renderResult?.(result, { expanded: false, isPartial: false }, theme),
    );

    expect(text).toBe("error:status.error accent(Compression Formats) accent([read])");
  });
});
