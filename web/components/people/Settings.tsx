// Your settings, on your profile (#/people/<you>/settings): a menu on the left that jumps to each, and each in its own
// card: Threads (Auto-archive, Private terminals), Passkeys, Connectors, Updates (agentbook on your machines),
// Signing in (with Google), Signing out and Delete account. Agents are managed on the profile’s Agents tab.
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import type { ReactNode } from "react";
import { getJSON, post } from "../../lib/api.ts";
import { agoText } from "../../lib/format.ts";
import { go, personHref, useRoute } from "../../lib/route.ts";
import { makePasskey, passkeysOff, sessionEnd, untilText } from "../../lib/passkeys.ts";
import { signedOut } from "../../lib/session.ts";
import { getApp, setApp, useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { AuthInfo, Passkeys } from "../../lib/types.ts";

type Prefs = NonNullable<AuthInfo["prefs"]>;
type PrefKey = "auto_archive" | "private_terminals";
import { Icon } from "../Icon.tsx";
import type { IconName } from "../Icon.tsx";
import { day } from "../agents/words.ts";
import { copyText, useSessionKey } from "./signing.ts";

// Keep the selected card while navigating from a direct Passkeys link to the main Settings page.
const useSetNav = create<{ on: string | null; jump: string | null }>(() => ({ on: null, jump: null }));

// A field with its label (the old page's `field`).
export function Field({ name, label, type = "text", ref, ...rest }: { name: string; label: ReactNode; type?: string; ref?: React.Ref<HTMLInputElement> } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="field">
      <span>{label}</span>
      <input ref={ref} name={name} type={type} {...rest} />
    </label>
  );
}
// A button that asks once more before it does what it does: the first press says what it'll do ("Remove it?").
export function SureButton({ ask, className = "btn btn--sm", title, run, children }: { ask: string; className?: string; title?: string; run: () => unknown; children: ReactNode }) {
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={className}
      type="button"
      title={title}
      disabled={busy}
      onClick={async () => {
        if (!sure) return setSure(true);
        setBusy(true);
        await run();
        setBusy(false);
      }}
    >
      {sure ? ask : children}
    </button>
  );
}

// What agentbook does with your threads (prefs on the server): Auto-archive, and Private terminals. Both off until you
// turn them on.
const THREAD_PREFS: [PrefKey, string, string][] = [
  ["auto_archive", "Auto-archive", "When a thread's pull request merges, or everything on its branch lands on main, it's archived once its turn ends. The bell says which, with a link. Threads already done stay as they are."],
  ["private_terminals", "Private terminals", "Only threads started in agentbook show here. Anything started elsewhere stays on your machines, and nothing about it is sent here. That covers claude or codex in a terminal, your editor or the desktop app, and a chat with an OpenClaw or Hermes agent on Discord or Telegram."],
];
function PrefSwitch({ k, title, small }: { k: PrefKey; title: string; small: string }) {
  const on = useApp((s) => !!s.auth.prefs?.[k]);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<boolean | null>(null);
  const change = async (want: boolean) => {
    setShown(want);
    setBusy(true);
    const r = await post<{ prefs: Prefs }>("/api/me/prefs", { [k]: want });
    setBusy(false);
    setShown(null);
    if (!r.ok) return;
    setApp({ auth: { ...getApp().auth, prefs: r.data.prefs } });
    toast(`${title} is ${want ? "on" : "off"}.`);
  };
  return (
    <label className="switch">
      <input type="checkbox" role="switch" checked={shown ?? on} disabled={busy} onChange={(e) => change(e.target.checked)} />
      <span className="track" aria-hidden="true" />
      <span>
        <b>{title}</b>
        <small>{small}</small>
      </span>
    </label>
  );
}
function ThreadPrefsBox() {
  return (
    <section className="card box set set-prefs" id="set-threads">
      <h3>Threads</h3>
      {THREAD_PREFS.map(([k, title, small]) => (
        <PrefSwitch key={k} k={k} title={title} small={small} />
      ))}
    </section>
  );
}

