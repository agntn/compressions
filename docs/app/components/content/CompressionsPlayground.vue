<script setup lang="ts">
import { base64 } from "@agntn/encodings/base64";
import { CompressionError, create, peel, type CompressionInfo } from "@agntn/compressions";
import {
  DATA_FORMATS,
  DEFAULT_SHOWN_BYTES,
  INPUT_FORMATS,
  MAX_SHOWN_BYTES,
  OUTPUT_FORMATS,
  compressionsCompress,
  compressionsDecompress,
  compressionsIdentify,
  compressionsInfo,
  type CompressDetails,
  type DecompressDetails,
  type IdentifyDetails,
} from "#tool-operations";
import {
  FORMATS,
  SAMPLE_INPUT,
  VARIANTS,
  checksums,
  formatEntry,
  ratio,
  sampleStream,
  type VariantEntry,
} from "../../utils/formats";
import { shellArg } from "../../utils/format";
import { jsonTokens, shellTokens } from "../../utils/tokens";
import { previewText, type ToolName } from "../../utils/tools";

type Operation = "compress" | "decompress" | "identify" | "info";
type DataFormat = (typeof DATA_FORMATS)[number];

const OPERATIONS: ReadonlyArray<{ key: Operation; label: string; tool: ToolName; about: string }> = [
  {
    key: "compress",
    label: "Compress",
    tool: "compressions_compress",
    about: "Text or bytes into a stream of one format and container, back as base64 or hex.",
  },
  {
    key: "decompress",
    label: "Decompress",
    tool: "compressions_decompress",
    about: "A stream back into bytes, every checksum checked, a window of the output shown.",
  },
  {
    key: "identify",
    label: "Identify",
    tool: "compressions_identify",
    about: "Which format and container read these bytes, ranked, or every layer peeled off.",
  },
  {
    key: "info",
    label: "Info",
    tool: "compressions_info",
    about: "The formats with their containers, magic numbers, checksums and options.",
  },
];

/**
 * Bytes in base64, for samples.
 *
 * @param {Uint8Array} bytes - The bytes.
 * @returns {string} Base64.
 */
function b64(bytes: Uint8Array): string {
  return base64.encode(bytes);
}

const variantOf = (format: string, container: string): VariantEntry | undefined =>
  VARIANTS.find((variant) => variant.format.slug === format && variant.container.name === container);

/** Samples for identify, each a different kind of evidence. */
const IDENTIFY_SAMPLES: ReadonlyArray<{ label: string; data: string; icon: string }> = [
  { label: "gzip", data: b64(sampleStream(variantOf("deflate", "gzip")!)), icon: "i-lucide-file-archive" },
  {
    label: "gzip in xz in bzip2",
    data: b64(
      create("bzip2").compress(
        create("lzma").compress(create("deflate").compress(SAMPLE_INPUT, { container: "gzip" }), { container: "xz" }),
      ),
    ),
    icon: "i-lucide-layers",
  },
  { label: "zstd, from its CLI", data: b64(sampleStream(variantOf("zstd", "zstd")!)), icon: "i-lucide-gauge" },
  { label: "brotli, no magic", data: b64(sampleStream(variantOf("brotli", "brotli")!)), icon: "i-lucide-globe" },
  { label: "a ZIP header", data: b64(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0])), icon: "i-lucide-package" },
  { label: "plain text", data: b64(new TextEncoder().encode(SAMPLE_INPUT)), icon: "i-lucide-text" },
];

const route = useRoute();
const router = useRouter();

const operation = ref<Operation>("compress");
const formatName = ref<string>("deflate");
const container = ref<string>("gzip");
const input = ref(SAMPLE_INPUT);
const inputFormat = ref<(typeof INPUT_FORMATS)[number]>("utf8");
const dataFormat = ref<DataFormat>("base64");
const data = ref(b64(sampleStream(variantOf("deflate", "gzip")!)));
const outputFormat = ref<(typeof OUTPUT_FORMATS)[number]>("auto");
const offset = ref<string | number>("");
const length = ref<string | number>("");
const partial = ref(false);
const unknown = ref(IDENTIFY_SAMPLES[0]!.data);
const peeling = ref(false);
const describe = ref("");
/** Compress options besides the container, as typed: empty means the format's default. */
const values = reactive<Record<string, string | boolean>>({});

const entry = computed(() => formatEntry(formatName.value) ?? FORMATS[0]!);
const named = computed(() => entry.value.info.containers.length > 1);
/** The options a compress call can set for this format and container, the container aside. */
const optionFields = computed(() =>
  entry.value.info.options.filter(
    (option) => option.name !== "container" && (!option.containers || option.containers.includes(container.value)),
  ),
);

const formatItems = computed(() =>
  FORMATS.map((format) => ({ label: format.slug, value: format.slug, icon: format.icon })),
);
const containerItems = computed(() =>
  entry.value.info.containers.map((item) => ({ label: `${item.name} · ${item.label}`, value: item.name })),
);
const inputFormatItems = INPUT_FORMATS.map((value) => ({ label: value, value }));
const dataFormatItems = DATA_FORMATS.map((value) => ({ label: value, value }));
const outputFormatItems = OUTPUT_FORMATS.map((value) => ({ label: value, value }));
/** Reka won't take `""` as a menu value, so "every format" goes on the menu as `*`. */
const EVERY_FORMAT = "*";
/** The menu's side of `describe`: `*` and anything unknown read back as `""`, no format. */
const describeModel = computed({
  get: () => describe.value || EVERY_FORMAT,
  set: (value: string) => {
    describe.value = formatEntry(value) ? value : "";
  },
});
const describeItems = [
  { label: "every format", value: EVERY_FORMAT },
  ...FORMATS.map((format) => ({ label: format.slug, value: format.slug, icon: format.icon })),
];

/** Compress options as the tool takes them: numbers as numbers, empty fields left out. */
const options = computed<Record<string, string | number | boolean>>(() => {
  const picked: Record<string, string | number | boolean> = named.value ? { container: container.value } : {};
  for (const option of optionFields.value) {
    const value = values[option.name];
    if (value === undefined || value === "") continue;
    picked[option.name] = option.type === "number" ? Number(value) : value;
  }
  return picked;
});

/**
 * Reads a number field: empty is absent.
 *
 * @param {string | number} value - The field.
 * @returns {number | undefined} The number.
 */
function numberField(value: string | number): number | undefined {
  return value === "" ? undefined : Number(value);
}

