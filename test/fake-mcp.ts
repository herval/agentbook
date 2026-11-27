// A stand-in for an MCP server over Streamable HTTP, for the demo's page routines: "datadog", with span_stats
// (p95 latency and the error rate for the last 30 days, ending today, per service, in TOON, as acme-litellm answers) and
// list_monitors. It drifts a little on each call, so a routine's runs change the page.

import http from "node:http";
import type { AddressInfo } from "node:net";

// Dates as dates (2026-10-03), so a page's time filter can trim them.
const ymd = (daysAgo: number) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const DAYS = Array.from({ length: 30 }, (_, i) => ymd(29 - i));
// The last week as it was, after 23 calmer days before it.
const before = (first: number, i: number) => Math.round(first + 14 * Math.sin(i / 2.6) + (i % 4) * 3);
const month = (week: number[]) => [...Array.from({ length: 23 }, (_, i) => before(week[0], i)), ...week];
const BASE = { "core-api": month([430, 418, 425, 409, 401, 396, 384]), "erp-sync": month([455, 470, 560, 610, 500, 452, 431]), "event-ingest": month([260, 262, 270, 281, 300, 322, 341]) };
const OVERALL = month([455, 448, 470, 452, 430, 412, 388]);
const ERRORS = [...Array.from({ length: 23 }, (_, i) => (0.15 + ((i * 7) % 5) / 100).toFixed(2)), "0.18", "0.16", "0.19", "0.17", "0.15", "0.17"];

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: { name?: string; arguments?: { last?: string; service?: string } };
}

export function startFakeMcp({ port = 0, key = "demo-key" }: { port?: number; key?: string } = {}) {
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (req.headers["x-api-key"] !== key) return res.writeHead(401).end("bad key");
    const msg: RpcMessage = JSON.parse(body || "{}");
    const answer = (result: object) => {
      res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "demo" });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`);
    };
    if (msg.method === "initialize") return answer({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "datadog", version: "1" } });
    if (msg.id == null) return res.writeHead(202).end();
    if (msg.method === "tools/list") return answer({ tools: [{ name: "span_stats", inputSchema: { type: "object" } }, { name: "list_monitors", inputSchema: { type: "object" } }] });
    const name = msg.params?.name;
    if (name === "span_stats") {
      const drift = (calls++ % 5) * 3;
      // For one service (service), and the last N days (last: "7d"); 30 days of every service when not asked.
      const args = msg.params?.arguments || {};
      const n = Math.min(DAYS.length, Math.max(1, parseInt(args.last, 10) || DAYS.length));
      const services = Object.entries(BASE).filter(([s]) => !args.service || s === args.service);
      const lines = [`window: ${n}d`, `days[${n}]: ${DAYS.slice(-n).map((d) => `"${d}"`).join(",")}`, `services[${services.length}]:`];
      for (const [service, all] of services) {
        const p95 = all.slice(-n);
        lines.push(`  - name: ${service}`, `    p95[${p95.length}]: ${p95.map((v, i) => (i === p95.length - 1 ? v - drift : v)).join(",")}`);
      }
      lines.push("overall:", `  p95[30]: ${OVERALL.slice(0, -1).join(",")},${OVERALL.at(-1) - drift}`, `  error_rate[30]: ${ERRORS.join(",")},${(0.21 - drift / 1000).toFixed(3)}`);
      return answer({ content: [{ type: "text", text: lines.join("\n") }] });
    }
    if (name === "list_monitors") return answer({ content: [{ type: "text", text: 'monitors[2]{name,state}:\n  "event-ingest backlog",Alert\n  "erp-sync p95",OK' }] });
    return answer({ content: [{ type: "text", text: `No tool ${name}` }], isError: true });
  });
  return new Promise<{ url: string; key: string; close: () => void }>((resolve) => server.listen(port, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, key, close: () => server.close() })));
}
