import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { registerPiTools } from "@agntn/tools/pi";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type * as CompressionTools from "../../../dist/tools.d.mts";

const sourceModuleUrl = new URL("../../../src/tools.ts", import.meta.url);
const distributionModuleUrl = new URL("../../../dist/tools.mjs", import.meta.url);

/**
 * Loads the tool definitions, from the source in a checkout and the build in the package.
 *
 * @returns {Promise<typeof CompressionTools>} The definitions and the executor loader.
 */
function loadTools(): Promise<typeof CompressionTools> {
  return import(
    existsSync(fileURLToPath(sourceModuleUrl)) ? sourceModuleUrl.href : distributionModuleUrl.href
  ) as Promise<typeof CompressionTools>;
}

/**
 * Registers the compression tools; the executors load on the first call.
 *
 * @param pi - Pi extension API.
 */
export default async function compressionsExtension(pi: ExtensionAPI): Promise<void> {
  const { compressionTools } = await loadTools();
  registerPiTools(pi, compressionTools);
}
