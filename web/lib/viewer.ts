// The file viewer: a file opens over the page rather than in a new tab: pictures, video and sound show as they are, a
// PDF in a frame, and anything that reads as text as text (markdown rendered). Cmd- or ctrl-click still opens the tab.
// The arrows step through the files next to the one you clicked. A file an agent named (`notes/plan.md`) opens in the
// same viewer, read from its thread's folder (openPeek). <FileViewer/> (components/FileViewer.tsx) draws it, once;
// this is how anything opens it.
import { create } from "zustand";
import { mdActions } from "./markdown.ts";
import { signedOut } from "./session.ts";
import { getApp } from "./store.ts";
import type { FileRecord, Step } from "./types.ts";

// A file in the viewer: a thread's (`id`, `from`, the thread it's from), a picture (`image`, `url`), or one of yours
// still to send (`staged`), with what it's called and where it downloads from.
export interface ViewerFile {
  id: string;
  url?: string;
  image?: boolean;
  staged?: { key: string; file: File };
  name: string;
  title: string;
  size?: number;
  download?: string | null;
  from?: string;
  post?: string;
  meta?: string;
}
// A file an agent named, as its machine read it: a folder's entries, a file's text (its first part, when it's big), or
// where its bytes are (`peek`) for a picture, a video, a sound, a page.
export interface PeekFile {
  kind: string;
  name: string;
  path: string;
  size?: number;
  modified?: string;
  text?: string;
  truncated?: boolean;
  entries?: { name: string; dir?: boolean }[];
  more?: number;
  peek?: { id: string; path: string } | null;
}
// The file open in the viewer: whose files (`post`), its path, the line it was named with, what was read, and the
// trail Back goes up. `diff`: where its changes are, while it's the file open.
export interface Peek {
  post: string | null;
  path: string;
  line: string;
  data: PeekFile | null;
  error: string | null;
  source: boolean;
  back: string[];
  diff?: { path: string; href: string } | null;
}
// What the viewer shows: a file of a set (`list`, the one open `i`, a page as its source or not), or a file an agent
// named (`mode` "peek", `pk`). `post`: the thread what's open is shown in. `kept`: its close has nothing to say.
// `rev` counts changes to the marks (kept outside the store, by picture).
export interface ViewerState {
  open: boolean;
  mode: "file" | "peek";
  list: ViewerFile[];
  i: number;
  source: boolean;
  post: string | null;
  kept: boolean;
  pk: Peek;
  // Which of the open picture's marks has its box open.
  markOpen: number | null;
  rev: number;
}
const NO_PEEK: Peek = { post: null, path: "", line: "", data: null, error: null, source: false, back: [], diff: null };
export const useViewer = create<ViewerState>(() => ({ open: false, mode: "file", list: [], i: 0, source: false, post: null, kept: false, pk: NO_PEEK, markOpen: null, rev: 0 }));
const V = useViewer.getState;
const setV = useViewer.setState;
export const PREVIEW_MAX = 2 * 1048576; // past this, text is a download rather than a preview

/* ---------- marks on a picture, kept while you step through the others or close it ---------- */
// A picture's address -> { post, name, pins: [{ x, y, text }] }, x and y 0–1 from its top left.
export interface MarkSet {
  post: string | null;
  name: string;
  pins: { x: number; y: number; text: string }[];
}
export const marks = new Map<string, MarkSet>();
export const markUrl = (f: ViewerFile) => f.url || `/api/files/${encodeURIComponent(f.id)}`;
export const markSet = (): MarkSet | undefined => {
  const s = V();
  const f = s.mode === "file" ? s.list[s.i] : null;
  return f ? marks.get(markUrl(f)) : undefined;
};
export const marksChanged = (o: Partial<ViewerState> = {}) => setV((s) => ({ ...o, rev: s.rev + 1 }));

