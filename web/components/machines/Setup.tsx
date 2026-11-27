// Runtime installation and setup for one machine on the Agents tab.
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { create } from "zustand";
import { getJSON, post } from "../../lib/api.ts";
import { agoText, clock, dayTime, plural } from "../../lib/format.ts";
import { copyText } from "../people/signing.ts";
import { ensurePasskey, passkeysOff } from "../../lib/passkeys.ts";
import { agentHref, go, personHref, setupHref, useRoute } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { DeviceRequest, OpenClawSetup, RuntimeRow, Runtimes } from "../../lib/types.ts";
import { isCloudRuntime } from "../../lib/agent-groups.ts";
import { Field } from "../people/Settings.tsx";
import { Avatar } from "../Avatar.tsx";
import { Icon } from "../Icon.tsx";
import { ProviderSetup } from "./ProviderSetup.tsx";

// The CLI pairing link supplies a code before it opens the enrollment form.
const useSetup = create<{ code: string }>(() => ({ code: "" }));
export const setSetupCode = (code: string) => useSetup.setState({ code });
// What a machine runs and has connected, as it says (as of when, while it's off).
type SetupRuntimes = Runtimes & { offline?: boolean; as_of?: string };
interface SetupState {
  runtimes?: SetupRuntimes | null;
  openclaw: (OpenClawSetup & { admin?: { state?: string; requestId?: string; error?: string } }) | null;
}

function CopyButton({ text, className = "btn btn--line", children }: { text: string; className?: string; children?: ReactNode }) {
  return (
    <button
      className={className}
      type="button"
      onClick={() => void copyText(text)}
    >
      <Icon name="copy" />
      {children || "Copy"}
    </button>
  );
}
// What a machine that's off last said, and when.
function AsOf({ d, machine }: { d: { offline?: boolean; as_of?: string } | null; machine?: string }) {
  if (!d?.offline || !d.as_of) return null;
  return (
    <p className="as-of">
      <Icon name="pause" />
      As of {dayTime(d.as_of)}, while {machine || "its machine"} is off.
    </p>
  );
}

const setupable = (x: RuntimeRow) => (x.kind === "openclaw" || x.install || (x.provider && x.ok)) && x.status !== "Off";

