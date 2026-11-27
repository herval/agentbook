import { shape } from "./shape.ts";
import { NODE_STATES } from "../../shared/widgets.ts";

export default shape({
  name: "ab_diagram",
  description: "A diagram on the reply that ends your turn: boxes and arrows, which agentbook lays out in columns, left to right along the arrows. For how something works, a cause chain (what broke, and what that broke), a pipeline: the picture you'd draw on a whiteboard, instead of a paragraph explaining it. Up to 30 boxes. Calling it again replaces it. To keep one in view on your thread, ab_attach it; on a page, it's the diagram widget.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      nodes: {
        type: "array",
        maxItems: 30,
        items: { type: "object", properties: { id: { type: "string", description: "What edges call it; its title when it has none." }, title: { type: "string", description: "A few words: \"erp-sync worker\"." }, text: { type: "string", description: "A line under it: \"retries every 30 s\"." }, state: { type: "string", enum: NODE_STATES, description: "on lights it (where it broke, what matters), done ticks it, failed marks it red, off greys it." } }, required: ["title"] },
      },
      edges: { type: "array", maxItems: 60, items: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, label: { type: "string" } }, required: ["from", "to"] } },
    },
    required: ["nodes"],
  },
  part: (args) => ({ diagram: { title: args.title, nodes: args.nodes ?? [], edges: args.edges ?? [] } }),
  said: "They show on the reply that ends your turn.",
});
