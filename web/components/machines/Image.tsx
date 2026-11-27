// An image for cloud machines, on its own page (server/images.ts keeps it).
// The image is a draft its owner edits: every change here is saved at once (`save`), and Build makes the draft a
// version. One sorted list of what agentbook can install, the picked ones first, with a chip per kind; the owner's
// own lists, repos, steps, settings and secrets under it; then each build, with what its script said.
import { useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { getJSON, post } from "../../lib/api.ts";
import { ago, listText } from "../../lib/format.ts";
import { BOAT_HAS, KIND_PILLS, SHOWN, behindOf, buildFacts, catalogOf, changeParts, cloudState, goingOf, imWords, kindChip, logText, pickedOf, sizeFace, span } from "../../lib/images.ts";
import type { BuildView, CatalogEntry, ImageUi, ImageView, ImagesCtx, MachineSeen } from "../../lib/images.ts";
import { connectorsHref } from "../../lib/route.ts";
import { toast } from "../../lib/toast.ts";
import type { ImageDef } from "../../../plugin/shared/types.ts";
import { Icon } from "../Icon.tsx";
import { Opt } from "./Opt.tsx";
import { day } from "./words.ts";

// What changes the draft: saved at once, and what the server couldn't keep is said.
export type ImageSave = (change: (def: ImageDef) => void) => Promise<void>;
const enc = encodeURIComponent;

// Update a cloud machine to its image's newest built version: its image's script runs on it, and its work stays.
export async function cloudUpdate(name: string): Promise<boolean> {
  const r = await post(`/api/machines/${enc(name)}/cloud/update`, {});
  if (!r.ok && !r.data.passkey) toast(r.data.error || "Couldn't start the update.");
  if (r.ok) toast(`${name} is updating: its image's script is running there.`);
  return r.ok;
}

export function ImageHead({ img, ctx, busy, save, onBuild }: { img: ImageView; ctx: ImagesCtx; busy: boolean; save: ImageSave; onBuild: () => void }) {
  const going = goingOf(img);
  const next = img.v + 1;
  const changed = img.built ? img.changes.length : 0;
  const cant = ctx.unreachable ? ctx.unreachable : !ctx.cli ? "This agentbook-server has no agentbook-cli to give a machine, so it can't build: it wasn't started by bin/agentbook-server." : "";
  const nothing = !!img.built && !changed;
  const where = ctx.boat?.find((c) => c.id === img.connector);
  return (
    <section className="card box im-head">
      <a className="im-back" href={connectorsHref()}>
        <Icon name="back" />
        Connectors · {where?.name || "boat"}
      </a>
      <div className="im-title">
        <span className="ico">
          <Icon name="laptop" />
        </span>
        <div>
          <h1 className="page-h">{img.name}</h1>
          <small>
            Image for cloud machines
            {img.built && (
              <>
                {" "}
                · on boat as <code>{img.built.snapshot}</code>
              </>
            )}
          </small>
        </div>
      </div>
      <div className="im-state">
        {img.built ? <span className="chip chip--done">{`v${img.built.v} built ${ago(img.built.at)}`}</span> : going ? null : <span className="chip">Not built yet</span>}
        {going ? <span className="chip chip--new">{`v${going.v} ${going.state === "saving" ? "saving its disk" : "building"}`}</span> : img.built && changed ? <span className="chip chip--new">{`v${next}: ${changed} ${changed === 1 ? "change" : "changes"}, not built`}</span> : null}
        {!going && img.tried ? <span className="chip chip--err">{`v${img.tried} failed`}</span> : null}
      </div>
      {img.built && changed ? (
        <p className="im-changes">
          Since v{img.built.v}:{" "}
          {img.changes.slice(0, 8).map((c, i) => {
            const [name, what] = changeParts(c);
            return (
              <span key={c}>
                {i ? ", " : ""}
                <b>{name}</b>
                {what}
              </span>
            );
          })}
          {changed > 8 ? `, and ${changed - 8} more` : ""}.{" "}
          <button type="button" onClick={() => save((def) => Object.assign(def, structuredClone(img.built.def)))}>
            Put it back as v{img.built.v}
          </button>
        </p>
      ) : null}
      {cant && <p className="auth-err">{cant}</p>}
      {going && <BuildLive build={going} />}
      <div className="row-acts">
        <button className="btn btn--dark" type="button" disabled={!!going || !!cant || nothing || busy} onClick={onBuild}>
          <Icon name="play" />
          {going ? `Building v${going.v}…` : `Build v${next}`}
        </button>
        <a className="btn btn--line" href={`#/workspaces/new?cloud=${enc(img.id)}`}>
          <Icon name="plus" />
          New machine from it
        </a>
        <Opt at="Size" label="Size" face={sizeFace(img.def.size, ctx.sizes)} value={img.def.size} options={Object.entries(ctx.sizes || {}).map(([k, v]) => ({ value: k, text: `${k} · ${v}` }))} onChange={(v) => save((def) => (def.size = v))} />
      </div>
      {nothing ? (
        <p className="muted im-note">Nothing changed since v{img.built.v}, so there's nothing to build.</p>
      ) : !img.built && !going ? (
        <p className="muted im-note">A build takes a few minutes on a builder sandbox on your boat account, with none of your secrets, and costs under a cent. A machine can also be made from it unbuilt: it then installs all this as it starts.</p>
      ) : null}
    </section>
  );
}

function BuildLive({ build: b }: { build: BuildView }) {
  const now = (text: string) => (
    <li className="now">
      <i className="im-dot" />
      {text}
    </li>
  );
  return (
    <ul className="im-steps-live">
      {b.steps.map((s, i) =>
        s.state === "ok" ? (
          <li key={i} className="done">
            <Icon name="check" />
            {s.label}
          </li>
        ) : (
          <li key={i} className="now">
            <i className="im-dot" />
            {s.label}
          </li>
        ),
      )}
      {b.state === "saving" ? now("Saving its disk on boat") : !b.steps.length ? now("Starting its builder on boat") : null}
    </ul>
  );
}

export function ImageMachines({ img, machines }: { img: ImageView; machines: MachineSeen[] }) {
  const mine = machines.filter((m) => m.cloud?.image === img.id);
  if (!mine.length) return null;
  const anyBehind = mine.some((m) => behindOf(img, m));
  return (
    <section className="card box">
      <h3>Machines from it</h3>
      <ul className="rows">
        {mine.map((m) => (
          <li key={m.name}>
            <span className="ico">
              <Icon name="laptop" />
            </span>
            <span>
              <b>
                <a href={`#/machines/${enc(m.name)}`}>{m.name}</a>
              </b>
              <small>{m.cloud.v ? `from v${m.cloud.v}` : "made unbuilt"}</small>
            </span>
            <span className={`chip${m.online ? " chip--done" : ""}`}>{cloudState(m)}</span>
            {behindOf(img, m) && <UpdateButton name={m.name} disabled={!m.online || !!m.cloud.updating} label={`Update to v${img.built.v}`} />}
          </li>
        ))}
      </ul>
      {anyBehind && <p className="muted im-note">Update installs what's new in v{img.built.v} on a machine's disk, and its work stays. The machine has to be on.</p>}
    </section>
  );
}
// Update, which stays pressed while it asks.
export function UpdateButton({ name, disabled, label, className = "btn btn--sm", onDone }: { name: string; disabled: boolean; label: string; className?: string; onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={className}
      type="button"
      disabled={disabled || busy}
      onClick={async () => {
        setBusy(true);
        await cloudUpdate(name);
        setBusy(false);
        onDone?.();
      }}
    >
      {label}
    </button>
  );
}

// What's on it: the catalog as one sorted list, picked first. `find` narrows it where it stands.
export function ImageCatalog({ img, ctx, ui, setUi, save }: { img: ImageView; ctx: ImagesCtx; ui: ImageUi; setUi: (u: Partial<ImageUi>) => void; save: ImageSave }) {
  const [find, setFind] = useState("");
  // A version picked for one that isn't picked yet: it waits in its row until it is.
  const [vers, setVers] = useState<Record<string, string>>({});
  const f = ui.f || (Object.keys(pickedOf(img.def)).length > 1 ? "picked" : "all");
  const { on, items, picked, shown, n } = catalogOf(img, ctx, f);
  const was = img.built ? pickedOf(img.built.def) : null;
  const q = find.trim().toLowerCase();
  const hidden = f === "all" && !ui.more ? Math.max(0, shown.length - SHOWN) : 0;
  const pick = (c: CatalogEntry, checked: boolean, v: string | undefined) => {
    if (c.kind === "agent") return save((def) => (def.agents = checked ? [...new Set([...def.agents, c.id])] : def.agents.filter((a) => a !== c.id)));
    return save((def) => (def.picks = [...def.picks.filter((p) => p.split("@")[0] !== c.id), ...(checked ? [v ? `${c.id}@${v}` : c.id] : [])]));
  };
  const version = (c: CatalogEntry, v: string) => {
    setVers((x) => ({ ...x, [c.id]: v }));
    // Its version only matters once it's picked: until then the choice waits in its row.
    if (!img.def.picks.some((p) => p.split("@")[0] === c.id)) return;
    save((def) => (def.picks = def.picks.map((p) => (p.split("@")[0] === c.id ? `${c.id}@${v}` : p))));
  };
  const pill = (key: string, label: string, count?: number) => (
    <button key={key} className={`pill${f === key ? " is-on" : ""}`} type="button" onClick={() => setUi({ f: key })}>
      {label}
      {count != null && <span className="n">{count}</span>}
    </button>
  );
  return (
    <section className="card box">
      <h3>
        What's on it <small>{n} picked</small>
      </h3>
      <div className="im-tools">
        {pill("all", "All", items.length)}
        {pill("picked", "Picked", n)}
        {KIND_PILLS.map(([k, l]) => pill(k, l))}
        <input className="im-find" type="search" placeholder="Find something to install" aria-label="Find something to install" value={find} onChange={(e) => setFind(e.target.value)} />
      </div>
      <ul className="im-list">
        {shown.length ? (
          shown.map((c, i) => {
            const p = picked(c);
            const v = typeof on[c.id] === "string" ? (on[c.id] as string) : vers[c.id] || c.versions?.[0];
            const fresh = was && p && !c.always && !(c.id in was);
            const extra = i >= SHOWN && !ui.more && f === "all";
            const text = `${c.label} ${c.kind} ${c.about}`.toLowerCase();
            return (
              <li key={c.id} className={`im-row${p ? "" : " is-off"}`} hidden={q ? !text.includes(q) : extra}>
                <label className="switch">
                  <input type="checkbox" role="switch" checked={p} disabled={c.always} aria-label={c.label} onChange={(e) => pick(c, e.target.checked, v)} />
                  <span className="track" aria-hidden="true" />
                </label>
                <span className="im-nm">
                  <b>{c.label}</b>
                  <span className="chip">{kindChip(c)}</span>
                  {fresh && <span className="chip chip--new">New</span>}
                </span>
                {c.versions ? <Opt label={`${c.label} version`} face={v} value={v} options={c.versions.map((x) => ({ value: x, text: x }))} onChange={(x) => version(c, x)} /> : <span />}
                <p>{c.about}</p>
              </li>
            );
          })
        ) : (
          <li className="im-row">
            <span />
            <p>Nothing picked of this kind.</p>
          </li>
        )}
      </ul>
      {hidden > 0 && (
        <button className="im-more" type="button" hidden={!!q} onClick={() => setUi({ more: true })}>
          {hidden} more
        </button>
      )}
      <div className="im-lists">
        <Tokens img={img} k="apt" label="apt packages" hint="ffmpeg, jq and ripgrep are already on boat's image." save={save} />
        <Tokens img={img} k="npm" label="npm globals" save={save} />
        <Tokens img={img} k="uv" label="uv tools" save={save} />
      </div>
      <details className="im-boat">
        <summary>Already on boat's image, without picking</summary>
        <p>{BOAT_HAS}</p>
      </details>
    </section>
  );
}
// One of the owner's own lists (apt, npm, uv): its words as chips, and a box to add more. Enter adds what's typed,
// and the box is ready for the next; so does leaving it.
function Tokens({ img, k, label, hint, save }: { img: ImageView; k: "apt" | "npm" | "uv"; label: string; hint?: string; save: ImageSave }) {
  const add = (input: HTMLInputElement) => {
    const words = imWords(input.value);
    input.value = "";
    if (!words.length) return;
    save((def) => (def[k] = [...new Set([...(def[k] || []), ...words])]));
  };
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    add(e.currentTarget);
  };
  return (
    <>
      <label>
        {label}
        <span className="im-tokens">
          {(img.def[k] || []).map((x) => (
            <span key={x} className="chip">
              {x}
              <button type="button" className="im-untok" aria-label={`Take ${x} off`} onClick={() => save((def) => (def[k] = (def[k] || []).filter((y) => y !== x)))}>
                ×
              </button>
            </span>
          ))}
          <input placeholder="Add one" aria-label={`Add to ${label}`} autoComplete="off" autoCapitalize="off" spellCheck={false} onKeyDown={key} onBlur={(e) => e.currentTarget.value.trim() && add(e.currentTarget)} />
        </span>
      </label>
      {hint && <p className="hint">{hint}</p>}
    </>
  );
}

