export type { BytesInput } from "./bytes.ts";
export { DEFAULT_LIMIT } from "./bytes.ts";
export {
  compressionFormats,
  type Compression,
  type CompressionContainer,
  type CompressionFormat,
  type CompressionInfo,
  type CompressionOption,
  type CompressOptions,
  type Decompressed,
  type Details,
  type DecompressOptions,
} from "./types.ts";
export {
  ChecksumError,
  CompressionError,
  DecompressError,
  InvalidOptionError,
  LimitError,
  UnknownFormatError,
  UnsupportedError,
  normalizeError,
  type DecompressErrorOptions,
} from "./errors.ts";
export { defineCompression, type CompressionSpec } from "./define.ts";
export { DEFLATE_CONTAINERS, deflate, type DeflateContainer } from "./deflate.ts";
export { bzip2 } from "./bzip2.ts";
export { LZMA_CONTAINERS, XZ_CHECKS, lzma, type LzmaContainer, type XzCheck } from "./lzma.ts";
export { zstd } from "./zstd.ts";
export { brotli } from "./brotli.ts";
export { LZ4_CONTAINERS, lz4, type Lz4Container } from "./lz4.ts";
export { lzw } from "./lzw.ts";
export {
  compress,
  create,
  decompress,
  formatInfos,
  formats,
  has,
  register,
  resolveFormat,
} from "./registry.ts";
export {
  archiveOf,
  identify,
  peel,
  type CompressionCandidate,
  type IdentifyOptions,
  type PeelOptions,
} from "./identify.ts";
