// Saying something to a thread as you, from a button rather than its box (a reply it suggested, a draft's Send, a
// card's button, Bring back): held for after the turn while one runs, and what happened to it said in a toast, as the
// box says it. The thread's page reads it again once it went.
import { post } from "../../lib/api.ts";
import type { Reply } from "../../lib/api.ts";
import { stuckLine, nudgedLine, waits } from "../../lib/agents.ts";
import { getApp, threadRow } from "../../lib/store.ts";
import { reloadThread } from "../../lib/thread.ts";
import { toast } from "../../lib/toast.ts";

// What a message's answer says happened to it, as a toast (none when it simply went in).
export function sentToast(r: Reply, id: string, what = "it gets this") {
  if (!r.ok || !r.data) return;
  if (r.data.went) toast("It had just finished, so it has this now.");
  else if (r.data.resumed) toast("Resuming it.");
  else if (r.data.queued) toast(waits(r.data, what));
  else if (r.data.stuck === "terminal") toast(stuckLine(threadRow(id)));
  else if (r.data.nudged) toast(nudgedLine(threadRow(id)));
}

// Send `text` to thread `id` as your message. `queue`: hold it for after the turn (by default, while it works).
export async function sayToThread(id: string, text: string, { queue, files = [], toastIt = true }: { queue?: boolean; files?: string[]; toastIt?: boolean } = {}): Promise<Reply> {
  const q = queue ?? threadRow(id)?.effective === "working";
  const r: Reply = await post(`/api/sessions/${encodeURIComponent(id)}/messages`, { text, files, ...(q ? { queue: true } : {}) }).catch((err) => (toast(err.message), { ok: false }));
  if (toastIt) sentToast(r, id);
  if (r.ok && getApp().open?.id === id) reloadThread();
  return r;
}
