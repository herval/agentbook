// What <Markdown> (components/Markdown.tsx) needs to know beyond markdown itself: which links and pictures may show,
// which words name a file an agent can open, and the words other parts of the page turn into chips (an @page, a
// thread's name). Those parts register themselves here, so Markdown doesn't import every screen.
import type { ReactNode } from "react";
import { webUrl } from "./format.ts";

// A link that may show: a web page, or one of agentbook's own files (a UUIDv7 now, `f<n>` from before, and either
// with its machine's name in front where the page renamed it).
export const mdUrl = (u: string): string | null => (/^https?:\/\//i.test(u) || /^\/api\/files\/[\w~-]+(\?download=1)?$/.test(u) ? u : null);
// A picture from elsewhere on the web comes through the agentbook that has its post or page, which keeps a copy (see
// /api/sessions/:id/picture), so the site it's on never sees who's looking. `pics`: where a post's or a page's
// pictures come from; without one, a picture loads from where it is.
export const postPics = (s: { id?: string } | null | undefined) => (s?.id ? `/api/sessions/${encodeURIComponent(s.id)}/picture` : null);
export const pagePics = (p: { id?: string } | null | undefined) => (p?.id ? `/api/pages/${encodeURIComponent(p.id)}/picture` : null);
export const picUrl = (url: string, pics: string | null) => (pics && webUrl(url) ? `${pics}?url=${encodeURIComponent(url)}` : url);
// A picture on its agent's machine, by its path (a screenshot it took, `/tmp/shot.png`): its post or page keeps a copy.
export const localPic = (url: string) => !/^[a-z][\w+.-]*:/i.test(url) && /\.(png|jpe?g|gif|webp)$/i.test(url) && !!filePath(url);
export const isImage = (n: string) => /\.(png|jpe?g|gif|webp|svg)$/i.test(n);

// A file an agent names, like `notes/plan.md`, `~/notes.txt`, `app.ts:42` or `designs/`: its path and line, or null.
// Without a slash, only a name with a known extension counts (so not `s.root`).
const FILE_EXT = /\.(md|markdown|mdx|txt|rst|html?|css|s[ac]ss|less|[cm]?[jt]sx?|json|jsonl|ya?ml|toml|ini|conf|cfg|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|zsh|bash|sql|csv|tsv|log|xml|svg|png|jpe?g|gif|webp|lock|diff|patch|proto|graphql|vue|svelte|lua|ipynb|tf|plist)$/i;
export function filePath(s: string): { path: string; line: string } | null {
  const m = s.match(/^(.+?)(?::(\d+)(?::\d+)?|#L(\d+))?$/);
  const p = m?.[1];
  if (!p || p.length > 300 || !/^[\w.@+~/-]+$/.test(p) || /\/\/|^~[^/]|.~/.test(p)) return null;
  const last = p.replace(/\/$/, "").split("/").pop();
  const named = !p.includes("/") ? FILE_EXT.test(p) && /^[\w@+-]/.test(p) : p.endsWith("/") ? /\w/.test(last) : /^[\w@+-][\w.@+-]*\.[A-Za-z]\w{0,9}$/.test(last);
  return named ? { path: p, line: m[2] || m[3] || "" } : null;
}

// Where a piece of markdown is: the thread whose files a named file opens from (`peek`), where its pictures come from
// (`pics`), and the thread whose names its words may use (`from`).
export interface MdContext {
  peek?: string | null;
  pics?: string | null;
  from?: string | null;
}
// Words another part of the page draws as something else: `re` finds them in text (global; group 1, when it has one,
// is what comes before and stays text), `render` draws one, or returns null to leave it as it was.
export interface InlineToken {
  name: string;
  re: (cx: MdContext) => RegExp | null;
  render: (m: RegExpExecArray, cx: MdContext) => ReactNode | null;
}
export const inlineTokens: InlineToken[] = [];
export function registerInline(t: InlineToken) {
  const i = inlineTokens.findIndex((x) => x.name === t.name);
  if (i >= 0) inlineTokens[i] = t;
  else inlineTokens.push(t);
}
// What a named file does when clicked (the thread page's viewer opens it), and what a code block can run.
export const mdActions: {
  peek: ((thread: string, path: string, line: string) => void) | null;
  // A runnable code block's ▶, in its corner beside Copy, and what it printed, under it (the thread page draws them).
  play: ((run: CodeRunAt) => ReactNode) | null;
  runs: ((run: CodeRunAt) => ReactNode) | null;
  // Whether it's running now, so the block says so: a hook, set once when the thread page's code loads.
  useRunning: ((run: CodeRunAt | null) => boolean) | null;
} = { peek: null, play: null, runs: null, useRunning: null };
// A code block in a thread's message that may run in the thread's folder: the thread, the message, which block of
// the message it is, and whether you may run it.
export interface CodeRunAt {
  post: string;
  mid: string;
  block: number;
  play?: boolean;
  code: string;
}
