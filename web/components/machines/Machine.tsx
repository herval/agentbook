// A machine of yours, on its page (#/machines/<name>), in parts: whether it's on and its agentbook-cli; the cloud
// sandbox it runs in and, for one agentbook made, where it came from and its secrets; a shared machine's people and
// your secrets on a seat of one; what runs on it; what waits for it; what it lets this server do (its gate, which
// only the machine changes); and what its gate did with the latest commands. And what your profile shows of your
// machines: whether one takes only what you sign (SignState), and the machines shared with you (BoxInvites).
import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { post } from "../../lib/api.ts";
import { agentMachine } from "../../lib/agent-groups.ts";
import { agentName, sortAgents, tildeOn } from "../../lib/agents.ts";
import { agoText, plural } from "../../lib/format.ts";
import { useLoad } from "../../lib/hooks.ts";
import { untilText, signMachine } from "../../lib/passkeys.ts";
import { connectorsHref, go, threadHref } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { CloudView, ImageSummary } from "../../lib/images.ts";
import type { BoxRow, MachineBoxes, MachineUsage, MachineView, Thread, Linked } from "../../lib/types.ts";
import { Avatar } from "../Avatar.tsx";
import { StatusChip } from "../Chips.tsx";
import { Icon } from "../Icon.tsx";
import { AgentListRow } from "../agents/AgentList.tsx";
import { busyFirst } from "../agents/words.ts";
import { UpdateButton } from "./Image.tsx";
import { AddAgentButton } from "../agents/AddAgentDialog.tsx";
import { OUTCOME, boatDollars, day, kindWords, machineTime } from "./words.ts";

const enc = encodeURIComponent;
// A machine on its page, as /api/machines/<name> has it: what the chrome's row has, and how its agentbook-cli updates
// itself, a shared machine's seat and people, your secrets on a seat, and whether git there signs in to GitHub as you.
export type MachineFull = Omit<MachineView, "people" | "agents" | "cloud"> & {
  agents?: number;
  update?: { mode?: string; state?: string; to?: string; at?: string; error?: string; why?: string } | null;
  seat?: string | null;
  shares?: boolean;
  secrets?: string[];
  people?: { user: string; state: string; seated?: boolean; machine?: string | null; online?: boolean; at?: string }[];
  cloud?: (CloudView & { github?: boolean; github_connected?: boolean }) | null;
};
// What the page does after a change: asks for the machine again.
export type Reload = () => void;