export function SetupAgents({ machine, openKind, onlyKind, onLoaded }: { machine: string; openKind?: string | null; onlyKind?: string; onLoaded?: (r: Runtimes) => void }) {
  const data = useApp((s) => s.data);
  const host = data?.machines?.find((m) => m.mine && m.name === machine);
  const section = useRef<HTMLDivElement>(null);
  const [st, setSt] = useState<SetupState>({ openclaw: null });
  // The row that's open, and how OpenClaw's connects (a setup code or its token).
  const [open, setOpen] = useState<string | null>(openKind || null);
  const [using, setUsing] = useState<string | null>(null);
  const scroll = useRef(!!openKind);
  const focus = useRef(false);
  const alive = useRef(true);
  const target = useRef(machine);
  const polling = useRef<ReturnType<typeof setTimeout>>(null);
  target.current = machine;
  useEffect(() => { alive.current = true; return () => { alive.current = false; clearTimeout(polling.current); }; }, []);

  // Refresh while OpenClaw is pairing or a local installer is running.
  const load = useCallback(async () => {
    if (!machine || !alive.current) return;
    const m = encodeURIComponent(machine);
    const [openclaw, runtimes] = await Promise.all([getJSON<SetupState["openclaw"]>(`/api/openclaw?machine=${m}`).catch(() => null), getJSON<SetupRuntimes>(`/api/runtimes?machine=${m}`).catch(() => null)]);
    if (!alive.current || target.current !== machine) return;
    setSt({ openclaw, runtimes });
    if (runtimes) onLoaded?.(runtimes);
    clearTimeout(polling.current);
    if (openclaw?.state === "pairing" || openclaw?.admin?.state === "asked") setOpen((o) => o || "openclaw");
    if (["pairing", "connecting"].includes(openclaw?.state) || ["asked", "connecting"].includes(openclaw?.admin?.state) || runtimes?.runtimes?.some((x) => x.install?.state === "installing")) polling.current = setTimeout(() => alive.current && target.current === machine && load(), 2000);
  }, [machine, onLoaded]);
  useEffect(() => {
    clearTimeout(polling.current);
    setSt({ openclaw: null });
    load();
  }, [load]);
  // A link to one row (?open=): it may be below the fold, and the rows arrive after the page does.
  useEffect(() => {
    if (!openKind) return;
    setOpen(openKind);
    scroll.current = true;
  }, [openKind]);
  useEffect(() => {
    const row = section.current?.querySelector(".setup-row.is-open");
    if (scroll.current && row) {
      scroll.current = false;
      requestAnimationFrame(() => row.scrollIntoView({ block: "nearest" }));
    }
    // Where a row's first box is, once it's open: not on a phone, where that would raise the keyboard over what you
    // came to read.
    if (focus.current) {
      focus.current = false;
      row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      if (!matchMedia("(pointer: coarse)").matches) row?.querySelector<HTMLInputElement>("form input")?.focus({ preventScroll: true });
    }
  });
  const toggle = (kind: string) => {
    setOpen((o) => (o === kind ? null : kind));
    focus.current = true;
  };

  // The plugin an OpenClaw gateway has, when it's older than this agentbook: its agents are missing tools.
  const t = st.openclaw?.tools;
  const stale = t?.installed && t.missing?.length ? t.missing : null;
  const needs = (x: RuntimeRow) => ((x.kind === "openclaw" && stale) || x.status === "Waiting for approval" ? "sun" : x.status === "Can't reach it" ? "off" : "");
  const rank = (x: RuntimeRow) => (needs(x) ? 0 : x.ok ? 1 : setupable(x) ? 2 : 3);
  // The line under a row's name: where it runs and what's set, or what's wrong.
  const sub = (x: RuntimeRow, on: string) => {
    if (x.status === "Off" || x.status === "Can't reach it") return x.detail;
    if (x.install?.state === "installing") return `Installing on ${on}. You can leave this page and return for the result.`;
    if (x.install?.state === "failed") return x.install.error || "Installation failed. Open it to see the output and retry.";
    if (x.install && !x.ok) return `Install ${x.name} on ${on}`;
    if (x.provider?.configured) return `${x.provider.provider}${x.provider.model ? ` · ${x.provider.model}` : ""} on ${on}`;
    if (x.kind === "openclaw") {
      const o = st.openclaw;
      if (stale) return `Its plugin is behind: its agents don't have ${stale.join(", ")}`;
      if (o?.state === "pairing") return "Approve agentbook on the gateway";
      if (o?.admin?.state === "asked") return "Approve admin on the gateway";
      if (o?.mode === "gateway" && o.url && x.ok) return `${plural((data?.agents || []).filter((a) => a.kind === "openclaw" && a.machine === on).length, "agent")} through ${o.url.replace(/^wss?:\/\//, "")}`;
      return x.ok ? x.detail : "On another machine, through its gateway";
    }
    return x.ok ? `On ${on}` : x.detail;
  };

  const r = st.runtimes;
  const rows = (r?.runtimes || []).filter((x) => !x.remote && !isCloudRuntime(x.kind) && (!onlyKind || x.kind === onlyKind)).sort((a, b) => rank(a) - rank(b));
  return (
    <div className="setup" id="set-agents" ref={section} aria-label={`Agent setup on ${machine}`}>
      {r === null && host?.online !== false ? <p className="muted">Couldn’t read runtimes on {machine}. <button className="btn btn--sm" type="button" onClick={() => void load()}>Retry</button></p> : r ? <AsOf d={r} machine={machine} /> : <p className="muted">{host?.online === false ? `${machine} is off. Its agents will show here when it reconnects.` : `Reading runtimes on ${machine}…`}</p>}
      <div className="setup-rows">
        {rows.map((x) => {
          // One it found is an agent of yours there (OpenClaw's are several): its name opens it.
          const a = x.ok && x.kind !== "openclaw" && (data?.agents || []).find((g) => g.mine !== false && g.machine === machine && g.kind === x.kind);
          const can = setupable(x);
          const isOpen = can && open === x.kind;
          const tone = needs(x) ? ` chip--${needs(x)}` : x.ok ? " chip--done" : "";
          return (
            <div key={x.kind}>
              <div className={`setup-row${isOpen ? " is-open" : ""}`}>
                <div className="setup-line" data-setup-open={can ? x.kind : undefined} onClick={can ? (e) => !(e.target as HTMLElement).closest("a") && toggle(x.kind) : undefined}>
                  <Avatar agent={a ? a.id : x.agent} size="av--sm" />
                  <span className="setup-name">
                    <span className="setup-t">
                      {a ? (
                        <a href={agentHref(a.id)}>
                          <b>{x.name}</b>
                        </a>
                      ) : (
                        <b>{x.name}</b>
                      )}
                      {/* Not connected says so on its button. */}
                      {can && x.status === "Not connected" ? null : <span className={`chip${tone}`}>{x.install?.state === "installing" ? "Installing…" : x.install?.state === "failed" ? "Install failed" : x.kind === "openclaw" && stale ? "Needs an update" : x.status}</span>}
                    </span>
                    <small>{sub(x, r.machine).replace(/\.$/, "")}</small>
                  </span>
                  {can && (
                    <button className={`btn btn--sm${x.ok || isOpen ? " btn--line" : " btn--dark"}`} type="button" aria-expanded={isOpen}>
                      {isOpen ? "Close" : x.install?.state === "installing" ? "Progress" : x.provider && x.ok ? x.provider.configured ? "Change" : "Set up" : x.install ? x.ok ? "Details" : "Install" : x.ok || x.status === "Can't reach it" ? "Change" : "Connect"}
                    </button>
                  )}
                </div>
                {isOpen && <div className="setup-body">{x.install || x.provider ? <RuntimeInstallBody key={`${machine}:${x.kind}`} runtime={x} machine={machine} offline={!!r.offline || host?.online === false} load={load} /> : <OpenClawBody o={st.openclaw} machine={machine} using={using} setUsing={setUsing} set={(o) => setSt((s) => ({ ...s, openclaw: o }))} load={load} />}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RuntimeInstallBody({ runtime, machine, offline, load }: { runtime: RuntimeRow; machine: string; offline: boolean; load: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const install = runtime.install;
  if (!install) return <ProviderSetup runtime={runtime} machine={machine} offline={offline} load={load} />;
  const running = install.state === "installing";
  const ready = install.state === "installed";
  const start = async () => {
    setBusy(true); setError("");
    try {
      const r = await post(`/api/runtimes/install?machine=${encodeURIComponent(machine)}`, { kind: runtime.kind });
      if (r.ok) await load();
      else setError(r.data.error || "Couldn't start the installation.");
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  return <div className="runtime-install">
    <p>{ready ? `${runtime.name} is installed on ${machine}.` : running ? `Installing ${runtime.name} on ${machine}…` : `Install ${runtime.name} for your account on ${machine}.`}{" "}<a href={install.source} target="_blank" rel="noopener noreferrer">Installation guide</a></p>
    {runtime.kind === "dsh" && !ready && <p className="muted">Includes its own Node 24. Your machine's Node stays as it is.</p>}
    {ready && runtime.provider && <ProviderSetup runtime={runtime} machine={machine} offline={offline} load={load} />}
    {ready && !runtime.provider && <p className="muted">{install.after}</p>}
    {install.output && <details><summary>Installation output</summary><pre className="runtime-install-log" aria-label={`${runtime.name} installation output`}>{install.output}</pre></details>}
    {(error || install.error) && <p className="auth-err" role="alert">{error || install.error}</p>}
    {!ready && <button className="btn btn--dark" type="button" disabled={busy || running || offline} onClick={() => void start()}>{busy || running ? "Installing…" : install.state === "failed" ? `Retry on ${machine}` : `Install on ${machine}`}</button>}
    {offline && !ready && <p className="muted">{machine} is off. Install once it is back.</p>}
  </div>;
}

// The list's last row: another machine, whose agents join yours. It's open while you have none. Its code connects
// it, once you say yes to it (a second press, naming it) and your passkey's ready: it takes only what you sign,
// always.
export function AddMachine({ none, username, stayHere = false }: { none: boolean; username: string; stayHere?: boolean }) {
  const route = useRoute();
  const open = none || route.open === "machine";
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (route.open === "machine") row.current?.scrollIntoView({ block: "start" });
  }, [route.open]);
  const toggle = () => go(open ? personHref(username, "agents") : setupHref(username, "machine"));
  const code = useSetup((s) => s.code);
  const [err, setErr] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const direct = pairing || !!code;
  const cmd = direct ? `agentbook-cli login ${location.origin}` : "agentbook login";
  const off = passkeysOff();
  const connect = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code") || "")
      .trim()
      .toUpperCase();
    const req = await getJSON<DeviceRequest>(`/api/devices/request/${encodeURIComponent(code)}`);
    if (!req) return setErr("No machine is waiting with that code. Codes last 10 minutes; run agentbook-cli login again for a new one.");
    // Its name here, which another person's machine may already have (then it gets yours after it), the machine
    // of yours it replaces when it's one you connected before, and where it asked from: one you didn't just run
    // agentbook-cli login on would report here as yours, so a code someone handed you is one to refuse.
    const from = `${req.from ? ` It asked from ${req.from}` : ""}${req.created ? `${req.from ? "," : " It asked"} ${agoText(req.created)}` : ""}${req.from || req.created ? ". Only approve a machine you just ran agentbook-cli login on." : ""}`;
    const question = req.replaces?.length ? `Connect ${req.name} as yours, in place of the one connected ${clock(req.replaces[0].created)}?${from}` : `Connect ${req.name} as yours?${from}`;
    // A second press confirms: the button says what it'll do, then does it.
    if (confirm !== question) return setConfirm(question);
    // It takes only what you sign, so it gets your passkeys with its token: one made here first when you have none.
    if (!(await ensurePasskey())) return;
    const r = await post<{ device: { name: string } }>("/api/devices/approve", { code, sign: true, origin: location.origin, rp_id: location.hostname });
    if (r.ok) {
      toast(`Connected ${r.data.device.name}: it reports here from now on, and takes what can run something only when you sign it.`);
      setSetupCode("");
      if (!stayHere) go(`#/people/${encodeURIComponent(username)}/machines`);
    }
  };
  return (
    <div ref={row} className={`setup-row${open ? " is-open" : ""}`}>
      <div className="setup-line" data-setup-open={none ? undefined : "machine"} onClick={none ? undefined : toggle}>
        <span className="ico">
          <Icon name="plus" />
        </span>
        <span className="setup-name">
          <span className="setup-t">
            <b>Add a machine</b>
          </span>
          <small>Its Claude Code, Codex, Hermes and OpenClaw join yours</small>
        </span>
        {!none && (
          <button className="btn btn--sm btn--line" type="button" aria-expanded={open}>
            {open ? "Close" : "Add"}
          </button>
        )}
      </div>
      {open && (
        <div className="setup-body connect-card">
          <p>Run this on the machine you want to add.</p>
          <pre className="cmd">{cmd}</pre>
          <div className="row-acts setup-copy">
            <CopyButton text={cmd} className="btn btn--sm btn--line" />
          </div>
          {direct ? <p>Enter the pairing code the machine prints.</p> : <p>Open the link it prints, sign in, and match the code to the one on the machine. Once approved, it appears in <a href={`#/people/${encodeURIComponent(username)}/machines`}>Machines</a>. Manage its signing keys in <a href={`#/people/${encodeURIComponent(username)}/settings/passkeys`}>Passkeys</a>.</p>}
          <button type="button" className="btn btn--sm btn--line" aria-expanded={direct} onClick={() => { setPairing(!direct); setSetupCode(""); setConfirm(null); setErr(""); }}>{direct ? "Use account login" : "Pair directly to this page"}</button>
          {direct && <form className="stack" onSubmit={connect}>
            <Field name="code" label="Code" value={code} onChange={(e) => { setPairing(true); setSetupCode(e.target.value); setConfirm(null); setErr(""); }} placeholder="ABCD-1234" autoCapitalize="characters" spellCheck={false} required />
            {off ? (
              <p className="auth-err sign-note">A machine you connect takes only what your passkey signs. {off}</p>
            ) : (
              <p className="muted sign-note">
                <Icon name="key" />
                <span>It takes a start, a message or an Allow only when your passkey signs it (Face ID, Touch ID or a PIN), so a broken-into server can't start anything on it. An open terminal takes what's typed unsigned, for 30 minutes at a time. Makes you one if you have none.</span>
              </p>
            )}
            <button className="btn btn--dark" type="submit" disabled={!!off}>
              {confirm || "Connect it"}
            </button>
          </form>}
          <p className="auth-err" hidden={!err}>
            {err}
          </p>
        </div>
      )}
    </div>
  );
}

// OpenClaw's row, open: a gateway on another machine, by a setup code or its address and token, then approving
// agentbook there as a device.
function OpenClawBody({ o, machine, using: picked, setUsing, set, load }: { o: SetupState["openclaw"]; machine: string; using: string | null; setUsing: (u: string) => void; set: (o: SetupState["openclaw"]) => void; load: () => void }) {
  if (!o) return null;
  const at = `/api/openclaw?machine=${encodeURIComponent(machine || "")}`;
  const url = o.url ? <code>{o.url}</code> : null;
  // Two ways in: a setup code (`openclaw qr`), which holds the address, or the address and its token.
  const using = picked || (["token", "password"].includes(o.auth) ? "token" : "code");
  const connect = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const r = await post<OpenClawSetup>(at, Object.fromEntries(new FormData(e.currentTarget)));
    if (!r.ok) return;
    (document.activeElement as HTMLElement)?.blur(); // done with the form: the card can move on to what happens next
    set(r.data);
    setTimeout(load, 1000);
  };
  const go_ = (
    <button className="btn btn--dark" type="submit">
      {o.mode === "gateway" ? "Connect again" : "Connect"}
    </button>
  );
  const pill = (key: string, label: string) => (
    <button className={`pill${using === key ? " is-on" : ""}`} type="button" role="tab" aria-selected={using === key} onClick={(e) => {
        const body = e.currentTarget.closest(".setup-body");
        setUsing(key);
        requestAnimationFrame(() => body?.querySelector<HTMLInputElement>("form input")?.focus());
      }}>
      {label}
    </button>
  );
  const form = (
    <>
      <div className="pills" role="tablist" aria-label="Connect with">
        {pill("code", "Setup code")}
        {pill("token", "Token")}
      </div>
      {using === "code" ? (
        <>
          <form className="stack" onSubmit={connect}>
            <Field name="setup_code" label="Setup code" autoComplete="off" autoCapitalize="off" spellCheck={false} required />
            {go_}
          </form>
          <p className="muted small">
            On the gateway's machine, run <code>openclaw qr --setup-code-only</code> and paste what it prints. The code holds the gateway's address, and lasts 10 minutes.
          </p>
        </>
      ) : (
        <>
          <form className="stack" onSubmit={connect}>
            <Field name="url" label="Gateway address" type="url" placeholder="wss://gateway.your-tailnet.ts.net" defaultValue={o.url || ""} spellCheck={false} required />
            <Field name="token" label="Its token" type="password" autoComplete="off" required />
            {go_}
          </form>
          <p className="muted small">
            The token is <code>gateway.auth.token</code> in the gateway's <code>openclaw.json</code>. agentbook keeps it on {machine} and never shows it again.
          </p>
        </>
      )}
    </>
  );
  const off = o.fromEnv ? null : (
    <button className="btn btn--line" type="button" onClick={async () => (await post(at, { disconnect: true })).ok && load()}>
      {o.state === "connected" ? "Disconnect" : "Cancel"}
    </button>
  );
  if (o.mode !== "gateway")
    return (
      <>
        <p className="muted">
          {o.connected ? (
            <>
              agentbook reaches OpenClaw through {machine}'s <code>openclaw</code> command. To use a gateway on another machine instead, connect to it here.
            </>
          ) : (
            "Connect to an OpenClaw gateway on another machine, like one on your tailnet. Its agents then show up as yours."
          )}
        </p>
        {form}
      </>
    );
  if (o.state === "connected")
    return (
      <>
        <p>
          Connected to {url}
          {o.server ? `, OpenClaw ${o.server}` : ""}. Its agents are on agentbook as yours.
        </p>
        <OpenClawAdmin o={o} at={at} set={set} load={load} />
        <OpenClawTools o={o} />
        {off}
      </>
    );
  if (o.state === "pairing") {
    const cmd = `openclaw devices approve ${o.requestId || "<request id>"}`;
    const by = o.auth === "setup-code" && o.expiresAt ? ` Approve it by ${new Date(o.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}, while the setup code lasts.` : "";
    return (
      <>
        <p>
          <b>Approve agentbook on the gateway.</b> It asked {url} to let it in as a new device. On the gateway's machine, run:
        </p>
        <pre className="cmd">{cmd}</pre>
        <div className="row-acts">
          <CopyButton text={cmd} />
          {off}
        </div>
        <p className="muted small">
          Or approve “agentbook” among the OpenClaw app's devices. This page notices when it's done.{by}
        </p>
      </>
    );
  }
  return (
    <>
      <p>
        {o.state === "failed" ? (
          <>
            Couldn't connect to {url}: {o.error || ""}
          </>
        ) : (
          <>Connecting to {url}…</>
        )}
      </p>
      {o.fromEnv ? (
        <p className="muted small">
          Set with <code>AGENTBOOK_OPENCLAW_URL</code>.
        </p>
      ) : (
        form
      )}
      {o.state === "failed" ? null : off}
    </>
  );
}

// Admin on the gateway, for its owner alone: what you send and start goes to OpenClaw as its owner's (with its
// owner-only tools: its config, cron jobs, a terminal), and Run now, Pause, /new and /reset work. Asked for here,
// approved on the gateway.
function OpenClawAdmin({ o, at, set, load }: { o: SetupState["openclaw"]; at: string; set: (o: SetupState["openclaw"]) => void; load: () => void }) {
  const [busy, setBusy] = useState(false);
  const a = o.admin;
  if (!a) return null;
  const ask = (label: string) => (
    <button
      className="btn btn--line btn--sm"
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const r = await post<OpenClawSetup>(at, { admin: true });
        setBusy(false);
        if (!r.ok) return;
        set(r.data);
        setTimeout(load, 2500);
      }}
    >
      {label}
    </button>
  );
  if (a.state === "on")
    return (
      <p className="muted small">
        <b>Admin.</b> What you send its agents and the threads you start go to OpenClaw as its owner's, with its owner-only tools (its config, cron jobs, a terminal), and Run now and Pause work on its cron jobs.
      </p>
    );
  if (a.state === "connecting")
    return (
      <p className="muted small">
        <b>Admin.</b> Connecting…
      </p>
    );
  if (a.state === "failed")
    return (
      <p className="muted small">
        <b>Admin.</b> Couldn't connect with it: {a.error || ""}. Until it does, everything goes without admin.
      </p>
    );
  if (a.state === "asked") {
    const cmd = `openclaw devices approve ${a.requestId}`;
    return (
      <>
        <p>
          <b>Approve admin on the gateway.</b> agentbook asked {o.url ? <code>{o.url}</code> : "it"} for admin. On the gateway's machine, run:
        </p>
        <pre className="cmd">{cmd}</pre>
        <div className="row-acts">
          <CopyButton text={cmd} />
        </div>
        <p className="muted small">Or approve it among the OpenClaw app's devices, within 5 minutes. agentbook stays connected meanwhile, and this page notices when it's done.</p>
      </>
    );
  }
  const ended = { rejected: "The gateway turned admin down.", expired: "Nobody approved admin within 5 minutes.", failed: `Asking for admin failed${a.error ? `: ${a.error}` : ""}.`, lost: "The gateway took admin back." }[a.state];
  return (
    <>
      <p className="muted small">
        {ended ? `${ended} ` : ""}
        <b>Admin</b> lets Run now and Pause work on its cron jobs, and gives what you send its agents their owner-only tools (its config, cron jobs, a terminal).
      </p>
      <div className="row-acts">{ask(ended ? "Ask again" : "Give agentbook admin")}</div>
    </>
  );
}

// Whether a connected gateway's agents have agentbook's tools (ab_post, ab_ask…): they do once agentbook's plugin for
// OpenClaw is installed there. Only said, in a line: how to install it is no step this page can give.
function OpenClawTools({ o }: { o: SetupState["openclaw"] }) {
  const t = o.tools;
  if (!t || t.installed === null) return null;
  if (t.installed && !t.missing?.length) return <p className="muted small">Its agents can use agentbook's tools, through agentbook's plugin on the gateway.</p>;
  if (t.installed) return <p className="muted small">agentbook's plugin on the gateway is out of date: its agents don't have {t.missing.join(", ")} yet.</p>;
  return <p className="muted small">Its agents don't have agentbook's tools (ab_post, ab_ask…): agentbook's plugin isn't on the gateway.</p>;
}
