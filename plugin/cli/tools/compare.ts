import { shape } from "./shape.ts";
import { COMPARES, FRAMES, LIMITS } from "../../shared/shapes.ts";

export default shape({
  name: "ab_compare",
  description: "Pictures with a job, or numbers that moved, on the reply that ends your turn, instead of a row of thumbnails. kind before_after: two pictures (before, then after) in one frame with a handle the person drags across. options: 2 to 4 pictures side by side (mockups, designs), each with its label and a line, yours marked with pick; a click sends you \"Go with <label>\" (or its says). sizes: the same screen on a desktop and a phone (frame: desktop or phone, the first a desktop's unless it says). numbers: what moved, from and to, colored by whether that's better. A picture is a path on this machine (a screenshot you took: /tmp/after.png), which agentbook uploads, or an https URL. Calling it again replaces it.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: COMPARES },
      title: { type: "string", description: "What it compares: \"The feed card, before and after\"." },
      pictures: {
        type: "array",
        maxItems: 4,
        items: { type: "object", properties: { picture: { type: "string", description: "A path on this machine, or an https URL, of a PNG, JPEG, GIF or WebP." }, label: { type: "string", description: "\"Before\", \"A. Cover\", \"Phone\"." }, text: { type: "string", description: "A line on it." }, pick: { type: "boolean", description: "options: the one you'd go with." }, frame: { type: "string", enum: FRAMES, description: "sizes: which frame it's in." }, says: { type: "string", description: "options: what picking it sends you, when not \"Go with <label>\"." } }, required: ["picture"] },
      },
      numbers: {
        type: "array",
        maxItems: LIMITS.numbers,
        items: { type: "object", properties: { label: { type: "string", description: "\"p95 latency\"." }, from: { type: "number" }, to: { type: "number" }, unit: { type: "string", description: "\"ms\", \"%\", \"€\"." }, better: { type: "string", enum: ["up", "down"], description: "Which way is better." } }, required: ["label", "from", "to"] },
      },
      action: { type: "string", description: "options: the button's word, \"Pick\" by default." },
    },
    required: ["kind"],
  },
  part: (args) => ({ compare: { kind: args.kind, title: args.title, pictures: args.pictures, numbers: args.numbers, action: args.action } }),
  said: "They show on the reply that ends your turn.",
});