// Your passkeys, and the machines that take what can run something only when one signs it.
function PasskeysBox({ keys: k, reload }: { keys: Passkeys | null; reload: () => unknown }) {
  const [held, endHeld] = useSessionKey();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  if (!k) return null;
  const off = passkeysOff();
  const machines = k.machines || [];
  const rows = k.passkeys || [];
  const update = async (action: () => Promise<string>) => {
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      setNotice(await action());
      await reload();
    } catch (err) {
      setNotice(err.message || "Could not reach the page. Refresh and try again.");
    } finally {
      setBusy(false);
    }
  };
  type Change = { removed?: boolean; sent?: string[]; pending?: { machine: string; reason: string }[] };
  const remove = (id: string) => update(async () => {
    const r = await post<Change>(`/api/passkeys/${encodeURIComponent(id)}/remove`, {});
    if (!r.ok) return r.data.error;
    if (r.data.removed) return "Passkey removed.";
    return (r.data.pending || []).map(p => `${p.machine}: ${p.reason}`).join(" ") + " Refresh after the machine reconnects.";
  });
  const approve = (id: string, m: typeof machines[number]) => update(async () => {
    if (!m.keys.length) {
      const r = await post(`/api/machines/${encodeURIComponent(m.name)}/signing`, { on: true, origin: location.origin, rp_id: location.hostname });
      return r.ok ? `Requested initial passkeys for ${m.name}. Check the reported status below.` : r.data.error;
    }
    const r = await post<Change>(`/api/passkeys/${encodeURIComponent(id)}/spread`, { machine: m.name });
    if (!r.ok) return r.data.error;
    return r.data.sent?.includes(m.name) ? `${m.name} confirmed approval.` : r.data.pending?.[0]?.reason || "Waiting for machine confirmation.";
  });
  // One Face ID for a while: this browser's key, while it holds (signCommand).
  const s = held;
  return (
    <section className="card box set" id="set-passkeys">
      <h3>Passkeys</h3>
      <p className="muted">Sign what your machines run (a start, a message, an Allow) with Face ID, Touch ID or a PIN, so a machine takes it only from you, whatever this server says.</p>
      {rows.length === 0 && <p>No passkeys registered on this page.</p>}
      {rows.map(key => (
        <div key={key.id} className="passkey-card">
          <div className="set-row">
            <div><b>{key.name || "Passkey"}</b><small><code>{key.fingerprint}</code> · Added {day(key.created)}</small></div>
            <button className="btn btn--sm" type="button" disabled={busy} onClick={() => setEditing(key.id)}>Rename</button>
            <SureButton ask="Remove this passkey?" run={() => remove(key.id)}>{key.removing ? "Retry removal" : "Remove"}</SureButton>
          </div>
          {editing === key.id && <form className="set-row" onSubmit={e => {
            e.preventDefault();
            const name = new FormData(e.currentTarget).get("name");
            void update(async () => {
              const r = await post(`/api/passkeys/${encodeURIComponent(key.id)}/rename`, { name });
              if (!r.ok) return r.data.error;
              setEditing(null);
              return "Passkey renamed.";
            });
          }}>
            <input autoFocus name="name" aria-label="Passkey name" maxLength={80} required defaultValue={key.name} />
            <button className="btn btn--sm" type="submit" disabled={busy}>Save name</button>
            <button className="btn btn--sm" type="button" onClick={() => setEditing(null)}>Cancel</button>
          </form>}
          {key.removing && <p role="status">Removal requested. Refresh after the machines reconnect. If a machine still trusts this key, retry removal.</p>}
          {machines.map(m => {
            const trusted = m.keys.includes(key.fingerprint);
            const recovery = m.source && /^[a-zA-Z0-9_-]+$/.test(m.source) && /^[a-zA-Z0-9_-]{12}$/.test(key.fingerprint)
              ? `agentbook keys recover ${m.source} ${key.fingerprint}` : null;
            return <div className="passkey-machine" key={m.name}>
              <div className="set-row">
                <div><b>{m.name}</b><small>{trusted ? (m.online ? "Trusted" : "Trusted at last report") : key.removing ? "Removed" : "Awaiting approval"}{!m.online && " · Offline"}</small></div>
                {!trusted && !key.removing && <button className="btn btn--sm" type="button" disabled={busy || !m.online || !!off} onClick={() => void approve(key.id, m)}>{m.keys.length ? "Approve" : "Set up signing"}</button>}
              </div>
              {!trusted && !key.removing && <>
                {m.keys.length > 0 && <p className="muted">Approve from a device with a passkey that {m.name} already trusts.</p>}
                {recovery && <details>
                  <summary>Recover access to {m.name}</summary>
                  <p>With access to a terminal on <b>{m.name}</b>, run this command as the user who runs agentbook. It approves this fingerprint for this page. Then refresh the machine status here.</p>
                  <pre className="cmd">{recovery}</pre>
                  <button className="btn btn--sm" type="button" onClick={() => void copyText(recovery)}>Copy recovery command</button>
                </details>}
              </>}
            </div>;
          })}
        </div>
      ))}
      {rows.length > 0 && !machines.length && <p className="muted">No machines have reported remote signing on this page yet.</p>}
      {notice && <p role="status">{notice}</p>}
      {machines.length > 0 && <button className="btn btn--sm" type="button" disabled={busy} onClick={() => void update(async () => "")}>Refresh machine status</button>}
      {machines.length > 0 && !off && (
        <div className="set-row">
          <p>
            {s ? (
              <>
                This browser signs for you until <b>{untilText(s.envelope.expires)}</b>, from one Face ID or Touch ID.
              </>
            ) : (
              "One Face ID or Touch ID signs for 12 hours in this browser, then it asks again."
            )}
          </p>
          {s && (
            <button
              className="btn btn--sm"
              type="button"
              onClick={async () => {
                await sessionEnd();
                endHeld();
                toast("This browser asks for your passkey again next time.");
              }}
            >
              Ask again
            </button>
          )}
        </div>
      )}
      {off ? (
        <p className="muted">{off}</p>
      ) : (
        <p className="set-foot">
          <button
            className="btn btn--sm"
            type="button"
            disabled={busy}
            onClick={async () => {
              await update(async () => (await makePasskey()) ? "Passkey saved on this page. Check each machine’s approval above." : "");
            }}
          >
            <Icon name="plus" />
            Add a passkey
          </button>
        </p>
      )}
    </section>
  );
}

