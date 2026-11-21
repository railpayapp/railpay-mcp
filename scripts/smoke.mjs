// Starts the built server over stdio like an MCP client would, lists the tools and calls railpay_network
// against the live RailPay network. Read-only: no agent key is passed, nothing is spent.
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

const denied = await client.callTool({ name: "railpay_agent", arguments: {} });
if (!denied.isError) throw new Error("railpay_agent should refuse without a key");
console.log("without key:", denied.content?.[0]?.text);

await client.close();
console.log("smoke ok");
