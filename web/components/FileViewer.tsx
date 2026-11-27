// The file viewer's dialog (lib/viewer.ts opens it; App draws it once): a file of a set, its arrows going through the
// rest; a picture of a thread you can write to, with marks on it (viewer-marks.tsx); or a file an agent named, read
// from its thread's folder (a folder lists what's in it; Back goes up the trail). It's emptied on close, so a video
// stops playing.
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon.tsx";
import { Markdown } from "./Markdown.tsx";
import { MarksBody, MarksPop, closeMarks, markEscAt, markable } from "./thread/viewer-marks.tsx";
import { isPicFile, stagedMarks, stagedOf, stagedPic, whenUnstaged } from "./thread/staged.tsx";
import { machineOf, tildeOn } from "../lib/agents.ts";
import { ago, ext, kb, plural } from "../lib/format.ts";
import { isImage, postPics } from "../lib/markdown.ts";
import { threadRow } from "../lib/store.ts";
import { toast } from "../lib/toast.ts";
import { PREVIEW_MAX, closeViewer, markSet, marks, openPeek, peekBack, peekUrl, setStagedApi, showFile, useViewer } from "../lib/viewer.ts";
import type { PeekFile, ViewerFile } from "../lib/viewer.ts";

// The box's files, for a picture on it opened in the viewer; its comments go when it's taken off the box.
setStagedApi({ files: stagedOf, orig: (f) => stagedMarks.get(f)?.orig || f, url: stagedPic, isPic: isPicFile });
whenUnstaged((orig) => marks.delete(stagedPic(orig)));

