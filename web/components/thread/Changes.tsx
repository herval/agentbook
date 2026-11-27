// What a thread changed, on its page: its Changes (the files its session changed, for the turn it's on or the whole
// session, and its commits, each opening to its diff), a step's diff, and the "Changed 3 files" line a turn ends with.
// Any line of a diff takes a comment to the thread (diff-view.tsx).
import { useEffect, useRef, useState } from "react";
import { Icon } from "../Icon.tsx";
import { Ago } from "../Time.tsx";
import { clock, plural } from "../../lib/format.ts";
import { useRoute } from "../../lib/route.ts";
import { getApp, useApp } from "../../lib/store.ts";
import { pickChanges } from "../../lib/thread.ts";
import type { ChangedFile, Changes, Commit, Step, Thread, ThreadDetail } from "../../lib/types.ts";
import { ChangeTiles } from "../visual/ChangeTiles.tsx";
import { ReachOf } from "./diff-reach.tsx";
import { ChgNotes, ChgSize, ChgTags, DiffView, PathParts, fetchDiff, toggleOpen, useDiffThread, useDiffs, useOpenKey, writable } from "./diff-view.tsx";
import { Sec, unfoldSec } from "./Sec.tsx";

export { ChgSize, PathParts, writable, DiffView };

function ChgFile({ f, scope, thread, at }: { f: ChangedFile; scope: string; thread: string; at: string | null }) {
  const open = useOpenKey(`f:${f.path}`);
  const key = `f:${scope}|${f.path}|${f.at}|${f.edits}`;
  const d = useDiffs((s) => s.diffs[key]);
  useEffect(() => {
    if (open && !f.nodiff) void fetchDiff(thread, key, `/changes/file?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(f.path)}`);
  }, [open, key, thread]);
  return (
    <li className={open ? "is-open" : undefined}>
      <button className="chg-row" type="button" data-chg-file={f.path} aria-expanded={open} onClick={() => toggleOpen(`f:${f.path}`)}>
        <span className="chg-path">
          <PathParts p={f.path} />
        </span>
        <ChgTags f={f} />
        {f.nodiff ? null : <ChgSize add={f.add} del={f.del} />}
        <Icon name="caret" />
      </button>
      {open && (
        <div className="chg-body">
          <ChgNotes f={f} />
          <DiffView f={f.nodiff ? f : d} at={at} thread={thread} />
        </div>
      )}
    </li>
  );
}
function ChgCommit({ c, thread, can }: { c: Commit & { add?: number; del?: number }; thread: string; can: boolean }) {
  const key = `c:${c.sha}`;
  const open = useOpenKey(key);
  const d = useDiffs((s) => s.diffs[key]);
  useEffect(() => {
    if (open) void fetchDiff(thread, key, `/commits/${encodeURIComponent(c.sha)}`);
  }, [open, key, thread]);
  const body = !open ? null : !d ? (
    <DiffView f={null} />
  ) : d.error ? (
    <DiffView f={d} />
  ) : (
    (d.files || []).map((f) => (
      <div key={f.path}>
        <p className="dv-file">
          <span className="chg-path">
            <PathParts p={f.path} />
          </span>
          <ChgTags f={f} />
          <ChgSize add={f.add} del={f.del} />
        </p>
        <DiffView f={f} at={can ? `c:${c.sha}|${f.path}` : null} thread={thread} />
      </div>
    ))
  );
  return (
    <li className={open ? "is-open" : undefined}>
      <button className="chg-row" type="button" data-commit={c.sha} aria-expanded={open} onClick={() => toggleOpen(key)}>
        <code className="sha">{c.short}</code>
        <span className="chg-path">{c.subject}</span>
        <ChgSize add={c.add} del={c.del} />
        <Icon name="caret" />
      </button>
      {open && <div className="chg-body">{body}</div>}
    </li>
  );
}

