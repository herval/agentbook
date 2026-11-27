// A thread's buttons (Pin, Watch, Stop, Hide, Archive, and its branch's Delete once it all landed), what its turn
// ended with (how long it worked, its steps, its files), its card's files that aren't in its cover, the to-dos it
// keeps for you, and on its page the tasks it's on.
import { post } from "../../lib/api.ts";
import { ago, dur, firstLine, plural, webUrl } from "../../lib/format.ts";
import { setDraft } from "../../lib/hooks.ts";
import { go, taskHref, threadHref } from "../../lib/route.ts";
import { getApp, threadRow, useApp } from "../../lib/store.ts";
import { reloadFeed } from "../../lib/feed.ts";
import { toast } from "../../lib/toast.ts";
import type { CleanBranch, TaskRow, Thread } from "../../lib/types.ts";
import { runtimeOfRow, waits } from "../../lib/agents.ts";
import { Icon } from "../Icon.tsx";
import type { IconName } from "../Icon.tsx";
import { LinkUrls } from "../post/Ask.tsx";
import { Opt } from "../tasks/Chips.tsx";
import { TaskFaces, TaskTick } from "../tasks/TaskRow.tsx";
import { atNames, linkThread, me, taskMine, taskPeople, todoLater } from "../tasks/tasks.ts";
import { cleanBranch, cleanableBranch, dropLabel, dropTitle, useWorld } from "../worktrees/wips.ts";
import { FileChip, isPicFile } from "./FileChip.tsx";
import { StopButton, showsLive, stoppable } from "./Live.tsx";
import { Sec } from "./Sec.tsx";
import { openCloudPull } from "../bar/compose-state.ts";
import { SureButton } from "../people/Settings.tsx";

/* ---------- its files, and what its turn ended with ---------- */

// Its card's files that aren't in its cover.
export function FilesRow({ thread: s }: { thread: Thread }) {
  const shown = new Set((s.last_pictures || []).filter(isPicFile).slice(0, 3).map((f) => f.id));
  const files = (s.last_files || []).filter((f) => !shown.has(f.id) && !(s.last_pictures?.length && isPicFile(f)));
  if (!files.length) return null;
  return (
    <div className="files-row">
      {files.map((f) => (
        <FileChip key={f.id} f={f} />
      ))}
    </div>
  );
}
// How long it worked, how many steps (and how many failed), how many files it changed, and when it ended.
export function Summary({ thread: s }: { thread: Thread }) {
  if (s.effective !== "done" && !s.stats) return null;
  const st = s.stats || { steps: 0, errors: 0, worked_ms: 0 };
  const bits: [IconName | null, string][] = [];
  if (st.worked_ms) bits.push(["clock", `Worked for ${dur(st.worked_ms)}`]);
  if (st.steps) bits.push(["steps", `${plural(st.steps, "step")}${st.errors ? `, ${st.errors} failed` : ""}`]);
  if (st.files) bits.push(["diff", `${plural(st.files, "file")} changed`]);
  // Posts that ended before the wording changed still say "Session ended".
  if (s.state === "done" && s.end_reason) bits.push([null, `${s.end_reason === "Session ended" ? "Ended" : s.end_reason} ${ago(s.ended)} ago`]);
  if (!bits.length) return null;
  return (
    <div className="summary">
      {bits.map(([ic, text], i) => (
        <span key={i}>
          {ic && <Icon name={ic} />}
          {text}
        </span>
      ))}
    </div>
  );
}

/* ---------- its buttons ---------- */