export function ImageRepos({ img, github, save }: { img: ImageView; github: boolean; save: ImageSave }) {
  return (
    <section className="card box">
      <h3>
        Repos <small>cloned in, with their dependencies installed</small>
      </h3>
      {(img.def.repos || []).map((r) => (
        <div key={r.repo} className="im-repo">
          <span className="ico">
            <Icon name="repo" />
          </span>
          <span>
            <b>{r.repo}</b>
            <small>
              into ~/{r.repo.split("/").pop()}
              {r.branch ? ` · branch ${r.branch}` : ""}
            </small>
          </span>
          <button className="icon-x" type="button" aria-label="Take it off" title="Take it off" onClick={() => save((def) => (def.repos = def.repos.filter((x) => x.repo !== r.repo)))}>
            <Icon name="x" />
          </button>
          <div className="im-install">
            Then{" "}
            <input
              key={r.install || ""}
              defaultValue={r.install || ""}
              placeholder="what its lockfile says"
              aria-label={`What installs ${r.repo}'s dependencies`}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              onBlur={(e) => {
                const v = e.currentTarget.value;
                if (v !== (r.install || "")) save((def) => (def.repos = def.repos.map((x) => (x.repo === r.repo ? { ...x, install: v.trim() || undefined } : x))));
              }}
            />
            <span>{r.install ? "" : "npm ci, pnpm install, uv sync, bundle install or cargo fetch, by the lockfile it finds"}</span>
          </div>
        </div>
      ))}
      <form
        className="im-add"
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const f = new FormData(form);
          const repo = String(f.get("repo") || "").trim();
          const branch = String(f.get("branch") || "").trim();
          save((def) => void def.repos.push({ repo, ...(branch ? { branch } : {}) })).then(() => form.reset());
        }}
      >
        <input name="repo" placeholder="acme/platform" aria-label="A GitHub repo, as owner/name" autoComplete="off" autoCapitalize="off" spellCheck={false} required />
        <input name="branch" placeholder="branch (its default)" aria-label="Branch" autoComplete="off" autoCapitalize="off" spellCheck={false} />
        <button className="btn btn--sm" type="submit">
          <Icon name="plus" />
          Add a repo
        </button>
      </form>
      <p className="muted im-note">
        {github ? (
          "Cloned with your GitHub connector, as you, during the build only."
        ) : (
          <>
            Public repos clone as they are. For private ones, <a href={connectorsHref()}>connect GitHub</a>: the build clones as you, and no token is kept on the disk.
          </>
        )}{" "}
        A new machine starts with the checkout and its dependencies in place.
      </p>
    </section>
  );
}

