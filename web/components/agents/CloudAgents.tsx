import { Fragment, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { RUNTIMES, type RuntimeId, type SetupField, type SetupForm } from "../../../plugin/shared/runtimes.ts";
import { isCloudRuntime } from "../../lib/agent-groups.ts";
import { getJSON, post } from "../../lib/api.ts";
import { useLoad } from "../../lib/hooks.ts";
import { agentHref, setupHref } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { RemoteAgentSetup, RuntimeRow, Runtimes } from "../../lib/types.ts";
import { Avatar } from "../Avatar.tsx";
import { Field } from "../people/Settings.tsx";

const providers = Object.values(RUNTIMES).filter((r) => isCloudRuntime(r.id) && r.setup);
type Inventory = Runtimes & { offline?: boolean };
type Connections = Partial<Record<RuntimeId, RemoteAgentSetup>> & { offline?: boolean };
type KeyHost = { name: string; online: boolean; row?: RuntimeRow };

// Prefer an existing connection, including a saved key on an offline machine.
function hostPriority({ online, row }: KeyHost) {
  if (!row) return 7;
  if (row.status === "Off") return 6;
  const rank = row.ok ? 0 : row.status === "Can't reach it" ? 2 : 4;
  return rank + (online ? 0 : 1);
}

export function CloudAgents({ username, openKind, machine, addOnly = false }: { addOnly?: boolean; username: string; openKind?: string | null; machine?: string | null }) {
  const data = useApp((s) => s.data);
  const mine = (data?.machines || []).filter((m) => m.mine).sort((a, b) => Number(b.name === data.machine) - Number(a.name === data.machine));
  const [open, setOpen] = useState(openKind);
  const [revision, refresh] = useState(0);
  const [reports, setReports] = useState<Record<string, Inventory | null>>({});
  // Feed updates replace the machine objects even when the set of credential hosts hasn't changed.
  const topology = JSON.stringify(mine.map((m) => [m.name, !!m.online]).sort());
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all(mine.map(async ({ name }) => {
      const report = await getJSON<Inventory>(`/api/runtimes?machine=${encodeURIComponent(name)}`, { signal: controller.signal }).catch(() => null);
      return [name, report] as const;
    })).then((entries) => {
      if (!controller.signal.aborted) setReports(Object.fromEntries(entries));
    });
    return () => controller.abort();
  }, [topology, revision]);
  const loading = !data || mine.some((m) => !Object.hasOwn(reports, m.name));

  return (
    <div className="setup" id="set-cloud-agents">
      {data && !mine.length && <p className="muted"><a href={setupHref(username, "machine")}>Connect a machine</a> to store your cloud API keys.</p>}
      <div className="setup-rows">
        {providers.map(({ id, name, setup }) => {
          const hosts = mine.map((m) => ({
            name: m.name, online: !!m.online && !reports[m.name]?.offline,
            row: reports[m.name]?.runtimes?.find((r) => r.kind === id),
          })).filter(h => !addOnly || !h.row?.ok && h.row?.status !== "Can’t reach it" && h.row?.status !== "Can't reach it").sort((a, b) => hostPriority(a) - hostPriority(b));
          if (addOnly && !loading && !hosts.length) return null;
          const best = hosts[0];
          const row = best?.row;
          const profile = row?.ok && data.agents?.find((a) => a.mine !== false && a.kind === id && a.machine === best.name);
          const expanded = !!best && open === id;
          const toggle = () => setOpen(expanded ? null : id);
          const unconnected = row?.status === "Not connected";
          const action = unconnected ? "Connect" : row?.ok || row?.status === "Can't reach it" ? "Manage" : "Details";
          const status = loading ? "Loading…" : unconnected ? "" : row?.status || (best ? "Unavailable" : "");
          return <div key={id}><div className={`setup-row${expanded ? " is-open" : ""}`}>
            <div className="setup-line" data-setup-open={best ? id : undefined} onClick={best ? (e) => !(e.target as HTMLElement).closest("a") && toggle() : undefined}>
              <Avatar agent={profile?.id || id} size="av--sm" />
              <span className="setup-name">
                <span className="setup-t">
                  <b>{profile ? <a href={agentHref(profile.id)}>{name}</a> : name}</b>
                  {status && <span className={`chip${row?.ok ? " chip--done" : ""}`}>{status}</span>}
                </span>
                <small>{setup.where}</small>
              </span>
              {best && <button type="button" className={`btn btn--sm ${row?.ok || expanded ? "btn--line" : "btn--dark"}`} aria-expanded={expanded}>
                {expanded ? "Close" : action}
              </button>}
            </div>
            {expanded && <div className="setup-body">
              <CloudConnection id={id} form={setup} hosts={hosts} loading={loading} initial={openKind === id ? machine : null} done={() => refresh((v) => v + 1)} />
            </div>}
          </div></div>;
        })}
      </div>
    </div>
  );
}

