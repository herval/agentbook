// A stand-in model behind an OpenAI-compatible API (chat completions, streamed or not), for a real OpenClaw gateway
// in a test: no LLM, no keys. The person's message says which tools to call, a line each ("CALL ab_post {json}"),
// and the model calls them in order, one a turn, then answers with what the last one said. Each request it gets is
// kept (requests): the tools it was offered and the system prompt, so a test sees what OpenClaw gave it.

import http from "node:http";
import type { AddressInfo } from "node:net";

type Content = string | { text?: string }[] | null | undefined;
interface ChatMessage {
  role: string;
  content?: Content;
  tool_calls?: unknown[];
}
// A tool as offered: { type: "function", function: { name, ... } }, or the function itself.
interface ToolDef {
  name?: string;
  function?: ToolDef;
  parameters?: { properties?: Record<string, unknown> };
  [field: string]: unknown;
}
// A chat completion request, the parts it reads.
interface ChatRequest {
  model?: string;
  stream?: boolean;
  messages?: ChatMessage[];
  tools?: ToolDef[];
}
// What it does this turn: call a tool, or say something.
interface Decision {
  call?: { name: string; args: string };
  text?: string;
}
// What a request had, for the test.
export interface ModelRequest {
  tools: string[];
  abTools: ToolDef[];
  system: string;
  toolResults: string[];
  decided: Decision;
}

const textOf = (c: Content) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text || "").join("") : "");

function decide(body: ChatRequest): Decision {
  const msgs = body.messages || [];
  // This turn: what came after the model's last answer (OpenClaw sends more than one user message, its context
  // first, and puts the time in front of the person's).
  let from = 0;
  for (let i = msgs.length - 1; i >= 0; i--)
    if (msgs[i].role === "assistant" && !msgs[i].tool_calls?.length) {
      from = i + 1;
      break;
    }
  const turn = msgs.slice(from);
  const said = turn.filter((m) => m.role === "user").map((m) => textOf(m.content)).join("\n");
  const calls = said.split("\n").map((l) => l.match(/CALL (\w+)\s*(\{.*\})?\s*$/)).filter(Boolean).map((m) => ({ name: m[1], args: m[2] || "{}" }));
  const results = turn.filter((m) => m.role === "tool");
  if (results.length < calls.length) return { call: calls[results.length] };
  // "SAY <word>" is what it answers, when a test needs its reply to be something: NO_REPLY, say.
  const told = /\bSAY (\S+)/.exec(said);
  return { text: calls.length ? `Called ${calls.map((c) => c.name).join(", ")}. Last said: ${textOf(results.at(-1)?.content).slice(0, 300)}` : told ? told[1] : "Hi." };
}

export function startModel() {
  const requests: ModelRequest[] = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      if (req.method === "GET" && /\/models$/.test(req.url)) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ object: "list", data: [{ id: "fake", object: "model" }] }));
      }
      let body: ChatRequest = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {}
      const out = decide(body);
      const tools = (body.tools || []).map((t) => t.function || t);
      const system = (body.messages || []).filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).join("\n");
      requests.push({ tools: tools.map((t) => t.name), abTools: tools.filter((t) => /^ab_/.test(t.name)), system, toolResults: (body.messages || []).filter((m) => m.role === "tool").map((m) => textOf(m.content)), decided: out });
      const id = `chatcmpl-${++n}`;
      const created = Math.floor(Date.now() / 1000);
      const call = out.call && { id: `call_${n}`, type: "function", function: { name: out.call.name, arguments: out.call.args } };
      const finish = call ? "tool_calls" : "stop";
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const send = (o: object) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        const delta = call ? { role: "assistant", content: null, tool_calls: [{ index: 0, ...call }] } : { role: "assistant", content: out.text };
        send({ id, object: "chat.completion.chunk", created, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] });
        send({ id, object: "chat.completion.chunk", created, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage });
        return res.end("data: [DONE]\n\n");
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id, object: "chat.completion", created, model: body.model, choices: [{ index: 0, message: call ? { role: "assistant", content: null, tool_calls: [call] } : { role: "assistant", content: out.text }, finish_reason: finish }], usage }));
    });
  });
  return new Promise<{ port: number; requests: ModelRequest[]; close: () => void }>((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as AddressInfo).port, requests, close: () => server.close() })));
}
