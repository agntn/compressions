<script setup lang="ts">
import { base64 } from "@agntn/encodings/base64";
import type { LandingSample } from "../../composables/useLandingSample";
import { clip } from "../../utils/format";
import { runTool } from "../../utils/tools";
import type { DecompressDetails } from "#tool-operations";

const props = defineProps<{ sample: LandingSample }>();
const emit = defineEmits<{ pause: [paused: boolean] }>();

const data = computed(() => base64.encode(props.sample.bytes));
const params = computed(() => ({
  format: props.sample.variant.format.slug,
  data: data.value,
  ...(props.sample.variant.named ? { options: { container: props.sample.variant.container.name } } : {}),
}));
const result = computed(() => runTool("compressions_decompress", params.value));
const text = computed(() => result.value.content[0]!.text);
const details = computed(() => result.value.details as DecompressDetails);
const shortData = computed(() => clip(data.value, 14));
const title = computed(() => `compressions_decompress(${JSON.stringify(params.value)})`);

/** What the tool text tells a model, as rows: how many bytes, the bytes, what else the stream carried. */
const rows = computed(() => {
  const extra = Object.entries(details.value.details)
    .map(([key, value]) => `${key} ${value}`)
    .join(", ");
  return [
    { label: "bytes", value: `${details.value.byteLength} as ${details.value.outputFormat}` },
    { label: "value", value: details.value.value, accent: true },
    { label: "carried", value: extra || "nothing but data", dim: !extra },
  ];
});
</script>

<template>
  <section
    class="tool-console landing-call"
    aria-label="One tool call"
    @mouseenter="emit('pause', true)"
    @mouseleave="emit('pause', false)"
    @focusin="emit('pause', true)"
    @focusout="emit('pause', false)"
  >
    <span class="console-cross console-cross-tl" aria-hidden="true">+</span>
    <span class="console-cross console-cross-br" aria-hidden="true">+</span>

    <header class="console-bar">
      <span class="console-title"
        ><span class="console-tag">Call</span>compressions_decompress(<Transition
          name="compressions-roll"
          mode="out-in"
          ><span :key="sample.key" class="compressions-roll-slot tok-str"
            >"{{ sample.variant.format.slug }}"</span
          ></Transition
        >, <span class="tok-str">"{{ shortData }}"</span>)</span
      >
      <span class="console-mark" aria-hidden="true" />
    </header>
    <div class="console-ruler" aria-hidden="true">
      <span :key="sample.key" class="console-cursor" />
    </div>

    <!-- The format on the crosses grid, what the tool text tells a model in the readout. -->
    <div class="call-subject">
      <div :key="sample.key" class="console-scan" aria-hidden="true" />
      <div class="call-identity">
        <ConsoleReticle :key="sample.key" :icon="sample.variant.format.icon" />
        <div class="call-name">
          <span class="console-label">Tool / <span class="console-label-key">{{ sample.variant.container.name }}</span></span>
          <h3>{{ sample.variant.container.label }}</h3>
          <p class="call-note">
            The bytes come out of the executor, not out of the model's imagination. Readable text
            comes back as text, anything else as hex.
          </p>
        </div>
      </div>
      <div class="console-readout">
        <dl :key="sample.key" class="console-readout-rows console-animate">
          <div v-for="(row, index) in rows" :key="row.label" :style="{ animationDelay: `${index * 45}ms` }">
            <dt>{{ row.label }}</dt>
            <dd :class="{ 'console-accent': row.accent, 'call-dim': row.dim }">
              <span class="call-line">{{ row.value }}</span>
            </dd>
          </div>
        </dl>
      </div>
    </div>

    <ConsoleResponse :title="title" :text="text" />

    <footer class="console-footer console-footer-plain">
      <span aria-label="Supported hosts: MCP, Pi and OMP">MCP · Pi · OMP</span>
      <span class="console-meta">compressions mcp · stdio</span>
    </footer>
  </section>
</template>

<style scoped>
.call-subject {
  position: relative;
  display: grid;
  gap: 16px;
  padding: 18px 20px 20px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='36' height='36'%3E%3Cpath d='M16 18h4m-2-2v4' fill='none' stroke='%23818a94' stroke-opacity='.1'/%3E%3C/svg%3E");
  background-size: 36px 36px;
  background-position: 24px 20px;
}
.call-subject > :not(.console-scan) {
  position: relative;
}
.call-identity {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  gap: 16px;
  align-items: center;
}
.call-name {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.call-name h3 {
  margin: 0;
  font-family: var(--font-sans);
  font-size: 22px;
  font-weight: 500;
  line-height: 1.2;
  color: var(--ui-text-highlighted);
}
.call-note {
  margin: 0;
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
.landing-call .console-readout-rows > div {
  grid-template-columns: 6.5rem minmax(0, 1fr);
}
.landing-call .console-readout-rows dt {
  text-transform: none;
  letter-spacing: 0.02em;
}
.call-dim {
  color: var(--ui-text-dimmed);
}
.call-line {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (width < 400px) {
  .call-subject {
    padding-inline: 14px;
  }
  .call-identity {
    grid-template-columns: 64px minmax(0, 1fr);
    gap: 12px;
  }
}
</style>