/* ---------- opening a file ---------- */
// Show the set's file `i` (round), as its page or its source. Marks with nothing written on them don't stay.
export function showFile(i: number, source = false) {
  const was = V().open && markSet();
  if (was) was.pins = was.pins.filter((p) => p.text.trim());
  const n = V().list.length;
  if (!n) return;
  setV({ open: true, mode: "file", i: (i + n) % n, source, markOpen: null, rev: V().rev + 1 });
}
// Open these files, at `i`, shown in thread `post`.
export function openFiles(list: ViewerFile[], i = 0, post: string | null = null) {
  if (!list.length) return;
  setV({ list, post });
  showFile(Math.max(0, i));
}
// A thread's file, as the viewer reads it.
export type FileShown = Pick<FileRecord, "id" | "name"> & { size?: number; from?: string; post?: string | null; title?: string };
export const viewerFile = (f: FileShown): ViewerFile => ({ id: f.id, name: f.name, title: f.title || f.name, size: Number(f.size) || 0, from: f.from || "", post: f.post || "" });
const shownIn = (el: Element | null) => el?.closest<HTMLElement>("[data-thread]")?.dataset.thread || getApp().open?.detail?.id || null;
// Open a file, its arrows going through `set` (the files next to it).
export function openFile(file: FileShown, set: FileShown[] = []) {
  const list = (set.length ? set : [file]).map(viewerFile);
  const i = Math.max(0, list.findIndex((f) => f.id === file.id));
  openFiles(list, i, file.post || getApp().open?.detail?.id || null);
}
// A chip of a file (FileChip, a cover's picture, a gallery's), clicked: in a set of them (`data-file-set`), its
// arrows go through the set; else through the files next to it. What the viewer reads of each is on its data-*.
export function openFileFrom(chip: HTMLElement) {
  const set = chip.closest("[data-file-set]");
  const chips = set ? [...set.querySelectorAll<HTMLElement>("a[data-file]")] : [...chip.parentElement.querySelectorAll<HTMLElement>(":scope > [data-file]")];
  const list = chips.map((a) => ({ id: a.dataset.file, name: a.dataset.name, title: a.dataset.title, size: Number(a.dataset.size) || 0, from: a.dataset.from, post: a.dataset.post }));
  openFiles(list, Math.max(0, chips.indexOf(chip)), shownIn(chip));
}
// A picture in markdown (an agent's note, a comment) opens the same way, its arrows going through the other
// pictures in the same text (a reply's cards: the other cards'). One from elsewhere on the web downloads as itself.
export function openPicture(a: HTMLElement) {
  const pics = [...(a.closest(".md, .cmt-bub, .updates li, .post-text, .rs-opts") || a.parentElement).querySelectorAll<HTMLElement>("a.md-img")];
  const list = pics.map((p) => {
    const url = p.getAttribute("href");
    return { id: url, url, image: true, name: "", title: p.querySelector("img")?.alt || p.getAttribute("aria-label") || "Picture", download: url.startsWith("/api/") ? null : url };
  });
  openFiles(list, Math.max(0, pics.indexOf(a)), shownIn(a));
}
// The pictures a session's agent saw, in order: the screenshots it took, the images it read or made. They stay in
// its transcript; each step says how many it has.
export function shotsOf(post: string, steps: Step[]): ViewerFile[] {
  return steps
    .filter((st) => st.images > 0)
    .flatMap((st) => Array.from({ length: st.images }, (_, i) => ({ id: `${st.id}/${i}`, url: `/api/sessions/${encodeURIComponent(post)}/images/${encodeURIComponent(st.id)}/${i}`, image: true, name: "", title: st.title, meta: clockOf(st.at) })));
}
const clockOf = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date().toDateString() === d.toDateString() ? d.toTimeString().slice(0, 5) : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};
// One opens in the viewer, whose arrows go through the rest.
export function openShot(post: string, id: string, steps: Step[]) {
  const list = shotsOf(post, steps);
  const i = list.findIndex((f) => f.id === id);
  if (i >= 0) openFiles(list, i, post);
}
// A picture on a box, not sent yet (components/thread/staged.tsx), its arrows going through the box's others. One you
// commented on opens as it was, your marks over it.
let stagedApi: { files: (key: string) => File[]; orig: (f: File) => File; url: (f: File) => string; isPic: (f: File) => boolean } | null = null;
// The box's files, as components/thread/staged.tsx keeps them (FileViewer hands them over).
export const setStagedApi = (api: typeof stagedApi) => void (stagedApi = api);
export function openStagedPic(key: string, i: number) {
  if (!stagedApi) return;
  const files = stagedApi.files(key);
  const pics = files.filter(stagedApi.isPic);
  if (!pics.includes(files[i])) return;
  const list = pics.map((f) => {
    const o = stagedApi.orig(f);
    const url = stagedApi.url(o);
    return { id: url, url, image: true, staged: { key, file: f }, name: o.name, title: o.name, size: o.size, download: url };
  });
  openFiles(list, pics.indexOf(files[i]), null);
}
export const closeViewer = () => setV({ open: false });

