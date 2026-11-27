import { tool, text } from "./tool.ts";
import { api } from "../../lib/common.ts";

export default tool({
  name: "ab_show",
  description: "Read agentbook as text: what's waiting on the person, every running session (so you don't duplicate another's work), and your own thread.",
  inputSchema: { type: "object", properties: {} },
  brief: {
    session: null,
    driven: "ab_show: what's waiting on the person, and the other threads running, so you don't duplicate their work.",
  },
  async run(args, { who }) {
    return text(await api("GET", `/api/show?proc=${encodeURIComponent(who.proc)}`));
  },
});
