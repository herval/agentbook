// An agent's workspace: an OpenClaw agent's own folder, on its gateway's machine: its AGENTS.md, SOUL.md and
// MEMORY.md, its memory/ notes, whatever it writes. Its profile shows what changed last, and its Files tab all of it, a
// folder at a time or newest first. A file opens in the viewer, read from there, and shows again as it is when it
// changes.
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { agentName } from "../../lib/agents.ts";
import { ago, agoText, kb, plural } from "../../lib/format.ts";
import { agentHref } from "../../lib/route.ts";
import { signedOut } from "../../lib/session.ts";
import type { AgentFolder as Folder } from "../../lib/types.ts";
import { openPeek } from "../../lib/viewer.ts";
import { Icon } from "../Icon.tsx";
import type { AgentRow } from "./types.ts";
import { peekShown, refreshPeek } from "../../lib/viewer.ts";

type FolderFile = Folder["files"][number];
type FolderDir = Folder["dirs"][number];

const awBase = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const awParent = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const awNewest = (files: FolderFile[]) => [...files].sort((x, y) => (y.modified || "").localeCompare(x.modified || ""));
// What's in it as far as it's been looked at: its listing, with what's in the folders it didn't go into that were
// opened since, each in place of what the listing had under it (the deepest last).
function awSeen(w: Folder, subs: Record<string, Folder>): { files: FolderFile[]; dirs: FolderDir[] } {
  let files = w.files || [];
  let dirs = w.dirs || [];
  for (const [dir, sub] of Object.entries(subs).sort(([x], [y]) => x.length - y.length)) {
    if (!sub.files) continue;
    const under = (p: string) => p.startsWith(`${dir}/`);
    files = [...files.filter((f) => !under(f.path)), ...sub.files];
    dirs = [...dirs.filter((d) => !under(d.path)).map((d) => (d.path === dir ? { ...d, listed: true } : d)), ...(sub.dirs || [])];
  }
  return { files, dirs };
}
// The folders on the way to `dir` (itself too) that the listing didn't go into: each is listed when you're in it.
function awUnlisted(w: Folder, subs: Record<string, Folder>, dir: string): string[] {
  const { dirs } = awSeen(w, subs);
  const out = [];
  for (let p = dir; p; p = awParent(p)) if (subs[p] || dirs.some((d) => d.path === p && !d.listed)) out.push(p);
  return out;
}
const awWhere = (w: Folder) => `${String(w.root).replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, "~")}${w.host ? ` on ${w.host}` : ""}`;

