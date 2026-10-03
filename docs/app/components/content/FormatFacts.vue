<script setup lang="ts">
import { hex } from "@agntn/encodings/hex";
import { create } from "@agntn/compressions";
import {
  FORMATS,
  GROUPS,
  SAMPLE_INPUT,
  VARIANTS,
  checksums,
  formatEntry,
  ratio,
  registryPosition,
  sampleStream,
  variantOptions,
} from "../../utils/formats";
import { shellArg } from "../../utils/format";
import { toolText } from "../../utils/tools";

const props = defineProps<{ name: string }>();

const entry = computed(() => formatEntry(props.name));
const position = computed(() => registryPosition(props.name));
const group = computed(() => GROUPS.find((item) => item.key === entry.value?.group));
const percent = computed(() => (entry.value ? ratio(entry.value) : undefined));

/** One row per container: the sample through it, read back here. */
const containers = computed(() =>
  VARIANTS.filter((variant) => variant.format.slug === props.name).map((variant) => {
    const bytes = sampleStream(variant);
    const { bytes: back, details } = create(variant.format.slug).decompress(bytes, variantOptions(variant));
    return {
      variant,
      bytes,
      head: hex.encode(bytes.subarray(0, 12)),
      back: new TextDecoder().decode(back) === SAMPLE_INPUT,
      details: Object.entries(details)
        .map(([key, value]) => `${key} ${value}`)
        .join(", "),
    };
  }),
);

/** The options in the order `info()` declares them, with their range or values and scope. */
const options = computed(() =>
  (entry.value?.info.options ?? []).map((option) => ({
    ...option,
    values: option.choices?.join(", ") ?? (option.min === undefined ? option.type : `${option.min} to ${option.max}`),
    requirement: option.default === undefined ? "optional" : `default ${String(option.default)}`,
    scope: option.containers ? `${option.containers.join(" and ")} only` : option.decode ? "compress and decompress" : "compress",
  })),
);

/** Other formats in the same group, as links. */
const kin = computed(() => FORMATS.filter((format) => format.group === entry.value?.group && format.slug !== props.name));

const cli = computed(() => {
  if (!entry.value) return "";
  const [first] = entry.value.info.containers;
  const named = entry.value.info.containers.length > 1;
  const file = `file${first?.extensions[0] ?? ""}`;
  const flag = named ? ` --container ${first!.name}` : "";
  return entry.value.info.compress
    ? `compressions compress ${entry.value.slug} ${shellArg("notes.txt")}${flag} > ${file}`
    : `compressions decompress ${entry.value.slug} ${file}`;
});
const subpath = computed(() => (entry.value ? `import { ${entry.value.slug} } from "@agntn/compressions/${entry.value.slug}"` : ""));
const playground = computed(() => {
  if (!entry.value) return "/playground";
  const query = entry.value.info.compress
    ? new URLSearchParams({ op: "compress", format: entry.value.slug, input: SAMPLE_INPUT })
    : new URLSearchParams({ op: "decompress", format: entry.value.slug, data: containers.value[0] ? hex.encode(containers.value[0].bytes) : "", dataFormat: "hex" });
  return `/playground?${query.toString()}`;
});

const text = computed(() => (entry.value ? toolText("compressions_info", { format: entry.value.slug }) : ""));
const title = computed(() => `compressions_info("${props.name}")`);
</script>

