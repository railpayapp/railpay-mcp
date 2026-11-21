#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fromUnits } from "railpay-sdk";

import { depsFromEnv } from "./config.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const deps = depsFromEnv();
  deps.log(deps.agent ? `agent key set, max ${fromUnits(deps.maxPerCall)} USDG per call` : "no RAILPAY_AGENT_KEY: only railpay_network works");
  await createServer(deps).connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`railpay-mcp failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
