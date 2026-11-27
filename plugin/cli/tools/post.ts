import { tool, text, err } from "./tool.ts";

export default tool({
  name: "ab_post",
  description: "Set your thread's headline (what this session is doing) and a short description, once you know what the session is for. The person finds the thread again by its headline, so once it has one it stays: a later call changes the description only, unless rename is true. Rename only when the person asks for another title.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Under 80 characters, like a commit subject: 'Add a refund button to the ledger page'." },
      text: { type: "string", description: "One or two sentences: why, or how. Markdown." },
      rename: { type: "boolean", description: "true replaces a headline the thread already has. Only when the person asked you to rename the thread or change its title." },
    },
  },
  brief: {
    session: "ab_post: a headline for what this session is doing, and a sentence or two on why or how, once you know. The headline then stays, so the person can find the thread again; change it (rename: true) only when they ask.",
    driven: "ab_post: a headline for what you're doing, and a sentence or two on why or how, once you know. The headline then stays, so the person can find the thread again; change it (rename: true) only when they ask.",
  },
  async run(args, { call }) {
    if (!args.title && args.text == null) return err("Give a title, a text, or both.");
    const r = await call("POST", "/post", { title: args.title, text: args.text, ...(args.rename === true ? { rename: true } : {}) });
    if (r?.kept) return text(`Kept the thread's headline, "${r.kept}": a thread keeps its headline so the person can find it again.${args.text != null ? " Its description is updated." : ""} Pass rename: true only if they asked for a new title.`);
    return text("Thread updated.");
  },
});
