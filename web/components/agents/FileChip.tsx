// A file a thread has, as a chip (the old page's fileChip): its picture or its extension, its title, and who it's from
// or how big. A click opens it in the viewer, whose arrows go through the files beside it (`set`); with ⌘ or ⇧, in a
// new tab.
import { ext } from "../../lib/format.ts";
import { isImage } from "../../lib/markdown.ts";
import type { FileRecord } from "../../lib/types.ts";
import { openFile } from "../../lib/viewer.ts";

// A copy of a claude.ai artifact, which its agent put on the thread (ab_artifact).
const artifactOf = (f: FileRecord) => (/^https:\/\/(?:preview\.)?claude\.ai\/(?:code\/)?artifact\/[\w-]+$/.test(f?.artifact || "") && /\.html?$/i.test(f.name || "") ? f.artifact : null);

export function FileChip({ file: f, set = [] }: { file: FileRecord; set?: FileRecord[] }) {
  const url = `/api/files/${encodeURIComponent(f.id)}`;
  return (
    <a
      className="file"
      href={url}
      target="_blank"
      rel="noopener"
      title={f.name}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        openFile(f, set.length ? set : [f]);
      }}
    >
      {isImage(f.name) ? <img className="ext" src={url} alt="" /> : <span className="ext">{ext(f.name)}</span>}
      <span>
        <b>{f.title || f.name}</b>
        <small>{f.from === "human" ? "From you" : f.draft ? "Draft" : artifactOf(f) ? "Claude artifact" : `${Math.max(1, Math.round(f.size / 1024))} KB`}</small>
      </span>
    </a>
  );
}
