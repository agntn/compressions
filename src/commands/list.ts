import { defineCommand } from "citty";
import { create, formatInfos } from "../core/registry.ts";
import type { CompressionContainer, CompressionInfo, CompressionOption } from "../core/types.ts";

/**
 * Writes a container on a line.
 *
 * @param container - The container.
 * @returns {string} The line.
 */
function containerLine(container: CompressionContainer): string {
  const facts = [
    container.extensions.join(" "),
    container.magic ? `magic ${container.magic}` : "",
    container.checksum ? `checksum ${container.checksum}` : "",
  ].filter(Boolean);
  const tail = facts.length > 0 ? `, ${facts.join(", ")}` : "";
  return `container ${container.name.padEnd(9)}${container.label}${tail}`;
}

/**
 * Writes an option as the flag that sets it.
 *
 * @param option - The option.
 * @returns {string} The line.
 */
function optionLine(option: CompressionOption): string {
  const range = option.min === undefined ? "" : ` (${option.min} to ${option.max})`;
  const values = option.choices ? ` (${option.choices.join(", ")})` : range;
  const scope = option.containers ? ` [${option.containers.join(", ")}]` : "";
  return `--${option.name.padEnd(11)}${option.description}${values}${scope}${option.decode ? " (decompress too)" : ""}`;
}

/**
 * Writes one format in full.
 *
 * @param info - The format's metadata.
 * @returns {string} The lines.
 */
function formatText(info: CompressionInfo): string {
  return [
    `${info.label} (${info.name})`,
    info.description,
    `standard  ${info.standard}`,
    `writes    ${info.compress ? "yes" : "no, reads only"}`,
    ...info.containers.map(containerLine),
    ...info.options.map(optionLine),
  ].join("\n");
}

export default defineCommand({
  meta: {
    name: "list",
    description: "List the formats, or show one with its containers and options",
  },
  args: { format: { type: "positional", description: "Format to show", required: false } },
  run({ args }) {
    if (args.format) {
      process.stdout.write(`${formatText(create(args.format).info())}\n`);
      return;
    }
    for (const info of formatInfos()) {
      const containers = info.containers.map((container) => container.name).join(", ");
      process.stdout.write(
        `${info.name.padEnd(9)}${(info.compress ? "rw" : "r-").padEnd(4)}${containers.padEnd(24)}${info.description}\n`,
      );
    }
  },
});
