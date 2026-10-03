<script setup lang="ts">
import { version } from "../../../../package.json";
import type { LandingSample } from "../../composables/useLandingSample";
import { CHECKSUM_COUNT, FORMATS, VARIANTS, WRITER_COUNT } from "../../utils/formats";
import { TOOLS } from "../../utils/tools";

defineProps<{ sample: LandingSample; samples: readonly LandingSample[] }>();
const emit = defineEmits<{ step: [delta: number]; pause: [paused: boolean] }>();

const INSTALL = "pnpm add @agntn/compressions";
const { copied, copy } = useCopied();
</script>

<template>
  <header class="compressions-hero hero-page">
    <div class="hero-zone">
      <span class="hero-cross hero-cross-tl" aria-hidden="true">+</span>
      <span class="hero-cross hero-cross-tr" aria-hidden="true">+</span>
      <span class="hero-bracket hero-bracket-l" aria-hidden="true" />
      <span class="hero-bracket hero-bracket-r" aria-hidden="true" />

      <p class="console-id">
        <span class="console-id-tag">ID</span>
        <span>@agntn/compressions</span>
        <span class="console-id-sep" aria-hidden="true">/</span>
        <span>v{{ version }}</span>
      </p>

      <h1 class="hero-title">Unpack it. <span>Don't guess it.</span></h1>
      <p class="hero-lead">
        A blob starts with <code>1f 8b</code> and somebody asks what's inside. This opens it. gzip,
        zlib, raw deflate, bzip2, xz and .lzma, zstd, brotli, lz4 and Unix compress, every checksum
        checked on the way out. Written from the RFCs and the format specs, no zlib binding
        underneath. One call in TypeScript, the terminal and your agent. Nothing leaves the machine.
      </p>

      <dl class="hero-metrics">
        <div>
          <dt>Formats</dt>
          <dd>{{ FORMATS.length }}</dd>
          <dd class="hero-metric-sub">in {{ VARIANTS.length }} containers</dd>
        </div>
        <div>
          <dt>Written too</dt>
          <dd>{{ WRITER_COUNT }}</dd>
          <dd class="hero-metric-sub">{{ CHECKSUM_COUNT }} with a checksum, {{ TOOLS.length }} agent tools</dd>
        </div>
        <div>
          <dt>Network calls</dt>
          <dd class="hero-metric-accent">0</dd>
          <dd class="hero-metric-sub">every value computed in place</dd>
        </div>
      </dl>

      <div class="console-actions">
        <UButton
          to="/guide"
          color="primary"
          variant="solid"
          trailing-icon="i-lucide-arrow-right"
          label="Get started"
        />
        <UButton
          to="https://github.com/agntn/compressions"
          target="_blank"
          color="neutral"
          variant="outline"
          icon="i-simple-icons-github"
          label="Star on GitHub"
        />
      </div>
      <div class="console-install">
        <span class="console-install-tag">Install</span>
        <code><span class="console-install-prompt">$</span> {{ INSTALL }}</code>
        <UButton
          color="neutral"
          variant="subtle"
          :icon="copied === 'install' ? 'i-lucide-check' : 'i-lucide-copy'"
          :aria-label="copied === 'install' ? 'Copied' : 'Copy install command'"
          @click="copy('install', INSTALL)"
        />
      </div>
    </div>

    <!-- One text through one format, the stream it writes byte by byte. -->
    <div class="hero-instrument">
      <svg class="hero-circuit" viewBox="0 0 160 56" aria-hidden="true">
        <path class="hero-circuit-rail" d="M80 0V16L96 32V56" />
        <path :key="sample.key" class="hero-circuit-live" d="M80 0V16L96 32V56" pathLength="1" />
        <path class="hero-circuit-seg" d="M96 38V48" />
        <rect class="hero-circuit-node" x="92.5" y="52.5" width="7" height="7" />
      </svg>
      <span class="hero-circuit-tag" aria-hidden="true">compress</span>
      <LandingStream :sample="sample" :samples="samples" @step="emit('step', $event)" @pause="emit('pause', $event)" />
    </div>
  </header>
</template>
