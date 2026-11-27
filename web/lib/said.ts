// What you say about something you point at, as a thread's message: lines of a diff (dvcText), or marks on a picture
// (marksText). Its agent reads the words as they are; the thread reads them back (dvQuote, marksQuote) to draw the
// quote, so the two sides of each pair have to agree. test/said.ts checks they do.

/* ---------- lines of a diff ---------- */
// lines: [{ c: "+" | "-" | " ", o, n, text }], o and n its line numbers before and after (null where it has none).
export interface DiffLine {
  c: string;
  o: number | null;
  n: number | null;
  text: string;
}

// The lines, as their numbers say: the file's lines now, or, when they're all removed ones, where they were.
export function dvcWhere<L extends Pick<DiffLine, "o" | "n">>(lines: L[]): string {
  const span = (ns: number[]): string => (ns.length ? (Math.min(...ns) === Math.max(...ns) ? `line ${ns[0]}` : `lines ${Math.min(...ns)}–${Math.max(...ns)}`) : "");
  const now = lines.map((l) => l.n).filter(Number.isFinite);
  if (now.length) return span(now);
  const was = span(lines.map((l) => l.o).filter(Number.isFinite));
  return was ? `removed ${was}` : "";
}
export const DVC_MAX = 60; // lines quoted at most
// What goes to its agent: the file and lines (and the commit, for one of its commits), the lines as a diff, then what
// you wrote. The fence is longer than any run of backticks in the lines.
export function dvcText({ path, commit = "", lines }: { path: string; commit?: string; lines: DiffLine[] }, text: string): string {
  const where = dvcWhere(lines);
  const body = lines.slice(0, DVC_MAX).map((l) => `${l.c === "+" || l.c === "-" ? l.c : " "}${l.text}`).join("\n");
  const fence = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `On ${path}${where ? `, ${where}` : ""}${commit ? ` (commit ${commit})` : ""}:\n${fence}diff\n${body}\n${fence}\n${text}`;
}
const DVQ = /^On (.+?)(?:, ((?:removed )?lines? \d+(?:–\d+)?))?(?: \(commit ([0-9a-f]{4,40})\))?:\n(`{3,})diff\n([\s\S]*?)\n\4(?:\n|$)/;
// A message that starts with such a quote: { path, where, commit, lines (as written: sign, then the code), rest }.
export function dvQuote(text: unknown): { path: string; where: string; commit: string; lines: string[]; rest: string } | null {
  const m = DVQ.exec(String(text || ""));
  return m ? { path: m[1], where: m[2] || "", commit: m[3] || "", lines: m[5].split("\n"), rest: String(text).slice(m[0].length) } : null;
}

/* ---------- marks on a picture ---------- */
// pins: [{ x, y, text }], x and y 0–1 from its top left.
export interface Pin {
  x: number;
  y: number;
  text: string;
}

export const markSpot = (p: Pin): string => `${Math.round(p.x * 100)}% across, ${Math.round(p.y * 100)}% down`;
export const MARKS_HEAD = /^Comments on the picture /;
// What goes to its agent: the picture (`copy`: the name of the copy with the marks drawn on it, attached; without one,
// `url`, where the picture is), then each comment by its number and where it is. A comment's next lines are indented,
// so they stay its own.
export function marksText(name: string, pins: Pin[], { copy = "", url = "" }: { copy?: string; url?: string } = {}): string {
  const what = `“${name}”${copy ? ` (attached as ${copy}, with my numbered marks on it)` : `, ${url}`}`;
  return `Comments on the picture ${what}, each at a spot given as how far across and down the picture it is:\n${pins.map((p, i) => `${i + 1}. (${markSpot(p)}) ${p.text.trim().replace(/\n/g, "\n   ")}`).join("\n")}`;
}
// Such a message: { name, items: [{ n, text }] }, or null.
export function marksQuote(text: unknown): { name: string; items: { n: string; text: string }[] } | null {
  const [head, ...rest] = String(text || "").split("\n");
  const name = MARKS_HEAD.test(head) ? /^Comments on the picture “(.*?)”/.exec(head)?.[1] : null;
  if (name == null) return null;
  const items: { n: string; text: string }[] = [];
  for (const l of rest) {
    const m = /^(\d+)\. \(\d+% across, \d+% down\) ?(.*)$/.exec(l);
    if (m) items.push({ n: m[1], text: m[2] });
    else if (items.length && /^ {3}/.test(l)) items.at(-1).text += `\n${l.slice(3)}`;
    else return null;
  }
  return items.length ? { name, items } : null;
}

// Either one, in a line: what it's on, then what you said. Anything else as it is.
export function saidShort(text: string): string {
  const q = dvQuote(text);
  if (q) return `${q.path}${q.where ? `, ${q.where}` : ""}: ${q.rest.trim()}`;
  const m = marksQuote(text);
  return m ? `On “${m.name}”: ${m.items.map((x) => `${x.n}. ${x.text}`).join(" ")}` : text;
}
