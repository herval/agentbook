// Connectors panel, embedded inside your profile's Settings (#/people/<you>/settings/connectors).
// Legacy #/connectors links redirect straight into your profile's Settings › Connectors.
import { useEffect, useState } from "react";
import { useLoad } from "../../lib/hooks.ts";
import type { Loaded } from "../../lib/hooks.ts";
import { personHref } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import type { ConnectorsView, GhApp, GhInstalls } from "../../lib/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { ConnectorCard } from "../../components/tasks/ConnectorCard.tsx";
import { ConnectorForm } from "../../components/tasks/ConnectorForm.tsx";
import { GithubAppBox } from "../../components/tasks/GitHubApp.tsx";
import { toast } from "../../lib/toast.ts";
import { CATEGORY_LABELS, CATEGORY_TAG, ConnectorBrand, KIND_ABOUT, categoryOf, openForm, setConnUi, useConnUi } from "../../components/tasks/connectors.tsx";
import type { ConnCtx, ConnSeen, ConnectorCategory } from "../../components/tasks/connectors.tsx";

const CAT_ORDER: ConnectorCategory[] = ["tasks", "data", "cloud"];

function failedOf(L: Loaded<ConnectorsView>): string | null {
  if (L.missing) return "agentbook's server is older than this page and has no connectors yet. Restart it, then reload this page.";
  if (!L.error) return null;
  if (L.error === "Couldn't reach agentbook.") return "agentbook can't be reached. Reload the page to try again.";
  const http = L.error.match(/^Couldn't get it \(HTTP (\d+)\)$/);
  return http ? `agentbook couldn't list your connectors (HTTP ${http[1]}).` : L.error;
}

// Legacy route (#/connectors): send straight to #/people/<you>/settings/connectors inside your profile.
export function Connectors() {
  const me = useApp((s) => s.me?.username);
  useEffect(() => {
    if (me) location.replace(personHref(me, "settings/connectors"));
  }, [me]);
  if (me) return null;
  return (
    <div className="person-page">
      <ConnectorsPanel />
    </div>
  );
}

export function ConnectorsPanel() {
  const seen = useApp((s) => s.data?.connectors);
  const seq = useConnUi((s) => s.seq);
  const edit = useConnUi((s) => s.edit);
  const [cat, setCat] = useState<"all" | ConnectorCategory>("all");

  const again = [seen || [], seq];
  const L = useLoad<ConnectorsView>("/api/connectors", again);
  const A = useLoad<GhApp>("/api/github/app", again);
  // Back from signing in with Linear: what came of it.
  const N = useLoad<{ note?: string | null }>("/api/linear/note");
  const viaApp = !!L.data?.connectors?.some((c) => c.kind === "github" && c.via === "app");
  const I = useLoad<GhInstalls>(viaApp ? "/api/github/installations" : null, again);

  useEffect(() => {
    if (A.data?.note) setConnUi({ note: A.data.note });
  }, [A.data]);
  useEffect(() => {
    if (N.data?.note) toast(N.data.note);
  }, [N.data]);

  const d = L.data;
  const failed = failedOf(L);
  const ready = (d || failed) && (A.data || A.error || A.missing || !A.loading);
  const x: ConnCtx = {
    kinds: d?.kinds || [],
    app: A.data || null,
    installs: viaApp ? I.data || (I.error || I.missing ? { error: "agentbook couldn't ask GitHub where it's installed." } : null) : null,
  };
  const conns = (d?.connectors || []) as ConnSeen[];
  const connectedKinds = new Set(conns.map((c) => c.kind));

  const counts = {
    tasks: conns.filter((c) => categoryOf(x, c.kind) === "tasks").length,
    data: conns.filter((c) => categoryOf(x, c.kind) === "data").length,
    cloud: conns.filter((c) => categoryOf(x, c.kind) === "cloud").length,
  };
  const activeCats = CAT_ORDER.filter((k) => counts[k] > 0);
  const pickedCat = cat !== "all" && counts[cat] > 0 ? cat : "all";
  const shown = pickedCat === "all" ? conns : conns.filter((c) => categoryOf(x, c.kind) === pickedCat);

  return (
    <div className="cn-panel">
      <div className="cn-head">
        <h2 className="page-h">Connectors</h2>
        {ready && !failed ? <span className="page-sub">{conns.length ? `${conns.length} connected` : "None connected yet"}</span> : null}
        <span className="cn-priv">
          <Icon name="lock" />
          Private to you · keys encrypted on server
        </span>
      </div>

      {!ready ? (
        <p className="muted">Loading…</p>
      ) : failed ? (
        <section className="card box">
          <p className="auth-err">{failed}</p>
        </section>
      ) : (
        <>
          {d.error ? (
            <section className="card box cn-err-box">
              <p className="auth-err">{d.error}</p>
            </section>
          ) : null}

          <GithubAppBox x={x} />

          {conns.length ? (
            <>
              {activeCats.length > 1 ? (
                <div className="cn-bar">
                  <div className="cn-pills" role="tablist" aria-label="Filter connectors by category">
                    <button type="button" role="tab" aria-selected={pickedCat === "all"} className={pickedCat === "all" ? "is-on" : ""} onClick={() => setCat("all")}>
                      All <span className="n">{conns.length}</span>
                    </button>
                    {activeCats.map((k) => (
                      <button key={k} type="button" role="tab" aria-selected={pickedCat === k} className={pickedCat === k ? "is-on" : ""} onClick={() => setCat(k)}>
                        {CATEGORY_LABELS[k]} <span className="n">{counts[k]}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="cn-grid">
                {shown.map((c) => (edit === c.id ? <ConnectorForm key={`f-${c.id}`} c={c} x={x} /> : <ConnectorCard key={`c-${c.id}`} c={c} x={x} />))}
              </div>
            </>
          ) : (
            <p className="cn-empty-lede">
              <Icon name="lock" />
              Connect the tools you work in to sync tasks, power read-only dashboards, or wake cloud machines. Keys stay encrypted on agentbook-server and are private to you.
            </p>
          )}

          {edit?.startsWith("new:") ? (
            <div className="cn-new-form">
              <ConnectorForm key={edit} c={{ kind: edit.slice(4) }} x={x} />
            </div>
          ) : null}

          <div className="cn-cat-head" id="connectors-catalog">
            <h3>{conns.length ? "Available connectors" : "Add a connector"}</h3>
            <span>{conns.length ? "Add another account or workspace" : "Pick a tool to connect"}</span>
          </div>

          <div className="cn-cat">
            {x.kinds.map((k) => {
              const catOfKind = categoryOf(x, k.kind);
              const isConnected = connectedKinds.has(k.kind);
              return (
                <div className="card cn-cat-tile" key={k.kind}>
                  <div className="cn-cat-tile-top">
                    <ConnectorBrand kind={k.kind} cat={catOfKind} size="sm" />
                    <b>{k.name}</b>
                    <span className={`cn-tag${catOfKind !== "tasks" ? ` cn-tag--${catOfKind}` : ""}`}>{CATEGORY_TAG[catOfKind]}</span>
                  </div>
                  <p>{KIND_ABOUT[k.kind] || k.about || ""}</p>
                  <div className="cn-cat-tile-foot">
                    {isConnected ? (
                      <>
                        <span className="cn-done-mark">
                          <Icon name="check" />
                          Connected
                        </span>
                        <button className="btn btn--sm" type="button" onClick={() => openForm(`new:${k.kind}`)}>
                          + Another
                        </button>
                      </>
                    ) : (
                      <button className="btn btn--sm btn--dark" type="button" onClick={() => openForm(`new:${k.kind}`)}>
                        Connect
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
