import { DEFAULT_BASE_URL, RailPay, toUnits } from "railpay-sdk";

import type { Deps } from "./tools.js";

/** Default ceiling per tool call when RAILPAY_MAX_PER_CALL is not set. */
export const DEFAULT_MAX_PER_CALL = "0.1";

/** Build the tool dependencies from the environment. Logs go to stderr: stdout carries the MCP protocol. */
export function depsFromEnv(env: NodeJS.ProcessEnv = process.env): Deps {
  const baseUrl = env.RAILPAY_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const key = env.RAILPAY_AGENT_KEY?.trim() || null;
  const max = env.RAILPAY_MAX_PER_CALL?.trim() || DEFAULT_MAX_PER_CALL;
  let maxPerCall: bigint;
  try {
    maxPerCall = toUnits(max);
  } catch {
    throw new Error(`RAILPAY_MAX_PER_CALL must be a USDG amount like "0.1", got ${JSON.stringify(max)}`);
  }
  return {
    agent: key ? new RailPay({ apiKey: key, baseUrl }) : null,
    public: new RailPay({ baseUrl }),
    fetch: (input, init) => globalThis.fetch(input, init),
    maxPerCall,
    rpcUrl: env.RAILPAY_RPC_URL?.trim() || undefined,
    log: (message) => process.stderr.write(`[railpay-mcp] ${message}\n`),
  };
}
