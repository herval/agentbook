import { shape } from "./shape.ts";
import { CHECKS, LIMITS } from "../../shared/shapes.ts";

export default shape({
  name: "ab_checks",
  description: "Only when a check you ran failed, or something that could still be broken went unchecked and your reply doesn't say so. On the reply that ends your turn: what failed in red, what you didn't check as one grey line that opens. Not what you didn't do (\"Push\": your line says that), not what only they can do (that's ab_todo), not the environment you work in (a signed-out browser), not what passed. When you could check it yourself if asked, give the row a do: the message that would have you do it, drawn as its button. Most turns need none. Calling it again replaces the list.",
  inputSchema: {
    type: "object",
    properties: {
      checks: {
        type: "array",
        maxItems: LIMITS.checks,
        items: {
          type: "object",
          properties: {
            status: { type: "string", enum: CHECKS },
            label: { type: "string", description: `A few words: "Phone width", "A real gateway", "sleep.ts". Under ${LIMITS.label} characters.` },
            detail: { type: "string", description: "Optional: why, and what it would take or whether it matters: \"Chrome isn't signed in to 4310; a reload shows it\", \"Fails the same on main\"." },
            do: { type: "string", description: `Optional: what they'd send to have you check it (\"Check it on real iOS Safari\"), under ${LIMITS.do} characters: a button on the row.` },
          },
          required: ["status", "label"],
        },
      },
    },
    required: ["checks"],
  },
  part: (args) => ({ checks: args.checks ?? [] }),
  said: "They show on the reply that ends your turn.",
});
