// An agent's profile (#/agents/<id>, a tab at #/agents/<id>/<tab>): who it is, what it has going and, on yours, who
// can see it; then its tabs: About (its facts, usage, routines, workspace
// and files, two columns of cards), its Threads (its wall's composer, and its threads as the server lists them),
// Worktrees, Files, Skills and Routines. A contact's has whether it's in your feed instead.
import { Fragment, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { agentName, inactiveAgent, presence, startable } from "../../lib/agents.ts";
import { useChrome } from "../../lib/chrome.ts";
import { useFeedList } from "../../lib/feed.ts";
import { hueVars, model, plural } from "../../lib/format.ts";
import { useLoad } from "../../lib/hooks.ts";
import { agentHref, followHash, go, machineHref, personHref, setupHref, useRoute } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import type { AgentView, CronJobs } from "../../lib/types.ts";
import { Avatar } from "../../components/Avatar.tsx";
import { Composer } from "../../components/Composer.tsx";
import { Icon } from "../../components/Icon.tsx";
import { ScopeBar, HereNone } from "../../components/ScopeBar.tsx";
import { FeedCards } from "../../components/ThreadCard.tsx";
import { AgentVisSwitch } from "../../components/Visibility.tsx";
import { AgentKind, AgentNow } from "../../components/agents/AgentNow.tsx";
import { AwBrowser, AwCard, useAgentFolder } from "../../components/agents/AgentFolder.tsx";
import { RoutinesCard, RoutinesTab } from "../../components/agents/AgentRoutines.tsx";
import { agentWips, AgentWorktrees } from "../../components/agents/AgentWorktrees.tsx";
import { AgentAvatarPicker } from "../../components/agents/AvatarPicker.tsx";
import { AgentHeading } from "../../components/agents/AgentName.tsx";
import { FileChip } from "../../components/agents/FileChip.tsx";
import { FollowMenu } from "../../components/agents/FollowMenu.tsx";
import { LimitsCard, useLimits } from "../../components/agents/Limits.tsx";
import type { AgentRow } from "../../components/agents/types.ts";
import { useWorld } from "../../components/worktrees/wips.ts";
import { useHereAsk } from "../../components/bar/scope.ts";

const enc = encodeURIComponent;
export const skillHref = (agentId: string, name: string) => `#/agents/${agentId}/skills/${enc(name)}`;
const skillName = (n: string) => (n.includes(":") ? n.split(":").pop() : n);
// Words in bold, one after another: "<b>Opus 5.5</b>, <b>Sonnet 4.5</b>".
const Bolds = ({ list }: { list: string[] }) => (
  <>
    {list.map((x, i) => (
      <Fragment key={x}>
        {i ? ", " : ""}
        <b>{x}</b>
      </Fragment>
    ))}
  </>
);

// On its page, the machine it's on, opening the machine's page when it's one of yours, and whether it's off. An
// OpenClaw agent runs on its gateway's machine ("brick"), which a machine of yours reaches.
function AgentMachine({ agent: a, machines }: { agent: AgentRow; machines: { name: string; mine?: boolean; online?: boolean }[] }) {
  if (!a.machine) return null;
  const m = machines.find((x) => x.name === a.machine) || ({} as { mine?: boolean; online?: boolean });
  const link = m.mine ? (
    <a href={machineHref(a.machine)}>
      <b>{a.machine}</b>
    </a>
  ) : (
    <b>{a.machine}</b>
  );
  const off = m.online === false ? ", which is off" : "";
  return (
    <li>
      <Icon name="laptop" />
      <span>
        {a.host && a.host !== a.machine ? (
          <>
            On <b>{a.host}</b>, via {link}
            {off}
          </>
        ) : (
          <>
            On {link}
            {off}
          </>
        )}
      </span>
    </li>
  );
}

// Bring the composer into view, ready to type in, with a flash so you see where it is. (The composer is the core
// area's: this finds its box on the page, a few frames on when the Threads tab is still drawing.)
function focusComposer(tries = 10) {
  const box = document.querySelector<HTMLElement>("[data-launch-text], .compose textarea, .compose [contenteditable]");
  if (!box) return void (tries > 0 && requestAnimationFrame(() => focusComposer(tries - 1)));
  box.focus({ preventScroll: true });
  if (box instanceof HTMLTextAreaElement) box.setSelectionRange(box.value.length, box.value.length);
  box.scrollIntoView({ behavior: "smooth", block: "center" });
  const card = box.closest<HTMLElement>(".compose");
  if (!card) return;
  card.classList.remove("is-flash");
  void card.offsetWidth; // restart the animation
  card.classList.add("is-flash");
}

export function AgentPage() {
  const route = useRoute();
  const username = useApp((s) => s.me?.username);
  const id = route.id;
  const data = useWorld();
  const q = useChrome((s) => s.q);
  const a = data?.agents?.find((x) => x.id === id) as AgentRow | undefined;
  // What the chrome doesn't have: its files and skills, and whether it's in your feed (a contact's). Read again when
  // its threads' files change.
  const view = useLoad<AgentView>(id ? `/api/agents/${enc(id)}` : null, a?.thread_files ?? null);
  // Its routines; read again when one changed, started or finished.
  const routines = useLoad<CronJobs>(a?.routines ? `/api/agents/${enc(id)}/routines` : null, JSON.stringify(a?.routines || null));
  const limits = useLimits(a);
  const folder = useAgentFolder(a);
  // A Worktrees tab only on an agent with some.
  const trees = a ? agentWips(a.id) : [];
  const reading = (data?.folders || []).some((x) => x.sessions && !("wip" in x));
  // A tab it doesn't have, at its address (Worktrees once git's read and it has none, Routines with none): its threads.
  const gone = !!a && ((route.tab === "worktrees" && !trees.length && !reading) || (route.tab === "routines" && !a.routines));
  useEffect(() => {
    if (!gone) return;
    history.replaceState(null, "", agentHref(id));
    followHash();
  }, [gone, id]);
  const tab = gone ? "threads" : route.tab || "threads";
  // Its threads as the server lists them (q/feed, narrowed to it), counted as the search finds them. Threads it's
  // still starting go on top.
  // Its threads, as its bar narrows them (by workspace, by status).
  const ask = useHereAsk("agent", id, q, !!a && tab === "threads");
  const feed = useFeedList(ask);

  if (!a)
    return (
      <div className="shell-msg">
        <p>{id === "~private" ? "This agent is private." : `No agent called ${id} yet.`}</p>
        <a className="btn" href="#/">
          Back to the feed
        </a>
      </div>
    );
  const mine = a.mine !== false;
  const threads = a.sessions || 0;
  const files = view.data?.files || [];
  const awFiles = a.workspace ? folder.aw?.files?.length || 0 : 0;
  const skills = view.data?.skills || [];
  const openTrees = trees.filter((x) => x.state !== "clear").length;
  const on = presence(a);
  const tabLink = (t: string, label: string, n?: number | null) => (
    <a className={tab === t ? "is-on" : ""} href={agentHref(id, t)}>
      {label}
      {n != null && <span className="n">{n}</span>}
    </a>
  );
  const newThread = (e: React.MouseEvent) => {
    e.preventDefault();
    // The composer lives on the Threads tab.
    if (tab !== "threads") go(agentHref(id));
    focusComposer();
  };
  const head = (
    <section className="profile-top" style={hueVars(id)}>
      <div className="profile-in">
        <div className="prof-head ag-head">
          {mine ? <AgentAvatarPicker agent={a} on={on} /> : <Avatar agent={id} size="av--hero" on={on} />}
          <div className="prof-name">
            <AgentHeading agent={a} mine={mine} />
            <p>
              <AgentKind agent={a} version />
              {!mine && (
                <>
                  , <a href={personHref(a.owner)}>@{a.owner}</a>'s
                </>
              )}
            </p>
            {a.bio && <p className="bio">{a.bio}</p>}
            {mine && (
              <p className="prof-vis">
                {a.visibility === "public" ? "Anyone signed in can see it and its threads." : "Only you can see it, and its threads unless you make one public."}
                {a.repos && (
                  <>
                    {" "}
                    <a href={setupHref(username, a.kind, a.machine)}>Key and limits</a>
                  </>
                )}
              </p>
            )}
            <div className="prof-now">
              <AgentNow agent={a} />
              {inactiveAgent(a) && <span className="chip chip--off" title="Activate this agent to start new threads. Existing threads continue.">Inactive</span>}
            </div>
          </div>
          {mine ? (
            <div className="prof-acts">
              <AgentVisSwitch a={a} />
              {startable(a) && (
                <button className="btn btn--dark" type="button" onClick={newThread}>
                  <Icon name="plus" />
                  New thread
                </button>
              )}
            </div>
          ) : (
            <div className="prof-acts ag-follow-acts">
              <FollowMenu id={a.id} name={agentName(a.id)} owner={a.owner || "its owner"} follow={view.data?.follow} reload={view.reload} />
            </div>
          )}
        </div>
        <nav className="tabs" aria-label="Profile">
          {tabLink("about", "About")}
          {tabLink("threads", "Threads", threads)}
          {trees.length > 0 && tabLink("worktrees", "Worktrees", openTrees || null)}
          {tabLink("files", "Files", files.length + awFiles)}
          {tabLink("skills", "Skills", skills.length)}
          {a.routines && tabLink("routines", "Routines", a.routines.n)}
        </nav>
      </div>
    </section>
  );

  // The About tab: these cards, each with a See all to its own tab where it has one.
  const models = [...new Set((a.thread_models || []).map(model).filter(Boolean))];
  const projects = a.thread_repos || [];
  const skillLink = (n: string) => (
    <a key={n} href={skillHref(id, n)}>
      <b>{skillName(n)}</b>
    </a>
  );
  const about =
    tab !== "about" ? null : (
      <>
        <div>
          <section className="card box">
            <h3>About</h3>
            <ul className="facts">
              <AgentMachine agent={a} machines={data?.machines || []} />
              {models.length > 0 && (
                <li>
                  <Icon name="chip" />
                  <span>
                    Runs on <Bolds list={models} />
                  </span>
                </li>
              )}
              {projects.length > 0 && (
                <li>
                  <Icon name="folder" />
                  <span>
                    Works in <Bolds list={projects.slice(0, 6)} />
                    {projects.length > 6 ? ` and ${projects.length - 6} more` : ""}
                  </span>
                </li>
              )}
              {skills.length > 0 && (
                <li>
                  <Icon name="spark" />
                  <span>
                    Skills:{" "}
                    {skills.slice(0, 4).map((k, i) => (
                      <Fragment key={k.name}>
                        {i ? ", " : ""}
                        {skillLink(k.name)}
                      </Fragment>
                    ))}
                    {skills.length > 4 && (
                      <>
                        {" "}
                        and <a href={agentHref(id, "skills")}>{skills.length - 4} more</a>
                      </>
                    )}
                  </span>
                </li>
              )}
              <li>
                <Icon name="steps" />
                <span>
                  <b>{plural(threads, "thread")}</b>, {a.ended || 0} idle
                </span>
              </li>
            </ul>
          </section>
        </div>
        <div>
          <LimitsCard agent={a} limits={limits} />
        </div>
        <div>{a.routines?.n ? <RoutinesCard agent={a} routines={routines.data} /> : null}</div>
        <div>{a.workspace ? <AwCard agent={a} folder={folder} /> : null}</div>
        <div>
          {files.length > 0 && (
            <section className="card box">
              <h3>
                {a.workspace ? "From its threads" : "Files"} <a href={agentHref(id, "files")}>See all</a>
              </h3>
              <div className="files-col">
                {files.slice(0, 6).map((f) => (
                  <FileChip key={f.id} file={f} set={files.slice(0, 6)} />
                ))}
              </div>
            </section>
          )}
        </div>
      </>
    );

  let main: ReactNode = null;
  if (tab === "routines" && a.routines) main = <RoutinesTab agent={a} routines={routines.data} />;
  else if (tab === "worktrees")
    main = (
      <div>
        {trees.length ? (
          <AgentWorktrees agent={a} trees={trees} />
        ) : (
          <section className="card box">
            <p className="muted">Reading git…</p>
          </section>
        )}
      </div>
    );
  else if (tab === "skills")
    main = (
      <div>
        <section className="card box">
          <h3>Skills</h3>
          {skills.length ? (
            <>
              <p className="muted skills-note">What {agentName(a.id)} can use, most used first.</p>
              <ul className="skills">
                {skills.map((k) => {
                  const [plugin, name] = k.name.includes(":") ? k.name.split(":") : [null, k.name];
                  return (
                    <li key={k.name}>
                      <a className="skill" href={skillHref(id, k.name)}>
                        <span className="skill-ico">
                          <Icon name="spark" />
                        </span>
                        <div>
                          <p>
                            <b>{name}</b>
                            {plugin && plugin !== name && <span className="chip">{plugin}</span>}
                            {k.used > 0 && (
                              <span className="skill-used">
                                Used {plural(k.used, "time")}
                                {k.sessions > 1 ? ` in ${k.sessions} threads` : ""}
                              </span>
                            )}
                          </p>
                          {k.description && <small>{k.description}</small>}
                        </div>
                        <span className="skill-go">
                          <Icon name="back" />
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <p className="muted">No skills seen yet. They show up after its first thread.</p>
          )}
        </section>
      </div>
    );
  else if (tab === "files")
    main = (
      <>
        <div>{a.workspace ? <AwBrowser agent={a} folder={folder} /> : null}</div>
        <div>
          {(!a.workspace || files.length > 0) && (
            <section className="card box">
              <h3>{a.workspace ? "From its threads" : "Files"}</h3>
              {files.length ? (
                <div className="files-grid-real">
                  {files.map((f) => (
                    <FileChip key={f.id} file={f} set={files} />
                  ))}
                </div>
              ) : (
                <p className="muted">No files yet.</p>
              )}
            </section>
          )}
        </div>
      </>
    );
  else if (tab === "threads")
    main = (
      <>
        <div>{startable(a) ? <Composer agent={id} /> : null}</div>
        <div>
          <ScopeBar name="agent" bare />
        </div>
        <FeedCards feed={feed} />
        <HereNone name="agent" feed={feed} count={feed?.list.length || 0} />
      </>
    );

  return (
    <>
      {head}
      <div className="prof-body" style={hueVars(id)} data-tab={tab}>
        <div className="prof-col">{about}</div>
        <div className="prof-col">{main}</div>
      </div>
    </>
  );
}
