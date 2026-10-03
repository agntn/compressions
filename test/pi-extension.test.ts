import { fileURLToPath } from "node:url";

import { wireSchema } from "@agntn/tools";
import { describe, expect, it } from "vite-plus/test";

import { compressionTools } from "../src/tools.ts";
import { loadPiExtension } from "./fixtures/pi-host.ts";

const extensionPath = fileURLToPath(
  new URL("../packages/pi/extensions/compressions.ts", import.meta.url),
);

describe("pi compressions extension", () => {
  it("registers every tool with the shared schemas", async () => {
    const host = await loadPiExtension(extensionPath);

    expect([...host.tools.keys()]).toEqual(compressionTools.map((tool) => tool.name));
    for (const definition of compressionTools) {
      expect(host.tool(definition.name).parameters).toEqual(wireSchema(definition));
    }
  });

  it("executes through the shared executor and returns structured details", async () => {
    const host = await loadPiExtension(extensionPath);

    const result = await host.tool("compressions_decompress").execute(
      "call-1",
      {
        format: "deflate",
        data: "H4sIAAAAAAAA/8tIzcnJBwCGphA2BQAAAA==",
        options: { container: "gzip" },
      },
      undefined,
      undefined,
      host.context,
    );

    expect(result.content[0]?.type).toBe("text");
    expect(result.details).toMatchObject({
      format: "deflate",
      container: "gzip",
      value: "hello",
      byteLength: 5,
    });
  });

  it("fails the call on arguments the schema rejects and on a broken stream", async () => {
    const host = await loadPiExtension(extensionPath);
    const decompress = host.tool("compressions_decompress");

    // Pi records every returned value as a successful call; only a throw fails it.
    await expect(
      decompress.execute("call-1", { format: "deflate" }, undefined, undefined, host.context),
    ).rejects.toThrow("Invalid arguments");
    await expect(
      decompress.execute(
        "call-2",
        {
          format: "deflate",
          data: "H4sIAAAAAAAA/8tIzcnJBwCGphA2BAAAAA==",
          options: { container: "gzip" },
        },
        undefined,
        undefined,
        host.context,
      ),
    ).rejects.toThrow("gzip size does not match");
  });
});
