// What Add a workspace offers, wherever it shows (its page, its box): a repo, a folder, and a machine in the cloud.
// The box (AddWsDialog) goes over the page you're on; one picker for every agent (memory: never a second menu).
import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { machineOf, many, repoName, tildeOn } from "../../lib/agents.ts";
import { NARROW, useMedia } from "../../lib/chrome.ts";
import { agoText, dayTime, plural } from "../../lib/format.ts";
import { useDraft } from "../../lib/hooks.ts";
import { connectorsHref, useRoute } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import { Dialog } from "../Dialog.tsx";
import { Icon } from "../Icon.tsx";
import { CloudForm } from "../machines/CloudForm.tsx";
import { Opt } from "../machines/Opt.tsx";
import { addRepoList, addWorkspace, addWsTab, browsable, browseMachine, browseTo, closeAddWs, cloneHereNote, keptFolder, useAddWs, wantFolders, wantGhRepos } from "./addws.ts";
import type { AddWsTab, RepoHit } from "./addws.ts";

// A button that stays pressed while what it adds is being added, as the old page's `button.disabled = true` did.
function AddButton({ body, machine, className = "btn btn--sm", children }: { body: Parameters<typeof addWorkspace>[0]; machine?: string; className?: string; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={className}
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await addWorkspace(body, machine).finally(() => setBusy(false));
      }}
    >
      {children}
    </button>
  );
}

// A repo: its box to find one in or type it, and the repos you can add, the ones checked out on your machines and,
// with GitHub connected, every one you have there. `focus`: the box takes the keys (the box's, not on a phone).
export function RepoPart({ focus = false, machine }: { focus?: boolean; machine?: string }) {
  const data = useApp((s) => s.data);
  const gh = useAddWs((s) => (data?.github ? s.gh : null));
  const [typed, setTyped] = useDraft("ws-repo");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLInputElement>(null);
  useEffect(wantGhRepos, [data?.github]);
  useEffect(() => void (focus && box.current?.focus()), [focus]);
  const { q, hits } = addRepoList(typed, gh, machine);
  const shown = hits.slice(0, q ? 12 : 8);
  const app = (data?.connectors || []).find((c) => c.kind === "github")?.via === "app";
  const notes: ReactNode[] = [
    data?.github ? null : (
      <>
        <a href={connectorsHref()}>Connect GitHub</a> to pick from all your repos there.
      </>
    ),
    hits.length > shown.length ? `And ${hits.length - shown.length} more${q ? "" : ": type to find one"}.` : null,
    q && !hits.length && (!gh || gh.data) ? `None of your repos${gh ? "" : " checked out on your machines"} match. Add takes it as you typed it.` : null,
    gh?.data?.more ? `GitHub has ${gh.data.more} more that aren't listed: type its owner/repo.` : null,
    gh?.data && app ? (
      <>
        Signed in with GitHub, agentbook sees only the repos its GitHub App is installed on: <a href={connectorsHref()}>install it on more</a>.
      </>
    ) : null,
  ].filter(Boolean);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = box.current?.value || "";
    if (!v.trim()) return box.current?.focus();
    // A name that isn't owner/repo nor a URL, and only one of your repos has it: that one.
    const one = !/[/:]/.test(v) && hits.length === 1 ? hits[0] : null;
    const body = one ? { repo: one.gh?.slug || one.repo, url: one.url || undefined } : { repo: v.trim() };
    setBusy(true);
    await addWorkspace(body, machine).finally(() => setBusy(false));
  };
  return (
    <>
      <p className="muted">
        {machine ? `Use an existing checkout or clone the repo ${cloneHereNote(machine)}.` : <>Its checkouts are found on all your machines. If none of them has one, it's cloned {cloneHereNote()} when you add it, and a machine you post to that doesn't have one clones it first.</>}
      </p>
      <form className="ws-repo" onSubmit={submit}>
        <input ref={box} name="repo" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Find a repo, or type owner/repo or its URL" autoCapitalize="off" autoComplete="off" spellCheck={false} aria-label="Repo" />
        <button className="btn btn--dark" type="submit" disabled={busy}>
          Add
        </button>
      </form>
      {shown.length > 0 && (
        <>
          <p className="ws-sub">{gh || machine ? "Your repos" : "Checked out on your machines"}</p>
          <ul className="rows ws-repos">
            {shown.map((r) => (
              <RepoRow key={r.repo} r={r} machine={machine} />
            ))}
          </ul>
        </>
      )}
      {notes.map((n, i) => (
        <p key={i} className="muted ws-note">
          {n}
        </p>
      ))}
      {!gh ? null : gh.error ? <p className="auth-err ws-note">Couldn't read your repos on GitHub: {gh.error}</p> : gh.data ? null : <p className="muted ws-note">Reading your repos on GitHub…</p>}
    </>
  );
}
// A repo on that list: where it's checked out and how many threads ran there, or when it was last pushed to.
function RepoRow({ r, machine }: { r: RepoHit; machine?: string }) {
  const facts = [r.sessions ? plural(r.sessions, "thread") : "", r.machines.size ? `on ${[...r.machines].join(", ")}` : "", !r.machines.size && r.gh?.pushed ? `pushed ${agoText(r.gh.pushed)}` : ""].filter(Boolean).join(", ");
  const line = [facts, r.gh?.about || ""].filter(Boolean).join(" · ");
  return (
    <li>
      <span className="ico">
        <Icon name="repo" />
      </span>
      <span>
        <b>{r.gh?.slug || repoName(r.repo)}</b>
        {line && <small title={r.gh?.about || ""}>{line}</small>}
      </span>
      {r.gh?.private && (
        <span className="chip chip--lock">
          <Icon name="lock" />
          Private
        </span>
      )}
      {r.gh?.fork && <span className="chip">Fork</span>}
      {r.gh?.archived && <span className="chip">Archived</span>}
      <AddButton machine={machine} body={{ repo: r.gh?.slug || r.repo, url: r.url || undefined }}>Add</AddButton>
    </li>
  );
}

