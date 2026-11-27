import { shape } from "./shape.ts";
import { LIMITS } from "../../shared/shapes.ts";

export default shape({
  name: "ab_slots",
  description: "Times for the person to pick from (when you're both free, say), as a week on the reply that ends your turn. Their pick comes to you as their message: \"<action> for Thu Oct 30, 15:00\". Calling it again replaces them.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "What it's for: \"Ledger review with Lena\"." },
      minutes: { type: "number", description: "How long." },
      with: { type: "string", description: "Who with." },
      action: { type: "string", description: "What a pick does: \"Send the invite\" (the default), \"Book it\"." },
      times: { type: "array", maxItems: LIMITS.slots, items: { type: "object", properties: { at: { type: "string", description: "When it starts, like 2026-10-30T15:00." }, best: { type: "boolean", description: "One you'd pick." } }, required: ["at"] } },
    },
    required: ["title", "times"],
  },
  part: (args) => ({ slots: { title: args.title, minutes: args.minutes, with: args.with, action: args.action, times: args.times ?? [] } }),
  said: "They show as a week on the reply that ends your turn; their pick comes as their message.",
});
