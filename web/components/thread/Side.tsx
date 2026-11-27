// A thread's page's side column: About this thread (its agent, its pull requests, its project and branch, when it
// started, its model, the thread it was started from, its machine, how it runs and hears you) with its buttons (a
// terminal in its folder, its cloud's, Copy the resume command, Link a pull request); the threads it started; its
// group; its loops; the routines that write to it; who can see it; and its agent's other threads.
import { useState } from "react";
import { agentName, appName, drivenBy, fromNow, kindCaps, postOwner, routineWhen, runtimeOfRow, tildeOn } from "../../lib/agents.ts";
import { post } from "../../lib/api.ts";
import { agoText, dayTime, groupStyle, model, plural, tokens } from "../../lib/format.ts";
import { agentHref, groupHref, routineHref } from "../../lib/route.ts";
import { agentOf, allRows, useAgent, useApp } from "../../lib/store.ts";
import { openTerminal, terminalShown } from "../../lib/terminal.ts";
import { toast } from "../../lib/toast.ts";
import type { GroupRow, Thread } from "../../lib/types.ts";
import { Avatar } from "../Avatar.tsx";
import { myRoutines } from "../bar/bell.ts";
import { modeName } from "../bar/compose-state.ts";
import { groupById, groupIn, groupThreads } from "../groups/groups.ts";
import { Icon } from "../Icon.tsx";
import { MenuPick } from "../MenuPick.tsx";
import type { MenuRow } from "../MenuPick.tsx";
import { threadGroupTo } from "../post/PostHead.tsx";
import { useStartedFrom } from "../post/util.tsx";
import { GrIco } from "../tasks/Chips.tsx";
import { ThreadRows } from "../ThreadRow.tsx";
import { PrivacyCard } from "../Visibility.tsx";
import { useWorld, wipHref, wipOfPost } from "../worktrees/wips.ts";
import { applyCloud, OffButton, teleport } from "./Actions.tsx";
import { modesOf, modeWaits, ranOn, switchesHere, switchTo } from "./Switch.tsx";
import { PR_CHIP, openPrLink, prReady, prsOf } from "./Results.tsx";
import { loopAct, useLoopBusy } from "../post/Loops.tsx";

// Copied, to paste in a terminal.
async function copy(text: string) {
  await navigator.clipboard?.writeText(text).catch(() => {});
  toast("Copied. Paste it in a terminal.");
}

// A terminal in its folder, on its machine (lib/terminal.ts), for its owner; not for one that runs in the cloud.
// While it opens one, it says so, unless one is on the page already (only hidden).
export function TermButton({ s }: { s: Thread }) {
  const [busy, setBusy] = useState<"" | "wait" | "opening">("");
  if (s.mine === false || s.rt?.kind === "cloud" || !(s.cwd || s.root)) return null;
  const title = s.offline ? `${s.machine || "Its machine"} is off` : `A shell in ${tildeOn(s.machine, s.cwd || s.root)}, on ${s.machine || "its machine"}`;
  return (
    <button
      className="btn btn--line"
      type="button"
      data-terminal={s.id}
      disabled={!!s.offline || !!busy}
      title={title}
      onClick={async () => {
        setBusy(terminalShown(s.id) ? "wait" : "opening");
        await openTerminal(s, {});
        setBusy("");
      }}
    >
      <Icon name="terminal" />
      {busy === "opening" ? "Opening a shell…" : "Open terminal"}
    </button>
  );
}

