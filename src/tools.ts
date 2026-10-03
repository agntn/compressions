/** The compression tools, declared once for MCP, Pi, OMP and the AI SDK. Executors load on first call. */

import {
  defineTool,
  Type,
  type TObject,
  type TProperties,
  type ToolDefinition,
} from "@agntn/tools";
import { compressionFormats } from "./core/types.ts";
import {
  CHECKS,
  CONTAINERS,
  DATA_FORMATS,
  DEFAULT_SHOWN_BYTES,
  INPUT_FORMATS,
  MAX_INPUT_LENGTH,
  MAX_LAYERS,
  MAX_NAME_LENGTH,
  MAX_OUTPUT_BYTES,
  MAX_SHOWN_BYTES,
  OUTPUT_FORMATS,
} from "./tool-contract.ts";

type ToolOperations = typeof import("./tool-operations.ts");

let operations: Promise<ToolOperations> | undefined;

/**
 * Loads the executors once. A failed load isn't cached, so a broken `dist` doesn't stick.
 *
 * @returns {Promise<ToolOperations>} The executors.
 */
export function loadOperations(): Promise<ToolOperations> {
  operations ??= import("./tool-operations.ts").catch((error: unknown) => {
    operations = undefined;
    throw error;
  });
  return operations;
}

/**
 * An object schema that rejects keys it does not declare, so a misspelled optional argument
 * fails instead of being dropped.
 *
 * @param properties - The declared properties.
 * @returns {TObject} The closed object schema.
 */
function closed<T extends TProperties>(properties: T): TObject<T> {
  return Type.Object(properties, { additionalProperties: false });
}

const format = Type.String({
  minLength: 1,
  maxLength: MAX_NAME_LENGTH,
  description: `Format: ${compressionFormats.join(", ")}. gzip and zlib are deflate containers, xz is an lzma container`,
});
const container = Type.Optional(
  Type.Enum(CONTAINERS, {
    description:
      "deflate: raw (default), zlib or gzip. lzma: alone (.lzma, default) or xz. lz4: frame (default) or legacy",
  }),
);
const dataFormat = Type.Optional(
  Type.Enum(DATA_FORMATS, {
    description: "How the compressed bytes are written: base64 (default) or hex",
  }),
);
const data = Type.String({
  minLength: 1,
  maxLength: MAX_INPUT_LENGTH,
  description: "Compressed bytes, written as dataFormat says",
});

export const compressSchema = closed({
  format,
  input: Type.String({
    maxLength: MAX_INPUT_LENGTH,
    description: "What to compress: text, or bytes written as inputFormat says",
  }),
  inputFormat: Type.Optional(
    Type.Enum(INPUT_FORMATS, {
      description: "How to read input: utf8 text (default), or bytes in hex or base64",
    }),
  ),
  dataFormat,
  options: Type.Optional(
    closed({
      container,
      level: Type.Optional(
        Type.Integer({
          minimum: 0,
          maximum: 9,
          description:
            "deflate: 0 stores to 9 smallest (default 6). lzma: preset 0 to 9 (default 6). bzip2: block size 1 to 9 (default 9)",
        }),
      ),
      name: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 255,
          description: "deflate with container gzip: file name in the header",
        }),
      ),
      mtime: Type.Optional(
        Type.Integer({
          minimum: 0,
          maximum: 0xffffffff,
          description: "deflate with container gzip: modification time, Unix seconds",
        }),
      ),
      check: Type.Optional(
        Type.Enum(CHECKS, {
          description: "lzma with container xz: none, crc32, crc64 (default) or sha256",
        }),
      ),
      checksum: Type.Optional(
        Type.Boolean({ description: "lz4 frame: XXH32 of the content (default true)" }),
      ),
      bits: Type.Optional(
        Type.Integer({
          minimum: 10,
          maximum: 16,
          description: "lzw: widest code, 10 to 16 (default 16)",
        }),
      ),
    }),
  ),
});

