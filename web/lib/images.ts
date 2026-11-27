// An image for cloud machines, as its page draws it (server/images.ts keeps
// it). The image is a draft its owner edits: every change here is saved at once, and Build makes the draft a
// version. One sorted list of what agentbook can install, the picked ones first, with a chip per kind; the owner's
// own lists, repos, steps, settings and secrets under it; then each build, with what its script said.
//
// Here: what the page reads of them, and the words it says, as data. components/machines/ draws them.

import type { ImageBuild, ImageDef } from "../../plugin/shared/types.ts";

export type { CloudView, ImageSummary } from "../../plugin/shared/api.ts";
import type { CloudView, ImageSummary } from "../../plugin/shared/api.ts";

// Something agentbook can install on an image (server/integrations/connectors/boat-catalog.ts's catalogView).
export interface CatalogEntry {
  id: string;
  label: string;
  kind: string;
  about: string;
  versions?: string[];
  always?: boolean;
}
// A part of a build's script, as its log says it went (server/image-script.ts's LogStep).
export interface BuildStep {
  label: string;
  state: "ok" | "failed" | "running";
  seconds: number | null;
  out: string;
}
// A build, as its image's page shows it (server/images.ts's view).
export interface BuildView {
  v: number;
  state: ImageBuild["state"];
  started: string;
  ended: string | null;
  error: string | null;
  sandbox: string | null;
  snapshot: string | null;
  cli: string | null;
  size: string;
  step: string | null;
  steps: BuildStep[];
  outcome: "ok" | "failed" | null;
  seconds: number | null;
  changes: string[];
}
// An image of yours, whole (server/images.ts's view): its draft, its newest built version, and its builds.
export interface ImageView {
  id: string;
  name: string;
  connector: string | null;
  def: ImageDef;
  v: number;
  updated: string;
  built: { v: number; at: string | null; snapshot: string | null; def: ImageDef } | null;
  building: number | null;
  // What Build would change, since the newest built version.
  changes: string[] | null;
  // A build that failed, with the draft as it is now.
  tried: number | null;
  builds: BuildView[];
}
// A connector of yours that runs machines (boat's, or exe.dev's), as the forms read it.
export interface BoatChoice {
  id: string;
  kind?: string;
  name: string;
  off?: boolean;
  settings?: { size?: string; idle?: string; org?: string };
}
export interface MachineSeen {
  name: string;
  online?: boolean;
  cloud?: CloudView | null;
}
// What the page knows besides the image: agentbook's catalog and sizes, your boat connectors and machines, whether
// GitHub is connected, and whether this agentbook-server can build at all.
export interface ImagesCtx {
  catalog?: CatalogEntry[];
  sizes?: Record<string, string>;
  cli?: string | null;
  unreachable?: string | null;
  boat?: BoatChoice[];
  machines?: MachineSeen[];
  github?: boolean;
  busy?: boolean;
  images?: ImageView[] | null;
  signs?: boolean;
  repos?: string[];
}
// What's open on an image's page: the catalog's filter and More, each build's whole log and whether it's open, and
// Delete pressed once.
export interface ImageUi {
  id?: string;
  f?: string | null;
  more?: boolean;
  logs?: Record<number, string>;
  open?: Record<number, boolean>;
  busy?: boolean;
  deleting?: boolean;
}
// New machine, In the cloud, as typed so far.
export interface CloudFormState {
  connector: string;
  image: string;
  size: string;
  repo: string;
  name: string;
  secrets: Record<string, string>;
  // On exe.dev: how Claude Code there signs in ("signin", as you, or "gateway", through exe.dev's).
  claude?: string;
  busy: boolean;
  error: string | null;
}


// The kinds of thing the catalog has: each one's chip, and the pills that narrow the list to one.
export const KINDS: Record<string, string> = { agent: "Agent", version: "Version", service: "Service", tool: "Tool" };
export const KIND_PILLS: [string, string][] = [["agent", "Agents"], ["version", "Versions"], ["service", "Services"], ["tool", "Tools"]];
export const BOAT_HAS = "Ubuntu 24.04 with passwordless sudo · Node 24, 22, 20 · Python 3.12 and uv · Go 1.23 · Rust · Java 11 · Bun · Deno · pnpm · Ruby · PHP · .NET 8 · Docker with Compose · Google Chrome · git · gh · ripgrep · jq · ffmpeg · Claude Code · Codex · OpenClaw · Hermes, and more. agentbook adds to that list; it doesn't install them again.";
// How many of the catalog show under All before More.
export const SHOWN = 15;

