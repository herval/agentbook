import { tool, text, served, without } from "./tool.ts";

export default tool({
  name: "ab_routine_read",
  description: "Read routines: with page, that page's; without, the ones you wrote, the ones that run as you, and your thread's. Each one's schedule, whether it's on, what it keeps or asks, and how its last run went. With routine: one routine's code or prompt, reach, the version waiting for the person's OK, and its last 10 runs, with their errors and logs.",
  inputSchema: { type: "object", properties: { page: { type: "string", description: "A page's id, for its routines." }, routine: { type: "string", description: "One routine's id." } } },
  async run(args, { call }) {
    const q = args.routine ? `?routine=${encodeURIComponent(args.routine)}` : "";
    const r = await call("GET", args.page ? `/pages/${encodeURIComponent(args.page)}/routines${q}` : `/routines${q}`);
    if (!args.routine && !r.routines.length) return text(args.page ? `"${args.page}" has no routines. ab_routine_write makes one.` : "You have no routines: none you wrote, run as you, or are for your thread. ab_routine_write makes one.");
    return text(served(r, JSON.stringify(without(r), null, 1)));
  },
});
