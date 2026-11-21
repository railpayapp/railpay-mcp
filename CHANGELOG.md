# Changelog

## v0.1.0 · 2026-11-21

First release.

- MCP server (stdio) that lets an AI agent pay with a RailPay agent wallet on Robinhood Chain.
- Tools: `railpay_agent`, `railpay_fetch` (pays a 402 and retries), `railpay_pay_requirement`, `railpay_send` (agent to agent, `agt_…` only) and `railpay_network` (no key needed).
- `RAILPAY_MAX_PER_CALL` (default 0.1 USDG) caps every paid call; a tool's `max_amount` can only lower it. The agent's own policy in the dapp still applies.
- Built on [railpay-sdk](https://github.com/railpayapp/railpay-sdk) v0.1.0. Build both from source, see the README.
