import { defineCommand } from "citty";
import { shown } from "../core/errors.ts";
import { create } from "../core/registry.ts";
import { fromFormat, integerFlag, readSource, writeOutput } from "./shared.ts";

export default defineCommand({
  meta: { name: "decompress", description: "Decompress a file or stdin" },
  args: {
    format: {
      type: "positional",
      description:
        "Format: deflate, bzip2, lzma, zstd, brotli, lz4 or lzw (compressions identify names it)",
      required: true,
    },
    file: { type: "positional", description: "File to decompress, or - for stdin", required: true },
    container: {
      type: "string",
      description: "deflate: raw, zlib or gzip. lzma: alone or xz. lz4: frame or legacy",
    },
    limit: { type: "string", description: "Most bytes to write (default 268435456)" },
    partial: {
      type: "boolean",
      description: "On a damaged stream, write what came out before the damage",
    },
    from: {
      type: "string",
      description: "How the input is written: raw (default), hex or base64",
      default: "raw",
    },
    to: {
      type: "string",
      alias: "o",
      description: "How to write the bytes: raw (default), hex or base64",
      default: "raw",
    },
  },
  run({ args }) {
    const format = create(args.format);
    const data = fromFormat(readSource(args.file), args.from);
    const { bytes, details } = format.decompress(data, {
      ...(args.container === undefined ? {} : { container: args.container }),
      ...(args.limit === undefined ? {} : { limit: integerFlag("limit", args.limit) }),
      partial: args.partial === true,
    });
    for (const [key, value] of Object.entries(details))
      process.stderr.write(`${key}: ${shown(value)}\n`);
    writeOutput(bytes, args.to, false);
  },
});