const modelName = (agentId: string | null, m: string) => agentOf(agentId).models?.list?.find((x) => x.id === m)?.name || model(m);
// The session's model. Where agentbook can switch it (switchesHere: a driven thread whose machine lists its models,
// Codex's; a Claude Code session in the background or one that ended) it's a picker, and what you pick takes over from
// the session's next turn, as the chips under its reply box say too. A session in a terminal or in the cloud switches
// there.
const switchable = (s: Thread) => switchesHere(s) && (drivenBy(s) ? !!s.rt.models : !!kindCaps(agentOf(s.agent).kind)?.models);
export function ModelRow({ s }: { s: Thread }) {
  // Drawn again when a switch was refused, so it shows what's picked still.
  const [refused, setRefused] = useState(0);
  const m = useAgent(s.agent).models;
  const now = s.model ? modelName(s.agent, s.model) : "";
  if (!switchable(s) || !m?.list?.length)
    return now ? (
      <>
        <dt>Model</dt>
        <dd>{now}</dd>
      </>
    ) : null;
  const ran = ranOn(s, m.list);
  const pick = s.model_pick || ran;
  return (
    <>
      <dt>Model</dt>
      <dd>
        <select
          key={`${pick}|${refused}`}
          className="model-pick"
          data-model-pick={s.id}
          aria-label="Model"
          defaultValue={pick}
          onChange={(e) => {
            const sel = e.currentTarget;
            const value = sel.value === ran ? "" : sel.value;
            sel.blur();
            switchTo(s, "model", value).then((r) => {
              if (r.ok && value) toast(`It switches to ${modelName(s.agent, value)} from its next turn.`);
              if (!r.ok) setRefused((n) => n + 1);
            });
          }}
        >
          {!ran && <option value="">{now || "Its default"}</option>}
          {m.list.map((x) => (
            <option key={x.id} value={x.id}>
              {x.id === ran ? now : x.name}
            </option>
          ))}
        </select>
        {s.model_pick && <small className="model-next">{modelName(s.agent, s.model_pick)} from its next turn</small>}
      </dd>
    </>
  );
}

// The mode it's in (shared/runtimes.ts's Mode): how much it does without asking. Full access, which never asks, in the
// warning color. Where agentbook can switch it, a picker, as Model is: from its next turn, or at once where its
// runtime switches a live session's mode.
export function ModeRow({ s }: { s: Thread }) {
  const [refused, setRefused] = useState(0);
  const modes = switchesHere(s) ? modesOf(s) : [];
  if (!modes.length)
    return s.mode ? (
      <>
        <dt>Mode</dt>
        <dd className={s.mode === "full" ? "mode-full" : undefined}>{s.mode === "full" ? "Full access, never asks" : modeName(s.mode)}</dd>
      </>
    ) : null;
  const pick = s.mode_pick || s.mode || "";
  const waits = modeWaits(s);
  return (
    <>
      <dt>Mode</dt>
      <dd className={pick === "full" ? "mode-full" : undefined}>
        <select
          key={`${pick}|${refused}`}
          className="model-pick"
          data-mode-pick={s.id}
          aria-label="Mode"
          defaultValue={pick}
          onChange={(e) => {
            const sel = e.currentTarget;
            sel.blur();
            switchTo(s, "mode", sel.value).then((r) => {
              if (!r.ok) setRefused((n) => n + 1);
            });
          }}
        >
          {!s.mode && <option value="">Not known</option>}
          {/* A select is as wide as its longest option: names only, as Model's are. */}
          {modes.map((x) => (
            <option key={x} value={x}>
              {x === "full" ? "Full access" : modeName(x)}
            </option>
          ))}
        </select>
        {s.mode_pick && <small className="model-next">{waits ? `${modeName(s.mode_pick)} from its next turn` : `Switching to ${modeName(s.mode_pick)}…`}</small>}
      </dd>
    </>
  );
}

