// Connectors: other tools whose work comes in as tasks, or whose numbers your dashboards show (#/connectors, and the
// card beside Tasks). What they say in words (each kind's name, what it's for, how its card and form say things),
// what's open on the page (a form, Remove pressed once, a sign-in with GitHub under way), and what their buttons do.
import { Fragment, useState } from "react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { create } from "zustand";
import { getJSON, post } from "../../lib/api.ts";
import { hiddenAgent, seniority, startable } from "../../lib/agents.ts";
import { webUrl } from "../../lib/format.ts";
import { signedOut } from "../../lib/session.ts";
import { agentOf, getApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { AgentSeen, ConnectorKind, ConnectorRow, GhApp, GhInstalls, GhSignin, GhSigninPoll } from "../../lib/types.ts";
import { Icon } from "../Icon.tsx";

/* ---------- connectors: other tools whose work comes in as tasks ---------- */

export type ConnectorCategory = "tasks" | "data" | "cloud";
export const CATEGORY_LABELS: Record<ConnectorCategory, string> = { tasks: "Tasks & code", data: "Data", cloud: "Cloud" };
export const CATEGORY_TAG: Record<ConnectorCategory, string> = { tasks: "Tasks", data: "Data", cloud: "Cloud" };

export const KIND_NAMES: Record<string, string> = { linear: "Linear", github: "GitHub", datadog: "Datadog", boat: "boat", exe: "exe.dev" };
export const KIND_ABOUT: Record<string, string> = {
  datadog: "Read-only metrics, APM spans, monitors and events for dashboards.",
  linear: "Assigned issues in your Tasks, synced bidirectionally on tick.",
  github: "Assigned issues, PR review requests, and workspace pull requests.",
  boat: "Wake cloud sandboxes on demand and manage starter images.",
  exe: "Make VMs that install agentbook and join your account; resume paused ones.",
};

export function categoryOf(x: ConnCtx, kind: string): ConnectorCategory {
  const k = kindOf(x, kind);
  if (k?.machines || kind === "boat") return "cloud";
  if ((k?.data && !k?.tasks) || kind === "datadog") return "data";
  return "tasks";
}

// Brand marks for known connectors, falling back to category icons for future or custom kinds.
const BRAND_SVG: Record<string, ReactNode> = {
  github: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M12 2.25a9.75 9.75 0 0 0-3.08 19c.49.09.67-.21.67-.47v-1.68c-2.72.59-3.29-1.31-3.29-1.31-.44-1.13-1.09-1.43-1.09-1.43-.89-.61.07-.6.07-.6.98.07 1.5 1.01 1.5 1.01.87 1.49 2.29 1.06 2.85.81.09-.63.34-1.06.62-1.31-2.17-.25-4.46-1.09-4.46-4.84 0-1.07.38-1.94 1.01-2.63-.1-.25-.44-1.24.1-2.59 0 0 .82-.26 2.68 1a9.35 9.35 0 0 1 4.88 0c1.86-1.26 2.68-1 2.68-1 .54 1.35.2 2.34.1 2.59.63.69 1.01 1.56 1.01 2.63 0 3.76-2.29 4.59-4.47 4.83.35.3.66.9.66 1.81v2.69c0 .26.18.56.67.47A9.75 9.75 0 0 0 12 2.25Z" />
    </svg>
  ),
  linear: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M3.15 13.72a9.16 9.16 0 0 0 7.13 7.13L3.15 13.72Zm-.43-2.69 10.25 10.25a9.3 9.3 0 0 0 2.09-.56L3.28 8.94a9.3 9.3 0 0 0-.56 2.09Zm1.49-3.95L16.92 19.8a9.3 9.3 0 0 0 1.48-1.15L5.35 5.6a9.3 9.3 0 0 0-1.14 1.48Zm2.8-2.67L19.6 17a9.2 9.2 0 0 0-12.6-12.6Z" />
    </svg>
  ),
  datadog: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M4.5 19.5V11h3v8.5h-3Zm5.25 0V6.5h3v13h-3Zm5.25 0v-9.5h3v9.5h-3Z" />
      <circle cx="16.5" cy="6.2" r="2.1" fill="currentColor" />
    </svg>
  ),
  // Not exe.dev's own mark: a shell prompt, for the VMs you ssh into.
  exe: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M5 7.5 9.5 12 5 16.5M12 17h7" />
    </svg>
  ),
  boat: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M12 4v8M12 4l6 5.5H12M4.5 14h15l-1.8 4.2a2 2 0 0 1-1.84 1.2H8.14a2 2 0 0 1-1.84-1.2L4.5 14Z" />
    </svg>
  ),
};

