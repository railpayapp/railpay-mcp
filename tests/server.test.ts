import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NETWORK, RailPay, USDG, b64json, type PaymentRequired } from "railpay-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { depsFromEnv } from "../src/config.js";
import { createServer } from "../src/server.js";
import { MAX_BODY_CHARS, type Deps } from "../src/tools.js";

const API = "https://api.test";
const SELLER = "https://seller.test";
const PAY_TO = "0x2222222222222222222222222222222222222222";
const TX = `0x${"ab".repeat(32)}`;
const RPC = "https://rpc.test";
// The first x402 settlement to the RailPay treasury (block 121421058), as the RPC returns it.
const SETTLED = "0x988a0174792c1de16af8922b84324efd6f4fa6f2c7f0dd6eaebb5b16a9f641b0";
const NONCE = "0xb543c896e4d11b7c71344d2e5430a631fa7703cbb448487dd77060336ffdcb42";
const RECEIPT = {
  status: "0x1",
  blockNumber: "0x73cbd02",
  from: "0x619538f76ba880a85e3db265694cdba0a66acc4d",
  gasUsed: "0x191f7",
  logs: [
    {
      address: USDG.toLowerCase(),
      topics: ["0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5", "0x0000000000000000000000002c92a59abf4a39b4db228fecb73e2ddaa900e611", NONCE],
      data: "0x",
      logIndex: "0x2b",
    },
    {
      address: USDG.toLowerCase(),
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        "0x0000000000000000000000002c92a59abf4a39b4db228fecb73e2ddaa900e611",
        "0x000000000000000000000000c74444dd7c6183b0f810487ef9dab8d7333a3709",
      ],
      data: "0x00000000000000000000000000000000000000000000000000000000000007d0",
      logIndex: "0x2c",
    },
  ],
};

const required = (amount: string, network = NETWORK): PaymentRequired => ({
  x402Version: 2,
  error: "payment_required",
  resource: { url: `${SELLER}/data` },
  accepts: [{ scheme: "exact", network, amount, asset: USDG, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "Global Dollar", version: "1" } }],
});

let price: string;
let sellerNetwork: string;
let bigBody: boolean;
let apiError: { status: number; error: string; message: string } | null;
let calls: { url: string; method: string; body: string; auth: string | null }[];

const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const req = new Request(input, init);
  const body = await req.text();
  calls.push({ url: req.url, method: req.method, body, auth: req.headers.get("authorization") });
  const path = req.url.replace(API, "");
  if (req.url === `${RPC}/`) {
    const { method, params } = JSON.parse(body) as { method: string; params: string[] };
    if (method === "eth_getTransactionReceipt") return Response.json({ jsonrpc: "2.0", id: 1, result: params[0] === SETTLED ? RECEIPT : null });
    if (method === "eth_getBlockByNumber") return Response.json({ jsonrpc: "2.0", id: 1, result: { timestamp: "0x6b0436f0" } });
  }
  if (req.url.startsWith(API)) {
    if (apiError && path !== "/v1/config") return Response.json({ error: apiError.error, message: apiError.message }, { status: apiError.status });
    if (path === "/v1/agent/me")
      return Response.json({
        agent: {
          id: "agt_1",
          name: "Researcher",
          address: "0x1111111111111111111111111111111111111111",
          created_at: 0,
          balance: 2_500_000,
          eth: "0.0001",
          spent_today: 30_000,
          policy: { per_request_max: 100_000, daily_cap: 1_000_000, allowed_hosts: [], allowed_pay_to: [], allow_a2a: true, paused: false },
        },
      });
    if (path === "/v1/agent/pay") return Response.json({ payment: "signed-payment", header: "PAYMENT-SIGNATURE", authorization: {}, valid_before: 1, amount: "0.01", spent_today: "0.04" });
    if (path === "/v1/agent/send") return Response.json({ tx_hash: TX, tx_url: `https://robinhoodchain.blockscout.com/tx/${TX}`, amount: JSON.parse(body).amount });
    if (path === "/v1/config")
      return Response.json({
        chain_id: 4663,
        chain_name: "Robinhood Chain",
        network: NETWORK,
        facilitators: ["https://x402.t0ll.xyz"],
        relayer_status: "coming_soon",
        gas_note: "x402 payments need no relayer",
        x402: { min_amount: 1000 },
        settlements: { about: "", guide: "", treasury_receipts: [{ tx: TX, block: 121421058, log_index: 44, amount: "0.002", asset: "USDG", payer: "0x2c92a59abf4a39b4db228fecb73e2ddaa900e611", payer_is_team: true, resource: "/x402/quote", settled_at: "2026-11-23T12:52:00.000Z", explorer: `https://robinhoodchain.blockscout.com/tx/${TX}` }] },
        token: { symbol: "RPAY", address: "0xf8a9170f198fc8b7ef58265ec00768fb26abb23d", role: "none today", page: "https://railpay.app/token" },
      });
  }
  if (req.url === `${SELLER}/data`) {
    if (req.headers.get("payment-signature") === "signed-payment") {
      return new Response(bigBody ? "x".repeat(MAX_BODY_CHARS + 50) : '{"answer":42}', {
        headers: { "content-type": "application/json", "PAYMENT-RESPONSE": b64json({ success: true, transaction: TX, network: NETWORK }) },
      });
    }
    const pr = required(price, sellerNetwork);
    return Response.json(pr, { status: 402, headers: { "PAYMENT-REQUIRED": b64json(pr) } });
  }
  return new Response("not found", { status: 404 });
});

