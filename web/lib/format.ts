export { plural, reEsc } from "../../plugin/shared/text.ts";

// A link from data (an agent's, or another person's machine's): only to a web page, never javascript: or data:.
// Null for anything else.
export const webUrl = (u: unknown): string | null => (/^https?:\/\//i.test(String(u || "")) ? String(u) : null);

// How long ago: "now", "5m", "3h", "2d".
export function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
export const agoText = (iso: string | null | undefined): string => (ago(iso) === "now" ? "just now" : `${ago(iso)} ago`);
// The time of day today, else the day.
export function clock(iso: string): string {
  const d = new Date(iso);
  return new Date().toDateString() === d.toDateString() ? d.toTimeString().slice(0, 5) : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
export const dayTime = (iso: string): string => new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
export const firstLine = (t: unknown): string => String(t || "").split("\n").find((l) => l.trim()) || "";
export const listText = (xs: string[]): string => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
export const model = (m: string | null | undefined): string => {
  const x = String(m || "").match(/^claude-([a-z]+)-(\d+)-(\d+)/);
  return x ? `${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}.${x[3]}` : m || "";
};
export const tokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n || 0));
export const kb = (n: number): string => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
export const ext = (name: string): string => (String(name || "").split(".").pop() || "").slice(0, 4).toUpperCase();

// An agent on another machine is "laptop~claude"; it looks like Claude, and says which machine.
export const baseId = (id: string): string => String(id).split("~").pop();
// One hue per agent: [its colour, its tint].
const HUES: Record<string, [string, string]> = { claude: ["#6a4fd1", "#eeeafb"] };
const CYCLE: [string, string][] = [["#0d8574", "#e0f3ef"], ["#d9434b", "#fce8e9"], ["#b8800f", "#f8efdb"], ["#2f6fd0", "#e6effc"], ["#c2418f", "#fae6f1"]];
export function hue(agentId: string | null | undefined): [string, string] {
  if (agentId == null) return ["#8a93a0", "#eef0f3"];
  const id = baseId(agentId);
  if (HUES[id]) return HUES[id];
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return CYCLE[h % CYCLE.length];
}
export const hueVars = (agentId: string | null | undefined) => ({ "--hue": hue(agentId)[0], "--tint": hue(agentId)[1] }) as React.CSSProperties;
export const hueCss = (agentId: string | null | undefined) => `--hue:${hue(agentId)[0]};--tint:${hue(agentId)[1]}`;
// A page's colour: the one picked for it, else its agent's, else ink.
export const PAGE_COLORS: Record<string, [string, string]> = { purple: ["#6a4fd1", "#eeeafb"], teal: CYCLE[0], red: CYCLE[1], amber: CYCLE[2], blue: CYCLE[3], pink: CYCLE[4], green: ["#23845a", "#e4f2ea"], gray: ["#4a5462", "#eef0f3"] };
export function pageHue(p: { color?: string | null; by?: { agent?: string | null } | null }): [string, string] {
  if (p.color && PAGE_COLORS[p.color]) return PAGE_COLORS[p.color];
  return p.by?.agent ? hue(p.by.agent) : ["#121821", "#e3e6ea"];
}
// A group's colour comes from its id, so it stays put.
export function groupHue(g: { id: string }): [string, string] {
  let h = 0;
  for (const c of String(g.id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return CYCLE[h % CYCLE.length];
}
// Their colours as a style prop, and as a style attribute (for what's drawn as HTML: the box's chips, a note's words).
const vars = ([h, t]: [string, string]) => ({ "--hue": h, "--tint": t }) as React.CSSProperties;
const css = ([h, t]: [string, string]) => `--hue:${h};--tint:${t}`;
export const pageStyle = (p: Parameters<typeof pageHue>[0]) => vars(pageHue(p));
export const groupStyle = (g: { id: string }) => vars(groupHue(g));
export const pageCss = (p: Parameters<typeof pageHue>[0]) => css(pageHue(p));
export const groupCss = (g: { id: string }) => css(groupHue(g));
export const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// A thread of your own, by its id.
export const isTalkId = (id: unknown): boolean => /^t-[0-9a-f]{12}$/.test(String(id || ""));
export const tilde = (p: string, home?: string | null): string => (home && p?.startsWith(home) ? `~${p.slice(home.length)}` : p);