// A folder: for anything that isn't a repo you share between machines. Where your agents have worked, and a
// machine's folders to look through.
export function FolderPart({ machine }: { machine?: string }) {
  const folders = useApp((s) => s.data?.folders);
  useEffect(() => {
    if (!machine) return wantFolders();
    const browse = useAddWs.getState().browse;
    browseTo(machine, browse.machine === machine ? browse.path : null);
  }, [machine]);
  // Folders your agents worked in that aren't clones of a repo.
  const rows = (folders || []).filter((f) => f.sessions && !f.remote && (!machine || machineOf(f) === machine) && !keptFolder(f)).slice(0, 6);
  return (
    <>
      <p className="muted">For anything that isn't a repo you share between machines. It stays on the machine it's on.</p>
      {rows.length > 0 && (
        <>
          <p className="ws-sub">Where your agents have worked</p>
          <ul className="rows">
            {rows.map((f) => (
              <li key={`${machineOf(f)}:${f.root}`}>
                <span className="ico">
                  <Icon name="folder" />
                </span>
                <span>
                  <b>{f.name}</b>
                  <small>
                    {tildeOn(machineOf(f), f.root)}
                    {many() ? ` on ${machineOf(f)}` : ""}, {plural(f.sessions, "thread")}
                  </small>
                </span>
                <AddButton machine={machine} body={{ folder: { machine: machineOf(f), path: f.root } }}>Add</AddButton>
              </li>
            ))}
          </ul>
        </>
      )}
      <FolderPicker target={machine} />
    </>
  );
}
// A machine's folders, one level at a time, as the machine lists them. Only your own machines.
function FolderPicker({ target }: { target?: string }) {
  const b = useAddWs((s) => s.browse);
  useApp((s) => s.data?.machines);
  const machines = browsable();
  const at = target || browseMachine(b);
  const which =
    !target && machines.length > 1 ? (
      <Opt className="ws-machine" title="The machine to look on" label="Machine" before={<Icon name="laptop" />} face={at} value={at} options={machines.map((m) => ({ value: m.name, text: m.name }))} onChange={(v) => browseTo(v, null)} />
    ) : null;
  const head = which ? (
    <div className="ws-sub ws-sub--row">
      <span>Look through the folders on</span>
      {which}
    </div>
  ) : (
    <p className="ws-sub">{target ? `Look through folders on ${target}` : "Look through your folders"}</p>
  );
  const matches = !target || b.machine === target;
  const d = matches ? b.data : null;
  if (matches && b.error)
    return (
      <>
        {head}
        <p className="auth-err">{b.error}</p>
      </>
    );
  if (!d)
    return (
      <>
        {head}
        <p className="muted">Loading…</p>
      </>
    );
  const machine = d.machine || at;
  return (
    <>
      {head}
      <div className="browser">
        {d.offline && d.as_of && (
          <p className="as-of">
            <Icon name="pause" />
            As of {dayTime(d.as_of)}, while {machine || "its machine"} is off.
          </p>
        )}
        <div className="browser-bar">
          <button className="icon-btn" type="button" onClick={() => browseTo(at, d.parent || "")} aria-label="Up a folder" title="Up a folder" disabled={!d.parent}>
            <Icon name="up" />
          </button>
          <code className="browser-path" title={d.path}>
            {tildeOn(d.machine, d.path)}
          </code>
          <AddButton machine={target} className="btn btn--dark btn--sm" body={{ folder: { machine: at, path: d.path }, repo: d.remote, url: d.url }}>
            {d.remote ? `Add ${repoName(d.remote)}` : "Add this folder"}
          </AddButton>
        </div>
        {d.remote && <p className="browser-note">It's a clone of {repoName(d.remote)}, so it's added as that repo, and found on your other machines too.</p>}
        {d.folders?.length ? (
          <ul className="rows browser-list">
            {d.folders.map((f) => (
              <li key={f.path}>
                <button className="browser-dir" type="button" onClick={() => browseTo(at, f.path)}>
                  <Icon name={f.remote ? "repo" : "folder"} />
                  <span>{f.name}</span>
                </button>
                {f.remote ? <span className="chip">{repoName(f.remote)}</span> : f.git ? <span className="chip">git</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="browser-note">No folders in here.</p>
        )}
        {d.more ? <p className="browser-note">And {d.more} more.</p> : null}
      </div>
    </>
  );
}

// In the cloud: a machine on your boat account, made here, with a repo to start in (components/machines/CloudForm),
// offered your repos on GitHub as you type. `image`: the one to start from (an image's New machine from it).
export function CloudPart({ image = "", dialogId }: { image?: string; dialogId?: symbol }) {
  const github = useApp((s) => s.data?.github);
  const gh = useAddWs((s) => s.gh);
  useEffect(wantGhRepos, [github]);
  const repos = ((github && gh?.data?.repos) || []).map((g) => g.slug);
  return <CloudForm image={image} repos={repos} onMade={dialogId ? () => { if (useAddWs.getState().box?.id === dialogId) closeAddWs(); } : undefined} />;
}

const TABS: [AddWsTab, string][] = [
  ["repo", "Connect a repo"],
  ["folder", "Pick a folder"],
  ["cloud", "In the cloud"],
];
// The box, over the page you're on: a tab each, or the folders are a long way under your repos. The box to find a
// repo in takes the keys, though not on a phone: its keyboard would cover the list.
export function AddWsDialog() {
  const box = useAddWs((s) => s.box);
  const narrow = useMedia(NARROW);
  const route = useRoute();
  const tab = box?.tab || "repo";
  const machine = box?.targetMachine;
  const title = machine ? `Add a workspace on ${machine}` : "Add a workspace";
  useEffect(() => {
    window.addEventListener("hashchange", closeAddWs);
    return () => {
      window.removeEventListener("hashchange", closeAddWs);
      closeAddWs();
    };
  }, []);
  return (
    <Dialog open={!!box} onClose={closeAddWs} className="viewer modal modal--add" label={title}>
      <header className="viewer-h">
        <span className="viewer-t">
          <b>{title}</b>
        </span>
        <button className="icon-btn" type="button" onClick={closeAddWs} aria-label="Close" title="Close">
          <Icon name="x" />
        </button>
      </header>
      <div className="modal-tabs" role="tablist">
        {TABS.filter(([k]) => !machine || k !== "cloud").map(([k, text]) => (
          <button key={k} className={k === tab ? "is-on" : undefined} type="button" role="tab" aria-selected={k === tab} onClick={() => addWsTab(k)}>
            {text}
          </button>
        ))}
      </div>
      <div className="modal-body">
        <section className="modal-sec">{tab === "repo" ? <RepoPart focus={!narrow} machine={machine} /> : tab === "folder" ? <FolderPart machine={machine} /> : <CloudPart image={route.cloud || ""} dialogId={box?.id} />}</section>
      </div>
    </Dialog>
  );
}
