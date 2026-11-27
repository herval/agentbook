import { tool, text, clip } from "./tool.ts";

export default tool({
  name: "ab_todo",
  description: "Something only the person can do, outside agentbook: review a PR, sign something, rotate a key, confirm a decision that doesn't stop you. It goes on your thread, as a title (text) and a body (note), in a For you checklist there, on its card, and on the reply that ends your turn; with answers, its row has buttons, each sending what it says as their message. You keep it, ticking it off with ab_tasks done once it's done. Most hand-offs belong there (review my pull request, restart the server, sign in). Only one that outlives your thread (renew the domain by the 30th, a contract to sign next week) goes on their Tasks list, with later: true. Never for yourself, and never for a go-ahead (that's ab_ask). When one that looks the same is already there (on their Tasks, maybe from another agent, or on your thread), nothing is added: you hear which one, and link your thread to it with ab_tasks link, or send it again with new: true if it's something else.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Its title: one short line, under 80 characters. A longer one is cut at a word with a …, and the rest goes on top of its body." },
      note: { type: "string", description: "Its body: the why and the how, links, steps. Plain text (its URLs become links), up to 4000 characters." },
      new: { type: "boolean", description: "Add it even though a task on their list looks the same." },
      later: { type: "boolean", description: "Put it on their Tasks list instead of your thread: for something that outlives the thread." },
      answers: { type: "array", maxItems: 4, items: { type: "object", properties: { label: { type: "string", description: "The button, under 40 characters: \"Confirmed\", \"Mirror\", \"Keep it\"." }, says: { type: "string", description: "What pressing it sends you as their message, when not the label." } }, required: ["label"] }, description: "Up to 4 buttons on its row, for a to-do that's a decision or a yes: each sends what it says as their message." },
    },
    required: ["text"],
  },
  async run(args, { call }) {
    const r = await call("POST", "/todos", { text: args.text, note: args.note || undefined, answers: Array.isArray(args.answers) ? args.answers : undefined, new: !!args.new, later: !!args.later });
    if (r.same?.thread) return text(`Not added: your thread already has ${r.same.id} ${clip(r.same.text)} for them. If it's something else, send yours again with new: true.`);
    if (r.same) return text(`Not added: their list already has ${r.same.id} ${clip(r.same.text)}${r.same.from ? `, from ${r.same.from}` : ""}. If that's it, link your thread to it: ab_tasks link: ["${r.same.id}"]. If it's something else, send yours again with new: true.`);
    if (r.thread) return text(`On your thread for them as ${r.id}, in its For you list. Tick it off with ab_tasks done: ["${r.id}"] once it's done; they can tick it or move it to their Tasks there.`);
    return text(`Added to their tasks as ${r.id}, linked to your thread.`);
  },
});