// A page opens as itself, in a frame sandboxed like a named one's (its source a switch away).
const isPage = (name: string | null | undefined) => /\.html?$/i.test(name || "");
const isMarkdown = (name: string) => /\.(md|markdown|mdx)$/i.test(name);
// A markdown file's links go from its own folder: [the mockup](../designs/tasks.html).
const joinPath = (dir: string, rel: string) => rel.split("/").reduce((at, p) => (p === ".." ? at.slice(0, -1) : p === "." || !p ? at : [...at, p]), dir.split("/")).join("/");
const relink = (text: string, dir: string) => text.replace(/\]\((?![a-z]+:|[/~#])([^)\s]+)\)/gi, (m, u) => `](${joinPath(dir, u)})`);

// No preview: its kind, why, and Download.
function NoPreview({ f, url, why }: { f: Pick<ViewerFile, "name">; url: string; why: string }) {
  return (
    <div className="viewer-none">
      <span className="ext">{ext(f.name)}</span>
      <p>{why}</p>
      <a className="btn btn--dark" href={`${url}?download=1`}>
        <Icon name="download" />
        Download
      </a>
    </div>
  );
}

// A video or a sound in the viewer that won't load says why (its file's gone from its agent's machine, this browser
// can't play it), instead of a player stuck at 0:00. The player doesn't hear the answer, so it's asked again.
function Media({ f, url, video }: { f: ViewerFile; url: string; video: boolean }) {
  const [why, setWhy] = useState<string | null>(null);
  const failed = async () => {
    const res = await fetch(url, { headers: { range: "bytes=0-0" } }).catch(() => null);
    setWhy(res?.ok ? `This browser can't play this ${video ? "video" : "sound"}.` : (await res?.json().catch(() => null))?.error || "Couldn't load this file.");
  };
  if (why) return <NoPreview f={f} url={url} why={why} />;
  return video ? <video src={url} controls autoPlay playsInline onError={failed} /> : <audio src={url} controls autoPlay onError={failed} />;
}

// Whatever else it is, it's text if it has no zero bytes and reads as UTF-8: markdown rendered, JSON laid out.
function ViewerText({ f, url }: { f: ViewerFile; url: string }) {
  const [got, setGot] = useState<{ why?: string; text?: string } | null>(null);
  useEffect(() => {
    let gone = false;
    (async () => {
      const res = await fetch(url).catch(() => null);
      const bytes = res?.ok ? new Uint8Array(await res.arrayBuffer()) : null;
      let text = null;
      try {
        if (bytes && !bytes.subarray(0, 8192).includes(0)) text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {}
      if (gone) return; // closed, or on to another file
      if (!bytes) return setGot({ why: "Couldn't load this file." });
      if (text == null) return setGot({ why: "No preview for this kind of file." });
      setGot({ text });
    })();
    return () => void (gone = true);
  }, [url]);
  if (got?.why) return <NoPreview f={f} url={url} why={got.why} />;
  if (!got)
    return (
      <div className="viewer-text" data-viewer-text>
        <p className="muted">Loading…</p>
      </div>
    );
  let text = got.text;
  if (!text.trim())
    return (
      <div className="viewer-text">
        <p className="muted">This file is empty.</p>
      </div>
    );
  if (/\.(md|markdown)$/i.test(f.name))
    return (
      <div className="viewer-text">
        <Markdown text={text} pics={f.post ? postPics({ id: f.post }) : null} />
      </div>
    );
  if (/\.json$/i.test(f.name)) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {}
  }
  return (
    <div className="viewer-text">
      <pre>{text}</pre>
    </div>
  );
}

// A file as it shows: pictures, video and sound as they are, a PDF in a frame, a page as itself (or its source), and
// anything else as text, unless it's too big.
function Preview({ f, url, source }: { f: ViewerFile; url: string; source: boolean }) {
  if (f.image || isImage(f.name)) return <img src={url} alt={f.title} />;
  if (/\.(mp4|mov|m4v|webm)$/i.test(f.name)) return <Media f={f} url={url} video />;
  if (/\.(mp3|wav|m4a|ogg)$/i.test(f.name)) return <Media f={f} url={url} video={false} />;
  if (/\.pdf$/i.test(f.name)) return <iframe src={url} title={f.title} />;
  if (isPage(f.name) && !source) return <iframe sandbox="allow-scripts allow-forms allow-popups" src={url} title={f.title} />;
  if (f.size > PREVIEW_MAX) return <NoPreview f={f} url={url} why="Too big to show here." />;
  return <ViewerText f={f} url={url} />;
}

// A file of a set: its title and where it is in the set; Page or Source for a page; its arrows; a new tab, Download
// and close; then it, or the picture with its marks.
function FileView() {
  const list = useViewer((s) => s.list);
  const i = useViewer((s) => s.i);
  const source = useViewer((s) => s.source);
  useViewer((s) => s.rev);
  const f = list[i];
  if (!f) return null;
  const n = list.length;
  const url = f.url || `/api/files/${encodeURIComponent(f.id)}`;
  const meta = [f.meta, f.from === "human" ? "From you" : "", f.size ? kb(f.size) : "", n > 1 ? `${i + 1} of ${n}` : ""].filter(Boolean).join(", ");
  return (
    <>
      <header className="viewer-h">
        <span className="viewer-t">
          <b>{f.title}</b>
          <small>{meta}</small>
        </span>
        {isPage(f.name) && (
          <span className="peek-seg">
            {(
              [
                [false, "Page"],
                [true, "Source"],
              ] as [boolean, string][]
            ).map(([src, label]) => (
              <button key={label} type="button" className={source === src ? "is-on" : undefined} onClick={() => showFile(i, src)}>
                {label}
              </button>
            ))}
          </span>
        )}
        {n > 1 && (
          <>
            <button className="icon-btn" type="button" data-viewer-step="-1" aria-label="Previous file" title="Previous" onClick={() => showFile(i - 1)}>
              <Icon name="back" />
            </button>
            <button className="icon-btn" type="button" data-viewer-step="1" aria-label="Next file" title="Next" onClick={() => showFile(i + 1)}>
              <Icon name="next" />
            </button>
            <i className="viewer-sep" />
          </>
        )}
        <a className="icon-btn" href={url} target="_blank" rel="noopener" aria-label="Open in a new tab" title="Open in a new tab">
          <Icon name="external" />
        </a>
        <a className="icon-btn" href={f.download || `${url}${url.includes("?") ? "&" : "?"}download=1`} aria-label="Download" title="Download" {...(f.download ? { target: "_blank", rel: "noopener" } : {})}>
          <Icon name="download" />
        </a>
        <button className="icon-btn" type="button" aria-label="Close" title="Close" autoFocus onClick={closeViewer}>
          <Icon name="x" />
        </button>
      </header>
      {markable(f) ? (
        <MarksBody f={f} url={url} key={url} />
      ) : (
        <div className="viewer-body">
          <Preview f={f} url={url} source={source} key={`${url}|${source}`} />
        </div>
      )}
    </>
  );
}

function PeekLines({ text, hit, prose }: { text: string; hit: string; prose: boolean }) {
  const lines = text.replace(/\n$/, "").split("\n");
  return (
    <pre className={`peek-code${prose ? " is-prose" : ""}`} style={{ "--w": `${String(lines.length).length}ch` } as React.CSSProperties}>
      {lines.map((l, i) => (
        <span key={i} className={`ln${String(i + 1) === hit ? " is-hit" : ""}`} data-n={i + 1}>
          {l || " "}
        </span>
      ))}
    </pre>
  );
}
function PeekBody({ f }: { f: PeekFile | null }) {
  const pk = useViewer((s) => s.pk);
  if (pk.error)
    return (
      <div className="viewer-text">
        <p className="err">{pk.error}</p>
      </div>
    );
  if (!f)
    return (
      <div className="viewer-text">
        <p className="muted">Loading…</p>
      </div>
    );
  if (f.kind === "dir")
    return (
      <div className="viewer-text">
        {f.entries.length ? (
          <>
            <ul className="peek-dir">
              {f.entries.map((e) => (
                <li key={e.name}>
                  <button type="button" onClick={() => void openPeek(pk.post, `${f.path}/${e.name}`, "", pk.path)}>
                    <Icon name={e.dir ? "folder" : "file"} />
                    <span>
                      {e.name}
                      {e.dir ? "/" : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {f.more ? <p className="muted">And {plural(f.more, "more")}.</p> : f.truncated ? <p className="muted">And more.</p> : null}
          </>
        ) : (
          <p className="muted">This folder is empty.</p>
        )}
      </div>
    );
  if (f.kind === "image") return <img src={peekUrl(f.peek)} alt={f.name} />;
  // A video or a sound plays, from wherever it is (an OpenClaw agent's, a piece at a time from its machine).
  if (f.kind === "video") return <video src={peekUrl(f.peek)} controls preload="metadata" />;
  if (f.kind === "audio") return <audio src={peekUrl(f.peek)} controls preload="metadata" />;
  // One on another machine that it can't hand over comes without a link to download it.
  if (f.kind === "binary")
    return (
      <div className="viewer-none">
        <span className="ext">{ext(f.name)}</span>
        {f.peek ? (
          <>
            <p>No preview for this kind of file.</p>
            <a className="btn btn--dark" href={peekUrl(f.peek)} download={f.name}>
              <Icon name="download" />
              Download
            </a>
          </>
        ) : (
          <p>No preview for this kind of file, and it's on another machine.</p>
        )}
      </div>
    );
  if (f.kind === "html" && !pk.source) return <iframe sandbox="allow-scripts allow-forms allow-popups" src={peekUrl(f.peek)} title={f.name} />;
  if (!f.text.trim())
    return (
      <div className="viewer-text">
        <p className="muted">This file is empty.</p>
      </div>
    );
  return (
    <div className="viewer-text">
      {isMarkdown(f.name) && !pk.source ? <Markdown text={relink(f.text, f.path.slice(0, f.path.lastIndexOf("/")))} peek={pk.post} /> : <PeekLines text={f.text} hit={pk.line} prose={/\.(md|markdown|mdx|txt|rst|log)$/i.test(f.name)} />}
      {f.truncated ? (
        <p className="muted">
          That's the first {kb(f.text.length)} of {kb(f.size)}.
        </p>
      ) : null}
    </div>
  );
}

// A file an agent named, as its folder has it: a page as itself, in a sandboxed frame, markdown rendered (either one
// as its source too), anything else as numbered lines, down to the line it was named with (`app.ts:42`).
function PeekView() {
  const pk = useViewer((s) => s.pk);
  const body = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState<boolean | null>(null);
  const f = pk.data;
  // Once it's read, at the line it was named with.
  const at = `${pk.post}|${pk.path}|${pk.line}`;
  const seen = useRef("");
  useEffect(() => {
    if (!f || seen.current === at) return;
    seen.current = at;
    body.current?.querySelector(".is-hit")?.scrollIntoView({ block: "center" });
  }, [f, at]);
  const name = f?.name || pk.path.replace(/\/$/, "").split("/").pop();
  const changed = f?.modified && (ago(f.modified) === "now" ? "changed just now" : `changed ${ago(f.modified)} ago`);
  const meta = f ? [f.kind === "dir" ? "" : kb(f.size), changed, tildeOn(machineOf(threadRow(pk.post) || {}), f.path)].filter(Boolean).join(", ") : pk.path;
  const both = f && (f.kind === "html" || (f.kind === "text" && isMarkdown(f.name)));
  const setSource = (source: boolean) => useViewer.setState((s) => ({ pk: { ...s.pk, source } }));
  return (
    <>
      <header className="viewer-h">
        {pk.back.length ? (
          <button className="icon-btn peek-back" type="button" aria-label="Back" title="Back" onClick={peekBack}>
            <Icon name="back" />
          </button>
        ) : null}
        <span className="viewer-t">
          <b>{name}</b>
          <small className="peek-meta" title={f?.path || pk.path}>
            {meta}
          </small>
        </span>
        {both && (
          <span className="peek-seg">
            {(
              [
                [false, f.kind === "html" ? "Page" : "Preview"],
                [true, "Source"],
              ] as [boolean, string][]
            ).map(([src, label]) => (
              <button key={label} type="button" className={pk.source === src ? "is-on" : undefined} onClick={() => setSource(src)}>
                {label}
              </button>
            ))}
          </span>
        )}
        {pk.diff?.path === pk.path && (
          <a className="icon-btn" href={pk.diff.href} aria-label="What changed in it" title="What changed in it, that turn" onClick={closeViewer}>
            <Icon name="diff" />
          </a>
        )}
        {f?.peek && f.kind !== "dir" && (
          <a className="icon-btn" href={peekUrl(f.peek)} target="_blank" rel="noopener" aria-label="Open in a new tab" title="Open in a new tab">
            <Icon name="external" />
          </a>
        )}
        {/* A toast would be under the viewer: the button says it instead. */}
        {f && (
          <button
            className="icon-btn"
            type="button"
            aria-label="Copy its path"
            title={copied == null ? "Copy its path" : copied ? "Copied" : "Couldn't copy it"}
            onClick={async () => {
              const ok = await (navigator.clipboard?.writeText(f.path).then(() => true, () => false) ?? Promise.resolve(false));
              setCopied(ok);
              setTimeout(() => setCopied(null), 1500);
            }}
          >
            <Icon name={copied == null ? "copy" : copied ? "check" : "x"} />
          </button>
        )}
        <button className="icon-btn" type="button" aria-label="Close" title="Close" autoFocus onClick={closeViewer}>
          <Icon name="x" />
        </button>
      </header>
      <div className="viewer-body" ref={body}>
        <PeekBody f={f} />
      </div>
    </>
  );
}

// The dialog, drawn once. Its close (×, Esc, the backdrop) says what it kept of the marks you wrote on a picture.
export function FileViewer() {
  const open = useViewer((s) => s.open);
  const mode = useViewer((s) => s.mode);
  const multi = useViewer((s) => s.mode === "file" && s.list.length > 1);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  // The arrows step through the set, but in a player or a box.
  useEffect(() => {
    if (!open || !multi) return;
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.matches("video, audio, textarea, input")) return;
      const { i } = useViewer.getState();
      if (e.key === "ArrowLeft") showFile(i - 1);
      if (e.key === "ArrowRight") showFile(i + 1);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [open, multi]);
  // Marks you wrote on a picture stay for when you open it again, and it says so.
  const closed = () => {
    const s = useViewer.getState();
    const f = s.mode === "file" ? s.list[s.i] : null;
    const m = f && markable(f) && markSet();
    if (m) {
      m.pins = m.pins.filter((p) => p.text.trim());
      const one = m.pins.length === 1;
      const st = f.staged;
      if (m.pins.length && !s.kept) toast(`Kept your ${one ? "comment" : plural(m.pins.length, "comment")} on that picture: open it again to ${st ? "add" : "send"} ${one ? "it" : "them"}${st ? " to your message" : ""}.`);
    }
    useViewer.setState({ open: false, kept: false, markOpen: null });
  };
  return (
    <dialog
      ref={ref}
      className="viewer"
      data-viewer=""
      aria-label="File"
      onClose={closed}
      // Esc in a mark's box closes the box, not the viewer.
      onCancel={(e) => Date.now() - markEscAt() < 200 && e.preventDefault()}
      onClick={(e) => {
        if (e.target === ref.current) return closeViewer(); // the backdrop
        // Anywhere else in the viewer: a mark's open box closes.
        closeMarks();
      }}
    >
      {open && (mode === "peek" ? <PeekView /> : <FileView />)}
      {open && mode === "file" && <MarksPop />}
    </dialog>
  );
}
