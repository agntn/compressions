import { hex } from "@agntn/encodings/hex";
import { create, formats, type CompressionContainer, type CompressionInfo } from "@agntn/compressions";

/** The built-in names, typed from the registry as the page loads it. */
type BuiltinFormat = (typeof BUILTINS)[number];

/** Built-ins in listing order. A newcomer without a row in `PRESENTATION` fails the type below. */
const BUILTINS = ["deflate", "bzip2", "lzma", "zstd", "brotli", "lz4", "lzw"] as const;

/** An icon, a one-liner and who writes it, per format. Everything else comes from `info()`. */
const PRESENTATION: Record<BuiltinFormat, { icon: string; blurb: string; usedBy: string }> = {
  deflate: {
    icon: "i-lucide-file-archive",
    blurb: "LZ77 and Huffman, raw or wrapped in zlib or gzip. Still everywhere",
    usedBy: "gzip, PNG, ZIP, HTTP, PDF",
  },
  bzip2: {
    icon: "i-lucide-shuffle",
    blurb: "Sorts every rotation of a block first, then codes what lines up",
    usedBy: "source tarballs, Wikipedia dumps",
  },
  lzma: {
    icon: "i-lucide-scale",
    blurb: "A range coder over bit models that learn. Small and patient",
    usedBy: "xz, 7-Zip, kernel images",
  },
  zstd: {
    icon: "i-lucide-gauge",
    blurb: "Huffman literals and FSE coded sequences. Fast both ways",
    usedBy: "Linux packages, Btrfs, HTTP",
  },
  brotli: {
    icon: "i-lucide-globe",
    blurb: "Context modeling and a built-in dictionary of the web",
    usedBy: "HTTP, WOFF2",
  },
  lz4: {
    icon: "i-lucide-zap",
    blurb: "Byte-aligned matches, no entropy coder. Built for speed",
    usedBy: "ZFS, Linux, game assets",
  },
  lzw: {
    icon: "i-lucide-book-a",
    blurb: "A dictionary that grows as it reads. The .Z of Unix compress",
    usedBy: "compress, GIF, old tarballs",
  },
};

/** How the landing groups the registry: by what does the work after the matching. */
export const GROUPS = [
  { key: "huffman", label: "Prefix codes", about: "LZ77 matches, then Huffman or FSE codes" },
  { key: "range", label: "Range coding", about: "LZ77 matches, then a range coder over adaptive bits" },
  { key: "sorting", label: "Block sorting", about: "the Burrows-Wheeler transform before any coding" },
  { key: "bytes", label: "Byte aligned", about: "matches and literals as whole bytes, nothing coded" },
  { key: "dictionary", label: "Dictionary codes", about: "one code per phrase seen before" },
] as const;

export type GroupKey = (typeof GROUPS)[number]["key"];

const GROUP_OF: Record<BuiltinFormat, GroupKey> = {
  deflate: "huffman",
  zstd: "huffman",
  brotli: "huffman",
  lzma: "range",
  bzip2: "sorting",
  lz4: "bytes",
  lzw: "dictionary",
};

export interface FormatEntry {
  slug: BuiltinFormat;
  to: string;
  icon: string;
  blurb: string;
  usedBy: string;
  group: GroupKey;
  info: CompressionInfo;
}

/** The built-in formats in listing order, with their live metadata. */
export const FORMATS: readonly FormatEntry[] = BUILTINS.map((slug) => ({
  slug,
  to: `/formats/${slug}`,
  ...PRESENTATION[slug],
  group: GROUP_OF[slug],
  info: create(slug).info(),
}));

if (import.meta.dev && formats().join() !== BUILTINS.join()) {
  console.warn("docs: BUILTINS in app/utils/formats.ts no longer matches formats()");
}

/** One container of one format: what the landing walks and a call names with `container`. */
export interface VariantEntry {
  format: FormatEntry;
  container: CompressionContainer;
  /** Whether the format has more than one container, so a call has to name it. */
  named: boolean;
  /** `deflate · gzip`, or the format alone when it has one container. */
  label: string;
}

