// A thread's guests: agents brought into it by @-ing them. A guest is a thread of its
// own, whose messages show in the thread it's a guest in. Here: who's in it (under its header), its guests at work
// (under its live line), the line under a box saying who what you write goes to, and sending to them. The data of
// it (who's in it, who @ lists) is guest-rows.ts.
import { useState } from "react";
import { post } from "../../lib/api.ts";
import type { Reply } from "../../lib/api.ts";
import { hueVars } from "../../lib/format.ts";
import { isTalkId } from "../../lib/format.ts";
import { agentOf, getApp, threadRow, useApp } from "../../lib/store.ts";
import { reloadThread } from "../../lib/thread.ts";
import { toast } from "../../lib/toast.ts";
import type { GroupRow, TaskRow, Thread } from "../../lib/types.ts";
import { Avatar, PersonAvatar } from "../Avatar.tsx";
import { Icon } from "../Icon.tsx";
import { Since } from "../Time.tsx";
import { getCompose } from "../bar/compose.ts";
import { launchMode } from "../bar/compose-state.ts";
import { StopButton, stoppable } from "./Live.tsx";
import { guestPlace, guestRows, guestsOn, guestWords, hasReplyPicker, msgsOf, replyMentions, replyName, replyPeople, replyPerson, setReplyTo, talkNamed, talkTarget, talkToNow, targetName, threadForReply, together, useReplyTo, useTalkTo } from "./guest-rows.ts";
import type { Guest } from "./guest-rows.ts";

export { boxTargets, guestPlace, guestPlaceWords, guestRows, guestsOn, guestWords, joinRows, talkRows, talkNamed, targetName, together, guestKind } from "./guest-rows.ts";
export type { Guest, GuestRow } from "./guest-rows.ts";

// Only threads with several agents need another control. Its options use session ids, so two sessions of the same
// agent stay distinct. A draft with @mentions shows those actual receivers instead of a picker that could disagree.
export function ReplyRecipient({ s, text, off = false }: { s: Thread; text: string; off?: boolean }) {
  useApp((st) => st.rows);
  useReplyTo((st) => st.to[s.id]);
  if (!hasReplyPicker(s)) return null;
  const named = replyMentions(s.id, text);
  const people = replyPeople(s);
  const selected = replyPerson(s);
  const namedPeople = [...(named.host ? [replyName(s)] : []), ...named.to.map((t) => {
    const id = t.slice(t.indexOf(":") + 1);
    return t.startsWith("thread:") ? replyName(people.find((p) => p.id === id) || { label: id }) : targetName(t);
  })];
  return (
    <div className="reply-recipient">
      <span>Reply to</span>
      {namedPeople.length ? (
        <><b>{namedPeople.join(" and ")}</b><small>Chosen by @mention</small></>
      ) : (
        <>
          <select aria-label="Reply recipient" value={selected?.id || ""} disabled={off} onChange={(e) => setReplyTo(s.id, e.currentTarget.value)}>
            {!selected && <option value="" disabled>Choose a recipient</option>}
            {people.map((p) => <option key={p.id} value={p.id}>{replyName(p)}</option>)}
          </select>
          <small>{selected ? "Only this agent receives it" : "That agent left. Choose who receives this draft."}</small>
        </>
      )}
    </div>
  );
}

// Who asked a question in a thread's conversation, and its conversation's questions: the core area's (post/Ask.tsx).
export { askerOf, threadQs } from "../post/Ask.tsx";

