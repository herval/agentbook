import { tool, text, isDriven } from "./tool.ts";
import type { Call, Who } from "./tool.ts";
import { api } from "../../lib/common.ts";
import { capsOf, runtimeOfProc } from "../../shared/runtimes.ts";

// Questions an ab_ask call is waiting on: it returns their answer itself, so agentbook doesn't also deliver it.
const awaiting = new Set<string>();
// Whether an ab_ask call is waiting on this question, and so returns its answer itself.
export const awaited = (qid: string) => awaiting.has(qid);
// How long ab_ask waits for the answer when the agent doesn't say: as long as its runtime holds a tool call (its
// caps.askWait). Claude Code's bridge holds one 330 s (plugin/mcp) and OpenClaw's plugin 360 s; Codex gives up on one
// after 60 s, and Hermes and dsh may sooner, so theirs returns at once and the answer comes as their next message. A
// thread still starting (`launch:`) doesn't wait.
const waitByDefault = (who: Who) => (isDriven(who.proc) && !runtimeOfProc(who.proc) ? 0 : capsOf(runtimeOfProc(who.proc) || "claude-code").askWait);
// What an agent hears while its question is open: the question holds the work it decides. Told only to "keep
// working on something else", agents built what they'd asked about on their default while it waited in Needs you,
// and the answer came after it was done, when it no longer mattered. A default applies only at its deadline (the
// daemon answers with it then), never sooner.
function holding({ driven, defaulted, until }) {
  const later = defaulted && until ? ` If nobody answers by ${until}, you'll hear that the default applies.` : defaulted ? " Its default has no deadline (until), so it never applies: it waits for their answer." : "";
  return `Until it's answered, don't build what it decides, not even on your default. Do only what doesn't depend on it, then end your turn: the answer ${driven ? "comes as your next message" : "starts your next turn"}.${later}`;
}

async function ackAnswer(qid: string, call: Call) {
  try {
    const { events } = await call("GET", "/events");
    const oids = events.filter((e) => e.event.question_id === qid).map((e) => e.oid);
    if (oids.length) await call("POST", "/ack", { oids });
  } catch {}
}

export default tool({
  name: "ab_ask",
  description: "Ask the person something on agentbook: pick an option, approve or reject an action, answer in words, or send a file. It waits for the answer a while (wait_seconds), then returns the question id with it still open in their Needs you. A question holds the work it decides: until it's answered, don't build that, not even on your default. Do only what doesn't depend on it, then end your turn; the answer starts your next one.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "One question, plainly worded." },
      kind: { type: "string", enum: ["choice", "approve", "text", "file"], description: "choice: pick from options. approve: yes/no on an action. text: answer in words. file: ask them to send a file. Defaults to choice when options are given, else text." },
      options: { type: "array", items: { type: "string" }, description: "For choice: 2 to 5 options, each 'Label' or 'Label|short trade-off'. For approve: optional custom labels, e.g. ['Merge it', 'Not yet']." },
      detail: { type: "string", description: "One or two sentences of context." },
      preview: { type: "string", description: "Exact text shown verbatim, e.g. the command, the message to send, the amount." },
      default: { type: "string", description: "What you'll do if nobody answers by 'until'. It isn't an answer: it applies only once 'until' passes, and agentbook tells you when it does; without 'until', never. Never default on spending money, sending messages, or deleting anything." },
      until: { type: "string", description: "Deadline for the default: 'HH:MM' local time or an ISO timestamp." },
      key: { type: "string", description: "Stable id. Asking again with the same key replaces the open question." },
      wait_seconds: { type: "number", description: "Wait up to this many seconds (max 300) for the answer before returning. Left out, as long as your runtime holds a call (300 in Claude Code and OpenClaw), else 0. Pass 0 when you have work that doesn't depend on the answer to do first." },
    },
    required: ["question"],
  },
  brief: {
    session: "ab_ask: when you need a decision, approval, answer or file and the person may not be watching the terminal. Prefer it over stopping to ask. It waits a few minutes for the answer; until it's answered, don't build what it decides, not even on your default: do only what doesn't depend on it, then end your turn, and the answer starts your next one.",
    driven: "ab_ask: when you need a decision, approval, answer or file. Prefer it over stopping to ask. Until it's answered, don't build what it decides, not even on your default: do only what doesn't depend on it, then end your turn. The answer arrives as your next message.",
  },
  async run(args, { who, call, driven }) {
    const options = Array.isArray(args.options) ? args.options : [];
    const kind = args.kind || (options.length ? "choice" : "text");
    const { id } = await call("POST", "/questions", { title: args.question, kind, options, detail: args.detail, preview: args.preview, default: args.default, until: args.until, key: args.key });
    // Some agents send it as a string, an empty one for none.
    const sent: unknown = args.wait_seconds;
    const asked = sent == null || sent === "" ? waitByDefault(who) : Number(sent) || 0;
    const wait = Math.min(Math.max(asked, 0), 300);
    const open = holding({ driven, defaulted: args.default != null && args.default !== "", until: args.until });
    if (!wait) return text(`Asked (question ${id}): it's in their Needs you. ${open}`);
    awaiting.add(id);
    try {
      const end = Date.now() + wait * 1000;
      while (Date.now() < end) {
        const q = await api("GET", `/api/questions/${id}`);
        if (q.answered) {
          await ackAnswer(id, call);
          if (q.by === "gone" || q.by === "replaced") return text(`Question ${id} was closed without an answer.`);
          if (q.by === "skipped") return text("The person skipped the question. Decide yourself if it's safe to, or carry on without it.");
          if (q.by === "archived") return text("The person archived this thread, which closed the question unanswered. Decide yourself if it's safe to, or carry on without it.");
          if (q.by === "default") return text(`No answer in time, so the default applies: ${q.value}`);
          if (q.file) return text(`The person sent a file: ${q.file.name} (${q.file.size} bytes), saved at ${q.file.path}`);
          return text(`Answer: ${q.value}`);
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      return text(`No answer in ${wait % 60 ? `${wait} second${wait === 1 ? "" : "s"}` : `${wait / 60} minute${wait === 60 ? "" : "s"}`}, so question ${id} stays open in their Needs you. ${open}`);
    } finally {
      awaiting.delete(id);
    }
  },
});
