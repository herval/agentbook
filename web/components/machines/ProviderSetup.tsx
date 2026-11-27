import { useState } from "react";
import type { FormEvent } from "react";
import { PROVIDERS, isProviderRuntime } from "../../../plugin/shared/runtime-providers.ts";
import type { RuntimeRow } from "../../lib/types.ts";
import { post } from "../../lib/api.ts";

export function ProviderSetup({ runtime, machine, offline, load }: { runtime: RuntimeRow; machine: string; offline: boolean; load: () => Promise<void> }) {
  const options = isProviderRuntime(runtime.kind) ? PROVIDERS[runtime.kind] : [];
  const saved = runtime.provider;
  const [provider, setProvider] = useState(saved?.provider || options[0]?.id || "");
  const [model, setModel] = useState(saved?.model || options[0]?.model || "");
  const [endpoint, setEndpoint] = useState(saved?.endpoint || "");
  const [key, setKey] = useState("");
  const [code, setCode] = useState("");
  const [url, setUrl] = useState("");
  const [userCode, setUserCode] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const option = options.find((p) => p.id === provider);
  const keySaved = provider === saved?.provider && saved?.keySaved;
  const query = `?machine=${encodeURIComponent(machine)}`;
  async function save(e: FormEvent) {
    e.preventDefault(); setBusy("save"); setError(""); setDone("");
    try {
      const r = await post(`/api/runtimes/configure${query}`, { kind: runtime.kind, provider, key, ...(!option?.ownModels ? { model } : {}), ...(option?.endpoint ? { endpoint } : {}) });
      if (r.ok) { setKey(""); setDone("Provider saved. New threads use this setup."); await load(); }
      else setError(r.data.error || "Couldn't save provider setup.");
    } catch (e) { setError(e.message); }
    finally { setBusy(""); }
  }
  async function login(step: "start" | "code" | "check" | "cancel") {
    setBusy(step); setError(""); setDone("");
    try {
      const r = await post<{ url?: string; user_code?: string; configured?: boolean; ended?: boolean }>(`/api/runtimes/login${query}`, { kind: runtime.kind, step, ...(step === "code" ? { code } : {}) });
      if (r.ok) {
        setCode(""); setUrl(r.data.url || ""); setUserCode(r.data.user_code || "");
        if (r.data.configured) { setDone(`${option?.name || "The account"} is signed in on ${machine}.`); await load(); }
      } else { setError(r.data.error || "Couldn't sign in."); if (r.data.ended) { setUrl(""); setUserCode(""); setCode(""); } }
    } catch (e) { setError(e.message); }
    finally { setBusy(""); }
  }
  const again = saved?.provider === provider;
  return <div className="provider-setup">
    <p><b>Provider setup</b></p>
    {saved?.configured && <p className="muted small">Saved on {machine}: {options.find((p) => p.id === saved.provider)?.name || saved.provider}{saved.model ? ` · ${saved.model}` : ""}.</p>}
    <label className="field"><span>Provider</span><select aria-label="Provider" value={provider} disabled={!!busy || !!url || offline} onChange={(e) => {
      const next = options.find((p) => p.id === e.target.value);
      setProvider(next.id); setModel(saved?.provider === next.id ? saved.model || next.model || "" : next.model || ""); setEndpoint(saved?.provider === next.id ? saved.endpoint || "" : ""); setKey(""); setError(""); setDone("");
    }}>{options.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    {option?.signIn === "device" ? <div>
      {url ? <>
        <p>Open x.ai, sign in, and confirm the code <b>{userCode}</b>. Then come back here.</p>
        <a className="btn btn--dark" href={url} target="_blank" rel="noopener noreferrer">Open x.ai</a>
        <div className="actions"><button className="btn btn--dark" type="button" disabled={!!busy || offline} onClick={() => void login("check")}>{busy === "check" ? "Checking…" : "I've confirmed it"}</button><button className="btn btn--line" type="button" disabled={!!busy || offline} onClick={() => void login("cancel")}>Cancel</button></div>
      </> : <button className="btn btn--dark" type="button" disabled={!!busy || offline} onClick={() => void login("start")}>{busy ? "Starting sign-in…" : again ? `Sign in to ${option.name} again` : `Sign in with ${option.name}`}</button>}
    </div> : option?.signIn === "code" ? <div>
      {url ? <>
        <p>Open Google, sign in, then paste the authorization code or the final redirect URL here.</p>
        <a className="btn btn--dark" href={url} target="_blank" rel="noopener noreferrer">Open Google sign-in</a>
        <form onSubmit={(e) => { e.preventDefault(); void login("code"); }}>
          <label className="field"><span>Authorization code or redirect URL</span><input type="password" name="code" value={code} autoComplete="off" spellCheck={false} required maxLength={4000} disabled={!!busy || offline} onChange={(e) => setCode(e.target.value)} /></label>
          <div className="actions"><button className="btn btn--dark" disabled={!!busy || offline}>{busy === "code" ? "Signing in…" : "Finish sign-in"}</button><button className="btn btn--line" type="button" disabled={!!busy || offline} onClick={() => void login("cancel")}>Cancel</button></div>
        </form>
      </> : <button className="btn btn--dark" type="button" disabled={!!busy || offline} onClick={() => void login("start")}>{busy ? "Starting sign-in…" : again ? "Check Google sign-in" : "Sign in with Google"}</button>}
    </div> : <form onSubmit={save}>
      {!option?.ownModels && <label className="field"><span>Model ID</span><input name="model" value={model} placeholder="Provider's model ID" required maxLength={300} disabled={!!busy || offline} onChange={(e) => setModel(e.target.value)} /></label>}
      {option?.endpoint && <label className="field"><span>API endpoint</span><input name="endpoint" type="url" value={endpoint} placeholder="https://example.com/v1" required maxLength={2000} disabled={!!busy || offline} onChange={(e) => setEndpoint(e.target.value)} /></label>}
      <label className="field"><span>API key{keySaved && <small> · saved on {machine}</small>}</span><input name="key" type="password" value={key} autoComplete="new-password" spellCheck={false} placeholder={keySaved ? "Leave blank to keep the saved key" : "Paste your provider's API key"} required={!keySaved} maxLength={8000} disabled={!!busy || offline} onChange={(e) => setKey(e.target.value)} /></label>
      <button className="btn btn--dark" disabled={!!busy || offline}>{busy ? "Saving…" : "Save provider"}</button>
    </form>}
    {(error || saved?.error) && <p className="auth-err" role="alert">{error || saved.error}</p>}
    {done && <p role="status">{done}</p>}
    <p className="muted small">Credentials stay on {machine}. Existing native setup still works until you save a provider here. Changes require this runtime's active threads to finish first.</p>
    {offline && <p className="muted">{machine} is off. Set it up once it is back.</p>}
  </div>;
}
