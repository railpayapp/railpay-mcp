import {
  RailPay,
  RailPayError,
  fromUnits,
  isRailPayPayable,
  readPaymentRequired,
  readPaymentResponse,
  requirementAmount,
  toUnits,
  txUrl,
  unb64json,
  withPayment,
  type PaymentEvent,
  type PaymentRequired,
} from "railpay-sdk";

/** Everything a tool needs. Built from env in index.ts, injected in tests. */
export type Deps = {
  /** null when RAILPAY_AGENT_KEY is not set: only the public tools work. */
  agent: RailPay | null;
  /** Public client (no key) for the network config. */
  public: RailPay;
  fetch: typeof fetch;
  /** Hard ceiling per tool call, in base units, applied on top of the agent's policy. */
  maxPerCall: bigint;
  log: (message: string) => void;
};

export const MAX_BODY_CHARS = 20_000;
const FETCH_TIMEOUT_MS = 60_000;

function needAgent(deps: Deps): RailPay {
  if (!deps.agent) throw new RailPayError(0, "missing_agent_key", "Set RAILPAY_AGENT_KEY (an agent key rp_sk_… from the RailPay dapp) to use this tool");
  return deps.agent;
}

/** The lower of the per-call ceiling and an optional limit the model asked for. */
function limitOf(deps: Deps, maxAmount?: string): bigint {
  if (maxAmount === undefined) return deps.maxPerCall;
  const asked = toUnits(maxAmount);
  return asked < deps.maxPerCall ? asked : deps.maxPerCall;
}

function overLimit(amount: bigint, limit: bigint, deps: Deps): never {
  const env = limit === deps.maxPerCall ? " (RAILPAY_MAX_PER_CALL)" : "";
  throw new RailPayError(0, "over_max_amount", `This asks ${fromUnits(amount)} USDG, above the limit of ${fromUnits(limit)} USDG${env}`);
}

// ---------- railpay_agent ----------

export async function agentInfo(deps: Deps) {
  const a = await needAgent(deps).me();
  const left = Math.max(0, a.policy.daily_cap - a.spent_today);
  return {
    id: a.id,
    name: a.name,
    address: a.address,
    balance_usdg: fromUnits(a.balance),
    eth: a.eth,
    spent_today_usdg: fromUnits(a.spent_today),
    left_today_usdg: fromUnits(left),
    max_per_call_usdg: fromUnits(deps.maxPerCall),
    policy: {
      paused: a.policy.paused,
      per_request_max_usdg: fromUnits(a.policy.per_request_max),
      daily_cap_usdg: fromUnits(a.policy.daily_cap),
      allowed_hosts: a.policy.allowed_hosts,
      allowed_pay_to: a.policy.allowed_pay_to,
      allow_a2a: a.policy.allow_a2a,
    },
    explorer: `https://robinhoodchain.blockscout.com/address/${a.address}`,
  };
}

// ---------- railpay_fetch ----------

export type FetchInput = {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: string;
  headers?: Record<string, string>;
  max_amount?: string;
};

