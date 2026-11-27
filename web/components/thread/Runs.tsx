// A code block's runs: ▶ in its corner (■ while it runs) runs it in the thread's folder on its machine, and what it
// printed shows under it, its latest run, as it goes and as it ended. Markdown draws the block and asks this for what
// goes with it (mdActions.play, mdActions.runs), on a thread's page and on its card in a list.
import { useLayoutEffect, useRef } from "react";
import { create } from "zustand";
import { post } from "../../lib/api.ts";
import { agoText, dur } from "../../lib/format.ts";
import { mdActions } from "../../lib/markdown.ts";
import type { CodeRunAt } from "../../lib/markdown.ts";
import { getApp, setApp, useApp } from "../../lib/store.ts";
import { resumeTerminal } from "../../lib/terminal.ts";
import type { RunSeen, Thread } from "../../lib/types.ts";
import { Icon } from "../Icon.tsx";
import { Since } from "../Time.tsx";

// "post|message|block" -> "run" or "stop": clicked, until the machine says so.
const useAsked = create<Record<string, "run" | "stop">>(() => ({}));
const keyOf = (at: CodeRunAt) => `${at.post}|${at.mid}|${at.block}`;

// The thread a code block is in, as the page has it: the open thread (on its page, or in a page's threads bar), or a
// card of the list it shows.
const runThreadOf = (s: ReturnType<typeof getApp>, id: string) => (s.open?.detail?.id === id ? s.open.detail : s.feed?.records[`thread:${id}`] || null);
// A thread's runs, changed where the page has it.
function setRuns(id: string, runs: RunSeen[]) {
  setApp((s) => {
    if (s.open?.detail?.id === id) return { open: { ...s.open, detail: { ...s.open.detail, runs } } };
    const k = `thread:${id}` as const;
    const rec = s.feed?.records[k];
    return rec ? { feed: { ...s.feed, records: { ...s.feed.records, [k]: { ...rec, runs } } as typeof s.feed.records } } : {};
  });
}

// ▶ (or ■ while it runs): it runs in the thread's folder on its machine, or stops.
async function runCode(at: CodeRunAt) {
  const key = keyOf(at);
  if (useAsked.getState()[key]) return;
  const t = runThreadOf(getApp(), at.post);
  const r = (t?.runs || []).find((x) => x.message === at.mid && x.block === at.block);
  const stop = r?.state === "running";
  useAsked.setState({ [key]: stop ? "stop" : "run" });
  const res = await post<{ running?: boolean; terminal?: boolean }>(`/api/sessions/${encodeURIComponent(at.post)}/run${stop ? "/stop" : ""}`, { message: at.mid, block: at.block, ...(stop ? {} : { code: at.code.replace(/\n$/, "") }) });
  useAsked.setState((s) => {
    const next = { ...s };
    delete next[key];
    return next;
  }, true);
  // Started: it shows as running until its machine says more, which comes on the page's stream.
  const now = runThreadOf(getApp(), at.post);
  if (res.ok && !stop && res.data.running !== false && now) {
    const was = (now.runs || []).filter((x) => !(x.message === at.mid && x.block === at.block));
    setRuns(now.id, [...was, { message: at.mid, block: at.block, state: "running", started: new Date().toISOString(), out: "", cut: false } as RunSeen]);
  }
  // It runs in the thread's terminal: on its page, that shows, so what it asks for can be answered there.
  const { route, open } = getApp();
  if (res.ok && !stop && res.data.terminal && route.name === "session" && route.id === at.post && open?.detail) resumeTerminal(open.detail, { show: true });
}