function deps(withKey = true, maxPerCall = 100_000n): Deps {
  const f = mockFetch as unknown as typeof fetch;
  return {
    agent: withKey ? new RailPay({ apiKey: "rp_sk_test", baseUrl: API, fetch: f }) : null,
    public: new RailPay({ baseUrl: API, fetch: f }),
    fetch: f,
    maxPerCall,
    rpcUrl: RPC,
    log: () => {},
  };
}

async function connect(d: Deps) {
  const server = createServer(d);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

type Result = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Record<string, unknown> };
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Result;
const paidCalls = () => calls.filter((c) => c.url.endsWith("/v1/agent/pay"));

beforeEach(() => {
  price = "10000";
  sellerNetwork = NETWORK;
  bigBody = false;
  apiError = null;
  calls = [];
  mockFetch.mockClear();
});

describe("railpay-mcp", () => {
  it("lists the six tools", async () => {
    const client = await connect(deps());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["railpay_agent", "railpay_fetch", "railpay_network", "railpay_pay_requirement", "railpay_send", "railpay_verify_payment"]);
  });

  it("railpay_verify_payment reads the payment from the chain, without a key", async () => {
    const client = await connect(deps(false));
    const r = await call(client, "railpay_verify_payment", { tx: SETTLED, pay_to: "0xc74444dd7c6183b0f810487ef9dab8d7333a3709", amount: "0.002" });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      ok: true,
      block: 121421058,
      settled_at: "2026-11-23T12:52:00.000Z",
      amount: "0.002",
      authorization: { nonce: NONCE },
      gas_used: 102903,
      checks: { succeeded: true, transfer: true, pay_to: true, amount: true, authorization: true },
    });
    expect(calls.every((c) => c.url === `${RPC}/`)).toBe(true);

    const wrong = await call(client, "railpay_verify_payment", { tx: SETTLED, amount: "0.5" });
    expect(wrong.structuredContent).toMatchObject({ ok: false, reason: "amount_mismatch" });

    const unknown = await call(client, "railpay_verify_payment", { tx: TX });
    expect(unknown.structuredContent).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("railpay_network works without an agent key", async () => {
    const client = await connect(deps(false));
    const r = await call(client, "railpay_network");
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ chain_id: 4663, relayer_status: "coming_soon", agent_key_set: false, max_per_call_usdg: "0.1" });
    expect(r.structuredContent).toMatchObject({
      gas_note: "x402 payments need no relayer",
      settled_treasury_payments: [{ tx: TX, block: 121421058, payer_is_team: true }],
      token: { symbol: "RPAY" },
    });
    expect(calls.every((c) => c.auth === null)).toBe(true);
  });

  it("agent tools explain the missing key", async () => {
    const client = await connect(deps(false));
    for (const [name, args] of [
      ["railpay_agent", {}],
      ["railpay_fetch", { url: `${SELLER}/data` }],
      ["railpay_send", { to: "agt_2", amount: "0.01" }],
    ] as const) {
      const r = await call(client, name, args);
      expect(r.isError).toBe(true);
      expect(r.content[0]?.text).toMatch(/^missing_agent_key/);
    }
    expect(calls).toHaveLength(0);
  });

  it("railpay_agent shows amounts in USDG", async () => {
    const r = await call(await connect(deps()), "railpay_agent");
    expect(r.structuredContent).toMatchObject({
      balance_usdg: "2.5",
      spent_today_usdg: "0.03",
      left_today_usdg: "0.97",
      policy: { per_request_max_usdg: "0.1", daily_cap_usdg: "1", allow_a2a: true },
    });
  });

  it("railpay_fetch pays a 402 and reports the transaction", async () => {
    const r = await call(await connect(deps()), "railpay_fetch", { url: `${SELLER}/data` });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      status: 200,
      body: '{"answer":42}',
      truncated: false,
      paid: { amount_usdg: "0.01", pay_to: PAY_TO, settled: true, tx_hash: TX, tx_url: `https://robinhoodchain.blockscout.com/tx/${TX}` },
    });
    expect(paidCalls()).toHaveLength(1);
    expect(paidCalls()[0]?.auth).toBe("Bearer rp_sk_test");
  });

  it("railpay_fetch cuts long bodies", async () => {
    bigBody = true;
    const r = await call(await connect(deps()), "railpay_fetch", { url: `${SELLER}/data` });
    expect(r.structuredContent?.truncated).toBe(true);
    expect(String(r.structuredContent?.body).length).toBeLessThan(MAX_BODY_CHARS + 100);
  });

  it("railpay_fetch never pays above the per-call limit, and max_amount cannot raise it", async () => {
    price = "200000"; // 0.2 USDG, limit is 0.1
    const client = await connect(deps());
    const r = await call(client, "railpay_fetch", { url: `${SELLER}/data`, max_amount: "5" });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/^over_max_amount/);
    price = "10000";
    const lower = await call(client, "railpay_fetch", { url: `${SELLER}/data`, max_amount: "0.005" });
    expect(lower.isError).toBe(true);
    expect(paidCalls()).toHaveLength(0);
  });

  it("railpay_fetch returns a 402 it cannot pay without signing", async () => {
    sellerNetwork = "eip155:8453";
    const r = await call(await connect(deps()), "railpay_fetch", { url: `${SELLER}/data` });
    expect(r.structuredContent).toMatchObject({ status: 402, paid: null });
    expect((r.structuredContent?.payment_required as { payable_by_railpay: boolean }[])[0]?.payable_by_railpay).toBe(false);
    expect(paidCalls()).toHaveLength(0);
  });

  it("railpay_fetch sends the POST body", async () => {
    await call(await connect(deps()), "railpay_fetch", { url: `${SELLER}/data`, method: "POST", body: '{"q":1}', headers: { "content-type": "application/json" } });
    const seller = calls.filter((c) => c.url === `${SELLER}/data`);
    expect(seller.map((c) => [c.method, c.body])).toEqual([
      ["POST", '{"q":1}'],
      ["POST", '{"q":1}'],
    ]);
  });

  it("railpay_pay_requirement signs from the header or the body", async () => {
    const client = await connect(deps());
    const fromHeader = await call(client, "railpay_pay_requirement", { payment_required: b64json(required("10000")) });
    expect(fromHeader.structuredContent).toMatchObject({ header: "PAYMENT-SIGNATURE", value: "signed-payment", amount_usdg: "0.01", pay_to: PAY_TO });
    const fromBody = await call(client, "railpay_pay_requirement", { payment_required: required("10000") as unknown as Record<string, unknown> });
    expect(fromBody.structuredContent?.value).toBe("signed-payment");
    const over = await call(client, "railpay_pay_requirement", { payment_required: b64json(required("500000")) });
    expect(over.content[0]?.text).toMatch(/^over_max_amount/);
    const other = await call(client, "railpay_pay_requirement", { payment_required: b64json(required("10000", "eip155:1")) });
    expect(other.content[0]?.text).toMatch(/^not_payable/);
    expect(paidCalls()).toHaveLength(2);
  });

  it("railpay_send checks the recipient and the limit", async () => {
    const client = await connect(deps());
    expect((await call(client, "railpay_send", { to: "0x2222222222222222222222222222222222222222", amount: "0.01" })).content[0]?.text).toMatch(/^invalid_recipient/);
    expect((await call(client, "railpay_send", { to: "agt_2", amount: "0.5" })).content[0]?.text).toMatch(/^over_max_amount/);
    expect(calls.filter((c) => c.url.endsWith("/v1/agent/send"))).toHaveLength(0);
    const ok = await call(client, "railpay_send", { to: "agt_2", amount: "0.05", memo: "thanks" });
    expect(ok.structuredContent).toMatchObject({ tx_hash: TX, amount: "0.05" });
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/v1/agent/send"))?.body ?? "{}")).toEqual({ to: "agt_2", amount: "0.05", memo: "thanks" });
  });

  it("passes API refusals through to the model", async () => {
    apiError = { status: 403, error: "over_daily_cap", message: "Daily cap 1 would be exceeded" };
    const r = await call(await connect(deps()), "railpay_fetch", { url: `${SELLER}/data` });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toBe("over_daily_cap: Daily cap 1 would be exceeded");
  });
});

describe("depsFromEnv", () => {
  it("defaults to 0.1 USDG per call and no agent without a key", () => {
    const d = depsFromEnv({});
    expect(d.maxPerCall).toBe(100_000n);
    expect(d.agent).toBeNull();
    expect(d.public.baseUrl).toBe("https://dapp.railpay.app");
  });

  it("reads the key, base URL and limit", () => {
    const d = depsFromEnv({ RAILPAY_AGENT_KEY: "rp_sk_x", RAILPAY_BASE_URL: "http://localhost:3222/", RAILPAY_MAX_PER_CALL: "2.5" });
    expect(d.agent).not.toBeNull();
    expect(d.agent?.baseUrl).toBe("http://localhost:3222");
    expect(d.maxPerCall).toBe(2_500_000n);
  });

  it("rejects a bad limit", () => {
    expect(() => depsFromEnv({ RAILPAY_MAX_PER_CALL: "lots" })).toThrow(/RAILPAY_MAX_PER_CALL/);
  });
});
