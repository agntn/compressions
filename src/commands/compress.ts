import { defineCommand } from "citty";
import { create } from "../core/registry.ts";
import { fromFormat, integerFlag, readSource, typedFlags, writeOutput } from "./shared.ts";

/** Flags that set compress options, by the option name they set. */
const OPTION_FLAGS = ["container", "level", "name", "mtime", "check", "checksum", "bits"] as const;
/** Options the format reads as numbers. */
const NUMBER_OPTIONS = new Set(["level", "mtime", "bits"]);

export default defineCommand({
  meta: { name: "compress", description: "Compress a file or stdin" },
  args: {
    format: {
      type: "positional",
      description: "Format: deflate, bzip2, lzma, lz4 or lzw (compressions list)",
      required: true,
    },
    file: { type: "positional", description: "File to compress, or - for stdin", required: true },
    container: {
      type: "string",
      description: "deflate: raw, zlib or gzip. lzma: alone or xz. lz4: frame or legacy",
    },
    level: { type: "string", description: "deflate 0-9, lzma 0-9, bzip2 1-9" },
    name: { type: "string", description: "deflate with --container gzip: file name in the header" },
    mtime: {
      type: "string",
      description: "deflate with --container gzip: modification time, Unix seconds",
    },
    check: {
      type: "string",
      description: "lzma with --container xz: none, crc32, crc64 or sha256",
    },
    checksum: { type: "boolean", description: "lz4 frame: XXH32 of the content (default on)" },
    bits: { type: "string", description: "lzw: widest code, 10 to 16" },
    from: {
      type: "string",
      description: "How the input is written: raw (default), hex or base64",
      default: "raw",
    },
    to: {
      type: "string",
      alias: "o",
      description: "How to write the result: raw (default), hex or base64",
      default: "raw",
    },
  },
  run({ args, rawArgs }) {
    const format = create(args.format);
    const flagged = typedFlags(OPTION_FLAGS, args, rawArgs);
    const options = Object.fromEntries(
      Object.entries(flagged).map(([key, value]) => [
        key,
        NUMBER_OPTIONS.has(key) ? integerFlag(key, value) : value,
      ]),
    );
    const input = fromFormat(readSource(args.file), args.from);
    writeOutput(format.compress(input, options), args.to, true);
  },
});
