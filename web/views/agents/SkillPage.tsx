import { agentName } from "../../lib/agents.ts";
import { nowOf } from "../../lib/feed.ts";
import { ago, hue, hueVars, plural } from "../../lib/format.ts";
import { useLoad } from "../../lib/hooks.ts";
import { agentHref, threadHref, useRoute } from "../../lib/route.ts";
import { threadRow, useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { SkillView, Thread } from "../../lib/types.ts";
import { Avatar } from "../../components/Avatar.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Markdown } from "../../components/Markdown.tsx";

// "plugin:skill" (or "dir/sub:skill") splits into where it comes from and its name.
function splitSkill(name: string): [string | null, string] {
  const cut = name.lastIndexOf(":");
  return cut > 0 ? [name.slice(0, cut), name.slice(cut + 1)] : [null, name];
}

// A thread's avatar in a ring that fills as its plan gets done (full once it's done, or waiting on you).
function Ring({ s }: { s: Thread }) {
  const plan = nowOf(s.id)?.plan || s.plan;
  const frac = s.effective === "needs" ? 1 : s.effective === "done" ? 1 : plan?.length ? plan.filter((t) => t.status === "completed").length / plan.length : 0;
  const color = s.effective === "needs" ? "#ffd23f" : s.effective === "done" ? "var(--line-2)" : hue(s.agent)[0];
  const c = 2 * Math.PI * 23;
  return (
    <span className="ring">
      <svg viewBox="0 0 52 52" width="52" height="52" aria-hidden="true">
        <circle cx="26" cy="26" r="23" fill="none" stroke="#e5e8ec" strokeWidth="3.5" />
        <circle cx="26" cy="26" r="23" fill="none" stroke={color} strokeWidth="3.5" strokeLinecap="round" strokeDasharray={`${(frac * c).toFixed(1)} ${c.toFixed(1)}`} />
      </svg>
      <Avatar agent={s.agent} />
    </span>
  );
}

export function SkillPage() {
  const { id, skill: name = "" } = useRoute();
  useApp((s) => s.data); // its agent's name, as the chrome has it
  useApp((s) => s.rows); // the threads that used it, as the chrome has them
  const got = useLoad<SkillView>(`/api/agents/${encodeURIComponent(id)}/skills/${encodeURIComponent(name)}`);
  const k = got.missing ? { missing: true } : got.data;
  const [from, short] = splitSkill(name);
  if (k?.missing)
    return (
      <div className="shell-msg">
        <p>
          {agentName(id)} has no skill called {short}.
        </p>
        <a className="btn" href={agentHref(id, "skills")}>
          Back to its skills
        </a>
      </div>
    );
  const used = k ? (k.used ? `Used ${plural(k.used, "time")}${k.uses.length > 1 ? ` in ${k.uses.length} threads` : ""}` : "Not used yet") : "";
  const uses = k?.uses || [];
  return (
    <div className="sess-shell" style={hueVars(id)}>
      <main>
        <div>
          <p className="crumbs">
            <a href={agentHref(id, "threads")}>{agentName(id)}</a>
            <span className="sep">/</span>
            <a href={agentHref(id, "skills")}>Skills</a>
            <span className="sep">/</span>
            <span>{short}</span>
          </p>
        </div>
        <article className="card post post--full">
          <div>
            <header className="skill-head">
              <span className="skill-ico skill-ico--lg">
                <Icon name="spark" />
              </span>
              <div>
                <h1 className="post-title post-title--big">{short}</h1>
                <div className="post-meta">
                  {from && <span className="chip">{from}</span>}
                  {used && <span>{used}</span>}
                  {k && !k.listed && <span className="chip">No longer available</span>}
                </div>
              </div>
            </header>
            {k?.description && <p className="skill-desc">{k.description}</p>}
          </div>
          <div>
            {!k ? (
              <p className="muted">Loading…</p>
            ) : k.body ? (
              <>
                <p className="sec-h">
                  Instructions <span className="muted">SKILL.md</span>
                </p>
                <Markdown text={k.body} className="md skill-doc" />
              </>
            ) : (
              <>
                <p className="sec-h">Instructions</p>
                <p className="muted">No SKILL.md for it on its machine. Skills built into Claude Code don't have one.</p>
              </>
            )}
          </div>
        </article>
      </main>
      <aside className="rail sess-side">
        <div>
          <section className="card rail-card">
            <h3 className="rail-h">About this skill</h3>
            <dl className="kv">
              <dt>Agent</dt>
              <dd>
                <a href={agentHref(id, "threads")}>
                  <b>{agentName(id)}</b>
                </a>
              </dd>
              <dt>Name</dt>
              <dd title={name}>{name}</dd>
              {from && (
                <>
                  <dt>{from.includes("/") ? "Folder" : "Plugin"}</dt>
                  <dd>{from}</dd>
                </>
              )}
              {k?.file && (
                <>
                  <dt>File</dt>
                  <dd title={k.file}>{k.file}</dd>
                </>
              )}
            </dl>
            {k?.file && (
              <div className="side-acts">
                <button
                  className="btn btn--line"
                  type="button"
                  onClick={async () => {
                    await navigator.clipboard?.writeText(k.file).catch(() => {});
                    toast("Copied. Paste it in a terminal.");
                  }}
                >
                  <Icon name="copy" />
                  Copy the file's path
                </button>
              </div>
            )}
          </section>
        </div>
        <div>
          {uses.length > 0 && (
            <section className="card rail-card related">
              <h3 className="rail-h">Threads that used it</h3>
              {uses.slice(0, 12).map((u) => {
                const s = threadRow(u.id);
                return (
                  <a key={u.id} href={threadHref(u.id)}>
                    {s ? <Ring s={s} /> : <Avatar agent={id} />}
                    <span>
                      <b>{s?.title || u.title}</b>
                      <small>
                        {u.label}, {plural(u.count, "time")}, {ago(u.started)} ago
                      </small>
                    </span>
                  </a>
                );
              })}
              {uses.length > 12 && <p className="muted">and {uses.length - 12} more</p>}
            </section>
          )}
        </div>
      </aside>
    </div>
  );
}
