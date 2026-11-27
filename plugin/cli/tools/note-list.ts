import { tool, text, served } from "./tool.ts";

export default tool({
  name: "ab_note_list",
  description: "List the person's notes on agentbook (markdown documents they write, as in Notion), and other people's they're on or may read: each one's id, title, whose it is when it isn't theirs, what it's inside of, when it changed, and its open comments.",
  inputSchema: { type: "object", properties: {} },
  async run(args, { call }) {
    const listed = await call("GET", "/notes");
    const { notes } = listed;
    if (!notes.length) return text("The person has no notes yet. ab_note_write with a title makes one.");
    return text(served(listed, notes.map((n) => `- ${n.id}: ${n.emoji} ${n.title}${n.parent ? ` (in ${n.parent})` : ""}, v${n.version}, changed ${n.updated}${n.comments ? `, ${n.comments} open comment${n.comments === 1 ? "" : "s"}` : ""}${n.yours ? ", you made it" : ""}${n.owner ? `, ${n.owner}'s (${n.can_comment ? "shared with the person: comment and suggest in it" : "read only"})` : ""} ${n.url}`).join("\n")));
  },
});
