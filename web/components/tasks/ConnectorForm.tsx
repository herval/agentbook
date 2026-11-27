// Setting a connector up, or changing it, on Connectors: a task connector's key, which of its work comes in and from
// where, and what their tasks are for (with Sign in with Linear, and Sign in with GitHub when there's agentbook's
// GitHub App); a Data or machines connector's keys and settings. It posts to /api/connectors itself, so what's wrong
// shows in the form.
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { agentName, workspaces } from "../../lib/agents.ts";
import { signedOut } from "../../lib/session.ts";
import { useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import { Icon } from "../Icon.tsx";
import { SigninPanel, ghInstallUrl } from "./GitHubApp.tsx";
import { ConnectorBrand, Field, categoryOf, closeForm, dataOnly, kindOf, kindText, reloadConnectors, secretLabel, setConnUi, signin as startSignin, taskAgents, useConnUi } from "./connectors.tsx";
import type { ConnCtx, ConnSeen } from "./connectors.tsx";

// What a connector's form sends (POST /api/connectors): a Data connector's settings and keys, by name; a task
// connector's states, teams, workspace, agent and whether to close; its key and name; and its kind (a new one) or id.
interface ConnectorFormBody {
  settings?: Record<string, string>;
  states?: FormDataEntryValue[];
  teams?: string;
  workspace?: FormDataEntryValue | null;
  agent?: FormDataEntryValue | null;
  close?: boolean;
  api_key?: string;
  name?: string;
  kind?: string;
  id?: string;
  [key: string]: unknown;
}
// The connector a form is for: one set up (with its id), or a new one of a kind.
type FormFor = Partial<ConnSeen> & { kind: string };

// What both forms do: send what's in them, saying in the form what's wrong, or start a sign-in instead (`signin`: its
// button is the form's). Done, the form closes, a toast says what came of it, and the list comes again.
function useSubmit(c: FormFor, x: ConnCtx, signin: boolean) {
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const which = c.id || `new:${c.kind}`;
  const kind = c.kind;
  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    // A Data connector (Datadog): its keys and its settings, nothing about tasks.
    const isData = dataOnly(x, kind);
    const body: ConnectorFormBody = isData
      ? { settings: Object.fromEntries([...f.entries()].filter(([k]) => k.startsWith("setting:")).map(([k, v]) => [k.slice(8), String(v)])) }
      : { states: f.getAll("states"), teams: String(f.get("teams") || ""), workspace: f.get("workspace") || null, agent: f.get("agent") || null, close: f.get("close") === "on" };
    if (isData) for (const name of Object.keys(kindOf(x, kind).secrets || {})) if (String(f.get(name) || "").trim()) body[name] = String(f.get(name)).trim();
    if (!isData && !body.states.length && !kindOf(x, kind)?.optional) return setErr("Pick at least one kind of issue.");
    if (String(f.get("api_key") || "").trim()) body.api_key = String(f.get("api_key")).trim();
    if (f.get("name")) body.name = String(f.get("name")).trim();
    if (which.startsWith("new:")) body.kind = which.slice(4);
    else body.id = which;
    // Signing in: the same settings, and Linear's page or a code to enter on GitHub rather than a key.
    if (signin) {
      delete body.kind;
      return startSignin(kind, which, body);
    }
    setBusy(true);
    setErr("");
    const res = await fetch("/api/connectors", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data: { error?: string; connector?: { name?: string; who?: string } } = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.status === 401) return signedOut();
    if (!res.ok) return setErr(data.error || `Something went wrong (HTTP ${res.status})`);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setConnUi({ edit: null });
    toast(
      body.id
        ? "Saved."
        : isData
          ? `Connected ${data.connector?.name || kindOf(x, kind).name}${data.connector?.who ? `: ${data.connector.who}` : ""}`
          : kind === "github"
            ? `Connected ${data.connector.name}${data.connector.who ? `, as ${data.connector.who}` : ""}. ${body.states.length ? "What's yours there is on its way to your Tasks, and" : "From now on"} your workspaces' pull requests are read as you.`
            : `Connected ${data.connector.name}. Its issues are on their way to your Tasks.`,
    );
    reloadConnectors();
  };
  return { err, busy, onSubmit };
}
// The form's first box has the cursor as it opens, as it had after Connect or Edit.
function useFocusFirst() {
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    ref.current?.querySelector("input")?.focus();
  }, []);
  return ref;
}