// What its agent's workspace has, as its profile reads it: read as the profile opens, again when its agent did
// something there (`a.workspace`), and every 30 seconds while the page is in sight. On a hiccup, it keeps what it had.
// The folder you're in, and its files newest first or not.
export interface AgentFolderState {
  aw: Folder | null;
  subs: Record<string, Folder>;
  dir: string;
  recent: boolean;
  setDir: (dir: string) => void;
  setRecent: (on: boolean) => void;
  open: (path: string) => void;
}
export function useAgentFolder(a: AgentRow | undefined): AgentFolderState {
  const id = a?.id;
  const has = !!a?.workspace;
  const [aw, setAw] = useState<Folder | null>(null);
  const [subs, setSubs] = useState<Record<string, Folder>>({});
  const [dir, setDirNow] = useState("");
  const [recent, setRecent] = useState(false);
  const now = useRef({ aw, subs, dir });
  now.current = { aw, subs, dir };
  const looking = useRef(new Set<string>());
  // One of its folders the listing didn't go into (see awSeen), while you're in it.
  const loadFolder = useCallback(
    async (d: string) => {
      if (looking.current.has(d)) return;
      looking.current.add(d);
      const res = await fetch(`/api/agents/${encodeURIComponent(id)}/workspace?dir=${encodeURIComponent(d)}`).catch(() => null);
      looking.current.delete(d);
      if (res?.status === 401) return signedOut();
      const data = await res?.json().catch(() => null);
      setSubs((s) => ({ ...s, [d]: res?.ok ? data : s[d]?.files ? s[d] : { error: data?.error || "Couldn't look in this folder." } }));
    },
    [id],
  );
  const load = useCallback(async () => {
    if (!id || !has) return;
    const res = await fetch(`/api/agents/${encodeURIComponent(id)}/workspace`).catch(() => null);
    if (res?.status === 401) return signedOut();
    const data: Folder | null = await res?.json().catch(() => null);
    if (res?.ok) setAw(data);
    else setAw((w) => (w?.files ? w : { error: data?.error || "Couldn't look in its workspace." }));
    // A file of it that's open changed: show it as it is now.
    const pk = res?.ok ? peekShown() : null;
    const open = pk && pk.post === `ws:${id}` && pk.data && pk.data.kind !== "dir" ? pk.data : null;
    const changed = open && data.files?.find((f) => (data.core ? f.path === open.name : `${data.root}/${f.path}` === open.path));
    if (changed && changed.modified !== open.modified) void refreshPeek();
    if (res?.ok) awUnlisted(data, now.current.subs, now.current.dir).forEach(loadFolder);
  }, [id, has, loadFolder]);
  // Its agent did something, so its workspace may have changed: look again.
  const changed = JSON.stringify(a?.workspace || null);
  useEffect(() => {
    load();
  }, [load, changed]);
  useEffect(() => {
    const t = setInterval(() => !document.hidden && load(), 30000);
    return () => clearInterval(t);
  }, [load]);
  return {
    aw,
    subs,
    dir,
    recent,
    setRecent,
    // Into a folder: one it didn't list is looked in then.
    setDir: (d) => {
      setDirNow(d);
      if (now.current.aw?.files) awUnlisted(now.current.aw, now.current.subs, d).forEach(loadFolder);
    },
    // A file of it, in the viewer.
    open: (path) => {
      const w = now.current.aw;
      if (w?.files) openPeek(`ws:${id}`, w.core ? path : `${w.root}/${path}`);
    },
  };
}

// When it changed: "4m", with a dot when it's in the last 10 minutes.
function AwWhen({ at }: { at?: string | null }) {
  if (!at) return <time />;
  return (
    <time className={Date.now() - Date.parse(at) < 600e3 ? "is-fresh" : undefined} dateTime={at} title={`Changed ${agoText(at)}`}>
      {ago(at)}
    </time>
  );
}
function AwFile({ f, where = false, open }: { f: FolderFile; where?: boolean; open: (path: string) => void }) {
  return (
    <li>
      <button className="aw-row" type="button" onClick={() => open(f.path)}>
        <Icon name="file" />
        <span className="aw-name">
          <b>{awBase(f.path)}</b>
          {where && awParent(f.path) && <small>{awParent(f.path)}/</small>}
        </span>
        <span className="aw-meta">{f.size != null ? kb(f.size) : ""}</span>
        <AwWhen at={f.modified} />
      </button>
    </li>
  );
}

