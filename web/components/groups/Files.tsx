// A group's files, in the middle of its Group tab, where its feed is: all of them (by folder, or newest first) and how
// agents get to them, or one open with its history (Restore, Download, Delete). Above them, the way back to its feed.
// Ported from the old page's groupFiles, groupFileView and loadGroupFile. A file opens here, in the group, rather than
// in the thread viewer: its versions are the group's (a Restore of each), which the viewer doesn't have.
import { Fragment, useEffect, useState } from "react";
import { post } from "../../lib/api.ts";
import { ago, agoText, ext, kb, plural } from "../../lib/format.ts";
import { useLoad } from "../../lib/hooks.ts";
import { groupHref } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { GroupFileVersion, GroupRow, GroupView } from "../../lib/types.ts";
import type { GroupFile } from "../../../plugin/shared/types.ts";
import { Icon } from "../Icon.tsx";
import { Markdown } from "../Markdown.tsx";
import { groupUpload } from "./Home.tsx";
import { fileBase, fileDir, fileUrl, groupBy, groupIn, groupMine, isImage, isMarkdown, loadGroup, useGroupUi } from "./groups.ts";
import { ByFace, copyIt } from "./parts.tsx";

// The Files view: `arg` is the file or folder open, `v` a version of the file.
export function GroupFiles({ g, d, arg, v }: { g: GroupRow; d: GroupView | null; arg: string; v: string | null }) {
  const machine = useApp((s) => s.data?.machine);
  const newest = useGroupUi((s) => s.groupNewest);
  const files = d?.file_list || [];
  const sel = arg || "";
  const isDir = !!sel && !files.some((f) => f.path === sel) && files.some((f) => f.path.startsWith(`${sel}/`));
  const dir = isDir ? sel : fileDir(sel);
  const open = isDir ? null : files.find((f) => f.path === sel) || null;
  const parts = (open ? open.path : dir).split("/").filter(Boolean);
  const crumbs = (
    <div data-key="crumbs">
      <nav className="aw-crumbs gf-crumbs" aria-label="Where it is">
        <a href={groupHref(g)}>
          <Icon name="back" />
          Feed
        </a>
        <span className="sep">/</span>
        {parts.length ? <a href={groupHref(g, "files")}>files</a> : <b>files</b>}
        {parts.map((part, i) => (
          <Fragment key={i}>
            <span className="sep">/</span>
            {i === parts.length - 1 ? <b>{part}</b> : <a href={groupHref(g, `files/${parts.slice(0, i + 1).join("/")}`)}>{part}</a>}
          </Fragment>
        ))}
      </nav>
    </div>
  );
  if (!d)
    return (
      <>
        {crumbs}
        <div data-key="loading">
          <section className="card box">
            <p className="muted">Loading its files…</p>
          </section>
        </div>
      </>
    );
  if (open)
    return (
      <>
        {crumbs}
        <div data-key="file">
          <GroupFileView g={g} d={d} f={open} v={v} />
        </div>
      </>
    );
  // A file's row (`where`: its folder too, newest first).
  const row = (f: GroupFile, where = false) => (
    <li key={f.path}>
      <a className="gf-row" href={groupHref(g, `files/${f.path}`)}>
        <Icon name={isImage(f.path) ? "image" : "file"} />
        <span className="nm">
          <b>{fileBase(f.path)}</b>
          <small>
            {where && fileDir(f.path) ? `${fileDir(f.path)}/ · ` : ""}v{f.v} by {groupBy(f.by)}
          </small>
        </span>
        <time className={Date.now() - Date.parse(f.at) < 600e3 ? "is-fresh" : ""}>{ago(f.at)}</time>
      </a>
    </li>
  );
  let list;
  if (newest) list = files.map((f) => row(f, true));
  else {
    const under = files.filter((f) => (dir ? f.path.startsWith(`${dir}/`) : true));
    const rest = (p: string) => (dir ? p.slice(dir.length + 1) : p);
    const subs = [...new Set(under.map((f) => rest(f.path)).filter((r) => r.includes("/")).map((r) => r.split("/")[0]))].sort();
    const here = under.filter((f) => !rest(f.path).includes("/")).sort((a, b) => a.path.localeCompare(b.path));
    list = [
      ...subs.map((sub) => {
        const p = dir ? `${dir}/${sub}` : sub;
        const inside = files.filter((f) => f.path.startsWith(`${p}/`));
        return (
          <li key={`dir:${p}`}>
            <a className="gf-row is-dir" href={groupHref(g, `files/${p}`)}>
              <Icon name="folder" />
              <span className="nm">
                <b>{sub}</b>
                <small>{plural(inside.length, "file")}</small>
              </span>
              <time>{ago(inside[0].at)}</time>
            </a>
          </li>
        );
      }),
      ...here.map((f) => row(f)),
    ];
  }
  return (
    <>
      {crumbs}
      <div data-key="list">
        <section className="card box gf-list">
          <h3>
            Files
            <span className="seg">
              <button type="button" className={newest ? "" : "is-on"} onClick={() => useGroupUi.setState({ groupNewest: false })}>
                Folders
              </button>
              <button type="button" className={newest ? "is-on" : ""} onClick={() => useGroupUi.setState({ groupNewest: true })}>
                Newest first
              </button>
            </span>
          </h3>
          <p className="gf-where">
            {groupIn(g) ? (
              <>
                In <code>{d.dir}</code> on {groupMine(g) ? machine : "each machine of everyone in it"}. Every agent in the group reads and writes them; every change is kept.
              </>
            ) : (
              "Its agents read and write them; every change is kept. Only the people in it change them here."
            )}
          </p>
          {files.length ? <ul className="gf-items">{list}</ul> : <p className="muted">{groupIn(g) ? "Nothing in it yet. Add files here, or ask a thread in the group to write one." : "Nothing in it yet."}</p>}
          {g.archived || !groupIn(g) ? null : (
            <div className="gf-drop">
              <Icon name="plus" />
              <button className="btn btn--sm" type="button" onClick={() => groupUpload(g, dir)}>
                Add files{dir ? ` to ${dir}/` : ""}
              </button>
            </div>
          )}
        </section>
      </div>
      <div data-key="reach">
        {groupIn(g) ? (
          <section className="card box">
            <h3>How agents get to them</h3>
            <ul className="facts">
              <li>
                <Icon name="folder" />
                <span>
                  <b>Claude Code and Codex</b> threads agentbook starts in the group get the folder as one more place they can write.
                </span>
              </li>
              <li>
                <Icon name="terminal" />
                <span>
                  Any thread in it reads and writes them with <code>ab_group_read</code> and <code>ab_group_write</code>.
                </span>
              </li>
              <li>
                <Icon name="history" />
                <span>A change is credited to the thread that wrote the file; one nobody's transcript explains is credited to {machine}.</span>
              </li>
            </ul>
          </section>
        ) : null}
      </div>
    </>
  );
}