// The agentbook each machine of yours runs, and Update where a newer one is out. A machine asks the repo it was
// installed from what main has (plugin/cli/update.ts): opening this card has each one that's on ask again, if it
// last did over 10 minutes ago, and Check asks now. Update is signed like any command that runs something there.
const UPDATE_FRESH_MS = 10 * 60e3;
function UpdatesBox() {
  const all = useApp((s) => s.data?.machines);
  const machines = (all || []).filter((m) => m.mine).sort((a, b) => Number(!!b.here) - Number(!!a.here) || a.name.localeCompare(b.name));
  const [busy, setBusy] = useState<string | null>(null);
  const on = machines.filter((m) => m.online && m.update && m.update.mode !== "none").map((m) => m.name).join("\n");
  useEffect(() => {
    for (const name of on.split("\n").filter(Boolean)) void getJSON(`/api/machines/${encodeURIComponent(name)}/update?within=${UPDATE_FRESH_MS}`);
  }, [on]);
  const act = async (name: string, run: () => Promise<void>) => {
    setBusy(name);
    try {
      await run();
    } finally {
      setBusy(null);
    }
  };
  const check = (name: string) =>
    act(name, async () => {
      const r = await fetch(`/api/machines/${encodeURIComponent(name)}/update?within=0`);
      const d = await r.json().catch(() => ({}));
      const u = d.update;
      if (!r.ok) toast(d.error || `Couldn't ask ${name}.`);
      else if (u?.checked?.error) toast(`${name} couldn't check: ${u.checked.error}`);
      else toast(u?.state === "behind" ? `agentbook ${u.to} is out for ${name}.` : `${name} has the newest agentbook.`);
    });
  const update = (name: string) =>
    act(name, async () => {
      const r = await post<{ started?: boolean }>(`/api/machines/${encodeURIComponent(name)}/update`, {});
      if (r.ok) toast(r.data.started === false ? `${name} has the newest agentbook already.` : `${name} is updating. It's back in a moment.`);
    });
  if (!all) return null;
  return (
    <section className="card box set" id="set-updates">
      <h3>Updates</h3>
      <p className="muted">Each machine of yours gets new versions of agentbook from the repo it was installed from. It updates itself once no agent is mid-turn, unless you've said otherwise there.</p>
      {machines.length ? (
        <ul className="rows">
          {machines.map((m) => {
            const u = m.update;
            const to = u?.to || "";
            // Update only where it takes one from here; Check wherever it asks main at all.
            const can = !!m.online && (u?.mode === "auto" || u?.mode === "ask");
            const asks = !!m.online && !!u && u.mode !== "none";
            const button = (label: string, run: () => unknown, dark = false, ok = can) => (
              <button className={`btn btn--sm${dark ? " btn--dark" : ""}`} type="button" disabled={!!busy || !ok} onClick={() => void run()}>
                {busy === m.name ? "…" : label}
              </button>
            );
            const checked = u?.checked ? (u.checked.error ? `couldn't check ${agoText(u.checked.at)}: ${u.checked.error}` : `checked ${agoText(u.checked.at)}`) : "";
            let say: ReactNode;
            let act: ReactNode = null;
            if (!m.cli || !u) say = "Its agentbook is from before it could update itself: update it there (README, Update).";
            else if (u.state === "updating") say = `Updating to ${to} now.`;
            else if (u.mode === "none") say = `Not updated from here: ${u.why || "it isn't an install"}.`;
            else if (u.state === "failed") {
              say = `It couldn't update to ${to}: ${u.error || "it didn't say why"}`;
              act = button("Try again", () => update(m.name));
            } else if (u.state === "behind" && u.mode === "off") say = <>{to} is out. Updates are off on it: <code>agentbook-cli update auto</code> there turns them on.</>;
            else if (u.state === "behind") {
              say = `${to} is out${u.mode === "auto" ? ": it updates itself once no agent is mid-turn" : ""}.`;
              act = button(`Update to ${to}`, () => update(m.name), true);
            } else {
              say = ["Up to date", checked, u.mode === "off" ? "updates are off on it" : u.mode === "ask" ? "it updates when you say" : ""].filter(Boolean).join(", ") + ".";
              act = button("Check now", () => check(m.name), false, asks);
            }
            return (
              <li key={m.name}>
                <span className="ico">
                  <Icon name="laptop" />
                </span>
                <span>
                  <b>
                    {m.name} {m.cli ? <code>v{m.cli.replace(/^v/, "")}</code> : null}
                  </b>
                  <small>
                    {m.online ? null : <>Off{m.seen ? ` since ${agoText(m.seen)}` : ""}. </>}
                    {say}
                  </small>
                </span>
                {act}
              </li>
            );
          })}
        </ul>
      ) : (
        <p>No machines on your account yet.</p>
      )}
    </section>
  );
}

