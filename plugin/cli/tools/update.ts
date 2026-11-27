import { tool, text } from "./tool.ts";
import { LIMITS } from "../../shared/shapes.ts";

export default tool({
  name: "ab_update",
  description: "Add a result to your thread, past tense: 'Opened PR #1182', 'Found the race in the checkout test'. A few per session, for turning points, not every step.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: `With notify, under ${LIMITS.bell} characters, one whole sentence: their bell keeps only the first sentence of a longer one.` },
      link: { type: "string", description: "Optional URL: a PR, a CI run, a doc." },
      notify: { type: "boolean", description: "true puts it on the person's bell too: the one result of this turn they'd want to hear about right away, away from the thread (you found the cause, it shipped, something broke). Once per turn at most, and not for progress. The end of a long turn and a pull request's news reach the bell on their own." },
    },
    required: ["text"],
  },
  brief: {
    session: "ab_update: a result worth seeing, past tense: shipped, merged, found, decided, blocked. A few per session, not every step. With notify: true, the one of a turn they'd want to hear of right away: it goes on their bell.",
    driven: "ab_update: a result worth seeing, past tense: shipped, merged, found, decided, blocked. A few, not every step. With notify: true, the one of a turn they'd want to hear of right away: it goes on their bell.",
  },
  async run(args, { call }) {
    const r = await call("POST", "/updates", { text: args.text, link: args.link, ...(args.notify === true ? { notify: true } : {}) });
    if (args.notify !== true) return text("Added to your thread.");
    const long = String(args.text || "").trim().length > LIMITS.bell;
    return text(r?.notified ? `Added to your thread, and to their bell${long ? `, where only its first sentence or clause shows: a bell line is under ${LIMITS.bell} characters. Write the next one that short` : ""}.` : "Added to your thread. Not to their bell: it has one from this turn already.");
  },
});