/** The arguments the tool receives, as an MCP client would send them. */
const toolArgs = computed((): Record<string, unknown> => {
  if (operation.value === "info") return describe.value ? { format: describe.value } : {};
  if (operation.value === "identify") {
    return { data: unknown.value, ...(peeling.value ? { peel: true } : {}) };
  }
  if (operation.value === "decompress") {
    return {
      format: formatName.value,
      data: data.value,
      ...(dataFormat.value === "base64" ? {} : { dataFormat: dataFormat.value }),
      ...(outputFormat.value === "auto" ? {} : { outputFormat: outputFormat.value }),
      ...(numberField(offset.value) === undefined ? {} : { offset: numberField(offset.value) }),
      ...(numberField(length.value) === undefined ? {} : { length: numberField(length.value) }),
      ...(partial.value ? { partial: true } : {}),
      ...(named.value ? { options: { container: container.value } } : {}),
    };
  }
  return {
    format: formatName.value,
    input: input.value,
    ...(inputFormat.value === "utf8" ? {} : { inputFormat: inputFormat.value }),
    ...(dataFormat.value === "base64" ? {} : { dataFormat: dataFormat.value }),
    ...(Object.keys(options.value).length > 0 ? { options: options.value } : {}),
  };
});

interface CompressAnswer {
  kind: "compress";
  text: string;
  details: CompressDetails;
}
interface DecompressAnswer {
  kind: "decompress";
  text: string;
  details: DecompressDetails;
}
interface IdentifyAnswer {
  kind: "identify";
  text: string;
  details: IdentifyDetails;
}
interface ListAnswer {
  kind: "list";
  text: string;
  infos: CompressionInfo[];
}
interface DescribeAnswer {
  kind: "describe";
  text: string;
  info: CompressionInfo;
}
interface ErrorAnswer {
  kind: "error";
  text: string;
  name: string;
  message: string;
}
type Answer = CompressAnswer | DecompressAnswer | IdentifyAnswer | ListAnswer | DescribeAnswer | ErrorAnswer;

const current = computed(() => OPERATIONS.find((row) => row.key === operation.value)!);
const position = computed(() => OPERATIONS.findIndex((row) => row.key === operation.value) + 1);

/**
 * Runs one call through the tool executors, the ones the MCP server runs. A library error comes
 * back as an answer of its own, with the text an MCP client would read.
 *
 * @param {Operation} op - Which tool.
 * @param {Record<string, unknown>} args - Its arguments.
 * @returns {Answer} The answer.
 */
function run(op: Operation, args: Record<string, unknown>): Answer {
  try {
    if (op === "info") {
      const result = compressionsInfo(args);
      const [only] = result.details.formats;
      return args.format && only
        ? { kind: "describe", text: result.content[0]!.text, info: only }
        : { kind: "list", text: result.content[0]!.text, infos: result.details.formats };
    }
    if (op === "identify") {
      const result = compressionsIdentify(args);
      return { kind: "identify", text: result.content[0]!.text, details: result.details };
    }
    if (op === "decompress") {
      const result = compressionsDecompress(args);
      return { kind: "decompress", text: result.content[0]!.text, details: result.details };
    }
    const result = compressionsCompress(args);
    return { kind: "compress", text: result.content[0]!.text, details: result.details };
  } catch (error) {
    if (!(error instanceof CompressionError)) throw error;
    const tool = OPERATIONS.find((row) => row.key === op)!.tool;
    return { kind: "error", text: `${tool} failed: ${error.message}`, name: error.name, message: error.message };
  }
}

/** The call on screen, run 250 ms after the form stops changing. */
const request = shallowRef({ op: operation.value, args: toolArgs.value });
let pending: ReturnType<typeof setTimeout> | undefined;
watch(toolArgs, (args) => {
  clearTimeout(pending);
  pending = setTimeout(() => {
    request.value = { op: operation.value, args };
  }, 250);
});

const answer = computed(() => run(request.value.op, request.value.args));
const answered = computed(() => OPERATIONS.find((row) => row.key === request.value.op)!);
const answeredEntry = computed(() => formatEntry(String(request.value.args.format ?? "")) ?? entry.value);

const cliLine = computed(() => {
  const args = request.value.args;
  if (request.value.op === "info") return args.format ? `compressions list ${String(args.format)}` : "compressions list";
  if (request.value.op === "identify") {
    return `echo ${shellArg(String(args.data))} | compressions identify - --from base64${args.peel ? " --peel" : ""}`;
  }
  const containerFlag = named.value ? ` --container ${container.value}` : "";
  if (request.value.op === "decompress") {
    const from = String(args.dataFormat ?? "base64");
    const to = args.outputFormat === "hex" || args.outputFormat === "base64" ? ` -o ${String(args.outputFormat)}` : "";
    return `echo ${shellArg(String(args.data))} | compressions decompress ${String(args.format)} - --from ${from}${containerFlag}${args.partial ? " --partial" : ""}${to}`;
  }
  const flags = Object.entries(options.value)
    .filter(([name]) => name !== "container")
    .map(([name, value]) => (value === true ? ` --${name}` : value === false ? ` --no-${name}` : ` --${name} ${shellArg(String(value))}`))
    .join("");
  const from = inputFormat.value === "utf8" ? "" : ` --from ${inputFormat.value}`;
  return `printf '%s' ${shellArg(input.value)} | compressions compress ${formatName.value} -${from}${containerFlag}${flags} --to ${dataFormat.value}`;
});
const toolCall = computed(() =>
  JSON.stringify({ name: answered.value.tool, arguments: request.value.args }, null, 2),
);
const call = computed(() => {
  const args = request.value.args;
  if (request.value.op === "info") return args.format ? `info("${String(args.format)}")` : "formats()";
  if (request.value.op === "identify") return `${args.peel ? "peel" : "identify"}(bytes)`;
  return `${request.value.op}("${String(args.format)}", ${request.value.op === "compress" ? "input" : "bytes"})`;
});
const responseTitle = computed(() => `${answered.value.tool}(${JSON.stringify(request.value.args)})`);

/**
 * What a stream carried, on one line.
 *
 * @param {Record<string, string | number | boolean>} details - The facts.
 * @returns {string} Such as `name "hi.txt", members 1`, or empty.
 */
function carried(details: Readonly<Record<string, string | number | boolean>>): string {
  return Object.entries(details)
    .map(([key, value]) => `${key} ${typeof value === "string" ? JSON.stringify(value) : String(value)}`)
    .join(", ");
}

const takes = computed(() => Object.keys(request.value.args).join(", ") || "no arguments");

/** One cursor sweep and scan per answer text, not per keystroke. */
const scan = ref(0);
watch(
  () => answer.value.text,
  () => {
    scan.value += 1;
  },
);

/**
 * Picks a format and container and loads the sample for the operation on screen.
 *
 * @param {VariantEntry} variant - The variant.
 */
