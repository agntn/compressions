<script setup lang="ts">
import { SAMPLE_INPUT, CHECKSUM_COUNT, FORMATS, GROUPS, VARIANTS } from "../../utils/formats";
import { spellOut, spellOutCapital } from "../../utils/format";
import { TOOLS } from "../../utils/tools";

const { samples, paused, current, step } = useLandingSample();
</script>

<template>
  <div class="compressions-landing not-prose">
    <LandingHero :sample="current" :samples="samples" @step="step" @pause="paused = $event" />

    <LandingFeature
      title="Same call, every format"
      to="/guide/compressing"
      link="Compressing and decompressing"
      :checks="[
        'compress(name, input) and decompress(name, bytes). That\'s the API on day one',
        'gzip and zlib are deflate with a container. xz is lzma with one. One family, one option',
        'Every checksum gets checked on the way out, and a wrong one is an error, not a shrug',
      ]"
    >
      Pick a format, hand it bytes, get bytes back. Then do it backwards. This file walks through
      {{ samples.length }} containers and none of it is a recording. Your browser runs every line
      with the same TypeScript the package ships. zstd and brotli come from their own CLIs, since
      this package reads them and doesn't write them. The rest it writes right here.
      <template #visual>
        <LandingRotatingCode :sample="current" @step="step" @pause="paused = $event" />
      </template>
    </LandingFeature>

    <LandingFeature
      title="A guess that shows its work"
      to="/guide/identify"
      link="Identify and peel"
      :checks="[
        'A magic number with a matching checksum beats everything',
        'Raw deflate and brotli have no magic. They count only when they eat every byte',
        'peel takes the layers off one by one, gzip inside xz inside zstd',
      ]"
      reverse
    >
      Somebody hands you a blob that starts with <code class="compressions-code">28 b5 2f fd</code>
      and asks what it is. A model squints and says gzip, probably.
      <code class="compressions-code">identify</code> actually tries every container whose start
      fits, decompresses it for real and ranks what worked. Each score comes with its reasons, so
      you can disagree with it. And when nothing fits? It says so, and tells you when the bytes
      look like a ZIP it doesn't open.
      <template #visual>
        <LandingIdentify :sample="current" @pause="paused = $event" />
      </template>
    </LandingFeature>

    <section class="compressions-section">
      <div class="mx-auto w-full max-w-[var(--ui-container)] px-8 py-20 sm:px-12 lg:px-16">
        <div class="max-w-2xl">
          <h2 class="text-2xl font-medium tracking-tight text-highlighted sm:text-[1.75rem]">
            {{ spellOutCapital(FORMATS.length) }} formats, {{ spellOut(VARIANTS.length) }} containers
          </h2>
          <p class="mt-4 text-sm leading-6 text-muted">
            Prefix codes after LZ77, where deflate, zstd and brotli live. A range coder that learns
            every bit, which is LZMA. Block sorting, which is bzip2 being bzip2. LZ4, which codes
            nothing at all and wins on speed. And the dictionary of Unix compress, older than most
            of the internet. {{ spellOutCapital(CHECKSUM_COUNT) }} containers check themselves on
            the way out. Every one written from its RFC or spec, with no zlib, no liblzma and no
            WASM underneath, grouped {{ spellOut(GROUPS.length) }} ways below.
          </p>
          <p class="landing-entry">
            <span class="console-tag">Import</span>
            <code>import { formats, create } from "@agntn/compressions"</code>
          </p>
        </div>
        <LandingRegistry :sample="current" class="mt-10" @pause="paused = $event" />
      </div>
    </section>

    <LandingFeature
      :title="`${spellOutCapital(TOOLS.length)} tools, one executor`"
      to="/guide/agents"
      link="MCP, Pi, OMP and AI SDK"
      :checks="[
        TOOLS.join(', '),
        'A misspelled argument is an error. An option of another format is named, not swallowed',
        'Long output comes in windows, and a bomb stops at 64 MiB',
      ]"
      reverse
    >
      Ask a model to gunzip something and it describes gzip to you. Give it
      <code class="compressions-code">compressions_decompress</code> and it opens the thing.
      <code class="compressions-code">compressions mcp</code>, the Pi and OMP extensions and
      <code class="compressions-code">@agntn/compressions/ai</code> all call the same executors.
      This page runs them too, so the dialog shows exactly what a model reads for
      <code class="compressions-code">"{{ SAMPLE_INPUT.slice(0, 12) }}…"</code>.
      <template #visual>
        <LandingToolCall :sample="current" @pause="paused = $event" />
      </template>
    </LandingFeature>

    <LandingFeature
      title="Your own format is one call"
      to="/guide/custom"
      link="Custom formats"
      :checks="[
        'defineCompression takes the metadata and two functions. The checks come free',
        'register(format) and compress, decompress and the tools see it',
        'out.fail() gives a broken stream the same error, partial reads included',
      ]"
    >
      Need run-length coding because some puzzle printed counts and bytes? Write the two functions,
      register the result, and the registry treats it like a built-in. Options get checked, the
      output limit holds, and <code class="compressions-code">partial</code> works on your format
      the same way it works on gzip. No plugin manifest, no base class to fight.
      <template #visual>
        <LandingCustom />
      </template>
    </LandingFeature>

    <section class="compressions-section">
      <div class="mx-auto w-full max-w-[var(--ui-container)] px-8 py-20 sm:px-12 lg:px-16">
        <LandingStart />
      </div>
    </section>
  </div>
</template>

<style scoped>
.landing-entry {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin: 20px 0 0;
  min-width: 0;
}
.landing-entry > .console-tag {
  flex: none;
  margin: 0;
}
.landing-entry > code {
  min-width: 0;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ui-text-highlighted);
}
</style>
