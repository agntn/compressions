/**
 * Finds what compressed some bytes: each format and container whose start fits, tried for real,
 * ranked by what the attempt showed. `peel` repeats it while each layer is backed by evidence.
 */
import { compressedBytes, DEFAULT_LIMIT, limitOption } from "./bytes.ts";
import { DecompressError, LimitError } from "./errors.ts";
import { create, formats } from "./registry.ts";
import type { Details } from "./types.ts";

/** How sure the start of the bytes makes a container. */
type Fit = "magic" | "header" | "none";

/** A way some bytes decompress. */
export interface CompressionCandidate {
  /** Registry name. */
  format: string;
  /** The container, as `decompress` takes it. */
  container: string;
  /** 0 to 100; ranks candidates, not a probability. */
  confidence: number;
  /** What the attempt showed, strongest first. */
  reasons: string[];
  /** The decompressed bytes. */
  bytes: Uint8Array;
  /** What the stream said about itself. */
  details: Record<string, string | number | boolean>;
  /** Whether a magic number, or a checked header and checksum, backs it. */
  confirmed: boolean;
  /** Whether the output passed the limit, so `bytes` holds only its first `limit` bytes. */
  limited: boolean;
}

/** Options of `identify`. */
export interface IdentifyOptions {
  /** Most bytes one attempt may write. Default: 256 MiB. */
  limit?: number;
}

/** Options of `peel`. */
export interface PeelOptions extends IdentifyOptions {
  /** Most layers to take off. Default: 10. */
  depth?: number;
}

/** A container this package writes or reads, and how its start is checked. */
interface Probe {
  format: string;
  container: string;
  fit: (bytes: Uint8Array) => Fit | undefined;
  /** Whether a stream carries a checksum that decoding verified. */
  checksum: boolean;
}

const startsWith = (bytes: Uint8Array, magic: readonly number[]): boolean =>
  magic.every((byte, i) => bytes[i] === byte);

/** Archives this package does not open, by their start, for a note when nothing else fits. */
const ARCHIVES: readonly (readonly [string, readonly number[], number])[] = [
  ["a ZIP archive", [0x50, 0x4b, 0x03, 0x04], 0],
  ["an empty ZIP archive", [0x50, 0x4b, 0x05, 0x06], 0],
  ["a 7-Zip archive", [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], 0],
  ["a RAR archive", [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07], 0],
  ["a tar archive", [0x75, 0x73, 0x74, 0x61, 0x72], 257],
  ["a Microsoft cabinet", [0x4d, 0x53, 0x43, 0x46], 0],
  ["an lzip file", [0x4c, 0x5a, 0x49, 0x50], 0],
  ["a PNG image, whose IDAT chunks hold zlib", [0x89, 0x50, 0x4e, 0x47], 0],
];

