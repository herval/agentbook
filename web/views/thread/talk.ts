// Threads you start yourself: a thread of yours, not an agent's, on the server, with no
// machine behind it. Each agent you name in it joins it as a guest, a thread of its own whose messages show in it.
// Writing in it wakes only who a message is to: the To row over its box, which starts as the agent you're answering,
// and whoever the box names. Here: starting one, replying in one, and sending what you wrote to who it's to.
import { create } from "zustand";
import { agentOf, getApp, threadRow } from "../../lib/store.ts";
import { post, sendStaged } from "../../lib/api.ts";
import type { Reply } from "../../lib/api.ts";
import { getDraft, setDraft } from "../../lib/hooks.ts";
import { reloadThread } from "../../lib/thread.ts";
import { toast } from "../../lib/toast.ts";
import { msgsOf, setTalkTo, talkNamed, talkToNow, targetName } from "../../components/thread/guest-rows.ts";
import { putBackStaged, saidWith, takeStaged } from "../../components/thread/staged.tsx";
import { getCompose } from "../../components/bar/compose.ts";
import { launchMode } from "../../components/bar/compose-state.ts";

export { talkAgents, talkNamed, talkRows, talkTarget, talkToNow, setTalkTo, useTalkTo } from "../../components/thread/guest-rows.ts";

// The boxes sending now, by draft key: their Send waits.
export const useTalkSending = create<{ keys: Set<string> }>(() => ({ keys: new Set() }));
const sending = (key: string, on: boolean) =>
  useTalkSending.setState((s) => {
    const keys = new Set(s.keys);
    if (on) keys.add(key);
    else keys.delete(key);
    return { keys };
  });
// What didn't go goes back in its box, before anything typed since.
const putBack = (key: string, text: string) => setDraft(key, [text, getDraft(key).trim()].filter(Boolean).join("\n\n"));

// What you wrote, to each it goes to: an agent in it gets it in its thread; one that isn't joins with it. -> the last
// answer, as post() gives it.
export async function sendTalk(id: string, mid: string, to: string[]): Promise<Reply> {
  let r: Reply = { ok: true, data: {} };
  for (const t of to) {
    const x = t.slice(t.indexOf(":") + 1);
    r = await post(`/api/talks/${encodeURIComponent(id)}/send`, { mid, ...(t.startsWith("agent:") ? { agent: x, mode: launchMode(x, getCompose().modePick)?.pick } : t.startsWith("join:") ? { join: x } : { thread: x }) });
    if (!r.ok) break;
  }
  return r;
}

// The composer, with You picked: a thread of yours, and the agents its text names join it. `files`: what's attached
// to the box (uploaded here); `workspace`, `visibility`: the composer's picks. The composer clears its box first, and
// puts what was in it back when this says it didn't start (false).
export async function startTalk(text: string, files: File[] = [], { workspace, visibility }: { workspace?: string; visibility?: string | null } = {}): Promise<boolean> {
  text = text.trim();
  if (!text) return false;
  const to = talkNamed(text, null);
  const level = visibility === "public" ? visibility : undefined;
  try {
    const ids = await sendStaged(files, null);
    const r = await post("/api/talks", { text: saidWith(text, files), workspace: workspace || undefined, visibility: level, files: ids });
    if (!r.ok) return false;
    const names = to.map(targetName);
    const fresh = to.some((t) => t.startsWith("agent:"));
    const went = await sendTalk(r.data.id, r.data.mid, to);
    if (went.ok) toast(names.length ? `Started. ${names.join(" and ")} ${names.length > 1 ? `join it${fresh ? ", each in a thread of its own" : " as they are"}` : `joins it${fresh ? ", in a thread of its own" : " as it is"}`}.` : "Started. Just you: @ an agent in it to bring one in.");
    return true;
  } catch (err) {
    toast(err.message);
    return false;
  }
}

// A reply of yours in it (its box, `c:<id>`): kept there, then sent to its To and to whoever it names. The box empties
// as it goes, and gets what was in it back if it didn't.
export async function replyTalk(id: string, text: string): Promise<boolean> {
  const key = `c:${id}`;
  if (useTalkSending.getState().keys.has(key)) return false;
  const s = threadRow(id);
  text = text.trim();
  const staged = takeStaged(key);
  if (!s || (!text && !staged.length)) return putBackStaged(key, staged), false;
  if (!text) {
    putBackStaged(key, staged);
    toast("Say something with what you attach.");
    return false;
  }
  const to = [...new Set([...talkToNow(s, msgsOf(s)), ...talkNamed(text, s)])];
  sending(key, true);
  setDraft(key, "");
  let r: Reply = { ok: false };
  try {
    const files = await sendStaged(staged, null);
    r = await post(`/api/talks/${encodeURIComponent(id)}/messages`, { text: saidWith(text, staged), files });
    if (r.ok) {
      setTalkTo(id, null);
      const joins = to.filter((t) => t.startsWith("agent:")).map((t) => agentOf(t.slice(6)).name);
      const asIs = to.filter((t) => t.startsWith("join:")).map(targetName);
      const went = await sendTalk(id, r.data.mid, to);
      if (went.ok && (joins.length || asIs.length)) toast([joins.length ? `${joins.join(" and ")} ${joins.length > 1 ? "join" : "joins"} this thread, in a thread of ${joins.length > 1 ? "their" : "its"} own.` : "", asIs.length ? `${asIs.join(" and ")} ${asIs.length > 1 ? "join" : "joins"} this thread, as ${asIs.length > 1 ? "they are" : "it is"}.` : ""].filter(Boolean).join(" "));
      const route = getApp().route;
      if (route.name === "session" && route.id === id) reloadThread();
    }
  } catch (err) {
    toast(err.message);
  } finally {
    sending(key, false);
    if (!r.ok) {
      putBack(key, text);
      putBackStaged(key, staged);
    }
  }
  return r.ok;
}

// A guest taken out of a thread of yours: what it said stays in it.
export async function talkOut(id: string, guest: string) {
  const r = await post(`/api/talks/${encodeURIComponent(id)}/guests`, { remove: guest });
  if (r.ok) toast("It left this thread. What it said stays here.");
  reloadThread();
}
// Archived, or back on your feed.
export async function talkArchive(id: string, archived: boolean) {
  const r = await post(`/api/talks/${encodeURIComponent(id)}`, { archived: !archived });
  if (r.ok) toast(archived ? "Back on your feed." : "Archived. Writing in it brings it back.");
  reloadThread();
}
