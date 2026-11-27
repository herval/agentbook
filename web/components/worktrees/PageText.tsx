// A line of markdown inside a sentence (the old page's mdInline): what a thread's result says, or a bit of what was said
// on GitHub, on a worktree's page. Its `code`, links, pictures, **bold**, *italics* and ~~strikes~~; a file it names
// opens in the viewer (`peek`, in a thread whose files you can see); and its web addresses and the words other parts
// of the page draw as something else (an @page, a thread's name: lib/markdown.ts's registerInline) as those.
import { Fragment } from "react";
import type { ReactNode } from "react";
import { webUrl } from "../../lib/format.ts";
import { filePath, localPic, mdUrl } from "../../lib/markdown.ts";
import type { Thread } from "../../lib/types.ts";
import { openPeek } from "../../lib/viewer.ts";
import { plainParts } from "../thread/Plain.tsx";

// The thread whose files a file it names opens from: one of yours, not in a vendor's cloud.
export const peekOf = (s: Thread) => (s.mine !== false && s.rt?.kind !== "cloud" ? s.id : null);

// What's markdown in a line, leftmost first: `code` (1), a picture (2 alt, 3 url), a link (4 text, 5 url), one in <>
// (6), a bare web address (7, as it is), **bold** (8), ~~struck~~ (9), *italics* (10 before, 11) and _italics_ (12
// before, 13).
const INLINE = new RegExp(
  [
    "`([^`]+)`",
    "!\\[([^\\]]*)\\]\\(([^)\\s]+)\\)",
    "\\[([^\\]]+)\\]\\(([^)\\s]+)\\)",
    "<(https?:\\/\\/[^\\s<>]+)>",
    "(https?:\\/\\/[^\\s<*]*[^\\s<.,;:!?)*_~\"'>])",
    "\\*\\*(.+?)\\*\\*",
    "~~(.+?)~~",
    "(^|[^\\w*])\\*(?!\\s)(.+?)(?<!\\s)\\*(?!\\w)",
    "(^|[^\\w])_(?!\\s)(.+?)(?<!\\s)_(?!\\w)",
  ].join("|"),
  "g",
);

function PeekButton({ peek, path, line, children }: { peek: string; path: string; line: string; children: ReactNode }) {
  return (
    <button className="md-path" type="button" title={`Open ${path}`} onClick={() => void openPeek(peek, path, line)}>
      {children}
    </button>
  );
}
// A web address, as a link that opens in a new tab.
const urlLink = (url: string, label: ReactNode, key: string) => (
  <a className="md-link" href={url} target="_blank" rel="noopener" key={key}>
    {label}
  </a>
);

// Its parts: what's markdown drawn, the text between as plain text with its words and addresses.
function inlineParts(text: string, cx: { peek: string | null; pics: string | null; from: string | null }, key = "m"): ReactNode[] {
  const out: ReactNode[] = [];
  const named = (p: string) => (cx.peek ? filePath(p) : null);
  const plain = (s: string, k: string) => out.push(<Fragment key={k}>{plainParts(s, cx)}</Fragment>);
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const k = `${key}${n++}`;
    const lead = m[10] ?? m[12] ?? "";
    const at = m.index + lead.length;
    if (at > last) plain(text.slice(last, at), `${k}t`);
    last = m.index + m[0].length;
    if (m[1] != null) {
      const code = m[1];
      const f = named(code);
      out.push(/^https?:\/\/\S+$/i.test(code) ? urlLink(code, <code>{code}</code>, k) : f ? <PeekButton key={k} peek={cx.peek} path={f.path} line={f.line}><code>{code}</code></PeekButton> : <code key={k}>{code}</code>);
    } else if (m[3] != null) {
      const url = m[3];
      const src = cx.pics && (webUrl(url) || localPic(url)) ? `${cx.pics}?url=${encodeURIComponent(url)}` : mdUrl(url);
      // One that can't show here is a link to it, if anything.
      if (src)
        out.push(
          <a className="md-img" href={src} target="_blank" rel="noopener" key={k}>
            <img src={src} alt={m[2]} loading="lazy" />
          </a>,
        );
      else plain(m[0].slice(1), k);
    } else if (m[5] != null) {
      const f = named(m[5]);
      if (mdUrl(m[5])) out.push(urlLink(m[5], m[4], k));
      else if (f) out.push(<PeekButton key={k} peek={cx.peek} path={f.path} line={f.line}>{m[4]}</PeekButton>);
      else plain(m[0], k);
    } else if (m[6] != null) out.push(urlLink(m[6], m[6], k));
    else if (m[7] != null) plain(m[7], k);
    else if (m[8] != null) out.push(<b key={k}>{inlineParts(m[8], cx, `${k}-`)}</b>);
    else if (m[9] != null) out.push(<s key={k}>{inlineParts(m[9], cx, `${k}-`)}</s>);
    else out.push(<i key={k}>{inlineParts(m[11] ?? m[13], cx, `${k}-`)}</i>);
  }
  if (last < text.length) plain(text.slice(last), `${key}end`);
  return out;
}

// A line of markdown, drawn inline. `peek`: the thread whose files it may open; `pics`: where its pictures come from;
// `from`: the thread whose names its words may use.
export function InlineMd({ text, peek = null, pics = null, from = null }: { text: string; peek?: string | null; pics?: string | null; from?: string | null }) {
  return <>{inlineParts(String(text || ""), { peek, pics, from })}</>;
}
