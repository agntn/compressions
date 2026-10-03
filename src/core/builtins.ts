import { brotli } from "./brotli.ts";
import { bzip2 } from "./bzip2.ts";
import { deflate } from "./deflate.ts";
import { lz4 } from "./lz4.ts";
import { lzma } from "./lzma.ts";
import { lzw } from "./lzw.ts";
import type { Compression } from "./types.ts";
import { zstd } from "./zstd.ts";

/** The built-in formats in listing order, as `compressionFormats` names them. */
export const builtins: readonly Compression[] = [deflate, bzip2, lzma, zstd, brotli, lz4, lzw];