function loadVariant(variant: VariantEntry) {
  formatName.value = variant.format.slug;
  container.value = variant.container.name;
  for (const key of Object.keys(values)) delete values[key];
  input.value = SAMPLE_INPUT;
  inputFormat.value = "utf8";
  dataFormat.value = "base64";
  data.value = b64(sampleStream(variant));
  partial.value = false;
}

/**
 * Whether a variant chip is the form as it stands.
 *
 * @param {VariantEntry} variant - The variant.
 * @returns {boolean} Whether it is the one on screen.
 */
function variantPressed(variant: VariantEntry): boolean {
  return formatName.value === variant.format.slug && container.value === variant.container.name;
}

/** Chips for compress list only the variants this package writes. */
const chips = computed(() =>
  VARIANTS.filter((variant) => operation.value !== "compress" || variant.format.info.compress),
);

/**
 * Picks a format from the select, with its default container.
 *
 * @param {string} slug - A built-in name.
 */
function selectFormat(slug: string) {
  const format = formatEntry(slug);
  if (!format) return;
  formatName.value = slug;
  container.value = format.info.containers[0]!.name;
  for (const key of Object.keys(values)) delete values[key];
}

/**
 * Takes a candidate or a peeled layer into decompress, with the bytes it reads.
 *
 * @param {string} format - The format.
 * @param {string} name - The container.
 * @param {string} bytes - The bytes it reads, in base64.
 */
function decompressCandidate(format: string, name: string, bytes: string) {
  formatName.value = format;
  container.value = name;
  data.value = bytes;
  dataFormat.value = "base64";
  outputFormat.value = "auto";
  offset.value = "";
  length.value = "";
  operation.value = "decompress";
}

/** Takes a compress result into decompress, so the stream goes straight back. */
function decompressResult() {
  if (answer.value.kind !== "compress") return;
  data.value = answer.value.details.data;
  dataFormat.value = answer.value.details.dataFormat;
  operation.value = "decompress";
}

/** Peeled layers outermost first, each with the bytes it reads in base64, recomputed here. */
const layers = computed(() => {
  if (answer.value.kind !== "identify" || answer.value.details.layers === undefined) return undefined;
  const found = answer.value.details.layers;
  let bytes: Uint8Array;
  try {
    bytes = base64.decode(String(request.value.args.data ?? "").replaceAll(/\s+/gu, ""));
  } catch {
    return [];
  }
  const peeled = peel(bytes);
  return found.map((layer, index) => ({
    layer,
    from: b64(index === 0 ? bytes : peeled[index - 1]!.bytes),
  }));
});
const innermost = computed(() => layers.value?.at(-1)?.layer);

const { copied, copy } = useCopied();

/** Query in, state out. Only values the form knows are read, the rest of the query is ignored. */
function readQuery(query: Record<string, unknown>) {
  const op = String(query.op ?? "");
  if (OPERATIONS.some((row) => row.key === op)) operation.value = op as Operation;
  const name = String(query.format ?? "");
  const known = formatEntry(name);
  if (known && op === "info") describe.value = name;
  else if (known) selectFormat(name);
  if (known?.info.containers.some((item) => item.name === query.container)) container.value = String(query.container);
  if (typeof query.input === "string") input.value = query.input;
  if (typeof query.data === "string") {
    if (op === "identify") unknown.value = query.data;
    else data.value = query.data;
  }
  if ((INPUT_FORMATS as readonly unknown[]).includes(query.inputFormat)) inputFormat.value = query.inputFormat as typeof inputFormat.value;
  if ((DATA_FORMATS as readonly unknown[]).includes(query.dataFormat)) dataFormat.value = query.dataFormat as DataFormat;
  if ((OUTPUT_FORMATS as readonly unknown[]).includes(query.outputFormat)) outputFormat.value = query.outputFormat as typeof outputFormat.value;
  if (typeof query.offset === "string") offset.value = query.offset;
  if (typeof query.length === "string") length.value = query.length;
  if (typeof query.partial === "string") partial.value = query.partial === "true";
  if (typeof query.peel === "string") peeling.value = query.peel === "true";
  for (const option of known?.info.options ?? []) {
    const value = query[option.name];
    if (typeof value !== "string" || option.name === "container") continue;
    values[option.name] = option.type === "boolean" ? value === "true" : value;
  }
  request.value = { op: operation.value, args: toolArgs.value };
}

const shareQuery = computed(() => {
  const query: Record<string, string> = { op: operation.value };
  for (const [name, value] of Object.entries(toolArgs.value)) {
    if (name === "options") {
      for (const [option, setting] of Object.entries(value as Record<string, unknown>)) query[option] = String(setting);
    } else {
      query[name] = String(value);
    }
  }
  return query;
});

/**
 * Deep link once after mount. A prerendered page hydrates with an empty `route.query` and Nuxt
 * restores the address only afterwards, so the first non-empty query is read once, whichever
 * comes first.
 */
function applyDeepLink() {
  const stop = watch(
    () => route.query,
    (query) => {
      readQuery(query as Record<string, unknown>);
      stop();
    },
    { once: true, flush: "post" },
  );
  if (Object.keys(route.query).length > 0) {
    stop();
    readQuery(route.query as Record<string, unknown>);
  }
}

onMounted(() => {
  applyDeepLink();
  watch(shareQuery, (query) => {
    void router.replace({ query });
  });
});

const shareLink = computed(() => {
  if (!import.meta.client) return "";
  const url = new URL(window.location.href);
  url.search = new URLSearchParams(shareQuery.value).toString();
  return url.toString();
});
</script>

