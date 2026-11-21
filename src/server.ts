import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { RailPayError } from "railpay-sdk";
import { z } from "zod";

import { agentInfo, network, paidFetch, payRequirement, send, type Deps } from "./tools.js";

export const SERVER_NAME = "railpay-mcp";
export const SERVER_VERSION = "0.1.0";

const USDG_AMOUNT = z.string().regex(/^\d+(\.\d{1,6})?$/, 'USDG as a decimal string, e.g. "0.01"');

function ok(result: object): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result as Record<string, unknown>,
  };
}

/** Errors come back as tool results the model can read, not as protocol errors. */
async function run(deps: Deps, fn: () => Promise<object>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    const code = e instanceof RailPayError ? e.code : e instanceof RangeError ? "invalid_amount" : "error";
    const message = e instanceof Error ? e.message : String(e);
    deps.log(`tool error ${code}: ${message}`);
    return { isError: true, content: [{ type: "text", text: `${code}: ${message}` }] };
  }
}

/** A fresh McpServer with every RailPay tool. Transport wiring is in index.ts so tests can use an in-memory pair. */
export function createServer(deps: Deps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "railpay_agent",
    {
      title: "RailPay agent wallet",
      description:
        "Shows this agent's RailPay wallet: address, USDG balance, ETH for gas, what it spent today and its spending policy (per-request max, daily cap, allowlists). Call this before paying to know the limits.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => run(deps, () => agentInfo(deps)),
  );

  server.registerTool(
    "railpay_fetch",
    {
      title: "Fetch a URL, paying x402 if asked",
      description:
        "HTTP request that pays automatically when the server answers 402 Payment Required with x402 (USDG on Robinhood Chain). Spends real USDG from the agent wallet, within the agent's policy and the per-call limit. Returns status, body (cut at 20,000 characters) and the payment with its transaction link. Ask the user before paying for something they did not request.",
      inputSchema: {
        url: z.string().url().describe("Absolute http(s) URL."),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional().describe("Default GET."),
        body: z.string().optional().describe("Request body for POST/PUT/PATCH/DELETE."),
        headers: z.record(z.string(), z.string()).optional().describe("Extra request headers."),
        max_amount: USDG_AMOUNT.optional().describe("Refuse to pay more than this, in USDG. Can only lower the server's per-call limit."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => run(deps, () => paidFetch(deps, args)),
  );

  server.registerTool(
    "railpay_pay_requirement",
    {
      title: "Sign an x402 payment",
      description:
        "Signs a payment for an x402 402 answer you already have (the PAYMENT-REQUIRED header or the 402 JSON body) and returns the PAYMENT-SIGNATURE header to retry with. Use railpay_fetch instead when you can make the request through it. Spends real USDG once the seller settles it.",
      inputSchema: {
        payment_required: z
          .union([z.string(), z.record(z.string(), z.unknown())])
          .describe("The PAYMENT-REQUIRED header value (base64) or the 402 JSON body."),
        resource_url: z.string().url().optional().describe("URL of the paid resource."),
        max_amount: USDG_AMOUNT.optional().describe("Refuse to sign above this, in USDG."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => run(deps, () => payRequirement(deps, args)),
  );

  server.registerTool(
    "railpay_send",
    {
      title: "Pay another RailPay agent",
      description:
        "Sends USDG from this agent to another RailPay agent (agt_…) on Robinhood Chain. Needs agent-to-agent payments switched on in the policy, and ETH in the agent wallet for gas. Real money, cannot be undone: confirm with the user first.",
      inputSchema: {
        to: z.string().describe("Recipient agent id, agt_…"),
        amount: USDG_AMOUNT.describe("Amount in USDG."),
        memo: z.string().max(140).optional().describe("Short note stored with the payment."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => run(deps, () => send(deps, args)),
  );

  server.registerTool(
    "railpay_network",
    {
      title: "RailPay network",
      description:
        "Public RailPay network facts: chain, USDG contract, x402 settings, the facilitators that pay settlement gas, relayer status, and payment totals. Needs no agent key.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => run(deps, () => network(deps)),
  );

  return server;
}
