// Answering it, and telling its agent what to do (the old page's "answering it, and telling its agent what to do"):
// under each of a WIP's review threads, reviews and comments, and each file it changes, Reply (on GitHub, as you),
// Resolve (a review thread), and Tell (to the agent on it).
import { useRef } from "react";
import { post, type Reply } from "../../lib/api.ts";
import { getDraft, setDraft } from "../../lib/hooks.ts";
import { threadHref } from "../../lib/route.ts";
import { agentOf } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { PullThread, Thread, WipPull } from "../../lib/types.ts";
import { Icon, type IconName } from "../Icon.tsx";
import { MsgBox } from "../MsgBox.tsx";
import { markDone, keepTold, sendingNow, setBox, usePage } from "./PageState.ts";
import { ghBody, prLaunch, prPlace, sessionById, useWorld, wipAgent, wipLaunch, type BranchRead, type Wip } from "./wips.ts";
import { agoText } from "../../lib/format.ts";

// A comment on GitHub, as the page reads it: a review thread's (its number, `n`, what a reply on GitHub answers), a
// review, or one on the pull request itself.
export interface GhSaid {
  id: string;
  n?: number | null;
  who: string;
  bot?: boolean;
  state?: string;
  body: string;
  at: string;
  url?: string | null;
}
// A review thread on it, with what you may do in it (unresolve too).
export type ReadThread = Omit<PullThread, "can" | "comments"> & { can?: { reply?: boolean; resolve?: boolean; unresolve?: boolean }; comments: GhSaid[] };
// A pull request's page as GitHub has it (/api/pulls): WipPull's, with its repo's slug, its summary (when it was
// opened, by whom, its size) and its threads' and checks' details.
export type PullRead = Omit<Partial<WipPull>, "threads_list" | "checks_list" | "comments_list" | "reviews_list"> & {
  threads_list?: ReadThread[];
  comments_list?: GhSaid[];
  reviews_list?: GhSaid[];
  checks_list?: (WipPull["checks_list"][number] & { text?: string | null })[];
  repo?: string;
  files?: number;
  created?: string;
  author?: string;
  add?: number;
  del?: number;
};
// What a page's boxes need: the WIP, what its page read (a pull request's, or a branch's), and how the page reads it
// again or changes what it has at once.
export interface PullCx {
  x: Wip;
  d: PullRead | BranchRead | null;
  reload: () => void;
  patchThread: (id: string, change: Partial<ReadThread>) => void;
}
// What its page read, as a pull request's (a branch's has none of what prItem looks for).
const pullOf = (d: PullCx["d"]) => d as PullRead | null;

export const REVIEW_VERB = { approved: "approved it", changes_requested: "asked for changes", commented: "reviewed it", dismissed: "had a review dismissed" };
export const EVENT_VERB = { merged: "merged it", closed: "closed it", reopened: "reopened it", "force-pushed": "force-pushed its branch", ready: "marked it ready for review", draft: "turned it back into a draft" };

