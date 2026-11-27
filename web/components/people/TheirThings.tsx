// What someone on another agentbook published to you (server/api/people-things.ts), on their profile: their agents,
// threads (with their work: steps and diffs), pages and tasks, read only. Nothing here steers anything: no reply box,
// no Stop, no answers, no ▶ on their code. While their door is off it's what came last, "as of" then. Their text is
// drawn as markdown with its pictures as links, so nothing loads from an address they picked.
// What you do here goes to their door and waits for their page to take it (server/api/people-comments.ts,
// server/api/people-spaces.ts): a comment on a thread of theirs, yes or no to being in a group, task, page or note of
// theirs, and once in, a note, a comment or one of your threads.
import { useState, type ReactNode } from "react";
import { post } from "../../lib/api.ts";
import { ago, agoText, plural } from "../../lib/format.ts";
import { useLoad } from "../../lib/hooks.ts";
import { personHref, theirThingHref } from "../../lib/route.ts";
import { toast } from "../../lib/toast.ts";
import { useApp } from "../../lib/store.ts";
import type { Person, Shown, TheirSpace, TheirThing, TheirThings as Things, Widget } from "../../lib/types.ts";
import { Icon } from "../Icon.tsx";
import { FollowMenu } from "../agents/FollowMenu.tsx";
import { Markdown } from "../Markdown.tsx";
import { WidgetBody } from "../pages/widgets.tsx";
import { ChgSize, DiffView, PathParts } from "../thread/diff-view.tsx";

const enc = encodeURIComponent;
// A picture in their text, as a link to it (`![a](u)` and `![a][r]` both).
const unpictured = (v: unknown): unknown =>
  typeof v === "string" ? v.replace(/!\[/g, "[") : Array.isArray(v) ? v.map(unpictured) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unpictured(x)])) : v;
const Text = ({ text, className = "md" }: { text: unknown; className?: string }) => <Markdown className={className} text={String(unpictured(text) || "")} />;
// The widgets drawn from their data alone: none that loads pictures, runs a query or is theirs to act on.
const DRAWN = new Set(["metric", "chart", "table", "list", "note", "doc", "link", "diagram"]);
type WidgetType = Widget["type"];

// How fresh it is: their door answered last time, or "as of" when it last did.
function AsOf({ things }: { things: Things }) {
  const off = things.remote?.reach && !things.remote.reach.ok;
  return off ? <p className="their-asof">Their agentbook is off: this is what it sent {agoText(things.as_of)}.</p> : null;
}
// Whom a thing names that your page knows, each a link to that person (decision 4: a mention shares nothing).
function Names({ t }: { t: TheirThing }) {
  if (!t.mentions?.length) return null;
  return (
    <p className="their-names">
      Names{" "}
      {t.mentions.map((m, i) => (
        <span key={m.username}>
          {i ? ", " : ""}
          <a href={personHref(m.username)}>{m.you ? "you" : `@${m.username}`}</a>
        </span>
      ))}
    </p>
  );
}
// Someone in a group, note or task of theirs: you, @their username here, or the handle they go by.
const shownName = (x: Shown) => (x.you ? "you" : `@${x.username || x.handle || "someone"}`);

// One of their agents, and whether its threads are in your feed (yours alone to say: nobody asks or is told).
function AgentRowOf({ a, owner, reload }: { a: Things["agents"][number]; owner: string; reload: () => unknown }) {
  return (
    <li className="act-row their-agent">
      <span className="pg-ico">{a.body.emoji || a.body.glyph || <Icon name="bot" />}</span>
      <span>
        <b>{a.body.name || "An agent"}</b>
        <small>
          {a.body.kind || "Agent"}
          {a.body.machine ? ` · on ${a.body.machine}` : ""}
          {a.body.working ? " · working" : ""}
        </small>
      </span>
      <FollowMenu id={a.ref} name={a.body.name || "It"} owner={owner} follow={a.follow} reload={reload} />
    </li>
  );
}

const agentNameIn = (things: Things, id: string | undefined) => things.agents.find((a) => a.id === id)?.body.name || null;

