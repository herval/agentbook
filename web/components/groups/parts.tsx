// The pieces of the group screens: a group's row in Groups, the New group form, a group's head (its name, who made it,
// who's in it, who sees it, what's going on in it, and its tabs), and the small things they share. Ported from the
// old page's groupListRow, newGroupForm, groupNow, groupVisText and groupHead.
import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { agentName, hiddenAgent, seniority, startable } from "../../lib/agents.ts";
import { post } from "../../lib/api.ts";
import { ago, agoText, groupStyle, hueVars, plural } from "../../lib/format.ts";
import { setDraft, useDraft } from "../../lib/hooks.ts";
import { groupHref, personHref } from "../../lib/route.ts";
import { threadRow, useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { GroupRow, Visibility } from "../../lib/types.ts";
import type { By } from "../../../plugin/shared/types.ts";
import { Avatar, PersonAvatar, YouAvatar } from "../Avatar.tsx";
import { Icon } from "../Icon.tsx";
import { GroupCorner, levelOf, VisCorner } from "../Visibility.tsx";
import type { Wip } from "../worktrees/wips.ts";
import { fileBase, groupAt, groupIn, groupMine, groupPeople, groupPublic, groupThreads, useGroupUi, when } from "./groups.ts";



export function ByFace({ by, size = "av--xs" }: { by: By | null | undefined; size?: string }) {
  const me = useApp((s) => s.me?.username);
  if (by?.post || by?.agent) return <Avatar agent={by.agent || threadRow(by.post)?.agent} size={size} />;
  if (by?.user) return by.user === me ? <YouAvatar size={size} /> : <PersonAvatar who={by.user} size={size} />;
  return (
    <span className={`av ${size}`}>
      <Icon name="laptop" />
    </span>
  );
}

export function WipDot({ w }: { w: Wip }) {
  if (w.kind === "pr" && w.pr.state === "closed")
    return (
      <span className="wip-dot wip-dot--closed">
        <Icon name="x" />
      </span>
    );
  if (w.state === "clear")
    return (
      <span className={`wip-dot${w.kind === "pr" ? " wip-dot--merged" : ""}`}>
        <Icon name="check" />
      </span>
    );
  return (
    <span className="wip-dot">
      <i className={`dot dot--${w.state}${w.stale ? " dot--stale" : ""}`}></i>
    </span>
  );
}

// Copy something, and say what to do with it (the old page's data-copy).
export const copyIt = (text: string) => navigator.clipboard?.writeText(text).then(
  () => toast("Copied. Paste it in a terminal."),
  () => toast("Copied. Paste it in a terminal."),
);

function GroupNow({ g }: { g: GroupRow }) {
  if (g.archived) return null;
  const ts = groupThreads(g);
  const needs = ts.filter((s) => s.effective === "needs");
  const live = ts.filter((s) => s.effective === "working");
  return (
    <>
      {needs.length ? (
        <span className="st-pill st-pill--needs" title={needs[0].title}>
          <Avatar agent={needs[0].agent} size="av--xs" />
          {needs.length === 1 ? `${needs[0].label} needs you` : `${needs.length} need you`}
        </span>
      ) : null}
      {live.length === 1 ? (
        <span className="st-pill" style={hueVars(live[0].agent)} title={live[0].title}>
          <Avatar agent={live[0].agent} size="av--xs" />
          {live[0].label}
          <i className="pulse"></i>
        </span>
      ) : live.length ? (
        <span className="st-pill" title={live.map((s) => s.label).join(", ")}>
          {live.length} live<i className="pulse"></i>
        </span>
      ) : null}
    </>
  );
}

// A group in Groups: its icon, name, who sees it and what's going on; whose it is and its brief's first line; its
// threads and files counted; who's in it; and when anything last happened in it.
export function GroupListRow({ g }: { g: GroupRow }) {
  useApp((s) => s.rows);
  const brief = (String(g.brief || "").split("\n").find((l) => l.trim()) || "").replace(/^[#>\s-]+|[*`_]/g, "");
  const agents = (g.members || []).filter((m) => m.agent);
  const people = groupPeople(g);
  const at = groupAt(g);
  const tip = at ? `Last change ${when(at)}${g.last_file ? `; ${fileBase(g.last_file.path)} ${agoText(g.last_file.at)}` : ""}` : "";
  return (
    <a className={`ls-r${g.archived ? " is-off" : ""}`} href={groupHref(g)} style={groupStyle(g)}>
      <span className="gr-ico ls-face">{g.emoji || "👥"}</span>
      <span className="ls-t">
        <b>{g.name}</b>
        <GroupCorner g={g} cls=" vis-corner--sm" />
        <GroupNow g={g} />
      </span>
      <span className="ls-sub">
        {groupMine(g) ? "" : `@${g.owner || "?"}'s · `}
        {brief ? brief : <span className="muted">No brief yet</span>}
      </span>
      <span className="ls-nums ls-counts">
        <span>{plural(g.posts || 0, "thread")}</span>
        <span>{plural(g.files || 0, "file")}</span>
      </span>
      <span className="ls-avs">
        <span className="avs">
          {people.map((u) => (
            <PersonAvatar key={`u:${u}`} who={u} size="av--xs" />
          ))}
          {agents.map((m) => (
            <Avatar key={`a:${m.agent}`} agent={m.agent} size="av--xs" />
          ))}
        </span>
      </span>
      <span className="ls-when" title={tip}>
        <b>{ago(at) || ""}</b>
      </span>
    </a>
  );
}

// Every group, and making one. It starts private, unless you pick public. A thread it starts with (`post`) goes in
// it; its name and brief are drafts while you write them.
export function NewGroupForm({ post: postId = null }: { post?: string | null }) {
  const data = useApp((s) => s.data);
  const vis = useGroupUi((s) => s.groupNewVis);
  const [name, setName] = useDraft("group-name");
  const [brief, setBrief] = useDraft("group-brief");
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const agents = (data?.agents || []).filter((a) => a.mine !== false && startable(a) && !hiddenAgent(a)).sort((a, b) => seniority(a).localeCompare(seniority(b)));
  const s = postId ? threadRow(postId) : null;
  useEffect(() => {
    const t = setTimeout(() => nameRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);
  // Make it: its page opens.
  const make = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    const res = await post<{ id: string }>("/api/groups", { name: f.get("name"), emoji: f.get("emoji"), brief: f.get("brief"), visibility: levelOf(vis) || "private", agents: f.getAll("agents"), post: f.get("post") || undefined });
    setBusy(false);
    if (!res.ok) return;
    useGroupUi.setState({ groupNew: false, groupNewPost: null, groupNewVis: null });
    setDraft("group-name", "");
    setDraft("group-brief", "");
    location.hash = `#/groups/${encodeURIComponent(res.data.id)}`;
    toast(f.get("post") ? `${f.get("name")} is made, with ${threadRow(String(f.get("post")))?.label || "the thread"} in it.` : `${f.get("name")} is made. Start a thread in it, or add one.`);
  };
  return (
    <section className="card box gnf">
      <form onSubmit={make}>
        <h3>New group</h3>
        <div className="gnf-name">
          <input className="gnf-emoji" name="emoji" defaultValue="👥" maxLength={16} aria-label="Its emoji" title="Its emoji" />
          <input ref={nameRef} name="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="What's it for? e.g. agentbook 0.5" aria-label="Its name" required />
        </div>
        <textarea name="brief" rows={3} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="Its brief: the goal, the ground rules, where things go. Every thread in it is told this, and you can change it any time." aria-label="Its brief" />
        {agents.length ? (
          <div className="gnf-who">
            <span className="muted">Its agents</span>
            {agents.map((a) => (
              <label key={a.id}>
                <Avatar agent={a.id} size="av--xs" />
                <input type="checkbox" name="agents" value={a.id} defaultChecked={a.id === s?.agent || (!s && a.id === agents[0]?.id)} />
                {agentName(a.id)}
              </label>
            ))}
          </div>
        ) : null}
        {s ? <input type="hidden" name="post" value={s.id} /> : null}
        <div className="gnf-acts">
          <p className="muted">{s ? `${s.label} goes in it, and hears about it with its next message.` : "Its files start empty, in a folder of its own that its threads can write."}</p>
          <span className="gnf-vis">
            <VisCorner kind="groupNew" id="" level={vis} label words={{ private: "you and the people you add", public: "you, the people in it and your contacts" }} onPick={(lv: Visibility) => useGroupUi.setState({ groupNewVis: lv })} />
            <input type="hidden" name="visibility" value={levelOf(vis)} />
          </span>
          <button className="btn" type="button" onClick={() => useGroupUi.setState({ groupNew: false, groupNewPost: null })}>
            Cancel
          </button>
          <button className="btn btn--dark" type="submit" disabled={busy}>
            Make it
          </button>
        </div>
      </form>
    </section>
  );
}

// Who sees it, said in words under its name (its corner, GroupCorner, changes it).
function groupVisText(g: GroupRow & { in?: boolean }) {
  if (g.archived) return "It's archived: its threads don't hear from it.";
  const people = groupPeople(g).length;
  if (g.in && !groupMine(g)) return `@${g.owner}'s group, and you're in it: you see every thread in it, and add yours, notes and files.`;
  if (!groupMine(g)) return `@${g.owner}'s group. You see its brief, its files, and the threads in it you'd see anyway.`;
  const with_ = people ? `You and ${people} ${people === 1 ? "person" : "people"} in it see every thread in it` : "Only you see it";
  return groupPublic(g) ? `${people ? `${with_}. ` : ""}Your contacts see its brief, its files, and the threads in it that are public. Only you change who's in it.` : `${with_}. Every thread in it sees the others, and its files.`;
}

// A group's head: its icon and name, who made it and who's in it, who sees it, what's going on in it (live, needs
// you, its newest file), its link and corner; then its tabs (Group, Members, and Brief for the people in it).
export function GroupHead({ g, tab }: { g: GroupRow; tab: string }) {
  useApp((s) => s.rows);
  const ts = groupThreads(g);
  const live = ts.filter((s) => s.effective === "working").length;
  const needs = ts.filter((s) => s.effective === "needs").length;
  const agents = (g.members || []).filter((m) => m.agent);
  const people = groupPeople(g);
  const last = g.last_file;
  const n = (t: string, label: string, count?: number) => (
    <a className={tab === t ? "is-on" : ""} href={groupHref(g, t === "group" ? "" : t)}>
      {label}
      {count != null ? <span className="n">{count}</span> : null}
    </a>
  );
  const owner = g.owner || "?";
  return (
    <>
      <div className="prof-head gr-head">
        <span className="gr-hero">{g.emoji || "👥"}</span>
        <div className="prof-name">
          <h1>{g.name}</h1>
          <p className="pg-by">
            {groupMine(g) ? (
              <>
                A group by <YouAvatar size="av--xs" />
                <b>you</b>
              </>
            ) : (
              <>
                A group by <PersonAvatar who={owner} size="av--xs" letter={owner[0].toUpperCase()} />
                <a href={personHref(g.owner)}>
                  <b>@{g.owner}</b>
                </a>
              </>
            )}
            <span className="sep">·</span>
            <span className="avs">
              {people.map((u) => (
                <PersonAvatar key={`u:${u}`} who={u} size="av--xs" />
              ))}
              {agents.map((m) => (
                <Avatar key={`a:${m.agent}`} agent={m.agent} size="av--xs" />
              ))}
            </span>
            <a href={groupHref(g, "members")}>{plural(agents.length + people.length + 1, "member")}</a>
          </p>
          <p className="prof-vis">{groupVisText(g)}</p>
          <div className="prof-now">
            {live ? (
              <span className="chip chip--live">
                <i className="pulse"></i>
                {live} live
              </span>
            ) : null}
            {needs ? (
              <span className="chip chip--sun">
                {needs} need{needs === 1 ? "s" : ""} you
              </span>
            ) : null}
            {last ? (
              <a className="chip" href={groupHref(g, `files/${last.path}`)}>
                <Icon name="file" />
                {fileBase(last.path)}, {agoText(last.at)}
              </a>
            ) : null}
          </div>
        </div>
        <div className="prof-acts">
          <button className="icon-btn" type="button" aria-label="Copy its link" title="Copy its link" onClick={() => copyIt(location.origin + location.pathname + groupHref(g))}>
            <Icon name="link" />
          </button>
          <GroupCorner g={g} cls=" vis-corner--head" />
        </div>
      </div>
      <nav className="tabs" aria-label="Group">
        {n("group", "Group")}
        {n("members", "Members", agents.length + people.length + 1)}
        {groupIn(g) ? n("brief", "Brief") : null}
      </nav>
    </>
  );
}
