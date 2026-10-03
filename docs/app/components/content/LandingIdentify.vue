<script setup lang="ts">
import { base64 } from "@agntn/encodings/base64";
import type { LandingSample } from "../../composables/useLandingSample";
import { VARIANTS } from "../../utils/formats";
import { clip } from "../../utils/format";
import { identifyAnswer, previewText } from "../../utils/tools";

const props = defineProps<{ sample: LandingSample }>();
const emit = defineEmits<{ pause: [paused: boolean] }>();

const slug = computed(() => props.sample.key);
const data = computed(() => base64.encode(props.sample.bytes));

/** The ranking `compressions_identify` hands a model, from the executor the tool runs. */
const answer = computed(() => identifyAnswer(data.value));
const best = computed(() => answer.value.candidates[0]);
const name = (candidate: Readonly<{ format: string; container: string }>): string => `${candidate.format}:${candidate.container}`;

/** Three rows always, so the console keeps one height; a missing candidate is an empty row. */
const rows = computed(() =>
  Array.from({ length: 3 }, (_, index) => {
    const candidate = answer.value.candidates[index];
    if (!candidate) return undefined;
    const shown = previewText(candidate);
    return {
      ...candidate,
      label: candidate.format === candidate.container ? candidate.format : `${candidate.format} · ${candidate.container}`,
      shown: clip(shown, 40),
      full: shown,
      hit: name(candidate) === slug.value,
    };
  }),
);

const readers = computed(() => answer.value.candidates.map(name));
const ticks = computed(() =>
  VARIANTS.map((variant) => {
    const key = `${variant.format.slug}:${variant.container.name}`;
    return { name: key, open: readers.value.includes(key) };
  }),
);

const shortData = computed(() => clip(data.value, 28));
const title = computed(() => `compressions_identify({ data: "${data.value}" })`);
const verdict = computed(() => {
  if (!best.value) return { label: "nothing", rest: "reads it" };
  const label = best.value.format === best.value.container ? best.value.format : `${best.value.format} · ${best.value.container}`;
  return name(best.value) === slug.value ? { label, rest: "it is" } : { label, rest: `not ${props.sample.variant.label}` };
});
const about = computed(() => {
  if (!best.value) return "No format turns these bytes into anything. Not every blob is compressed.";
  const reasons = best.value.reasons.join(", ");
  return `${reasons.charAt(0).toUpperCase()}${reasons.slice(1)}.`;
});
const playground = computed(() => `/playground?op=identify&data=${encodeURIComponent(data.value)}`);
</script>