const PROBES: readonly Probe[] = [
  {
    format: "deflate",
    container: "gzip",
    checksum: true,
    fit: (b) => (startsWith(b, [0x1f, 0x8b, 0x08]) ? "magic" : undefined),
  },
  {
    format: "deflate",
    container: "zlib",
    checksum: true,
    fit: (b) =>
      b.length >= 6 &&
      (b[0]! & 15) === 8 &&
      b[0]! >>> 4 <= 7 &&
      ((b[0]! << 8) | b[1]!) % 31 === 0 &&
      !(b[1]! & 0x20)
        ? "header"
        : undefined,
  },
  { format: "deflate", container: "raw", checksum: false, fit: () => "none" },
  {
    format: "bzip2",
    container: "bzip2",
    checksum: true,
    fit: (b) =>
      startsWith(b, [0x42, 0x5a, 0x68]) && b[3]! >= 0x31 && b[3]! <= 0x39 ? "magic" : undefined,
  },
  {
    format: "lzma",
    container: "xz",
    checksum: true,
    fit: (b) => (startsWith(b, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]) ? "magic" : undefined),
  },
  {
    format: "lzma",
    container: "alone",
    checksum: false,
    fit: (b) => {
      if (b.length < 14 || b[0]! >= 225) return undefined;
      const dictionary = (b[1]! | (b[2]! << 8) | (b[3]! << 16) | (b[4]! << 24)) >>> 0;
      const unknownSize = b.subarray(5, 13).every((byte) => byte === 0xff);
      const sizeField = unknownSize || (b[11] === 0 && b[12] === 0);
      return sizeField && b[13] === 0 && dictionary >= 4096 ? "header" : undefined;
    },
  },
  {
    format: "zstd",
    container: "zstd",
    checksum: true,
    fit: (b) =>
      startsWith(b, [0x28, 0xb5, 0x2f, 0xfd]) ||
      ((b[0]! & 0xf0) === 0x50 && startsWith(b.subarray(1), [0x2a, 0x4d, 0x18]))
        ? "magic"
        : undefined,
  },
  { format: "brotli", container: "brotli", checksum: false, fit: () => "none" },
  {
    format: "lz4",
    container: "frame",
    checksum: true,
    fit: (b) => (startsWith(b, [0x04, 0x22, 0x4d, 0x18]) ? "magic" : undefined),
  },
  {
    format: "lz4",
    container: "legacy",
    checksum: false,
    fit: (b) => (startsWith(b, [0x02, 0x21, 0x4c, 0x18]) ? "magic" : undefined),
  },
  {
    format: "lzw",
    container: "compress",
    checksum: false,
    fit: (b) => (startsWith(b, [0x1f, 0x9d]) ? "magic" : undefined),
  },
];

/**
 * Whether bytes read as text: valid UTF-8 with no control characters but tab and line breaks.
 *
 * @param bytes - The bytes.
 * @returns {boolean} Whether they are text.
 */
export function readable(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return !/[\p{Cc}\p{Cf}]/u.test(text.replaceAll(/[\t\n\r]/gu, ""));
  } catch {
    return false;
  }
}

/** What one probe gave back. */
interface Outcome {
  bytes: Uint8Array;
  details: Details;
  /** Whether the output passed the limit and stopped there. */
  limited?: boolean;
}

/**
 * Decompresses with one probe: nothing for another container, the prefix for one too big.
 *
 * @param probe - The container.
 * @param bytes - The input.
 * @param limit - Most bytes to write.
 * @returns {Outcome | undefined} What came out, cut at the limit when it got that far.
 */
function tryProbe(probe: Readonly<Probe>, bytes: Uint8Array, limit: number): Outcome | undefined {
  try {
    return create(probe.format).decompress(bytes, { container: probe.container, limit });
  } catch (error) {
    if (error instanceof LimitError) return { bytes: error.partial, details: {}, limited: true };
    if (error instanceof DecompressError) return undefined;
    throw error;
  }
}

/**
 * Whether evidence backs a candidate: a magic number, a checked header with a checksum, or a
 * checked header that decodes to readable text to the last byte.
 *
 * @param fit - How the start fit.
 * @param checksum - Whether a checksum matched.
 * @param cleanText - Whether it decoded to readable text and to the last byte.
 * @returns {boolean} Whether it counts as confirmed.
 */
function confirmed(fit: Fit, checksum: boolean, cleanText: boolean): boolean {
  if (fit === "magic") return true;
  return fit === "header" && (checksum || cleanText);
}

/**
 * Scores what one probe gave back. A cut stream earns nothing for a checksum or its last byte.
 *
 * @param probe - The container.
 * @param fit - How its start fit.
 * @param result - What came out.
 * @param input - The input length and the limit.
 * @returns {CompressionCandidate} The candidate.
 */