export function ConnectorBrand({ kind, cat, size = "" }: { kind: string; cat?: ConnectorCategory; size?: "" | "sm" }) {
  const known = BRAND_SVG[kind];
  const fallback = cat === "cloud" ? "laptop" : cat === "data" ? "gauge" : "plug";
  return <span className={`cn-brand${known ? ` cn-brand--${kind}` : ""}${size ? ` cn-brand--${size}` : ""}`}>{known || <Icon name={fallback} />}</span>;
}
// How each kind's card and form say things: its key, which of its work comes in, where from, and what ticking does.
export interface KindText {
  key: string;
  keyHelp: string;
  placeholder: string;
  what: string;
  teams: ReactNode;
  teamsEmpty: string;
  everywhere: string;
  upper: boolean;
  closeOn: [string, string];
}
export const KIND_TEXT: Record<string, KindText> = {
  linear: {
    key: "API key",
    keyHelp: "in Linear: Settings › Account › Security & Access › New API key",
    placeholder: "lin_api_…",
    what: "Issues assigned to you, in",
    teams: (
      <>
        Teams <small>their keys, like ENG; empty for every team</small>
      </>
    ),
    teamsEmpty: "Every team",
    everywhere: "in every team",
    upper: true,
    closeOn: ["Ticking a task closes its issue", "In its team's first done state. Unticking puts it back the way it was."],
  },
  github: {
    key: "Token",
    keyHelp: "a personal access token, from GitHub's Settings › Developer settings › Personal access tokens: one that reads your repos' pull requests, contents, checks and statuses, and their issues (and writes issues, to close them)",
    placeholder: "github_pat_… or ghp_…",
    what: "What comes into your Tasks",
    teams: (
      <>
        Repos and organizations <small>owner/name, or an organization's name; empty for all of them</small>
      </>
    ),
    teamsEmpty: "All of them",
    everywhere: "in every repo",
    upper: false,
    closeOn: ["Ticking an issue's task closes it on GitHub", "And unticking opens it again. A review's task goes once you've reviewed it."],
  },
};
export const kindText = (kind: string): KindText => KIND_TEXT[kind] || KIND_TEXT.linear;
// The name of the connector something came from (a task's source): the one set up, else its kind's.
export const connectorName = (s: { connector?: string; kind?: string }, connectors: ConnectorRow[] | undefined = getApp().data?.connectors): string =>
  (connectors || []).find((c) => c.id === s.connector)?.name || KIND_NAMES[s.kind] || s.kind;

// A connector as /api/connectors and the chrome show it: how its last sync went (`syncing`, `synced`, `error`,
// `count`), as whom (`who`), where its key comes from (`key_env`), whether it can't be read here (`locked`), the
// queries a Data one answered in the last hour (`calls`), what a boat key can't be seen to do (`lacks`), and where
// a task connector's tasks go (`workspace`, `agent`) and from where (`teams`).
export type ConnSeen = Omit<ConnectorRow, "teams"> & {
  teams?: string[];
  syncing?: boolean;
  synced?: string | null;
  error?: string | null;
  count?: number | null;
  who?: string | null;
  key_env?: string | null;
  locked?: boolean;
  calls?: number;
  lacks?: string[];
  workspace?: string | null;
  agent?: string | null;
};
// What the page read besides the connectors: each kind there is, agentbook's GitHub App, and where it's installed.
export interface ConnCtx {
  kinds: ConnectorKind[];
  app: GhApp | null;
  installs: GhInstalls | null;
}
export const kindOf = (x: ConnCtx, kind: string): ConnectorKind | undefined => x.kinds.find((k) => k.kind === kind);
// A connector with a Data side and no Tasks (Datadog): what it answers dashboards with, and as whom.
// A kind with keys and nothing about tasks: one that answers dashboards (Datadog), or wakes machines (boat).
export const dataOnly = (x: ConnCtx, kind: string): boolean => (!!kindOf(x, kind)?.data || !!kindOf(x, kind)?.machines) && !kindOf(x, kind)?.tasks;
export const secretLabel = (v: unknown, name: string): string => (typeof v === "string" ? v : (v as { label?: string } | null)?.label || name);

// What's open on Connectors, kept while you go elsewhere and come back, as the old page's S was: the form open (a
// connector's id, or "new:<kind>"), Remove pressed once, a sign-in with GitHub under way, pasting a token instead of
// signing in, what happened making agentbook's GitHub App (`note`), and a count that asks for the list again (`seq`).
interface ConnUi {
  edit: string | null;
  removing: string | null;
  signin: GhSignin | null;
  token: boolean;
  note: string | null;
  seq: number;
}
export const useConnUi = create<ConnUi>(() => ({ edit: null, removing: null, signin: null, token: false, note: null, seq: 0 }));
export const setConnUi = useConnUi.setState;
export const reloadConnectors = () => setConnUi((s) => ({ seq: s.seq + 1 }));

// Open a connector's form (its id), or a new one's ("new:<kind>"); Remove pressed once is forgotten.
export const openForm = (which: string) => setConnUi({ edit: which, removing: null });
// Close the form, with any sign-in under way and the token toggle.
export const closeForm = () => setConnUi({ edit: null, signin: null, token: false });