// The text of the file that's open, fetched again each time the group is (it changed, or a version came in): text,
// or that it isn't text.
function useFileText(g: GroupRow, d: GroupView, f: GroupFile) {
  const [t, setT] = useState<{ path: string; binary: boolean; text: string } | null>(null);
  useEffect(() => {
    if (isImage(f.path)) return;
    let on = true;
    fetch(fileUrl(g, f.path))
      .then(async (res) => {
        if (!res.ok || !on) return;
        const buf = new Uint8Array(await res.arrayBuffer());
        const binary = buf.slice(0, 8000).includes(0);
        if (on) setT({ path: f.path, binary, text: binary ? "" : new TextDecoder().decode(buf.slice(0, 400000)) });
      })
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [g.id, f.path, f.v, d]);
  return t?.path === f.path ? t : null;
}

// One file open: what it is, its versions, Download, Copy its path, Delete; it (a picture, markdown, text, or a word
// that it isn't text); and its history, each version with Restore and Download.
function GroupFileView({ g, d, f, v }: { g: GroupRow; d: GroupView; f: GroupFile; v: string | null }) {
  const t = useFileText(g, d, f);
  const L = useLoad<{ versions: (GroupFileVersion & GroupFile)[] }>(`/api/groups/${encodeURIComponent(g.id)}/versions?${new URLSearchParams({ path: f.path })}`, [f.v, f.at]);
  const versions = L.data?.versions || null;
  const [restoring, setRestoring] = useState<number | null>(null);
  const isIn = groupIn(g);
  const body = isImage(f.path) ? (
    <div className="gf-pic">
      <img src={fileUrl(g, f.path, v)} alt={fileBase(f.path)} />
    </div>
  ) : !t ? (
    <div className="gf-doc">
      <p className="muted">Loading…</p>
    </div>
  ) : t.binary ? (
    <div className="gf-doc">
      <p className="muted">
        It isn't text. <a href={fileUrl(g, f.path, v, true)}>Download it</a>.
      </p>
    </div>
  ) : isMarkdown(f.path) ? (
    <Markdown text={t.text} className="md gf-doc" />
  ) : (
    <pre className="gf-doc gf-pre">{t.text}</pre>
  );
  // Putting an older version back, as a new one.
  const restore = async (n: number) => {
    setRestoring(n);
    const res = await post<{ version: GroupFileVersion }>(`/api/groups/${encodeURIComponent(g.id)}/files/restore`, { path: f.path, v: n });
    setRestoring(null);
    if (res.ok) toast(`Restored v${n} as v${res.data.version.v}.`);
    loadGroup();
  };
  // Deleting it: its versions are kept.
  const del = async () => {
    const res = await post(`/api/groups/${encodeURIComponent(g.id)}/files/delete`, { path: f.path });
    if (res.ok) {
      toast(`Deleted ${f.path}. Its versions are kept.`);
      location.hash = groupHref(g, "files");
    }
    loadGroup();
  };
  return (
    <section className="card gf-view">
      <div className="gf-vh">
        <span className="ext">{ext(f.path)}</span>
        <div>
          <b>{f.path}</b>
          <small>
            v{f.v}, {kb(f.size)}, changed {agoText(f.at)} by {groupBy(f.by)}
          </small>
        </div>
        <a className="icon-btn" href={fileUrl(g, f.path, null, true)} aria-label="Download" title="Download">
          <Icon name="download" />
        </a>
        {isIn ? (
          <button className="icon-btn" type="button" aria-label="Copy its path" title="Copy its path" onClick={() => copyIt(`${d.dir || ""}/${f.path}`)}>
            <Icon name="copy" />
          </button>
        ) : null}
        {g.archived || !isIn ? null : (
          <button className="btn btn--sm btn--line" type="button" title="Delete it: its versions are kept" onClick={del}>
            Delete
          </button>
        )}
      </div>
      {body}
      <div className="gf-sec">
        <p className="sec-h">
          History <span className="muted">{versions ? plural(versions.length, "version") : ""}</span>
        </p>
        {versions ? (
          <ul className="vers">
            {versions.map((x, i) => (
              <li key={x.v}>
                <ByFace by={x.by} />
                <span>
                  <b>v{x.v}</b> {x.deleted ? "Deleted" : x.restored ? `Restored v${x.restored}` : x.v === 1 ? "Added" : "Changed"}
                  {i === 0 ? (
                    <>
                      {" "}
                      <span className="ver-tag ver-tag--latest">Now</span>
                    </>
                  ) : null}
                </span>
                <span className="acts">
                  {i === 0 || x.deleted || !isIn || g.archived ? null : (
                    <button className="btn btn--sm btn--line" type="button" disabled={restoring === x.v} onClick={() => restore(x.v)}>
                      <Icon name="undo" />
                      Restore
                    </button>
                  )}
                  <a className="icon-btn" href={fileUrl(g, f.path, x.v, true)} aria-label={`Download v${x.v}`} title={`Download v${x.v}`}>
                    <Icon name="download" />
                  </a>
                </span>
                <p>
                  {groupBy(x.by)}, {agoText(x.at)}
                  {x.size ? `, ${kb(x.size)}` : ""}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </div>
    </section>
  );
}
