// Add a workspace, In the cloud: a machine on your boat account, from an image of yours, with a repo to start in; or
// a VM on your exe.dev account, which installs agentbook and joins your account through the relay (ExeForm).
// What's typed so far stays in this tab's memory (secrets' values too) until the machine is made, wherever In the
// cloud shows: Add a workspace's page or its box.
import { create } from "zustand";
import { post } from "../../lib/api.ts";
import { useLoad } from "../../lib/hooks.ts";
import { askedOf, cloudHow, cloudName, cloudNameOf, sizeFace } from "../../lib/images.ts";
import type { BoatChoice, CloudFormState } from "../../lib/images.ts";
import { connectorsHref, go } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { ImagesView } from "../../lib/types.ts";
import { Icon } from "../Icon.tsx";
import { Opt } from "./Opt.tsx";

const useCloudForm = create<{ form: CloudFormState | null }>(() => ({ form: null }));
const blank = (image: string): CloudFormState => ({ connector: "", image, size: "", repo: "", name: "", secrets: {}, busy: false, error: null });

// `image`: the image to start from, from an image's New machine from it. `repos`: your repos on GitHub (owner/repo),
// offered as you type. A dialog supplies onMade to handle completion on its own page.
export function CloudForm({ image = "", repos = [], onMade }: { image?: string; repos?: string[]; onMade?: () => void }) {
  const data = useApp((s) => s.data);
  const L = useLoad<ImagesView>("/api/images", data?.images || []);
  const f = useCloudForm((s) => s.form) || blank(image);
  const setForm = (x: Partial<CloudFormState>) => useCloudForm.setState((s) => ({ form: { ...(s.form || f), ...x } }));
  const d = L.data;
  const failed = L.error && !d ? L.error : null;
  const boat: BoatChoice[] = d?.boat || (data?.connectors || []).filter((c) => c.kind === "boat").map((c) => ({ id: c.id, name: c.name, off: c.off, settings: {} }));
  const exe: BoatChoice[] = (data?.connectors || []).filter((c) => c.kind === "exe").map((c) => ({ id: c.id, kind: "exe", name: c.name, off: c.off, settings: {} }));
  const images = failed ? [] : d?.images || null;
  const conns = [...boat, ...exe].filter((c) => !c.off);
  if (!conns.length)
    return (
      <>
        <p className="muted">A machine in the cloud, on your own boat.dev or exe.dev account: your agents work there with every Mac off, and agentbook wakes it when you send it something.</p>
        <p className="muted ws-note">
          <a href={connectorsHref()}>Connect boat or exe.dev</a> first, with a key of yours.
        </p>
      </>
    );
  const conn = conns.find((c) => c.id === f.connector) || conns[0];
  const pick = conns.length > 1 && <Opt className="cloud-opt" name="connector" label="connector" face={conn.name} value={conn.id} options={conns.map((c) => ({ value: c.id, text: `${c.name} · ${cloudName(c.kind)}` }))} onChange={(v) => setForm({ connector: v, image: "", size: "" })} />;
  if (conn.kind === "exe") return <ExeForm conn={conn} pick={pick} repos={repos} onMade={onMade} />;
  if (!images) return <p className="muted">Reading your images…</p>;
  const unreachable = d?.unreachable || failed;
  if (unreachable) return <p className="auth-err">{unreachable}</p>;
  const mine = images.filter((i) => i.connector === conn.id);
  const img = mine.find((i) => i.id === f.image) || null;
  const size = f.size || (img ? img.def.size : conn.settings?.size) || "default";
  const asked = askedOf(img);
  // The same field, typed or picked.
  const field = (name: keyof CloudFormState) => (v: string) => setForm(name === "image" ? { image: v, size: "" } : { [name]: v });

  const make = async (e: React.FormEvent) => {
    e.preventDefault();
    if (f.busy) return;
    const connector = conn.id;
    const repo = f.repo.trim();
    setForm({ busy: true, error: null });
    // With a passkey, the server answers with what to sign, and post() signs it and sends it again.
    const r = await post<{ machine: string; folder?: string; setting?: boolean }>("/api/cloud/machines", { connector, ...(f.image ? { image: f.image } : {}), ...(f.size ? { size: f.size } : {}), ...(repo ? { repo } : {}), ...(f.name.trim() ? { name: f.name.trim() } : {}), secrets: Object.fromEntries(Object.entries(f.secrets).filter(([, v]) => v)) });
    if (!r.ok) return setForm({ busy: false, error: r.data.passkey ? null : r.data.error || "Couldn't make it." });
    const made = r.data;
    useCloudForm.setState({ form: null });
    // Its repo is a workspace of yours, with its checkout there: its machine trusts that folder once it's on.
    if (repo && made.folder) await post("/api/workspaces", { repo, folder: { machine: made.machine, path: made.folder } });
    toast(`${made.machine} is starting on boat. ${made.setting ? "It sets itself up first, which takes a few minutes." : "It's On in a moment."}`);
    if (onMade) onMade();
    else go(`#/machines/${encodeURIComponent(made.machine)}`);
  };

  return (
    <>
      <p className="muted">A machine on boat.dev, on your own account: it's on while your agents work there, sleeps {conn.settings?.idle || "15"} minutes after they go idle, and wakes when you send it something, with every Mac off.</p>
      <form className="stack cloud-form" onSubmit={make}>
        <label className="field">
          <span>
            A repo to start in <small>on GitHub, as owner/repo; or none</small>
          </span>
          <input name="repo" value={f.repo} onChange={(e) => field("repo")(e.target.value)} placeholder="acme/platform" autoCapitalize="off" autoComplete="off" spellCheck={false} list={repos.length ? "cloud-repos" : undefined} />
        </label>
        {repos.length > 0 && (
          <datalist id="cloud-repos">
            {repos.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        )}
        <div className="cloud-row">
          <Opt className="cloud-opt" name="image" label="image" face={img ? img.name : "Basic"} value={img?.id || ""} options={[{ value: "", text: "Basic · agentbook and Claude Code" }, ...mine.map((i) => ({ value: i.id, text: `${i.name} · ${i.built ? `v${i.built.v} built` : "not built"}` }))]} onChange={field("image")} />
          <Opt className="cloud-opt" name="size" label="size" face={sizeFace(size, d?.sizes)} value={size} options={Object.entries(d?.sizes || {}).map(([k, v]) => ({ value: k, text: `${k} · ${v}` }))} onChange={field("size")} />
          {pick}
        </div>
        <p className="muted ws-note">
          {cloudHow(img)}
          {img && (
            <>
              {" "}
              <a href={`#/images/${encodeURIComponent(img.id)}`}>Its page</a>.
            </>
          )}
        </p>
        <label className="field">
          <span>
            Its name <small>as it shows among your machines</small>
          </span>
          <input name="name" value={f.name} onChange={(e) => field("name")(e.target.value)} placeholder={cloudNameOf(f.repo)} maxLength={60} autoCapitalize="off" autoComplete="off" spellCheck={false} />
        </label>
        {asked.length > 0 && (
          <>
            <p className="ws-sub">Its secrets</p>
            {asked.map((k) => (
              <label key={k} className="field">
                <span>
                  <code>{k}</code>
                  {k === "CLAUDE_CODE_OAUTH_TOKEN" && (
                    <>
                      {" "}
                      <small>
                        from <code>claude setup-token</code>: Claude Code signs in with it
                      </small>
                    </>
                  )}
                </span>
                <input type="password" name={`secret:${k}`} value={f.secrets?.[k] || ""} onChange={(e) => setForm({ secrets: { ...f.secrets, [k]: e.target.value } })} autoComplete="off" spellCheck={false} placeholder="Its value, or set it later on the machine's page" />
              </label>
            ))}
            <p className="muted ws-note">A value goes straight to boat, on this machine's own environment. agentbook keeps only its name.</p>
          </>
        )}
        {f.error && <p className="auth-err">{f.error}</p>}
        <div className="row-acts">
          <button className="btn btn--dark" type="submit" disabled={f.busy}>
            <Icon name="plus" />
            {f.busy ? "Making it…" : "Make the machine"}
          </button>
        </div>
        <p className="muted ws-note">
          It bills your boat account{conn.settings?.org && conn.settings.org.toLowerCase() !== "personal" ? ` (${conn.settings.org}'s wallet)` : ""} while it's on. {d?.signs ? "You confirm it with your passkey." : ""}
        </p>
      </form>
    </>
  );
}

// A machine on exe.dev: a VM named as the machine, which installs agentbook (Node, its release repo, systemd) and
// joins your account through the relay. Its page then shows the code to say yes to (Machine.tsx's MadeMachine).
// There are no images or sizes there: exe.dev bills a pool of VMs by the month, and every VM is the same.
function ExeForm({ conn, pick, repos, onMade }: { conn: BoatChoice; pick: React.ReactNode; repos: string[]; onMade?: () => void }) {
  const f = useCloudForm((s) => s.form) || blank("");
  const setForm = (x: Partial<CloudFormState>) => useCloudForm.setState((s) => ({ form: { ...(s.form || f), ...x } }));
  const claude = f.claude === "gateway" ? "gateway" : "signin";
  const make = async (e: React.FormEvent) => {
    e.preventDefault();
    if (f.busy) return;
    const repo = f.repo.trim();
    setForm({ busy: true, error: null });
    const r = await post<{ machine: string }>("/api/cloud/machines", { connector: conn.id, ...(repo ? { repo } : {}), ...(f.name.trim() ? { name: f.name.trim() } : {}), claude });
    if (!r.ok) return setForm({ busy: false, error: r.data.passkey ? null : r.data.error || "Couldn't make it." });
    useCloudForm.setState({ form: null });
    toast(`${r.data.machine} is on exe.dev, setting itself up. Its page shows the code to say yes to, in a few minutes.`);
    if (onMade) onMade();
    else go(`#/machines/${encodeURIComponent(r.data.machine)}`);
  };
  return (
    <>
      <p className="muted">A VM on your exe.dev account that installs agentbook and joins your account. It stays on until you pause it there; agentbook resumes a paused one when you send it something.</p>
      <form className="stack cloud-form" onSubmit={make}>
        <label className="field">
          <span>
            A repo to start in <small>a public one on GitHub, as owner/repo, cloned into ~/dev there; or none</small>
          </span>
          <input name="repo" value={f.repo} onChange={(e) => setForm({ repo: e.target.value })} placeholder="acme/platform" autoCapitalize="off" autoComplete="off" spellCheck={false} list={repos.length ? "cloud-repos" : undefined} />
        </label>
        {repos.length > 0 && (
          <datalist id="cloud-repos">
            {repos.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        )}
        <div className="cloud-row">
          <Opt className="cloud-opt" name="claude" label="Claude Code" face={claude === "gateway" ? "Claude Code through exe.dev's gateway" : "Claude Code signs in as you"} value={claude} options={[{ value: "signin", text: "Signs in as you · your Claude plan" }, { value: "gateway", text: "exe.dev's gateway · billed by exe.dev" }]} onChange={(v) => setForm({ claude: v })} />
          {pick}
        </div>
        <label className="field">
          <span>
            Its name <small>the VM's, and the machine's here: lowercase letters, digits and -</small>
          </span>
          <input name="name" value={f.name} onChange={(e) => setForm({ name: e.target.value })} placeholder={cloudNameOf(f.repo, "exe")} maxLength={60} autoCapitalize="off" autoComplete="off" spellCheck={false} />
        </label>
        {f.error && <p className="auth-err">{f.error}</p>}
        <div className="row-acts">
          <button className="btn btn--dark" type="submit" disabled={f.busy}>
            <Icon name="plus" />
            {f.busy ? "Making it…" : "Make the machine"}
          </button>
        </div>
        <p className="muted ws-note">Setting it up takes a few minutes. Then you say yes to its code once, on agentbook's sign-in page, and it's On.</p>
      </form>
    </>
  );
}