export function ConnectorForm({ c, x }: { c: FormFor; x: ConnCtx }) {
  useApp((s) => s.data);
  const token = useConnUi((s) => s.token);
  const which = c.id || `new:${c.kind}`;
  const signingIn = useConnUi((s) => s.signin?.form === which);
  const k = kindOf(x, c.kind);
  const editing = !!c.id;
  // Linear, and GitHub with agentbook's GitHub App: Sign in with it, unless they'd rather paste a key.
  const canSignin = !!k?.signin || (c.kind === "github" && !!x.app?.app);
  const signin = canSignin && !token && !editing;
  const { err, busy, onSubmit } = useSubmit(c, x, signin && !signingIn);
  const ref = useFocusFirst();
  if (!k) return null;
  if (dataOnly(x, c.kind)) return <DataConnectorForm c={c} x={x} />;
  const kt = kindText(c.kind);
  // A new one starts with the default picks; one being changed has its own, which for GitHub may be none.
  const states = editing && k.optional ? c.states || [] : c.states?.length ? c.states : k.default_states || [];
  const ws = c.workspace ? workspaces().find((w) => w.id === c.workspace || w.name === c.workspace)?.id || "" : "";
  const aKey = c.kind === "github" ? "a token" : "an API key";
  const keyHelp = editing ? (c.locked ? "the one it has can't be read here: paste it again" : c.key_env ? `from ${c.key_env}; paste one to use it instead` : c.via === "app" ? `signed in with ${k?.name}; paste ${aKey} to use it instead` : "leave it empty to keep the one it has") : kt.keyHelp;
  const toggleToken = () => setConnUi((s) => ({ token: !s.token }));
  const noApp =
    c.kind === "github" && !x.app?.app ? (
      <p className="muted">{x.app?.admin ? "Or make agentbook's GitHub App (above), and everyone here signs in with GitHub instead." : "Signing in with GitHub instead needs agentbook's GitHub App, which an admin here sets up on this page."}</p>
    ) : null;
  // Signed in with GitHub, the repos and organizations named here only narrow where agentbook's GitHub App is installed.
  const install = c.kind === "github" && c.via === "app" ? ghInstallUrl(x) : null;
  return (
    <section className="card box conn-card cn-form-card">
      <div className="cn-form-head">
        <ConnectorBrand kind={c.kind} cat={categoryOf(x, c.kind)} />
        <h2 className="page-h">{editing ? `Edit ${c.name}` : `Connect ${k.name}`}</h2>
      </div>
      <form className="stack conn-form" ref={ref} onSubmit={onSubmit}>
        {signin ? null : (
          <>
            <Field
              name="api_key"
              label={
                <>
                  {kt.key} <small>{keyHelp}</small>
                </>
              }
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={editing ? "Keep the one it has" : kt.placeholder}
              required={!editing}
            />
            {noApp}
          </>
        )}
        <fieldset className="field conn-states">
          <legend>{kt.what}</legend>
          <div className="conn-checks">
            {Object.entries(k.states || {}).map(([v, label]) => (
              <label key={v}>
                <input type="checkbox" name="states" value={v} defaultChecked={states.includes(v)} />
                {label}
              </label>
            ))}
          </div>
          {k.optional ? <small className="muted">None of them: nothing comes into your Tasks, and it's only how agentbook reads GitHub as you.</small> : null}
        </fieldset>
        <Field name="teams" label={kt.teams} type="text" defaultValue={(c.teams || []).join(", ")} autoCapitalize={kt.upper ? "characters" : "off"} autoComplete="off" spellCheck={false} placeholder={kt.teamsEmpty} />
        {install ? (
          <small className="conn-hint">
            Signed in with GitHub, it reads only the repos agentbook's GitHub App is installed on:{" "}
            <a href={install} target="_blank" rel="noopener">
              add repos or organizations
            </a>{" "}
            on GitHub.
          </small>
        ) : null}
        <div className="conn-for">
          <label className="field">
            <span>Their tasks are in</span>
            <select name="workspace" defaultValue={ws}>
              <option value="">No workspace</option>
              {workspaces().map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>For</span>
            <select name="agent" defaultValue={c.agent || ""}>
              <option value="">Any agent</option>
              {taskAgents(c.agent).map((a) => (
                <option key={a.id} value={a.id}>
                  {agentName(a.id)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="switch">
          <input type="checkbox" name="close" role="switch" defaultChecked={c.close !== false} />
          <span className="track" aria-hidden="true"></span>
          <span>
            <b>{kt.closeOn[0]}</b>
            <small>{kt.closeOn[1]}</small>
          </span>
        </label>
        {editing ? <Field name="name" label="Name" type="text" defaultValue={c.name} maxLength={60} autoComplete="off" /> : null}
        <p className="auth-err" hidden={!err}>
          {err}
        </p>
        {signingIn ? (
          <SigninPanel />
        ) : (
          <div className="row-acts">
            {signin ? (
              <>
                <button className="btn btn--dark" type="submit">
                  <Icon name="external" />
                  Sign in with {k.name}
                </button>
                <button className="link-btn" type="button" onClick={toggleToken}>
                  or paste {aKey}
                </button>
              </>
            ) : (
              <>
                <button className="btn btn--dark" type="submit" disabled={busy}>
                  {editing ? "Save" : "Connect"}
                </button>
                {canSignin && !editing ? (
                  <button className="link-btn" type="button" onClick={toggleToken}>
                    or sign in with {k.name}
                  </button>
                ) : null}
              </>
            )}
            <button className="btn btn--line" type="button" onClick={closeForm}>
              Cancel
            </button>
          </div>
        )}
      </form>
    </section>
  );
}

// A Data connector's form (Datadog), or a machines one's (boat): its key and secrets, and its settings, each one of a
// few (`of`, with its unit, like "15 minutes") or words of yours (a wallet's name).
export function DataConnectorForm({ c, x }: { c: FormFor; x: ConnCtx }) {
  const { err, busy, onSubmit } = useSubmit(c, x, false);
  const ref = useFocusFirst();
  const k = kindOf(x, c.kind);
  if (!k) return null;
  const editing = !!c.id;
  const keep = editing ? "leave it empty to keep the one it has" : "";
  return (
    <section className="card box conn-card cn-form-card">
      <div className="cn-form-head">
        <ConnectorBrand kind={c.kind} cat={categoryOf(x, c.kind)} />
        <h2 className="page-h">{editing ? `Edit ${c.name}` : `Connect ${k.name}`}</h2>
      </div>
      {k.about ? <p className="muted">{k.about}</p> : null}
      <form className="stack conn-form" ref={ref} onSubmit={onSubmit}>
        <Field
          name="api_key"
          label={
            <>
              Its {k.key || "API key"}{" "}
              <small>
                {keep ||
                  (c.kind === "datadog" ? (
                    "in Datadog: Organization Settings › API Keys"
                  ) : c.kind === "exe" ? (
                    <>
                      from <code>ssh exe.dev ssh-key generate-api-key --label=agentbook --cmds={(k.scopes || []).join(",")}</code>
                    </>
                  ) : (
                    ""
                  ))}
              </small>
            </>
          }
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={editing ? "Keep the one it has" : ""}
          required={!editing}
        />
        {Object.entries(k.secrets || {}).map(([name, label]) => (
          <Field
            key={name}
            name={name}
            label={
              <>
                Its {secretLabel(label, name)} <small>{keep || (c.kind === "datadog" ? "in Datadog: Organization Settings › Application Keys; give it read scopes only" : "")}</small>
              </>
            }
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={editing ? "Keep the one it has" : ""}
            required={!editing}
          />
        ))}
        {Object.entries(k.fields || {}).map(([name, f]) =>
          f.of ? (
            <label key={name} className="field">
              <span>{f.label || name}</span>
              <select name={`setting:${name}`} defaultValue={c.settings?.[name] ?? f.default}>
                {f.of.map((o) => (
                  <option key={o} value={o}>
                    {f.unit ? `${o} ${f.unit}` : o}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <Field
              key={name}
              name={`setting:${name}`}
              label={
                <>
                  {f.label || name}
                  {f.hint ? (
                    <>
                      {" "}
                      <small>{f.hint}</small>
                    </>
                  ) : null}
                </>
              }
              type="text"
              defaultValue={c.settings?.[name] ?? f.default ?? ""}
              maxLength={200}
              autoComplete="off"
              spellCheck={false}
            />
          ),
        )}
        <p className="muted">{k.machines ? "agentbook checks the key before it keeps it. It's kept encrypted on agentbook-server, and never reaches a page, an agent or a sandbox." : "agentbook checks the keys before it keeps them: a key that can write is turned down. They're kept encrypted on agentbook-server, and never reach a page or an agent: agents get answers."}</p>
        {editing ? <Field name="name" label="Name" type="text" defaultValue={c.name} maxLength={60} autoComplete="off" /> : null}
        <p className="auth-err" hidden={!err}>
          {err}
        </p>
        <div className="row-acts">
          <button className="btn btn--dark" type="submit" disabled={busy}>
            {editing ? "Save" : "Connect"}
          </button>
          <button className="btn btn--line" type="button" onClick={closeForm}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
