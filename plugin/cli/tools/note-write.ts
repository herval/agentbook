import { tool, text } from "./tool.ts";

export default tool({
  name: "ab_note_write",
  description: "Make a note for the person (markdown: # headings, - lists, - [ ] to-dos, > quotes, ``` code), or write a new text for a note you made. A note the person wrote is theirs: you can't write it, so suggest edits with ab_note_suggest. Every write is a version they can see.",
  inputSchema: {
    type: "object",
    properties: {
      note: { type: "string", description: "The note's id, to write a note you made. Leave it out to make one." },
      title: { type: "string", description: "Its title. Required to make one." },
      text: { type: "string", description: "Its whole markdown." },
      emoji: { type: "string", description: "One emoji for it." },
      parent: { type: "string", description: "The id of a note to put it inside of." },
    },
  },
  async run(args, { call }) {
    const r = await call("POST", "/notes", { note: args.note, title: args.title, text: args.text, emoji: args.emoji, parent: args.parent }, { timeout: 15000 });
    return text(r.created ? `Made the note "${r.id}": ${r.url}` : `${r.changed ? `Saved v${r.version}` : `Nothing changed, so it's still v${r.version}`} of "${r.id}": ${r.url}`);
  },
});
