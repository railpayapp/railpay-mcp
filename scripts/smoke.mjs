// Starts the built server over stdio like an MCP client would, lists the tools, calls railpay_network
// against the live RailPay network and railpay_verify_payment against Robinhood Chain. Read-only: no agent key is passed, nothing is spent.
// Usage: pnpm build && pnpm smoke
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const env = { ...process.env };
delete env.RAILPAY_AGENT_KEY;

const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env, stderr: "inherit" });
const client = new Client({ name: "railpay-mcp-smoke", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

const r = await client.callTool({ name: "railpay_network", arguments: {} });
if (r.isError) throw new Error(`railpay_network failed: ${r.content?.[0]?.text}`);
const n = r.structuredContent;
console.log("network:", JSON.stringify({ chain_id: n.chain_id, network: n.network, relayer_status: n.relayer_status, facilitators: n.facilitators, payments: n.payments }));

const tx = n.settled_treasury_payments?.[0]?.tx ?? "0x988a0174792c1de16af8922b84324efd6f4fa6f2c7f0dd6eaebb5b16a9f641b0";
const v = await client.callTool({ name: "railpay_verify_payment", arguments: { tx } });
if (v.isError || !v.structuredContent.ok) throw new Error(`railpay_verify_payment failed: ${v.content?.[0]?.text}`);
const p = v.structuredContent;
console.log("verified:", JSON.stringify({ tx: p.tx, block: p.block, amount: p.amount, pay_to: p.pay_to, gas_payer: p.gas_payer }));

const denied = await client.callTool({ name: "railpay_agent", arguments: {} });
if (!denied.isError) throw new Error("railpay_agent should refuse without a key");
console.log("without key:", denied.content?.[0]?.text);

await client.close();
console.log("smoke ok");
