import { CHECKSUM_COUNT, FORMATS } from "./utils/formats";
import { TOOLS } from "./utils/tools";
import { spellOut, spellOutCapital } from "./utils/format";

export default defineAppConfig({
  docus: {
    colorMode: "dark",
  },
  /** Landing JSON-LD: a free SoftwareApplication published by the agntn Organization, tied to GitHub and npm through sameAs. */
  seo: {
    title: "@agntn/compressions",
    description: `${spellOutCapital(FORMATS.length)} compression formats behind one local API, a CLI and ${spellOut(TOOLS.length)} agent tools. gzip, zlib, deflate, bzip2, xz, lzma, zstd, brotli, lz4 and Unix compress. ${spellOutCapital(CHECKSUM_COUNT)} containers checked by checksum. Written from the specs, all offline.`,
    schema: {
      type: "SoftwareApplication",
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Node.js",
      price: 0,
      sameAs: ["https://github.com/agntn/compressions", "https://www.npmjs.com/package/@agntn/compressions"],
      organization: {
        name: "agntn",
        url: "https://agntn.dev",
        logo: "https://agntn.dev/icon-512.png",
        sameAs: ["https://github.com/agntn", "https://www.npmjs.com/org/agntn"],
      },
    },
  },
  header: {
    title: "@agntn/compressions",
  },
  /** Sections as tabs under the header, so the sidebar holds one section as the lists grow. */
  navigation: {
    sub: "header",
  },
  github: {
    url: "https://github.com/agntn/compressions",
    branch: "main",
    rootDir: "docs",
  },
  /** Docus adds the repository link itself, a GitHub social next to it is the same icon twice. */
  socials: {
    npm: "https://www.npmjs.com/package/@agntn/compressions",
  },
  ui: {
    colors: {
      primary: "amber",
      neutral: "slate",
    },
    /**
     * Buttons in the instrument grammar, by variant, so a page writes <UButton> and gets the look
     * from app.css: primary solid and neutral outline are boxed actions with the glyph in its own
     * cell, neutral subtle the small control of an instrument (`square` for a step button), and
     * the site's own `chip` variant a chip, primary for the picked one. Docus renders its search
     * field as neutral soft and its own buttons as neutral ghost and link, so those stay default.
     */
    button: {
      slots: {
        base: "h-9 rounded-lg px-3.5 text-sm leading-none font-medium cursor-pointer transition-colors",
      },
      variants: {
        variant: {
          chip: "",
        },
      },
      compoundVariants: [
        {
          color: "primary",
          variant: "solid",
          class: "compressions-action compressions-action-primary ring-0",
        },
        {
          color: "neutral",
          variant: "outline",
          class: "compressions-action ring-0",
        },
        {
          color: "neutral",
          variant: "subtle",
          class: "compressions-control ring-0",
        },
        {
          color: "neutral",
          variant: "subtle",
          square: true,
          class: "compressions-control-square",
        },
        {
          color: "neutral",
          variant: "chip",
          class: "compressions-chip",
        },
        {
          color: "primary",
          variant: "chip",
          class: "compressions-chip compressions-chip-on",
        },
      ],
    },
    /** Status words as boxed mono capitals: neutral quiet, subtle bright, primary the accent, error red. */
    badge: {
      slots: {
        base: "compressions-badge",
      },
      compoundVariants: [
        { color: "neutral", variant: "subtle", class: "compressions-badge-bright ring-0" },
        { color: "neutral", variant: "outline", class: "ring-0" },
        { color: "primary", variant: "outline", class: "compressions-badge-accent ring-0" },
        { color: "error", variant: "outline", class: "compressions-badge-error ring-0" },
      ],
    },
    /** Tabs as mono capitals on a quiet rule, the active one over an accent segment. */
    tabs: {
      compoundVariants: [
        {
          variant: "link",
          class: {
            list: "compressions-tabs-list",
            trigger: "compressions-tabs-trigger",
            indicator: "compressions-tabs-indicator",
          },
        },
      ],
    },
    /** A field with variant none sits inside a readout row: the row is its frame, the value is mono. */
    input: {
      compoundVariants: [
        { variant: "none", class: { base: "compressions-field", leadingIcon: "compressions-field-icon" } },
      ],
    },
    textarea: {
      compoundVariants: [{ variant: "none", class: { base: "compressions-field" } }],
    },
    selectMenu: {
      slots: {
        content: "compressions-menu rounded-none ring-0 shadow-none bg-transparent",
        group: "compressions-menu-group",
        item: "compressions-menu-item",
        itemLeadingIcon: "compressions-field-icon",
        input: "compressions-menu-input",
      },
      compoundVariants: [
        {
          variant: "none",
          class: {
            base: "compressions-field",
            leadingIcon: "compressions-field-icon",
            trailingIcon: "compressions-field-icon",
          },
        },
      ],
    },
    /** A failed read: a red edge and the message in mono, no box. */
    alert: {
      compoundVariants: [
        {
          color: "error",
          variant: "outline",
          class: {
            root: "compressions-alert ring-0",
            title: "compressions-alert-title",
            icon: "compressions-alert-icon",
          },
        },
      ],
    },
    /** A tooltip is a console label: flat, clipped corner, mono, and it wraps, because it carries full addresses. */
    tooltip: {
      slots: {
        content:
          "compressions-tooltip h-auto max-w-[min(32rem,calc(100vw-2rem))] rounded-none bg-transparent shadow-none ring-0 px-3 py-1.5 data-[state=delayed-open]:animate-none data-[state=closed]:animate-none",
        text: "whitespace-normal text-highlighted [overflow-wrap:anywhere]",
      },
    },
    /** The site header, the search field and the keys in the instrument grammar; the look lives in app.css. */
    header: {
      slots: {
        root: "compressions-site-header",
      },
    },
    contentSearchButton: {
      slots: {
        base: "compressions-search",
      },
    },
    /** The search modal and its palette in the instrument grammar; the look lives in app.css (portalled). */
    contentSearch: {
      slots: {
        modal: "compressions-search-modal",
      },
    },
    commandPalette: {
      slots: {
        root: "compressions-palette",
        input: "compressions-palette-input",
        close: "compressions-palette-close",
        group: "compressions-palette-group",
        label: "compressions-palette-label",
        item: "compressions-palette-item",
        itemLeadingIcon: "compressions-palette-icon",
        itemLabel: "compressions-palette-text",
        itemLabelBase: "compressions-palette-name",
        itemDescription: "compressions-palette-about",
        empty: "compressions-palette-empty",
      },
    },
    kbd: {
      base: "compressions-kbd",
    },
    pageHeader: {
      slots: {
        root: "compressions-page-header py-8 border-b-0",
        headline: "compressions-eyebrow mb-3",
        title: "text-3xl sm:text-4xl font-medium tracking-tight text-highlighted",
        description: "text-base leading-7 text-muted",
      },
    },
    /**
     * The layouts with a right aside get one track per panel instead of the ten column grid: the toc
     * takes a fixed 13.75rem, a little wider than Nuxt UI's, and the text keeps 52rem on a large
     * screen, the width the rosters need before they stack.
     */
    page: {
      compoundVariants: [
        {
          left: true,
          right: true,
          class: {
            root: "lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_min(13.75rem,20%)]",
            left: "lg:col-span-1",
            center: "lg:col-span-1",
            right: "lg:col-span-1",
          },
        },
        {
          left: false,
          right: true,
          class: {
            root: "lg:grid-cols-[minmax(0,1fr)_min(13.75rem,20%)]",
            center: "lg:col-span-1",
            right: "lg:col-span-1",
          },
        },
      ],
    },
    /** Nuxt UI truncates TOC entries; headings here are sentences, so let them wrap. */
    contentToc: {
      slots: {
        linkText: "whitespace-normal",
      },
    },
    prose: {
      callout: {
        slots: {
          base: "rounded-xl px-4 py-3.5",
        },
      },
      card: {
        slots: {
          base: "rounded-xl compressions-frame border-0 p-5 bg-default hover:bg-muted",
          icon: "size-5 mb-3 text-muted transition-colors group-hover:text-primary",
          title: "text-sm font-medium",
          description: "text-sm text-muted",
        },
      },
      cardGroup: {
        base: "grid grid-cols-1 sm:grid-cols-2 gap-3 my-5 *:my-0",
      },
      /** Inline code in the instrument grammar; the look lives in `.compressions-code` in app.css. */
      code: {
        base: "compressions-code",
      },
      pre: {
        slots: {
          header: "border-default bg-default",
          base: "border-default bg-muted",
        },
      },
    },
    pageHero: {
      slots: {
        title: "font-medium tracking-tight",
        description: "text-base leading-7 sm:text-lg",
      },
    },
  },
});
