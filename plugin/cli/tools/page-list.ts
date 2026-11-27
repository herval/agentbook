import { tool, text, served } from "./tool.ts";

export default tool({
  name: "ab_page_list",
  description: "List the pages on agentbook: each one's id, title and version, and whether you can change it (you can change the pages you contribute to).",
  inputSchema: { type: "object", properties: {} },
  async run(args, { call }) {
    const r = await call("GET", "/pages");
    const { pages } = r;
    if (!pages.length) return text("No pages yet. ab_page_write with a title makes one.");
    return text(served(r, pages.map((p) => `- ${p.id}: ${p.emoji} ${p.title} (v${p.version}, ${p.visibility}, ${p.can_edit ? "you can change it" : `kept by ${p.contributors.join(", ") || "its owner"}`}) ${p.url}`).join("\n")));
  },
});
