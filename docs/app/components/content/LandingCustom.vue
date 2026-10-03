<script setup lang="ts">
import { tokens } from "../../utils/tokens";

const { copied, copy } = useCopied();

/** A format of your own: `defineCompression` with metadata and two functions, then register. */
const FILE = [
  'import { compress, decompress, defineCompression, register } from "@agntn/compressions";',
  "",
  "const rle = defineCompression({",
  "  info: {",
  '    name: "rle",',
  '    label: "Run-length",',
  '    description: "Each run of one byte as its length and the byte",',
  '    standard: "none",',
  '    containers: [{ name: "rle", label: "Run-length", standard: "none", extensions: [".rle"] }],',
  "    compress: true,",
  "    options: [],",
  "  },",
  "  compress(bytes) {",
  "    const out: number[] = [];",
  "    for (let i = 0, run = 1; i < bytes.length; i += run, run = 1) {",
  "      while (run < 255 && bytes[i + run] === bytes[i]) run++;",
  "      out.push(run, bytes[i]!);",
  "    }",
  "    return Uint8Array.from(out);",
  "  },",
  "  decompress(data, out) {",
  '    if (data.length % 2) throw out.fail("a run needs its length and its byte");',
  "    for (let i = 0; i < data.length; i += 2) out.copyByte(data[i + 1]!, data[i]!);",
  "    return {};",
  "  },",
  "});",
  "",
  "register(rle);",
  'compress("rle", "aaaabbb");                     // Uint8Array [4, 97, 3, 98]',
  'decompress("rle", compress("rle", "aaaabbb")).bytes;  // the bytes of "aaaabbb"',
] as const;

/**
 * What the panel shows: the shape the section is about, with `info`, `compress` and `decompress`
 * folded the way an editor folds them. Copy hands out `FILE`, every line.
 */
const LINES = [
  ...FILE.slice(0, 3),
  '  info: { name: "rle", label, description, containers, compress: true, options: [] },',
  "  compress(bytes) { /* a length and a byte per run */ },",
  "  decompress(data, out) { /* out.copyByte(byte, length) per pair */ },",
  "});",
  ...FILE.slice(26),
] as const;
</script>

<template>
  <section class="tool-console landing-custom" aria-label="A format of your own">
    <span class="console-cross console-cross-tl" aria-hidden="true">+</span>
    <span class="console-cross console-cross-br" aria-hidden="true">+</span>

    <header class="console-bar">
      <span class="console-title"><span class="console-tag">File</span>rle.ts</span>
      <span class="console-meta">folded · copy is whole</span>
      <span class="console-mark" aria-hidden="true" />
      <UButton
        color="neutral"
        variant="subtle"
        :icon="copied === 'rle' ? 'i-lucide-check' : 'i-lucide-copy'"
        :label="copied === 'rle' ? 'copied' : 'copy'"
        :aria-label="copied === 'rle' ? 'Copied' : 'Copy rle.ts'"
        @click="copy('rle', FILE.join('\n'))"
      />
    </header>
    <div class="console-ruler" aria-hidden="true" />

    <div class="custom-body">
      <!-- prettier-ignore -->
      <pre class="console-snippet console-lines"><code><span v-for="(line, index) in LINES" :key="index"><span v-for="(token, part) in tokens(line)" :key="part" :class="token.cls">{{ token.text }}</span></span></code></pre>
    </div>
  </section>
</template>

<style scoped>
.custom-body {
  padding: 14px 20px 18px;
}
/* Breaks only between words: a string split at any character is hard to read. */
.custom-body > .console-snippet {
  overflow-wrap: break-word;
}
@media (width < 400px) {
  .custom-body {
    padding-inline: 14px;
  }
}
</style>