// Its worktree, when its machine takes Clean up only signed: from here, which signs it.
async function cleanUp(c: CleanBranch) {
  const r = await post<{ removed?: boolean }>(`/api/wip/clean?machine=${encodeURIComponent(c.machine)}`, { root: c.root, branch: c.branch });
  if (r.ok && r.data.queued) toast(waits(r.data, "it cleans it up"));
  else if (r.ok) toast(`Deleted ${c.branch}${r.data.removed ? ", and its worktree" : ""}.`);
  return r.ok;
}
// Pin (yours alone), Hide or Archive it, or put it back.
async function setFlag(id: string, flag: string, on: boolean) {
  if (flag === "pinned") {
    const r = await post("/api/pins", { post: id, pinned: on });
    // Pinned threads go on top of the feed: it's asked for again, to put it there.
    if (r.ok && getApp().route.name === "feed") reloadFeed();
    return;
  }
  const r = await post<{ slept?: boolean; cleans?: string; clean?: CleanBranch }>(`/api/sessions/${encodeURIComponent(id)}/flag`, { [flag]: on });
  if (r.ok && flag === "archived") toast(on ? `Archived${r.data.slept ? ", and its agent put to sleep" : ""}. ${r.data.cleans ? `Its worktree goes too: everything on ${r.data.cleans} is on main. ` : ""}Pick Archived under Threads to find it.` : threadRow(id)?.hidden ? "It's back under Hidden." : "It's back in the feed.");
  if (r.ok && on && r.data.clean) await cleanUp(r.data.clean);
  if (r.ok && flag === "hidden") toast(on ? "Hidden: it keeps going, off the feed. Pick Hidden under Threads to find it." : "It's back in the feed.");
}
// Stop following it, or follow it again: its machine keeps its session off agentbook, and
// it's archived with what it had. Its session goes on where it is either way.
async function setOff(s: Thread, off: boolean) {
  const r = await post<{ queued?: boolean; waiting?: string }>(`/api/sessions/${encodeURIComponent(s.id)}/off`, { off });
  if (!r.ok) return;
  if (!off) return void toast("Following it again: it's back in the feed, and its session shows here from its next turn.");
  toast(r.data.queued ? `Archived. ${r.data.waiting} is off: it stops sending this session once it's back.` : "Archived, and nothing more of its session comes here. The session itself keeps going.");
}
export function OffButton({ s, className = "btn btn--line" }: { s: Thread; className?: string }) {
  if (s.mine === false) return null;
  if (s.off)
    return (
      <button className={className} type="button" onClick={() => setOff(s, false)}>
        <Icon name="eye" />
        Follow again
      </button>
    );
  return (
    <SureButton className={className} ask="Stop following it? Click again" title="Archive it, and keep its session off agentbook from now on. The session itself keeps going." run={() => setOff(s, true)}>
      <Icon name="eyeOff" />
      Stop following
    </SureButton>
  );
}
function Flag({ s, k, on, label, icon }: { s: Thread; k: string; on: boolean; label: string; icon: IconName }) {
  return (
    <button className={on ? "is-on" : ""} type="button" data-flag={k} onClick={() => setFlag(s.id, k, !on)}>
      <Icon name={icon} />
      {label}
    </button>
  );
}
// Its branch, once everything on it is on main and nothing goes on there: Delete branch (or worktree).
function DropButton({ s }: { s: Thread }) {
  useWorld();
  const w = cleanableBranch(s);
  if (!w) return null;
  return (
    <button
      type="button"
      data-drop-branch={s.id}
      title={dropTitle(w)}
      onClick={async (e) => {
        const b = e.currentTarget;
        const now = cleanableBranch(threadRow(s.id) || s);
        if (!now) return;
        b.disabled = true;
        if (!(await cleanBranch(now))) b.disabled = false;
      }}
    >
      <Icon name="worktree" />
      {dropLabel(w)}
    </button>
  );
}
// A followed cloud session teleports from the composer, where you pick the project it goes into.
export function teleport(s: Thread) {
  openCloudPull((s as Thread & { url?: string }).url || `https://claude.ai/code/${s.id}`);
  go("#/");
  toast("Pick the project to teleport it into, then Pull.");
}
// A Codex Cloud task's change, applied to a checkout on your machine; else its command, copied.
export async function applyCloud(e: React.MouseEvent<HTMLButtonElement>, id: string) {
  const b = e.currentTarget;
  b.disabled = true;
  const r = await post<{ root?: string; cmd?: string }>(`/api/sessions/${encodeURIComponent(id)}/apply`, {});
  b.disabled = false;
  if (r.ok) return toast(`Applied it in ${r.data.root}.`);
  if (r.data?.cmd) await navigator.clipboard?.writeText(r.data.cmd).catch(() => {});
}

