// The welcome card, on top of the feed (A): for each machine of yours whose history nobody
// has picked yet, the agents found on it and what they did before, per day, to bring in as far back as you pick.
// Then it shows the bringing in, and what came, until you dismiss it. A machine that joins later gets the same card.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { HISTORY_DAYS, countBy, perDay, perFolder, picked } from "../../../plugin/shared/history.ts";
import type { HistoryRead, Leaveouts, Range } from "../../../plugin/shared/history.ts";
import { RUNTIMES, isRuntimeId } from "../../../plugin/shared/runtimes.ts";
import { isCloudRuntime } from "../../lib/agent-groups.ts";
import { getJSON, post } from "../../lib/api.ts";
import { hueVars, plural } from "../../lib/format.ts";
import { usePref } from "../../lib/hooks.ts";
import { setupHref } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { RuntimeRow, Runtimes } from "../../lib/types.ts";
import { Avatar } from "../Avatar.tsx";
import { Icon } from "../Icon.tsx";
import { hideAgent } from "../Visibility.tsx";

const RANGES: [Range, string][] = [[0, "Nothing"], [1, "Today"], [7, "7 days"], [30, "30 days"], [null, "All"]];
const n = (x: number) => x.toLocaleString("en-US");
const dayLabel = (today: string, back: number) => {
  const d = new Date(`${today}T12:00:00`);
  d.setDate(d.getDate() - back);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};
const folderName = (f: string) => f.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, "~");
// A folder as its last name, with where it is before it: the name stays whole, where it is gives way.
const path = { dirname: (f: string) => f.replace(/\/[^/]*\/?$/, "") || "/", basename: (f: string) => f.replace(/\/$/, "").split("/").pop() || f };

// Every machine of yours that's waiting for a pick, or bringing its past in, or just did: a card each.
export function WelcomeCards() {
  const machines = useApp((s) => s.data?.machines);
  const mine = (machines || []).filter((m) => m.mine && (m.history === "pending" || m.history === "importing" || m.history === "imported"));
  if (!mine.length) return null;
  return (
    <>
      {mine.map((m) => (
        <WelcomeCard key={m.name} machine={m.name} here={!!m.here} online={m.online !== false} first={(machines || []).filter((x) => x.mine).length < 2} />
      ))}
    </>
  );
}

function WelcomeCard({ machine, here, online, first }: { machine: string; here: boolean; online: boolean; first: boolean }) {
  const me = useApp((s) => s.me);
  const [h, setH] = useState<HistoryRead | null>(null);
  const [rt, setRt] = useState<Runtimes | null>(null);
  const [failed, setFailed] = useState(false);
  const [dismissed, setDismissed] = usePref<string>(`welcome.${machine}`, "");
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout>>(null);
  const m = encodeURIComponent(machine);

  const load = useCallback(async () => {
    const [hist, runtimes] = await Promise.all([getJSON<HistoryRead>(`/api/history?machine=${m}`).catch(() => null), getJSON<Runtimes>(`/api/runtimes?machine=${m}`).catch(() => null)]);
    if (!alive.current) return;
    setFailed(!hist);
    if (hist) setH(hist);
    if (runtimes) setRt(runtimes);
    // Only while its past is coming in: the card then says how far along it is.
    clearTimeout(timer.current);
    if (hist?.progress && !hist.progress.finished) timer.current = setTimeout(load, 2000);
  }, [m]);
  useEffect(() => {
    alive.current = true;
    load();
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
    };
  }, [load]);

  if (!online && !h) return null;
  if (failed && !h)
    return (
      <section className="card ob-card">
        <p className="muted">
          Couldn't read what {machine}'s agents did before. <button className="btn btn--sm" type="button" onClick={() => void load()}>Try again</button>
        </p>
      </section>
    );
  if (!h) return null;
  const p = h.progress;
  if (!h.pending && p) {
    if (p.finished && dismissed === p.started) return null;
    return <Progress h={h} onDismiss={() => setDismissed(p.started)} />;
  }
  if (!h.pending) return null;
  return <Pick h={h} rt={rt} machine={machine} here={here} first={first} name={me?.display_name?.split(" ")[0] || me?.username || ""} username={me?.username || ""} onPicked={load} />;
}

