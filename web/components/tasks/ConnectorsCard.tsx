import { useApp } from "../../lib/store.ts";
import { Icon } from "../Icon.tsx";
import { SyncBtn } from "./connectors.tsx";
import type { ConnSeen } from "./connectors.tsx";
import { agoText } from "../../lib/format.ts";

// Beside the Tasks page: where its tasks come from, when each last synced, and a button to sync it now.
export function ConnectorsCard() {
  const connectors = useApp((s) => s.data?.connectors) as ConnSeen[] | undefined;
  const on = (connectors || []).filter((c) => !c.off);
  if (!on.length) return null;
  return (
    <section className="card rail-card conn-rail">
      <h3 className="rail-h">Connectors</h3>
      {on.map((c) => (
        <ConnLine key={c.id} c={c} />
      ))}
    </section>
  );
}
function ConnLine({ c }: { c: ConnSeen }) {
  const how = c.syncing ? "Syncing…" : c.error ? <span className="task-err">{c.error}</span> : c.synced ? `Synced ${agoText(c.synced)}` : "Not synced yet";
  return (
    <div className="conn-line">
      <span className="ico">
        <Icon name="plug" />
      </span>
      <span>
        <b>{c.name}</b>
        <small>{how}</small>
      </span>
      <SyncBtn className="icon-btn" id={c.id} disabled={c.syncing} title="Sync now" aria-label={`Sync ${c.name} now`}>
        <Icon name="sync" />
      </SyncBtn>
    </div>
  );
}