// Sync a connector now (or check its keys): what went wrong is said, and Connectors reads its list again.
export async function syncConnector(id: string) {
  const r = await post<{ connector?: { error?: string } }>(`/api/connectors/${encodeURIComponent(id)}/sync`);
  if (r.ok && r.data.connector?.error) toast(r.data.connector.error);
  const rt = getApp().route;
  if (rt.name === "connectors" || (rt.name === "person" && rt.tab === "settings" && rt.sub === "connectors")) reloadConnectors();
}

// Remove, pressed once, asks; pressed again, removes it. A boat or exe.dev connector's machines are deleted with it
// there (`machines: "delete"`) or left there, unmanaged ("leave"). `where`: boat or exe.dev.
export async function removeConnector(id: string, machines?: "delete" | "leave", where = "boat") {
  if (useConnUi.getState().removing !== id) return setConnUi({ removing: id });
  setConnUi({ removing: null });
  const r = await post(`/api/connectors/${encodeURIComponent(id)}/delete`, machines ? { machines } : {});
  if (r.ok) toast(machines === "delete" ? `Removed, with its machines on ${where}.` : machines ? `Removed. Its machines stay on ${where}, and agentbook no longer wakes them.` : "Removed. Its tasks stay on your list.");
  else if (!r.data.passkey) toast(r.data.error || "Couldn't remove it.");
  reloadConnectors();
}

// Sign in with Linear: for a connector being made (its settings), or one signing in again (`{ id }`). The page goes to
// Linear, which sends it back to Connectors, where what came of it is said.
export async function linearSignin(body: object) {
  const r = await post<{ url?: string }>("/api/linear/signin", body);
  if (r.ok && r.data.url) return window.location.assign(r.data.url);
  toast(r.data.error || "Couldn't start signing in with Linear.");
}
// Either sign-in, by kind: `form` is the form or card it's for, which a sign-in with GitHub shows its code in.
export const signin = (kind: string, form: string, body: object) => (kind === "linear" ? linearSignin(body) : githubSignin(form, body));

// Start a sign-in with GitHub: for a connector being made (its settings), or one signing in again.
export async function githubSignin(form: string, body: object) {
  const res = await fetch("/api/github/signin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data: { id?: string; user_code?: string; verification_uri?: string; expires_in?: number; error?: string } = await res.json().catch(() => ({}));
  if (res.status === 401) return signedOut();
  if (!res.ok) return toast(data.error || `Something went wrong (HTTP ${res.status})`);
  setConnUi({ signin: { id: data.id, form, user_code: data.user_code, verification_uri: data.verification_uri, until: Date.now() + data.expires_in * 1000, error: null, body } });
  window.open(webUrl(data.verification_uri) || "about:blank", "_blank", "noopener");
  waitGithub(data.id);
}
// Until GitHub says yes (or no, or the code runs out): then the connector is theirs, signed in.
async function waitGithub(id: string) {
  const ui = useConnUi.getState;
  while (ui().signin?.id === id) {
    await new Promise((r) => setTimeout(r, 2000));
    if (ui().signin?.id !== id) return;
    const r = await getJSON<GhSigninPoll>(`/api/github/signin/${encodeURIComponent(id)}`);
    if (ui().signin?.id !== id) return;
    if (!r || r.status === "pending") continue;
    if (r.status === "done") {
      setConnUi({ signin: null, edit: null, token: false });
      toast(`Signed in with GitHub${r.connector?.who ? ` as ${r.connector.who}` : ""}. Your workspaces' pull requests are read as you.`);
      return reloadConnectors();
    }
    setConnUi({ signin: { ...ui().signin, error: r.error || "GitHub didn't sign you in." } });
    return;
  }
}

export function ListOf({ items }: { items: ReactNode[] }) {
  return (
    <>
      {items.map((x, i) => (
        <Fragment key={i}>
          {i === 0 ? "" : i === items.length - 1 ? " and " : ", "}
          {x}
        </Fragment>
      ))}
    </>
  );
}
// A labelled box in a form, as the old page's field() drew one.
export function Field({ label, ...input }: { label: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="field">
      <span>{label}</span>
      <input {...input} />
    </label>
  );
}
// A button that syncs a connector now, and stays pressed while it does, as the old page's `sync.disabled = true` did.
export function SyncBtn({ id, disabled, children, ...rest }: { id: string; disabled?: boolean; children: ReactNode } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "type">) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      {...rest}
      type="button"
      disabled={disabled || busy}
      onClick={async () => {
        setBusy(true);
        try {
          await syncConnector(id);
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
    </button>
  );
}

// Where and who a task is for, picked under it as you add or edit it. Sending it picks them in the composer.
// The agents are the ones you can post to, offline ones too: the task may wait for one.
export const taskAgents = (keep: string | null | undefined): AgentSeen[] => {
  const list: AgentSeen[] = (getApp().data?.agents || []).filter((a) => startable(a) && !hiddenAgent(a)).sort((a, b) => seniority(a).localeCompare(seniority(b)));
  return keep && !list.some((a) => a.id === keep) ? [...list, agentOf(keep)] : list;
};