// How you sign in: with Google, as the account this machine logged in with (agentbook login), through the relay,
// whose page has the account's machines.
function SigningInBox() {
  const relay = useApp((s) => s.auth.relay?.url || null);
  return (
    <section className="card box set" id="set-signin">
      <h3>Signing in</h3>
      <p>
        You sign in with Google, as the account this machine logged in with.
        {relay ? (
          <>
            {" "}
            Your account and its machines are on{" "}
            <a href={relay} target="_blank" rel="noopener noreferrer">
              {new URL(relay).host}
            </a>
            .
          </>
        ) : null}
      </p>
    </section>
  );
}

// Signing out of this browser (and forgetting its passkey key), or of every other one.
function SignOutBox() {
  return (
    <section className="card box set" id="set-signout">
      <h3>Signing out</h3>
      <div className="set-row">
        <p>Sign out of this browser, or of every other one you're signed in on.</p>
        <button
          className="btn btn--sm"
          type="button"
          onClick={async () => {
            const r = await post("/api/me/signout-everywhere", {});
            if (r.ok) toast("Signed out everywhere else.");
          }}
        >
          Sign out everywhere else
        </button>
        <button
          className="btn btn--sm"
          type="button"
          onClick={async () => {
            await post("/api/auth/logout", {});
            await sessionEnd();
            signedOut();
          }}
        >
          <Icon name="out" />
          Sign out
        </button>
      </div>
    </section>
  );
}

