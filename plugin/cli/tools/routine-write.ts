import { tool, text, err } from "./tool.ts";
import { pathOn } from "./disk.ts";

export default tool({
  name: "ab_routine_write",
  description: `Make or change a routine: something agentbook runs on a schedule, which the person sees and controls on agentbook (Routines). Two kinds:
- kind "code" (the default): a small JavaScript module agentbook runs with no model. For a page, what it returns is written to the widgets it keeps, as a version: use it for what a program can fetch (numbers, series, tables, statuses). Without a page, it returns a line (summary), posted to the thread it continues, if any.
- kind "agent": a prompt an agent runs (you, unless agent says), each run a new thread in its folder (or, with page, started from the page so it can ab_page_write; or, with thread, a message to that thread, which resumes it if it ended). Use it for what needs judgment, or when the person asks for something done on a schedule ("every weekday at 9, summarize…"). It runs at most hourly. Never launchd, cron, or a script that starts sessions.
The person OKs every new routine and every change to its code and reach, or its prompt, agent, folder and model, before it runs; the version they OK'd keeps running until then. So test with test: true (it runs code once, or shows an agent routine's prompt as it would be sent; it saves nothing and needs no OK) until it's right, then save once.
When the person asks you to remove a routine you wrote: routine and remove: true (it's archived, and routine and restore: true puts it back).
A code module: export default async function (ctx) { ...; return { widgets: [{ id, data }], summary? } }
- ctx.tool(server, tool, args): an MCP tool on a server in Claude Code's config on this machine (HTTP servers), named in reach.tools as "server/tool", e.g. "acme-litellm/acme_eng-dd_span_stats" (the server's own tool name, not mcp__…). Returns { text, data }: data is the answer read as JSON, or as TOON. Throws when the tool fails.
- ctx.sh(command, args, { timeout }): a command named in reach.commands, run with no shell: { stdout, stderr, code }.
- A live routine (schedule 'live 30s') gets what's picked on its page: ctx.filters ({ service: 'erp-sync', when: '7d' }), ctx.ranges (a time filter's period as dates: { when: { from, to } }) and ctx.params (what an html widget it keeps asked with, agentbook.query(params)); ctx.live is true. Query for exactly that, so a filter fetches what isn't on the page. Keep a scheduled routine too for what needs history or alerts.
- ctx.page: the page's widgets by id ({ id, type, title, data }), to keep text you don't write. ctx.memo: an object kept between runs that worked (64 KB). ctx.last: { at, ok }. ctx.now (a Date), ctx.tz. ctx.log() and console.log go to the run's log.
- It can't read or write files or run commands itself. fetch() works, for public URLs: it holds no credentials.
- For a page, it returns only widgets it keeps (keeps: their ids), shaped as ab_page_write's; data merges key by key. Writing any other widget fails the run. Two routines can't keep the same widget.
- Fetch the whole window each run (the last 24 hours, the last 7 days) rather than appending to what's there, so a missed run fixes itself.
- Use read-only tools. Say in cant_keep which widgets code can't keep, and what tool would let it.`,
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["code", "agent"], description: "code (the default): a module with no model. agent: a prompt an agent runs." },
      page: { type: "string", description: "A page it's linked to, from ab_page_list (you must contribute to it): a code routine keeps its widgets; an agent routine's runs start from it. More pages go in links." },
      thread: { type: "string", description: "The thread its runs continue: \"this\" for yours. Each agent run is a message to it; a code run's line is posted there. Leave it out for a new thread each run." },
      links: { type: "array", description: "What else it's linked to: [{ kind: 'page' | 'thread' | 'agent', id }]. Each shows it, and each run is told about them. 'this' is your thread.", items: { type: "object", properties: { kind: { type: "string", enum: ["page", "thread", "agent"] }, id: { type: "string" } } } },
      routine: { type: "string", description: "The routine's id, to change one (ab_routine_read lists them). Leave it out to make one; the same name in the same place changes that one." },
      name: { type: "string", description: "A short name, like 'Numbers' or 'Morning digest'." },
      about: { type: "string", description: "What it does, in a sentence the person reads." },
      schedule: { type: "string", description: "When it runs: how often ('30m', '1h', '1d'), a cron in this machine's time ('0 9 * * 1-5' for weekdays at 9), 'manual' (only when it's run), or 'live 30s': code for a page that runs while the page is open (when it's opened, every 30 s while it stays open, and when its filters change), what it returns going to the screen, not into a version. Code: at most once a minute (live: every 10 s); agent: at most hourly." },
      prompt: { type: "string", description: "An agent routine's prompt: what its agent does each run. Write it for an agent that starts fresh, with nobody watching." },
      agent: { type: "string", description: "An agent routine's agent, by id: you by default." },
      folder: { type: "string", description: "An agent routine's folder: yours by default (a page's: where its threads work)." },
      model: { type: "string", description: "An agent routine's model, when it isn't the agent's default." },
      keeps: { type: "array", items: { type: "string" }, description: "A page's code routine: the ids of the widgets it writes." },
      reach: { type: "object", description: "A code routine: what it may call: { tools: ['server/tool', ...], commands: ['gh', ...] }.", properties: { tools: { type: "array", items: { type: "string" } }, commands: { type: "array", items: { type: "string" } } } },
      code: { type: "string", description: "A code routine: the module's source." },
      file: { type: "string", description: "Or a path to the module, in your folder." },
      cant_keep: { type: "string", description: "Widgets on the page code can't keep, and why: 'The error widgets: no tool counts error spans'." },
      summary: { type: "string", description: "What this version changes, for the person's OK: 'Reads the HPA from k8s_deployments'." },
      timeout: { type: "number", description: "A code routine: seconds a run may take (60 by default, at most 300)." },
      test: { type: "boolean", description: "Try it, saving nothing: code runs once and says what it would write; an agent routine shows its prompt as it would be sent." },
      remove: { type: "boolean", description: "With routine: take it off, only when the person asks you to, and only one you wrote. It's archived: it stops running and leaves the lists, a code routine's widgets stay as they are, and restore brings it back as it was." },
      restore: { type: "boolean", description: "With routine: put back one that was removed (archived), when the person asks: as it was, its schedule, the version it ran and its runs." },
    },
  },
  brief: "ab_routine_write with kind \"agent\": something the person asks to have done on a schedule (every weekday at 9, every few hours), by itself, for a page, or for your thread. agentbook runs it, and they see and OK it there.",
  async run(args, { call, disk, where: folder }) {
    if ((args.remove || args.restore) && !args.routine) return err(`Say which routine to ${args.restore ? "restore" : "remove"}: its id (ab_routine_read lists them).`);
    // Its code from a file: read on the machine the agent works on (a Claude Agent's sandbox, an OpenClaw gateway).
    const { file, ...sent } = args;
    const body: typeof sent & { code?: string } = sent;
    if (body.code == null && file) {
      const p = pathOn(disk, folder, file);
      if (!(await disk.stat(p))) return err(`No file at ${p}`);
      body.code = (await disk.read(p)).toString("utf8");
    }
    const r = await call("POST", args.page ? `/pages/${encodeURIComponent(args.page)}/routines` : "/routines", body, { timeout: 330e3 });
    if (r.removed) {
      const kept = r.kind === "code" && r.page && r.keeps.length ? ` The widgets it kept (${r.keeps.join(", ")}) stay as they are, no longer kept up to date.` : "";
      return text(`Removed "${r.name}" (routine "${r.removed}")${r.page ? ` from "${r.page}"` : ""}: it's archived, so it won't run, and it's under Archived on Routines.${kept} To put it back: routine "${r.removed}" and restore: true, or Restore on ${r.url}`);
    }
    if (r.restored) return text(`Restored "${r.name}" (routine "${r.restored}")${r.page ? ` on "${r.page}"` : ""}, as it was: ${r.every}, v${r.live_v}${r.on ? "" : ", paused"}${r.next ? `, next run ${r.next}` : ""}.\n${r.url}`);
    // A save answers with the test it ran for the OK too: only a test's answer has no id.
    if (!r.id && r.test?.agent_test) {
      const t = r.test;
      return text(`Test (nothing saved): ${t.runs_as || "you"} would run this ${t.when}${t.root ? `, in ${t.root}` : ""}${t.per_day >= 1 ? `, about ${Math.round(t.per_day)} times a day` : ""}. Each run gets:\n\n${t.prompt}`);
    }
    if (!r.id && r.test) {
      const t = r.test;
      const changes = (t.changes || []).filter((c) => c.id).map((c) => `- ${c.w}${c.from != null && c.to != null ? `: ${c.from} → ${c.to}` : c.text ? `: ${c.text}` : ""}`);
      const head = t.ok ? `Test run (nothing saved): it worked in ${t.ms < 1000 ? `${t.ms} ms` : `${(t.ms / 1000).toFixed(1)} s`}.${changes.length ? ` It would change:\n${changes.join("\n")}` : args.page ? " It would change nothing on the page as it is." : ""}` : `Test run (nothing saved): it failed after ${t.ms < 1000 ? `${t.ms} ms` : `${(t.ms / 1000).toFixed(1)} s`}.\n${t.error}`;
      const extra = [t.summary ? `Summary: ${t.summary}` : "", t.ask ? `Ask: ${t.ask}` : "", t.log ? `Log:\n${t.log}` : "", t.widgets?.length ? `Widgets it returned:\n${JSON.stringify(t.widgets).slice(0, 20000)}` : ""].filter(Boolean);
      return text([head, `Reach: ${r.reach}.`, ...extra].join("\n\n"));
    }
    const where = r.page ? ` on "${r.page}"` : r.thread ? " for its thread" : "";
    const waits = r.waiting ? `v${r.waiting} waits for the person's OK, asked on your thread and on agentbook${r.live_v ? `; v${r.live_v} keeps running until then` : ""}. ${r.test_words || ""}` : `It runs v${r.live_v}${r.live_v ? "" : " (nothing OK'd yet)"}.`;
    const what = r.kind === "agent" ? `Runs as ${r.runs_as || "you"}.` : `Reach: ${r.reach}.`;
    return text(`Saved "${r.name}" (routine "${r.id}")${where}, ${r.every}. ${waits}\n${what}\n${r.url}`);
  },
});