// Who Tell goes to on a WIP: the thread going on it, else whoever a new thread there would start with. Null when
// nobody can take it.
interface Tellee {
  going?: Thread;
  name: string;
}
export function tellee(x: Wip): Tellee | null {
  const going = x.posts.find((s) => s.state !== "done" && s.mine !== false);
  if (going) return { going, name: going.label };
  const at = x.kind === "pr" ? prPlace(x) : x;
  const a = at && wipAgent({ machine: at.machine, posts: x.posts });
  return a ? { name: agentOf(a.id).name } : null;
}
// What a key names on its page: a review thread ("t:"), a review ("r:"), a comment ("c:"), a file ("f:"), or the pull
// request itself ("pr").
type PrIt = { key: string; kind: "pr" } | { key: string; kind: "file"; path: string } | { key: string; kind: "thread"; t: ReadThread } | { key: string; kind: "review" | "comment"; c: GhSaid };
function prItem(d: PullRead | null, key: string): PrIt | null {
  const [k, id] = [key.slice(0, 2), key.slice(2)];
  if (key === "pr") return { key, kind: "pr" };
  if (k === "f:") return { key, kind: "file", path: id };
  if (k === "t:") return d?.threads_list?.find((t) => t.id === id) ? { key, kind: "thread", t: d.threads_list.find((t) => t.id === id) } : null;
  if (k === "r:") return d?.reviews_list?.find((r) => r.id === id) ? { key, kind: "review", c: d.reviews_list.find((r) => r.id === id) } : null;
  if (k === "c:") return d?.comments_list?.find((c) => c.id === id) ? { key, kind: "comment", c: d.comments_list.find((c) => c.id === id) } : null;
  return null;
}
// What Tell sends: which pull request (or branch) and which of its threads, comments or files, what was said there
// (as theirs: it's other people's words, quoted, not yours), how to answer it on GitHub, and what you wrote. Nothing
// written: address it. `about`: say which pull request (a new thread's prompt says that already).
const quoted = (c: GhSaid) => `> @${c.who}: ${ghBody(c.body).slice(0, 1500).replace(/\n/g, "\n> ")}`;
const SAID = "What was said there on GitHub (their words, quoted):";
function tellText(x: Wip, d: PullRead | null, it: PrIt, text: string, about = true) {
  const pr = x.kind === "pr";
  const slug = d?.repo || "";
  const head = !about ? "" : pr ? `About pull request #${x.number} (${x.pr.url}), on its branch ${x.branch}. ` : `About the branch ${x.branch}${x.worktree ? `, in ${x.worktree}` : ""}. `;
  const lines: string[] = [];
  let how = "";
  let fallback = "";
  if (it.kind === "thread") {
    const t = it.t;
    lines.push(`${head}The review thread on ${t.path}${t.line ? `:${t.line}` : ""}${t.comments[0]?.url ? ` (${t.comments[0].url})` : ""}.`, SAID, ...(t.comments.length > 6 ? [t.comments[0], ...t.comments.slice(-5)] : t.comments).map(quoted));
    // GitHub takes a reply to a thread's first comment, not to a reply.
    how = slug && t.comments[0]?.n ? `To answer on that thread on GitHub: gh api repos/${slug}/pulls/${x.number}/comments/${t.comments[0].n}/replies -f body='…'` : "";
    fallback = "Address it: change the code if it should, push, and reply on the thread with what you did, or why not.";
  } else if (it.kind === "review" || it.kind === "comment") {
    lines.push(`${head}${it.kind === "review" ? `@${it.c.who}'s review (${REVIEW_VERB[it.c.state] || "reviewed it"})` : `@${it.c.who}'s comment`}${it.c.url ? ` (${it.c.url})` : ""}.`, SAID, quoted(it.c));
    how = pr ? `To answer on GitHub: gh pr comment ${x.number} --body '…'` : "";
    fallback = "Address it: change the code if it should, push, and answer on the pull request with what you did, or why not.";
  } else if (it.kind === "file") lines.push(`${head}Its changes to ${it.path}.`);
  return [...lines, "", `What I want: ${text || fallback}`, ...(how ? ["", how] : [])].join("\n");
}
async function prTell(x: Wip, d: PullRead | null, it: PrIt, text: string): Promise<Reply> {
  const to = tellee(x);
  if (!to) return toast(`No agent can take it here.`), { ok: false };
  const r = to.going ? await post(`/api/sessions/${encodeURIComponent(to.going.id)}/messages`, { text: tellText(x, d, it, text), files: [] }) : await (x.kind === "pr" ? prLaunch : wipLaunch)(x, tellText(x, d, it, text, false));
  if (!r.ok) return r;
  if (to.going) toast(`Sent to ${to.name}.`);
  keepTold(`${x.id}|${it.key}`, { at: new Date().toISOString(), text, to: to.name, post: to.going?.id || null });
  return r;
}

