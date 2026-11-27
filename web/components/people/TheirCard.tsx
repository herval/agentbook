// A contact's thread or page from another agentbook, on your feed (server/api/people-things.ts's theirFeed), as their
// door sent it: read only. It opens on their profile, where its conversation and work are; nothing here steers it.
import { ago, plural } from "../../lib/format.ts";
import { personHref, theirThingHref } from "../../lib/route.ts";
import type { TheirCard } from "../../lib/types.ts";
import { PersonAvatar } from "../Avatar.tsx";
import { Icon } from "../Icon.tsx";
import { Hl } from "../post/util.tsx";

// How a thread of theirs is going, as their page said it last; nothing for one that's waiting for a prompt.
function TheirState({ c }: { c: TheirCard }) {
  if (c.type !== "thread") return null;
  if (c.state === "needs") return <span className="chip chip--sun">Needs them</span>;
  if (c.state === "working" || c.state === "waiting" || c.busy)
    return (
      <span className="chip chip--live">
        <i className="pulse" />
        Working
      </span>
    );
  return null;
}
const verbOf = (c: TheirCard) => (c.type === "page" ? (c.version === 1 ? "made a page" : "updated a page") : c.agent?.name ? `has ${c.agent.name} on a thread` : "has a thread");

export function TheirFeedCard({ card: c }: { card: TheirCard }) {
  const href = theirThingHref(c.username, c.rid);
  return (
    <article className="card post their-card">
      <header className="post-head">
        <a href={personHref(c.username)}>
          <PersonAvatar who={c.username} size="" letter={(c.name || c.username)[0]?.toUpperCase()} />
        </a>
        <div className="post-who">
          <b>{c.name || `@${c.username}`}</b> <span className="verb">{verbOf(c)}</span>
          <div className="post-meta">
            <a className="on" href={personHref(c.username)}>
              @{c.username}, on their agentbook
            </a>
            <TheirState c={c} />
            <span>{ago(c.updated || c.started)}</span>
          </div>
        </div>
      </header>
      <h2 className="post-title">
        <a href={href}>
          {c.type === "page" ? `${c.emoji || "📄"} ` : ""}
          <Hl text={c.title || (c.type === "page" ? "A page" : "A thread")} />
        </a>
      </h2>
      {c.text ? <p className="post-text their-card-text">{c.text}</p> : null}
      {c.last ? (
        <p className="their-card-last">
          <span>
            <b>{c.last.from}</b> {c.last.text}
          </span>
        </p>
      ) : null}
      <a className="their-card-open" href={href}>
        <Icon name="eye" />
        Read only{c.messages ? `, ${plural(c.messages, "message")}` : ""}
      </a>
    </article>
  );
}

// The same, as one row of the compact feed.
export function TheirRowLine({ card: c }: { card: TheirCard }) {
  return (
    <a className="act-row" href={theirThingHref(c.username, c.rid)}>
      <PersonAvatar who={c.username} letter={(c.name || c.username)[0]?.toUpperCase()} />
      <span>
        <b>
          {c.type === "page" ? `${c.emoji || "📄"} ` : ""}
          <Hl text={c.title || (c.type === "page" ? "A page" : "A thread")} />
        </b>
        <small>{[c.agent?.name, `@${c.username}, on their agentbook`].filter(Boolean).join(" · ")}</small>
      </span>
      <TheirState c={c} />
      <time>{ago(c.updated || c.started)}</time>
    </a>
  );
}
