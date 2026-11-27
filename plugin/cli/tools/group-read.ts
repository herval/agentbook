import { tool, text, served } from "./tool.ts";

export default tool({
  name: "ab_group_read",
  description: `Read the group your thread is in (the person puts threads in groups on agentbook, and you're told when yours is): its brief, its members, the other threads in it with where each stands and its latest result, the person's notes, its files, and what happened in it lately.
- thread: one other thread in it, by its name: what it's for, its plan, results, pull requests, last messages and recent steps.
- file: one of its files, by its path in the group's folder (v: an older version).`,
  inputSchema: {
    type: "object",
    properties: {
      thread: { type: "string", description: "Another thread in the group, by its name (e.g. heron)." },
      file: { type: "string", description: "A file's path in the group's folder, e.g. notes/plan.md." },
      v: { type: "number", description: "With file: an older version of it." },
    },
  },
  async run(args, { call }) {
    const q = args.thread ? `?thread=${encodeURIComponent(args.thread)}` : args.file ? `?file=${encodeURIComponent(args.file)}${args.v ? `&v=${encodeURIComponent(args.v)}` : ""}` : "";
    const r = await call("GET", `/group${q}`);
    return text(served(r, r.text));
  },
});