// The thread one was started from, in About on its page, where its owner picks it: for a thread nothing says it of
// (Claude Desktop says which session started one only for its tasks). Any thread they see but itself and the ones it
// started; the server refuses one further down. "None" takes it off.
export function FromRow({ s }: { s: Thread }) {
  const f = useStartedFrom(s);
  const started = useApp((st) => (st.open?.detail?.id === s.id ? st.open.detail.startedThreads : null));
  useApp((st) => st.rows);
  useApp((st) => st.more);
  if (s.mine === false)
    return f ? (
      <>
        <dt>Started from</dt>
        <dd>
          <a href={`#/threads/${encodeURIComponent(f.id)}`} title={f.title || ""}>
            {f.label}
          </a>
        </dd>
      </>
    ) : null;
  const mine = new Set((started || []).map((r) => r.id));
  const rows: MenuRow[] = allRows()
    .filter((r) => r.id !== s.id && !mine.has(r.id) && !r.talk && (!r.archived || r.id === f?.id))
    .sort((a, b) => (b.updated || b.started || "").localeCompare(a.updated || a.started || ""))
    .map((r) => ({ value: r.id, text: r.title || r.label, find: `${r.label} ${r.title || ""}`, face: <Avatar agent={r.agent} size="av--xs" />, note: r.label, on: r.id === f?.id }));
  if (f && !rows.some((r) => r.on)) rows.unshift({ value: f.id, text: f.title || f.label, face: <Avatar agent={f.agent} size="av--xs" />, note: f.label, on: true });
  if (!rows.length) return null;
  const face = f ? <span className="opt-v">{f.label}</span> : <span className="opt-v muted">Pick a thread</span>;
  return (
    <>
      <dt>Started from</dt>
      <dd className="kv-from">
        <MenuPick
          id={`from:${s.id}`}
          label="Thread"
          title={f ? `Started from ${f.label}${f.title ? `: ${f.title}` : ""}` : "The thread this one was started from"}
          face={face}
          find
          none={!f}
          rows={[...(f ? [{ value: "", text: "None" }, { divider: "" }] : []), ...rows]}
          onPick={(v) => void post(`/api/sessions/${encodeURIComponent(s.id)}/from`, { from: v || null })}
        />
      </dd>
    </>
  );
}

function PrsRow({ s }: { s: Thread }) {
  const prs = prsOf(s);
  if (!prs.length) return null;
  return (
    <>
      <dt>{prs.length > 1 ? "Pull requests" : "Pull request"}</dt>
      <dd className="kv-prs">
        {prs.map((p, i) => {
          const chip = p.gh ? PR_CHIP[p.gh.state] || PR_CHIP.open : null;
          return (
            <span key={p.url}>
              {i ? " " : ""}
              <a href={p.url} target="_blank" rel="noopener">
                #{p.number}
              </a>
              {chip && (
                <>
                  {" "}
                  <span className={`chip ${chip[1]}`}>{prReady(p.gh) ? "Ready" : chip[0]}</span>
                </>
              )}
            </span>
          );
        })}
      </dd>
    </>
  );
}
function ProjectRow({ s }: { s: Thread }) {
  useWorld();
  if (!s.repo) return null;
  const w = s.branch && s.branch !== "HEAD" ? wipOfPost(s) : null;
  return (
    <>
      <dt>Project</dt>
      <dd title={s.root || undefined}>
        {s.repo}
        {s.branch && s.branch !== "HEAD" ? (
          <>
            , on {w ? <a href={wipHref(w)}>{s.branch}</a> : s.branch}
          </>
        ) : null}
      </dd>
    </>
  );
}