// The owner's own steps, run last.
export function ImageSteps({ img, save }: { img: ImageView; save: ImageSave }) {
  const changed = img.built && (img.built.def.steps || "") !== (img.def.steps || "");
  return (
    <section className="card box">
      <h3>
        Your steps
        {changed && (
          <>
            {" "}
            <span className="chip chip--new">Changed since v{img.built.v}</span>
          </>
        )}
      </h3>
      <textarea
        key={img.def.steps || ""}
        className="im-steps"
        spellCheck={false}
        autoCapitalize="off"
        aria-label="Your steps"
        placeholder={"# Runs last, as user, with sudo. Keep it safe to run twice:\n# Update runs it again on machines made from an older version."}
        defaultValue={img.def.steps || ""}
        onBlur={(e) => {
          const v = e.currentTarget.value;
          if (v !== (img.def.steps || "")) save((def) => (def.steps = v));
        }}
      />
      <p className="muted im-note">For anything the list doesn't have. A failing line stops the build, and its output is in the build's log.</p>
    </section>
  );
}

// Its settings (built in) and secrets (asked for per machine, only their names here), and how Claude Code signs in.
export function ImageSettings({ img, save }: { img: ImageView; save: ImageSave }) {
  const token = img.def.claude === "token";
  const kv = (k: string, code: ReactNode, chip: string, small: string, off: (def: ImageDef) => void) => (
    <div key={`${chip}:${k}`} className="im-kv">
      <code>{code}</code>
      <span>
        <span className="chip">{chip}</span>
        <button className="icon-x" type="button" aria-label={`Take ${k} off`} onClick={() => save(off)}>
          <Icon name="x" />
        </button>
      </span>
      <small>{small}</small>
    </div>
  );
  return (
    <section className="card box">
      <h3>Settings and secrets</h3>
      {Object.entries(img.def.env || {}).map(([k, v]) =>
        kv(
          k,
          <>
            {k}
            <i> = </i>
            {v}
          </>,
          "Setting",
          "Built into the image, so it's the same on every machine.",
          (def) => void delete def.env[k],
        ),
      )}
      {(img.def.secrets || []).map((k) => kv(k, k, "Secret", "Asked for when you make a machine. Only its name is here.", (def) => void (def.secrets = def.secrets.filter((x) => x !== k))))}
      <form
        className="im-add"
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const f = new FormData(form);
          const name = String(f.get("name") || "").trim();
          const submitter = (e.nativeEvent as SubmitEvent).submitter;
          const as = submitter instanceof HTMLButtonElement && submitter.value === "secrets" ? "secrets" : "env";
          save((def) => void (as === "env" ? (def.env[name] = String(f.get("value") || "")) : def.secrets.push(name))).then(() => form.reset());
        }}
      >
        <input name="name" placeholder="NAME" aria-label="Name" autoComplete="off" autoCapitalize="characters" spellCheck={false} required />
        <input name="value" placeholder="its value, for a setting" aria-label="Value, for a setting" autoComplete="off" spellCheck={false} />
        <button className="btn btn--sm" type="submit" name="as" value="env">
          <Icon name="plus" />
          Setting
        </button>
        <button className="btn btn--sm" type="submit" name="as" value="secrets">
          <Icon name="plus" />
          Secret
        </button>
      </form>
      <p className="muted im-note">A secret's value goes straight to boat, on each machine's own environment. agentbook keeps only its name, and an image never holds one, since snapshots can be shared.</p>
      <div className="im-login">
        <b>How Claude Code signs in</b>
        <div className="seg">
          <button type="button" className={token ? "" : "is-on"} onClick={() => save((def) => (def.claude = "signin"))}>
            Sign in on the machine
          </button>
          <button type="button" className={token ? "is-on" : ""} onClick={() => save((def) => (def.claude = "token"))}>
            A setup-token secret
          </button>
        </div>
        <p>
          {token ? (
            <>
              A <code>CLAUDE_CODE_OAUTH_TOKEN</code> secret from <code>claude setup-token</code>, asked for when you make a machine: no sign-in, and it allows inference only, without your claude.ai connectors.
            </>
          ) : (
            "Each new machine shows a Sign in card: a claude.ai link and a code, from your phone. Your Max or Pro login, with its claude.ai connectors (Slack, Notion, Linear…)."
          )}
        </p>
      </div>
    </section>
  );
}

