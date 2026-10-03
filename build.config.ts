import { defineBuildConfig } from "obuild/config";

/** One subpath per format, so a caller that needs gzip loads deflate without the registry. */
export const formatEntries = ["deflate", "bzip2", "lzma", "zstd", "brotli", "lz4", "lzw"] as const;

export default defineBuildConfig({
  entries: [
    {
      /** One bundle, so every entry shares the registry the MCP server reads. */
      type: "bundle",
      input: [
        "./src/index.ts",
        "./src/cli.ts",
        "./src/ai.ts",
        "./src/mcp.ts",
        "./src/tools.ts",
        ...formatEntries.map((name) => `./src/${name}.ts`),
      ],
    },
  ],
});