function AboutCard({ s }: { s: Thread }) {
  const driven = drivenBy(s);
  const bg = s.rt?.kind === "background";
  const resume = driven ? s.rt.resume || "" : s.session_id ? `cd ${s.cwd || s.root || "."} && claude --resume ${s.session_id}` : "";
  const inCloud = s.rt?.kind === "cloud";
  // A cloud's own words for where its thread runs, and whether its work is applied here (Codex Cloud's) or brought
  // over by teleport (claude.ai's).
  const cloud = runtimeOfRow(s);
  const runs = s.offline ? "" : inCloud ? cloud.placeWords?.runs || "" : driven ? `In ${driven.name}` : bg ? "In the background" : s.effective === "done" ? "" : appName(s) ? `In ${appName(s)}` : "In a terminal";
  const owner = postOwner(s);
  return (
    <section className="card rail-card">
      <h3 className="rail-h">About this thread</h3>
      <dl className="kv">
        <dt>Agent</dt>
        <dd>
          <a href={agentHref(s.agent)}>
            <b className={s.agent == null ? "redacted" : undefined}>{agentName(s.agent)}</b>
          </a>
        </dd>
        <dt>Posted as</dt>
        <dd>{s.label}</dd>
        <PrsRow s={s} />
        <ProjectRow s={s} />
        <dt>Started</dt>
        <dd>
          {new Date(s.started).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
          {s.launch ? ", from agentbook" : ""}
        </dd>
        <ModelRow s={s} />
        <ModeRow s={s} />
        <FromRow s={s} />
        {s.machine ? (
          <>
            <dt>Machine</dt>
            <dd>
              {s.mine !== false ? <a href={`#/machines/${encodeURIComponent(s.machine)}`}>{s.machine}</a> : s.machine}
              {s.offline ? ", off" : ""}
              {s.host && s.host !== s.machine ? ` (it runs on ${s.host})` : ""}
            </dd>
          </>
        ) : s.host ? (
          <>
            <dt>Machine</dt>
            <dd>{s.host}</dd>
          </>
        ) : null}
        {s.context ? (
          <>
            <dt>Context</dt>
            <dd>{tokens(s.context)} tokens</dd>
          </>
        ) : null}
        {runs && s.mine !== false ? (
          <>
            <dt>Runs</dt>
            <dd>{runs}</dd>
          </>
        ) : null}
        {s.mine === false ? (
          <>
            <dt>Owner</dt>
            <dd>
              <a href={`#/people/${owner}`}>@{owner}</a>
            </dd>
          </>
        ) : null}
        {s.off && s.mine !== false ? (
          <>
            <dt>Following</dt>
            <dd title="Nothing of its session comes here since. The session itself goes on.">Stopped {dayTime(s.off)}</dd>
          </>
        ) : null}
        {s.state !== "done" && !driven && !inCloud && !s.off && s.mine !== false ? (
          <>
            <dt>Delivery</dt>
            <dd>{s.channel ? "Live" : bg ? "Between turns, and wakes it when idle" : "At the end of each turn"}</dd>
          </>
        ) : null}
      </dl>
      {s.mine !== false && (
        <div className="side-acts">
          <TermButton s={s} />
          {inCloud &&
            (cloud.caps.applies ? (
              <>
                <button className="btn btn--line" type="button" data-apply={s.id} onClick={(e) => applyCloud(e, s.id)}>
                  <Icon name="check" />
                  Apply to a local checkout
                </button>
                <button className="btn btn--line" type="button" data-copy={s.rt.apply} onClick={() => copy(s.rt.apply)}>
                  <Icon name="copy" />
                  Copy <code>{s.rt.apply}</code>
                </button>
              </>
            ) : (
              <>
                <button className="btn btn--line" type="button" data-teleport={s.id} onClick={() => teleport(s)}>
                  <Icon name="terminal" />
                  Teleport here
                </button>
                <button className="btn btn--line" type="button" data-copy={s.rt.teleport} onClick={() => copy(s.rt.teleport)}>
                  <Icon name="copy" />
                  Copy the teleport command
                </button>
              </>
            ))}
          {resume && s.state === "done" && !inCloud && (
            <button className="btn btn--line" type="button" data-copy={resume} onClick={() => copy(resume)}>
              <Icon name="copy" />
              Copy the resume command
            </button>
          )}
          <button className="btn btn--line" type="button" data-pr-link={s.id} onClick={() => openPrLink(s.id)}>
            <Icon name="link" />
            Link a pull request
          </button>
          <OffButton s={s} />
        </div>
      )}
    </section>
  );
}

/* ---------- its group ---------- */

// The menu that puts a thread in one of your groups, moves it or takes it out: your groups (and the ones you're in),
// found by their names as you type, the one it's in ticked; New group, which makes one named after what you typed;
// and No group.
function GroupPick({ s, g }: { s: Thread; g: GroupRow | null }) {
  const groups = useApp((st) => st.data?.groups) || [];
  const mine = groups.filter((x) => !x.archived && groupIn(x) && x.id !== g?.id);
  const rows: MenuRow[] = [
    ...(g ? [g] : []).concat(mine).map((x) => ({ value: x.id, text: x.name, face: <GrIco g={x} />, on: x === g })),
    { divider: "" },
    { value: "~new", text: "New group…", face: <Icon name="plus" />, make: "New group" },
    { value: "~none", text: "No group", face: <Icon name="x" />, on: !g, title: g ? `Take it out of ${g.name}` : "It's in no group" },
  ];
  const face = (
    <>
      <Icon name="group" />
      <span className="opt-v">{g ? "Move it" : "Add it to a group"}</span>
      <Icon name="down" className="caret" />
    </>
  );
  return (
    <MenuPick
      id={`thread-group:${s.id}`}
      label="Group"
      title={g ? `In ${g.name}: move it to another group, or take it out` : "Put it in one of your groups"}
      face={face}
      rows={rows}
      find
      onPick={(v) => {
        if (v && v !== (g?.id || "~none")) void threadGroupTo(s, v);
      }}
    />
  );
}
function GroupSideCard({ s }: { s: Thread }) {
  const g = useApp((st) => (s.group ? groupById(s.group) || null : null));
  useApp((st) => st.rows);
  if (s.mine === false) return null;
  if (!g)
    return (
      <section className="card rail-card">
        <h3 className="rail-h">Group</h3>
        <p className="muted side-p">Not in a group. In one, it would see the other threads there and share their files.</p>
        <GroupPick s={s} g={null} />
      </section>
    );
  const others = groupThreads(g)
    .filter((x) => x.id !== s.id)
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  return (
    <section className="card rail-card" style={groupStyle(g)}>
      <h3 className="rail-h">
        <span className="gr-title">
          <span className="gr-ico">{g.emoji || "👥"}</span>
          {g.name}
        </span>
        <a href={groupHref(g)}>Open</a>
      </h3>
      <p className="muted side-p">
        It sees the brief, {plural(others.length, "other thread")} and {plural(g.files || 0, "file")}. <a href={groupHref(g, "brief")}>What it's told</a>
      </p>
      <ThreadRows list={others.slice(0, 6)} />
      <GroupPick s={s} g={g} />
    </section>
  );
}

/* ---------- its loops ---------- */

// A loop as its thread has it (the server's relay view of it): what it's called, whose, when next and how it's
// scheduled, how many times it ran and when last, when it stopped or ends, a Codex automation's page, and what you
// may do to it.
interface SideLoop {
  id: string;
  name: string;
  agent: string;
  what?: string;
  live?: boolean;
  next?: string | null;
  ended?: string | null;
  expires?: string | null;
  enabled?: boolean;
  last?: string | null;
  runs?: number | null;
  repeats?: boolean;
  schedule?: { kind?: string; reason?: string } | null;
  acts?: string[];
  url?: string;
}
const repeats = (l: SideLoop) => l.repeats !== false;
function LoopLi({ l }: { l: SideLoop }) {
  const busy = useLoopBusy((b) => b.busy === l.id);
  const when = l.live ? routineWhen(l) : l.ended ? `Stopped ${agoText(l.ended)}` : l.expires && Date.parse(l.expires) < Date.now() ? `Ended ${agoText(l.expires)}, a week after it began` : !l.enabled && l.agent === "codex" ? "Paused" : "Not running";
  const ran = l.runs != null ? (l.runs ? `Ran ${plural(l.runs, "time")}${l.last ? `, last ${agoText(l.last)}` : ""}` : "Hasn't run yet") : l.last ? `Ran ${agoText(l.last)}` : "";
  const ends = l.live && l.expires ? `Ends ${dayTime(l.expires)}` : "";
  const acts = l.acts || [];
  return (
    <li className={l.live ? "" : "is-off"}>
      <span className={`rt-dot rt-dot--${l.live ? "ok" : "off"}`} />
      <div>
        <a className="loop-name" href={agentHref(l.agent, `routines/${encodeURIComponent(l.id)}`)} title={l.what}>
          {l.name}
        </a>
        <small>{when}</small>
        {l.schedule?.kind === "paced" && l.schedule.reason && l.live && <small className="rt-what">{l.schedule.reason}</small>}
        {(ran || ends) && <small>{[ran, ends].filter(Boolean).join(" · ")}</small>}
        {acts.length ? (
          <div className="rt-acts">
            {acts.includes("run") && (
              <button className="btn btn--line btn--sm" type="button" data-loop-act="run" disabled={busy} onClick={() => loopAct(l, "run")}>
                <Icon name="play" />
                Run now
              </button>
            )}
            {acts.includes("stop") && (
              <button className="btn btn--line btn--sm" type="button" data-loop-act="stop" disabled={busy} onClick={() => loopAct(l, "stop")}>
                <Icon name="stop" />
                Stop
              </button>
            )}
          </div>
        ) : l.url ? (
          <div className="rt-acts">
            <a className="btn btn--line btn--sm" href={l.url}>
              <Icon name="external" />
              Open in Codex
            </a>
          </div>
        ) : null}
      </div>
    </li>
  );
}
// A post's loops: what it runs again and again (/loop, or a Codex automation's heartbeat into its thread),
// when next, and how often it has. Run now writes the loop's prompt to the post; Stop asks the session to stop it.
function LoopsCard({ s }: { s: Thread }) {
  const list = (s.loops || []) as unknown as SideLoop[];
  if (!list.length) return null;
  const live = list.filter((l) => l.live).length;
  return (
    <section className="card rail-card">
      <h3 className="rail-h">
        {!list.some(repeats) ? "Checks back" : list.length > 1 ? "Loops" : "Loop"}
        {live > 1 && <span className="n">{live}</span>}
      </h3>
      <ul className="loops">
        {list.map((l) => (
          <LoopLi key={l.id} l={l} />
        ))}
      </ul>
    </section>
  );
}

/* ---------- the routines that write to it ---------- */

// The routines tied to a thread: each run is a message to it, from the routine. "Repeat…" makes one.
function ThreadRoutinesCard({ s }: { s: Thread }) {
  const data = useApp((st) => st.data);
  const list = myRoutines(data).filter((r) => (r.links || []).some((l) => l.kind === "thread" && l.id === s.id));
  const canResume = s.state !== "done" || !!kindCaps(agentOf(s.agent).kind)?.resumes;
  if (!list.length && !canResume) return null;
  return (
    <section className="card rail-card">
      <h3 className="rail-h">
        Routines{list.length > 0 && <span className="n">{list.length}</span>}
      </h3>
      {list.length ? (
        <ul className="rt-mini">
          {list.map((r) => (
            <li key={r.id}>
              <a href={routineHref(r.id)}>
                <span className={`rt-dot rt-dot--${!r.live_v || !r.on ? "off" : r.fails ? "error" : "ok"}`} />
                <span>
                  <b title={r.name}>{r.name}</b>
                  <small>{r.live_v ? (r.on ? `${r.when}${r.next ? `, next ${fromNow(r.next)}` : ""}` : "Off") : "Waits for your OK"}</small>
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Nothing writes to it on a schedule.</p>
      )}
      <div className="side-acts">
        <a className="btn btn--line" href={`#/routines/new?thread=${encodeURIComponent(s.id)}`}>
          <Icon name="repeat" />
          Repeat…
        </a>
      </div>
    </section>
  );
}

export function ThreadSide({ s }: { s: Thread }) {
  const detail = useApp((st) => (st.open?.detail?.id === s.id ? st.open.detail : null));
  const started = detail?.startedThreads || [];
  const others = detail?.others || [];
  return (
    <>
      <AboutCard s={s} />
      {/* The threads it started (a Claude Desktop session's tasks), oldest first. */}
      {started.length > 0 && (
        <section className="card rail-card">
          <h3 className="rail-h">
            Threads it started <span className="n">{started.length}</span>
          </h3>
          <ThreadRows list={started} agent={false} />
        </section>
      )}
      {s.mine && <GroupSideCard s={s} />}
      {s.mine && <LoopsCard s={s} />}
      {s.mine && <ThreadRoutinesCard s={s} />}
      {s.mine && <PrivacyCard s={s} />}
      {others.length > 0 && (
        <section className="card rail-card">
          <h3 className="rail-h">
            {agentName(s.agent)}'s other threads <a href={`#/agents/${s.agent}`}>See all</a>
          </h3>
          <ThreadRows list={others} agent={false} />
        </section>
      )}
    </>
  );
}
