<script setup lang="ts">
import { hex } from "@agntn/encodings/hex";
import type { LandingSample } from "../../composables/useLandingSample";
import { SAMPLE_INPUT, FORMATS, READ_ONLY_SAMPLES, SEGMENT_LABELS, VARIANTS, registryPosition, type SegmentKind } from "../../utils/formats";
import { optionLiteral } from "../../utils/format";

const props = defineProps<{ sample: LandingSample; samples: readonly LandingSample[] }>();
const emit = defineEmits<{ step: [delta: number]; pause: [paused: boolean] }>();

const { copied, copy } = useCopied();

const variant = computed(() => props.sample.variant);
const entry = computed(() => variant.value.format);
const readOnly = computed(() => READ_ONLY_SAMPLES[entry.value.slug] !== undefined);
const optionsArg = computed(() =>
  Object.keys(props.sample.options).length > 0 ? `, ${optionLiteral(props.sample.options)}` : "",
);
const call = computed(() =>
  readOnly.value
    ? `decompress("${entry.value.slug}", bytes)`
    : `compress("${entry.value.slug}", "${SAMPLE_INPUT}"${optionsArg.value})`,
);

/** The widest stream in the walk: the grid keeps room for it, so the band never jumps. */
const widest = Math.max(...props.samples.map((sample) => sample.bytes.length));

/** One cell per byte of the stream, tagged with what the byte is for. */
const cells = computed(() => {
  const kinds: SegmentKind[] = [];
  for (const segment of props.sample.segments) {
    for (let i = segment.start; i < segment.end; i++) kinds[i] = segment.kind;
  }
  return Array.from({ length: widest }, (_, index) => {
    const byte = props.sample.bytes[index];
    return byte === undefined ? undefined : { text: byte.toString(16).padStart(2, "0"), kind: kinds[index]! };
  });
});

/** The kinds this stream has, in order, with their byte counts, for the legend. */
const legend = computed(() =>
  (["magic", "header", "data", "check"] as const).map((kind) => ({
    kind,
    bytes: props.sample.segments.filter((segment) => segment.kind === kind).reduce((sum, segment) => sum + segment.end - segment.start, 0),
  })),
);

const checksum = computed(() => variant.value.container.checksum ?? "none");
const extension = computed(() => variant.value.container.extensions.join(" ") || "none");

/** One tick per container in the registry, this format's open. */
const ticks = computed(() =>
  VARIANTS.map((other) => ({
    key: `${other.format.slug}:${other.container.name}`,
    open: other.format.slug === entry.value.slug,
  })),
);
const kin = computed(() => ticks.value.filter((tick) => tick.open).length);
</script>

