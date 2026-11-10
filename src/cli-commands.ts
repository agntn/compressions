/**
 * The commands only the CLI gets: a file or stdin byte for byte, raw bytes on stdout, and one flag
 * per format option instead of an `options` object in JSON. Each takes the place of the tool
 * command with its name. Executors load on first call, so `--help` never loads a codec.
 */

import { defineTool, Type, type TObject, type TProperties } from "@agntn/tools";
import { compressSchema } from "./tools.ts";

type CliOperations = typeof import("./cli-operations.ts");

let operations: Promise<CliOperations> | undefined;

/**
 * Loads the executors once. A failed load isn't cached, so a broken `dist` doesn't stick.
 *
 * @returns {Promise<CliOperations>} The executors.
 */
function loadOperations(): Promise<CliOperations> {
  operations ??= import("./cli-operations.ts").catch((error: unknown) => {
    operations = undefined;
    throw error;
  });
  return operations;
}

/**
 * An object schema that refuses keys it does not declare.
 *
 * @param properties - The declared properties.
 * @returns {TObject} The closed object schema.
 */
function closed<T extends TProperties>(properties: T): TObject<T> {
  return Type.Object(properties, { additionalProperties: false });
}

/** How the CLI reads and writes bytes: as they are, or spelled in hex or base64. */
export const BYTE_FORMATS = ["raw", "hex", "base64"] as const;

const { format } = compressSchema.properties;

/** The flags `compress` hands to the format, described and bounded once, in the tool schema. */
export const compressFlags = compressSchema.properties.options.properties;

const from = Type.Optional(
  Type.Enum(BYTE_FORMATS, {
    description: "How the input is written: raw (default), hex or base64",
  }),
);

export const compressCommandSchema = closed({
  format,
  file: Type.String({ minLength: 1, description: "File to compress, or - for stdin" }),
  ...compressFlags,
  from,
  to: Type.Optional(
    Type.Enum(BYTE_FORMATS, {
      description: "How to write the result: raw (default), hex or base64",
    }),
  ),
});

export const decompressCommandSchema = closed({
  format,
  file: Type.String({ minLength: 1, description: "File to decompress, or - for stdin" }),
  container: compressFlags.container,
  limit: Type.Optional(
    Type.Integer({ minimum: 0, description: "Most bytes to write (default 268435456)" }),
  ),
  partial: Type.Optional(
    Type.Boolean({ description: "On a damaged stream, write what came out before the damage" }),
  ),
  from,
  to: Type.Optional(
    Type.Enum(BYTE_FORMATS, {
      description: "How to write the bytes: raw (default), hex or base64",
    }),
  ),
});

export const identifyCommandSchema = closed({
  file: Type.String({ minLength: 1, description: "File to look at, or - for stdin" }),
  peel: Type.Optional(
    Type.Boolean({
      description: "Take off every layer and write the innermost bytes to stdout",
    }),
  ),
  depth: Type.Optional(
    Type.Integer({ minimum: 1, description: "With --peel: most layers (default 10)" }),
  ),
  from,
});

export const compressCommand = defineTool({
  name: "compressions_compress",
  title: "Compress",
  description: "Compress a file or stdin",
  effect: "read",
  input: compressCommandSchema,
  cli: {
    positional: ["format", "file"],
    plain: ["format", "file"],
    short: { to: "o" },
    json: false,
  },
  execute: async (params) => (await loadOperations()).compress(params),
});

export const decompressCommand = defineTool({
  name: "compressions_decompress",
  title: "Decompress",
  description: "Decompress a file or stdin",
  effect: "read",
  input: decompressCommandSchema,
  cli: {
    positional: ["format", "file"],
    plain: ["format", "file"],
    short: { to: "o" },
    json: false,
  },
  execute: async (params) => (await loadOperations()).decompress(params),
});

export const identifyCommand = defineTool({
  name: "compressions_identify",
  title: "Identify Compression",
  description: "Rank the formats a file decompresses in, or peel them off layer by layer",
  effect: "read",
  input: identifyCommandSchema,
  cli: { positional: ["file"], plain: ["file"] },
  execute: async (params, context) => (await loadOperations()).identify(params, context.host),
});

/** The commands that take the place of the generated ones with their names. */
export const cliCommands = [compressCommand, decompressCommand, identifyCommand];
