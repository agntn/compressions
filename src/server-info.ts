import type { McpServerInfo } from "@agntn/tools/mcp";
import { version } from "./version.ts";

/** How both MCP servers introduce themselves, so a connector card says more than a name. */
export const serverInfo = {
  name: "compressions",
  version,
  description:
    "gzip, bzip2, xz, zstd, brotli, lz4 and good old .Z, written from the specs. Hand it a blob nobody labeled and it names the format, checks the checksum and peels it open, layer by layer.",
  icons: [
    {
      src: "https://compressions.agntn.dev/favicon.svg",
      mimeType: "image/svg+xml",
      sizes: ["any"],
    },
    {
      src: "https://compressions.agntn.dev/icon-512.png",
      mimeType: "image/png",
      sizes: ["512x512"],
    },
  ],
} satisfies McpServerInfo;
