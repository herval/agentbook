// dsh's web page, as test/dsh-web-real.ts needs it: a plugin in the dsh web process that does what the page asks
// dsh's session controller to (a new session, a message of yours), and says how many of dsh's own prompts are
// waiting for a page to answer them (its gateway's pending asks: an approval, a question). On 127.0.0.1:PAGE_PORT:
// POST /new { cwd } -> { sessionId }, POST /prompt { id, text }, GET /pending -> { pending }, and GET /has?id= ->
// { has, cwd, workspace }: whether dsh web has that session (a live agent), its folder, and whether it's in the
// workspace at that folder; POST /workspace { path } adds a workspace, as the page's Open folder does.

import crypto from "node:crypto";
import http from "node:http";

export const name = "fake-dsh-page";

// dsh's services, as far as this reaches into them (by the name it injects each as).
interface Services {
  sessionController?: { commands: { create(o: { cwd: string }): Promise<object>; prompt(o: object, by: { kind: string; rpcId: string }): Promise<object> } };
  typertGateway?: { pendingRemoteEvents?: { size: number } };
  agents?: Map<string, { id: string; session?: { header?: { cwd?: string } } }>;
  workspaceRegistry?: { resolveByPath(cwd: string): Promise<{ sessionIds?: string[] } | null>; create(path: string): Promise<{ id: string }> };
}
// What dsh hands a plugin.
interface PluginContext {
  inject(names: string[], fn: (c: Services) => void): void;
  effect(fn: () => () => void): void;
}

export function apply(ctx: PluginContext) {
  let sessions: Services | null = null;
  let gateway: Services | null = null;
  let agents: Services | null = null;
  let workspaces: Services | null = null;
  ctx.inject(["sessionController"], (c) => void (sessions = c));
  ctx.inject(["typertGateway"], (c) => void (gateway = c));
  ctx.inject(["agents"], (c) => void (agents = c));
  ctx.inject(["workspaceRegistry"], (c) => void (workspaces = c));
  const server = http.createServer(async (rq, rs) => {
    let body = "";
    for await (const d of rq) body += d;
    try {
      const b: { cwd?: string; id?: string; text?: string; path?: string } = body ? JSON.parse(body) : {};
      const commands = sessions?.sessionController?.commands;
      let out: object = {};
      if (rq.url === "/new") out = await commands.create({ cwd: b.cwd });
      else if (rq.url === "/prompt") {
        const rpcId = crypto.randomUUID();
        out = await commands.prompt({ sessionId: b.id, requestId: rpcId, mode: "queue", content: [{ type: "text", text: b.text }] }, { kind: "user", rpcId });
      } else if (rq.url === "/pending") out = { pending: gateway?.typertGateway?.pendingRemoteEvents?.size ?? null };
      else if (rq.url.startsWith("/has?")) {
        const a = agents?.agents?.get(new URLSearchParams(rq.url.slice(5)).get("id"));
        const cwd = a?.session?.header?.cwd ?? null;
        const w = cwd ? await workspaces?.workspaceRegistry?.resolveByPath(cwd) : null;
        out = { has: !!a, cwd, workspace: !!w?.sessionIds?.includes(a?.id) };
      } else if (rq.url === "/workspace") {
        const w = await workspaces.workspaceRegistry.create(b.path);
        out = { id: w.id };
      }
      rs.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out ?? {}));
    } catch (e) {
      rs.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: e.message }));
    }
  });
  server.listen(Number(process.env.PAGE_PORT), "127.0.0.1");
  ctx.effect(() => () => server.close());
}