// A button that stays pressed while what it does is under way, as the old page's `button.disabled = true` did.
function Act({ className = "btn btn--sm", disabled = false, title, run, children }: { className?: string; disabled?: boolean; title?: string; run: () => Promise<unknown>; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={className}
      type="button"
      title={title}
      disabled={disabled || busy}
      onClick={async () => {
        setBusy(true);
        try {
          await run();
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
    </button>
  );
}

// Whether a machine of yours takes what can run something only when you sign it: Signed; no need, when its server
// is itself (agentbook up); else a button that hands it your passkeys, as it takes nothing that can run something
// until then. There's no turning it off. `then`: what to read again once it's signed.
export function SignState({ name, signs, here, then }: { name: string; signs: boolean; here: boolean; then?: () => void }) {
  if (signs)
    return (
      <span className="chip chip--done sign-chip" title="It takes a start, a message or an Allow only when your passkey signs it">
        <Icon name="key" />
        Signed
      </span>
    );
  if (here)
    return (
      <span className="chip sign-chip" title="Its server is on it, so it takes what that server sends unsigned">
        Its own server
      </span>
    );
  return (
    <Act title="It takes nothing that can run something until it keeps your passkeys" run={async () => (await signMachine(name), then?.())}>
      <Icon name="key" />
      Sign it
    </Act>
  );
}

// Another machine of yours linked to this page's (linked: server/mesh.ts): each takes your passkeys on the other's
// page by itself, as they link or as you first steer it (plugin/cli/page-keys.ts), once. Sign once is how this
// page's machine takes that one's page again after that, once its passkeys there were all taken off.
export function LinkedState({ name, linked, then }: { name: string; linked: Linked; then?: () => void }) {
  return (
    <>
      {linked.why && (
        <span className="chip" title={linked.why}>
          Sends here only
        </span>
      )}
      {linked.signs ? (
        <span className="chip chip--done sign-chip" title={`It takes what you sign on this page${linked.iroh ? ". They talk over iroh, encrypted between the two machines" : ""}`}>
          <Icon name="key" />
          Linked
        </span>
      ) : linked.url ? (
        <span className="chip" title={`${name} takes what you sign on this page once it has your passkeys here, which it takes by itself as they link or as you first steer it from here`}>
          Not yet
        </span>
      ) : (
        <span className="chip" title={`${name} has no page of its own: it takes what you sign on this page, and takes your passkeys here as you first steer it`}>
          No page
        </span>
      )}
      {linked.iroh && linked.path && (
        <span className="chip" title={linked.path === "direct" ? "The two machines reach each other directly, encrypted between them" : "The two machines can't reach each other directly, so what they say goes through the iroh relay, which can't read it"}>
          {linked.path === "direct" ? "Direct" : "Relayed"}
        </span>
      )}
      {!linked.takes && linked.url && (
        <Act title={`So this page's machine takes what you sign on ${name}'s page: it took your passkeys there by itself as they linked, and takes them again, once they were all taken off there, only as you press this`} run={async () => ((await post(`/api/mesh/${encodeURIComponent(name)}/vouch`, {})).ok && toast(`This machine takes what you sign on ${name}'s page now.`), then?.())}>
          <Icon name="key" />
          Sign once
        </Act>
      )}
    </>
  );
}

// The head: on or off, its agentbook-cli and how that updates, when it logged in, what's on it, where it clones.
export function MachineHead({ m, reload }: { m: MachineFull; reload: Reload }) {
  const all = useApp((s) => s.data?.agents);
  const agents = all ? all.filter((a) => a.mine !== false && agentMachine(a) === m.name).length : m.agents || 0;
  return (
    <section className="card box machine-head">
      <h1 className="page-h">
        <Icon name="laptop" /> {m.name} {m.online ? <span className="chip chip--done">On</span> : <span className="chip chip--off">{`Off${m.seen ? `, since ${agoText(m.seen)}` : ""}`}</span>}
      </h1>
      <dl className="kv">
        {m.cli && (
          <>
            <dt>agentbook-cli</dt>
            <dd>
              {m.cli}
              {m.os ? `, on ${m.os}` : ""}
              <MachineUpdate m={m} reload={reload} />
            </dd>
          </>
        )}
        {m.since && (
          <>
            <dt>Logged in</dt>
            <dd>{day(m.since)}</dd>
          </>
        )}
        <dt>On it</dt>
        <dd>
          {plural(agents, "agent")}, {plural(m.posts || 0, "thread")}
        </dd>
        {m.clone_dir && (
          <>
            <dt>Clones into</dt>
            <dd>
              <code>{tildeOn(m.name, m.clone_dir)}</code>
            </dd>
          </>
        )}
      </dl>
      {!m.online && <p className="muted">Its threads show what it did. What you send it waits until it's back: messages for a week, a start for an hour, a stop for a minute.</p>}
    </section>
  );
}

export function MachineAgents({ m }: { m: MachineFull }) {
  const all = useApp((s) => s.data?.agents);
  const agents = sortAgents((all || []).filter((a) => a.mine !== false && agentMachine(a) === m.name)).sort(busyFirst);
  return (
    <section className="card box machine-agents">
      <h3>
        <span>Agents <small>{plural(agents.length, "agent")}</small></span>
        <AddAgentButton machine={m.name} className="btn btn--sm"><Icon name="plus" />Add agents</AddAgentButton>
      </h3>
      <p className="muted agent-activation-note">Deactivate prevents new threads and hides the agent from your sidebar and feed. Existing threads continue, and its requests still reach you.</p>
      {!all ? <p className="muted">Loading agents…</p> : agents.length ? (
        <ul className="act-list">
          {agents.map((a) => <AgentListRow key={a.id} agent={a} manage />)}
        </ul>
      ) : <p className="list-empty">No agents on this machine yet.</p>}
    </section>
  );
}

// What a machine says of updating its own agentbook-cli, under its version, with Update where pressing it does
// something: your passkey signs it, and the machine fetches and checks the release itself. One that says nothing is
// older than updating itself.
export function MachineUpdate({ m, reload }: { m: MachineFull; reload: Reload }) {
  const u = m.update;
  if (!u) return null;
  const to = u.to || "";
  const update = async () => {
    const r = await post<{ started?: boolean }>(`/api/machines/${enc(m.name)}/update`, {});
    if (!r.ok && !r.data.passkey) toast(r.data.error || "Couldn't start the update.");
    if (r.ok) toast(r.data.started === false ? `${m.name} has the newest agentbook-cli already.` : `${m.name} is updating its agentbook-cli. It's back in a moment.`);
    reload();
  };
  const button = (label: string) =>
    u.mode === "auto" || u.mode === "ask" ? (
      <>
        {" "}
        <Act disabled={!m.online} run={update}>
          {label}
        </Act>
      </>
    ) : null;
  const line = (text: ReactNode, extra: ReactNode = null) => (
    <>
      <br />
      <small className="muted">{text}</small>
      {extra}
    </>
  );
  if (u.state === "updating") return line(`Updating to ${to} now.`);
  if (u.state === "failed") return line(`It couldn't update to ${to}: ${u.error || "it didn't say why"}`, button("Try again"));
  if (u.state === "behind") {
    if (u.mode === "none") return line(`${to} is out. It isn't updated from here: ${u.why || ""}.`);
    if (u.mode === "off")
      return line(
        <>
          {to} is out. Updates are off on it: <code>agentbook-cli update auto</code> there turns them on.
        </>,
      );
    if (u.mode === "ask") return line(`${to} is out. It updates when you say.`, button(`Update to ${to}`));
    return line(`${to} is out: it updates itself once no agent is mid-turn.`, button("Update now"));
  }
  const how = u.mode === "auto" ? "It updates itself" : u.mode === "ask" ? "It updates when you say" : u.mode === "off" ? "Updates are off on it" : "";
  return how || u.at ? line([how, u.at ? `${how ? "last" : "Last updated"} ${agoText(u.at)}` : ""].filter(Boolean).join(", ") + ".") : null;
}

// When boat stops a cloud machine that's on (cloud.ts, "sleeping"): soon once it's idle, late while it's busy.
function MachineSleep({ m }: { m: MachineFull }) {
  const s = m.online ? m.cloud?.sleep : null;
  if (!s) return null;
  if (s.error) return <p className="auth-err">agentbook couldn't say when its sandbox stops, so boat's own auto-stop stands. {s.error}</p>;
  if (!s.until) return null;
  return (
    <p className="muted">
      {s.busy ? (
        <>
          It's busy, so its sandbox stays up: until <b>{untilText(s.until)}</b> at the latest{s.capped ? ", the most boat's free trial allows" : ""}.
        </>
      ) : (
        <>
          Nothing's running on it: its sandbox stops at <b>{untilText(s.until)}</b> unless something starts.
        </>
      )}
    </p>
  );
}
function MachineUsageLine({ u }: { u: MachineUsage | null }) {
  if (!u || (!u.usage && !u.error)) return null;
  if (u.error) return <p className="muted">Couldn't read its usage. {u.error}</p>;
  const w = u.wallet;
  const left = !w ? "" : w.hours_left != null ? ` Your plan has ${machineTime(w.hours_left * 3600)} left${w.period_end ? ` until ${day(w.period_end)}` : ""}${w.balance != null ? `, and ${boatDollars(w.balance)} in the wallet` : ""}.` : w.balance != null ? ` ${boatDollars(w.balance)} in the wallet.` : "";
  return (
    <p className="muted">
      This month it ran <b>{machineTime(u.usage.seconds)}</b> of {u.usage.size || "default"} machine time, {boatDollars(u.usage.dollars)} at boat's price.{left}
      {w && !w.can_start ? " boat won't start a machine now: the plan's hours and the wallet are used up." : ""}
    </p>
  );
}

// Wake it, link it to a sandbox, unlink it, or turn git's GitHub sign-in there on or off: then it's read again.
export async function cloudAct(kind: "wake" | "link" | "unlink" | "github", name: string, args: { sandbox?: string; connector?: string; on?: boolean } = {}) {
  if (kind === "github") {
    const r = await post(`/api/machines/${enc(name)}/cloud/github`, { on: !!args.on });
    if (r.ok) toast(args.on ? `git on ${name} signs in to GitHub as you.` : `git on ${name} no longer signs in to GitHub as you.`);
    return r.ok;
  }
  const r = kind === "wake" ? await post<{ on?: boolean }>(`/api/machines/${enc(name)}/wake`, {}) : await post<{ on?: boolean }>(`/api/machines/${enc(name)}/cloud`, kind === "link" ? { connector: args.connector, sandbox: args.sandbox } : {});
  if (r.ok) toast(kind === "wake" ? (r.data?.on ? `${name} is on.` : `Waking ${name}.`) : kind === "link" ? `agentbook wakes ${name} when you send it something.` : `${name} isn't linked to a sandbox any more.`);
  return r.ok;
}

// The sandbox a machine of yours runs in (cloud.ts): linked, agentbook wakes it when something waits for it. Not
// linked yet, your boat sandboxes to say which one (`boxes`).
export function MachineCloud({ m, usage, boxes, images, deleting, setDeleting, reload, unlinked }: { m: MachineFull; usage: MachineUsage | null; boxes: MachineBoxes | null; images: ImageSummary[]; deleting: boolean; setDeleting: (v: boolean) => void; reload: Reload; unlinked: () => void }) {
  const c = m.cloud;
  const wake = (
    <Act run={async () => (await cloudAct("wake", m.name), reload())}>
      Wake it now
    </Act>
  );
  const state = (c: CloudView) =>
    m.online ? null : c.waking ? (
      <div className="live live--step">
        <i className="pulse" />
        <b>Waking it</b>
        {c.error && <span className="live-n">{c.error}</span>}
      </div>
    ) : c.error ? (
      <p className="auth-err">Couldn't wake it. {c.error}</p>
    ) : null;
  // Your seat on someone else's shared machine: its sandbox is theirs. What it says of waking and sleeping is yours too.
  if (c?.shared)
    return (
      <section className="card box">
        <h3>Its sandbox</h3>
        <p className="muted">
          It runs in @{c.shared.owner || "its owner"}'s boat sandbox, with {c.shared.machine || "their machine"}. agentbook wakes it when you send it something, on their boat account.
        </p>
        {state(c)}
        <MachineSleep m={m} />
        {m.online || c.waking ? null : <div className="row-acts">{wake}</div>}
      </section>
    );
  if (c)
    return (
      <>
        <section className="card box">
          <h3>{c.kind === "exe" ? "Its VM" : "Its sandbox"}</h3>
          <p className="muted">
            {c.kind === "exe" ? (
              <>
                {m.name} runs in exe.dev VM <code>{c.sandbox}</code>, which stays on until it's paused there. agentbook resumes it when you send it something.
              </>
            ) : (
              <>
                {m.name} runs in boat sandbox <code>{c.sandbox}</code>, which stops itself when it's been on a while. agentbook wakes it when you send it something.
              </>
            )}
          </p>
          {state(c)}
          <MachineSleep m={m} />
          <MachineUsageLine u={usage} />
          <div className="row-acts">
            {m.online || c.waking ? null : wake}
            {!c.made && (
              <Act className="btn btn--line btn--sm" run={async () => (await cloudAct("unlink", m.name), unlinked(), reload())}>
                Unlink
              </Act>
            )}
          </div>
          <ul className="rows">
            <li>
              <span className="ico">
                <Icon name="repo" />
              </span>
              <span>
                <b>git there signs in to GitHub as you</b>
                <small>
                  {!c.github ? (
                    "Off: git on it has no GitHub sign-in from agentbook, so it clones only public repos."
                  ) : c.github_connected ? (
                    "With your GitHub connector's sign-in, asked for one git command at a time and never kept on its disk. Your agents there can clone what that connector reads."
                  ) : (
                    <>
                      On, but you have no GitHub connector: <a href={connectorsHref()}>connect GitHub</a> and git there can clone your private repos.
                    </>
                  )}
                </small>
              </span>
              <Act run={async () => (await cloudAct("github", m.name, { on: !c.github }), reload())}>{c.github ? "Turn off" : "Turn on"}</Act>
            </li>
          </ul>
        </section>
        <MadeMachine m={m} img={images.find((i) => i.id === c.image) || null} deleting={deleting} setDeleting={setDeleting} reload={reload} />
      </>
    );
  const on = (m.boat || []).find((x) => x.id === boxes?.connector);
  if (!on || !boxes) return null;
  const where = on.kind === "exe" ? { one: "an exe.dev VM", them: "exe.dev VMs", none: "Your exe.dev account has no VMs." } : { one: "a boat sandbox", them: "boat sandboxes", none: "Your boat account has no sandboxes." };
  return (
    <section className="card box">
      <h3>{on.kind === "exe" ? "Its VM" : "Its sandbox"}</h3>
      <p className="muted">If {m.name} runs in {where.one}, say which one: agentbook then wakes it when you send it something, instead of waiting for it.</p>
      {boxes.error ? (
        <p className="auth-err">{boxes.error}</p>
      ) : !boxes.list ? (
        <p className="muted">Reading your {where.them}…</p>
      ) : boxes.list.length ? (
        <ul className="rows">
          {boxes.list.map((x) => (
            <li key={x.id}>
              <span className="ico">
                <Icon name="laptop" />
              </span>
              <span>
                <b>{x.name || x.id}</b>
                <small>
                  <code>{x.id}</code>, {x.state}
                </small>
              </span>
              <Act run={async () => (await cloudAct("link", m.name, { sandbox: x.id, connector: boxes.connector }), reload())}>It runs in this one</Act>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{where.none}</p>
      )}
    </section>
  );
}

// A cloud machine agentbook made, on its page: where it came from, how its setup or update is going, its secrets,
// and Delete. `img`: its image as the chrome has it (briefly), or null.
export function MadeMachine({ m, img, deleting, setDeleting, reload }: { m: MachineFull; img: ImageSummary | null; deleting: boolean; setDeleting: (v: boolean) => void; reload: Reload }) {
  const c = m.cloud;
  if (!c?.made) return null;
  if (c.kind === "exe") return <MadeOnExe m={m} deleting={deleting} setDeleting={setDeleting} reload={reload} />;
  const behind = img?.built && c.v != null && c.v < img.built;
  const setSecret = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const r = await post(`/api/machines/${enc(m.name)}/cloud/secrets`, { name: String(fd.get("name") || "").trim(), value: String(fd.get("value") || "") });
    if (!r.ok) return void toast(r.data.error || "Couldn't set it.");
    toast(`Set on boat. ${m.name}'s new sessions get it once its agentbook-cli starts again.`);
    form.reset();
    reload();
  };
  const del = async () => {
    if (!deleting) return setDeleting(true);
    setDeleting(false);
    const r = await post(`/api/machines/${enc(m.name)}/cloud/delete`, {});
    if (!r.ok) return void (r.data.passkey || toast(r.data.error || "Couldn't delete it."));
    toast(`Deleted ${m.name}, with its sandbox on boat.`);
    go(connectorsHref());
  };
  return (
    <section className="card box">
      <h3>Made by agentbook</h3>
      <p className="muted">
        From {img ? <a href={`#/images/${enc(img.id)}`}>{img.name}</a> : "an image that's gone"}
        {c.v ? `, v${c.v}` : ", unbuilt"} · {c.size || "default"}.{behind ? ` v${img.built} is built since.` : ""}
      </p>
      {c.updating ? (
        <div className="live live--step">
          <i className="pulse" />
          <b>Updating to v{c.updating}</b>
          <span className="live-n">its image's script is running on it</span>
        </div>
      ) : c.setting ? (
        <div className="live live--step">
          <i className="pulse" />
          <b>Setting itself up</b>
          <span className="live-n">installing what its image has; threads can start once it's On</span>
        </div>
      ) : c.setup_error ? (
        <p className="auth-err">{c.setup_error}</p>
      ) : null}
      {behind && (
        <>
          <div className="row-acts">
            <UpdateButton className="btn btn--sm btn--dark" name={m.name} disabled={!m.online || !!c.updating} label={`Update to v${img.built}`} onDone={reload} />
          </div>
          <p className="muted im-note">
            Update installs what's new in v{img.built} on its disk, and its work stays.{m.online ? "" : " It has to be on: wake it first."}
          </p>
        </>
      )}
      <h3 className="im-sub">Its secrets</h3>
      {c.secrets?.length ? (
        <ul className="rows">
          {c.secrets.map((k) => (
            <li key={k}>
              <span className="ico">
                <Icon name="key" />
              </span>
              <span>
                <b>
                  <code>{k}</code>
                </b>
                <small>Its value is on boat, not here.</small>
              </span>
              <Act
                run={async () => {
                  const r = await post(`/api/machines/${enc(m.name)}/cloud/secrets`, { name: k });
                  if (!r.ok) toast(r.data.error || "Couldn't take it away.");
                  reload();
                }}
              >
                Take away
              </Act>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">None set.</p>
      )}
      <SecretForm onSubmit={setSecret} />
      <p className="muted im-note">New sessions on it get a secret once its agentbook-cli starts again: at its next wake, or sooner if you restart it there.</p>
      <div className="set-row made-del">
        <p>{deleting ? `Delete ${m.name}? Its sandbox, its disk and its secrets are deleted from boat. Work on it that isn't pushed is lost. Its threads stay here, ended.` : "Delete this machine: its sandbox and its secrets on boat, and its login here."}</p>
        <button className={`btn btn--sm${deleting ? " btn--dark" : ""}`} type="button" onClick={del}>
          {deleting ? "Delete it" : "Delete"}
        </button>
      </div>
    </section>
  );
}
// One agentbook made on exe.dev: how its setup is going, the code its login waits on (said yes to on the relay's page,
// where it shows the same code), Try again when it stopped, and Delete.
function MadeOnExe({ m, deleting, setDeleting, reload }: { m: MachineFull; deleting: boolean; setDeleting: (v: boolean) => void; reload: Reload }) {
  const c = m.cloud;
  const del = async () => {
    if (!deleting) return setDeleting(true);
    setDeleting(false);
    const r = await post(`/api/machines/${enc(m.name)}/cloud/delete`, {});
    if (!r.ok) return void (r.data.passkey || toast(r.data.error || "Couldn't delete it."));
    toast(`Deleted ${m.name}, with its VM on exe.dev.`);
    go(connectorsHref());
  };
  return (
    <section className="card box">
      <h3>Made by agentbook</h3>
      <p className="muted">
        A VM on your exe.dev account, with agentbook installed. <code>ssh {c.sandbox}.exe.xyz</code> gets you a shell there.
      </p>
      {m.online ? null : c.login ? (
        <div className="live live--step">
          <i className="pulse" />
          <a href={c.login.url} target="_blank" rel="noreferrer">
            <b>Say yes to {c.login.code}</b>
          </a>
          <span className="live-n">on the sign-in page, which shows the same code, and {m.name} is On a moment later</span>
        </div>
      ) : c.setting ? (
        <div className="live live--step">
          <i className="pulse" />
          <b>Setting itself up</b>
          <span className="live-n">installing agentbook; the code to say yes to shows here in a few minutes</span>
        </div>
      ) : c.setup_error ? (
        <>
          <p className="auth-err">{c.setup_error}</p>
          <div className="row-acts">
            <Act
              run={async () => {
                const r = await post(`/api/machines/${enc(m.name)}/cloud/setup`, {});
                if (!r.ok) toast(r.data.error || "Couldn't start it again.");
                reload();
              }}
            >
              Try again
            </Act>
          </div>
        </>
      ) : null}
      <div className="set-row made-del">
        <p>{deleting ? `Delete ${m.name}? Its VM and its disk are deleted from exe.dev. Work on it that isn't pushed is lost. Its threads stay here, ended.` : "Delete this machine: its VM on exe.dev, and its login here."}</p>
        <button className={`btn btn--sm${deleting ? " btn--dark" : ""}`} type="button" onClick={del}>
          {deleting ? "Delete it" : "Delete"}
        </button>
      </div>
    </section>
  );
}
function SecretForm({ onSubmit }: { onSubmit: (e: FormEvent<HTMLFormElement>) => void }) {
  return (
    <form className="im-add" onSubmit={onSubmit}>
      <input name="name" placeholder="NAME" aria-label="A secret's name" autoComplete="off" autoCapitalize="characters" spellCheck={false} required />
      <input name="value" type="password" placeholder="its value" aria-label="Its value" autoComplete="off" spellCheck={false} required />
      <button className="btn btn--sm" type="submit">
        <Icon name="plus" />
        Set
      </button>
    </form>
  );
}

// Leave a shared machine you're on (or, `decline`, turn down one shared with you): its Linux user and home there
// are deleted. Says whether it did.
async function leaveBox(id: string, decline: boolean) {
  const r = await post<{ left?: string }>(`/api/boxes/${enc(id)}/leave`, {});
  if (!r.ok) return void toast(r.data.error || "Couldn't leave it.");
  toast(decline ? "Turned down." : `You left ${r.data.left}.`);
  return true;
}

// On a machine of yours that's set up to be shared (its agentbook-cli runs in a seat there, with the seats helper):
// who's on it, adding someone, and taking them off. Each person has their own Linux user, logins and agentbook-cli
// there; the code is shared. On your seat on someone else's: whose it is, and Leave.
export function MachinePeople({ m, reload }: { m: MachineFull; reload: Reload }) {
  const boxes = useApp((s) => s.data?.boxes);
  const [leaving, setLeaving] = useState(false);
  if (m.cloud?.shared) {
    const s = m.cloud.shared;
    const box = (boxes || []).find((b) => b.seat === m.name);
    return (
      <section className="card box">
        <h3>Your seat</h3>
        <p className="muted">
          {m.name} is your seat on <b>{s.machine || "a shared machine"}</b>, @{s.owner || "its owner"}'s: your own Linux user there, with your own logins, beside theirs. Its sandbox is theirs, and wakes when any of you sends it something.
        </p>
        {box && (
          <div className="row-acts">
            <button
              className="btn btn--sm"
              type="button"
              onClick={async () => {
                if (!leaving) return setLeaving(true);
                setLeaving(false);
                if (await leaveBox(box.id, false)) go("#/");
              }}
            >
              {leaving ? "Leave it? Your Linux user and home there are deleted" : "Leave"}
            </button>
          </div>
        )}
      </section>
    );
  }
  const people = m.people || [];
  if (!m.shares && !people.length && !m.seat) return null;
  const add = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const user = String(new FormData(form).get("user") || "")
      .trim()
      .replace(/^@/, "");
    // With a passkey, the server answers with what to sign, and post() signs it and sends it again.
    const r = await post(`/api/machines/${enc(m.name)}/people`, { user });
    if (!r.ok) return void (r.data.passkey || toast(r.data.error || "Couldn't add them."));
    toast(r.data.queued ? `@${user}'s seat is made when ${m.name} is next on.` : `@${user} has a seat on ${m.name}. They join from their profile.`);
    form.reset();
    reload();
  };
  return (
    <section className="card box">
      <h3>People</h3>
      <p className="muted">{people.length ? "Who's on this machine with you. They see the threads that run on it, unless one is made Private." : "Only you. Someone you add works on it as themselves, beside you."}</p>
      {people.length > 0 && (
        <ul className="rows">
          {people.map((p) => {
            const state = p.state === "joined" ? (p.online ? ["On", "chip--done"] : ["Joined", ""]) : p.seated ? ["Invited", "chip--new"] : ["Once it's on", ""];
            const small = p.state === "joined" ? `their seat is ${p.machine ? p.machine : "theirs"}` : p.seated ? "their seat is made there; they join from their own page" : "their seat is made when the machine is next on";
            return (
              <li key={p.user}>
                <span className="ico">
                  <Icon name="agents" />
                </span>
                <span>
                  <b>@{p.user}</b>
                  <small>{small}</small>
                </span>
                <span className={`chip ${state[1]}`}>{state[0]}</span>
                <Act
                  run={async () => {
                    const r = await post(`/api/machines/${enc(m.name)}/people`, { user: p.user, remove: true });
                    if (!r.ok) toast(r.data.error || "Couldn't take them off.");
                    else toast(`@${p.user} is off ${m.name}: their Linux user and home there are deleted${r.data.queued ? " once it's on" : ""}.`);
                    reload();
                  }}
                >
                  Take off
                </Act>
              </li>
            );
          })}
        </ul>
      )}
      {m.shares ? (
        <>
          <form className="im-add" onSubmit={add}>
            <input name="user" placeholder="@username" aria-label="Someone's username" autoComplete="off" autoCapitalize="off" spellCheck={false} required />
            <button className="btn btn--sm" type="submit">
              <Icon name="plus" />
              Add them
            </button>
          </form>
          <p className="muted im-note">You sign it with your passkey, and the machine checks that itself. They get a Linux user of their own there, with no sudo, and bring their own Claude Code, Codex and GitHub logins. The code, and the bill, are shared: it wakes for any of you, on your boat account.</p>
        </>
      ) : (
        <p className="muted im-note">
          To share {m.name}, on it, as root: <code>agentbook-cli seat share {m.seat || "your-seat"}</code>. Then you add people here.
        </p>
      )}
    </section>
  );
}

// Your own secrets on a seat of a shared machine: their names. A value you type goes to your own agentbook-cli there,
// signed with your passkey, and is kept in your home on that machine, which only you read.
export function SeatSecrets({ m, reload }: { m: MachineFull; reload: Reload }) {
  if (!m.seat) return null;
  const later = () => setTimeout(reload, 600);
  const set = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const r = await post(`/api/machines/${enc(m.name)}/secrets`, { name: String(fd.get("name") || "").trim(), value: String(fd.get("value") || "") });
    if (!r.ok) return void (r.data.passkey || toast(r.data.error || "Couldn't set it."));
    toast(r.data.queued ? "It's set once the machine is on." : "Set, in your home on the machine.");
    form.reset();
    later();
  };
  return (
    <section className="card box">
      <h3>Your secrets there</h3>
      <p className="muted">What your own sessions on it need, like an API key. Nobody else on the machine can read them, and agentbook keeps only their names.</p>
      {m.secrets?.length > 0 && (
        <ul className="rows">
          {m.secrets.map((k) => (
            <li key={k}>
              <span className="ico">
                <Icon name="key" />
              </span>
              <span>
                <b>
                  <code>{k}</code>
                </b>
                <small>Its value is in your home on the machine, not here.</small>
              </span>
              <button
                className="btn btn--sm"
                type="button"
                onClick={async () => {
                  const r = await post(`/api/machines/${enc(m.name)}/secrets`, { name: k });
                  if (!r.ok && !r.data.passkey) toast(r.data.error || "Couldn't take it away.");
                  later();
                }}
              >
                Take away
              </button>
            </li>
          ))}
        </ul>
      )}
      <SecretForm onSubmit={set} />
      <p className="muted im-note">Sessions you start there from now on have it.{m.online ? "" : " It's off: this waits a few minutes for it, so wake it first."}</p>
    </section>
  );
}

export function BoxInvites() {
  const boxes = useApp((s) => s.data?.boxes);
  const waiting = (boxes || []).filter((b: BoxRow) => b.state === "invited");
  if (!waiting.length) return null;
  const join = async (b: BoxRow) => {
    const r = await post<{ on: string; machine: string }>(`/api/boxes/${enc(b.id)}/join`, {});
    if (!r.ok) return void toast(r.data.error || "Couldn't join it.");
    toast(`You're on ${r.data.on}, as ${r.data.machine}. Sign Claude Code in there from its card.`);
    go(`#/machines/${enc(r.data.machine)}`);
  };
  return (
    <ul className="rows">
      {waiting.map((b) => (
        <li key={b.id}>
          <span className="ico">
            <Icon name="laptop" />
          </span>
          <span>
            <b>{b.machine}</b>
            <small>
              @{b.owner || "someone"} shared it with you{b.seated ? "" : ": your seat is made when it's next on"}
            </small>
          </span>
          <Act className="btn btn--sm btn--dark" disabled={!b.seated} run={() => join(b)}>
            Join
          </Act>
          <button className="btn btn--sm" type="button" onClick={() => leaveBox(b.id, true)}>
            No thanks
          </button>
        </li>
      ))}
    </ul>
  );
}

// Its threads that are running, the one worked on last first, each opening its thread. While it's off, nobody
// knows what runs on it (its threads say "Off").
export function MachineThreads({ m }: { m: MachineFull }) {
  const rows = useApp((s) => s.rows);
  const here = useApp((s) => s.data?.machine);
  if (!m.online) return null;
  const live = Object.values(rows)
    .filter((s: Thread) => s.effective === "working" && !s.archived && !s.hidden && (s.machine || here) === m.name)
    .sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
  if (!live.length)
    return (
      <section className="card box">
        <h3>Running on it</h3>
        <p className="muted">Nothing right now.</p>
      </section>
    );
  return (
    <section className="card box">
      <h3>
        Running on it<span className="n">{live.length}</span>
      </h3>
      <ul className="rows">
        {live.map((s) => (
          <li key={s.id}>
            <Avatar agent={s.agent} size="av--sm" on="active" />
            <span>
              <a href={threadHref(s.id)}>
                <b>{s.title || s.label}</b>
              </a>
              <small>
                {s.label}, {agentName(s.agent)}
                {s.repo ? `, in ${s.repo}` : ""}
                {s.updated ? `, ${agoText(s.updated)}` : ""}
              </small>
            </span>
            <StatusChip thread={s} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function MachineWaiting({ m, reload }: { m: MachineFull; reload: Reload }) {
  if (!m.waiting?.length) return null;
  return (
    <section className="card box">
      <h3>
        Waiting for it<span className="n">{m.waiting.length}</span>
      </h3>
      <ul className="rows">
        {m.waiting.map((c) => (
          <li key={c.cid}>
            <span className="ico">
              <Icon name="clock" />
            </span>
            <span>
              <b>{kindWords(c.kind)}</b>
              <small>
                {c.text ? `“${c.text.slice(0, 120)}”, ` : ""}sent {agoText(c.at)}
                {c.post && (
                  <>
                    , on <a href={threadHref(c.post)}>its thread</a>
                  </>
                )}
              </small>
            </span>
            <Act
              run={async () => {
                const r = await post(`/api/machines/${enc(m.name)}/commands/${enc(c.cid)}/cancel`, {});
                if (r.ok) toast("Taken back.");
                reload();
              }}
            >
              Take it back
            </Act>
          </li>
        ))}
      </ul>
    </section>
  );
}

// What it lets this server do: its gate.json, which only the machine changes.
export function MachineGate({ m, reload }: { m: MachineFull; reload: Reload }) {
  const g = m.gate;
  if (!g)
    return (
      <section className="card box">
        <h3>What it lets this server do</h3>
        <p className="muted">{m.name} hasn't said yet: its agentbook-cli tells this server once it's connected.</p>
      </section>
    );
  return (
    <section className="card box">
      <h3>What it lets this server do</h3>
      <p className="muted">
        {m.name} decides, in its own <code>gate.json</code>. Change it there: <code>agentbook-cli allow &lt;folder&gt;</code>, <code>deny</code>, <code>gate</code>.
      </p>
      <dl className="kv">
        <dt>Steered by</dt>
        <dd>{g.owner ? `@${g.owner} only` : "its owner"}</dd>
        <dt>Folders</dt>
        <dd>
          {g.shared.length ? (
            <ul className="plain">
              {g.shared.slice(0, 30).map((f) => (
                <li key={f}>
                  <code>{f}</code>
                </li>
              ))}
              {g.shared.length > 30 && <li className="muted">and {g.shared.length - 30} more</li>}
            </ul>
          ) : (
            "none yet"
          )}
        </dd>
        {g.never?.length > 0 && (
          <>
            <dt>Kept out</dt>
            <dd>
              {g.never.map((f, i) => (
                <span key={f}>
                  {i ? ", " : ""}
                  <code>{f}</code>
                </span>
              ))}
            </dd>
          </>
        )}
        <dt>Turned off</dt>
        <dd>{g.off?.length ? g.off.join(", ") : "nothing"}</dd>
        <dt>New threads</dt>
        <dd>at most {g.starts_per_hour} an hour</dd>
        {g.ask_here?.length > 0 && (
          <>
            <dt>Asks there first</dt>
            <dd>
              {g.ask_here.join(", ")}
              {g.waiting ? `, ${plural(g.waiting, "command")} waiting for an OK` : ""}
            </dd>
          </>
        )}
        <dt>Signed</dt>
        <dd>
          {g.signed?.keys?.length ? (
            <>
              what can run something, only when {g.signed.keys.length === 1 ? "your passkey signs it" : "one of your passkeys signs it"} (
              {g.signed.keys.map((x, i) => (
                <span key={x.fingerprint}>
                  {i ? ", " : ""}
                  <code>{x.fingerprint}</code>
                </span>
              ))}
              )
            </>
          ) : g.server_here ? (
            "not needed from its own page: its server is on it"
          ) : (
            <>
              not yet: it takes nothing that can run something until it keeps your passkeys <SignState name={m.name} signs={false} here={false} then={reload} />
            </>
          )}
        </dd>
        {g.signed?.sites?.length > 0 && (
          <>
            <dt>Other pages</dt>
            <dd>
              what you sign on{" "}
              {g.signed.sites.map((x, i) => (
                <span key={x.origin}>
                  {i ? ", " : ""}
                  <a href={x.origin} target="_blank" rel="noreferrer">
                    {x.name ? `${x.name}'s page` : x.origin}
                  </a>{" "}
                  (
                  {x.keys.map((k, j) => (
                    <span key={k.fingerprint}>
                      {j ? ", " : ""}
                      <code>{k.fingerprint}</code>
                    </span>
                  ))}
                  )
                </span>
              ))}
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}

export function MachineAudit({ m }: { m: MachineFull }) {
  if (!m.audit?.length) return null;
  return (
    <section className="card box">
      <h3>What it did with what it was asked</h3>
      <ul className="rows audit">
        {m.audit.slice(0, 50).map((l, i) => {
          const [word, cls] = OUTCOME[l.outcome] || [l.outcome, ""];
          return (
            <li key={i}>
              <span className={`chip ${cls}`}>{word}</span>
              <span>
                <b>{kindWords(l.kind)}</b>
                <small>
                  {l.by ? `from @${l.by}, ` : ""}
                  {agoText(l.at)}
                  {l.root || l.path ? (
                    <>
                      , <code>{l.root || l.path}</code>
                    </>
                  ) : null}
                  {l.reason ? `: ${l.reason}` : ""}
                </small>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function useUsage(m: MachineFull | null): MachineUsage | null {
  const [usage, setUsage] = useState<MachineUsage | null>(null);
  const asked = useRef(false);
  const cloud = !!m?.cloud && !m.cloud.shared;
  const name = m?.name;
  useEffect(() => {
    if (!cloud || asked.current) return;
    asked.current = true;
    let gone = false;
    fetch(`/api/machines/${enc(name)}/cloud/usage`)
      .then(async (res) => ({ res, d: await res.json().catch(() => ({})) }))
      .then(({ res, d }) => !gone && setUsage({ name, ...(res.ok ? d : { error: d.error || `Something went wrong (HTTP ${res.status})` }) }))
      .catch(() => {});
    return () => void (gone = true);
  }, [cloud, name]);
  return usage;
}

function useBoxes(m: MachineFull | null): [MachineBoxes | null, () => void] {
  const [boxes, setBoxes] = useState<MachineBoxes | null>(null);
  const c = m && !m.cloud ? (m.boat || []).find((x) => !x.off) : null;
  const name = m?.name;
  useEffect(() => {
    if (!c || boxes) return;
    setBoxes({ name, connector: c.id, list: null, error: null });
    fetch(`/api/machines/${enc(name)}/cloud/sandboxes?connector=${enc(c.id)}`)
      .then(async (res) => ({ res, d: await res.json().catch(() => ({})) }))
      .then(({ res, d }) => setBoxes({ name, connector: c.id, list: res.ok ? d.sandboxes : null, error: res.ok ? null : d.error || `Something went wrong (HTTP ${res.status})` }))
      .catch(() => {});
  }, [c?.id, name, boxes]);
  return [boxes, () => setBoxes(null)];
}

// Inline machine details inside a machine card on the Agents tab (replaces the standalone #/machines/:name page).
// Loaded lazily only when the Details & access section is expanded.
export function MachineDetailsPanel({ name }: { name: string }) {
  const images = useApp((s) => s.data?.images) || [];
  const online = useApp((s) => s.data?.machines?.find((m) => m.name === name)?.online);
  const allAgents = useApp((s) => s.data?.agents);
  const L = useLoad<MachineFull>(`/api/machines/${enc(name)}`, online ?? null);
  const m = L.data;
  const reload = () => void L.reload();
  const [deleting, setDeleting] = useState(false);
  const usage = useUsage(m);
  const [boxes, unlinked] = useBoxes(m);

  if (!m) {
    if (L.loading || (!L.missing && !L.error)) return <p className="muted">Loading details for {name}…</p>;
    return <p className="muted">Details aren’t available for {name}.</p>;
  }
  const agents = allAgents ? allAgents.filter((a) => a.mine !== false && agentMachine(a) === m.name).length : m.agents || 0;
  return (
    <div className="machine-details">
      <dl className="machine-details-grid">
        {m.cli && (
          <div className="machine-details-kv">
            <dt>agentbook-cli / plugin</dt>
            <dd>
              <code>{m.cli}</code>
              <MachineUpdate m={m} reload={reload} />
            </dd>
          </div>
        )}
        {m.os && (
          <div className="machine-details-kv">
            <dt>Operating system</dt>
            <dd>{m.os}</dd>
          </div>
        )}
        <div className="machine-details-kv">
          <dt>On it</dt>
          <dd>
            {plural(agents, "agent")}, {plural(m.posts || 0, "thread")}
            {m.since ? <span className="muted"> · Logged in {day(m.since)}</span> : null}
          </dd>
        </div>
        {m.clone_dir && (
          <div className="machine-details-kv">
            <dt>Clones into</dt>
            <dd>
              <code>{tildeOn(m.name, m.clone_dir)}</code>
            </dd>
          </div>
        )}
      </dl>
      {!m.online && <p className="muted machine-details-note">Its threads show what it did. What you send it waits until it’s back: messages for a week, a start for an hour, a stop for a minute.</p>}
      <MachineCloud m={m} usage={usage} boxes={boxes} images={images} deleting={deleting} setDeleting={setDeleting} reload={reload} unlinked={unlinked} />
      <MachinePeople m={m} reload={reload} />
      <SeatSecrets m={m} reload={reload} />
      <MachineWaiting m={m} reload={reload} />
      <MachineGate m={m} reload={reload} />
      <MachineAudit m={m} />
    </div>
  );
}