// What's picked of the catalog in a definition: { id: version | true }.
export function pickedOf(def: Pick<ImageDef, "agents" | "picks">): Record<string, string | true> {
  const on: Record<string, string | true> = {};
  for (const a of def.agents || []) on[a] = true;
  for (const p of def.picks || []) {
    const [id, v] = p.split("@");
    on[id] = v || true;
  }
  return on;
}
export const span = (seconds: number | null): string => (seconds == null ? "" : seconds < 90 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`);
// What's typed in one of the lists (apt, npm, uv), as its words.
export const imWords = (v: unknown): string[] =>
  String(v || "")
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
export const sizeFace = (size: string, sizes: Record<string, string> | undefined): string => `${size} · ${(sizes?.[size] || "").split(",").slice(0, 2).join(",")}`;
// A change since the built version, as its name and what happened to it: ["Redis", " added"].
export const changeParts = (c: string): [string, string] => {
  const m = c.match(/^(.*?)( added| removed| changed|$)/);
  return [m?.[1] ?? c, m?.[2] ?? ""];
};
export const goingOf = (img: ImageView): BuildView | undefined => img.builds.find((b) => b.state === "building" || b.state === "saving");

// The catalog as one list: agentbook itself first (always on it), then what agentbook can install; the picked ones
// first, narrowed to `f` ("all", "picked" or a kind).
export function catalogOf(img: ImageView, ctx: Pick<ImagesCtx, "catalog" | "cli">, f: string) {
  const on = pickedOf(img.def);
  const items: CatalogEntry[] = [{ id: "agentbook", label: "agentbook", kind: "always", about: `agentbook-cli and the plugin at this server's version${ctx.cli ? ` (${ctx.cli})` : ""}, downloaded from it, with their systemd unit, so they're back at every wake.`, always: true }, ...(ctx.catalog || [])];
  const picked = (c: CatalogEntry): boolean => !!c.always || c.id in on;
  const sorted = [...items].sort((a, b) => Number(picked(b)) - Number(picked(a)));
  const shown = sorted.filter((c) => f === "all" || (f === "picked" ? picked(c) : c.kind === f));
  return { on, items, picked, shown, n: items.filter(picked).length };
}
export const kindChip = (c: CatalogEntry): string => (c.kind === "always" || c.always ? (c.kind === "agent" ? "Agent, always" : "Always") : KINDS[c.kind]);

export const cloudState = (m: MachineSeen): string => (m.cloud.updating ? "Updating" : m.cloud.setting ? "Setting up" : m.online ? "On" : m.cloud.waking ? "Waking" : "Asleep");
export const behindOf = (img: Pick<ImageView, "built">, m: MachineSeen): boolean => !!img.built && m.cloud.v != null && m.cloud.v < img.built.v;

// A build's whole log, its script's markers as lines a person reads.
export const logText = (full: string): string => full.replace(/^::(step|ok|failed|end).*$/gm, (l) => l.replace(/^::step /, "\n# ").replace(/^::ok (\d+)/, "# ok, $1 s").replace(/^::failed /, "# failed: ").replace(/^::end /, "# ended: "));
// What a build's row says of it: when, how long, how big, which agentbook.
export function buildFacts(b: BuildView, ago: (iso: string) => string, day: (iso: string) => string): string {
  const when = b.ended || b.started;
  return [when ? (Date.now() - Date.parse(when) < 86400e3 ? ago(when) : day(when)) : "", span(b.seconds), b.size, b.cli ? `agentbook ${b.cli}` : ""].filter(Boolean).join(" · ");
}

export const summaryState = (i: ImageSummary): string => (i.state === "building" || i.state === "saving" ? `building v${i.v}${i.step ? `: ${i.step}` : ""}` : i.built ? `v${i.built} built` : i.state === "failed" ? `v${i.v} failed` : "not built yet");

// New machine, In the cloud: what a machine made from `img` starts as (Basic without one).
export function cloudHow(img: ImageView | null): string {
  if (!img) return "Basic: agentbook and Claude Code. It installs them as it starts, which takes a minute or two.";
  if (img.built) {
    const n = img.changes?.length || 0;
    return `Starts from ${img.name} v${img.built.v}, ready in seconds.${n ? ` Its draft has ${n === 1 ? "a change" : `${n} changes`} that ${n === 1 ? "isn't" : "aren't"} built, and ${n === 1 ? "isn't" : "aren't"} in it.` : ""}`;
  }
  return `${img.name} isn't built, so the machine installs everything on it as it starts. That takes minutes; a build makes it seconds.`;
}
// The secrets a machine made from `img` asks for: its own, and Claude Code's token when it signs in with one.
export const askedOf = (img: ImageView | null): string[] => (img ? [...new Set([...(img.def.secrets || []), ...(img.def.claude === "token" ? ["CLAUDE_CODE_OAUTH_TOKEN"] : [])])] : []);
// The kinds of connector that run machines (server/integrations/connectors/machines.ts), and each one's name.
export const CLOUD_KINDS = ["boat", "exe"];
export const cloudName = (kind?: string | null): string => (kind === "exe" ? "exe.dev" : "boat");
// The name a new machine gets when none is typed: boat-<its repo's name> (exe-<…> on exe.dev).
export const cloudNameOf = (repo: string, kind = "boat"): string => {
  const name = String(repo || "")
    .trim()
    .split("/")
    .pop()
    .replace(/\.git$/, "");
  return name ? `${kind}-${name.toLowerCase()}` : `${kind}-machine`;
};