<template>
  <section v-if="entry" class="tool-console console-wide not-prose my-6" aria-label="Format record">
    <span class="console-cross console-cross-tl" aria-hidden="true">+</span>
    <span class="console-cross console-cross-br" aria-hidden="true">+</span>

    <header class="console-bar">
      <span class="console-title"
        ><span class="console-tag">ID</span>{{ entry.slug
        }}<span class="console-file">{{ String(position).padStart(2, "0") }} / {{ FORMATS.length }}</span></span
      >
      <span class="console-meta"
        >{{ entry.info.containers.length }} {{ entry.info.containers.length === 1 ? "container" : "containers" }} ·
        {{ entry.info.compress ? "reads and writes" : "reads" }}</span
      >
      <span class="console-mark" aria-hidden="true" />
    </header>
    <div class="console-ruler" aria-hidden="true"><span class="console-cursor" /></div>

    <div class="console-band console-subject-band">
      <div class="console-scan" aria-hidden="true" />
      <div class="console-identity-block">
        <ConsoleReticle :key="entry.slug" :icon="entry.icon" />
        <div class="console-name">
          <span class="console-label">Format / {{ group?.label }}</span>
          <h3>{{ entry.info.label }}</h3>
          <p class="console-about">{{ entry.blurb }}.</p>
        </div>
      </div>

      <div class="console-readout">
        <svg class="console-link" viewBox="0 0 32 40" fill="none" aria-hidden="true">
          <circle cx="3" cy="12" r="2.5" />
          <path d="M5.5 12H14L22 20H32" />
        </svg>
        <dl class="console-readout-rows">
          <div>
            <dt>Ratio</dt>
            <dd class="console-accent">
              <span class="facts-line">{{ percent === undefined ? "reads only" : `${percent}% of the input, on text` }}</span>
            </dd>
          </div>
          <div>
            <dt>Checksum</dt>
            <dd>
              <UTooltip :text="checksums(entry)">
                <span class="facts-line" :class="{ 'facts-none': checksums(entry) === 'none' }" tabindex="0">{{
                  checksums(entry)
                }}</span>
              </UTooltip>
            </dd>
          </div>
          <div>
            <dt>Standard</dt>
            <dd>
              <UTooltip :text="entry.info.standard">
                <span class="facts-line" tabindex="0">{{ entry.info.standard }}</span>
              </UTooltip>
            </dd>
          </div>
          <div>
            <dt>Used by</dt>
            <dd>
              <UTooltip :text="entry.usedBy">
                <span class="facts-line" tabindex="0">{{ entry.usedBy }}</span>
              </UTooltip>
            </dd>
          </div>
        </dl>
        <div class="console-gauge" :aria-label="`${kin.length + 1} of ${FORMATS.length} formats in this group`">
          <span class="console-ticks" aria-hidden="true">
            <span
              v-for="(other, index) in FORMATS"
              :key="other.slug"
              :class="other.group === entry.group ? 'console-tick-open' : 'console-tick-closed'"
              :style="{ animationDelay: `${index * 12}ms` }"
            />
          </span>
          <span class="console-gauge-read">group {{ kin.length + 1 }} / {{ FORMATS.length }}</span>
        </div>
      </div>
    </div>

    <div class="console-band">
      <p class="console-label console-rule-title">
        <span>Containers <span aria-hidden="true">[ "{{ SAMPLE_INPUT.slice(0, 12) }}…" through each, computed here ]</span></span>
        <span class="console-mark" aria-hidden="true" />
      </p>
      <dl class="facts-containers">
        <div v-for="row in containers" :key="row.variant.container.name">
          <dt><span class="console-tag">{{ row.variant.container.name }}</span></dt>
          <dd class="facts-container-about">
            <span class="facts-line facts-value">{{ row.variant.container.label }}</span>
            <span class="facts-line facts-dim"
              >{{ row.variant.container.extensions.join(" ") || "no file extension" }} ·
              {{ row.variant.container.magic ? `magic ${row.variant.container.magic}` : "no magic number" }} ·
              {{ row.variant.container.checksum ?? "no checksum" }}</span
            >
          </dd>
          <dd class="facts-container-sample">
            <UTooltip :text="hex.encode(row.bytes)">
              <span class="facts-line facts-value" tabindex="0">{{ row.bytes.length }} bytes · {{ row.head }}…</span>
            </UTooltip>
            <span class="facts-line facts-dim">{{ row.back ? "reads back" : "does not read back" }}{{ row.details ? ` · ${row.details}` : "" }}</span>
          </dd>
        </div>
      </dl>
    </div>

    <div v-if="options.length" class="console-band">
      <p class="console-label console-rule-title">
        <span>Options <span aria-hidden="true">[ as info() declares them ]</span></span>
        <span class="console-mark" aria-hidden="true" />
      </p>
      <dl class="facts-options">
        <div v-for="option in options" :key="option.name">
          <dt>
            <code>{{ option.name }}</code>
            <span class="facts-type">{{ option.values }}</span>
          </dt>
          <dd class="facts-requirement">{{ option.requirement }} · {{ option.scope }}</dd>
          <dd class="facts-description">{{ option.description }}</dd>
        </div>
      </dl>
    </div>

    <div class="console-band">
      <p class="console-label console-rule-title">
        <span>Access <span aria-hidden="true">[ library · CLI · playground ]</span></span>
        <span class="console-mark" aria-hidden="true" />
      </p>
      <dl class="facts-leads">
        <dd class="console-lead">
          <span class="console-tag">Import</span>
          <UTooltip :text="subpath">
            <code class="facts-code" tabindex="0"
              ><span class="tok-kw">import</span> { {{ entry.slug }} } from
              <span class="tok-str">"@agntn/compressions/{{ entry.slug }}"</span></code
            >
          </UTooltip>
          <span class="console-leader" aria-hidden="true" />
        </dd>
        <dd class="console-lead">
          <span class="console-tag">CLI</span>
          <UTooltip :text="cli">
            <code class="facts-code" tabindex="0"><span class="tok-fn">compressions</span> {{ cli.slice(13) }}</code>
          </UTooltip>
          <span class="console-leader" aria-hidden="true" />
        </dd>
        <dd class="console-lead">
          <span class="console-tag">Try</span>
          <NuxtLink :to="playground">playground<span class="facts-dim"> with the sample above</span></NuxtLink>
          <span class="console-leader" aria-hidden="true" />
        </dd>
        <dd v-if="kin.length" class="console-lead">
          <span class="console-tag">Kin</span>
          <span class="facts-kin"
            ><template v-for="(other, index) in kin" :key="other.slug"
              ><NuxtLink :to="other.to">{{ other.slug }}</NuxtLink
              ><template v-if="index < kin.length - 1">, </template></template
            ></span
          >
          <span class="console-leader" aria-hidden="true" />
        </dd>
      </dl>
    </div>

    <ConsoleResponse :title="title" :text="text" />

    <footer class="console-footer console-footer-plain">
      <ul class="console-links">
        <li>
          <NuxtLink to="/formats"><span aria-hidden="true">→ </span>All formats</NuxtLink>
        </li>
        <li>
          <NuxtLink to="/guide/compressing"><span aria-hidden="true">→ </span>Compressing and decompressing</NuxtLink>
        </li>
      </ul>
      <span class="console-meta">in your browser / no network</span>
    </footer>
  </section>
