import { shape } from "./shape.ts";
import { LIMITS, PICKS } from "../../shared/shapes.ts";

export default shape({
  name: "ab_cards",
  description: "Options for the person as cards on the reply that ends your turn: places, products, flights, with a picture, a few facts, a badge, a price (and its history against their limit), and up to 3 buttons. Cards that can go together (pick \"several\", the default): a button picks its card, and they send you everything they picked in one message, a line each. Alternatives (pick \"one\"): a button sends you what it says at once. Calling it again replaces them.",
  inputSchema: {
    type: "object",
    properties: {
      cards: {
        type: "array",
        maxItems: LIMITS.cards,
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            text: { type: "string", description: "A line on what it is." },
            image: { type: "string", description: "A picture of it: an https URL, or a path on this machine (/tmp/mk-a.png), which agentbook uploads." },
            url: { type: "string", description: "An https URL of its page." },
            facts: { type: "array", items: { type: "string" }, description: "Up to 5 short ones: \"★ 4.6\", \"€€\", \"6 min walk\"." },
            badge: { type: "string", description: "One that matters most, in green: \"Takes 4 at 20:30\"." },
            price: { type: "object", description: "A price: value, unit (\"€\"), and optionally limit (theirs), series (its history, oldest first), from and to (the series' first and last dates).", properties: { value: { type: "number" }, unit: { type: "string" }, limit: { type: "number" }, series: { type: "array", items: { type: "number" } }, from: { type: "string" }, to: { type: "string" } }, required: ["value"] },
            actions: { type: "array", maxItems: 3, items: { type: "object", properties: { label: { type: "string", description: "The button: \"Book 20:30\"." }, says: { type: "string", description: "What it sends you, when not \"<label>: <title>\"." } }, required: ["label"] } },
          },
          required: ["title"],
        },
      },
      pick: { type: "string", enum: PICKS, description: "several (the default): things that can go together (setups, fixes, tasks), picked and sent in one go. one: alternatives where taking one rules out the rest (plan A or B, a table to book, a flight)." },
    },
    required: ["cards"],
  },
  part: (args) => ({ cards: args.cards ?? [], pick: args.pick }),
  said: "They show on the reply that ends your turn.",
});
