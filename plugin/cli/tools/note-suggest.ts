import { tool, text, err } from "./tool.ts";

export default tool({
  name: "ab_note_suggest",
  description: "Suggest an edit to a note: these words, replaced by those. It shows in the note in your color, struck out and written in, and the person accepts or rejects it. find is the note's words exactly as written (markdown and all, from ab_note_read), on one line, the first place they are; replace is what goes in their place (empty to take them out; it can be several lines). When they @'d you in the text, find is that line, @ and all, and replace is what goes there. Suggest one edit per passage, not the whole note.",
  inputSchema: {
    type: "object",
    properties: {
      note: { type: "string", description: "The note's id." },
      find: { type: "string", description: "The words to replace, exactly as the note has them." },
      replace: { type: "string", description: "What goes in their place." },
      comment: { type: "string", description: "The comment it answers (you were asked in). Leave it out and it starts a comment of its own on those words." },
      why: { type: "string", description: "A short line on what it changes and why, shown with it." },
    },
    required: ["note", "find", "replace"],
  },
  async run(args, { call }) {
    if (!args.note) return err("Say which note: its id.");
    const r = await call("POST", `/notes/${encodeURIComponent(args.note)}/suggest`, { find: args.find, replace: args.replace, comment: args.comment, why: args.why });
    return text(`Suggested it (${r.suggestion}, in comment ${r.comment}). The person accepts or rejects it on the note: ${r.url}`);
  },
});