function RunHead({ r, t }: { r: RunSeen; t: Thread }) {
  const took = r.ended ? dur(Date.parse(r.ended) - Date.parse(r.started)) : "";
  const how =
    r.state === "running" ? (
      <>
        <span className="pulse" />
        <b>Running</b>
        <Since since={r.started} />
      </>
    ) : r.state === "stopped" ? (
      <>
        <Icon name="stop" />
        <b>Stopped</b>
        {took && <span>after {took}</span>}
      </>
    ) : r.state === "failed" ? (
      <>
        <Icon name="alert" />
        <b>Couldn't run it</b>
      </>
    ) : r.exit === 0 ? (
      <>
        <Icon name="check" />
        <b>Done</b>
        {took && <span>in {took}</span>}
      </>
    ) : (
      <>
        <Icon name="alert" />
        <b>{r.exit != null ? `Exit code ${r.exit}` : r.signal ? `Ended by ${r.signal}` : "Ended"}</b>
        {took && <span>after {took}</span>}
      </>
    );
  return (
    <>
      {how}
      {t.mine === false && r.by && <span>by @{r.by}</span>}
      {r.state !== "running" && <span className="md-run-at">{agoText(r.ended || r.started)}</span>}
    </>
  );
}

// What it printed, kept scrolled to its end while you're there.
function RunOut({ r }: { r: RunSeen }) {
  const ref = useRef<HTMLPreElement>(null);
  const atEnd = useRef(true);
  const running = r.state === "running";
  const said = r.error && r.state === "failed" ? r.error : r.out || "";
  useLayoutEffect(() => {
    const pre = ref.current;
    if (pre && atEnd.current) pre.scrollTop = pre.scrollHeight;
  });
  return (
    <pre
      className="md-run-out"
      ref={ref}
      onScroll={(e) => {
        const pre = e.currentTarget;
        atEnd.current = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 12;
      }}
    >
      {r.cut && (
        <>
          <span className="md-run-cut">Only the end of what it printed is kept.</span>
          {"\n"}
        </>
      )}
      {said ? said.replace(/\n$/, "") : <span className="md-run-none">{running ? "Nothing printed yet." : r.error ? r.error : "It printed nothing."}</span>}
      {r.error && r.state !== "failed" && (
        <>
          {"\n"}
          <span className="md-run-none">{r.error}</span>
        </>
      )}
    </pre>
  );
}

// ▶ in the block's corner, beside Copy (■ while it runs).
function CodePlay({ at }: { at: CodeRunAt }) {
  const t = useApp((s) => runThreadOf(s, at.post));
  const asked = useAsked((s) => s[keyOf(at)]);
  const r = (t?.runs || []).find((x) => x.message === at.mid && x.block === at.block);
  if (!at.play) return null;
  const mode = asked ? "wait" : r?.state === "running" ? "stop" : "run";
  const off = !!t?.offline;
  const title = off ? `${t.machine || "Its machine"} is off` : mode === "stop" ? "Stop it" : mode === "wait" ? (asked === "stop" ? "Stopping…" : "Starting…") : r ? "Run it again" : "Run it in the thread's folder";
  return (
    <button className="md-code-btn" type="button" data-code-run data-mode={mode} title={title} aria-label={title} disabled={off || mode === "wait"} onClick={() => runCode(at)}>
      <Icon name={mode === "stop" ? "stop" : "play"} />
    </button>
  );
}

function CodeRuns({ at }: { at: CodeRunAt }) {
  const t = useApp((s) => runThreadOf(s, at.post));
  const r = (t?.runs || []).find((x) => x.message === at.mid && x.block === at.block);
  if (!r || !t) return null;
  return (
    <div className="md-run" data-state={r.state === "done" && r.exit !== 0 ? "failed" : r.state}>
      <div className="md-run-h">
        <RunHead r={r} t={t} />
      </div>
      <RunOut r={r} />
    </div>
  );
}

mdActions.play = (at) => <CodePlay at={at} />;
mdActions.runs = (at) => <CodeRuns at={at} />;
mdActions.useRunning = (at) => useApp((s) => !!at && (runThreadOf(s, at.post)?.runs || []).some((x) => x.message === at.mid && x.block === at.block && x.state === "running"));