/** Every container of every format, in listing order. */
export const VARIANTS: readonly VariantEntry[] = FORMATS.flatMap((format) =>
  format.info.containers.map((container) => ({
    format,
    container,
    named: format.info.containers.length > 1,
    label: format.info.containers.length > 1 ? `${format.slug} · ${container.name}` : format.slug,
  })),
);

/**
 * One format by its registry name.
 *
 * @param {string} slug - A built-in name.
 * @returns {FormatEntry | undefined} Undefined for a name the site doesn't ship.
 */
export function formatEntry(slug: string): FormatEntry | undefined {
  return FORMATS.find((format) => format.slug === slug);
}

/**
 * One format's place in the registry, 1-based, the way an ID bar numbers it.
 *
 * @param {string} slug - A built-in name.
 * @returns {number} Its position.
 */
export function registryPosition(slug: string): number {
  return FORMATS.findIndex((format) => format.slug === slug) + 1;
}

/** The formats this package writes as well as reads. */
export const WRITER_COUNT = FORMATS.filter((format) => format.info.compress).length;

/** The containers that carry a checksum. */
export const CHECKSUM_COUNT = VARIANTS.filter((variant) => variant.container.checksum).length;

/** The text every panel compresses: a repeated sentence, so even a short stream shrinks. */
export const SAMPLE_INPUT = "hello world! hello world! hello world! hello world!";

/**
 * The sample as zstd 1.5.7 (`zstd -19`) and brotli 1.2.0 (`brotli -q 11`) wrote it, since this
 * package reads those two and doesn't write them. `test/docs.test.ts` decompresses both.
 */
export const READ_ONLY_SAMPLES: Readonly<Partial<Record<BuiltinFormat, string>>> = {
  zstd: "28b52ffd0468a500007068656c6c6f20776f726c642120680100e0994a31ba782b",
  brotli: "1f3200f88dd44e777726aa32b40609617b53b358530d6440358300",
};

/**
 * The options a call passes to compress with a variant: the container where the format has
 * several, a gzip name never.
 *
 * @param {VariantEntry} variant - The variant.
 * @returns {Record<string, string>} The options.
 */
export function variantOptions(variant: VariantEntry): Record<string, string> {
  return variant.named ? { container: variant.container.name } : {};
}

/**
 * The sample stream of a variant: written by the library, or by the reference tool for a format
 * the library only reads.
 *
 * @param {VariantEntry} variant - The variant.
 * @returns {Uint8Array} The compressed bytes.
 */
export function sampleStream(variant: VariantEntry): Uint8Array {
  const written = READ_ONLY_SAMPLES[variant.format.slug];
  if (written) return hex.decode(written);
  return create(variant.format.slug).compress(SAMPLE_INPUT, variantOptions(variant));
}

/** What a run of bytes in a stream is for. */
export type SegmentKind = "magic" | "header" | "data" | "check";

export interface Segment {
  kind: SegmentKind;
  start: number;
  end: number;
}

/** What the segment kinds are called on a page. */
export const SEGMENT_LABELS: Record<SegmentKind, string> = {
  magic: "magic",
  header: "header",
  data: "data",
  check: "check",
};

/**
 * Bytes at the start (magic, header) and the end (check) of each container's sample stream, as
 * its format lays them out. The middle is data. Bit-packed trailers that don't fall on a byte
 * (bzip2's end of stream) stay in the data.
 */
