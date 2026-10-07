import { serverInfo } from "../../../src/server-info.ts";

/** Introduces itself like `compressions mcp`, plus the Docus page tools. */
export default defineMcpHandler({ ...serverInfo });