// Opening a box: answering a review or a comment is a comment on the pull request, so it starts by naming whose it was.
function openBox(cx: PullCx, key: string, mode: string) {
  const { x } = cx;
  setBox({ id: x.id, key, mode });
  const it = prItem(pullOf(cx.d), key);
  const draft = `pr:${x.id}:${mode}:${key}`;
  if (mode === "reply" && it && "c" in it && it.c.who !== x.me && !getDraft(draft)) setDraft(draft, `@${it.c.who} `);
}
// Resolving a review thread on GitHub (or Undo): the page has it at once, before GitHub's read again says so.
export async function resolveThread(cx: PullCx, thread: string, undo: boolean, btn: HTMLButtonElement) {
  const { x } = cx;
  if (x.kind !== "pr") return;
  btn.disabled = true;
  const r = await post("/api/pulls/resolve", { workspace: x.ws.id, number: x.number, thread, resolved: !undo });
  if (r.ok) {
    markDone(thread, !undo);
    cx.patchThread(thread, { resolved: !undo });
    cx.reload();
  } else btn.disabled = false;
}

// Under each of a WIP's review threads, reviews and comments, and each file it changes: Reply, which answers it on
// GitHub as you (a thread's reply goes on the thread; anything else's is a comment on the pull request), Resolve, for
// a thread, and Tell, which sends what you write about this one to the agent on it: the thread going on the WIP, else
// a new one (tellee). `o`: { key, reply, thread, who (whose it is), top (the pull request's own comment box) }.
export interface ActsOpts {
  key: string;
  reply?: boolean;
  thread?: ReadThread;
  who?: string;
  top?: boolean;
}
export function PrActs({ cx, o }: { cx: PullCx; o: ActsOpts }) {
  useWorld();
  const { x } = cx;
  const box = usePage((s) => s.box);
  const told = usePage((s) => s.told[`${x.id}|${o.key}`]);
  if (x.shared) return null;
  const mode = box?.id === x.id && box.key === o.key ? box.mode : null;
  const to = x.posts.every((s) => s.mine !== false) ? tellee(x) : null;
  if (mode) return <PrForm cx={cx} o={o} mode={mode} to={to} />;
  if (o.top)
    return (
      <div className="rp-new">
        <button className="rp-pill" type="button" onClick={() => openBox(cx, "pr", "reply")}>
          Comment on #{x.number}…
        </button>
      </div>
    );
  // What you told it shows until there's an answer on the thread after it.
  const answered = told && o.thread && o.thread.comments.some((c) => c.at > told.at);
  const by = told && (told.post ? sessionById(told.post) : x.posts.find((s) => s.started >= told.at));
  const note =
    told && !answered ? (
      <p className="rp-told">
        <Icon name="send" />
        <span>
          You told <b>{told.to}</b> {agoText(told.at)}
          {told.text ? `: “${told.text.length > 140 ? `${told.text.slice(0, 139)}…` : told.text}”` : ", to address it"}
        </span>
        {by ? <a href={threadHref(by.id)}>Its thread</a> : null}
      </p>
    ) : null;
  const btn = (m: string, ico: IconName, label: string, title: string) => (
    <button className="btn btn--line" type="button" title={title} onClick={() => openBox(cx, o.key, m)}>
      <Icon name={ico} />
      {label}
    </button>
  );
  const t = o.thread;
  const resolve = t ? (
    <button className="btn btn--line" type="button" disabled={t.can?.resolve === false} title={t.can?.resolve !== false ? "Resolve it on GitHub" : "GitHub doesn't let you resolve it"} onClick={(e) => void resolveThread(cx, t.id, false, e.currentTarget)}>
      <Icon name="check" />
      Resolve
    </button>
  ) : null;
  const reply = o.reply ? btn("reply", "comment", "Reply", t ? "Reply on this thread on GitHub, as you" : `Comment on #${x.number} on GitHub, as you, answering this`) : null;
  const tell = to ? btn("tell", "send", `Tell ${to.name}`, to.going ? `Tell ${to.name}, on this ${x.kind === "pr" ? "pull request" : "branch"}, what to do about this one` : `Start a thread with ${to.name} about this one`) : null;
  return (
    <>
      {note}
      {reply || resolve || tell ? (
        <div className="rp-foot">
          {reply}
          {resolve}
          {tell}
        </div>
      ) : null}
    </>
  );
}

