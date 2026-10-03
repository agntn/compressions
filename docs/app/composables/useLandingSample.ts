import { create } from "@agntn/compressions";
import {
  SAMPLE_INPUT,
  VARIANTS,
  anatomy,
  sampleStream,
  variantOptions,
  type Segment,
  type VariantEntry,
} from "../utils/formats";

/** The order the landing walks the variants in. Neighbours are kept different on purpose. */
const ORDER: readonly string[] = [
  "deflate:gzip",
  "zstd:zstd",
  "lzma:xz",
  "bzip2:bzip2",
  "brotli:brotli",
  "lz4:frame",
  "deflate:zlib",
  "lzw:compress",
  "lzma:alone",
  "deflate:raw",
  "lz4:legacy",
];

const key = (variant: VariantEntry): string => `${variant.format.slug}:${variant.container.name}`;

/** Every variant, in `ORDER` first; a newcomer missing from it joins at the end. */
const WALK: readonly VariantEntry[] = [
  ...ORDER.flatMap((name) => VARIANTS.filter((variant) => key(variant) === name)),
  ...VARIANTS.filter((variant) => !ORDER.includes(key(variant))),
];

export interface LandingSample {
  variant: VariantEntry;
  /** `format:container`, stable across renders. */
  key: string;
  /** The sample as this variant writes it. */
  bytes: Uint8Array;
  /** What the bytes are for. */
  segments: readonly Segment[];
  /** Bytes in. */
  inputLength: number;
  /** Bytes out as a percentage of bytes in. */
  ratio: number;
  /** Whether the library read the stream back to the sample. */
  roundTrip: boolean;
  /** The options a call passes. */
  options: Readonly<Record<string, string>>;
  /** What decompressing the stream reported about it. */
  details: Readonly<Record<string, string | number | boolean>>;
}

/**
 * Compresses the sample with one variant, or takes the reference tool's stream, and reads it back.
 *
 * @param {VariantEntry} variant - A format and one of its containers.
 * @returns {LandingSample} The stream, its anatomy and the round trip.
 */
export function compressSample(variant: VariantEntry): LandingSample {
  const options = variantOptions(variant);
  const bytes = sampleStream(variant);
  const input = new TextEncoder().encode(SAMPLE_INPUT);
  const { bytes: back, details } = create(variant.format.slug).decompress(bytes, options);
  return {
    variant,
    key: key(variant),
    bytes,
    segments: anatomy(variant, bytes),
    inputLength: input.length,
    ratio: Math.round((bytes.length / input.length) * 100),
    roundTrip: new TextDecoder().decode(back) === SAMPLE_INPUT,
    options,
    details,
  };
}

/** One clock for every landing panel. The library computes the samples, at build and live. */
export function useLandingSample() {
  const samples = WALK.map((variant) => compressSample(variant));
  const tick = ref(0);
  const paused = ref(false);
  const index = computed(() => tick.value % samples.length);
  const current = computed(() => samples[index.value]!);

  let timer: number | undefined;

  /** Wraps at both ends, so previous on the first variant lands on the last one. */
  function step(delta: number) {
    tick.value = (tick.value + delta + samples.length) % samples.length;
  }

  function stopWalk() {
    if (timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  }

  function startWalk() {
    stopWalk();
    if (!import.meta.client || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    timer = window.setInterval(() => {
      if (!paused.value && !document.hidden) {
        step(1);
      }
    }, 4200);
  }

  onMounted(startWalk);
  onUnmounted(stopWalk);

  return { samples, tick, index, paused, current, step };
}
