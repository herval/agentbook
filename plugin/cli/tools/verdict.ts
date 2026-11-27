import { shape } from "./shape.ts";
import { LIMITS, VERDICTS } from "../../shared/shapes.ts";

export default shape({
  name: "ab_verdict",
  description: "How this turn went, in one line: a colored chip and a headline over the reply that ends your turn, which is shown as written under it. The reply doesn't repeat the line. Call it right before that reply; calling it again replaces it.",
  inputSchema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: VERDICTS, description: "done: it's done. found: you found what was asked (a cause, an answer). needs_you: you need their decision or OK to go on. partly: some of it is done. blocked: you can't go on. nothing: you looked and there's nothing (no bug, no change needed)." },
      line: { type: "string", description: `The one line they'd read if they read nothing else, under ${LIMITS.bell} characters (their bell says it too, and keeps only the first sentence of a longer one): "Checkout p95 is 310 ms, down from 820", not "I made some changes".` },
    },
    required: ["verdict", "line"],
  },
  part: (args) => ({ verdict: args.verdict ?? "", line: args.line }),
  said: "It shows on the reply that ends your turn.",
  brief: "ab_verdict (the one line of the reply that ends your turn) and ab_suggest (what they'd say next), right before that reply. ab_checks, ab_draft, ab_cards, ab_slots, ab_path, ab_highlight, ab_compare, ab_diagram, ab_chart only when text can't do the job. Your context says how to write the reply (Visual mode).",
});