/* ---------- a file an agent named ---------- */
// `post` is the post whose files it reads, or `ws:<agent>` for an agent's own workspace (an OpenClaw agent's).
export const peekSrc = (key: string, p: string) => `${key.startsWith("ws:") ? `/api/agents/${encodeURIComponent(key.slice(3))}/workspace/file` : `/api/sessions/${encodeURIComponent(key)}/file`}?path=${encodeURIComponent(p)}`;
// On the previews' own origin, when the server has one (AGENTBOOK_PREVIEW_URL).
export const peekUrl = (l: { id: string; path: string }) => `${getApp().data?.preview || ""}/api/peek/${encodeURIComponent(l.id)}/${l.path.split("/").map(encodeURIComponent).join("/")}`;
const setPk = (o: Partial<Peek>) => setV((s) => ({ pk: { ...s.pk, ...o } }));
// Open a file its agent named. `from`: the file it was named in, for Back; `diff`: where its changes are (a reply's
// "Changed" chip), a button on it while it's the file open.
export async function openPeek(thread: string, path: string, line = "", from: string | null = null, diff: string | null = null) {
  const s = V();
  const was = s.open ? s.pk : NO_PEEK;
  const back = s.open && s.mode === "peek" ? [...was.back] : [];
  if (from) back.push(from);
  const keepDiff = s.open && s.mode === "peek" ? was.diff : null;
  setV({ open: true, mode: "peek", list: [], kept: false, markOpen: null, pk: { post: thread, path, line: line || "", data: null, error: null, source: !!line, back, diff: diff ? { path, href: diff } : keepDiff } });
  const res = await fetch(peekSrc(thread, path)).catch(() => null);
  if (res?.status === 401) return signedOut();
  const data = await res?.json().catch(() => null);
  const now = V();
  if (!now.open || now.mode !== "peek" || now.pk.post !== thread || now.pk.path !== path) return;
  if (res?.ok) setPk({ data });
  else setPk({ error: data?.error || "Couldn't open it." });
}
// Back up the trail.
export function peekBack() {
  const { pk } = V();
  if (!pk.back.length || !pk.post) return;
  const to = pk.back.at(-1);
  setPk({ back: pk.back.slice(0, -1) });
  void openPeek(pk.post, to);
}
// The file that's open again, where you were in it, now that it changed (an agent's workspace file it watches).
export async function refreshPeek() {
  const { post, path } = V().pk;
  if (!post) return;
  const res = await fetch(peekSrc(post, path)).catch(() => null);
  const data = res?.ok ? await res.json().catch(() => null) : null;
  const now = V();
  if (!data || now.pk.post !== post || now.pk.path !== path || !now.open) return;
  setPk({ data });
}
// What's open in the viewer as a file an agent named, if anything (for what watches it change).
export const peekShown = (): Peek | null => (V().open && V().mode === "peek" ? V().pk : null);

// A file named in markdown opens here; from inside the viewer, Back goes to the file it was named in.
mdActions.peek = (thread, path, line) => {
  const s = V();
  void openPeek(thread, path, line, s.open && s.mode === "peek" ? s.pk.path : null);
};

// What the old page caught from anywhere on it, for what draws without asking the viewer itself: a chip of a file
// (`a[data-file]`, in any area's lists), a picture in markdown (`a.md-img`), a file named with data-peek. A
// cmd-, ctrl-, shift- or alt-click still opens the tab. A click something already handled is left alone.
if (typeof document !== "undefined") {
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || !(e.target instanceof Element)) return;
    const t = e.target;
    if (t.closest("dialog.viewer") && !t.closest("a.md-img, [data-peek]")) return;
    const plain = !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);
    const file = t.closest<HTMLElement>("a[data-file]");
    if (file && plain) {
      e.preventDefault();
      return openFileFrom(file);
    }
    const pic = t.closest<HTMLElement>("a.md-img");
    if (pic && plain) {
      e.preventDefault();
      return openPicture(pic);
    }
    const named = t.closest<HTMLElement>("[data-peek]");
    if (named?.dataset.path) {
      // One that's a link too (a reply's "Changed" chip) goes there on a cmd- or ctrl-click, as a file chip does.
      if (named.tagName === "A") {
        if (!plain) return;
        e.preventDefault();
      }
      const s = V();
      void openPeek(named.dataset.peek, named.dataset.path, named.dataset.line || "", s.open && s.mode === "peek" ? s.pk.path : null, named.dataset.diff || null);
    }
  });
  // A picture in markdown that won't load (its file's gone from its agent's machine, its site took it down) says
  // so, instead of showing as broken.
  document.addEventListener(
    "error",
    (e) => {
      const a = e.target instanceof HTMLImageElement && e.target.closest("a.md-img");
      if (!a) return;
      const gone = document.createElement("span");
      gone.className = "md-img-gone";
      gone.textContent = `${(e.target as HTMLImageElement).alt || "A picture"}: this picture isn't there any more.`;
      a.replaceWith(gone);
    },
    true,
  );
}
