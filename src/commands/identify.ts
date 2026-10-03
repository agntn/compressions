import { defineCommand } from "citty";
import { quote } from "../core/errors.ts";
import {
  archiveOf,
  identify,
  peel,
  readable,
  type CompressionCandidate,
} from "../core/identify.ts";
import { fromFormat, integerFlag, readSource } from "./shared.ts";

/**
 * Writes a candidate on one line.
 *
 * @param candidate - The candidate.
 * @returns {string} The line.
 */
function line(candidate: CompressionCandidate): string {
  const head = candidate.bytes.subarray(0, 60);
  const preview = readable(head)
    ? quote(new TextDecoder().decode(head))
    : `${candidate.bytes.length} bytes`;
  const mark = candidate.confirmed ? "" : " unconfirmed";
  return `${String(candidate.confidence).padStart(3)}${mark} ${candidate.format} --container ${candidate.container}  ${candidate.reasons.join("; ")}  ${preview}`;
}

/**
 * Names an archive the bytes start like, for a message.
 *
 * @param data - The bytes.
 * @param suffix - What to add after the archive name.
 * @returns {string} The sentence, or nothing.
 */
function archiveNote(data: Uint8Array, suffix = ""): string {
  const archive = archiveOf(data);
  return archive ? ` It starts like ${archive}${suffix}.` : "";
}

/**
 * Peels every layer, lists them on stderr and writes the innermost bytes to stdout.
 *
 * @param data - The bytes.
 * @param depth - Most layers.
 */
function peelTo(data: Uint8Array, depth: number): void {
  const layers = peel(data, { depth });
  for (const layer of layers) process.stderr.write(`${line(layer)}\n`);
  const inner = layers.findLast((layer) => layer.confirmed)?.bytes;
  if (inner) {
    process.stdout.write(inner);
    return;
  }
  process.stderr.write(`No confirmed layer.${archiveNote(data)}\n`);
  process.exitCode = 1;
}

export default defineCommand({
  meta: { name: "identify", description: "Name the format and container of compressed data" },
  args: {
    file: { type: "positional", description: "File to look at, or - for stdin", required: true },
    peel: {
      type: "boolean",
      description: "Take off every layer and write the innermost bytes to stdout",
    },
    depth: { type: "string", description: "With --peel: most layers (default 10)" },
    from: {
      type: "string",
      description: "How the input is written: raw (default), hex or base64",
      default: "raw",
    },
  },
  run({ args }) {
    const data = fromFormat(readSource(args.file), args.from);
    if (args.peel) {
      peelTo(data, args.depth === undefined ? 10 : integerFlag("depth", args.depth));
      return;
    }
    const candidates = identify(data);
    for (const candidate of candidates) process.stdout.write(`${line(candidate)}\n`);
    if (candidates.length > 0) return;
    process.stderr.write(
      `No format decompresses this.${archiveNote(data, ", which this package does not open")}\n`,
    );
    process.exitCode = 1;
  },
});