// Deleting your account: agentbook logout on this machine takes it off the account and deletes what agentbook keeps
// on it, and the relay's page deletes the account, with all its machines.
function DeleteBox() {
  const relay = useApp((s) => s.auth.relay?.url || null);
  return (
    <section className="card box set" id="set-delete">
      <h3>Delete account</h3>
      <p className="muted">
        Run <code>agentbook logout</code> on this machine: it takes the machine off your account and deletes everything agentbook keeps on it. To delete the account itself, with all its machines, use{" "}
        {relay ? (
          <a href={relay} target="_blank" rel="noopener noreferrer">
            {new URL(relay).host}
          </a>
        ) : (
          "the sign-in relay's page"
        )}
        . <a href="/privacy">What's kept, and where.</a>
      </p>
    </section>
  );
}

export function SettingsNav({ username, sub, keys }: { username: string; sub?: string | null; keys: Passkeys | null }) {
  const connectors = useApp((s) => s.data?.connectors);
  const on = useSetNav((s) => s.on);
  const sections: [string, IconName, string, number?][] = [["threads", "archive", "Threads"], ["passkeys", "key", "Passkeys", keys?.passkeys?.length], ["connectors", "plug", "Connectors", (connectors || []).length], ["updates", "sync", "Updates"], ["signin", "lock", "Signing in"], ["signout", "out", "Signing out"], ["delete", "x", "Delete account"]];
  const base = `${personHref(username, "settings")}`;
  const jump = (e: React.MouseEvent, k: string) => {
    e.preventDefault();
    if (k === "connectors") {
      useSetNav.setState({ on: k, jump: null });
      return go(`${base}/connectors`);
    }
    if (sub) {
      useSetNav.setState({ jump: k, on: k });
      return go(base);
    }
    useSetNav.setState({ on: k });
    document.getElementById(`set-${k}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <nav className="card set-nav" aria-label="Settings">
      {sections.map(([k, ic, label, n]) => (
        <a key={k} className={(sub || on) === k ? "is-on" : ""} href={k === "connectors" ? `${base}/connectors` : base} onClick={(e) => jump(e, k)}>
          <Icon name={ic} />
          {label}
          {n ? <span className="n">{n}</span> : null}
        </a>
      ))}
    </nav>
  );
}

export function SettingsCards({ keys, reload }: { keys: Passkeys | null; reload: () => unknown }) {
  const sub = useRoute().sub;
  // The direct Passkeys link and jumps back to another Settings card scroll after the cards have rendered.
  useEffect(() => {
    const k = useSetNav.getState().jump || (sub === "passkeys" ? "passkeys" : null);
    if (!k) return;
    useSetNav.setState({ jump: null });
    requestAnimationFrame(() => document.getElementById(`set-${k}`)?.scrollIntoView({ block: "start" }));
  }, [sub]);
  return (
    <>
      <div>
        <ThreadPrefsBox />
      </div>
      <div>
        <PasskeysBox keys={keys} reload={reload} />
      </div>
      <div>
        <UpdatesBox />
      </div>
      <div>
        <SigningInBox />
      </div>
      <div>
        <SignOutBox />
      </div>
      <div>
        <DeleteBox />
      </div>
    </>
  );
}
