import oxfmt from "@agntn/ox/oxfmt";
import oxlint from "@agntn/ox/oxlint";
import { defineConfig } from "vite-plus";

const readonlyParams = oxlint.rules?.["typescript/prefer-readonly-parameter-types"];
if (!Array.isArray(readonlyParams)) {
  throw new TypeError("@agntn/ox no longer configures typescript/prefer-readonly-parameter-types");
}
const [severity, options] = readonlyParams;

export default defineConfig({
  fmt: { ...oxfmt, ignorePatterns: ["/CHANGELOG.md", "docs", ".scratch"] },
  lint: {
    ...oxlint,
    rules: {
      ...oxlint.rules,
      "typescript/prefer-readonly-parameter-types": [
        severity,
        {
          ...options,
          allow: [
            ...(options?.allow ?? []),
            /* TypedArrays have no readonly form in the TS lib, and codecs write output into them. */
            { from: "lib", name: ["Uint8Array", "Uint16Array", "Uint32Array", "Int32Array"] },
            /* Decoders write into the output, move the readers and adapt the models: mutable by design. */
            {
              from: "file",
              name: [
                "BackwardReader",
                "Block",
                "Blocks",
                "Compression",
                "CompressionCandidate",
                "CompressionContainer",
                "CompressionInfo",
                "CompressionOption",
                "CompressionSpec",
                "Decompressed",
                "Deflater",
                "Details",
                "ForwardBits",
                "FrameState",
                "LiteralCursor",
                "IdentifyCandidate",
                "InflateReader",
                "LengthProbabilities",
                "LengthRun",
                "MetaBlock",
                "LsbReader",
                "LsbWriter",
                "LzmaEncoder",
                "LzmaModel",
                "MsbReader",
                "MsbWriter",
                "Output",
                "RangeDecoder",
                "RangeEncoder",
                "Sorted",
                "StreamState",
                "ToolResult",
              ],
            },
            { from: "package", name: ["OmpResultView"], package: "@agntn/tools" },
          ],
        },
      ],
    },
    ignorePatterns: ["docs", ".scratch"],
  },
});
