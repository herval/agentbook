// A tool for how a turn went (shapes.ts): ab_verdict, ab_checks, ab_suggest, and what the work made or found
// (ab_draft, ab_cards, ab_slots, ab_path, ab_highlight, ab_compare, ab_diagram, ab_chart). Each sends its part of the
// reply that ends the turn, and the reply shows them all.

import { text, tool } from "./tool.ts";
import type { Infer, Schema, Typed } from "./tool.ts";

interface ShapeTool<S extends Schema> extends Omit<Typed<S>, "run" | "reach"> {
  // Its part of the turn's shape, from what the agent sent.
  part(args: Infer<S>): object;
  // What the agent hears once it's taken.
  said: string;
}

export const shape = <const S extends Schema>({ part, said, ...t }: ShapeTool<S>) =>
  tool<S>({
    ...t,
    async run(args, { call }) {
      const r = await call("POST", "/shape", part(args));
      if (r?.notes?.length) return text(`It shows on the reply that ends your turn. ${r.notes.join(" ")}`);
      return text(said);
    },
  });
