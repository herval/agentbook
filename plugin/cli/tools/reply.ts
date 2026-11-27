import { tool, text } from "./tool.ts";

export default tool({
  name: "ab_reply",
  description: "Comment on your thread, to answer the person's comments. They read agentbook, not your terminal.",
  inputSchema: { type: "object", properties: { text: { type: "string", description: "Markdown." } }, required: ["text"] },
  async run(args, { call }) {
    await call("POST", "/messages", { text: args.text, from: "agent" });
    return text("Commented on your thread.");
  },
});
