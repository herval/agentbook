// A thread's files as the page shows them: a chip (opening the viewer, its arrows going through the files next to
// it), a claude.ai artifact's copy as the page it is, and a thread's latest pictures as its card's cover.
import { useState } from "react";
import { ext } from "../../lib/format.ts";
import { isImage } from "../../lib/markdown.ts";
import type { FileRecord } from "../../lib/types.ts";
import { openFileFrom } from "../../lib/viewer.ts";
import { isPicFile } from "./staged.tsx";

export { isPicFile };
// A file as a chip, a cover or a gallery has it: maybe only some of a record (a message's files), from you or its
// agent, in a thread.
export type FileLike = Pick<FileRecord, "id" | "name"> & Partial<Omit<FileRecord, "id" | "name" | "from" | "post">> & { from?: string; post?: string | null; title?: string };

// What the viewer reads of a file, on whatever opens it (openFileFrom): its data-* attributes.
export const fileData = (f: FileLike) => ({ "data-file": f.id, "data-name": f.name, "data-title": f.title || f.name, "data-size": f.size ?? "", "data-from": f.from || "", "data-post": f.post || "" });
// A click opens the viewer, unless it's a cmd-, ctrl-, shift- or alt-click (the browser's new tab).
export function openOnClick(e: React.MouseEvent<HTMLElement>) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  openFileFrom(e.currentTarget);
}
// A page opens as itself, in a frame sandboxed like a named one's (its source a switch away).
export const isPage = (name: string | null | undefined) => /\.html?$/i.test(name || "");

export function FileChip({ f }: { f: FileLike }) {
  const url = `/api/files/${f.id}`;
  return (
    <a className="file" href={url} target="_blank" rel="noopener" title={f.name} {...fileData(f)} onClick={openOnClick}>
      {isImage(f.name) ? <img className="ext" src={url} alt="" /> : <span className="ext">{ext(f.name)}</span>}
      <span>
        <b>{f.title || f.name}</b>
        <small>{f.from === "human" ? "From you" : f.draft ? "Draft" : artifactOf(f) ? "Claude artifact" : `${Math.max(1, Math.round((f.size || 0) / 1024))} KB`}</small>
      </span>
    </a>
  );
}

// A copy of a claude.ai artifact, which its agent put on the thread (ab_artifact): claude.ai won't be framed by
// another site, so its link alone could only open it. On its thread's page the copy shows as the page it is, in the
// conversation, sandboxed as any agent's HTML file is (it belongs to no site, so never to agentbook's). Its name
// opens it larger, in the viewer; "claude.ai" opens the artifact itself. -> its link, if `f` is one.
export const artifactOf = (f: { artifact?: string; name?: string } | null | undefined): string | null => (/^https:\/\/(?:preview\.)?claude\.ai\/(?:code\/)?artifact\/[\w-]+$/.test(f?.artifact || "") && isPage(f.name) ? f.artifact : null);
// React keeps the frame as the conversation draws again, so it doesn't load again.
export function ArtifactFrame({ f }: { f: FileLike }) {
  const url = `/api/files/${encodeURIComponent(f.id)}`;
  const title = f.title || f.name;
  return (
    <div className="artf">
      <div className="artf-h">
        <a className="artf-t" href={url} target="_blank" rel="noopener" title="Open it larger" {...fileData(f)} onClick={openOnClick}>
          <b>{title}</b>
        </a>
        <a className="artf-src" href={artifactOf(f)} target="_blank" rel="noopener" title={`Open the artifact on claude.ai. What's here is a copy from ${new Date(f.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}.`}>
          claude.ai ↗
        </a>
      </div>
      <iframe className="artf-frame" sandbox="allow-scripts allow-forms allow-popups" src={url} title={title} key={f.id} />
    </div>
  );
}

// A thread's latest pictures, its card's cover: one alone, two side by side, or one
// large and two beside it with "+4" on the last. A click opens the viewer, its arrows going through all of them (the
// ones not shown are there, hidden, for it). `count`: how many it has in all.
// A phone's screenshot in a wide tile would show as a blur of its top: once it has loaded, one taller than it's wide
// shows whole instead, and is remembered so the next draw has it so from the start.
const tallPics = new Map<string, boolean>(); // its address -> taller than wide
function CoverTile({ f, more }: { f: FileLike; more: number }) {
  const url = `/api/files/${encodeURIComponent(f.id)}`;
  const [tall, setTall] = useState(!!tallPics.get(url));
  return (
    <a className={`cv-p${tall ? " tall" : ""}`} href={url} target="_blank" rel="noopener" title={f.title || f.name} {...fileData(f)} onClick={openOnClick}>
      <img
        src={url}
        alt={f.title || f.name}
        loading="lazy"
        decoding="async"
        onLoad={(e) => {
          const img = e.currentTarget;
          const t = img.naturalHeight > img.naturalWidth * 1.15;
          tallPics.set(url, t);
          setTall(t);
        }}
      />
      {more > 0 && <span className="cv-more">+{more}</span>}
    </a>
  );
}
export function Cover({ pics, count = 0, page = false }: { pics: FileLike[] | null | undefined; count?: number; page?: boolean }) {
  const list = (pics || []).filter(isPicFile);
  if (!list.length) return null;
  const shown = list.slice(0, 3);
  const more = Math.max(count, list.length) - shown.length;
  return (
    <div className={`cover cover--${shown.length}${page ? " cover--page" : ""}`}>
      {shown.map((f, i) => (
        <CoverTile key={f.id} f={f} more={i === shown.length - 1 ? more : 0} />
      ))}
      {list.slice(shown.length, 80).map((f) => (
        <a key={f.id} hidden href={`/api/files/${encodeURIComponent(f.id)}`} {...fileData(f)} />
      ))}
    </div>
  );
}