// Something to write and send to their door: a comment, a note.
function SendBox({ to, body, label, placeholder, sent }: { to: string; body: (text: string) => Record<string, unknown>; label: string; placeholder: string; sent: () => unknown }) {
  const [text, setText] = useState("");
  const send = async () => {
    if (!text.trim()) return;
    const r = await post(to, body(text.trim()));
    if (!r.ok) return;
    setText("");
    toast("Sent. It shows here once their agentbook has it.");
    sent();
  };
  return (
    <div className="their-send">
      <textarea value={text} rows={2} placeholder={placeholder} onChange={(e) => setText(e.target.value)} />
      <button className="btn btn--sm" type="button" disabled={!text.trim()} onClick={send}>
        {label}
      </button>
    </div>
  );
}
// Comments on a thread of theirs, each by whoever wrote it; their answers under the ones they answer.
function CommentsOf({ comments }: { comments: TheirThing[] }) {
  if (!comments.length) return null;
  const answers = new Map(comments.filter((c) => c.body.to).map((c) => [c.body.to, c]));
  return (
    <ul className="their-comments">
      {comments
        .filter((c) => !c.body.to)
        .map((c) => (
          <li key={c.id}>
            <b>@{c.author}</b> <time>{ago(c.body.at)}</time>
            <Text text={c.body.text} />
            {answers.get(c.id) ? (
              <div className="their-answer">
                <b>@{answers.get(c.id)!.author}</b> <time>{ago(answers.get(c.id)!.body.at)}</time>
                <Text text={answers.get(c.id)!.body.text} />
              </div>
            ) : null}
          </li>
        ))}
    </ul>
  );
}

// Its plan, as its agent last wrote it.
const PLAN_MARK: Record<string, string> = { completed: "✓", in_progress: "▸" };
function PlanOf({ plan }: { plan: { text: string; status?: string }[] | undefined }) {
  if (!plan?.length) return null;
  return (
    <ul className="their-plan">
      {plan.map((x, i) => (
        <li key={i} className={`is-${x.status || "pending"}`}>
          <span aria-hidden="true">{PLAN_MARK[x.status || ""] || "○"}</span>
          {x.text}
        </li>
      ))}
    </ul>
  );
}
// Its work, a turn at a time as their door sent it (server/publish.ts's workRecords): what its agent did, and what it
// changed, diffs and all, read only. The latest turn is open; the others are a line each until you open one.
function WorkOf({ work }: { work: TheirThing[] }) {
  if (!work.length) return null;
  return (
    <section className="their-work">
      <h3>Work</h3>
      {[...work].reverse().map((w, i) => (
        <TurnOf key={w.id} w={w.body} open={i === 0} />
      ))}
    </section>
  );
}
type TheirStep = { id: string; kind: string; tool?: string; title?: string; text?: string; error?: string };
type TheirFile = { path: string; add?: number; del?: number; hunks?: unknown[]; more?: number; nodiff?: boolean; by?: string };
function TurnOf({ w, open }: { w: Record<string, any>; open: boolean }) {
  const steps: TheirStep[] = w.steps || [];
  const files: TheirFile[] = w.files || [];
  const cut = w.cut || {};
  return (
    <details className="their-turn" open={open}>
      <summary>
        <b>Turn {w.turn}</b>
        <span>{plural(steps.filter((s) => s.kind === "tool").length, "step")}</span>
        {files.length ? (
          <span>
            {plural(w.totals?.files ?? files.length, "file")} <ChgSize add={w.totals?.add} del={w.totals?.del} />
          </span>
        ) : null}
        {w.updated ? <time>{ago(w.updated)}</time> : null}
      </summary>
      {cut.steps ? <p className="muted">{plural(cut.steps, "earlier step")} of this turn left out.</p> : null}
      <ol className="their-steps">
        {steps.map((s) => (
          <li key={s.id} className={s.kind === "say" ? "is-say" : s.error ? "is-error" : undefined}>
            {s.kind === "say" ? <Text text={s.text} /> : <code>{s.title || s.tool}</code>}
            {s.error ? <span className="their-step-error">{s.error}</span> : null}
          </li>
        ))}
      </ol>
      {(w.commits || []).length > 0 && (
        <ul className="their-commits">
          {w.commits.map((c: { short: string; subject?: string }) => (
            <li key={c.short}>
              <code>{c.short}</code> {c.subject}
            </li>
          ))}
        </ul>
      )}
      {files.map((f) => (
        <details key={f.path} className="their-file">
          <summary>
            <PathParts p={f.path} />
            <ChgSize add={f.add} del={f.del} />
          </summary>
          <DiffView f={f as Parameters<typeof DiffView>[0]["f"]} />
        </details>
      ))}
      {cut.files ? <p className="muted">and {plural(cut.files, "more file")} it changed, left out.</p> : null}
    </details>
  );
}