function CloudConnection({ id, form, hosts, initial, loading, done }: { id: RuntimeId; form: SetupForm; hosts: KeyHost[]; initial?: string | null; loading: boolean; done: () => void }) {
  // Keep the target of a draft key stable if a machine comes online or its status changes.
  const [picked, setPicked] = useState(initial);
  const host = hosts.find((h) => h.name === picked);
  const best = hosts[0].name;
  useEffect(() => {
    if (!picked && !loading) setPicked(best);
  }, [picked, best, loading]);
  if (picked && !host && !loading) return <p className="muted">
    {picked} is unavailable. <button type="button" className="btn btn--sm" onClick={() => setPicked(best)}>Use {best}</button>
  </p>;
  if (!host || (loading && !host.row)) return <p className="muted">Loading connections…</p>;
  return <>
    {hosts.length > 1 && <label className="field">
      <span>Machine that stores the API key</span>
      <select value={host.name} onChange={(e) => setPicked(e.target.value)}>
        {hosts.map((h) => <option key={h.name} value={h.name}>{h.name}{h.row?.ok ? " · connected" : ""}{h.online ? "" : " · offline"}</option>)}
      </select>
    </label>}
    <ConnectionDetails key={host.name} id={id} form={form} host={host} done={done} />
  </>;
}

function ConnectionDetails({ id, form, host, done }: { id: RuntimeId; form: SetupForm; host: KeyHost; done: () => void }) {
  const available = host.row && host.row.status !== "Off";
  const details = useLoad<Connections>(available ? `/api/remote-agents?machine=${encodeURIComponent(host.name)}` : null, host.online);
  const saved = details.data?.[id];
  if (!host.online || details.data?.offline) return <>
    {saved?.connected && <p className="muted small">{formWords(form, saved)}.</p>}
    <p className="muted">{host.name} is offline. Reconnect it to manage the API key.</p>
  </>;
  if (host.row?.status === "Off") return <p className="muted">{host.row.detail}</p>;
  if (details.error) return <p className="auth-err">{details.error} <button className="btn btn--line btn--sm" type="button" onClick={details.reload}>Retry</button></p>;
  if (host.row && !details.data) return <p className="muted">Loading connection…</p>;
  if (!saved) return <p className="muted">Connection setup is unavailable on {host.name}. <button className="btn btn--line btn--sm" type="button" onClick={() => { void details.reload(); done(); }}>Retry</button></p>;
  return <>
    {host.row.status === "Can't reach it" && <p className="auth-err">{host.row.detail}</p>}
    {saved.connected && <p className="muted small">{formWords(form, saved)}.</p>}
    <RemoteForm key={saved.connected ? "connected" : "new"} id={id} form={form} machine={host.name} setup={saved} done={() => { void details.reload(); done(); }} />
  </>;
}

// A field's value as its connection has it: what isn't secret, as it is now (`now`), and whether a secret is saved.
const nowOf = (f: SetupField | undefined, c: RemoteAgentSetup) => (f?.now ? (c as Record<string, unknown>)[f.now] : null);
const savedOf = (f: SetupField | undefined, c: RemoteAgentSetup) => !!(f?.saved && (c as Record<string, unknown>)[f.saved]);
// What its row says under its name: where it runs, then, once it's connected, what its form's `row` says of each of
// its fields ("In Anthropic's cloud, up to $12.5 a thread, public repos only").
function formWords(form: SetupForm, c: RemoteAgentSetup | undefined) {
  if (!c?.connected) return form.where;
  const said = (form.row || []).map((r) => {
    const f = form.fields.find((x) => x.key === r.key);
    const v = f?.secret ? savedOf(f, c) : nowOf(f, c);
    return v ? r.set.replace("{v}", String(v)) : r.unset || "";
  });
  return [form.where, ...said.filter(Boolean)].join(", ");
}