// Its guests at work, under its own live line: what each is doing this moment, with Stop. Null when none is.
export function GuestLive({ s }: { s: Thread }) {
  useApp((st) => st.rows);
  const going = guestsOn(s).filter((g) => g.effective === "working" || g.effective === "starting");
  if (!going.length) return null;
  return (
    <>
      {going.map((g) => {
        const row = threadRow(g.id);
        const st = g.live?.step;
        const text = g.effective === "starting" ? "Starting" : !st ? "Working" : st.kind === "say" ? st.text.split("\n")[0] : st.title;
        return (
          <div className="cmt cmt-now" style={hueVars(g.agent)} key={g.id}>
            <Avatar agent={g.agent} size="av--sm" />
            <div className="live">
              <i className="pulse" />
              <b>{text}</b>
              <span className="muted live-n">
                {g.label || agentOf(g.agent).name}
                {s.talk ? "" : " · guest"}
                {st && g.live.steps ? ` · step ${g.live.steps}` : ""}
              </span>
              {st && !st.done && st.at && (
                <time dateTime={st.at}>
                  <Since since={st.at} />
                </time>
              )}
              {row && stoppable(row) && (
                <span className="live-acts">
                  <StopButton s={row} />
                </span>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}

// × on a guest: out of the thread; what it said stays in it.
function GuestOut({ g, host, name }: { g: Guest; host: string; name: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="with-x"
      type="button"
      disabled={busy}
      title="Take it out of this thread: what it said stays"
      aria-label={`Take ${name} out of this thread`}
      onClick={async (e) => {
        e.preventDefault();
        setBusy(true);
        const r = await post(`/api/sessions/${encodeURIComponent(host)}/guests`, { remove: g.id });
        if (r.ok) {
          toast("It left this thread. What it said stays here.");
          if (getApp().route.name === "session") reloadThread();
        } else setBusy(false);
      }}
    >
      <Icon name="x" />
    </button>
  );
}

// Who's in a thread's conversation, under its header: its own agent, then each guest with how it's doing, a click from
// its thread, and × to take it out of this one. On a guest's own page: the thread it's a guest in.
export function WithRow({ s }: { s: Thread }) {
  const me = useApp((st) => st.me);
  const h = typeof s.guest_of === "object" ? s.guest_of : null;
  // In a thread of a person's own: whose it is.
  if (h?.talk)
    return (
      <p className="with-row">
        <a className="chip with-of" href={`#/threads/${encodeURIComponent(h.id)}`}>
          <PersonAvatar who={h.by} size="av--xs" />
          {h.removed ? "Was in" : "In"} {h.by === me?.username ? "your" : `@${h.by}'s`} thread ↗
        </a>
        {h.title && <span className="muted">{h.title}</span>}
      </p>
    );
  if (h)
    return (
      <p className="with-row">
        <a className="chip with-of" href={`#/threads/${encodeURIComponent(h.id)}`} style={hueVars(h.agent)}>
          <Avatar agent={h.agent} size="av--xs" />
          {h.removed ? "Was a guest in" : "A guest in"} {h.label || "a thread"} ↗
        </a>
        {h.title && <span className="muted">{h.title}</span>}
      </p>
    );
  const gs = guestsOn(s);
  if (!gs.length) return null;
  const named = together(s);
  const host = named[0];
  return (
    <div className="with-row">
      <span className="with-h">With</span>
      <span className="with-chip is-host" style={hueVars(host.agent)}>
        <Avatar agent={host.agent} size="av--xs" />
        <b>{host.name}</b>
        <small>{host.label}</small>
      </span>
      {gs.map((g) => {
        const name = named.find((x) => x.id === g.id)?.name || agentOf(g.agent).name;
        return (
          <span className="with-chip" style={hueVars(g.agent)} key={g.id}>
            <a href={`#/threads/${encodeURIComponent(g.id)}`} title="Open its thread">
              <Avatar agent={g.agent} size="av--xs" on={g.effective === "working" ? "active" : false} />
              <b>{name}</b>
              <small>{g.label ? `${g.label} · ${guestWords(g)}` : guestWords(g)}</small>
            </a>
            {s.mine !== false && <GuestOut g={g} host={s.id} name={name} />}
          </span>
        );
      })}
    </div>
  );
}
/* ---------- the line under a box: who it goes to ---------- */

const TASK_MENTION = /(^|[\s(>*_~])@task:([a-z0-9]+)(?![\w/-])/g;
const GROUP_MENTION = /(^|[\s(>*_~])@group:([a-z0-9][a-z0-9-]*)(?![\w/-])/g;
const groupIn = (g: GroupRow | undefined) => !!g && (g.mine !== false || !!(g as GroupRow & { in?: boolean }).in);
const quote = (t: TaskRow) => `“${t.text.length > 60 ? `${t.text.slice(0, 59)}…` : t.text}”`;
// What the tasks and the group a box names do to its thread (the server's mentionLinks, and /api/launch): "On the
// task “Fix login” · In the group hive". Only what would change: a task it's on already, or the group it's in, says
// nothing, and the composer's group picked as where it goes wins over one it names. `threadId` null: the composer,
// with the group it has picked (`picked`).
export function linkHint(threadId: string | null, text: string, picked: string | null = null): string {
  const data = getApp().data;
  const taskNamed = (id: string) => (data?.tasks || []).find((t) => t.id === id) || (data?.todos || []).find((t) => t.id === id);
  const tasks = [...new Set([...String(text || "").matchAll(TASK_MENTION)].map((m) => m[2]))].map(taskNamed).filter(Boolean);
  const g = [...String(text || "").matchAll(GROUP_MENTION)].map((m) => (data?.groups || []).find((x) => x.id === m[2])).find((x) => x && groupIn(x) && !x.archived);
  if (!threadId) return [tasks.length ? `On the task${tasks.length > 1 ? "s" : ""} ${tasks.map(quote).join(" and ")}` : "", g && !picked ? `In the group ${g.name}` : ""].filter(Boolean).join(" · ");
  const s = threadRow(threadId);
  const on = tasks.filter((t) => !(t.posts || []).some((e) => e.post === threadId));
  const into = g && s?.group !== g.id ? g : null;
  return [on.length ? `Puts this thread on ${on.map(quote).join(" and ")}` : "", into ? `${s?.group ? "Moves it into" : "Puts it in"} the group ${into.name}` : ""].filter(Boolean).join(" · ");
}
// What the line under a box says, given what's in it. `talk`: a thread of yours (`threadId`), or the composer starting
// one (null); else a thread's reply box, or the composer starting an agent's thread (null; `picked`, its group).
export function toHintText(threadId: string | null, text: string, { talk = false, picked = null, recipientShown = false }: { talk?: boolean; picked?: string | null; recipientShown?: boolean } = {}): string {
  // The composer starting an agent's thread: where naming a task or a group puts it.
  if (!threadId && !talk) return linkHint(null, text, picked);
  // A thread of yours, or the composer starting one: who it brings in, and who else it's to.
  if (talk || isTalkId(threadId)) {
    const s = threadId ? threadRow(threadId) || null : null;
    const named = talkNamed(text, s);
    const joins = named.filter((t) => t.startsWith("agent:")).map((t) => agentOf(t.slice(6)).name);
    const now = s ? talkToNow(s, msgsOf(s)) : [];
    const also = s
      ? named
          .filter((t) => t.startsWith("thread:") && !now.includes(t))
          .map((t) => {
            const x = talkTarget(s, t);
            return x.label || agentOf(x.agent).name;
          })
      : [];
    const asIs = named.filter((t) => t.startsWith("join:")).map(targetName);
    return [also.length ? `Also to ${also.join(" and ")}` : "", asIs.length ? `${asIs.join(" and ")} ${asIs.length > 1 ? "join" : "joins"} ${s ? "this thread" : "it"} as ${asIs.length > 1 ? "they are" : "it is"}` : "", joins.length ? `${joins.join(" and ")} ${joins.length > 1 ? "join" : "joins"} ${s ? "this thread" : "it"}, ${joins.length > 1 ? "each in a thread of its own" : "in a thread of its own"}` : ""].filter(Boolean).join(" · ");
  }
  const { to, host } = replyMentions(threadId, text);
  const s = threadRow(threadId);
  const name = (t: string) => {
    const id = t.slice(t.indexOf(":") + 1);
    return t.startsWith("agent:") || t.startsWith("join:") ? null : guestsOn(s).find((g) => g.id === id)?.label || id;
  };
  const sent = [...(host ? [s?.label || "this thread"] : []), ...to.map(name).filter(Boolean)];
  const joining = to.filter((t) => t.startsWith("agent:")).map((t) => agentOf(t.slice(6)));
  const joins = joining.map((a) => a.name);
  // Where they work, when it's the same for all of them.
  const hows = [...new Set(joining.map((a) => (s ? guestPlace(s, a) : "other")))];
  const where = hows.length !== 1 ? "" : hows[0] === "same" ? ", in this thread's folder" : hows[0] === "none" ? ", with no folder" : "";
  const asIs = to.filter((t) => t.startsWith("join:")).map((t) => threadRow(t.slice(5))?.label).filter(Boolean);
  return [!recipientShown && sent.length ? `To ${sent.join(" and ")} only` : "", asIs.length ? `${asIs.join(" and ")} ${asIs.length > 1 ? "join" : "joins"} this thread as ${asIs.length > 1 ? "they are" : "it is"}` : "", joins.length ? `${joins.join(" and ")} ${joins.length > 1 ? "join" : "joins"} this thread, ${joins.length > 1 ? "each in a thread of its own" : "in a thread of its own"}${where}` : "", linkHint(threadId, text)].filter(Boolean).join(" · ");
}
export function ToHint({ threadId, text, talk = false, picked = null, recipientShown = false }: { threadId: string | null; text: string; talk?: boolean; picked?: string | null; recipientShown?: boolean }) {
  // What it says changes with the thread, its guests, and who a thread of yours's reply goes to.
  useApp((st) => (threadId ? threadRow(threadId, st) : st.data));
  useTalkTo((st) => (threadId ? st.to[threadId] : null));
  const hint = toHintText(threadId, text, { talk, picked, recipientShown });
  return (
    <p className="to-hint" hidden={!hint}>
      {hint}
    </p>
  );
}

// What you wrote in a thread's box to the agents it names: a guest gets it as a message (waiting for its turn to end,
// while it works, unless you send it now), an agent that isn't in the thread joins it with it, and the thread's own
// agent gets it only when it's named too. Files go with the first. -> the last answer, as post() gives it.
export async function sendToGuests(id: string, { to, host }: { to: string[]; host: boolean }, { text, files, queue, now }: { text: string; files: string[]; queue?: boolean; now?: boolean }): Promise<Reply> {
  const s = threadForReply(id);
  let r: Reply = { ok: true, data: {} };
  let rest = files;
  const send = async (url: string, body: object) => {
    r = await post(url, { ...body, files: rest });
    rest = [];
    return r.ok;
  };
  if (host && !(await send(`/api/sessions/${encodeURIComponent(id)}/messages`, { text, ...(queue ? { queue: true } : {}) }))) return r;
  for (const t of to) {
    const [kind, tid] = [t.slice(0, t.indexOf(":")), t.slice(t.indexOf(":") + 1)];
    if (kind === "agent") {
      if (!(await send(`/api/sessions/${encodeURIComponent(id)}/guests`, { agent: tid, text, mode: launchMode(tid, getCompose().modePick)?.pick }))) return r;
      toast(`${agentOf(tid).name} joins this thread, in a thread of its own.`);
    } else if (kind === "join") {
      if (!(await send(`/api/sessions/${encodeURIComponent(id)}/guests`, { thread: tid, text }))) return r;
      toast(`${threadRow(tid)?.label || "It"} joins this thread, as it is.`);
    } else {
      const g = guestsOn(s).find((g) => g.id === tid);
      const busy = !!(g?.busy ?? (g?.effective === "working")) || !!g?.going?.length;
      if (!(await send(`/api/sessions/${encodeURIComponent(tid)}/messages`, { text, ...(busy && !now ? { queue: true } : {}) }))) return r;
    }
  }
  return r;
}