// A thread of theirs: its title, its agent, how it stands, its pull requests and results, its plan, its latest
// messages, and its work.
function ThreadOf({ t, things, who, comments = [], work = [], reload }: { t: TheirThing; things: Things; who: Person; comments?: TheirThing[]; work?: TheirThing[]; reload?: () => unknown }) {
  const b = t.body;
  const agent = agentNameIn(things, b.agent);
  const msgs: { id?: string; from: string; text: string; at?: string; user?: string }[] = b.messages || [];
  return (
    <section className="card box their-thread">
      <p className="their-crumb">
        <a href={personHref(who.username)}>@{who.username}</a> · {b.talk ? "their own thread" : agent ? `${agent}'s thread` : "a thread"}
        {b.state ? ` · ${b.state}` : ""}
      </p>
      <h2>{b.title || "A thread"}</h2>
      {b.headline ? <p className="muted">{b.headline}</p> : null}
      <Names t={t} />
      {(b.prs || []).length > 0 && (
        <ul className="their-prs">
          {b.prs.map((p: Record<string, string>) => (
            <li key={p.url}>
              <a href={p.url} target="_blank" rel="noopener">
                {p.title || p.url}
              </a>
              {p.state ? <span className="chip">{p.state}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {(b.updates || []).length > 0 && (
        <ul className="their-results">
          {b.updates.map((u: { text: string; at: string }, i: number) => (
            <li key={i}>
              <Text text={u.text} />
              <time>{ago(u.at)}</time>
            </li>
          ))}
        </ul>
      )}
      <PlanOf plan={b.plan} />
      {b.earlier > 0 && <p className="muted">{plural(b.earlier, "earlier message")} stay on their agentbook.</p>}
      <ol className="their-msgs">
        {msgs.map((m, i) => (
          <li key={m.id || i} className={m.from === "human" ? "is-human" : "is-agent"}>
            <b>{m.from === "human" ? m.user || who.display_name : agent || "Their agent"}</b>
            {m.at ? <time>{ago(m.at)}</time> : null}
            <Text text={m.text} />
          </li>
        ))}
      </ol>
      <WorkOf work={work} />
      <p className="their-foot">Read only: it's {t.passed_on ? `${t.yours ? "yours" : `@${t.author || "someone"}'s`}, passed on by ${who.display_name.split(" ")[0]}` : `${who.display_name.split(" ")[0]}'s, on their agentbook`}.</p>
      <CommentsOf comments={comments} />
      {!t.space && !t.passed_on && reload ? (
        <SendBox to={`/api/people/${enc(who.username)}/things/${enc(t.id)}/comments`} body={(text) => ({ text })} label="Comment" placeholder={`Comment: ${who.display_name.split(" ")[0]} and everyone who sees this thread read it; its agent doesn't`} sent={reload} />
      ) : null}
    </section>
  );
}

// Where one of a group's threads goes: yours, theirs, or someone else's they pass on.
type GroupThread = Shown & { id: string; title?: string };
function threadHref(who: Person, gid: string, x: GroupThread) {
  if (x.you) return `#/threads/${enc(x.id)}`;
  return theirThingHref(who.username, x.username === who.username ? x.id : `group:${gid}/${x.id}`);
}
// A group of theirs you're in: its brief, who's in it, its threads and notes; your note, your threads in it, Leave.
function GroupOf({ t, things, who, reload }: { t: TheirThing; things: Things; who: Person; reload: () => unknown }) {
  const b = t.body;
  const spaces = useLoad<{ spaces: TheirSpace[] }>(`/api/people/${enc(who.username)}/spaces`);
  const rows = useApp((st) => st.rows);
  const space = spaces.data?.spaces.find((x) => x.space === `group:${t.id}`);
  const base = `/api/people/${enc(who.username)}/spaces/group/${enc(t.id)}`;
  const mineIn = new Set(space?.threads || []);
  const yours = Object.values(rows || {}).filter((r) => r.mine !== false && !r.talk && !mineIn.has(r.id));
  const [pick, setPick] = useState("");
  const act = async (p: string, body: Record<string, unknown>, said: string) => {
    const r = await post(p, body);
    if (!r.ok) return;
    toast(said);
    spaces.reload();
    reload();
  };
  return (
    <section className="card box their-group">
      <p className="their-crumb">
        <a href={personHref(who.username)}>@{who.username}</a> · their group, which you're in
      </p>
      <h2>
        {b.emoji ? `${b.emoji} ` : ""}
        {b.name || "A group"}
      </h2>
      {b.brief ? <Text text={b.brief} /> : <p className="muted">No brief.</p>}
      <p className="their-names">In it: {(b.members || []).map(shownName).join(", ")}</p>
      <h3>Threads</h3>
      <ul className="act-list">
        {(b.threads || []).map((x: GroupThread) => (
          <li key={`${x.username || x.handle}/${x.id}`} className="act-row">
            <span>
              <a href={threadHref(who, t.id, x)}>{(x.you ? threadRowTitle(rows, x.id) : null) || x.title || "A thread"}</a>
              <small>{x.you ? "Yours" : `${shownName(x)}'s`}</small>
            </span>
            {x.you ? (
              <button className="btn btn--sm btn--line" type="button" onClick={() => act(`${base}/threads`, { post: x.id, remove: true }, "Taken out of it.")}>
                Take out
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {yours.length > 0 && (
        <div className="their-send">
          <select value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Put a thread of yours in it…</option>
            {yours.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title || r.label}
              </option>
            ))}
          </select>
          <button className="btn btn--sm" type="button" disabled={!pick} onClick={() => act(`${base}/threads`, { post: pick }, "Put in. The others see its conversation, not its steps.")}>
            Put in
          </button>
        </div>
      )}
      <h3>Notes</h3>
      {(b.notes || []).length ? (
        <ul className="their-comments">
          {[...b.notes].reverse().map((n: { id: string; by: string; text: string; at: string }) => (
            <li key={n.id}>
              <b>{n.by}</b> <time>{ago(n.at)}</time>
              <Text text={n.text} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No notes yet.</p>
      )}
      <SendBox to={`${base}/propose`} body={(text) => ({ what: "note", body: { text } })} label="Leave a note" placeholder="A note: everyone in it reads it, and their threads in it hear it as yours" sent={reload} />
      <p className="their-foot">
        <button className="btn btn--sm btn--line" type="button" onClick={() => act(`${base}/leave`, {}, "You left it.")}>
          Leave the group
        </button>
      </p>
    </section>
  );
}
const threadRowTitle = (rows: Record<string, { title?: string; label?: string }> | undefined, id: string) => rows?.[id]?.title || rows?.[id]?.label || null;

// A note of theirs you're on: its text, its comments, yours.
function NoteOf({ t, things, who, reload }: { t: TheirThing; things: Things; who: Person; reload: () => unknown }) {
  const b = t.body;
  return (
    <section className="card box their-note">
      <p className="their-crumb">
        <a href={personHref(who.username)}>@{who.username}</a> · their note, which you're on
      </p>
      <h2>{b.title || "A note"}</h2>
      <Text text={b.text} />
      {(b.comments || []).length > 0 && (
        <ul className="their-comments">
          {b.comments.map((c: { id: string; by: string; text: string; at: string }) => (
            <li key={c.id}>
              <b>{c.by}</b> <time>{ago(c.at)}</time>
              <Text text={c.text} />
            </li>
          ))}
        </ul>
      )}
      <SendBox to={`/api/people/${enc(who.username)}/spaces/note/${enc(t.id)}/propose`} body={(text) => ({ what: "comment", body: { text } })} label="Comment" placeholder="A comment on the note" sent={reload} />
    </section>
  );
}

// The groups, tasks, pages and notes of theirs you're asked into or in: yes or no, open, leave.
const KIND_WORD: Record<TheirSpace["kind"], string> = { group: "group", task: "task", page: "page", note: "note" };
function TheirSpaces({ who, things, reload }: { who: Person; things: Things; reload: () => unknown }) {
  const spaces = useLoad<{ spaces: TheirSpace[] }>(`/api/people/${enc(who.username)}/spaces`);
  const list = spaces.data?.spaces || [];
  if (!list.length) return null;
  const act = async (x: TheirSpace, p: string, body: Record<string, unknown>, said: string) => {
    const r = await post(`/api/people/${enc(who.username)}/spaces/${x.kind}/${enc(x.id)}${p}`, body);
    if (!r.ok) return;
    toast(said);
    spaces.reload();
    reload();
  };
  const has = (x: TheirSpace) => [...things.groups, ...things.notes, ...things.pages].some((r) => r.id === x.id);
  return (
    <section className="card box">
      <h3>Shared with you</h3>
      <ul className="act-list">
        {list.map((x) => (
          <li key={x.space} className="act-row their-space">
            <span>
              <b>{x.name || `A ${KIND_WORD[x.kind]}`}</b>
              <small>
                their {KIND_WORD[x.kind]}
                {x.state === "asked" ? ` · they asked you in ${agoText(x.at)}` : " · you're in it"}
              </small>
            </span>
            {x.state === "asked" ? (
              <>
                <button className="btn btn--sm" type="button" onClick={() => act(x, "", { yes: true }, "You're in. What's in it comes from their agentbook.")}>
                  Say yes
                </button>
                <button className="btn btn--sm btn--line" type="button" onClick={() => act(x, "", { yes: false }, "Said no.")}>
                  No
                </button>
              </>
            ) : (
              <>
                {x.kind !== "task" && has(x) ? (
                  <a className="btn btn--sm btn--line" href={theirThingHref(who.username, x.id)}>
                    Open
                  </a>
                ) : null}
                <button className="btn btn--sm btn--line" type="button" onClick={() => act(x, "/leave", {}, "You left it.")}>
                  Leave
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// A page of theirs, its current version, the widgets drawn from their data.
function PageOf({ t, things, who }: { t: TheirThing; things: Things; who: Person }) {
  const b = t.body;
  return (
    <section className="their-page">
      <p className="their-crumb">
        <a href={personHref(who.username)}>@{who.username}</a> · their page{b.version ? `, v${b.version}` : ""}
      </p>
      <h2>
        {b.emoji ? `${b.emoji} ` : ""}
        {b.title || "A page"}
      </h2>
      {b.about ? <Text text={b.about} /> : null}
      <Names t={t} />
      {(b.widgets || []).map((w: { id: string; type: string; title?: string; data?: unknown }) => (
        <section key={w.id} className="card box">
          {w.title ? <h3>{w.title}</h3> : null}
          {DRAWN.has(w.type) ? <WidgetBody w={{ type: w.type as WidgetType, title: w.title || "", data: unpictured(w.data || {}) as never }} /> : <p className="muted">A {w.type} widget, which shows on their own page only.</p>}
        </section>
      ))}
    </section>
  );
}

// One thing of theirs, opened (#/people/<them>/things/<id>).
export function TheirThing({ who, id, things }: { who: Person; id: string; things: Things }) {
  const one = useLoad<{ thing: TheirThing; comments: TheirThing[]; work?: TheirThing[] }>(`/api/people/${enc(who.username)}/things/${enc(id)}`);
  if (one.missing) return <p className="list-empty">They haven't sent that, or took it back.</p>;
  if (!one.data) return <p className="muted">{one.error || "Loading…"}</p>;
  const t = one.data.thing;
  return (
    <>
      <AsOf things={things} />
      {t.type === "thread" ? (
        <ThreadOf t={t} things={things} who={who} comments={one.data.comments || []} work={one.data.work || []} reload={one.reload} />
      ) : t.type === "page" ? (
        <PageOf t={t} things={things} who={who} />
      ) : t.type === "group" ? (
        <GroupOf t={t} things={things} who={who} reload={one.reload} />
      ) : t.type === "note" ? (
        <NoteOf t={t} things={things} who={who} reload={one.reload} />
      ) : (
        <p className="muted">A {t.type} of theirs.</p>
      )}
    </>
  );
}

// Their profile's tab, from what their door sent: threads, agents, pages, or about (their tasks).
export function TheirTab({ who, tab, things, reload }: { who: Person; tab: string; things: Things | null; reload: () => unknown }) {
  const first = who.display_name.split(" ")[0];
  if (!things) return <p className="muted">Loading what {first} shares…</p>;
  const card = (title: string, empty: string, list: ReactNode[]) => (
    <section className="card box">
      <h3>{title}</h3>
      {list.length ? <ul className="act-list">{list}</ul> : <p className="list-empty">{empty}</p>}
    </section>
  );
  const body =
    tab === "agents"
      ? card(
          "Agents",
          `${first} has no public agent.`,
          things.agents.map((a) => <AgentRowOf key={a.id} a={a} owner={who.username} reload={reload} />),
        )
      : tab === "pages"
        ? card(
            "Pages",
            `${first} hasn't shared a page with you.`,
            things.pages.map((p) => (
              <li key={p.id}>
                <a className="act-row" href={theirThingHref(who.username, p.id)}>
                  <span className="pg-ico">{p.body.emoji || "📄"}</span>
                  <span>
                    <b>{p.body.title || "A page"}</b>
                    <small>
                      v{p.body.version || 1}
                      {p.body.updated ? `, changed ${agoText(p.body.updated)}` : ""}
                    </small>
                  </span>
                </a>
              </li>
            )),
          )
        : tab === "about"
          ? card(
              "Tasks",
              `${first} hasn't shared a task with you.`,
              things.tasks.map((k) => (
                <li key={k.id} className="act-row">
                  <Icon name={k.body.done ? "check" : "steps"} />
                  <span>
                    <b>{k.body.title}</b>
                    <small>
                      {k.body.done ? `Done ${agoText(k.body.done_at)}` : plural((k.body.threads || []).length, "thread")}
                      {k.body.people?.length ? ` · with ${k.body.people.map(shownName).join(", ")}` : ""}
                      {(k.body.prs || []).length ? ` · ${plural(k.body.prs.length, "pull request")}` : ""}
                    </small>
                    {k.body.note ? <Text text={k.body.note} /> : null}
                  </span>
                </li>
              )),
            )
          : card(
              "Threads",
              `${first} hasn't shared a thread with you.`,
              [...things.threads]
                .sort((a, b) => String(b.body.updated || "").localeCompare(String(a.body.updated || "")))
                .map((t) => (
                  <li key={t.id}>
                    <a className="act-row" href={theirThingHref(who.username, t.id)}>
                      <span className="pg-ico">
                        <Icon name={t.body.talk ? "pencil" : "bot"} />
                      </span>
                      <span>
                        <b>{t.body.title || "A thread"}</b>
                        <small>
                          {t.body.talk ? "Their own" : agentNameIn(things, t.body.agent) || "An agent"}
                          {t.body.last ? ` · ${String(t.body.last.text).slice(0, 120)}` : ""}
                        </small>
                      </span>
                      {t.body.state ? <span className="chip">{t.body.state}</span> : null}
                      <time>{ago(t.body.updated)}</time>
                    </a>
                  </li>
                )),
            );
  return (
    <>
      <AsOf things={things} />
      <TheirSpaces who={who} things={things} reload={reload} />
      {body}
    </>
  );
}