export async function paidFetch(deps: Deps, input: FetchInput) {
  const agent = needAgent(deps);
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new RailPayError(0, "invalid_url", "url must be an absolute http(s) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new RailPayError(0, "invalid_url", "url must be an absolute http(s) URL");
  const limit = limitOf(deps, input.max_amount);
  let paid: PaymentEvent | null = null;
  const f = withPayment(agent, {
    fetch: deps.fetch,
    maxAmount: limit,
    onPayment: (e) => {
      paid = e;
      deps.log(`paying ${fromUnits(e.amount)} USDG to ${e.requirement.payTo} for ${e.url}`);
    },
  });
  const method = input.method ?? "GET";
  const res = await f(url.href, {
    method,
    headers: input.headers,
    body: input.body === undefined || method === "GET" ? undefined : input.body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  const text = await res.text();
  const truncated = text.length > MAX_BODY_CHARS;
  const receipt = readPaymentResponse(res);
  const event = paid as PaymentEvent | null;
  const out: Record<string, unknown> = {
    status: res.status,
    content_type: res.headers.get("content-type"),
    body: truncated ? `${text.slice(0, MAX_BODY_CHARS)}\n…[truncated, ${text.length} chars in total]` : text,
    truncated,
    paid: event
      ? {
          amount_usdg: fromUnits(event.amount),
          pay_to: event.requirement.payTo,
          settled: receipt?.success ?? false,
          tx_hash: receipt?.transaction || null,
          tx_url: receipt?.transaction ? txUrl(receipt.transaction) : null,
          ...(receipt?.success ? {} : { note: "Signed and sent. The seller did not confirm settlement in this response." }),
        }
      : null,
  };
  if (res.status === 402 && !event) {
    const pr = await readPaymentRequired(new Response(text, { status: 402, headers: res.headers }));
    out.payment_required = pr ? summarize(pr) : null;
    out.note = "The resource asks for a payment RailPay cannot make (only exact / eip155:4663 / USDG is supported).";
  }
  return out;
}

function summarize(pr: PaymentRequired) {
  return pr.accepts.map((r) => ({
    scheme: r.scheme,
    network: r.network,
    asset: r.asset,
    amount: r.amount ?? r.maxAmountRequired,
    pay_to: r.payTo,
    payable_by_railpay: isRailPayPayable(r),
  }));
}

// ---------- railpay_pay_requirement ----------

export type PayRequirementInput = {
  /** The PAYMENT-REQUIRED header value (base64) or the 402 JSON body. */
  payment_required: string | Record<string, unknown>;
  resource_url?: string;
  max_amount?: string;
};

export async function payRequirement(deps: Deps, input: PayRequirementInput) {
  const agent = needAgent(deps);
  let pr: PaymentRequired;
  try {
    pr = (typeof input.payment_required === "string"
      ? input.payment_required.trim().startsWith("{")
        ? JSON.parse(input.payment_required)
        : unb64json(input.payment_required)
      : input.payment_required) as PaymentRequired;
  } catch {
    throw new RailPayError(0, "invalid_payment_required", "payment_required must be the PAYMENT-REQUIRED header (base64) or the 402 JSON body");
  }
  if (!Array.isArray(pr?.accepts)) throw new RailPayError(0, "invalid_payment_required", "payment_required has no accepts list");
  const req = pr.accepts.find(isRailPayPayable);
  if (!req) throw new RailPayError(0, "not_payable", "No option in accepts is exact / eip155:4663 / USDG");
  const amount = requirementAmount(req);
  const limit = limitOf(deps, input.max_amount);
  if (amount > limit) overLimit(amount, limit, deps);
  const resource = input.resource_url ?? pr.resource?.url;
  const signed = await agent.pay({ ...pr, accepts: [req], resource: pr.resource ?? (resource ? { url: resource } : undefined) }, resource);
  deps.log(`signed ${fromUnits(amount)} USDG to ${req.payTo}${resource ? ` for ${resource}` : ""}`);
  return {
    header: signed.header,
    value: signed.payment,
    amount_usdg: fromUnits(amount),
    pay_to: req.payTo,
    valid_before: signed.valid_before,
    spent_today_usdg: signed.spent_today,
    how_to_use: `Retry the request with the header ${signed.header}: <value>. The seller settles it on-chain.`,
  };
}

// ---------- railpay_send ----------

export type SendInput = { to: string; amount: string; memo?: string };

export async function send(deps: Deps, input: SendInput) {
  const agent = needAgent(deps);
  if (!/^agt_[A-Za-z0-9_-]+$/.test(input.to)) throw new RailPayError(0, "invalid_recipient", "to must be a RailPay agent id (agt_…)");
  const amount = toUnits(input.amount);
  if (amount <= 0n) throw new RailPayError(0, "invalid_amount", "amount must be above 0");
  if (amount > deps.maxPerCall) overLimit(amount, deps.maxPerCall, deps);
  const r = await agent.send({ to: input.to, amount: fromUnits(amount), memo: input.memo });
  deps.log(`sent ${fromUnits(amount)} USDG to ${input.to}: ${r.tx_hash}`);
  return r;
}

// ---------- railpay_network ----------

export async function network(deps: Deps) {
  const config = await deps.public.config();
  return {
    chain: config.chain_name ?? "Robinhood Chain",
    chain_id: config.chain_id,
    network: config.network,
    asset: config.asset,
    explorer: config.explorer,
    facilitators: config.facilitators,
    relayer_status: config.relayer_status,
    gas: config.gas,
    x402: config.x402,
    agent_key_set: deps.agent !== null,
    max_per_call_usdg: fromUnits(deps.maxPerCall),
  };
}
