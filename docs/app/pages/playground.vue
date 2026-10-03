<script setup lang="ts">
import { version } from "@agntn/compressions";
import { CHECKSUM_COUNT, FORMATS, VARIANTS } from "../utils/formats";
import { spellOut } from "../utils/format";
import { TOOLS } from "../utils/tools";

definePageMeta({ layout: "default" });

const title = "Playground";
const description = `Compress and decompress with any of the ${spellOut(FORMATS.length)} formats, identify bytes nobody named, peel nested layers, or list them all. In the browser, with the same executors the CLI and the agent tools run.`;
/** The OG pipeline drops commas from its props, so the card gets a version written without them. */
const cardDescription = `Compress and decompress and identify with any of the ${spellOut(FORMATS.length)} formats. In the browser with the library itself.`;

useSeo({
  title,
  description,
  type: "article",
  breadcrumbs: [{ title: "Playground", path: "/playground" }],
});

defineOgImage(
  "Docs.takumi",
  { headline: "Playground", title, description: cardDescription },
  { alt: "The @agntn/compressions playground: compress, decompress and identify in the browser" },
);
</script>

<template>
  <div class="compressions-landing not-prose">
    <header class="compressions-hero hero-page">
      <div class="hero-zone">
        <span class="hero-cross hero-cross-tl" aria-hidden="true">+</span>
        <span class="hero-cross hero-cross-tr" aria-hidden="true">+</span>
        <span class="hero-bracket hero-bracket-l" aria-hidden="true" />
        <span class="hero-bracket hero-bracket-r" aria-hidden="true" />

        <p class="console-id">
          <span class="console-id-tag">ID</span>
          <span>playground</span>
          <span class="console-id-sep" aria-hidden="true">/</span>
          <span>@agntn/compressions v{{ version }}</span>
        </p>

        <h1 class="hero-title">
          Any format. <br class="playground-break" />
          <span>Unpacked in your tab.</span>
        </h1>
        <p class="hero-lead">
          The page imports @agntn/compressions and runs the tool executors right here. Paste the
          weird blob, flip a byte, watch the checksum say no, cut it in half and read what's left.
          Nothing leaves the tab, and every state is a link you can send to a friend who's stuck on
          the same puzzle.
        </p>

        <dl class="hero-metrics">
          <div>
            <dt>Tools</dt>
            <dd>{{ TOOLS.length }}</dd>
            <dd class="hero-metric-sub">same as MCP, Pi and OMP</dd>
          </div>
          <div>
            <dt>Formats</dt>
            <dd>{{ FORMATS.length }}</dd>
            <dd class="hero-metric-sub">{{ VARIANTS.length }} containers, {{ CHECKSUM_COUNT }} with checksum</dd>
          </div>
          <div>
            <dt>Network</dt>
            <dd class="hero-metric-accent">0 <span>calls</span></dd>
            <dd class="hero-metric-sub">the library never asks</dd>
          </div>
        </dl>

        <p class="playground-note">
          <span class="console-tag">Note</span>
          <span
            >Nothing leaves the tab, but whatever you paste does land in the address bar and in any
            link you copy. A wallet file decompresses fine here. It's still a wallet file in a URL.</span
          >
        </p>
      </div>

      <div class="hero-instrument hero-instrument-keep">
        <svg class="hero-circuit" viewBox="0 0 160 56" aria-hidden="true">
          <path class="hero-circuit-rail" d="M80 0V16L96 32V56" />
          <path class="hero-circuit-live" d="M80 0V16L96 32V56" pathLength="1" />
          <path class="hero-circuit-seg" d="M96 38V48" />
          <rect class="hero-circuit-node" x="92.5" y="52.5" width="7" height="7" />
        </svg>
        <span class="hero-circuit-tag" aria-hidden="true">call</span>
        <CompressionsPlayground />
      </div>
    </header>
  </div>
</template>

<style scoped>
/* One sentence per line on wide screens; narrow, the title wraps where it fits. */
@media (width < 64rem) {
  .playground-break {
    display: none;
  }
}
/* The note reads as a line of the zone, like the share bar's legend on the landing: no box of its own. */
.playground-note {
  display: flex;
  justify-content: center;
  align-items: baseline;
  gap: 12px;
  max-width: 44rem;
  margin: 28px auto 0;
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.6;
  text-align: left;
  color: var(--ui-text-muted);
}
.playground-note > .console-tag {
  flex: none;
  margin: 0;
  color: var(--console-accent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--console-accent) 55%, transparent);
}
</style>