<template>
  <section
    class="tool-console landing-identify"
    aria-label="One compressed stream, and the formats that read it"
    @mouseenter="emit('pause', true)"
    @mouseleave="emit('pause', false)"
    @focusin="emit('pause', true)"
    @focusout="emit('pause', false)"
  >
    <span class="console-cross console-cross-tl" aria-hidden="true">+</span>
    <span class="console-cross console-cross-br" aria-hidden="true">+</span>
    <header class="console-bar">
      <UTooltip :text="title">
        <span class="console-title verify-call" tabindex="0"
          ><span class="console-tag">Call</span>compressions_identify(<span class="tok-str">"{{ shortData }}"</span>)</span
        >
      </UTooltip>
      <span class="console-meta">ranked</span>
      <span class="console-mark" aria-hidden="true" />
    </header>
    <div class="console-ruler" aria-hidden="true">
      <span :key="slug" class="console-cursor" />
    </div>

    <!-- The best guess on the crosses grid, then the top three and a tick per container that reads the stream. -->
    <div class="verify-subject">
      <div :key="slug" class="console-scan" aria-hidden="true" />
      <div class="verify-identity">
        <ConsoleReticle :key="slug" icon="i-lucide-scan-search" />
        <div class="verify-name">
          <span class="console-label">Guess / <span class="console-label-key">{{ best?.confidence ?? "none" }}</span></span>
          <h3>
            <span class="verify-hit">{{ verdict.label }}</span>, {{ verdict.rest }}
          </h3>
          <p class="console-about identify-about">{{ about }}</p>
        </div>
      </div>
      <div class="console-readout">
        <ol :key="slug" class="console-animate verify-rows">
          <li
            v-for="(row, index) in rows"
            :key="row ? `${row.format}:${row.container}` : `empty-${index}`"
            :data-hit="row?.hit ? '' : undefined"
            :style="{ animationDelay: `${index * 45}ms` }"
          >
            <template v-if="row">
              <span class="verify-encoding">{{ row.label }}</span>
              <UTooltip :text="row.full">
                <span class="verify-expected" tabindex="0">{{ row.shown }}</span>
              </UTooltip>
              <UBadge :color="row.hit ? 'primary' : 'neutral'" variant="outline" :label="String(row.confidence)" />
            </template>
            <span v-else class="verify-encoding identify-empty">no other reading</span>
          </li>
        </ol>
        <div
          class="console-gauge"
          :aria-label="`${readers.length} of ${ticks.length} containers read this stream`"
        >
          <span class="console-ticks" aria-hidden="true">
            <span
              v-for="(tick, index) in ticks"
              :key="tick.name"
              :class="tick.open ? 'console-tick-open' : 'console-tick-closed'"
              :style="{ animationDelay: `${index * 12}ms` }"
            />
          </span>
          <span class="console-gauge-read">{{ readers.length }} of {{ ticks.length }} read it</span>
        </div>
      </div>
    </div>

    <ConsoleResponse :title="title" :text="answer.text" />

    <footer class="console-footer console-footer-plain">
      <span>In your browser / no network</span>
      <NuxtLink :to="playground" class="verify-link"
        ><span aria-hidden="true">→ </span>identify your own bytes</NuxtLink
      >
    </footer>
  </section>
</template>

<style scoped>
.verify-call {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.verify-subject {
  position: relative;
  display: grid;
  gap: 16px;
  padding: 18px 20px 20px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='36' height='36'%3E%3Cpath d='M16 18h4m-2-2v4' fill='none' stroke='%23818a94' stroke-opacity='.1'/%3E%3C/svg%3E");
  background-size: 36px 36px;
  background-position: 24px 20px;
}
.verify-subject > :not(.console-scan) {
  position: relative;
}
.verify-identity {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  gap: 16px;
  align-items: center;
}
.verify-name {
  min-width: 0;
}
.verify-name h3 {
  margin: 4px 0 6px;
  font-family: var(--font-mono);
  font-size: 20px;
  font-weight: 400;
  line-height: 1.25;
  color: var(--ui-text-highlighted);
}
.verify-hit {
  color: var(--console-accent);
}
.verify-name .console-about {
  font-size: 14px;
}
.verify-rows {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
}
/* One row per candidate: the format and container, what it decompresses to on one line, the score. The sample's own one carries the accent edge. */
.verify-rows > li {
  display: grid;
  grid-template-columns: 8.5rem minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 8px 12px;
  font-size: 12px;
}
.verify-rows > li + li {
  border-top: 1px solid var(--console-line);
}
.verify-rows > li[data-hit] {
  background: color-mix(in srgb, var(--ui-primary) 5%, var(--ui-bg));
  box-shadow: inset 2px 0 0 var(--console-accent);
}
.verify-encoding {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ui-text-dimmed);
}
.verify-expected {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ui-text-muted);
}
.identify-about {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.identify-empty {
  grid-column: 1 / -1;
  min-height: 22px;
  line-height: 22px;
}
.verify-link {
  margin-left: auto;
  color: var(--ui-text-highlighted);
}
.verify-link:hover {
  color: var(--console-accent);
}
.verify-link:focus-visible {
  outline: 1px solid var(--ui-primary);
  outline-offset: 3px;
}
@media (width < 400px) {
  .verify-subject {
    padding-inline: 14px;
  }
  .verify-identity {
    grid-template-columns: 64px minmax(0, 1fr);
    gap: 12px;
  }
}
</style>
