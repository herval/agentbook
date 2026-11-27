import { useEffect, useState } from "react";
import type { ButtonHTMLAttributes } from "react";
import { create } from "zustand";
import { isCloudRuntime } from "../../lib/agent-groups.ts";
import { followHash, personHref, useRoute } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import { Dialog } from "../Dialog.tsx";
import { Icon } from "../Icon.tsx";
import { AddMachine } from "../machines/Setup.tsx";
import { CloudAgents } from "./CloudAgents.tsx";
import { NewAgent } from "./NewAgent.tsx";

interface Target {
  machine?: string | null;
  open?: string | null;
}

const useAgentBox = create<{ target: Target | null }>(() => ({ target: null }));
export const openAddAgent = (target: Target = {}) => useAgentBox.setState({ target });
const closeAgentBox = () => useAgentBox.setState({ target: null });

type TriggerProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & Target;
export function AddAgentButton({ machine, open, children, ...props }: TriggerProps) {
  return <button {...props} type="button" aria-haspopup="dialog" onClick={() => openAddAgent({ machine, open })}>{children || "Add agent"}</button>;
}

export function AddAgentDialog() {
  const clicked = useAgentBox((s) => s.target);
  const route = useRoute();
  const username = useApp((s) => s.me?.username);
  const linked = route.name === "person" && route.id === username && route.tab === "agents" && route.open !== "machine" && !!(route.machine || route.open);
  const target = clicked || (linked ? route : null);
  useEffect(() => {
    window.addEventListener("hashchange", closeAgentBox);
    return () => {
      window.removeEventListener("hashchange", closeAgentBox);
      closeAgentBox();
    };
  }, [username]);
  const close = () => {
    closeAgentBox();
    if (linked) {
      history.replaceState(history.state, "", personHref(username, "agents"));
      followHash();
    }
  };
  const cloud = target?.open === "cloud" || isCloudRuntime(target?.open);
  const title = cloud ? "Cloud connections" : target?.machine ? `Add agent on ${target.machine}` : "Add agent";
  return (
    <Dialog open={!!target} onClose={close} label={title} className="viewer modal modal--add">
      <header className="viewer-h">
        <span className="viewer-t"><b>{title}</b></span>
        <button type="button" className="icon-btn" aria-label="Close" onClick={close}><Icon name="x" /></button>
      </header>
      <div className="modal-body">
        <section className="modal-sec">
          {target && <AgentPicker key={JSON.stringify([username, target.machine, target.open])} target={target} cloud={cloud} username={username} done={close} />}
        </section>
      </div>
    </Dialog>
  );
}

function AgentPicker({ target, cloud, username, done }: { target: Target; cloud: boolean; username: string; done: () => void }) {
  const data = useApp((s) => s.data);
  const owned = (data?.machines || []).filter((m) => m.mine);
  const defaultMachine = owned.find((m) => m.name === data?.machine) || owned[0];
  const [choice, setChoice] = useState(() => defaultMachine ? `machine:${defaultMachine.name}` : "");
  const generic = !target.machine && !cloud;
  const machine = target.machine || (choice.startsWith("machine:") ? choice.slice(8) : defaultMachine?.name);
  const host = owned.find((m) => m.name === machine);
  if (!data) return <p className="muted">Loading machines…</p>;
  if (generic && !owned.length) return <AddMachine username={username} none stayHere />;
  return (
    <>
      {generic && <label className="field">
        <span>Add agent on</span>
        <select value={choice || `machine:${machine}`} onChange={(e) => setChoice(e.target.value)}>
          {owned.map((m) => <option key={m.name} value={`machine:${m.name}`}>{m.name}{m.online === false ? " (offline)" : ""}</option>)}
          <option value="cloud">Cloud</option>
        </select>
      </label>}
      {cloud || choice === "cloud"
        ? <CloudAgents addOnly={!cloud || target.open === "cloud"} username={username} openKind={target.open} machine={target.machine} />
        : host ? <NewAgent key={host.name} machine={host.name} openKind={target.open === "add" ? null : target.open} done={done} />
          : <p className="muted">The machine {machine} is unavailable.</p>}
    </>
  );
}
