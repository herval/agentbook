import { shape } from "./shape.ts";
import { LIMITS } from "../../shared/shapes.ts";

export default shape({
  name: "ab_highlight",
  description: "What matters, marked where it is. Without source: sentences or phrases of the reply that ends your turn, word for word, marked there. With source (a file path or an https URL you read): passages of it as excerpts on your reply, each with what to mark in it, where it is (\"p. 4, §7.2\") and a note on why it matters. One agentbook can't find isn't shown. Calling it again replaces them.",
  inputSchema: {
    type: "object",
    properties: {
      source: { type: "string", description: "Optional: the file or https URL the passages are from." },
      title: { type: "string", description: "With source: what it is (\"Ledgerly renewal 2026.pdf\")." },
      items: {
        type: "array",
        maxItems: LIMITS.items,
        items: { type: "object", properties: { text: { type: "string", description: "Word for word: a sentence of your reply, or with source, the passage." }, mark: { type: "string", description: "With source: the words in the passage to mark." }, where: { type: "string" }, label: { type: "string", description: "With source: a word on it, \"Changed\", \"New\"." }, note: { type: "string", description: "Why it matters." } }, required: ["text"] },
      },
    },
    required: ["items"],
  },
  part: (args) => ({ items: args.items ?? [], source: args.source, title: args.title }),
  said: "They show on the reply that ends your turn.",
});
