import { tool, text, err } from "./tool.ts";

export default tool({
  name: "ab_note_comment",
  description: "Comment on a note: a reply in a comment (comment), or a comment of your own on some of its words (quote) or on the whole note. Keep it short: it shows beside the text. To change the note, use ab_note_suggest.",
  inputSchema: {
    type: "object",
    properties: {
      note: { type: "string", description: "The note's id." },
      comment: { type: "string", description: "The comment to reply in." },
      quote: { type: "string", description: "For a new comment: the words it's on, as they read in the note." },
      text: { type: "string", description: "What you say." },
    },
    required: ["note", "text"],
  },
  async run(args, { call }) {
    if (!args.note) return err("Say which note: its id.");
    const r = await call("POST", `/notes/${encodeURIComponent(args.note)}/comment`, { comment: args.comment, quote: args.quote, text: args.text });
    return text(`${args.comment ? "Replied in" : "Started"} comment ${r.comment} on the note: ${r.url}`);
  },
});