<template>
  <section
    class="tool-console console-wide landing-stream"
    aria-label="One text through one format, the stream byte by byte"
    @mouseenter="emit('pause', true)"
    @mouseleave="emit('pause', false)"
    @focusin="emit('pause', true)"
    @focusout="emit('pause', false)"
  >
    <span class="console-cross console-cross-tl" aria-hidden="true">+</span>
    <span class="console-cross console-cross-br" aria-hidden="true">+</span>

    <header class="console-bar">
      <UTooltip :text="call">
        <span v-if="readOnly" class="console-title stream-call" tabindex="0"
          ><span class="console-tag">Call</span>decompress(<span class="tok-str">"{{ entry.slug }}"</span>, bytes)</span
        >
        <span v-else class="console-title stream-call" tabindex="0"
          ><span class="console-tag">Call</span>compress(<span class="tok-str">"{{ entry.slug }}"</span>,
          <span class="tok-str">"{{ SAMPLE_INPUT }}"</span>{{ optionsArg }})</span
        >
      </UTooltip>
      <span class="console-meta"
        >{{ variant.container.name }} · {{ String(registryPosition(entry.slug)).padStart(2, "0") }} /
        {{ FORMATS.length }}</span
      >
      <span class="console-mark" aria-hidden="true" />
    </header>
    <div class="console-ruler" aria-hidden="true">
      <span :key="sample.key" class="console-cursor" />
    </div>

    <div class="console-band console-subject-band stream-subject">
      <div :key="sample.key" class="console-scan" aria-hidden="true" />
      <div class="stream-left">
        <div class="console-identity-block">
          <ConsoleReticle :key="sample.key" :icon="entry.icon" />
          <!-- Every sample's name sits in the same cell, hidden, so the band keeps the tallest one's height. -->
          <div class="stream-names">
            <div
              v-for="other in samples"
              :key="other.key"
              class="console-name"
              :class="{ 'stream-sizer': other.key !== sample.key }"
              :aria-hidden="other.key !== sample.key ? 'true' : undefined"
            >
              <span class="console-label"
                >Format / <span class="console-label-key">{{ other.variant.container.name }}</span></span
              >
              <h3>{{ other.variant.container.label }}</h3>
              <p class="console-about">{{ other.variant.format.blurb }}.</p>
            </div>
          </div>
        </div>

        <div class="stream-board">
          <p class="console-label console-rule-title">
            <span>Stream <span aria-hidden="true">[ every byte it wrote, by what it's for ]</span></span>
            <span class="console-mark" aria-hidden="true" />
            <UButton
              color="neutral"
              variant="subtle"
              :icon="copied === 'stream' ? 'i-lucide-check' : 'i-lucide-copy'"
              :label="copied === 'stream' ? 'copied' : 'copy'"
              :aria-label="copied === 'stream' ? 'Copied' : 'Copy the stream in hex'"
              @click="copy('stream', hex.encode(sample.bytes))"
            />
          </p>

          <div class="stream-row">
            <span class="console-tag">In</span>
            <UTooltip :text="SAMPLE_INPUT">
              <span class="stream-text" tabindex="0">{{ SAMPLE_INPUT }}</span>
            </UTooltip>
            <span class="stream-count">{{ sample.inputLength }} bytes</span>
          </div>
          <div class="stream-row">
            <span class="console-tag stream-tag-out">Out</span>
            <span class="stream-legend">
              <span v-for="item in legend" :key="item.kind" class="stream-key" :data-kind="item.kind" :data-empty="item.bytes === 0 ? '' : undefined"
                ><span class="stream-swatch" aria-hidden="true" />{{ SEGMENT_LABELS[item.kind] }} {{ item.bytes }}</span
              >
            </span>
            <span class="stream-count">{{ sample.bytes.length }} bytes</span>
          </div>

          <div
            :key="sample.key"
            class="stream-grid"
            role="img"
            :aria-label="`${sample.bytes.length} bytes: ${legend.filter((item) => item.bytes > 0).map((item) => `${item.bytes} ${item.kind}`).join(', ')}`"
          >
            <span
              v-for="(cell, index) in cells"
              :key="index"
              class="stream-byte"
              :data-kind="cell?.kind ?? 'none'"
              :style="{ animationDelay: `${Math.min(index * 4, 600)}ms` }"
              >{{ cell?.text }}</span
            >
          </div>
        </div>
      </div>

      <div class="console-readout">
        <svg class="console-link" viewBox="0 0 32 40" fill="none" aria-hidden="true">
          <circle cx="3" cy="12" r="2.5" />
          <path d="M5.5 12H14L22 20H32" />
        </svg>
        <dl :key="sample.key" class="console-readout-rows console-animate">
          <div>
            <dt>Size</dt>
            <dd>
              <span class="stream-line">{{ sample.inputLength }} → {{ sample.bytes.length }} bytes</span>
            </dd>
          </div>
          <div>
            <dt>Ratio</dt>
            <dd class="console-accent">
              <span class="stream-line">{{ sample.ratio }}% · {{ sample.roundTrip ? "reads back" : "does not read back" }}</span>
            </dd>
          </div>
          <div>
            <dt>Checksum</dt>
            <dd>
              <span class="stream-line" :class="{ 'stream-none': checksum === 'none' }">{{ checksum }}</span>
            </dd>
          </div>
          <div>
            <dt>Written by</dt>
            <dd>
              <UTooltip :text="readOnly ? `${entry.slug} CLI; this package reads it` : '@agntn/compressions, here'">
                <span class="stream-line" tabindex="0">{{ readOnly ? `the ${entry.slug} CLI` : "this page" }}</span>
              </UTooltip>
            </dd>
          </div>
          <div>
            <dt>Files</dt>
            <dd>
              <span class="stream-line" :class="{ 'stream-none': extension === 'none' }">{{ extension }}</span>
            </dd>
          </div>
        </dl>
        <div class="console-gauge" :aria-label="`${kin} of ${VARIANTS.length} containers belong to ${entry.slug}`">
          <span class="console-ticks" aria-hidden="true">
            <span
              v-for="(tick, index) in ticks"
              :key="tick.key"
              :class="tick.open ? 'console-tick-open' : 'console-tick-closed'"
              :style="{ animationDelay: `${index * 12}ms` }"
            />
          </span>
          <span class="console-gauge-read">containers {{ kin }} / {{ VARIANTS.length }}</span>
        </div>
      </div>
    </div>

    <footer class="console-footer console-footer-plain">
      <NuxtLink :to="entry.to" class="stream-link"
        ><span aria-hidden="true">→ </span>{{ entry.info.label }}<span> · {{ entry.to }}</span></NuxtLink
      >
      <div class="console-controls" aria-label="Sample formats">
        <UButton
          color="neutral"
          variant="subtle"
          square
          icon="i-lucide-chevron-left"
          aria-label="Previous format"
          @click="emit('step', -1)"
        />
        <span>Format</span>
        <UButton
          color="neutral"
          variant="subtle"
          square
          icon="i-lucide-chevron-right"
          aria-label="Next format"
          @click="emit('step', 1)"
        />
      </div>
    </footer>
  </section>
</template>

<style scoped>
.stream-call {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stream-names {
  display: grid;
  min-width: 0;
}
.stream-names > .console-name {
  grid-area: 1 / 1;
}
.stream-sizer {
  visibility: hidden;
}
.stream-line {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stream-none {
  color: var(--ui-text-dimmed);
}
.landing-stream :deep(.console-readout-rows > div) {
  grid-template-columns: 6.5rem minmax(0, 1fr);
}
/* The left column: the format, then the sample in and the stream out, byte by byte. */
.stream-left {
  display: grid;
  gap: 18px;
  min-width: 0;
}
.stream-board {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.stream-board > .console-rule-title {
  margin: 0 0 2px;
}
.stream-row {
  display: grid;
  grid-template-columns: 3rem minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
}
.stream-row > .console-tag {
  justify-self: start;
  margin: 0;
}
.stream-tag-out {
  color: var(--console-accent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--console-accent) 55%, transparent);
}
.stream-text {
  display: block;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: pre;
  color: var(--ui-text-highlighted);
}
.stream-count {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.04em;
  white-space: nowrap;
  color: var(--ui-text-dimmed);
}
.stream-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--ui-text-muted);
}
.stream-key {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.stream-key[data-empty] {
  color: var(--ui-text-dimmed);
}
.stream-swatch {
  display: inline-block;
  width: 9px;
  height: 9px;
}
/* One cell per byte, 16 to a row; what the byte is for sets its look. */
.stream-grid {
  display: grid;
  grid-template-columns: repeat(16, minmax(0, 1fr));
  gap: 2px;
  margin-top: 8px;
}
.stream-byte {
  display: grid;
  place-items: center;
  height: 22px;
  min-width: 0;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  animation: stream-in 0.24s ease-out both;
}
.stream-byte[data-kind="data"],
.stream-key[data-kind="data"] .stream-swatch {
  color: var(--ui-text-muted);
  background: color-mix(in srgb, var(--ui-text-muted) 10%, var(--ui-bg));
}
.stream-byte[data-kind="magic"],
.stream-key[data-kind="magic"] .stream-swatch {
  color: var(--ui-text-highlighted);
  box-shadow: inset 0 0 0 1px var(--console-accent);
  background: color-mix(in srgb, var(--console-accent) 30%, var(--ui-bg));
}
.stream-byte[data-kind="header"],
.stream-key[data-kind="header"] .stream-swatch {
  color: var(--ui-text-highlighted);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--console-accent) 55%, transparent);
  background: var(--ui-bg);
}
.stream-byte[data-kind="check"],
.stream-key[data-kind="check"] .stream-swatch {
  color: var(--ui-text-highlighted);
  box-shadow: inset 0 0 0 1px var(--console-corner);
  background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--ui-text-muted) 22%, var(--ui-bg)) 0 2px, var(--ui-bg) 2px 5px);
}
.stream-byte[data-kind="none"] {
  animation: none;
}
@keyframes stream-in {
  from {
    transform: translateY(-3px);
  }
}
/* Side by side, the readout runs as tall as the board beside it; stacked, it keeps its own height. */
@container (width >= 46rem) {
  .stream-subject > .console-readout {
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    align-self: stretch;
  }
  .stream-subject .console-readout-rows {
    grid-auto-rows: minmax(2.5rem, 1fr);
  }
  .stream-subject .console-readout-rows > div {
    align-items: center;
  }
}
.stream-link {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ui-text-highlighted);
}
.stream-link > span:last-child {
  color: var(--ui-text-dimmed);
}
.stream-link:hover {
  color: var(--console-accent);
}
.stream-link:focus-visible {
  outline: 1px solid var(--ui-primary);
  outline-offset: 3px;
}
@media (width < 640px) {
  .stream-board > .console-rule-title > .console-mark {
    display: none;
  }
  .stream-grid {
    grid-template-columns: repeat(8, minmax(0, 1fr));
  }
}
@media (prefers-reduced-motion: reduce) {
  .stream-byte {
    animation: none;
  }
}
</style>