const LAYOUT: Record<string, (bytes: Uint8Array) => readonly [magic: number, header: number, check: number]> = {
  "deflate:raw": () => [0, 0, 0],
  "deflate:zlib": () => [0, 2, 4],
  "deflate:gzip": (bytes) => [3, 7 + gzipName(bytes), 8],
  "bzip2:bzip2": () => [4, 0, 0],
  "lzma:alone": () => [1, 12, 0],
  "lzma:xz": (bytes) => [6, 18, xzTail(bytes)],
  "zstd:zstd": () => [4, 2, 4],
  "brotli:brotli": () => [0, 0, 0],
  "lz4:frame": () => [4, 7, 8],
  "lz4:legacy": () => [4, 4, 0],
  "lzw:compress": () => [2, 1, 0],
};

/**
 * Bytes a gzip header spends on the file name, zero byte included.
 *
 * @param {Uint8Array} bytes - A gzip member.
 * @returns {number} The count.
 */
function gzipName(bytes: Uint8Array): number {
  return bytes[3]! & 8 ? bytes.indexOf(0, 10) - 9 : 0;
}

/**
 * Bytes after an xz block's data: padding, check, index and footer.
 *
 * @param {Uint8Array} bytes - An xz stream with one block.
 * @returns {number} The count.
 */
function xzTail(bytes: Uint8Array): number {
  const index = (new DataView(bytes.buffer, bytes.byteOffset).getUint32(bytes.length - 8, true) + 1) * 4;
  const checkSize = [0, 4, 4, 4, 8, 8, 8, 16, 16, 16, 32, 32, 32, 64, 64, 64][bytes[7]! & 15]!;
  return 12 + index + checkSize;
}

/**
 * Splits a sample stream into what its bytes are for.
 *
 * @param {VariantEntry} variant - The variant that wrote it.
 * @param {Uint8Array} bytes - The stream.
 * @returns {Segment[]} Magic, header, data and check runs, in order, the empty ones left out.
 */
export function anatomy(variant: VariantEntry, bytes: Uint8Array): Segment[] {
  const [magic, header, check] = LAYOUT[`${variant.format.slug}:${variant.container.name}`]?.(bytes) ?? [0, 0, 0];
  const dataEnd = bytes.length - check;
  const segments: Segment[] = [
    { kind: "magic", start: 0, end: magic },
    { kind: "header", start: magic, end: magic + header },
    { kind: "data", start: magic + header, end: dataEnd },
    { kind: "check", start: dataEnd, end: bytes.length },
  ];
  return segments.filter((segment) => segment.end > segment.start);
}

/** Text the roster measures the ratio on: prose with the repetition real text has. */
const RATIO_TEXT = Array.from(
  { length: 40 },
  (_, i) => `Line ${i}: the quick brown fox jumps over the lazy dog, then naps for ${(i * 7) % 13} minutes.\n`,
).join("");

/** Bytes of the roster's text. */
export const RATIO_BYTES = new TextEncoder().encode(RATIO_TEXT).length;

/**
 * How small a format writes the roster's text, as a percentage of the input, at its defaults.
 *
 * @param {FormatEntry} entry - A built-in.
 * @returns {number | undefined} The percentage, or nothing for a format this package only reads.
 */
export function ratio(entry: FormatEntry): number | undefined {
  if (!entry.info.compress) return undefined;
  const packed = create(entry.slug).compress(RATIO_TEXT);
  return Math.round((packed.length / new TextEncoder().encode(RATIO_TEXT).length) * 100);
}

/**
 * A format's containers as the extension list a page shows.
 *
 * @param {FormatEntry} entry - A built-in.
 * @returns {string} Such as `.gz .tgz .zz`.
 */
export function extensions(entry: FormatEntry): string {
  return entry.info.containers.flatMap((container) => container.extensions).join(" ");
}

/**
 * The checksums a format's containers carry, deduplicated.
 *
 * @param {FormatEntry} entry - A built-in.
 * @returns {string} Such as `Adler-32, CRC-32`, or `none`.
 */
export function checksums(entry: FormatEntry): string {
  const names = [...new Set(entry.info.containers.flatMap((container) => (container.checksum ? [container.checksum] : [])))];
  return names.length > 0 ? names.join(", ") : "none";
}
