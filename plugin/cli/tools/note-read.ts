import { tool, text, err, served } from "./tool.ts";

export default tool({
  name: "ab_note_read",
  description: "Read a note: its markdown, with the edits suggested and not yet accepted shown as CriticMarkup ({~~old~>new~~}), then its open comments: the words each is on, and what was said, with their ids.",
  inputSchema: { type: "object", properties: { note: { type: "string", description: "The note's id, from ab_note_list or the comment you were asked in." } }, required: ["note"] },
  async run(args, { call }) {
    if (!args.note) return err("Say which note: its id, from ab_note_list.");
    const n = await call("GET", `/notes/${encodeURIComponent(args.note)}`);
    const comments = n.comments.map((c) => [`- comment ${c.id}, ${c.spot ? `at the line: ${c.spot}` : c.quote ? `on "${c.quote}"` : "on the whole note"}:`, ...c.messages.map((m) => `  ${m.who}: ${m.text}`), ...c.suggestions.map((x) => `  (suggestion ${x.id}, ${x.state}: "${x.find}" -> "${x.replace}")`)].join("\n"));
    return text(served(n, `# ${n.emoji} ${n.title}\nnote ${n.id}, v${n.version}${n.parent ? `, inside ${n.parent}` : ""}, ${n.yours ? "you made it, so you can write it" : `${n.person}'s: suggest edits, don't write it`}. ${n.url}\n\n${n.text}\n\n${comments.length ? `Open comments:\n${comments.join("\n")}` : "No open comments."}`));
  },
});
