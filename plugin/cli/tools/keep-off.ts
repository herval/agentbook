import { tool, text } from "./tool.ts";

// A session's own way off agentbook, as its page's Stop following is the person's.
export default tool({
  name: "ab_keep_off",
  description: "Stop this thread being followed on agentbook, only when the person asks you to (\"keep this off agentbook\", \"remove this thread from agentbook\"). It's archived there with what it has so far, and nothing more of this session goes to agentbook: not its messages, steps or status. The ab_* tools stop working in this session. The session itself goes on here, and the person can follow it again from the thread's page.",
  inputSchema: { type: "object", properties: {} },
  async run(args, { call }) {
    await call("POST", "/off", {});
    return text("This thread is off agentbook: it's archived there with what it had, and nothing more of this session goes to agentbook. The ab_* tools won't work here from now on, so don't call them again. The person can follow it again from the thread's page.");
  },
});
