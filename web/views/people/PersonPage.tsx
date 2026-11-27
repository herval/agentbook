// Your Agents tab groups machines, agents, routines and workspaces; other profiles show their shared agents.
import { Fragment, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { agentName, postOwner, presence, repoName, sortAgents, workspaces } from "../../lib/agents.ts";
import { post } from "../../lib/api.ts";
import { useChrome } from "../../lib/chrome.ts";
import { ago, agoText, pageStyle, plural } from "../../lib/format.ts";
import { useLoad } from "../../lib/hooks.ts";
import { agentHref, pageHref, personHref, setupHref, threadHref, useRoute, workspaceHref } from "../../lib/route.ts";
import { found, haystack } from "../../lib/search.ts";
import { allRows, getApp, setApp, useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { ContactsList, DoorStatus, Passkeys, Person, PersonView, TheirThings as TheirThingsView, Thread } from "../../lib/types.ts";
import { Avatar, PersonAvatar } from "../../components/Avatar.tsx";
import { StatusChip } from "../../components/Chips.tsx";
import { Icon } from "../../components/Icon.tsx";
import { LevelChip, levelOf } from "../../components/Visibility.tsx";
import { PersonNow } from "../../components/agents/AgentNow.tsx";
import { AgentGroups } from "../../components/agents/AgentList.tsx";
import { YourAvatarPicker } from "../../components/agents/AvatarPicker.tsx";
import type { AgentRow } from "../../components/agents/types.ts";
import { agentsOf, busyFirst, day, isMe, KINDS, machinesOf } from "../../components/agents/words.ts";
import { byName, inFilter, shelf } from "../../components/pages/pages.ts";
import type { PageRec } from "../../components/pages/pages.ts";
import { ContactsBox, PersonContactActs } from "../../components/people/Contacts.tsx";
import { AccountBox } from "../../components/people/Machines.tsx";
import { MachineAgents } from "../../components/people/MachineAgents.tsx";
import { SettingsCards, SettingsNav } from "../../components/people/Settings.tsx";
import { ConnectorsPanel } from "../tasks/Connectors.tsx";
import { TheirTab, TheirThing } from "../../components/people/TheirThings.tsx";
import { Hl, searchTerms } from "../../components/post/util.tsx";

const enc = encodeURIComponent;
const PERSON_TABS: [string, string][] = [
  ["about", "About"],
  ["threads", "Threads"],
  ["agents", "Agents"],
  ["pages", "Pages"],
];
const OLD_TABS = ["routines", "workspaces", "machines"];
const PERSON_FILTERS: [string, string][] = [
  ["all", "All"],
  ["working", "Running"],
  ["needs", "Needs you"],
  ["done", "Idle"],
];

// Words in bold, one after another: "<b>a</b>, <b>b</b>", or with `and`, as listText says them: "<b>a</b>, <b>b</b>
// and <b>c</b>".
const Bolds = ({ list, and = false }: { list: string[]; and?: boolean }) => (
  <>
    {list.map((x, i) => (
      <Fragment key={x}>
        {i ? (and && i === list.length - 1 ? " and " : ", ") : ""}
        <b>{x}</b>
      </Fragment>
    ))}
  </>
);

// Your name and line are edited where they show. The form keeps what you type while the rest updates.
function ProfileEdit({ u, handle, done }: { u: Person; handle: ReactNode; done: () => void }) {
  const name = useRef<HTMLInputElement>(null);
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const r = await post<{ user: Person }>("/api/me", Object.fromEntries(new FormData(e.currentTarget)));
    if (!r.ok) return;
    const s = getApp();
    setApp({ me: r.data.user, ...(s.people ? { people: s.people.map((x) => (x.id === r.data.user.id ? r.data.user : x)) } : {}) });
    toast("Saved.");
    done();
  };
  return (
    <form className="prof-edit" id="profile-edit" onSubmit={submit}>
      <input ref={name} name="display_name" defaultValue={u.display_name} maxLength={60} aria-label="Your name" autoComplete="name" autoFocus />
      {handle}
      <textarea name="bio" rows={2} maxLength={500} aria-label="About you" placeholder="A line about you, for everyone here" defaultValue={u.bio} />
      <small>Everyone signed in here sees your name and this line.</small>
    </form>
  );
}


export function PersonPage() {
  const route = useRoute();
  const id = route.id;
  const s = useApp();
  const me = isMe(id, s);
  useEffect(() => {
    if (me && route.old && route.tab === "agents") location.replace(setupHref(id, route.open, route.machine));
  }, [me, id, route.old, route.tab, route.open, route.machine]);
  const yours = s.me?.role === "admin";
  const q = useChrome((c) => c.q);
  const [editing, setEditing] = useState(false);
  const [filter, setFilter] = useState("all");
  const [showAll, setShowAll] = useState(false);
  // Your Contacts box takes a new ask, or a yes to yours, as the bell hears it, on the page already open.
  const heard = (s.data?.added || []).filter((x) => x.kind === "contact-ask" || x.kind === "contact").map((x) => `${x.kind}:${x.id}:${x.by}:${x.at}`).join("|");
  const person = useLoad<PersonView>(`/api/people/${enc(id)}`, heard);
  // Someone elsewhere: what their door sent you (TheirThings.tsx), in place of what this page has of theirs.
  const remote = !me && !!person.data?.remote;
  const things = useLoad<TheirThingsView>(remote ? `/api/people/${enc(id)}/things` : null, heard);
  const keys = useLoad<Passkeys>(me ? "/api/passkeys" : null, heard);
  const contacts = useLoad<ContactsList>(me ? "/api/contacts" : null, heard);
  const reload = () => Promise.all([person.reload(), keys.reload(), contacts.reload(), things.reload()]);
  const p = person.data ? { ...person.data, id } : person.missing ? { id, missing: true } : null;

  const u: Person | undefined = me ? s.me : p?.user || s.people?.find((x) => x.username === id);
  if (!u)
    return p?.missing ? (
      <div className="shell-msg">
        <p>No one called {id} here.</p>
        <a className="btn" href="#/people">
          Everyone here
        </a>
      </div>
    ) : (
      <div className="shell-msg">
        <p className="muted">Loading…</p>
      </div>
    );

  const tab = me ? (OLD_TABS.includes(route.tab) ? "agents" : route.tab) : ["settings", ...OLD_TABS].includes(route.tab) ? "threads" : route.tab;
  const agents = sortAgents(agentsOf(id, s)) as AgentRow[];
  // A person's threads: yours, or the ones someone else made public.
  const threads = allRows(s).filter((x) => (me ? x.mine !== false : x.mine === false && postOwner(x) === id) && !shelf(x));
  const pages = (s.data?.pages || []).filter((x) => !x.archived && (me ? x.mine : !x.mine && x.owner === id)) as unknown as PageRec[];
  const href = (k: string) => personHref(id, k === "threads" ? "" : k);
  const first = u.display_name.split(" ")[0];

  const handle = (
    <p className="handle">
      <span>@{u.username}</span>
      {p?.remote && p.remote.handle !== u.username ? <span>Goes by @{p.remote.handle}</span> : null}
      {p?.remote ? <span>On their own agentbook</span> : <span>Joined {day(u.created)}</span>}
      {u.deleted ? <span>Account deleted</span> : u.disabled ? <span>Account disabled</span> : null}
    </p>
  );
  const editNow = me && editing;
  const name = editNow ? (
    <ProfileEdit u={u} handle={handle} done={() => (setEditing(false), reload())} />
  ) : (
    <>
      <h1>{u.display_name}</h1>
      {handle}
      {me && p?.door ? <DoorLine door={p.door} /> : null}
      {u.bio ? (
        <p className="bio">{u.bio}</p>
      ) : me ? (
        <button className="bio-add" type="button" onClick={() => setEditing(true)}>
          Add a line about you
        </button>
      ) : null}
      <div className="prof-now">
        <PersonNow username={id} />
      </div>
    </>
  );
  const acts = !me ? (
    p?.contact && !u.deleted ? (
      <div className="prof-acts">
        <PersonContactActs u={u} c={p.contact} reload={reload} />
      </div>
    ) : null
  ) : editNow ? (
    <div className="prof-acts">
      <button className="btn" type="button" onClick={() => setEditing(false)}>
        Cancel
      </button>
      <button className="btn btn--dark" type="submit" form="profile-edit">
        Save
      </button>
    </div>
  ) : (
    <div className="prof-acts">
      <button className="btn btn--line" type="button" onClick={() => setEditing(true)}>
        <Icon name="pencil" />
        Edit profile
      </button>
    </div>
  );
  const routines = (s.data?.routines || []).filter((r) => !r.archived);
  const waiting = me ? routines.filter((r) => r.waiting).length : 0;
  const counts: Record<string, number> = remote
    ? { threads: things.data?.threads.length || 0, agents: things.data?.agents.length || 0, pages: things.data?.pages.length || 0 }
    : { threads: threads.length, agents: agents.length, pages: pages.length, routines: me ? routines.length : 0, workspaces: me ? workspaces().length : 0, machines: me ? (p?.devices || (s.data?.machines || []).filter((m) => m.mine)).length : 0 };
  // A routine waiting for your OK says so on its tab, as it did on the sidebar's Routines.
  const n = (k: string) =>
    k === "about" ? null : k === "routines" && waiting ? (
      <span className="n badge" title={`${plural(waiting, "routine")} waiting for your OK`}>
        {waiting}
      </span>
    ) : (
      <span className="n">{counts[k]}</span>
    );
  const top = (
    <section className="profile-top person-top">
      <div className="profile-in">
        <div className="prof-head">
          {me ? <YourAvatarPicker /> : <PersonAvatar who={u} size="av--hero" />}
          <div className="prof-name">{name}</div>
          {acts}
        </div>
        <nav className="tabs" aria-label="Profile">
          {PERSON_TABS.map(([k, label]) => (
            <a key={k} className={tab === k ? "is-on" : ""} href={href(k)}>
              {label}
              {n(k)}
            </a>
          ))}
          {me && (
            <a className={`tab-end ${tab === "settings" ? "is-on" : ""}`} href={href("settings")}>
              <Icon name="gear" />
              Settings
            </a>
          )}
        </nav>
      </div>
    </section>
  );

  // Someone elsewhere: theirs as their door sent it, read only.
  if (remote)
    return (
      <>
        {top}
        <div className="prof-body person-top" data-tab={route.thing ? "threads" : tab}>
          <div className="prof-col" />
          <div className="prof-col">{route.thing && things.data ? <TheirThing who={u} id={route.thing} things={things.data} /> : <TheirTab who={u} tab={tab} things={things.data} reload={reload} />}</div>
        </div>
      </>
    );

  // Each tab is one column of what it shows (agentbook.css), but Settings, its menu beside it.
  if (tab === "settings") {
    const isConnectors = route.sub === "connectors";
    const ready = isConnectors || (!!person.data && (!me || keys.data || keys.error));
    return (
      <>
        {top}
        <div className={`prof-body person-top${isConnectors ? " prof-body--connectors" : ""}`}>
          <div className="prof-col">{(ready || route.sub) && <SettingsNav username={id} sub={route.sub} keys={keys.data} />}</div>
          <div className="prof-col">
            {isConnectors ? <ConnectorsPanel /> : ready ? <SettingsCards keys={keys.data} reload={reload} /> : <p className="muted">Loading…</p>}
          </div>
        </div>
      </>
    );
  }

  // The About tab: who they are, in facts, their agents, each opening its profile, and on yours, your Follows.
  const repos = [...new Set(threads.map((x) => x.repo).filter(Boolean))];
  const where = machinesOf(agents);
  const idle = threads.filter((x) => ["done", "idle"].includes(x.effective)).length;
  const about =
    tab !== "about" ? null : (
      <>
        <div>
          <section className="card box">
            <h3>About</h3>
            <ul className="facts">
              <li>
                <Icon name="bot" />
                <span>
                  {agents.length ? (
                    <>
                      {me ? "Runs" : "Shares"} <b>{plural(agents.length, me ? "agent" : "public agent")}</b>
                      {where.length > 0 && (
                        <>
                          {" "}
                          on <Bolds list={where} and />
                        </>
                      )}
                    </>
                  ) : me ? (
                    "No agents yet"
                  ) : (
                    "No public agents yet"
                  )}
                </span>
              </li>
              {repos.length > 0 && (
                <li>
                  <Icon name="folder" />
                  <span>
                    Works in <Bolds list={repos.slice(0, 4)} />
                    {repos.length > 4 ? ` and ${repos.length - 4} more` : ""}
                  </span>
                </li>
              )}
              {threads.length > 0 && (
                <li>
                  <Icon name="steps" />
                  <span>
                    <b>{plural(threads.length, me ? "thread" : "public thread")}</b>, {idle} idle
                  </span>
                </li>
              )}
              {pages.length > 0 && (
                <li>
                  <Icon name="page" />
                  <span>
                    Keeps <b>{plural(pages.length, me ? "page" : "public page")}</b>
                  </span>
                </li>
              )}
              <li>
                <Icon name="clock" />
                <span>Joined {day(u.created)}</span>
              </li>
            </ul>
          </section>
        </div>
        <div>
          {agents.length > 0 && (
            <section className="card box">
              <h3>
                Agents
                {agents.length > 5 && <a href={href("agents")}>See all</a>}
              </h3>
              <ul className="act-list">
                {agents.slice(0, 5).map((a) => (
                  <li key={a.id}>
                    <a className="act-row" href={agentHref(a.id)}>
                      <Avatar agent={a.id} size="av--sm" on={presence(a)} />
                      <span>
                        <b>{agentName(a.id)}</b>
                        <small>{KINDS[a.kind] || a.kind}</small>
                      </span>
                      {a.offline ? (
                        <span className="chip chip--off">Offline</span>
                      ) : a.working ? (
                        <span className="chip chip--live" title={`${plural(a.working, "thread")} running`}>
                          <i className="pulse" />
                          {a.working}
                        </span>
                      ) : null}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
        <div>{me && !u.deleted ? <ContactsBox contacts={contacts.data?.contacts ? contacts.data : null} reload={reload} /> : null}</div>
        <div>
          {/* Their workspaces you may see, each opening its page, to read. */}
          {!me && Array.isArray(p?.workspaces) && p.workspaces.length > 0 && (
            <section className="card box">
              <h3>Workspaces</h3>
              <ul className="act-list">
                {p.workspaces.map((w) => (
                  <li key={w.id}>
                    <a className="act-row" href={workspaceHref(w.id)}>
                      <span className="pg-ico">
                        <Icon name={w.repo ? "repo" : "folder"} />
                      </span>
                      <span>
                        <b>{w.name}</b>
                        <small>{w.repo ? repoName(w.repo) : "A folder"}</small>
                      </span>
                      <LevelChip level={levelOf(w.visibility)} />
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
        <div>{!me && yours && p?.user ? <AccountBox p={p} reload={reload} /> : null}</div>
      </>
    );

  let main: ReactNode = null;
  if (tab === "agents") {
    const sorted = [...agents].sort(busyFirst);
    main = me ? <MachineAgents agents={sorted} person={p && !p.missing ? p : null} reload={reload} /> : (
      <section className="card box">
        <h3>Agents</h3>
        {me || agents.length ? (
          <AgentGroups key={id} agents={sorted} manage={me} profile />
        ) : <p className="list-empty">{first}'s agents are private. One shows up here once they make it public.</p>}
      </section>
    );
  } else if (tab === "pages")
    main = (
      <section className="card box">
        <h3>Pages</h3>
        {pages.length ? (
          <ul className="act-list">
            {pages.map((pg) => (
              <li key={pg.id}>
                <a className="act-row" href={pageHref(pg)} style={pageStyle(pg)}>
                  <span className="pg-ico">{pg.emoji || "📄"}</span>
                  <span>
                    <b>{pg.title}</b>
                    <small>
                      v{pg.version}, changed {agoText(pg.updated)} by {byName(pg, pg.last?.by)}
                    </small>
                  </span>
                  <LevelChip level={levelOf(pg.visibility)} />
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="list-empty">
            {me ? (
              <>
                No pages yet. Ask an agent for one on <a href="#/pages">Pages</a>.
              </>
            ) : (
              `${first} hasn't made a page public yet.`
            )}
          </p>
        )}
      </section>
    );
  else if (tab !== "about") {
    // Their threads, one list, the one worked on last first. The search narrows it, as it does an agent's.
    const filters = PERSON_FILTERS.filter(([k]) => me || k !== "needs");
    const f = filters.some(([k]) => k === filter) ? filter : "all";
    // (A row has its title, its name, its project and its branch, not its messages.)
    const terms = searchTerms(q, s);
    const matched = threads.filter((x) => !q || terms.every((t) => found(haystack([x.title, x.label, x.repo, x.branch].filter(Boolean).join(" ")), t)));
    const shown = matched.filter((x) => inFilter(x, f)).sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
    const max = showAll ? Infinity : 40;
    const row = (x: Thread) => (
      <li key={x.id}>
        <a className="act-row" href={threadHref(x.id)}>
          <Avatar agent={x.agent} size="av--sm" on={x.effective === "working" ? "active" : false} />
          <span>
            <b>
              <Hl text={x.title || x.label} />
            </b>
            <small>
              {agentName(x.agent)}
              {x.repo ? ` · ${x.repo}` : ""}
            </small>
          </span>
          <StatusChip thread={x} />
          <time>{ago(x.updated)}</time>
        </a>
      </li>
    );
    const empty = !threads.length ? (me ? "No threads yet. Start one from the feed." : `${first} hasn't made a thread public yet. What they share shows up here.`) : q ? "Nothing here matches your search." : "None here.";
    main = (
      <section className="card box">
        <div className="list-h">
          <h3>Threads</h3>
          {threads.length > 0 &&
            filters.map(([k, label]) => (
              <a
                key={k}
                className={`pill ${f === k ? "is-on" : ""}`}
                href={href("threads")}
                onClick={(e) => {
                  e.preventDefault();
                  setFilter(f === k ? "all" : k);
                  setShowAll(false);
                }}
              >
                {label} {matched.filter((x) => inFilter(x, k)).length}
              </a>
            ))}
        </div>
        {shown.length ? <ul className="act-list">{shown.slice(0, max).map(row)}</ul> : <p className="list-empty">{empty}</p>}
        {shown.length > max && (
          <button className="btn btn--sm act-more" type="button" onClick={() => setShowAll(true)}>
            Show all {shown.length}
          </button>
        )}
      </section>
    );
  }

  return (
    <>
      {top}
      <div className="prof-body person-top" data-tab={tab}>
        <div className="prof-col">{about}</div>
        <div className="prof-col">{main}</div>
      </div>
    </>
  );
}

// Your door (server/door.ts), and your invite link: how someone on another agentbook follows you, since nobody can
// look anyone up. You give it to whoever you like; it says who you are and where your door is, and nothing else.
function DoorLine({ door }: { door: DoorStatus }) {
  const copy = () => {
    if (!door.invite) return;
    navigator.clipboard?.writeText(door.invite).then(
      () => toast("Your invite link is copied: send it to them yourself."),
      () => toast("It didn't copy: select the link and copy it."),
    );
  };
  return (
    <div className="door-line">
      {door.state === "up" && door.invite ? (
        <>
          <span>People on other agentbooks follow you by your invite link, which you give them.</span>
          <span className="door-invite">
            <input readOnly value={door.invite} aria-label="Your invite link" onFocus={(e) => e.currentTarget.select()} />
            <button className="btn btn--dark btn--sm" type="button" onClick={copy}>
              Copy
            </button>
          </span>
        </>
      ) : door.state === "elsewhere" ? (
        <span>Your door runs on {door.machine}: your invite link and following people on other agentbooks are on its page.</span>
      ) : door.state === "starting" ? (
        <span>Your door is starting.</span>
      ) : (
        <span>No door here, so nobody elsewhere can follow you yet{door.why ? `: ${door.why}` : "."}</span>
      )}
    </div>
  );
}
