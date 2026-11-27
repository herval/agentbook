// A connector of yours, on Connectors: structured app card with brand mark, live status pill, key-value specs,
// inline warnings/images, and a calm footer bar (primary action on the left, Edit + overflow menu on the right).
import type { ReactNode } from "react";
import { agentName, workspaces } from "../../lib/agents.ts";
import { agoText, listText } from "../../lib/format.ts";
import { machineHref, pageHref } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import type { PageRow } from "../../lib/types.ts";
import type { Widget } from "../../../plugin/shared/types.ts";
import { Icon } from "../Icon.tsx";
import { Menu } from "../Menu.tsx";
import { ImagesList } from "../machines/ImagesList.tsx";
import { GhInstallsSummary, GhMissingAlerts, SigninPanel, ghInstallUrl } from "./GitHubApp.tsx";
import { CATEGORY_TAG, ConnectorBrand, ListOf, SyncBtn, categoryOf, dataOnly, kindOf, kindText, openForm, removeConnector, setConnUi, signin, useConnUi } from "./connectors.tsx";
import type { ConnCtx, ConnSeen } from "./connectors.tsx";

const isDash = (p: PageRow | null | undefined) => p?.kind === "dashboard";
const DASH_PANELS = ["metric", "chart", "table", "list"];
const isPanelOf = (w: Widget | null | undefined) => DASH_PANELS.includes(w?.type) && !!w.query;

function StatusPill({ tone, label }: { tone: "ok" | "warn" | "err" | "idle"; label: string }) {
  return (
    <span className={`cn-st${tone !== "idle" ? ` cn-st--${tone}` : ""}`}>
      <i className={`cn-dot${tone !== "idle" ? ` cn-dot--${tone}` : ""}`} />
      {label}
    </span>
  );
}

function EditBtn({ id }: { id: string }) {
  return (
    <button className="btn btn--sm" type="button" onClick={() => openForm(id)}>
      <Icon name="pencil" />
      Edit
    </button>
  );
}

