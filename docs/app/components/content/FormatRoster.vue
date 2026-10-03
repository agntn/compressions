<script setup lang="ts">
import type { TableColumn } from "@nuxt/ui";
import { FORMATS, RATIO_BYTES, checksums, ratio, type FormatEntry } from "../../utils/formats";
import { ROSTER_CLASS, ROSTER_TABLE_UI } from "../../utils/roster";

interface Row {
  readonly entry: FormatEntry;
  readonly slug: string;
  readonly label: string;
  /** The containers, default first. */
  readonly containers: readonly string[];
  /** Bytes out per hundred in on the roster's text, or -1 for a format this package only reads. */
  readonly ratio: number;
  readonly checksum: string;
  readonly writes: string;
  readonly standard: string;
}

/** Every value comes from `info()` or the library itself; the listing order is the default. */
const rows = computed<Row[]>(() =>
  FORMATS.map((entry) => ({
    entry,
    slug: entry.slug,
    label: entry.info.label,
    containers: entry.info.containers.map((container) => container.name),
    ratio: ratio(entry) ?? -1,
    checksum: checksums(entry),
    writes: entry.info.compress ? "yes" : "no",
    standard: entry.info.standard,
  })),
);

const sorting = ref<{ id: string; desc: boolean }[]>([]);

const roster = useTemplateRef<HTMLElement>("roster");
useRosterFlip(
  () => roster.value,
  () => sorting.value,
);

const allColumns: TableColumn<Row>[] = [
  { accessorKey: "label", header: "Format", sortingFn: "text", meta: { class: { th: "w-[14rem]" } } },
  {
    id: "containers",
    header: "Containers",
    enableSorting: false,
    meta: { class: { th: "w-[8rem]", td: "min-w-0" } },
  },
  {
    accessorKey: "ratio",
    header: "Ratio",
    sortingFn: "basic",
    meta: { class: { th: "w-[6rem]" } },
  },
  {
    accessorKey: "checksum",
    header: "Checksum",
    sortingFn: "text",
    meta: { class: { th: "w-[10rem]", td: "min-w-0" } },
  },
  {
    accessorKey: "writes",
    header: "Writes",
    sortingFn: "text",
    meta: { class: { th: "w-[4.5rem]" } },
  },
  {
    id: "standard",
    header: "Standard",
    enableSorting: false,
    // No width: the standard takes what the other columns leave, so the table never runs past its frame.
    meta: { class: { td: "min-w-0" } },
  },
];

const columns = allColumns;

const order = computed(() => {
  const [first] = sorting.value;
  if (first === undefined) return "listing order";
  const label = allColumns.find((column) => "accessorKey" in column && column.accessorKey === first.id)?.header;
  return `by ${String(label).toLowerCase()} ${first.desc ? "descending" : "ascending"}`;
});
</script>

<template>
  <section ref="roster" class="roster not-prose my-6" aria-label="Formats">
    <span class="console-cross console-cross-tl" aria-hidden="true">+</span>
    <span class="console-cross console-cross-br" aria-hidden="true">+</span>
    <header :class="ROSTER_CLASS.bar">
      <span :class="ROSTER_CLASS.title">formats()</span>
      <span :class="ROSTER_CLASS.meta">{{ rows.length }} formats · {{ order }}</span>
    </header>
    <div class="roster-ruler" aria-hidden="true" />
    <UTable
      v-model:sorting="sorting"
      :data="rows"
      :columns="columns"
      :get-row-id="(row) => row.slug"
      :ui="ROSTER_TABLE_UI"
    >
      <template #label-header="{ column }"><RosterSort :column="column" label="Format" /></template>
      <template #ratio-header="{ column }"><RosterSort :column="column" label="Ratio" /></template>
      <template #checksum-header="{ column }"><RosterSort :column="column" label="Checksum" /></template>
      <template #writes-header="{ column }"><RosterSort :column="column" label="Writes" /></template>
      <template #label-cell="{ row }">
        <NuxtLink :to="row.original.entry.to" :class="[ROSTER_CLASS.name, 'max-w-full items-baseline']">
          <UIcon :name="row.original.entry.icon" class="relative top-0.5 size-3.5 flex-none" aria-hidden="true" />
          <span class="truncate">{{ row.original.label }}</span>
          <span :class="[ROSTER_CLASS.id, 'flex-none']">{{ row.original.slug }}</span>
        </NuxtLink>
      </template>
      <template #containers-cell="{ row }">
        <span class="block text-muted"
          ><template v-for="(name, index) in row.original.containers" :key="name"
            ><span :class="index === 0 ? 'text-highlighted' : ''">{{ name }}</span
            ><template v-if="index < row.original.containers.length - 1">, </template></template
          ></span
        >
      </template>
      <template #ratio-cell="{ row }">
        <span v-if="row.original.ratio >= 0" class="whitespace-nowrap text-highlighted"
          ><span class="@min-[52rem]/roster:hidden text-dimmed">ratio </span>{{ row.original.ratio }}%</span
        >
        <span v-else class="whitespace-nowrap text-dimmed">reads only</span>
      </template>
      <template #checksum-cell="{ row }">
        <span :class="row.original.checksum === 'none' ? 'text-dimmed' : 'text-highlighted'"
          ><span class="@min-[52rem]/roster:hidden">checksum </span>{{ row.original.checksum }}</span
        >
      </template>
      <template #writes-cell="{ row }">
        <span :class="row.original.writes === 'yes' ? 'text-highlighted' : 'text-dimmed'"
          ><span class="@min-[52rem]/roster:hidden">writes </span>{{ row.original.writes }}</span
        >
      </template>
      <template #standard-cell="{ row }">
        <span :class="ROSTER_CLASS.count"
          ><span :class="ROSTER_CLASS.leader" aria-hidden="true" /><UTooltip :text="row.original.standard"
            ><span class="min-w-0 truncate text-highlighted" tabindex="0">{{ row.original.standard }}</span></UTooltip
          ></span
        >
      </template>
    </UTable>
    <footer :class="ROSTER_CLASS.footer">
      <span>read from the registry in your browser / no network</span>
      <span :class="ROSTER_CLASS.meta">ratio on {{ RATIO_BYTES }} bytes of text, default container and level</span>
    </footer>
  </section>
</template>