function Pick({ h, rt, machine, here, first, name, username, onPicked }: { h: HistoryRead; rt: Runtimes | null; machine: string; here: boolean; first: boolean; name: string; username: string; onPicked: () => void }) {
  const [range, setRange] = useState<Range>(30);
  const [offAgents, setOffAgents] = useState<Set<string>>(new Set());
  const [outFolders, setOutFolders] = useState<Set<string>>(new Set());
  const [showFolders, setShowFolders] = useState(false);
  const [codexTools, setCodexTools] = useState(true);
  const [busy, setBusy] = useState(false);
  const agents = useApp((s) => s.data?.agents);
  const rows = (rt?.runtimes || []).filter((r) => !r.remote && isRuntimeId(r.kind) && !isCloudRuntime(r.kind));
  const found = rows.filter((r) => r.ok || r.status === "Waiting for approval");
  const missing = rows.filter((r) => !found.includes(r) && r.install);
  const out: Leaveouts = useMemo(() => ({ agents: offAgents, folders: outFolders }), [offAgents, outFolders]);
  const list = picked(h, range, out);
  const by = countBy(h, list);
  const all = countBy(h, picked(h, range, { agents: new Set(), folders: outFolders }));
  const folders = perFolder(h, range, offAgents);
  const toggle = (set: Set<string>, k: string) => {
    const s = new Set(set);
    if (s.has(k)) s.delete(k);
    else s.add(k);
    return s;
  };
  const sessionsOf = (kind: string) => h.sessions.filter(([a]) => h.agents[a]?.kind === kind).length;
  const go = async () => {
    setBusy(true);
    try {
      const r = await post("/api/history", { machine, days: range, out_agents: [...offAgents], out_folders: [...outFolders], codex_tools: !offAgents.has("codex") && codexTools, claude_plugin: !offAgents.has("claude-code") });
      if (!r.ok) return toast(r.data.error || `Couldn't reach ${machine}. Try again.`);
      // An agent turned off here leaves your sidebar and feed, as Deactivate on the Agents tab does.
      for (const a of agents || []) if (a.machine === machine && offAgents.has(a.kind) && !a.hidden) await hideAgent(a.id, true, true).catch(() => {});
      onPicked();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card ob-card" aria-label={`Set up ${machine}`}>
      <div className="ob-hello">
        {first && here ? <h1>Welcome{name ? `, ${name}` : ""}</h1> : <h1 className="ob-h1-sm">{machine} is on your agentbook</h1>}
        <p>
          {first && here ? (
            <>
              <b>{machine}</b> is on your agentbook. Pick the agents it follows here, and how much of what they did before to bring in.
            </>
          ) : (
            <>Pick what it follows, and how much of the past to bring in. Nothing from before goes up until you do.</>
          )}
        </p>
      </div>

      <div className="ob-h">
        <span className="n">1</span>
        <h2>Your agents on {machine}</h2>
        {rt && <span className="r">Found {found.length}</span>}
      </div>
      {!rt ? (
        <p className="muted ob-wait">Asking {machine} what it runs…</p>
      ) : (
        <>
          <div className="ob-rows">
            {found.map((r) => (
              <AgentRowView
                key={r.kind}
                r={r}
                n={sessionsOf(r.kind)}
                on={!offAgents.has(r.kind)}
                flip={() => setOffAgents((s) => toggle(s, r.kind))}
                codexTools={codexTools}
                setCodexTools={setCodexTools}
                setup={setupHref(username, r.kind, machine)}
              />
            ))}
            {!found.length && <p className="muted ob-wait">No agents on {machine} yet.</p>}
          </div>
          {missing.length > 0 && (
            <div className="ob-more">
              <b>Not on {here ? "this machine" : machine}:</b> {missing.map((r) => r.name).join(", ")} · <a href={setupHref(username, "", machine)}>Install one</a>
            </div>
          )}
          <div className="ob-more">
            <b>In the cloud:</b> Claude Agent, Devin · connect them any time, from <a href={setupHref(username, "cloud")}>Agents</a>
          </div>
        </>
      )}

      <div className="ob-h">
        <span className="n">2</span>
        <h2>What they did before</h2>
      </div>
      <div className="ob-range">
        <div className="seg" role="group" aria-label="How far back">
          {RANGES.map(([d, label]) => (
            <button key={label} type="button" className={range === d ? "is-on" : ""} aria-pressed={range === d} onClick={() => setRange(d)}>
              {label}
            </button>
          ))}
        </div>
        <span className="hint">or drag the line</span>
      </div>
      <Chart h={h} range={range} out={out} setRange={setRange} />
      {range === 0 ? (
        <div className="ob-sum">
          <span className="muted">Nothing from before: only what your agents do from now on shows here.</span>
        </div>
      ) : (
        <>
          <div className="ob-sum">
            <b>
              {plural(list.length, "thread")}
              {range == null ? "" : ` from ${dayLabel(h.today, range - 1)} on`}
            </b>
            {h.agents.map((a) =>
              (all[a.kind] || 0) > 0 || by[a.kind] ? (
                <button key={a.kind} type="button" className={`ob-pick${offAgents.has(a.kind) ? " is-out" : ""}`} style={hueVars(a.agent)} title={offAgents.has(a.kind) ? "Bring it in" : "Leave it out"} onClick={() => setOffAgents((s) => toggle(s, a.kind))}>
                  <i />
                  {a.name}
                  <span className="k">{n(all[a.kind] || 0)}</span>
                </button>
              ) : null,
            )}
            {folders.length > 1 && (
              <button className="ob-folders-link" type="button" aria-expanded={showFolders} onClick={() => setShowFolders((v) => !v)}>
                {outFolders.size ? `${folders.length - outFolders.size} of ${folders.length} folders` : `From ${folders.length} folders`} · {showFolders ? "Done" : "Leave some out"}
              </button>
            )}
          </div>
          {showFolders && (
            <div className="ob-folders">
              {folders.map(({ folder, n: k }) => (
                <label key={folder} className={outFolders.has(folder) ? "is-out" : ""} title={folder}>
                  <input type="checkbox" checked={!outFolders.has(folder)} onChange={() => setOutFolders((s) => toggle(s, folder))} />
                  <span className="f">
                    <span className="p">&lrm;{folderName(path.dirname(folder))}/&lrm;</span>
                    <b>{path.basename(folder)}</b>
                  </span>
                  <span className="k">{n(k)}</span>
                </label>
              ))}
            </div>
          )}
        </>
      )}
      <p className="ob-note">
        <Icon name="lock" />
        <span>Read on {machine}, and kept only on your machines: the sign-in relay knows only your account and your machines' names. Keys and passwords in them are blanked out before they leave {machine}.</span>
      </p>
      <div className="ob-go">
        <span className="left">Change either later, in Agents.</span>
        <button className="btn btn--dark" type="button" disabled={busy || !rt} onClick={() => void go()}>
          {range === 0 || !list.length ? "Start from now" : `Bring in ${plural(list.length, "thread")}`}
        </button>
      </div>
    </section>
  );
}

function AgentRowView({ r, n: count, on, flip, codexTools, setCodexTools, setup }: { r: RuntimeRow; n: number; on: boolean; flip: () => void; codexTools: boolean; setCodexTools: (v: boolean) => void; setup: string }) {
  const waiting = r.status === "Waiting for approval";
  const what = RUNTIMES[r.kind as keyof typeof RUNTIMES];
  return (
    <div className={`ob-row${on ? "" : " is-off"}`}>
      <Avatar agent={r.agent || r.kind} size="av--sm" />
      <div className="t">
        <b>{r.name}</b>
        <span className="c">{count ? `${plural(count, "past session")}` : what?.caps?.discovers === "own" ? "The threads you start here" : r.detail || ""}</span>
        {r.kind === "claude-code" && <small>agentbook's plugin goes into Claude Code: each session shows here as it runs, and gets agentbook's tools.</small>}
        {what?.caps?.discovers === "own" && r.kind !== "claude-code" && <small>Sessions started in its own app don't show.</small>}
      </div>
      <label className="switch switch--flush ob-tog" aria-label={`Follow ${r.name}`}>
        <input type="checkbox" checked={on} onChange={flip} />
        <span className="track" />
      </label>
      {r.kind === "codex" && on && (
        <div className="sub">
          <label>
            <input type="checkbox" checked={codexTools} onChange={(e) => setCodexTools(e.target.checked)} />
            <span>
              Give it agentbook's tools too, in <code>~/.codex/config.toml</code>
            </span>
          </label>
        </div>
      )}
      {waiting && on && (
        <div className="wait">
          Say yes to agentbook on its gateway. <a className="btn btn--sm btn--line" href={setup}>Show me how</a>
        </div>
      )}
    </div>
  );
}

// Threads per day, stacked by agent, the last HISTORY_DAYS days, today on the right; what the range leaves out is
// faint. Dragging on it moves where the range starts.
function Chart({ h, range, out, setRange }: { h: HistoryRead; range: Range; out: Leaveouts; setRange: (r: Range) => void }) {
  const N = HISTORY_DAYS;
  const W = 600;
  const H = 92;
  const gap = 2;
  const bw = W / N - gap;
  const grid = perDay(h, N, out);
  const full = perDay(h, N);
  const max = Math.max(1, ...full.map((d) => d.reduce((a, b) => a + b, 0)));
  const svg = useRef<SVGSVGElement>(null);
  const at = (e: { clientX: number }) => {
    const r = svg.current.getBoundingClientRect();
    return Math.max(1, Math.min(N, Math.round(((r.right - e.clientX) / r.width) * N)));
  };
  const down = (e: ReactPointerEvent<SVGSVGElement>) => {
    svg.current.setPointerCapture(e.pointerId);
    setRange(at(e));
  };
  const move = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (svg.current.hasPointerCapture(e.pointerId)) setRange(at(e));
  };
  const bars = [];
  for (let d = 0; d < N; d++) {
    const x = W - (d + 1) * (bw + gap) + gap;
    const inRange = range == null || d < range;
    let y = H;
    let any = false;
    grid[d].forEach((v, a) => {
      if (!v) return;
      any = true;
      const hgt = Math.max(1.5, (v / max) * (H - 6));
      y -= hgt;
      bars.push(<rect key={`${d}:${a}`} x={x} y={y} width={bw} height={hgt} rx={1.5} style={{ fill: hueVars(h.agents[a].agent)["--hue" as never] as string }} opacity={inRange && range !== 0 ? 1 : 0.18} />);
    });
    if (!any) bars.push(<rect key={`${d}:-`} x={x} y={H - 1.5} width={bw} height={1.5} fill="var(--line-2)" />);
  }
  const keeps = h.agents.map((a) => a.keeps).filter((k): k is number => !!k && k < N);
  const handle = range != null && range > 0 && range < N ? W - range * (bw + gap) + gap / 2 - 1 : null;
  const keeper = keeps.length ? h.agents.find((a) => a.keeps === keeps[0]) : null;
  return (
    <div className="ob-chart" title="Drag to pick how far back">
      {keeper && (
        <span className="ob-keep" style={{ right: `${((keeps[0] / N) * 100).toFixed(1)}%` }}>
          {keeper.name} keeps {keeps[0]} days
        </span>
      )}
      <svg ref={svg} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onPointerDown={down} onPointerMove={move} role="img" aria-label="Past threads per day">
        {bars}
        {keeps.length > 0 && <line x1={W - keeps[0] * (bw + gap) + gap / 2} x2={W - keeps[0] * (bw + gap) + gap / 2} y1={2} y2={H} stroke="var(--ink-3)" strokeDasharray="2 3" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
        {handle != null && (
          <>
            <rect x={handle} y={0} width={W - handle} height={H} rx={4} fill="rgba(18,24,33,0.045)" />
            <line x1={handle} x2={handle} y1={-4} y2={H + 2} stroke="var(--ink)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            <rect x={handle - 5} y={H / 2 - 11} width={10} height={22} rx={5} fill="#fff" stroke="var(--ink)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          </>
        )}
      </svg>
      <div className="ob-axis">
        {[N - 1, Math.round((N * 3) / 4), Math.round(N / 2), Math.round(N / 4)].map((d) => (
          <span key={d}>{dayLabel(h.today, d)}</span>
        ))}
        <span>Today</span>
      </div>
    </div>
  );
}

function Progress({ h, onDismiss }: { h: HistoryRead; onDismiss: () => void }) {
  const p = h.progress;
  const name = (k: string) => h.agents.find((a) => a.kind === k)?.name || RUNTIMES[k as keyof typeof RUNTIMES]?.name || k;
  const agentOf = (k: string) => h.agents.find((a) => a.kind === k)?.agent || k;
  if (p.finished)
    return (
      <section className="card ob-card">
        <div className="ob-done">
          <span className="tick">
            <Icon name="check" />
          </span>
          <div>
            <p>
              <b>{p.total ? `Brought in ${plural(p.done, "thread")} from ${h.machine}.` : `${h.machine} starts from now.`}</b> Its agents post here from now on.
            </p>
            {p.error && <p>{p.error}</p>}
          </div>
          <button className="btn btn--sm" type="button" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </section>
    );
  return (
    <section className="card ob-card">
      <div className="ob-prog-h">
        <b>Bringing in {plural(p.total, "thread")} from {h.machine}</b>
        <span className="r">
          {n(p.done)} of {n(p.total)}
        </span>
      </div>
      <div className="ob-bar">
        <i style={{ width: `${p.total ? Math.round((p.done / p.total) * 100) : 0}%` }} />
      </div>
      <div className="ob-prog">
        {Object.entries(p.by).map(([k, v]) => (
          <div key={k} className="ob-prog-row">
            <Avatar agent={agentOf(k)} size="av--xs" />
            <span>{name(k)}</span>
            <span className={`k${v.done >= v.total ? " ok" : ""}`}>
              {n(v.done)} of {n(v.total)}
            </span>
          </div>
        ))}
      </div>
      <p className="ob-note">
        <Icon name="clock" />
        <span>They come in newest first, below. You can start a thread meanwhile.</span>
      </p>
    </section>
  );
}
