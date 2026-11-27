import { Fragment } from "react";
import type { FormEvent } from "react";
import { post } from "../../lib/api.ts";
import { webUrl } from "../../lib/format.ts";
import { toast } from "../../lib/toast.ts";
import { Icon } from "../Icon.tsx";
import { Field, ListOf, githubSignin, reloadConnectors, setConnUi, useConnUi } from "./connectors.tsx";
import type { ConnCtx } from "./connectors.tsx";

// Signing in with GitHub needs agentbook's GitHub App (from the sign-in relay, or one an admin makes here).
// Renders nothing when an app is already configured and healthy; shows an actionable banner when Device Flow needs
// enabling, or a collapsed setup toggle for admins on an isolated server with no app at all.
export function GithubAppBox({ x }: { x: ConnCtx }) {
  const note = useConnUi((s) => s.note);
  const g = x.app;
  if (!g) return null;
  const links = g.app?.links || {};
  if (note && note !== "created")
    return (
      <section className="card box cn-err-box">
        <p className="auth-err">{note}</p>
      </section>
    );
  if (!g.admin) return null;

  if (g.app && (note === "created" || g.app.device_flow === false))
    return (
      <div className="cn-banner">
        <Icon name="alert" />
        <span>
          <b>{note === "created" ? "GitHub App created" : "GitHub App has Device Flow off"}</b>
          {g.app.slug ? (
            <>
              {" "}
              (<code>{g.app.slug}</code>)
            </>
          ) : null}
          : tick <b>Enable Device Flow</b> in its settings on GitHub and save so people can sign in with it here.
        </span>
        <div className="cn-banner-acts">
          {links.settings ? (
            <a className="btn btn--sm btn--dark" href={links.settings} target="_blank" rel="noopener">
              <Icon name="external" />
              Its settings
            </a>
          ) : null}
          {links.install ? (
            <a className="btn btn--sm" href={links.install} target="_blank" rel="noopener">
              <Icon name="external" />
              Install it
            </a>
          ) : null}
          {note === "created" ? (
            <button className="btn btn--sm" type="button" onClick={() => setConnUi({ note: null })}>
              Done
            </button>
          ) : null}
        </div>
      </div>
    );

  if (g.app) return null;

  return (
    <details className="card box cn-gh-setup">
      <summary>
        <b>Set up a GitHub App</b>
        <small>Let everyone here sign in with GitHub instead of pasting personal tokens</small>
      </summary>
      <p className="muted cn-gh-copy">GitHub's creation page opens pre-filled and you confirm it there. agentbook keeps only its client ID, never its private key: the app acts only as each person who signs in.</p>
      <form className="stack conn-form" onSubmit={makeApp}>
        <Field
          name="org"
          label={
            <>
              For an organization <small>its GitHub name, if the app belongs to an org; empty for your own account</small>
            </>
          }
          type="text"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          placeholder="Your own account"
        />
        <p className="auth-err" hidden></p>
        <div className="row-acts">
          <button className="btn btn--dark btn--sm" type="submit">
            Create agentbook's GitHub App
          </button>
        </div>
      </form>
      <details className="gh-own">
        <summary>Or use an app you made yourself</summary>
        <form className="stack conn-form" onSubmit={ownApp}>
          <Field
            name="client_id"
            label={
              <>
                Its client ID <small>on its settings page, not its app ID</small>
              </>
            }
            type="text"
            autoComplete="off"
            spellCheck={false}
            required
          />
          <Field
            name="slug"
            label={
              <>
                Its slug <small>the end of its page's address, github.com/apps/&lt;slug&gt;</small>
              </>
            }
            type="text"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
          />
          <p className="muted">It needs Device Flow on, and to read pull requests, contents, checks and statuses, and to write issues.</p>
          <div className="row-acts">
            <button className="btn btn--line btn--sm" type="submit">
              Use it
            </button>
          </div>
        </form>
      </details>
    </details>
  );
}