<template>
  <div class="playground">
    <form class="tool-console console-wide" @submit.prevent>
      <span class="console-cross console-cross-tl" aria-hidden="true">+</span>
      <span class="console-cross console-cross-br" aria-hidden="true">+</span>
      <header class="console-bar">
        <span class="console-title"
          ><span class="console-tag">Call</span>{{ current.tool
          }}<span class="console-file">{{ String(position).padStart(2, "0") }} / {{ OPERATIONS.length }}</span></span
        >
        <span class="console-meta" aria-label="Supported hosts: MCP, Pi, OMP and the AI SDK">MCP · Pi · OMP · AI SDK</span>
        <span class="console-mark" aria-hidden="true" />
      </header>
      <div class="console-ruler" aria-hidden="true"><span class="console-cursor" /></div>

      <div class="console-band playground-band-first playground-columns">
        <div class="playground-column">
          <p class="console-label console-rule-title">
            <span>Operation <span aria-hidden="true">[ {{ OPERATIONS.length }} ]</span></span>
            <span class="console-mark" aria-hidden="true" />
          </p>
          <div role="group" aria-label="Operation" class="playground-ops console-draw">
            <button
              v-for="(row, index) in OPERATIONS"
              :key="row.key"
              type="button"
              class="console-lead"
              :aria-pressed="operation === row.key"
              @click="operation = row.key"
            >
              <span class="console-tag">{{ row.label }}</span>
              <span>{{ row.tool }}</span>
              <span class="console-leader" aria-hidden="true" :style="{ animationDelay: `${index * 60}ms` }" />
            </button>
          </div>
          <p class="console-about playground-tool-about">{{ current.about }}</p>
        </div>

        <div class="playground-column">
          <p class="console-label console-rule-title">
            <span
              >Input <span aria-hidden="true">[ {{ Object.keys(toolArgs).length || "no" }}
                {{ Object.keys(toolArgs).length === 1 ? "argument" : "arguments" }} ]</span></span
            >
            <span class="console-mark" aria-hidden="true" />
          </p>

          <div class="console-readout">
            <dl v-if="operation === 'info'" class="console-readout-rows">
              <div>
                <dt><label for="playground-describe">format</label></dt>
                <dd>
                  <USelectMenu
                    id="playground-describe"
                    v-model="describeModel"
                    :items="describeItems"
                    value-key="value"
                    variant="none"
                    :search-input="false"
                    class="w-full"
                  />
                </dd>
              </div>
            </dl>
            <dl v-else-if="operation === 'identify'" class="console-readout-rows">
              <div>
                <dt><label for="playground-unknown">data</label></dt>
                <dd>
                  <UTextarea
                    id="playground-unknown"
                    v-model="unknown"
                    variant="none"
                    :rows="1"
                    autoresize
                    :maxrows="6"
                    placeholder="bytes in base64, as you found them"
                    spellcheck="false"
                    autocomplete="off"
                    class="w-full"
                  />
                </dd>
              </div>
              <div>
                <dt><label for="playground-peel">peel</label></dt>
                <dd>
                  <UCheckbox id="playground-peel" v-model="peeling" label="take every layer off, outermost first" />
                </dd>
              </div>
            </dl>
            <dl v-else class="console-readout-rows">
              <div>
                <dt><label for="playground-format">format</label></dt>
                <dd>
                  <USelectMenu
                    id="playground-format"
                    :model-value="entry.slug"
                    :items="formatItems"
                    value-key="value"
                    variant="none"
                    :search-input="false"
                    :icon="entry.icon"
                    class="w-full"
                    @update:model-value="selectFormat($event as string)"
                  />
                </dd>
              </div>
              <div v-if="named">
                <dt><label for="playground-container">container</label></dt>
                <dd>
                  <USelectMenu
                    id="playground-container"
                    v-model="container"
                    :items="containerItems"
                    value-key="value"
                    variant="none"
                    :search-input="false"
                    class="w-full"
                  />
                </dd>
              </div>
              <template v-if="operation === 'compress'">
                <div>
                  <dt><label for="playground-input">input</label></dt>
                  <dd>
                    <UTextarea
                      id="playground-input"
                      v-model="input"
                      variant="none"
                      :rows="1"
                      autoresize
                      :maxrows="6"
                      spellcheck="false"
                      autocomplete="off"
                      class="w-full"
                    />
                  </dd>
                </div>
                <div>
                  <dt><label for="playground-input-format">inputFormat</label></dt>
                  <dd>
                    <USelectMenu
                      id="playground-input-format"
                      v-model="inputFormat"
                      :items="inputFormatItems"
                      value-key="value"
                      variant="none"
                      :search-input="false"
                      class="w-full"
                    />
                  </dd>
                </div>
                <div v-for="option in optionFields" :key="option.name">
                  <dt><label :for="`playground-option-${option.name}`">{{ option.name }}</label></dt>
                  <dd>
                    <UCheckbox
                      v-if="option.type === 'boolean'"
                      :id="`playground-option-${option.name}`"
                      :model-value="values[option.name] === undefined ? option.default === true : values[option.name] === true"
                      :label="option.description"
                      @update:model-value="values[option.name] = $event === true"
                    />
                    <USelectMenu
                      v-else-if="option.choices"
                      :id="`playground-option-${option.name}`"
                      :model-value="(values[option.name] as string | undefined) || String(option.default)"
                      :items="option.choices.map((choice) => ({ label: choice, value: choice }))"
                      value-key="value"
                      variant="none"
                      :search-input="false"
                      class="w-full"
                      @update:model-value="values[option.name] = $event === option.default ? '' : String($event)"
                    />
                    <UInput
                      v-else
                      :id="`playground-option-${option.name}`"
                      v-model="values[option.name] as string"
                      :type="option.type === 'number' ? 'number' : 'text'"
                      :min="option.min"
                      :max="option.max"
                      variant="none"
                      :placeholder="option.default === undefined ? option.description : `default ${option.default}`"
                      spellcheck="false"
                      autocomplete="off"
                      class="w-full"
                    />
                  </dd>
                </div>
              </template>
              <template v-else>
                <div>
                  <dt><label for="playground-data">data</label></dt>
                  <dd>
                    <UTextarea
                      id="playground-data"
                      v-model="data"
                      variant="none"
                      :rows="1"
                      autoresize
                      :maxrows="6"
                      spellcheck="false"
                      autocomplete="off"
                      class="w-full"
                    />
                  </dd>
                </div>
                <div>
                  <dt><label for="playground-output-format">outputFormat</label></dt>
                  <dd>
                    <USelectMenu
                      id="playground-output-format"
                      v-model="outputFormat"
                      :items="outputFormatItems"
                      value-key="value"
                      variant="none"
                      :search-input="false"
                      class="w-full"
                    />
                  </dd>
                </div>
                <div>
                  <dt><label for="playground-offset">offset</label></dt>
                  <dd>
                    <UInput id="playground-offset" v-model="offset" type="number" min="0" placeholder="default 0" variant="none" class="w-full" />
                  </dd>
                </div>
                <div>
                  <dt><label for="playground-length">length</label></dt>
                  <dd>
                    <UInput
                      id="playground-length"
                      v-model="length"
                      type="number"
                      min="1"
                      :max="MAX_SHOWN_BYTES"
                      :placeholder="`default ${DEFAULT_SHOWN_BYTES}`"
                      variant="none"
                      class="w-full"
                    />
                  </dd>
                </div>
                <div>
                  <dt><label for="playground-partial">partial</label></dt>
                  <dd>
                    <UCheckbox id="playground-partial" v-model="partial" label="show what came out before the damage" />
                  </dd>
                </div>
              </template>
              <div>
                <dt><label for="playground-data-format">dataFormat</label></dt>
                <dd>
                  <USelectMenu
                    id="playground-data-format"
                    v-model="dataFormat"
                    :items="dataFormatItems"
                    value-key="value"
                    variant="none"
                    :search-input="false"
                    class="w-full"
                  />
                </dd>
              </div>
            </dl>
          </div>

          <div v-if="operation === 'identify'" class="playground-chips" role="group" aria-label="Sample bytes">
            <UButton
              v-for="sample in IDENTIFY_SAMPLES"
              :key="sample.label"
              :color="unknown === sample.data ? 'primary' : 'neutral'"
              variant="chip"
              :icon="sample.icon"
              :label="sample.label"
              :aria-pressed="unknown === sample.data"
              @click="unknown = sample.data"
            />
          </div>
          <div v-else-if="operation !== 'info'" class="playground-chips" role="group" aria-label="Sample formats">
            <UButton
              v-for="variant in chips"
              :key="variant.label"
              :color="variantPressed(variant) ? 'primary' : 'neutral'"
              variant="chip"
              :icon="variant.format.icon"
              :label="variant.label"
              :aria-pressed="variantPressed(variant)"
              @click="loadVariant(variant)"
            />
          </div>

          <p class="playground-note">
            <template v-if="operation === 'decompress'"
              >A chip loads <code>{{ SAMPLE_INPUT.slice(0, 12) }}…</code> in that container. Change one
              character near the end of the gzip one and watch the CRC-32 say no. Then tick
              partial.</template
            >
            <template v-else-if="operation === 'identify'"
              >Each sample is a different kind of evidence: a magic number with a checksum, three
              layers, a stream with no magic at all, an archive this package doesn't open, and
              plain text that isn't compressed. Peel takes off one layer after another.</template
            >
            <template v-else-if="operation === 'info'"
              >Pick a format to see its containers and options the way a model sees them before its
              first call.</template
            >
            <template v-else
              >A chip picks a format and container. zstd and brotli have no chip here, since this
              package reads them and doesn't write them.</template
            >
          </p>
        </div>
      </div>

      <div class="console-band playground-columns">
        <div class="playground-column">
          <p class="console-label console-rule-title">
            <span>CLI <span aria-hidden="true">[ same call ]</span></span>
            <span class="console-mark" aria-hidden="true" />
            <UButton
              color="neutral"
              variant="subtle"
              :icon="copied === 'cli' ? 'i-lucide-check' : 'i-lucide-copy'"
              :label="copied === 'cli' ? 'copied' : 'copy'"
              :aria-label="copied === 'cli' ? 'Copied' : 'Copy the CLI line'"
              @click="copy('cli', cliLine)"
            />
          </p>
          <!-- prettier-ignore -->
          <pre class="console-snippet"><code><span class="playground-prompt">$ </span><span v-for="(token, index) in shellTokens(cliLine)" :key="index" :class="token.cls">{{ token.text }}</span></code></pre>
        </div>
        <div class="playground-column">
          <p class="console-label console-rule-title">
            <span>Tool <span aria-hidden="true">[ what an MCP client sends ]</span></span>
            <span class="console-mark" aria-hidden="true" />
            <UButton
              color="neutral"
              variant="subtle"
              :icon="copied === 'tool' ? 'i-lucide-check' : 'i-lucide-copy'"
              :label="copied === 'tool' ? 'copied' : 'copy'"
              :aria-label="copied === 'tool' ? 'Copied' : 'Copy the tool call'"
              @click="copy('tool', toolCall)"
            />
          </p>
          <!-- prettier-ignore -->
          <pre class="console-snippet"><code><span v-for="(token, index) in jsonTokens(toolCall)" :key="index" :class="token.cls">{{ token.text }}</span></code></pre>
        </div>
      </div>

      <footer class="console-footer console-footer-plain">
        <ul class="console-links">
          <li>
            <button type="button" @click="copy('link', shareLink)">
              <span aria-hidden="true">→ </span>{{ copied === "link" ? "permalink copied" : "copy the permalink" }}
            </button>
          </li>
        </ul>
        <span class="console-meta">every state is a link</span>
      </footer>
    </form>

    <!-- The call runs from the request down into the response, the way the zone's circuit runs into the request. -->
    <div class="playground-link" aria-hidden="true">
      <svg :key="scan" class="hero-circuit" viewBox="0 0 160 56">
        <path class="hero-circuit-rail" d="M80 0V16L96 32V56" />
        <path class="hero-circuit-live" d="M80 0V16L96 32V56" pathLength="1" />
        <path class="hero-circuit-seg" d="M96 38V48" />
        <rect class="hero-circuit-node" x="92.5" y="52.5" width="7" height="7" />
      </svg>
      <span class="hero-circuit-tag">answer</span>
    </div>

    <section class="tool-console console-wide" aria-live="polite">
      <span class="console-cross console-cross-tl" aria-hidden="true">+</span>
      <span class="console-cross console-cross-br" aria-hidden="true">+</span>
      <header class="console-bar">
        <UTooltip :text="responseTitle">
          <span class="console-title playground-call" tabindex="0"
            ><span class="console-tag">{{ answered.label }}</span>{{ call }}</span
          >
        </UTooltip>
        <span v-if="answer.kind === 'compress'" class="console-meta"
          >{{ answer.details.inputLength }} → {{ answer.details.outputLength }} bytes</span
        >
        <span v-else-if="answer.kind === 'decompress'" class="console-meta"
          >{{ answer.details.byteLength }} bytes · {{ answer.details.outputFormat }}</span
        >
        <span v-else-if="layers" class="console-meta"
          >{{ layers.length }} {{ layers.length === 1 ? "layer" : "layers" }} · outermost first</span
        >
        <span v-else-if="answer.kind === 'identify'" class="console-meta"
          >{{ answer.details.candidates.length }} {{ answer.details.candidates.length === 1 ? "candidate" : "candidates" }} · best first</span
        >
        <span v-else-if="answer.kind === 'list'" class="console-meta">{{ answer.infos.length }} formats · listing order</span>
        <span v-else-if="answer.kind === 'describe'" class="console-meta"
          >{{ answer.info.containers.length }} containers · {{ answer.info.compress ? "reads and writes" : "reads" }}</span
        >
        <span v-else class="console-meta">{{ answer.name }}</span>
        <span class="console-mark" aria-hidden="true" />
      </header>
      <div class="console-ruler" aria-hidden="true">
        <span :key="scan" class="console-cursor" />
      </div>

      <template v-if="answer.kind === 'compress'">
        <div class="console-band console-subject-band">
          <div :key="scan" class="console-scan" aria-hidden="true" />
          <div class="console-identity-block">
            <ConsoleReticle :key="answeredEntry.slug" :icon="answeredEntry.icon" />
            <div class="console-name">
              <span class="console-label"
                >Compress / <span class="console-label-key">{{ answer.details.options.container }}</span></span
              >
              <h3>{{ answeredEntry.info.label }}</h3>
              <p class="console-about">{{ answeredEntry.blurb }}.</p>
            </div>
          </div>
          <div class="console-readout">
            <svg class="console-link" viewBox="0 0 32 40" fill="none" aria-hidden="true">
              <circle cx="3" cy="12" r="2.5" />
              <path d="M5.5 12H14L22 20H32" />
            </svg>
            <dl :key="scan" class="console-readout-rows console-animate">
              <div>
                <dt>Size</dt>
                <dd class="console-accent">
                  {{ answer.details.inputLength }} → {{ answer.details.outputLength }} bytes
                  <span class="playground-none"
                    >·
                    {{ answer.details.inputLength ? Math.round((answer.details.outputLength / answer.details.inputLength) * 100) : 0 }}%</span
                  >
                </dd>
              </div>
              <div>
                <dt>Options</dt>
                <dd>
                  <span class="playground-line">{{ carried(answer.details.options) }}</span>
                </dd>
              </div>
              <div>
                <dt>Checksum</dt>
                <dd>{{ checksums(answeredEntry) }}</dd>
              </div>
            </dl>
          </div>
        </div>
        <div class="console-band">
          <p class="console-label console-rule-title">
            <span>Data <span aria-hidden="true">[ {{ answer.details.dataFormat }}, content[0].text after the header ]</span></span>
            <span class="console-mark" aria-hidden="true" />
            <UButton
              color="neutral"
              variant="subtle"
              trailing-icon="i-lucide-arrow-right"
              label="decompress"
              aria-label="Decompress this stream"
              @click="decompressResult"
            />
            <UButton
              color="neutral"
              variant="subtle"
              :icon="copied === 'out' ? 'i-lucide-check' : 'i-lucide-copy'"
              :label="copied === 'out' ? 'copied' : 'copy'"
              :aria-label="copied === 'out' ? 'Copied' : 'Copy the compressed bytes'"
              @click="copy('out', answer.details.data)"
            />
          </p>
          <pre :key="scan" class="console-snippet playground-output"><code>{{ answer.details.data }}</code></pre>
        </div>
      </template>

      <template v-else-if="answer.kind === 'decompress'">
        <div class="console-band console-subject-band">
          <div :key="scan" class="console-scan" aria-hidden="true" />
          <div class="console-identity-block">
            <ConsoleReticle :key="answeredEntry.slug" :icon="answeredEntry.icon" />
            <div class="console-name">
              <span class="console-label"
                >Decompress / <span class="console-label-key">{{ answer.details.container }}</span></span
              >
              <h3>{{ answeredEntry.info.label }}</h3>
              <p class="console-about">
                {{
                  answer.details.details.error
                    ? "Cut short. What came out before the damage is below, nothing after it."
                    : answeredEntry.info.containers.find((item) => item.name === answer.details.container)?.checksum
                      ? "The checksum matched, so these are the bytes the writer meant."
                      : `${answeredEntry.blurb}.`
                }}
              </p>
            </div>
          </div>
          <div class="console-readout">
            <svg class="console-link" viewBox="0 0 32 40" fill="none" aria-hidden="true">
              <circle cx="3" cy="12" r="2.5" />
              <path d="M5.5 12H14L22 20H32" />
            </svg>
            <dl :key="scan" class="console-readout-rows console-animate">
              <div>
                <dt>Bytes</dt>
                <dd class="console-accent">{{ answer.details.byteLength }} out</dd>
              </div>
              <div>
                <dt>Shown</dt>
                <dd>
                  {{ answer.details.offset }} to {{ answer.details.offset + answer.details.shownLength }} as
                  {{ answer.details.outputFormat }}
                </dd>
              </div>
              <div>
                <dt>Carried</dt>
                <dd>
                  <UTooltip v-if="carried(answer.details.details)" :text="carried(answer.details.details)">
                    <span class="playground-line" tabindex="0">{{ carried(answer.details.details) }}</span>
                  </UTooltip>
                  <span v-else class="playground-none">nothing but data</span>
                </dd>
              </div>
            </dl>
          </div>
        </div>
        <div class="console-band">
          <p class="console-label console-rule-title">
            <span>Value <span aria-hidden="true">[ {{ answer.details.outputFormat }} ]</span></span>
            <span class="console-mark" aria-hidden="true" />
            <UButton
              color="neutral"
              variant="subtle"
              :icon="copied === 'out' ? 'i-lucide-check' : 'i-lucide-copy'"
              :label="copied === 'out' ? 'copied' : 'copy'"
              :aria-label="copied === 'out' ? 'Copied' : 'Copy the decompressed value'"
              @click="copy('out', answer.details.value)"
            />
          </p>
          <pre :key="scan" class="console-snippet playground-output"><code>{{ answer.details.value }}</code></pre>
        </div>
      </template>

      <template v-else-if="layers">
        <div class="console-band console-subject-band">
          <div :key="scan" class="console-scan" aria-hidden="true" />
          <div class="console-identity-block">
            <ConsoleReticle :key="innermost?.format ?? 'none'" :icon="formatEntry(innermost?.format ?? '')?.icon ?? 'i-lucide-layers'" />
            <div class="console-name">
              <span class="console-label">Peel / <span class="console-label-key">{{ layers.length }} deep</span></span>
              <h3 :class="{ 'playground-invalid': layers.length === 0 }">
                {{ layers.length > 0 ? layers.map(({ layer }) => layer.container).join(" → ") : "Nothing to peel" }}
              </h3>
              <p class="console-about">
                {{
                  layers.length === 0
                    ? answer.kind === "identify" && answer.details.archive
                      ? `These bytes start like ${answer.details.archive}, which this package doesn't open.`
                      : "No format decompresses these bytes."
                    : innermost?.confirmed === false
                      ? "The last layer is only the best guess. Nothing backs it."
                      : "A magic number or a checked header backs every layer."
                }}
              </p>
            </div>
          </div>
          <div class="console-readout">
            <svg class="console-link" viewBox="0 0 32 40" fill="none" aria-hidden="true">
              <circle cx="3" cy="12" r="2.5" />
              <path d="M5.5 12H14L22 20H32" />
            </svg>
            <dl :key="scan" class="console-readout-rows console-animate">
              <div>
                <dt>Layers</dt>
                <dd class="console-accent">{{ layers.length }}</dd>
              </div>
              <div>
                <dt>Backed</dt>
                <dd>{{ layers.filter(({ layer }) => layer.confirmed).length }} of {{ layers.length }}</dd>
              </div>
              <div>
                <dt>Bottom</dt>
                <dd>
                  <UTooltip v-if="innermost" :text="innermost.preview">
                    <span class="playground-line" tabindex="0">{{ innermost.byteLength }} bytes · {{ previewText(innermost) }}</span>
                  </UTooltip>
                  <span v-else class="playground-none">the bytes themselves</span>
                </dd>
              </div>
            </dl>
          </div>
        </div>
        <ol v-if="layers.length > 0" :key="scan" class="console-rows console-animate playground-candidates">
          <li v-for="({ layer, from }, index) in layers" :key="index" :style="{ animationDelay: `${Math.min(index * 30, 600)}ms` }">
            <span class="playground-layer-name">
              <NuxtLink :to="`/formats/${layer.format}`" class="playground-list-name">{{ layer.format }} · {{ layer.container }}</NuxtLink>
              <UBadge v-if="!layer.confirmed" color="neutral" variant="outline" label="guess" />
            </span>
            <span class="playground-line playground-none">{{ layer.confidence }} · {{ layer.byteLength }} bytes · {{ previewText(layer) }}</span>
            <UButton
              color="neutral"
              variant="subtle"
              trailing-icon="i-lucide-arrow-right"
              label="decompress"
              :aria-label="`Decompress layer ${index + 1} as ${layer.format} ${layer.container}`"
              @click="decompressCandidate(layer.format, layer.container, from)"
            />
          </li>
        </ol>
      </template>

      <template v-else-if="answer.kind === 'identify'">
        <div class="console-band console-subject-band">
          <div :key="scan" class="console-scan" aria-hidden="true" />
          <div class="console-identity-block">
            <ConsoleReticle
              :key="answer.details.candidates[0]?.format ?? 'none'"
              :icon="formatEntry(answer.details.candidates[0]?.format ?? '')?.icon ?? 'i-lucide-scan-search'"
            />
            <div class="console-name">
              <span class="console-label"
                >Guess / <span class="console-label-key">{{ answer.details.candidates[0]?.confidence ?? "none" }}</span></span
              >
              <h3 :class="{ 'playground-invalid': answer.details.candidates.length === 0 }">
                {{
                  answer.details.candidates[0]
                    ? `${answer.details.candidates[0].format} · ${answer.details.candidates[0].container}`
                    : "Nothing reads it"
                }}
              </h3>
              <p class="console-about">
                {{
                  answer.details.candidates[0]?.reasons.join(", ") ||
                  (answer.details.archive
                    ? `These bytes start like ${answer.details.archive}, which this package doesn't open.`
                    : "No format decompresses these bytes.")
                }}
              </p>
            </div>
          </div>
          <div class="console-readout">
            <svg class="console-link" viewBox="0 0 32 40" fill="none" aria-hidden="true">
              <circle cx="3" cy="12" r="2.5" />
              <path d="M5.5 12H14L22 20H32" />
            </svg>
            <dl :key="scan" class="console-readout-rows console-animate">
              <div>
                <dt>Candidates</dt>
                <dd class="console-accent">{{ answer.details.candidates.length }}</dd>
              </div>
              <div>
                <dt>Confirmed</dt>
                <dd>{{ answer.details.candidates.filter((candidate) => candidate.confirmed).length }}</dd>
              </div>
              <div>
                <dt>Archive</dt>
                <dd :class="{ 'playground-none': !answer.details.archive }">{{ answer.details.archive ?? "none" }}</dd>
              </div>
            </dl>
          </div>
        </div>
        <ol v-if="answer.details.candidates.length > 0" :key="scan" class="console-rows console-animate playground-candidates">
          <li
            v-for="(candidate, index) in answer.details.candidates"
            :key="`${candidate.format}:${candidate.container}`"
            :style="{ animationDelay: `${Math.min(index * 30, 600)}ms` }"
          >
            <NuxtLink :to="`/formats/${candidate.format}`" class="playground-list-name">{{ candidate.format }} · {{ candidate.container }}</NuxtLink>
            <span class="playground-line playground-none"
              >{{ candidate.confidence }} · {{ candidate.byteLength }} bytes · {{ previewText(candidate) }}</span
            >
            <UButton
              color="neutral"
              variant="subtle"
              trailing-icon="i-lucide-arrow-right"
              label="decompress"
              :aria-label="`Decompress as ${candidate.format} ${candidate.container}`"
              @click="decompressCandidate(candidate.format, candidate.container, String(request.args.data ?? ''))"
            />
          </li>
        </ol>
      </template>

      <ol v-else-if="answer.kind === 'list'" :key="scan" class="console-rows console-animate playground-list">
        <li v-for="(info, index) in answer.infos" :key="info.name" :style="{ animationDelay: `${Math.min(index * 30, 600)}ms` }">
          <NuxtLink :to="`/formats/${info.name}`" class="playground-list-name">{{ info.name }}</NuxtLink>
          <span class="playground-none">{{ info.containers.map((item) => item.name).join(", ") }}</span>
          <span>{{ ratio(formatEntry(info.name)!) === undefined ? "reads only" : `${ratio(formatEntry(info.name)!)}%` }}</span>
          <span :class="info.compress ? 'playground-valid' : 'playground-none'">{{ info.compress ? "writes" : "reads" }}</span>
        </li>
      </ol>

      <template v-else-if="answer.kind === 'describe'">
        <div class="console-band console-subject-band">
          <div :key="scan" class="console-scan" aria-hidden="true" />
          <div class="console-identity-block">
            <ConsoleReticle :key="answer.info.name" :icon="formatEntry(answer.info.name)?.icon ?? 'i-lucide-archive'" />
            <div class="console-name">
              <span class="console-label">Format / {{ answer.info.name }}</span>
              <h3>{{ answer.info.label }}</h3>
              <p class="console-about">{{ answer.info.description }}</p>
            </div>
          </div>
          <div class="console-readout">
            <svg class="console-link" viewBox="0 0 32 40" fill="none" aria-hidden="true">
              <circle cx="3" cy="12" r="2.5" />
              <path d="M5.5 12H14L22 20H32" />
            </svg>
            <dl :key="scan" class="console-readout-rows console-animate">
              <div>
                <dt>Containers</dt>
                <dd class="console-accent">{{ answer.info.containers.map((item) => item.name).join(", ") }}</dd>
              </div>
              <div>
                <dt>Standard</dt>
                <dd>
                  <UTooltip :text="answer.info.standard">
                    <span class="playground-line" tabindex="0">{{ answer.info.standard }}</span>
                  </UTooltip>
                </dd>
              </div>
              <div>
                <dt>Options</dt>
                <dd>{{ answer.info.options.length || "none" }}</dd>
              </div>
            </dl>
          </div>
        </div>
        <ol v-if="answer.info.options.length" :key="scan" class="console-rows console-animate playground-options">
          <li v-for="option in answer.info.options" :key="option.name">
            <code>{{ option.name }}</code>
            <span class="playground-none">{{ option.default === undefined ? "optional" : `default ${option.default}` }}</span>
            <span class="playground-option-about">{{ option.description }}</span>
          </li>
        </ol>
      </template>

      <div v-else class="console-band console-subject-band">
        <div :key="scan" class="console-scan" aria-hidden="true" />
        <div class="console-identity-block">
          <ConsoleReticle :key="answer.name" icon="i-lucide-circle-alert" />
          <div class="console-name">
            <span class="console-label">Error / thrown</span>
            <h3 class="console-name-mono playground-invalid">{{ answer.name }}</h3>
            <p class="console-about">{{ answer.message }}</p>
          </div>
        </div>
        <div class="console-readout">
          <dl class="console-readout-rows">
            <div>
              <dt>Tool</dt>
              <dd>{{ answered.tool }}</dd>
            </div>
            <div>
              <dt>Sent</dt>
              <dd>
                <span class="playground-line">{{ takes }}</span>
              </dd>
            </div>
          </dl>
        </div>
      </div>

      <ConsoleResponse :title="responseTitle" :text="answer.text" />

      <footer class="console-footer console-footer-plain">
        <ul class="console-links">
          <li v-if="answer.kind === 'compress' || answer.kind === 'decompress' || answer.kind === 'describe'">
            <NuxtLink :to="answeredEntry.to"><span aria-hidden="true">→ </span>{{ answeredEntry.info.label }}</NuxtLink>
          </li>
          <li>
            <NuxtLink
              :to="answered.key === 'identify' ? '/guide/identify' : answered.key === 'info' ? '/formats' : '/guide/compressing'"
              ><span aria-hidden="true">→ </span>How it works</NuxtLink
            >
          </li>
        </ul>
        <span class="console-meta">in your browser / no network</span>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.playground {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0;
}
/* The link between the two instruments: the zone's circuit, standing on its own 56 px of height. */
.playground-link {
  position: relative;
  height: 56px;
}
.playground-link > .hero-circuit {
  bottom: 0;
}
.playground-link > .hero-circuit-tag {
  bottom: 18px;
}
/* One track by default: an implicit auto track would grow to the widest chip row and push the page sideways. */
.playground-columns {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 24px 48px;
}
.playground-column {
  min-width: 0;
}
@media (width >= 56rem) {
  .playground-columns {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
}
@media (width >= 80rem) {
  .playground-ops {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
/* The playground carries more rows than a dossier, so its bands breathe a little wider. */
.playground .console-bar {
  padding-block: 12px;
}
.playground .console-band {
  padding: 22px 24px 24px;
}
.playground .console-rule-title {
  margin-bottom: 18px;
}
.playground .console-readout-rows > div {
  padding: 12px 16px;
}
.playground-prompt {
  color: var(--ui-text-dimmed);
}
.playground .console-snippet {
  padding: 12px 16px;
  line-height: 1.8;
  overflow-wrap: anywhere;
}
.playground .console-footer {
  padding: 14px 24px;
}
.playground .console-rows li {
  padding: 12px 24px;
}
.playground-band-first {
  border-top: 0;
}
.playground-tool-about {
  margin-top: 20px;
  font-size: 14px;
}
.playground-ops {
  display: grid;
  gap: 0 40px;
  margin-top: -12px;
}
.playground-ops .console-lead {
  margin-top: 12px;
  padding: 2px 0;
}
.playground-ops .console-lead > span:not(.console-tag, .console-leader) {
  white-space: nowrap;
  color: var(--ui-text-muted);
}
.playground-ops .console-lead[aria-pressed="true"] > span:not(.console-tag, .console-leader),
.playground-ops .console-lead:hover > span:not(.console-tag, .console-leader) {
  color: var(--ui-text-highlighted);
}
.playground-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 18px;
}
.playground-note {
  margin: 16px 0 0;
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.7;
  color: var(--ui-text-muted);
}
.playground-call {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.playground-none {
  color: var(--ui-text-dimmed);
}
.playground-valid {
  color: var(--console-accent);
}
.playground-invalid {
  color: var(--compressions-del);
}
.playground-line {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* The answer as a value, whole and wrapped: a long text never scrolls the page. */
.playground-output {
  max-height: 16rem;
  overflow-y: auto;
  white-space: pre-wrap;
  color: var(--ui-text-highlighted);
}
/* One row per format of the listing: the name as a link, containers, ratio, whether it writes. */
.playground-list li {
  grid-template-columns: minmax(0, 12rem) minmax(0, 10rem) 6rem minmax(0, 1fr);
}
.playground-list-name {
  color: var(--ui-text-highlighted);
}
.playground-list-name:hover {
  color: var(--console-accent);
}
/* One row per candidate: the format and container, its score and preview, the decompress button. */
.playground-candidates li {
  grid-template-columns: minmax(0, 10rem) minmax(0, 1fr) auto;
  align-items: center;
}
/* A layer's name with its `guess` badge, which wraps under it in a narrow column. */
.playground-layer-name {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  min-width: 0;
}
/* One row per option of one format: the name, whether it is required, what it does. */
.playground-options li {
  grid-template-columns: 9rem 8rem minmax(0, 1fr);
}
.playground-options code {
  font-family: var(--font-mono);
  color: var(--ui-text-highlighted);
}
.playground-option-about {
  font-family: var(--font-sans);
  font-size: 14px;
  color: var(--ui-text-muted);
}
@media (width < 640px) {
  /* The bracket note goes on a phone: a band title with two buttons has no room left for it. */
  .playground .console-rule-title > span:first-child > span {
    display: none;
  }
  .playground-options li {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .playground-option-about {
    grid-column: 1 / -1;
  }
  .playground-list li {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .playground-list li > span:nth-of-type(1) {
    display: none;
  }
  .playground-candidates li {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .playground-candidates li > .playground-line {
    display: none;
  }
}
@media (width < 400px) {
  /* The label column fits the longest label, `outputFormat`, with room to spare. */
  .playground .console-readout-rows > div {
    grid-template-columns: 6.25rem minmax(0, 1fr);
    gap: 8px;
    padding: 10px 12px;
  }
  .playground .console-band,
  .playground .console-footer,
  .playground .console-rows li {
    padding-inline: 14px;
  }
}
</style>