const BUILD_CHIP: Record<string, [string, string]> = { ready: ["Built", "chip--done"], failed: ["Failed", "chip--err"], gone: ["Gone from boat", ""], building: ["Building", "chip--new"], saving: ["Saving", "chip--new"] };
export function ImageBuilds({ img, ui, setUi }: { img: ImageView; ui: ImageUi; setUi: (u: Partial<ImageUi>) => void }) {
  if (!img.builds.length) return null;
  const kept = img.builds.filter((b) => b.state === "ready");
  const fullLog = async (v: number) => {
    const d = await getJSON<{ log?: string }>(`/api/images/${enc(img.id)}/builds/${enc(String(v))}/log`);
    setUi({ logs: { ...ui.logs, [v]: d?.log ?? "" }, open: { ...ui.open, [v]: true } });
  };
  return (
    <section className="card box">
      <h3>Builds</h3>
      {img.builds.map((b) => {
        const [word, cls] = BUILD_CHIP[b.state] || [b.state, ""];
        const full = ui.logs?.[b.v];
        const note =
          b.state === "failed" ? (
            <p>{(b.error || "It failed").replace(/[.\s]+$/, "")}. Nothing was saved, and the builder was deleted.</p>
          ) : b.state === "ready" && kept[1] === b ? (
            <p>
              The one before v{kept[0].v}, kept on boat in case v{kept[0].v} needs undoing.
            </p>
          ) : b.state === "gone" ? (
            <p>Its saved snapshot was deleted from boat once two newer ones were built.</p>
          ) : null;
        return (
          <div key={b.v} className="im-build">
            <div className="im-build-h">
              <b>v{b.v}</b>
              <span className={`chip ${cls}`}>{word}</span>
              <small>{buildFacts(b, ago, day)}</small>
            </div>
            {b.changes?.length && b.state !== "gone" ? (
              <p>
                {listText(b.changes.slice(0, 6))}
                {b.changes.length > 6 ? ", and more" : ""}.
              </p>
            ) : null}
            {note}
            {(b.steps.length || b.state !== "building") && (
              <details open={!!ui.open?.[b.v]} onToggle={(e) => setUi({ open: { ...ui.open, [b.v]: e.currentTarget.open } })}>
                <summary>Log</summary>
                <pre className="im-log">
                  <span className="dim">builder {b.sandbox || ""} · no secrets · monitoring off</span>
                  {"\n"}
                  {full != null ? logText(full) : b.steps.map((s, i) => <LogLine key={i} step={s} first={!i} />)}
                  {b.state === "ready" ? (
                    <>
                      {"\n"}
                      <span className="dim">saved {b.snapshot} · builder deleted</span>
                    </>
                  ) : b.state === "failed" ? (
                    <>
                      {"\n"}
                      <span className="dim">stopped · builder deleted</span>
                    </>
                  ) : null}
                </pre>
                {full == null && b.steps.length > 0 && (
                  <button className="btn btn--sm" type="button" onClick={() => fullLog(b.v)}>
                    The whole log
                  </button>
                )}
              </details>
            )}
          </div>
        );
      })}
      <p className="muted im-note">Two built versions stay on boat: the newest and the one before. Each $20 of plan includes 10 saved snapshots, and each one past that costs $0.056 a day.</p>
    </section>
  );
}
function LogLine({ step: s, first }: { step: BuildView["steps"][number]; first: boolean }) {
  return (
    <>
      {first ? "" : "\n"}
      {s.label}
      {"  "}
      <span className={s.state === "ok" ? "ok" : s.state === "failed" ? "no" : "dim"}>{s.state === "ok" ? "ok" : s.state}</span>
      {s.seconds > 9 && (
        <>
          {" "}
          <span className="dim">{span(s.seconds)}</span>
        </>
      )}
      {s.state === "failed" && s.out && (
        <>
          {"\n"}
          <span className="no">{s.out}</span>
        </>
      )}
    </>
  );
}

// Delete, pressed once to ask.
export function ImageDelete({ img, used, deleting, onDelete }: { img: ImageView; used: number; deleting: boolean; onDelete: () => void }) {
  return (
    <section className="card box">
      <div className="set-row">
        <p>{deleting ? `Delete ${img.name}? Its saved snapshots are deleted from boat.${used ? ` The ${used === 1 ? "machine" : `${used} machines`} made from it keep running.` : ""}` : "Delete this image, and its saved snapshots on boat."}</p>
        <button className={`btn btn--sm${deleting ? " btn--dark" : ""}`} type="button" onClick={onDelete}>
          {deleting ? "Delete it" : "Delete"}
        </button>
      </div>
    </section>
  );
}
