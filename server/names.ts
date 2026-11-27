// Another thread, named in a thread's words: agents name each other's threads by
// their names ("petrel's branch brings 7 back"), and the page makes each a link to the thread by that name that was
// around at the same time. Names repeat over time (there are 24 birds), and agentbook gives a new thread a name no
// other open thread has (freeName in store.ts). If two fit, the one in the same project, then the one still open,
// then the latest. The server works it out, over the threads the person may see, and sends what a thread's words
// need with it: a card, the names its words use; a thread's page, every name around it.

import type { Iso } from "../plugin/shared/types.ts";
import { reEsc } from "../plugin/shared/text.ts";

// A thread as names reads it (a row of the view).
export interface Named {
  id: string;
  label?: string | null;
  agent?: string | null;
  title?: string | null;
  root?: string | null;
  archived?: boolean;
  state?: string;
  started?: Iso;
  updated?: Iso;
  ended?: Iso | null;
}
// The thread a name means: enough to link to it.
export interface NameRef {
  id: string;
  agent: string | null;
  label: string;
  title: string;
}

const endOf = (s: Named) => (s.state === "done" ? Date.parse(s.ended || s.updated) : Date.now());

// Each name around `from` (a thread, as the view has it), and the thread it means: name -> { id, agent, label, title }.
export function namesNear(sessions: Named[], from: Named | null | undefined): Map<string, NameRef> {
  const names = new Map<string, NameRef>();
  if (!from?.id) return names;
  const start = Date.parse(from.started);
  const end = endOf(from);
  const rank = (s: Named): [number, number, string] => [s.root && s.root === from.root ? 1 : 0, s.archived ? 0 : 1, s.updated || ""];
  const better = (a: Named, b: Named) => {
    const x = rank(a);
    const y = rank(b);
    return x[0] - y[0] || x[1] - y[1] || String(x[2]).localeCompare(String(y[2]));
  };
  const best = new Map<string, Named>();
  for (const s of sessions) {
    if (s.id === from.id || !s.label || Date.parse(s.started) > end || endOf(s) < start) continue;
    const had = best.get(s.label);
    if (!had || better(s, had) > 0) best.set(s.label, s);
  }
  for (const [label, s] of best) names.set(label, { id: s.id, agent: s.agent ?? null, label: s.label, title: s.title || "" });
  return names;
}

// The names a thread's words use, of those around it (as the page finds them: a whole word, not inside a path or an
// address), as an object.
export function namesIn(names: Map<string, NameRef>, texts: unknown[]): Record<string, NameRef> {
  if (!names.size) return {};
  const re = new RegExp(`(^|[^\\w/.@-])(${[...names.keys()].sort((a, b) => b.length - a.length).map(reEsc).join("|")})(?![\\w/-])`, "g");
  const out: Record<string, NameRef> = {};
  for (const t of texts) for (const m of String(t || "").matchAll(re)) out[m[2]] = names.get(m[2]);
  return out;
}