// An admin making agentbook's GitHub App: its manifest goes to GitHub in a form, and GitHub takes it from there.
async function makeApp(e: FormEvent<HTMLFormElement>) {
  e.preventDefault();
  const f = new FormData(e.currentTarget);
  const r = await post<{ action: string; manifest: string }>("/api/github/app/manifest", { org: String(f.get("org") || "").trim() || null });
  if (!r.ok) return;
  const out = Object.assign(document.createElement("form"), { method: "post", action: r.data.action });
  out.append(Object.assign(document.createElement("input"), { type: "hidden", name: "manifest", value: r.data.manifest }));
  document.body.append(out);
  out.submit();
}

// Or an app the admin made themselves: its client ID and slug.
async function ownApp(e: FormEvent<HTMLFormElement>) {
  e.preventDefault();
  const f = new FormData(e.currentTarget);
  const r = await post("/api/github/app", { client_id: String(f.get("client_id") || "").trim(), slug: String(f.get("slug") || "").trim() });
  if (r.ok) toast("agentbook signs people in with that app now.");
  reloadConnectors();
}

// Compact inline list of where agentbook's GitHub App is installed, for the GitHub card's structured spec cell.
export function GhInstallsSummary({ x }: { x: ConnCtx }) {
  const g = x.installs;
  if (!g) return <span className="muted">Checking…</span>;
  if (g.error) return <span className="muted">Couldn't check</span>;
  const list = (g.installations || []).map((i, n) => (
    <Fragment key={n}>
      {webUrl(i.url) ? (
        <a href={i.url} target="_blank" rel="noopener" title="Which of its repos agentbook reads, on GitHub">
          {i.account}
        </a>
      ) : (
        i.account
      )}
      {i.all ? "" : <span className="muted"> (some)</span>}
    </Fragment>
  ));
  if (!list.length) return <span className="muted">Not installed on any repo yet</span>;
  return <ListOf items={list} />;
}

// Missing workspace repos that the GitHub App isn't installed on yet, shown as crisp amber alerts on the GitHub card.
export function GhMissingAlerts({ x }: { x: ConnCtx }) {
  const missing = x.installs?.missing || [];
  if (!missing.length) return null;
  return (
    <div className="cn-alerts">
      {missing.map((m, n) => (
        <div className="cn-alert" key={n}>
          <Icon name="alert" />
          <span>
            <b>{m.workspace}</b>: {m.text}
          </span>
          {webUrl(m.url) ? (
            <a href={m.url} target="_blank" rel="noopener">
              {m.label || "Install"} ↗
            </a>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export const ghInstallUrl = (x: ConnCtx) => webUrl(x.installs?.install || x.app?.app?.links?.install);

export function SigninPanel() {
  const g = useConnUi((s) => s.signin);
  if (!g) return null;
  if (g.error)
    return (
      <div className="gh-signin">
        <p className="auth-err">{g.error}</p>
        <div className="row-acts">
          <button className="btn btn--dark btn--sm" type="button" onClick={() => githubSignin(g.form, g.body)}>
            Sign in again
          </button>
          <button className="btn btn--line btn--sm" type="button" onClick={() => setConnUi({ signin: null })}>
            Cancel
          </button>
        </div>
      </div>
    );
  return (
    <div className="gh-signin">
      <p>On GitHub, enter this code:</p>
      <p className="gh-code">
        <code>{g.user_code}</code>
        <button className="icon-btn" type="button" aria-label="Copy the code" title="Copy the code" onClick={() => void navigator.clipboard?.writeText(g.user_code || "").then(() => toast("Copied."), () => {})}>
          <Icon name="copy" />
        </button>
      </p>
      <div className="row-acts">
        <a className="btn btn--dark btn--sm" href={webUrl(g.verification_uri) || "#"} target="_blank" rel="noopener">
          <Icon name="external" />
          Open GitHub
        </a>
        <button className="btn btn--line btn--sm" type="button" onClick={() => setConnUi({ signin: null })}>
          Cancel
        </button>
      </div>
      <p className="muted">Waiting for GitHub… The code lasts {Math.max(1, Math.round((g.until - Date.now()) / 60e3))} minutes.</p>
    </div>
  );
}