function PrForm({ cx, o, mode, to }: { cx: PullCx; o: ActsOpts; mode: string; to: Tellee | null }) {
  const { x } = cx;
  const form = useRef<HTMLFormElement>(null);
  const tell = mode === "tell";
  const draft = `pr:${x.id}:${mode}:${o.key}`;
  const busy = usePage((s) => s.sending.has(draft));
  const file = o.key.startsWith("f:");
  const ph = tell ? `What should ${to?.name || "it"} do about ${file ? "this file" : "it"}?${file ? "" : " Nothing written: address it, and answer on GitHub."}` : o.thread ? "Reply on this thread…" : `Comment on #${x.number}…`;
  const note = tell ? (to?.going ? `Goes to ${to.name}, on its thread` : `Starts a thread with ${to?.name || "an agent"}`) : `Posts on GitHub as @${x.me || "you"}`;
  const label = tell ? `Send to ${to?.name || "it"}` : o.thread ? "Reply" : "Comment";
  // Sending it: told to its agent, a reply on its thread (and resolving it, `resolve`), or a comment on the pull
  // request. Nothing written goes only as Tell, about something other than a file.
  const send = async (resolve: boolean, given?: string) => {
    const d = pullOf(cx.d);
    if (usePage.getState().sending.has(draft)) return;
    const it = prItem(d, o.key);
    const text = String(given ?? getDraft(draft)).trim();
    if (!it) return toast("It isn't on GitHub anymore.");
    if (!text && (mode === "reply" || it.kind === "file")) return void form.current?.querySelector<HTMLElement>("textarea, ab-box, [contenteditable]")?.focus();
    sendingNow(draft, true);
    let r: Reply;
    try {
      if (mode === "tell") r = await prTell(x, d, it, text);
      else if (it.kind === "thread") r = await post("/api/pulls/reply", { workspace: x.ws.id, number: x.number, thread: it.t.id, body: text, resolve });
      else r = await post("/api/pulls/comment", { workspace: x.ws.id, number: x.number, body: text });
    } catch (err) {
      toast(err.message);
      r = { ok: false };
    }
    sendingNow(draft, false);
    if (!r.ok) return;
    setDraft(draft, "");
    if (usePage.getState().box?.key === it.key) setBox(null);
    if (mode === "reply") {
      toast(it.kind === "thread" ? (resolve ? "Replied and resolved, on GitHub." : "Replied on GitHub.") : "Commented on GitHub.");
      if (resolve && it.kind === "thread") {
        markDone(it.t.id, true);
        cx.patchThread(it.t.id, { resolved: true });
      }
      if (x.kind === "pr") cx.reload();
    }
  };
  return (
    <form
      ref={form}
      className="rp-form"
      data-pr-form={o.key}
      data-mode={mode}
      onSubmit={(e) => {
        e.preventDefault();
        void send((e.nativeEvent as SubmitEvent).submitter?.dataset.and === "resolve");
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || (e.target as HTMLElement).closest("button")) return;
        (e.target as HTMLElement).blur?.();
        setBox(null);
      }}
    >
      <MsgBox draft={draft} placeholder={ph} label={tell ? `What to tell ${to?.name || "its agent"}` : "Your reply"} autoFocus onSend={(text) => void send(false, text)} />
      <div className="rp-send">
        <span className="muted">{note}</span>
        <button className="rp-quiet" type="button" onClick={() => setBox(null)}>
          Cancel
        </button>
        {!tell && o.thread && o.thread.can?.resolve !== false ? (
          <button className="btn btn--line" type="submit" data-and="resolve" disabled={busy}>
            Reply and resolve
          </button>
        ) : null}
        <button className="btn btn--dark" type="submit" disabled={busy}>
          {label}
        </button>
      </div>
    </form>
  );
}