function scored(
  probe: Readonly<Probe>,
  fit: Fit,
  result: Readonly<Outcome>,
  input: Readonly<{ length: number; limit: number; trailing: number }>,
): CompressionCandidate {
  const { length, limit, trailing } = input;
  const limited = result.limited === true;
  const checksum = probe.checksum && !limited;
  const whole = !limited && trailing === 0;
  const text = readable(result.bytes);
  const evidence: ReadonlyArray<readonly [boolean, number, string]> = [
    [fit === "magic", 50, "starts with its magic number"],
    [fit === "header", 25, "header fields are valid"],
    [checksum, 30, "checksum matches"],
    [whole, 10, "decodes to the last byte"],
    [trailing > 0, -15, `${trailing} bytes follow the stream`],
    [limited, 0, `output passes the limit of ${limit} bytes, cut there`],
    [text, 10, "decompresses to readable text"],
    [result.bytes.length > length, 5, "comes out longer than it went in"],
  ];
  const held = evidence.filter(([holds]) => holds);
  const confidence = held.reduce((sum, [, points]) => sum + points, 0);
  return {
    format: probe.format,
    container: probe.container,
    confidence: Math.max(1, Math.min(100, confidence)),
    reasons: held.map(([, , reason]) => reason),
    bytes: result.bytes,
    details: result.details,
    confirmed: confirmed(fit, checksum, whole && text),
    limited,
  };
}

/**
 * Tries one probe. Raw deflate and brotli need bytes back, to the last byte or to the limit.
 *
 * @param probe - The container.
 * @param fit - How its start fit.
 * @param bytes - The input.
 * @param limit - Most bytes to write.
 * @returns {CompressionCandidate | undefined} The candidate, or nothing when decoding failed.
 */
function attempt(
  probe: Readonly<Probe>,
  fit: Fit,
  bytes: Uint8Array,
  limit: number,
): CompressionCandidate | undefined {
  const result = tryProbe(probe, bytes, limit);
  const trailing = Number(result?.details["trailing"] ?? 0);
  if (!result || (fit === "none" && (result.bytes.length === 0 || trailing > 0))) return undefined;
  return scored(probe, fit, result, { length: bytes.length, limit, trailing });
}

/**
 * Lists the formats and containers some bytes decompress in, most likely first. A container with
 * a magic number or a checked header is tried only when the bytes start that way; raw deflate and
 * brotli, which have neither, are tried always and count only when they decode to the last byte.
 *
 * @param data - The bytes.
 * @param options - The output limit per attempt.
 * @returns {CompressionCandidate[]} The candidates, best first.
 */
export function identify(
  data: Uint8Array,
  options?: Readonly<IdentifyOptions>,
): CompressionCandidate[] {
  const bytes = compressedBytes(data);
  const limit = limitOption(options?.limit ?? DEFAULT_LIMIT);
  const known = new Set(formats());
  const candidates: CompressionCandidate[] = [];
  for (const probe of PROBES) {
    if (!known.has(probe.format)) continue;
    const fit = probe.fit(bytes);
    if (!fit) continue;
    const candidate = attempt(probe, fit, bytes, limit);
    if (candidate) candidates.push(candidate);
  }
  return candidates.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Names an archive format this package does not open, when the bytes start like one.
 *
 * @param data - The bytes.
 * @returns {string | undefined} Such as `a ZIP archive`.
 */
export function archiveOf(data: Uint8Array): string | undefined {
  return ARCHIVES.find(([, magic, offset]) => startsWith(data.subarray(offset), magic))?.[0];
}

/**
 * Takes off one compression layer at a time while the best candidate is confirmed, and lists
 * every layer, outermost first. An unconfirmed best guess ends the list with `confirmed: false`,
 * a layer cut at the limit with `limited: true`.
 *
 * @param data - The bytes.
 * @param options - The output limit per attempt and the most layers.
 * @returns {CompressionCandidate[]} The layers.
 */
export function peel(data: Uint8Array, options?: Readonly<PeelOptions>): CompressionCandidate[] {
  const depth = options?.depth ?? 10;
  const layers: CompressionCandidate[] = [];
  let bytes = compressedBytes(data);
  while (layers.length < depth) {
    const [best] = identify(bytes, options);
    if (!best) break;
    layers.push(best);
    if (!best.confirmed || best.limited) break;
    bytes = best.bytes;
  }
  return layers;
}
