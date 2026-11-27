// The profile's Usage card: how much of each usage limit its plan gives it has been used, and when each resets; for an
// OpenClaw agent, each provider its gateway signs in to. Its owner's only.
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { signedOut } from "../../lib/session.ts";
import type { Limits } from "../../lib/types.ts";
import { DEFAULT_KIND, kindCaps } from "../../lib/agents.ts";
import { Icon } from "../Icon.tsx";
import type { AgentRow } from "./types.ts";
import { agoText } from "../../lib/format.ts";

type Window = Limits["limits"][number]["windows"][number];
interface Credits {
  unlimited?: boolean;
  balance?: number | string | null;
  unit?: string;
  period?: string;
  used?: number;
  limit?: number | null;
}

// How much of its plan's usage limits the open agent of yours has used (cli/limits.ts): read as its profile opens,
// and again as one of its turns starts or ends, at most every 30 seconds (its machine keeps them a minute anyway).
// Only for an agent whose runtime's machine reads them (shared/runtimes.ts, `limits`).
export function useLimits(a: AgentRow | undefined): Limits | null {
  const [L, setL] = useState<Limits | null>(null);
  const had = useRef(L);
  had.current = L;
  const id = a?.id;
  const none = !a || a.mine === false || !kindCaps(a.kind || DEFAULT_KIND)?.limits;
  const machine = a?.machine;
  const load = useCallback(async () => {
    if (!id) return;
    if (none) return setL({ none: true, read: Date.now() });
    const res = await fetch(`/api/agents/${encodeURIComponent(id)}/limits`).catch(() => null);
    if (res?.status === 401) return signedOut();
    const data = res ? await res.json().catch(() => ({})) : {};
    setL((was) => (res?.ok ? { ...data, read: Date.now() } : res?.status === 404 ? { none: true, read: Date.now() } : { ...(was?.limits ? was : { limits: [] }), error: data.offline ? `${machine || "Its machine"} is off.` : data.error || "Couldn't read them.", read: Date.now() }));
  }, [id, none, machine]);
  useEffect(() => {
    load();
  }, [load]);
  // One of its turns started or ended: it used some of its limits.
  const working = a?.working || 0;
  const seen = useRef(working);
  useEffect(() => {
    if (seen.current === working) return;
    seen.current = working;
    if (!had.current?.none && Date.now() - (had.current?.read || 0) > 30e3) load();
  }, [working, load]);
  return L;
}

function resetText(iso: string) {
  const ms = Date.parse(iso) - Date.now();
  if (!(ms > 60e3)) return "Resets any moment";
  const d = new Date(iso);
  const hm = d.toTimeString().slice(0, 5);
  if (ms < 3600e3) return `Resets in ${Math.round(ms / 60e3)}m`;
  if (ms < 86400e3) return `Resets in ${Math.round(ms / 3600e3)}h, at ${hm}`;
  return `Resets ${d.toLocaleDateString(undefined, ms < 6 * 86400e3 ? { weekday: "short" } : { month: "short", day: "numeric" })} at ${hm}`;
}
function CreditsText({ c }: { c: Credits }) {
  if (c.unlimited) return <>Unlimited credits</>;
  if (c.balance != null)
    return (
      <>
        <b>{String(c.balance)}</b> credits left
      </>
    );
  const money = (n: number) => (c.unit && c.unit !== "USD" ? `${n.toFixed(2)} ${c.unit}` : `$${n % 1 ? n.toFixed(2) : n}`);
  const per = c.period === "month" ? " this month" : c.period ? ` in ${c.period}` : "";
  return c.limit != null ? (
    <>
      Extra usage: <b>{money(c.used)}</b> of {money(c.limit)}
      {per}
    </>
  ) : (
    <>
      Spent <b>{money(c.used)}</b>
      {per}
    </>
  );
}
function LimitRow({ w }: { w: Window }) {
  const tone = w.used >= 100 ? " lim--out" : w.used >= 80 ? " lim--high" : "";
  const n = Math.round(w.used);
  return (
    <li className={`lim${tone}`}>
      <div className="lim-top">
        <b>{w.label}</b>
        <span>{n}% used</span>
      </div>
      <span className="lim-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={n} aria-label={w.label}>
        <i style={{ width: `${Math.max(w.used, 1)}%` }} />
      </span>
      {w.resets && <small>{resetText(w.resets)}</small>}
    </li>
  );
}

export function LimitsCard({ agent: a, limits: L }: { agent: AgentRow; limits: Limits | null }) {
  if (a.mine === false || !L || L.none) return null;
  const list = (L.limits || []).filter((x) => x.windows?.length || x.credits || x.error || x.blocked);
  if (!list.length && !L.error) return null;
  const many = list.length > 1;
  const plan = (x: { plan?: string }) => (x.plan ? <span className="lim-plan">{x.plan}</span> : null);
  const shared = kindCaps(a.kind)?.limits === "shared" ? `Its gateway's sign-ins${L.host ? `, on ${L.host}` : ""}: the same for each of its agents. ` : "";
  const when = L.offline && L.as_of ? `As of ${agoText(L.as_of)}, while its machine is off.` : L.at ? `Read ${agoText(L.at)}.` : "";
  return (
    <section className="card box lims-card">
      <h3>
        Usage
        {many ? null : plan(list[0] || {})}
      </h3>
      {list.map((x, i) => (
        <Fragment key={i}>
          {many && (
            <p className="lim-h">
              <b>{x.name}</b>
              {plan(x)}
            </p>
          )}
          {x.blocked && (
            <p className="lim-out">
              <Icon name="clock" />
              Out of usage until a limit resets
            </p>
          )}
          {!!x.windows?.length && (
            <ul className="lims">
              {x.windows.map((w, j) => (
                <LimitRow key={j} w={w} />
              ))}
            </ul>
          )}
          {!!x.credits && (
            <p className="lim-x">
              <CreditsText c={x.credits as Credits} />
            </p>
          )}
          {x.error && <p className="muted lim-err">{x.error}</p>}
        </Fragment>
      ))}
      {L.error && <p className="muted lim-err">{L.error}</p>}
      {(shared || when) && (
        <p className="muted lim-foot">
          {shared}
          {when}
        </p>
      )}
    </section>
  );
}
