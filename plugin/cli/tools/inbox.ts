import { tool, text, clip } from "./tool.ts";
import { describe } from "../../lib/common.ts";

export default tool({
  name: "ab_inbox",
  description: "Fetch what the person did on agentbook for you that you haven't seen yet: answers, comments, files.",
  inputSchema: { type: "object", properties: {} },
  async run(args, { call }) {
    const { events, open = [] } = await call("GET", "/events?ack=1&news=1&open=1");
    const lines = events.filter((e) => e.event.type !== "permission").map((e) => `- ${describe(e.event)}`);
    // Its questions still waiting on the person, so it doesn't take "nothing new" as leave to answer them itself.
    const waiting = open.length ? `\nStill open in their Needs you: ${open.map((q) => `${q.id} ${clip(q.title)}`).join(", ")}. Don't build what ${open.length > 1 ? "they decide" : "it decides"}, not even on your default; once only that's left, end your turn, and the answer starts your next one.` : "";
    return text(`${lines.length ? lines.join("\n") : "Nothing new from agentbook."}${waiting}`);
  },
});