export const decompressSchema = closed({
  format,
  data,
  dataFormat,
  outputFormat: Type.Optional(
    Type.Enum(OUTPUT_FORMATS, {
      description:
        "How to show the bytes: auto (UTF-8 when they are readable text, else hex; default), utf8, hex or base64",
    }),
  ),
  offset: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: MAX_OUTPUT_BYTES,
      description: "First decompressed byte to show (default 0)",
    }),
  ),
  length: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_SHOWN_BYTES,
      description: `Most decompressed bytes to show (default ${DEFAULT_SHOWN_BYTES})`,
    }),
  ),
  partial: Type.Optional(
    Type.Boolean({
      description: "On a truncated or damaged stream, show what came out before the damage",
    }),
  ),
  options: Type.Optional(closed({ container })),
});

export const identifySchema = closed({
  data,
  dataFormat,
  peel: Type.Optional(
    Type.Boolean({
      description: "Take off one layer at a time while each is confirmed, and list every layer",
    }),
  ),
  depth: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_LAYERS,
      description: `With peel: most layers (default ${MAX_LAYERS})`,
    }),
  ),
});

export const infoSchema = closed({
  format: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: MAX_NAME_LENGTH,
      description: "Show one format with its containers and options",
    }),
  ),
});

/** The containers that stand for formats other libraries name on their own. */
const CONTAINER_NOTE =
  "A container is an option of its format: gzip is deflate with container gzip, zlib is deflate with container zlib, xz is lzma with container xz.";

export const compressTool = defineTool({
  name: "compressions_compress",
  title: "Compress",
  description:
    "Compress text or bytes as deflate (raw, zlib or gzip), bzip2, lzma (.lzma or xz), lz4 (frame or legacy) or Unix compress (.Z). The result comes back in base64 or hex.",
  snippet: "Use compressions_compress to make gzip, zlib, bzip2, xz, lz4 or .Z bytes.",
  guidelines: [
    "Text is compressed as UTF-8. For bytes, pass them in hex or base64 and set inputFormat.",
    CONTAINER_NOTE,
    "zstd and brotli are read only. Only the options of the chosen format and container apply; others are named in the reply.",
  ],
  effect: "read",
  input: compressSchema,
  execute: async (params) => (await loadOperations()).compressionsCompress(params),
});

export const decompressTool = defineTool({
  name: "compressions_decompress",
  title: "Decompress",
  description:
    "Decompress bytes in a named format: deflate (raw, zlib, gzip), bzip2, lzma (.lzma, xz), zstd, brotli, lz4 or Unix compress. Checksums are verified, and the reply names what the stream carried, such as a gzip file name.",
  snippet: "Use compressions_decompress when you know the format of compressed bytes.",
  guidelines: [
    "Unsure which format it is? Call compressions_identify first; it names the format and container.",
    CONTAINER_NOTE,
    `Long output comes in windows of length bytes from offset. Streams stop at ${MAX_OUTPUT_BYTES / 1024 / 1024} MiB.`,
    "A truncated or corrupt stream fails; set partial to see what came out before the damage.",
  ],
  effect: "read",
  input: decompressSchema,
  execute: async (params) => (await loadOperations()).compressionsDecompress(params),
});

export const identifyTool = defineTool({
  name: "compressions_identify",
  title: "Identify Compression",
  description:
    "Rank the formats some bytes decompress in, by trying each whose start fits: magic numbers, valid headers, checksums that match, output that reads as text. With peel, take off nested layers such as gzip inside xz.",
  snippet: "Use compressions_identify on compressed bytes whose format nobody named.",
  guidelines: [
    "The confidence ranks candidates; it is not a probability. A magic number with a matching checksum is the strongest evidence.",
    "Raw deflate and brotli have no magic number; they count only when they decode to the last byte.",
    "With peel, a last layer marked unconfirmed is only the best guess.",
  ],
  effect: "read",
  input: identifySchema,
  execute: async (params) => (await loadOperations()).compressionsIdentify(params),
});

export const infoTool = defineTool({
  name: "compressions_info",
  title: "Compression Formats",
  description:
    "List the formats with their containers, magic numbers, checksums and options, or show one.",
  snippet: "Use compressions_info to see which formats and options exist.",
  guidelines: [CONTAINER_NOTE],
  effect: "read",
  input: infoSchema,
  execute: async (params) => (await loadOperations()).compressionsInfo(params),
});

/** The compression tools, in the order every surface lists them. */
export const compressionTools: readonly ToolDefinition[] = [
  compressTool,
  decompressTool,
  identifyTool,
  infoTool,
];
