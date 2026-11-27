import { useState } from "react";
import { agentName, postOwner } from "../lib/agents.ts";
import { post } from "../lib/api.ts";
import { ago, pageStyle } from "../lib/format.ts";
import { pageHref, threadHref } from "../lib/route.ts";
import { agentOf } from "../lib/store.ts";
import { toast } from "../lib/toast.ts";
import type { LaunchRow as Launch, PageRow, Thread } from "../lib/types.ts";
import { Avatar, PersonAvatar, YouAvatar } from "./Avatar.tsx";
import { StatusChip } from "./Chips.tsx";
import { Icon } from "./Icon.tsx";
import { guestsOn } from "./post/PostHead.tsx";
import { Hl } from "./post/util.tsx";
import { plainMentions } from "../lib/mentions.tsx";

export interface RowOpts {
  // false where every row has the same one (a worktree's project, the agent whose other threads they are).
  repo?: boolean;
  agent?: boolean;
}
// A thread as a row: its agent, its title, who and where, its status, and when.
export function ThreadRow({ thread: s, repo = true, agent = true }: { thread: Thread } & RowOpts) {
  // A thread of yours: your face, and who's in it.
  if (s.talk) {
    const gs = guestsOn(s);
    const where = [s.mine === false ? `@${s.owner}'s` : "Yours", gs.length ? `with ${gs.map((g) => agentOf(g.agent).name).join(", ")}` : ""].filter(Boolean).join(" · ");
    return (
      <a className="act-row" href={threadHref(s.id)}>
        {s.mine === false ? <PersonAvatar who={s.owner} /> : <YouAvatar />}
        <span>
          <b>
            <Hl text={s.title} />
          </b>
          <small>{where}</small>
        </span>
        {s.effective === "needs" ? (
          <span className="chip chip--sun">Needs you</span>
        ) : s.effective === "working" ? (
          <span className="chip chip--live">
            <i className="pulse" />
            Working
          </span>
        ) : null}
        <time>{ago(s.updated || s.started)}</time>
      </a>
    );
  }
  const where = [agent ? agentName(s.agent) : "", repo && s.repo ? s.repo : "", s.mine === false ? `@${postOwner(s)}'s` : ""].filter(Boolean).join(" · ");
  return (
    <a className="act-row" href={threadHref(s.id)}>
      <Avatar agent={s.agent} size="av--sm" on={s.effective === "working" ? "active" : false} />
      <span>
        <b>
          {s.pinned && (
            <span className="row-pin" title="Pinned">
              <Icon name="pin" />
            </span>
          )}
          <Hl text={s.title || s.label} />
        </b>
        <small>{where}</small>
      </span>
      <StatusChip thread={s} />
      <time>{ago(s.updated || s.started)}</time>
    </a>
  );
}
export function ThreadRows({ list, ...opts }: { list: Thread[] } & RowOpts) {
  if (!list.length) return null;
  return (
    <ul className="act-list">
      {list.map((t) => (
        <li key={t.id}>
          <ThreadRow thread={t} {...opts} />
        </li>
      ))}
    </ul>
  );
}
export function PageRowLine({ page: p }: { page: PageRow }) {
  return (
    <a className="act-row" href={pageHref(p)} style={pageStyle(p)}>
      <span className="pg-ico">{p.emoji || "📄"}</span>
      <span>
        <b>
          <Hl text={p.title} />
        </b>
        <small>
          v{p.version}
          {p.last?.summary ? `: ${p.last.summary}` : ""}
        </small>
      </span>
      <span className="chip chip--page">
        <Icon name="page" />
        Page
      </span>
      <time>{ago(p.updated)}</time>
    </a>
  );
}

// A Claude Code session that couldn't start because Claude Code doesn't trust its folder yet: agentbook can
// trust it, as Claude Code's trust prompt there would, and start it again.
export const untrustedStart = (l: Launch) => /^Workspace not trusted\. Run `claude` in /.test(l.error || "") && !!l.named && !l.resume && !l.teleport;
// Trust and retry: agentbook trusts its folder, and it starts again.
export function TrustButton({ launch: l, className }: { launch: Launch; className?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={className}
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const r = await post(`/api/launches/${encodeURIComponent(l.id)}/trust`, {});
        if (!r.ok) setBusy(false);
      }}
    >
      {className ? null : <Icon name="check" />}
      Trust and retry
    </button>
  );
}
export function ArchiveLaunch({ launch: l, className, children }: { launch: Launch; className?: string; children: React.ReactNode }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={className}
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const r = await post<{ cancelled?: boolean }>(`/api/launches/${encodeURIComponent(l.id)}/archive`, {});
        if (r.ok) toast(r.data.cancelled ? "Taken back: it won't start." : "Archived.");
        else setBusy(false);
      }}
    >
      {children}
    </button>
  );
}

// One starting has no thread to open yet; one that couldn't start says why, with what its card offers.
export function LaunchRow({ launch: l }: { launch: Launch }) {
  const title = l.teleport ? l.prompt.replace(/^https:\/\//, "") : plainMentions(l.prompt.split("\n")[0]);
  const chip = l.error ? (
    <span className="chip">Couldn't start</span>
  ) : l.waiting ? (
    <span className="chip chip--off">Waits for {l.waiting}</span>
  ) : (
    <span className="chip chip--live">
      <i className="pulse" />
      {l.teleport ? "Teleporting" : l.cloning ? "Cloning" : l.progress?.total ? `${Math.floor((l.progress.done / l.progress.total) * 100)}%` : "Starting"}
    </span>
  );
  return (
    <div className="act-row">
      <Avatar agent={l.agent} size="av--sm" on={!l.error} />
      <span>
        <b>{title}</b>
        <small className={l.error ? "err" : undefined}>{l.error ? l.error : `${agentName(l.agent)} · ${l.step || (l.root || "").split("/").pop()}`}</small>
      </span>
      {chip}
      {untrustedStart(l) && <TrustButton launch={l} className="btn btn--sm" />}
      {(l.error || l.waiting) && (
        <ArchiveLaunch launch={l} className="btn btn--sm">
          {l.waiting ? "Take it back" : "Archive"}
        </ArchiveLaunch>
      )}
      <time>{ago(l.at)}</time>
    </div>
  );
}