// Inline confirmation strip shown at the bottom of a card when Remove is picked from its ⋯ menu.
function RemoveConfirm({ id, prompt, note }: { id: string; prompt: string; note?: string }) {
  return (
    <div className="cn-confirm">
      <span>
        <b>{prompt}</b>
        {note ? <small>{note}</small> : null}
      </span>
      <div className="cn-confirm-acts">
        <button className="btn btn--sm btn--red" type="button" onClick={() => removeConnector(id)}>
          Remove
        </button>
        <button className="btn btn--sm" type="button" onClick={() => setConnUi({ removing: null })}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// Task connector card (GitHub, Linear): issues/PRs synced into Tasks, destination, scope, tick behavior.
export function ConnectorCard({ c, x }: { c: ConnSeen; x: ConnCtx }) {
  useApp((s) => s.data);
  const signinHere = useConnUi((s) => s.signin?.form === c.id);
  const removing = useConnUi((s) => s.removing === c.id);
  if (dataOnly(x, c.kind)) return <DataConnectorCard c={c} x={x} />;

  const k = kindOf(x, c.kind);
  const kt = kindText(c.kind);
  const cat = categoryOf(x, c.kind);
  const states = (c.states?.length ? c.states : k?.optional ? [] : k?.default_states || []).map((s) => k?.states?.[s] || s);
  const ws = c.workspace && workspaces().find((w) => w.id === c.workspace || w.name === c.workspace);
  const dest = [ws?.name || c.workspace || "", c.agent ? agentName(c.agent) : ""].filter(Boolean).join(" · ") || "Tasks · Any agent";
  const install = c.kind === "github" && c.via === "app" ? ghInstallUrl(x) : null;
  const canSigninAgain = (k?.signin || (c.kind === "github" && x.app?.app)) && (c.via === "app" || c.error);

  const tone: "ok" | "warn" | "err" | "idle" = c.off ? "idle" : c.error ? "err" : c.syncing ? "warn" : c.synced ? "ok" : "idle";
  const status = c.off ? "Off" : c.syncing ? "Syncing…" : c.error ? "Can't sync" : c.synced ? `Synced ${agoText(c.synced)}` : "Not synced";
  const subtitle = c.who ? `${c.who}${c.kind === "github" && c.via === "app" ? " · GitHub App" : ""}` : c.key_env ? `Key from ${c.key_env}` : k ? "" : `Unknown kind "${c.kind}"`;

  const stateSummary =
    c.kind === "github"
      ? states.length
        ? states.map((s) => (s === "Issues assigned to you" ? "Issues" : s === "Pull requests waiting for your review" ? "PR reviews" : s)).join(", ")
        : "PRs only (no tasks)"
      : states.length
        ? states.join(", ")
        : "All assigned";

  return (
    <article className="card cn-card">
      <div className="cn-card-head">
        <ConnectorBrand kind={c.kind} cat={cat} />
        <div className="cn-card-title">
          <div className="cn-card-title-row">
            <b>{c.name}</b>
            <span className="cn-tag">{CATEGORY_TAG[cat]}</span>
          </div>
          {subtitle ? <span className="cn-card-sub" title={subtitle}>{subtitle}</span> : null}
        </div>
        <StatusPill tone={tone} label={status} />
      </div>

      {c.error ? <p className="auth-err">{c.error}</p> : null}

      <div className="cn-kv">
        <div className="cn-kv-item">
          <span className="cn-kv-k">Syncing to Tasks</span>
          <span className="cn-kv-v">
            {c.count != null && !c.error && (states.length || c.kind !== "github") ? (
              <>
                <b>{c.count} open</b> ·{" "}
              </>
            ) : null}
            {stateSummary}
          </span>
        </div>

        {c.kind === "github" && c.via === "app" ? (
          <div className="cn-kv-item">
            <span className="cn-kv-k">Installed on</span>
            <span className="cn-kv-v">
              <GhInstallsSummary x={x} />
            </span>
          </div>
        ) : (
          <div className="cn-kv-item">
            <span className="cn-kv-k">{c.kind === "github" ? "Repos & orgs" : "Teams"}</span>
            <span className="cn-kv-v">{c.teams?.length ? c.teams.join(", ") : kt.teamsEmpty}</span>
          </div>
        )}

        {states.length || c.kind !== "github" ? (
          <>
            <div className="cn-kv-item">
              <span className="cn-kv-k">Destination</span>
              <span className="cn-kv-v">{dest}</span>
            </div>
            <div className="cn-kv-item">
              <span className="cn-kv-k">On tick</span>
              <span className="cn-kv-v">{c.close ? `Closes issue in ${k?.name || c.kind}` : "Leaves issue open"}</span>
            </div>
          </>
        ) : (
          <div className="cn-kv-item cn-kv-item--wide">
            <span className="cn-kv-k">Pull requests</span>
            <span className="cn-kv-v">Reads your workspaces' pull requests as you</span>
          </div>
        )}
      </div>

      {c.kind === "github" && c.via === "app" ? <GhMissingAlerts x={x} /> : null}
      {signinHere ? <SigninPanel /> : null}

      {removing ? (
        <RemoveConfirm id={c.id} prompt={`Remove ${c.name}?`} note="Its existing tasks stay on your list." />
      ) : (
        <div className="cn-foot">
          <SyncBtn className="btn btn--sm" id={c.id} disabled={c.syncing || c.off}>
            <Icon name="sync" />
            Sync
          </SyncBtn>
          {install ? (
            <a className="btn btn--sm" href={install} target="_blank" rel="noopener" title="On GitHub: install agentbook's GitHub App on an organization or more repos">
              <Icon name="external" />
              Repos
            </a>
          ) : null}
          <div className="cn-foot-r">
            <EditBtn id={c.id} />
            <Menu
              className="cn-more"
              menuClass="fb-menu cn-more-menu"
              label={`More actions for ${c.name}`}
              title="More"
              button={<Icon name="dots" />}
            >
              {(close) => (
                <>
                  {canSigninAgain ? (
                    <button
                      type="button"
                      className="fb-row"
                      onClick={() => {
                        close();
                        signin(c.kind, c.id, { id: c.id });
                      }}
                    >
                      <Icon name="external" />
                      Sign in again
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="fb-row fb-row--warn"
                    onClick={() => {
                      close();
                      removeConnector(c.id);
                    }}
                  >
                    <Icon name="x" />
                    Remove
                  </button>
                </>
              )}
            </Menu>
          </div>
        </div>
      )}
    </article>
  );
}

// Parse Datadog's `who` string ("Name, in Org. The application key ... is scoped to reading (...).") into compact fields.
function parseDataWho(who: string | null | undefined): { account: string; scope: string; perms: string; warning: string | null } {
  if (!who) return { account: "", scope: "Read-only", perms: "", warning: null };
  const dot = who.indexOf(". ");
  const account = dot > 0 ? who.slice(0, dot) : who;
  const rest = dot > 0 ? who.slice(dot + 2) : "";
  const scoped = rest.match(/application key "([^"]+)" is scoped to reading \(([^)]+)\)/);
  if (scoped) return { account, scope: `Read-only · ${scoped[1]}`, perms: scoped[2], warning: null };
  const unscoped = rest.match(/application key "([^"]+)" has no scopes/);
  if (unscoped) return { account, scope: `Unscoped · ${unscoped[1]}`, perms: "agentbook only reads", warning: `Application key "${unscoped[1]}" has no scopes; a read-only key is safer.` };
  if (rest) return { account, scope: "Read-only", perms: "", warning: rest };
  return { account, scope: "Read-only", perms: "", warning: null };
}

export function DataConnectorCard({ c, x }: { c: ConnSeen; x: ConnCtx }) {
  const pages = useApp((s) => s.data?.pages);
  const removing = useConnUi((s) => s.removing === c.id);
  const k = kindOf(x, c.kind);
  if (k?.machines) return <MachinesConnectorCard c={c} x={x} />;

  const site = c.settings?.site;
  const uses = (pages || []).filter((p) => isDash(p) && (p.widgets || []).some((w) => isPanelOf(w) && (w.query.source === c.id || w.query.source === c.kind)));
  const info = parseDataWho(c.who);
  const tone: "ok" | "warn" | "err" | "idle" = c.off ? "idle" : c.error ? "err" : c.syncing ? "warn" : c.who ? "ok" : "idle";
  const status = c.off ? "Off" : c.syncing ? "Checking…" : c.error ? "Can't reach" : c.calls ? `${c.calls}/hr` : c.who ? "Connected" : "Not checked";
  const subtitle = [site, info.account].filter(Boolean).join(" · ");

  return (
    <article className="card cn-card">
      <div className="cn-card-head">
        <ConnectorBrand kind={c.kind} cat="data" />
        <div className="cn-card-title">
          <div className="cn-card-title-row">
            <b>{c.name}</b>
            <span className="cn-tag cn-tag--data">Data</span>
          </div>
          {subtitle ? <span className="cn-card-sub" title={subtitle}>{subtitle}</span> : null}
        </div>
        <StatusPill tone={tone} label={status} />
      </div>

      {c.error ? <p className="auth-err">{c.error}</p> : null}

      <div className="cn-kv">
        <div className="cn-kv-item">
          <span className="cn-kv-k">Key scope</span>
          <span className="cn-kv-v">{info.scope}</span>
        </div>
        <div className="cn-kv-item">
          <span className="cn-kv-k">Permissions</span>
          <span className="cn-kv-v">{info.perms || "Server-side read-only"}</span>
        </div>
        <div className="cn-kv-item cn-kv-item--wide">
          <span className="cn-kv-k">Dashboards{uses.length ? ` (${uses.length})` : ""}</span>
          <span className="cn-kv-v">
            {uses.length ? (
              uses.map((p, i) => (
                <span key={p.id}>
                  {i ? ", " : ""}
                  <a href={pageHref(p)}>{p.title}</a>
                </span>
              ))
            ) : (
              <>
                None yet · <a href="#/dashboards">Ask an agent for one</a>
              </>
            )}
          </span>
        </div>
      </div>

      {info.warning ? (
        <div className="cn-alerts">
          <div className="cn-alert">
            <Icon name="alert" />
            <span>{info.warning}</span>
          </div>
        </div>
      ) : null}

      {removing ? (
        <RemoveConfirm id={c.id} prompt={`Remove ${c.name}?`} note="Dashboards using it will stop answering." />
      ) : (
        <div className="cn-foot">
          <SyncBtn className="btn btn--sm" id={c.id} disabled={c.syncing || c.off}>
            <Icon name="sync" />
            Check keys
          </SyncBtn>
          <div className="cn-foot-r">
            <EditBtn id={c.id} />
            <Menu
              className="cn-more"
              menuClass="fb-menu cn-more-menu"
              label={`More actions for ${c.name}`}
              title="More"
              button={<Icon name="dots" />}
            >
              {(close) => (
                <button
                  type="button"
                  className="fb-row fb-row--warn"
                  onClick={() => {
                    close();
                    removeConnector(c.id);
                  }}
                >
                  <Icon name="x" />
                  Remove
                </button>
              )}
            </Menu>
          </div>
        </div>
      )}
    </article>
  );
}

// What a boat key can't be seen to do, in what that stops (boat.ts's `lacks`: only what reads can be asked about).
const BOAT_STOPS: Record<string, string> = {
  "sandbox.read": "read your sandboxes",
  "snapshot.read": "make a machine from an image",
  "environment.read": "give a machine its secrets",
  "account.read": "show what's left in your wallet",
};

function BoatLacks({ c, scopes }: { c: ConnSeen; scopes: string[] }) {
  const lacks = (c.lacks || []).filter((s) => BOAT_STOPS[s]);
  if (!lacks.length) return null;
  return (
    <div className="cn-alerts">
      <div className="cn-alert cn-alert--block">
        <Icon name="alert" />
        <span>
          Key lacks <ListOf items={lacks.map((s) => <code key={s}>{s}</code>)} />, so agentbook can't {listText(lacks.map((s) => BOAT_STOPS[s]))}. Create a full key with{" "}
          <code>boat api-key create agentbook --actions {scopes.join(",")}</code> and paste it under Edit.
        </span>
      </div>
    </div>
  );
}

export function MachinesConnectorCard({ c, x }: { c: ConnSeen; x: ConnCtx }) {
  const machines = useApp((s) => s.data?.machines);
  const exe = c.kind === "exe";
  const where = exe ? "exe.dev" : "boat";
  const removing = useConnUi((s) => s.removing === c.id);
  const wakes = (machines || []).filter((m) => m.mine && m.cloud?.connector === c.id);
  const mine = (machines || []).filter((m) => m.mine && !m.here);
  const st = c.settings || {};
  const wallet = !st.org || String(st.org).toLowerCase() === "personal" ? "personal wallet" : `${st.org}'s wallet`;
  const tone: "ok" | "warn" | "err" | "idle" = c.off ? "idle" : c.error ? "err" : c.syncing ? "warn" : c.who ? "ok" : "idle";
  const status = c.off ? "Off" : c.syncing ? "Checking…" : c.error ? "Can't reach" : wakes.length ? `${wakes.length} ${wakes.length === 1 ? "machine" : "machines"}` : c.who ? "Connected" : "Not checked";
  // exe.dev bills a pool by the month: there's no wallet to name.
  const subtitle = [c.who && c.who !== where ? c.who : "", exe ? "" : wallet].filter(Boolean).join(" · ");
  const made = wakes.filter((m) => m.cloud.made).length;

  const commas = (list: { name: string }[]): ReactNode =>
    list.map((m, i) => (
      <span key={m.name}>
        {i ? ", " : ""}
        <a href={machineHref(m.name)}>{m.name}</a>
      </span>
    ));

  return (
    <article className="card cn-card">
      <div className="cn-card-head">
        <ConnectorBrand kind={c.kind} cat="cloud" />
        <div className="cn-card-title">
          <div className="cn-card-title-row">
            <b>{c.name}</b>
            <span className="cn-tag cn-tag--cloud">Cloud</span>
          </div>
          {subtitle ? <span className="cn-card-sub" title={subtitle}>{subtitle}</span> : null}
        </div>
        <StatusPill tone={tone} label={status} />
      </div>

      {c.error ? <p className="auth-err">{c.error}</p> : null}

      <div className="cn-kv">
        <div className="cn-kv-item">
          <span className="cn-kv-k">Wakes machines</span>
          <span className="cn-kv-v">
            {wakes.length ? (
              commas(wakes)
            ) : (
              <>
                None yet
                {c.off ? null : (
                  <>
                    {" "}
                    · <a href="#/workspaces/new?cloud=">Make one</a>
                  </>
                )}
                {mine.length ? <> or link {commas(mine.slice(0, 3))}</> : null}
              </>
            )}
          </span>
        </div>

        {exe ? null : (
          <div className="cn-kv-item">
            <span className="cn-kv-k">Defaults</span>
            <span className="cn-kv-v">
              {st.size || "default"} · {st.idle || "15"}m idle / {st.busy || "8"}h max
            </span>
          </div>
        )}

        {c.off || exe ? null : <ImagesList connector={c.id} />}
      </div>

      {exe ? null : <BoatLacks c={c} scopes={kindOf(x, "boat")?.scopes || []} />}

      {removing ? (
        <div className="cn-confirm cn-confirm--col">
          <span>
            <b>Remove {c.name}?</b>
            {wakes.length ? <small>Choose what happens to {wakes.length === 1 ? "its machine" : `its ${wakes.length} machines`} on {where}.</small> : null}
          </span>
          <div className="cn-confirm-acts">
            {!wakes.length ? (
              <button className="btn btn--sm btn--red" type="button" onClick={() => removeConnector(c.id)}>
                Remove
              </button>
            ) : (
              <>
                {made ? (
                  <button className="btn btn--sm btn--red" type="button" onClick={() => removeConnector(c.id, "delete", where)}>
                    Delete {made === 1 ? "machine" : `${made} machines`} on {where}
                  </button>
                ) : null}
                <button className="btn btn--sm btn--dark" type="button" onClick={() => removeConnector(c.id, "leave", where)}>
                  Leave {wakes.length === 1 ? "machine" : "machines"} unmanaged
                </button>
              </>
            )}
            <button className="btn btn--sm" type="button" onClick={() => setConnUi({ removing: null })}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="cn-foot">
          {c.off ? null : (
            <a className="btn btn--sm btn--dark" href="#/workspaces/new?cloud=">
              <Icon name="plus" />
              New machine
            </a>
          )}
          <SyncBtn className="btn btn--sm" id={c.id} disabled={c.syncing || c.off}>
            <Icon name="sync" />
            Check key
          </SyncBtn>
          <div className="cn-foot-r">
            <EditBtn id={c.id} />
            <Menu
              className="cn-more"
              menuClass="fb-menu cn-more-menu"
              label={`More actions for ${c.name}`}
              title="More"
              button={<Icon name="dots" />}
            >
              {(close) => (
                <button
                  type="button"
                  className="fb-row fb-row--warn"
                  onClick={() => {
                    close();
                    removeConnector(c.id);
                  }}
                >
                  <Icon name="x" />
                  Remove
                </button>
              )}
            </Menu>
          </div>
        </div>
      )}
    </article>
  );
}