</template>

<style scoped>
.facts-none {
  color: var(--ui-text-dimmed);
}
/* Values stay on one line for every format; the whole value is in the tooltip. */
.facts-line {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
section :deep(.console-readout-rows > div) {
  grid-template-columns: 6.5rem minmax(0, 1fr);
}
.facts-value {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--ui-text-highlighted);
}
/* One row per option: the name and its type, whether it is required, then what it does in the reading face. */
.facts-options {
  display: grid;
  margin: 0;
}
.facts-options > div {
  display: grid;
  grid-template-columns: 11rem 7.5rem minmax(0, 1fr);
  gap: 4px 16px;
  align-items: baseline;
  padding: 8px 0;
}
.facts-options > div + div {
  border-top: 1px solid var(--console-line);
}
.facts-options dt {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 8px;
  align-items: baseline;
  min-width: 0;
}
.facts-options code {
  flex: none;
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--ui-text-highlighted);
}
.facts-type {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ui-text-dimmed);
}
.facts-requirement {
  margin: 0;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.facts-requirement[data-required] {
  color: var(--console-accent);
}
.facts-description {
  margin: 0;
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
/* One row per container: its tag, what it is, then the sample through it. */
.facts-containers {
  display: grid;
  margin: 0;
}
.facts-containers > div {
  display: grid;
  grid-template-columns: 6rem minmax(0, 1fr) minmax(0, 1fr);
  gap: 4px 16px;
  align-items: start;
  padding: 8px 0;
}
.facts-containers > div + div {
  border-top: 1px solid var(--console-line);
}
.facts-containers dt > .console-tag {
  margin: 0;
}
.facts-containers dd {
  display: grid;
  gap: 2px;
  min-width: 0;
  margin: 0;
  font-family: var(--font-mono);
  font-size: 12px;
}
.facts-code {
  min-width: 0;
  overflow: hidden;
  font: inherit;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ui-text-highlighted);
}
.facts-dim {
  color: var(--ui-text-dimmed);
}
.console-lead > a:hover .facts-dim {
  color: inherit;
}
.facts-kin {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.facts-kin a:hover {
  color: var(--console-accent);
}
.facts-leads {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
  gap: 0 28px;
  margin: 0;
}
.facts-leads > .console-lead {
  margin: 0 0 8px;
  flex-wrap: nowrap;
  min-width: 0;
}
@media (width < 640px) {
  .facts-leads .console-leader {
    display: none;
  }
  /* One column on a phone: the name, then the default and scope, then what it does. */
  .facts-options > div {
    grid-template-columns: minmax(0, 1fr);
  }
  .facts-containers > div {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