export function Actions({ thread: s, watch = true }: { thread: Thread; watch?: boolean }) {
  const stop = stoppable(s) && !showsLive(s) ? <StopButton s={s} className="" /> : null;
  // An archived thread isn't pinned (archiving unpins it), so it has no Pin, as it has no Hide.
  const pin = s.archived && !s.pinned ? null : <Flag s={s} k="pinned" on={!!s.pinned} label={s.pinned ? "Pinned" : "Pin"} icon="pin" />;
  // One you stopped following comes back by following it again, not by Unarchive.
  const archive = s.off ? <OffButton s={s} className="" /> : <Flag s={s} k="archived" on={!!s.archived} label={s.archived ? "Unarchive" : "Archive"} icon="archive" />;
  const hide = s.archived ? null : <Flag s={s} k="hidden" on={!!s.hidden} label={s.hidden ? "Unhide" : "Hide"} icon="eyeOff" />;
  const look = watch ? (
    <a href={threadHref(s.id)}>
      <Icon name="eye" />
      Watch
    </a>
  ) : null;
  // Steering is its owner's alone; anyone who can see a post can pin it for themselves, and watch it.
  if (s.mine === false)
    return (
      <div className="post-acts">
        {pin}
        {look}
      </div>
    );
  if (s.rt?.kind === "cloud")
    return (
      <div className="post-acts">
        {pin}
        {look}
        <a className="act" href={webUrl(s.rt.url) || "#"} target="_blank" rel="noopener">
          <Icon name="link" />
          {runtimeOfRow(s).placeWords?.open}
        </a>
        {runtimeOfRow(s).caps.applies ? (
          <button type="button" data-apply={s.id} onClick={(e) => applyCloud(e, s.id)}>
            <Icon name="check" />
            Apply locally
          </button>
        ) : (
          <button type="button" data-teleport={s.id} onClick={() => teleport(s)}>
            <Icon name="terminal" />
            Teleport here
          </button>
        )}
        {hide}
        {archive}
      </div>
    );
  return (
    <div className="post-acts">
      {pin}
      {look}
      {stop}
      {hide}
      {archive}
      <DropButton s={s} />
    </div>
  );
}

/* ---------- the to-dos it keeps for you ---------- */

// The to-dos a thread keeps for you (ab_todo): what only you can do for it (review its pull
// request, restart something, sign in), as a checklist on it, on its card in the feed and on its page, as its other
// widgets are. Its agent ticks one off once it's done, and so can you; ↗ puts one on your Tasks, for when it outlives
// the thread. On its card, the open ones only (4 at most); on its page, the ticked ones too, under them.
const TODOS_ON_CARD = 4;
type Todo = TaskRow & { removed?: string | boolean | null };
function TodoRow({ t, card }: { t: Todo; card: boolean }) {
  const by = useApp((st) => (t.done && t.done_by === "agent" ? threadRow(t.done_post, st)?.label || "its agent" : null));
  return (
    <li className={t.done ? "is-done" : ""}>
      <TaskTick t={t} title />
      <span className="todo-t">
        <span>
          <LinkUrls text={t.text} />
        </span>
        {t.note && !card && (
          <small>
            <LinkUrls text={firstLine(t.note)} />
          </small>
        )}
        {by && <small className="todo-by">{by} ticked it</small>}
      </span>
      {!t.done && (
        <button
          className="icon-btn"
          type="button"
          data-todo-later={t.id}
          title="Put it on your Tasks: it outlives this thread"
          aria-label="Put it on your Tasks"
          onClick={async (e) => {
            e.currentTarget.disabled = true;
            await todoLater(t.id);
          }}
        >
          <Icon name="tasks" />
        </button>
      )}
    </li>
  );
}
export function ThreadTodos({ thread: s, card = false }: { thread: Thread; card?: boolean }) {
  const all = useApp((st) => st.data?.todos) as Todo[] | undefined;
  const list = (all || []).filter((t) => t.from === s.id && !t.removed);
  const open = list.filter((t) => !t.done).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const done = list.filter((t) => t.done).sort((a, b) => String(a.done_at).localeCompare(String(b.done_at)));
  if (!open.length && (card || !done.length)) return null;
  const shown = card ? open.slice(0, TODOS_ON_CARD) : [...open, ...done];
  const n = open.length ? `${open.length} to do` : "all done";
  const ul = (
    <ul className="todo-list">
      {shown.map((t) => (
        <TodoRow key={t.id} t={t} card={card} />
      ))}
    </ul>
  );
  if (!card)
    return (
      <Sec k="todos" label="For you" count={<span className="muted">{n}</span>}>
        {ul}
      </Sec>
    );
  return (
    <div className="att att-todo">
      <p className="att-title">
        For you<span className="n">{n}</span>
      </p>
      {ul}
      {open.length > shown.length && (
        <a className="todo-more" href={threadHref(s.id)}>
          and {open.length - shown.length} more
        </a>
      )}
    </div>
  );
}

