import { shape } from "./shape.ts";
import { LIMITS } from "../../shared/shapes.ts";

export default shape({
  name: "ab_suggest",
  description: "What the person would likely say next, 2 to 4 short replies (\"Open the PR\", \"Show me the diff\", \"Not now\"): buttons under the reply that ends your turn; a click sends one as their message. Not for a question you must have answered before going on: that's ab_ask.",
  inputSchema: {
    type: "object",
    properties: { replies: { type: "array", items: { type: "string" }, maxItems: LIMITS.replies, description: `Each under ${LIMITS.reply} characters, in their words, as they'd send it.` } },
    required: ["replies"],
  },
  part: (args) => ({ replies: args.replies ?? [] }),
  said: "They show as buttons under the reply that ends your turn.",
});
