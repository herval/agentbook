import { shape } from "./shape.ts";
import { LIMITS } from "../../shared/shapes.ts";

export default shape({
  name: "ab_path",
  description: "The path this turn took, on the reply that ends it: its stages in order, the dead ends too (what you tried and dropped, and why), with the minutes each took, so the person sees what you explored without reading your steps. Calling it again replaces it.",
  inputSchema: {
    type: "object",
    properties: {
      stages: {
        type: "array",
        maxItems: LIMITS.stages,
        items: { type: "object", properties: { text: { type: "string", description: "What you did: \"Batched the lookup: one call per cart\"." }, minutes: { type: "number" }, dead: { type: "string", description: "For a dead end, why you dropped it: \"rates go stale at month end\"." } }, required: ["text"] },
      },
    },
    required: ["stages"],
  },
  part: (args) => ({ stages: args.stages ?? [] }),
  said: "It shows on the reply that ends your turn.",
});
