// People on other agentbooks in a group, task, page or note of yours (server/api/people-spaces.ts): the ones you asked
// who haven't said yes yet (they're in it, as anyone is, only once they do; Take back withdraws the ask), and the
// threads the ones in it put in it, which stay on their machines and show here as their copies.
import { create } from "zustand";
import { post } from "../../lib/api.ts";
import { agoText } from "../../lib/format.ts";
import { useLoad } from "../../lib/hooks.ts";
import { personHref, theirThingHref } from "../../lib/route.ts";
import { toast } from "../../lib/toast.ts";

type Asked = { username: string | null; handle: string | null; name: string | null; state: "asked" | "in"; at: string };
type Theirs = { key: string; id: string; username: string | null; handle: string | null; title: string; state: string | null; updated: string };
const useAsks = create<{ n: number }>(() => ({ n: 0 }));
const enc = encodeURIComponent;

// What putting someone in it answered: someone elsewhere is asked, not in yet.
export function saidAsked(r: { asked?: boolean; user?: string } | null | undefined, words: string): boolean {
  if (!r?.asked) return false;
  useAsks.setState((s) => ({ n: s.n + 1 }));
  toast(`Asked @${r.user} into ${words}, on their agentbook: they're in it once they say yes.`);
  return true;
}

export function AskedElsewhere({ kind, id }: { kind: "group" | "task" | "page" | "note"; id: string }) {
  const n = useAsks((s) => s.n);
  const asks = useLoad<{ people: Asked[]; threads: Theirs[] }>(`/api/spaces/${kind}/${enc(id)}/elsewhere`, n);
  const waiting = (asks.data?.people || []).filter((p) => p.state === "asked" && p.username);
  if (!waiting.length) return null;
  const takeBack = async (p: Asked) => {
    if ((await post(`/api/spaces/${kind}/${enc(id)}/elsewhere/${enc(p.username!)}/take-back`, {})).ok) toast(`Took back your ask to @${p.username || p.handle}.`);
    asks.reload();
  };
  return (
    <div className="asked-elsewhere">
      <p className="ver-h">Asked, on other agentbooks</p>
      {waiting.map((p) => (
        <p key={p.username} className="asked-row">
          <a href={personHref(p.username!)}>@{p.username || p.handle}</a>
          <span className="muted">
            {" "}
            asked {agoText(p.at)}, not in it until they say yes
          </span>
          <button className="btn btn--sm btn--line" type="button" onClick={() => takeBack(p)}>
            Take back
          </button>
        </p>
      ))}
    </div>
  );
}

// Their threads in it, for its rail (a group's) or under its threads (a task's).
export function ThreadsElsewhere({ kind, id, card = false }: { kind: "group" | "task"; id: string; card?: boolean }) {
  const n = useAsks((s) => s.n);
  const got = useLoad<{ people: Asked[]; threads: Theirs[] }>(`/api/spaces/${kind}/${enc(id)}/elsewhere`, n);
  const list = (got.data?.threads || []).filter((t) => t.username);
  if (!list.length) return null;
  const rows = list.map((t) => (
    <p key={t.key} className="asked-row">
      <a href={theirThingHref(t.username!, t.key)}>{t.title || "A thread"}</a>
      <span className="muted">
        {" "}
        @{t.username || t.handle}'s{t.state ? ` · ${t.state}` : ""} · {agoText(t.updated)}
      </span>
    </p>
  ));
  return card ? (
    <section className="card rail-card">
      <h3 className="rail-h">From other agentbooks</h3>
      {rows}
      <p className="muted rail-note">Their threads stay on their machines: these are their copies, read only.</p>
    </section>
  ) : (
    <div className="asked-elsewhere">
      <p className="ver-h">From other agentbooks</p>
      {rows}
    </div>
  );
}