/* ---------- the tasks it's on ---------- */

// On a thread's page, a task it's on that's shared: who reads the thread through it.
function SharedNote({ t }: { t: TaskRow }) {
  useApp((st) => st.me);
  const others = taskPeople(t).filter((u) => u !== me());
  if (!others.length) return null;
  return (
    <>
      {" "}
      <span className="muted tk-shared">
        · <TaskFaces t={t} whose={false} />
        {taskMine(t) ? `shared with ${atNames(others)}` : `@${t.owner_name}'s, shared with you`}
      </span>
    </>
  );
}
function TickedNote({ t }: { t: TaskRow }) {
  const by = useApp((st) => (t.done && t.done_by === "agent" ? threadRow(t.done_post, st)?.label || "an agent" : null));
  if (!by) return null;
  return (
    <>
      {" "}
      <span className="muted">· ticked off by {by}</span>
    </>
  );
}
function PostTaskRow({ t, s }: { t: TaskRow; s: Thread }) {
  const from = useApp((st) => (t.from && t.from !== s.id ? threadRow(t.from, st)?.label || "another thread" : null));
  return (
    <li className={t.done ? "is-done" : ""}>
      <TaskTick t={t} />
      <a className="post-task-t" href={taskHref(t)} title={t.text}>
        {t.text}
      </a>
      {from && (
        <>
          {" "}
          <span className="muted">· from {from}</span>
        </>
      )}
      <TickedNote t={t} />
      <SharedNote t={t} />
      {(s.mine !== false || taskMine(t)) && (
        <button className="icon-btn" type="button" data-task-unlink={t.id} title="Unlink it from this thread" aria-label="Unlink it from this thread" onClick={() => linkThread(t.id, s.id, false)}>
          <Icon name="x" />
        </button>
      )}
    </li>
  );
}
// A post's tasks, on its page: the ones linked to it, the to-dos it left you among them. Tick them here, unlink
// one, or link the post to another of your open tasks (a task has any number of posts, a post any number of
// tasks).
export function PostTasks({ s }: { s: Thread }) {
  const tasks = useApp((st) => st.data?.tasks) || [];
  const linked = tasks.filter((t) => t.posts?.some((e) => e.post === s.id));
  const more = tasks.filter((t) => !t.done && !linked.includes(t)).sort((a, b) => a.rank - b.rank);
  if (!linked.length && !more.length) return null;
  const clip = (x: string) => (x.length > 70 ? `${x.slice(0, 69)}…` : x);
  const link = more.length ? (
    <span className="sec-h-end">
      <Opt
        label="Link a task to this thread"
        face={
          <>
            <Icon name="plus" />
            <span className="opt-v">Link a task</span>
          </>
        }
        value=""
        onChange={(v) => {
          if (v) linkThread(v, s.id);
          (document.activeElement as HTMLElement | null)?.blur?.();
        }}
      >
        <option value="">Link a task…</option>
        {more.map((t) => (
          <option key={t.id} value={t.id}>
            {clip(t.text)}
          </option>
        ))}
      </Opt>
    </span>
  ) : null;
  return (
    <Sec k="tasks" label="Tasks" count={linked.length ? <span className="muted">{linked.length}</span> : ""} acts={link}>
      {linked.length > 0 && (
        <ul className="post-tasks">
          {linked.map((t) => (
            <PostTaskRow key={t.id} t={t} s={s} />
          ))}
        </ul>
      )}
    </Sec>
  );
}
