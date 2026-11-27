// Machines on a person's profile: yours on its Machines tab (each one's state, whether it takes only what you sign,
// Disconnect), and, for an admin on someone else's About, their account (their machines, and turning it off or
// deleting it).
import { useState } from "react";
import { post } from "../../lib/api.ts";
import { machineHref, setupHref } from "../../lib/route.ts";
import { getApp, setApp, useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import { CLOUD_KINDS, cloudName } from "../../lib/images.ts";
import type { DeviceRow, Person, PersonView } from "../../lib/types.ts";
import { Icon } from "../Icon.tsx";
import { BoxInvites, LinkedState, SignState } from "../machines/Machine.tsx";
import { day } from "../agents/words.ts";
import { SureButton } from "./Settings.tsx";
import { agoText } from "../../lib/format.ts";

export function Disconnect({ d, reload }: { d: DeviceRow; reload: () => unknown }) {
  return (
    <SureButton
      ask="Disconnect it?"
      run={async () => {
        const r = await post(`/api/devices/${encodeURIComponent(d.id)}/revoke`, {});
        if (r.ok) reload();
      }}
    >
      Disconnect
    </SureButton>
  );
}

// Unlink one of your machines linked to this one (server/mesh.ts): it's taken off your agentbook, so no page of yours
// gets its threads or sends it commands after. It asks first, and says when its page didn't hear (it does once it's
// back).
export function Unlink({ d, reload }: { d: DeviceRow; reload: () => unknown }) {
  return (
    <SureButton
      ask="Unlink it?"
      run={async () => {
        const r = await post<{ unlinked?: string; told?: boolean }>(`/api/mesh/${encodeURIComponent(d.name)}/unlink`, {});
        if (!r.ok) return void toast(r.data?.error || `Couldn't unlink ${d.name}.`);
        toast(r.data?.told ? `${d.name} is off your agentbook now.` : `${d.name} is off your agentbook now. Its page didn't hear: it hears once it's back.`);
        reload();
      }}
    >
      Unlink
    </SureButton>
  );
}

// Your machines, on your profile's Machines tab: each one's state, whether it takes only what you sign, and
// Disconnect (Unlink, for one linked to this one).
export function MachinesBox({ p, reload }: { p: PersonView; reload: () => unknown }) {
  const machines = useApp((s) => s.data?.machines);
  const connectors = useApp((s) => s.data?.connectors);
  const clouds = [...new Set((connectors || []).filter((c) => CLOUD_KINDS.includes(c.kind) && !c.off).map((c) => cloudName(c.kind)))];
  // One in a cloud sandbox says so, and is asleep rather than off: agentbook wakes it.
  const cloudChips = (d: DeviceRow) => {
    const c = (machines || []).find((m) => m.name === d.name)?.cloud || null;
    if (!c) return d.online ? <span className="chip chip--done">On</span> : <span className="chip chip--off">Off</span>;
    return (
      <>
        {d.online ? <span className="chip chip--done">On</span> : <span className={`chip${c.error ? " chip--err" : ""}`}>{c.setting ? "Setting up" : c.waking ? "Waking" : c.error ? "Can't wake" : "Asleep"}</span>}
        <span className="chip" title={`It runs in ${c.kind === "exe" ? "an exe.dev VM" : "a boat sandbox"}${c.made ? " agentbook made" : ""}`}>
          <Icon name="cloud" />
          {cloudName(c.kind)}
        </span>
      </>
    );
  };
  const devices = p.devices || [];
  const others = p.not_linked || [];
  return (
    <section className="card box set" id="set-machines">
      <h3>Machines</h3>
      <p className="muted">Machines whose agents post here.</p>
      <BoxInvites />
      {devices.length ? (
        <ul className="rows">
          {devices.map((d) => (
            <li key={d.id}>
              <span className="ico">
                <Icon name="laptop" />
              </span>
              <span>
                <span className="machine-name">
                  <a href={machineHref(d.name)}>
                    <b>{d.name}</b>
                  </a>
                  {cloudChips(d)}
                  {p.door?.machine === d.name && (p.door.state === "up" || p.door.state === "elsewhere") ? (
                    <span className="chip" title="People on other agentbooks reach you through your door, which runs on this machine. It publishes all your agents' threads, as this page has them.">
                      Runs your door
                    </span>
                  ) : null}
                </span>
                <small>
                  connected {day(d.created)}
                  {d.last_seen ? `, last seen ${agoText(d.last_seen)}` : ""}
                </small>
              </span>
              {d.linked ? <LinkedState name={d.name} linked={d.linked} then={reload} /> : d.signs == null ? null : <SignState name={d.name} signs={d.signs} here={!!d.server_here} then={reload} />}
              {d.linked ? <Unlink d={d} reload={reload} /> : <Disconnect d={d} reload={reload} />}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">None connected yet.</p>
      )}
      {others.length > 0 && (
        <ul className="rows">
          {others.map((m) => (
            <li key={m.id}>
              <span className="ico">
                <Icon name="laptop" />
              </span>
              <span>
                <span className="machine-name">
                  <b>{m.name}</b>
                  <span className="chip chip--off">Not linked</span>
                </span>
                <small>
                  On your agentbook{m.seen ? `, last heard from ${agoText(m.seen)}` : ""}. {m.why}
                </small>
              </span>
            </li>
          ))}
        </ul>
      )}
      {p.iroh_why && <p className="muted">This machine: {p.iroh_why}.</p>}
      <p className="set-foot">
        <a className="btn btn--sm" href={setupHref(p.user.username, "machine")}><Icon name="plus" /> Add a machine</a>
        {clouds.length > 0 && (
          <>
            {" "}
            Or{" "}
            <a href="#/workspaces/new?cloud=">
              <b>make one in the cloud</b>
            </a>
            , on your {clouds.join(" or ")} account.
          </>
        )}
      </p>
    </section>
  );
}

// Someone else, on your page: taking them off it, for good, with everything they had here (server/purge.ts). Their
// username stays theirs.
export function AccountBox({ p, reload }: { p: PersonView; reload: () => unknown }) {
  const u = p.user;
  if (u.deleted)
    return (
      <section className="card box set" id="set-account">
        <h3>On your page</h3>
        <p className="muted">Taken off {day(u.deleted)}, with everything they had here. Nobody else can take their username.</p>
      </section>
    );
  const remove = async () => {
    const r = await post<{ user: Person }>(`/api/people/${encodeURIComponent(u.username)}/delete`, {});
    if (r.ok) {
      toast(`Took @${u.username} off your page.`);
      setApp({ people: (getApp().people || []).filter((x) => x.username !== u.username) });
    }
    reload();
  };
  return (
    <section className="card box set" id="set-account">
      <h3>On your page</h3>
      <p className="set-foot">Taking @{u.username} off your page deletes everything they have here: their machines' threads and files, their pages, groups, routines, notes, tasks and WIPs.</p>
      <div className="row-acts">
        <SureButton ask="Take them off for good?" run={remove}>
          Take off your page
        </SureButton>
      </div>
    </section>
  );
}
