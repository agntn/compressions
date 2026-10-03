<script setup lang="ts">
import { hex } from "@agntn/encodings/hex";
import { create, identify } from "@agntn/compressions";
import type { LandingSample } from "../../composables/useLandingSample";
import { SAMPLE_INPUT } from "../../utils/formats";
import { optionLiteral } from "../../utils/format";
import { tokens } from "../../utils/tokens";

const props = defineProps<{ sample: LandingSample }>();
const emit = defineEmits<{ step: [delta: number]; pause: [paused: boolean] }>();

const { copied, copy } = useCopied();

/**
 * What `identify` says about the stream, as the comment under the call reads it.
 *
 * @param {LandingSample} sample - The sample.
 * @returns {string} The comment.
 */
function guessComment(sample: LandingSample): string {
  const [best] = identify(sample.bytes);
  if (!best) return "// undefined, nothing reads it";
  const said = `// "${best.format}", container "${best.container}"`;
  return best.format === sample.variant.format.slug && best.container === sample.variant.container.name ? said : `${said}, not what wrote it`;
}

/** Every variant gets the same eleven lines, so the file keeps one height while the sample walks. */
const lines = computed(() => {
  const { variant, bytes, options, details } = props.sample;
  const slug = variant.format.slug;
  const optionsArg = Object.keys(options).length > 0 ? `, ${optionLiteral(options)}` : "";
  const shownDetails = Object.keys(details).length > 0 ? optionLiteral(details) : "{}";
  const head = hex.encode(bytes.subarray(0, 8));
  const writes = variant.format.info.compress;
  const back = create(slug).decompress(bytes, options).bytes;
  return [
    'import { compress, decompress, identify } from "@agntn/compressions";',
    writes ? "" : 'import { readFileSync } from "node:fs";',
    `// ${variant.container.label}, ${variant.container.standard}`,
    writes
      ? `const bytes = compress("${slug}", "${SAMPLE_INPUT}"${optionsArg});`
      : `const bytes = readFileSync("hello${variant.container.extensions[0] ?? ""}");  // from the ${slug} CLI`,
    `// ${bytes.length} bytes: ${head}${bytes.length > 8 ? " ..." : ""}`,
    `const { bytes: out, details } = decompress("${slug}", bytes${optionsArg});`,
    `// details ${shownDetails}`,
    `new TextDecoder().decode(out);  // ${JSON.stringify(new TextDecoder().decode(back))}`,
    "",
    "identify(bytes)[0];",
    guessComment(props.sample),
  ];
});
</script>

<template>
  <section
    class="tool-console landing-file"
    aria-label="One format, written, read back and recognized"
    @mouseenter="emit('pause', true)"
    @mouseleave="emit('pause', false)"
    @focusin="emit('pause', true)"
    @focusout="emit('pause', false)"
  >
    <span class="console-cross console-cross-tl" aria-hidden="true">+</span>
    <span class="console-cross console-cross-br" aria-hidden="true">+</span>

    <header class="console-bar">
      <span class="console-title file-name"
        ><span class="console-tag">File</span
        ><Transition name="compressions-roll" mode="out-in"
          ><span :key="sample.key" class="compressions-roll-slot"
            >{{ sample.variant.format.slug }}.ts</span
          ></Transition
        ></span
      >
      <span class="console-meta">{{ sample.variant.container.name }} · computed here</span>
      <span class="console-mark" aria-hidden="true" />
    </header>
    <div class="console-ruler" aria-hidden="true">
      <span :key="sample.key" class="console-cursor" />
    </div>

    <div class="file-body">
      <p class="console-label console-rule-title">
        <span>Round trip <span aria-hidden="true">[ and back ]</span></span>
        <span class="console-mark" aria-hidden="true" />
        <UButton
          color="neutral"
          variant="subtle"
          :icon="copied === 'file' ? 'i-lucide-check' : 'i-lucide-copy'"
          :label="copied === 'file' ? 'copied' : 'copy'"
          :aria-label="copied === 'file' ? 'Copied' : 'Copy the file'"
          @click="copy('file', lines.join('\n'))"
        />
      </p>
      <!-- prettier-ignore -->
      <pre class="console-snippet console-lines file-lines"><code><span v-for="(line, index) in lines" :key="index"><span class="file-code"><span v-for="(token, part) in tokens(line)" :key="part" :class="token.cls">{{ token.text }}</span></span></span></code></pre>
    </div>

    <footer class="console-footer console-footer-plain">
      <NuxtLink :to="sample.variant.format.to" class="file-link"
        ><span aria-hidden="true">→ </span>{{ sample.variant.format.info.label
        }}<span> · {{ sample.variant.format.to }}</span></NuxtLink
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
.file-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-name :deep(.compressions-roll-slot) {
  display: inline;
}
.file-body {
  padding: 14px 20px 16px;
}
.file-body > .console-rule-title {
  margin-bottom: 10px;
}
/* One line per code line whatever the format: the number in its own column, a long value ends in an
   ellipsis there and never takes the number with it; copy hands out the whole line. */
.file-lines > code > span {
  display: grid;
  grid-template-columns: 2.25em minmax(0, 1fr);
  column-gap: 1em;
  padding-left: 0;
  text-indent: 0;
}
.file-lines > code > span::before {
  margin-right: 0;
}
.file-code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: pre;
}
.file-code :deep(*) {
  white-space: pre;
  overflow-wrap: normal;
}
.file-link {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ui-text-highlighted);
}
.file-link > span:last-child {
  color: var(--ui-text-dimmed);
}
.file-link:hover {
  color: var(--console-accent);
}
.file-link:focus-visible {
  outline: 1px solid var(--ui-primary);
  outline-offset: 3px;
}
@media (width < 640px) {
  .file-body > .console-rule-title > .console-mark {
    display: none;
  }
}
@media (width < 400px) {
  .file-body {
    padding-inline: 14px;
  }
  .file-body > .console-rule-title > span:first-child > span {
    display: none;
  }
}
</style>