// A cloud agent's row, open: agents that run on their vendor's computers, not this machine's. This machine holds the
// key and reads what they do, so a thread stops updating while it's asleep. The key goes to the machine and stays
// there, so it never comes back here: connected, a box left empty keeps what's saved, and a new key replaces it.
// Its boxes are its runtime's setup form's (shared/runtimes.ts), the same for any runtime that has one.
function RemoteForm({ id, form, machine, setup, done }: { id: RuntimeId; form: SetupForm; machine: string; setup: RemoteAgentSetup | undefined; done: () => void }) {
  const c = setup || {};
  const on = !!c.connected;
  const m = machine || "This machine";
  const [busy, setBusy] = useState(false);
  // It forgets a key that may be hard to get again, so it asks first, on the button.
  const [sure, setSure] = useState(false);
  const at = `/api/remote-agents?machine=${encodeURIComponent(machine)}`;
  const fields = form.fields.map((f) => {
    const v = nowOf(f, c);
    // A value it has now, as it reads ("$12.5 now", "4 now"), which leaving its box empty keeps; one with no way to
    // read it (an organization id) shows as it is, in its box.
    const now = f.nowAs && v ? `${f.nowAs === "dollars" ? "$" : ""}${v} now` : "";
    const note = now ? "leave empty to keep" : f.note;
    const label = note ? (
      <>
        {f.label} <small>{note}</small>
      </>
    ) : (
      f.label
    );
    const hint = f.secret ? (savedOf(f, c) ? "Saved. Paste to replace it" : f.placeholder) : now || (!f.nowAs && v ? String(v) : f.placeholder) || undefined;
    // A box for words (a key, an id) isn't filled in or spell-checked; one for a number brings up the number keys.
    const words = !f.input || f.input === "text";
    return <Field key={f.key} name={f.key} label={label} type={f.secret ? "password" : "text"} {...(words ? { autoComplete: "off", spellCheck: false } : { inputMode: f.input })} placeholder={hint} required={!!f.required && !on} />;
  });
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const element = e.currentTarget;
    const fields = Object.fromEntries([...new FormData(element)].filter(([, v]) => String(v).trim()));
    setBusy(true);
    const r = await post(at, { vendor: id, ...fields }).catch(() => toast("Couldn't reach agentbook."));
    setBusy(false);
    if (!r || !r.ok) return;
    element.reset();
    setSure(false);
    toast(on ? "Saved." : `${RUNTIMES[id].name} connected.`);
    done();
  };
  const forget = async () => {
    if (!sure) return setSure(true);
    setBusy(true);
    const r = await post(at, { vendor: id, disconnect: true }).catch(() => toast("Couldn't reach agentbook."));
    setBusy(false);
    if (!r || !r.ok) return;
    setSure(false);
    toast(`${RUNTIMES[id].name} disconnected. Its threads stay here.`);
    done();
  };
  return (
    <>
      <form className="stack" onSubmit={submit}>
        {fields}
        <div className="row-acts">
          <button className="btn btn--dark" type="submit" disabled={busy}>
            {on ? "Save" : "Connect"}
          </button>
          {on && (
            <button className="btn btn--line" type="button" disabled={busy} onClick={forget}>
              {sure ? `Forget its key on ${machine}?` : "Disconnect"}
            </button>
          )}
        </div>
      </form>
      <p className="muted small">
        <AboutText text={form.about} machine={m} />
      </p>
    </>
  );
}
// What a setup form says under it: "{machine}" is the machine's name, and [text](url) a link, opened beside the page.
function AboutText({ text, machine }: { text: string; machine: string }) {
  const parts = text.replace(/\{machine\}/g, machine).split(/(\[[^\]]+\]\([^)\s]+\))/);
  return (
    <>
      {parts.map((p, i) => {
        const link = p.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
        return link ? (
          <a key={i} href={link[2]} target="_blank" rel="noopener">
            {link[1]}
          </a>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        );
      })}
    </>
  );
}