// The post's Changes: the files its session changed, for the turn it's on or the whole session, and its commits.
// ?changes=<turn> (a "Changed 3 files" line links there) opens it on that turn and scrolls to it; &file=<path> (one of
// its tiles) opens that file's diff. `canWrite`: you can write to it (the page's check, with its folder's), so its
// lines take comments; by default, as writable() says.
export function ChangesSection({ s, canWrite }: { s: ThreadDetail; canWrite?: boolean }) {
  const c = useApp((st) => (st.open?.id === s.id ? st.open.chg : null));
  const route = useRoute();
  useDiffThread(s.id);
  // Asked for a turn by the address: scrolled to once its Changes are in.
  const want = useRef<Changes | null | undefined>(undefined);
  const asked = route.name === "session" && route.id === s.id ? route.changes : null;
  useEffect(() => {
    if (!asked) return;
    want.current = getApp().open?.chg ?? null;
    pickChanges(asked);
    unfoldSec("changes");
    // A tile of its change: that file's diff, open.
    if (route.file) toggleOpen(`f:${route.file}`, true);
  }, [s.id, asked, route.at, route.file]);
  useEffect(() => {
    if (want.current === undefined || !c || c === want.current) return;
    want.current = undefined;
    requestAnimationFrame(() => document.getElementById("changes")?.scrollIntoView({ block: "start" }));
  }, [c]);
  if (!c || (!c.files.length && !c.commits.length && c.scope === "all")) return null;
  const can = canWrite ?? writable(s);
  const latest = String(c.latest);
  const earlier = c.scope !== "all" && c.scope !== latest;
  const chgAt = asked === c.scope ? route.at : null;
  const now = s.effective === "working" ? "This turn" : "Last turn";
  const pick = (value: string, label: string) => (
    <button
      type="button"
      key={value}
      className={c.scope === value ? "is-on" : undefined}
      data-chg-scope={value}
      onClick={() => {
        for (const k of useDiffs.getState().open) if (k.startsWith("f:")) toggleOpen(k, false);
        pickChanges(value);
      }}
    >
      {label}
    </button>
  );
  const seg =
    c.turns > 1 || earlier || (c.scope !== "all" && c.turns) ? (
      <span className="seg">
        {earlier ? pick(c.scope, chgAt ? `Turn at ${clock(chgAt)}` : "That turn") : null}
        {pick(latest, now)}
        {pick("all", "Whole session")}
      </span>
    ) : null;
  const t = c.totals;
  const own = c.files.filter((f) => !f.elsewhere);
  const away = c.files.filter((f) => f.elsewhere);
  const list = (fs: ChangedFile[]) => (
    <ul className="chg-files">
      {fs.map((f) => (
        <ChgFile key={`${f.path}|${f.at}|${f.edits}`} f={f} scope={c.scope} thread={s.id} at={can ? `f:${f.path}` : null} />
      ))}
    </ul>
  );
  return (
    <Sec
      k="changes"
      label="Changes"
      id="changes"
      acts={seg}
      count={
        t.files ? (
          <>
            <span className="muted">{plural(t.files, "file")}</span>
            <ChgSize add={t.add} del={t.del} />
          </>
        ) : null
      }
    >
      {!c.files.length && !c.commits.length && <p className="chg-note">Nothing changed in {c.scope === "all" ? "this session" : c.scope === latest ? (s.effective === "working" ? "this turn yet" : "the last turn") : "that turn"}.</p>}
      {own.length ? list(own) : null}
      {away.length ? (
        <>
          <p className="chg-sub">Outside its folder</p>
          {list(away)}
        </>
      ) : null}
      {c.commits.length ? (
        <>
          <p className="chg-sub">{c.commits.length === 1 ? "Commit" : "Commits"}</p>
          <ul className="chg-files">
            {c.commits.map((x) => (
              <ChgCommit key={x.sha} c={x} thread={s.id} can={can} />
            ))}
          </ul>
        </>
      ) : null}
    </Sec>
  );
}

// What a step changed, opened under it (the page's Steps draw this inside their .step-diff): its file's diff, or each
// file a command or subagent changed. A subagent's step keeps changing while it works, so it's fetched again when its
// size does.
export const stepKey = (st: Step) => `s:${st.id}|${(st.files || []).map((f) => `${f.add}.${f.del}`).join(",")}`;
export function StepDiff({ st, s, canWrite }: { st: Step; s: Thread | ThreadDetail; canWrite?: boolean }) {
  useDiffThread(s.id);
  const key = stepKey(st);
  const d = useDiffs((x) => x.diffs[key]);
  useEffect(() => {
    void fetchDiff(s.id, key, `/steps/${encodeURIComponent(st.id)}/diff`);
  }, [key, s.id]);
  const can = canWrite ?? writable(s as Thread);
  if (!d) return <DiffView f={null} />;
  if (d.error) return <DiffView f={d} />;
  if (!d.files?.length) return <p className="dv-wait">No lines changed.</p>;
  const heads = d.files.length > 1 || d.files[0].by === "command";
  return (
    <>
      {d.files.map((f) => (
        <div key={f.path}>
          {heads && (
            <p className="dv-file">
              <span className="chg-path">
                <PathParts p={f.path} />
              </span>
              <ChgTags f={f} />
              {f.nodiff ? null : <ChgSize add={f.add} del={f.del} />}
            </p>
          )}
          <DiffView f={f} at={can ? `s:${st.id}|${f.path}` : null} thread={s.id} />
        </div>
      ))}
    </>
  );
}

// The "Changed 3 files, +40 −8" a turn ends with, opening the post's Changes for that turn; its files as tiles, a click
// on one opening its diff; and how far it reaches (reach.ts), a click away.
export function ChangeLine({ s, u, tag = "li" }: { s: Pick<Thread, "id">; u: Thread["updates"][number]; tag?: "li" | "div" }) {
  const [open, setOpen] = useState(false);
  if (!u.changes) return null;
  const href = `#/threads/${encodeURIComponent(s.id)}?changes=${u.changes.turn}&at=${encodeURIComponent(u.at)}`;
  const r = u.changes.reach;
  const Tag = tag;
  const tiles = (u.changes.tiles || []).some((t) => t?.path);
  return (
    <>
      <Tag className={`chg-line${tiles ? " has-tiles" : ""}`}>
        <Icon name="diff" />
        <span>
          <a href={href}>{u.text}</a>
          {r && (
            <>
              {" "}
              <button className="rs-ghost" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
                <Icon name="reach" />
                How far it reaches
              </button>
            </>
          )}
          <ChangeTiles ch={u.changes} href={(t) => `${href}&file=${encodeURIComponent(t.path)}`} />
        </span>
        <Ago at={u.at} />
      </Tag>
      {open && r && (
        <Tag className="rs-reach-li">
          <ReachOf r={r} />
        </Tag>
      )}
    </>
  );
}