export function AwCard({ agent: a, folder }: { agent: AgentRow; folder: AgentFolderState }) {
  const w = folder.aw;
  if (!w) return null;
  if (w.error)
    return (
      <section className="card box">
        <h3>Workspace</h3>
        <p className="muted">{w.error}</p>
      </section>
    );
  const rows = awNewest(w.files || []).slice(0, 5);
  return (
    <section className="card box">
      <h3>
        Workspace <a href={agentHref(a.id, "files")}>See all</a>
      </h3>
      {rows.length ? (
        <ul className="rt-mini aw-mini">
          {rows.map((f) => (
            <li key={f.path}>
              <button type="button" title={f.path} onClick={() => folder.open(f.path)}>
                <Icon name="file" />
                <span>
                  <b>{awBase(f.path)}</b>
                  <small>
                    {awParent(f.path) ? `${awParent(f.path)}/, ` : ""}changed {agoText(f.modified)}
                  </small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Nothing in it yet.</p>
      )}
    </section>
  );
}

export function AwBrowser({ agent: a, folder }: { agent: AgentRow; folder: AgentFolderState }) {
  const w = folder.aw;
  const name = agentName(a.id);
  const head = (more = null) => <h3>Workspace{more}</h3>;
  if (!w)
    return (
      <section className="card box">
        {head()}
        <p className="muted">Looking in it…</p>
      </section>
    );
  if (w.error)
    return (
      <section className="card box">
        {head()}
        <p className="err">{w.error}</p>
      </section>
    );
  const recent = folder.recent && !w.core;
  const seg = w.core ? null : (
    <span className="seg">
      {(
        [
          [false, "Folders"],
          [true, "Newest first"],
        ] as const
      ).map(([on, label]) => (
        <button key={label} type="button" className={recent === on ? "is-on" : ""} onClick={() => folder.setRecent(on)}>
          {label}
        </button>
      ))}
    </span>
  );
  const seen = awSeen(w, folder.subs);
  // A folder that's gone (it was removed while you were in it) is its nearest one that's still there.
  let dir = folder.dir;
  while (dir && !seen.dirs.some((d) => d.path === dir)) dir = awParent(dir);
  const here = (p: string) => awParent(p) === dir;
  // One the listing didn't go into, until what's in it comes.
  const sub = dir && !seen.dirs.find((d) => d.path === dir).listed ? folder.subs[dir] || {} : null;
  let body;
  if (recent)
    body = (
      <ul className="aw-list">
        {awNewest(seen.files)
          .slice(0, 60)
          .map((f) => (
            <AwFile key={f.path} f={f} where open={folder.open} />
          ))}
      </ul>
    );
  else {
    const crumbs = dir ? (
      <p className="aw-crumbs">
        <button type="button" onClick={() => folder.setDir("")}>
          {awBase(w.root) || "workspace"}
        </button>
        {dir.split("/").map((part, i, all) =>
          i === all.length - 1 ? (
            <Fragment key={i}>
              <span className="sep">/</span>
              <b>{part}</b>
            </Fragment>
          ) : (
            <Fragment key={i}>
              <span className="sep">/</span>
              <button type="button" onClick={() => folder.setDir(all.slice(0, i + 1).join("/"))}>
                {part}
              </button>
            </Fragment>
          ),
        )}
      </p>
    ) : null;
    const sortName = (x: { path: string }, y: { path: string }) => awBase(x.path).localeCompare(awBase(y.path), undefined, { sensitivity: "base", numeric: true });
    const folders = seen.dirs
      .filter((d) => here(d.path))
      .sort(sortName)
      .map((d) => {
        const inside = d.listed ? seen.files.filter((f) => f.path.startsWith(`${d.path}/`)) : [];
        const newest = awNewest(inside)[0]?.modified || d.modified;
        return (
          <li key={`d:${d.path}`}>
            <button className="aw-row is-dir" type="button" onClick={() => folder.setDir(d.path)}>
              <Icon name="folder" />
              <span className="aw-name">
                <b>{awBase(d.path)}</b>
              </span>
              <span className="aw-meta">{d.listed ? plural(inside.length, "file") : ""}</span>
              <AwWhen at={newest} />
            </button>
          </li>
        );
      });
    const files = seen.files
      .filter((f) => here(f.path))
      .sort(sortName)
      .map((f) => <AwFile key={f.path} f={f} open={folder.open} />);
    const empty = sub ? sub.error ? <p className="err">{sub.error}</p> : <p className="muted">Looking in it…</p> : <p className="muted">{dir ? "This folder is empty." : "Nothing in it yet."}</p>;
    body = (
      <>
        {crumbs}
        {folders.length || files.length ? (
          <ul className="aw-list">
            {folders}
            {files}
          </ul>
        ) : (
          empty
        )}
      </>
    );
  }
  const notes = [w.core ? `These are the files OpenClaw keeps for ${name}. The rest of its workspace shows once it has a thread.` : "", w.more ? "There's more in it than shows here." : ""].filter(Boolean);
  return (
    <section className="card box aw">
      {head(seg)}
      <p className="muted aw-where" title={w.root}>
        {awWhere(w)}
      </p>
      {body}
      {notes.map((n) => (
        <p key={n} className="muted aw-note">
          {n}
        </p>
      ))}
    </section>
  );
}
