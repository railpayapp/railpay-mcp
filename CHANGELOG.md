# Changelog

## v0.3.0 · 2026-11-24

- New tool `railpay_verify_payment { tx, pay_to?, amount? }`: checks a payment on Robinhood Chain from the transaction receipt, not from RailPay or the seller. Returns `ok`, payer, recipient, USDG amount, the EIP-3009 authorization nonce, who paid the gas, the block and its time. Needs no agent key and spends nothing.
- New env `RAILPAY_RPC_URL` (default publicnode) for that read.
- `pnpm smoke` also verifies the latest settled treasury payment on chain.
- Built on [railpay-sdk](https://github.com/railpayapp/railpay-sdk) v0.3.0 (`verifyPayment`).

## v0.2.0 · 2026-11-23

- `railpay_network` also returns `gas_note`, `settled_treasury_payments` (x402 payments settled to the RailPay treasury, with tx, block and `payer_is_team`) and `token` ($RPAY address and its role). Still needs no agent key.
- Built on [railpay-sdk](https://github.com/railpayapp/railpay-sdk) v0.2.0 (typed `config()`).

## v0.1.0 · 2026-11-21

First release.

- MCP server (stdio) that lets an AI agent pay with a RailPay agent wallet on Robinhood Chain.
- Tools: `railpay_agent`, `railpay_fetch` (pays a 402 and retries), `railpay_pay_requirement`, `railpay_send` (agent to agent, `agt_…` only) and `railpay_network` (no key needed).
- `RAILPAY_MAX_PER_CALL` (default 0.1 USDG) caps every paid call; a tool's `max_amount` can only lower it. The agent's own policy in the dapp still applies.
- Built on [railpay-sdk](https://github.com/railpayapp/railpay-sdk) v0.1.0. Build both from source, see the README.
