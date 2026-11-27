// PRIVATE to the talk page (views/thread/TalkPage.tsx), until the thread's conversation has one of its own: a
// question answered (or closed), in the conversation, with what you picked or said. Ported from the old page's answered().
import { agentName, typedIn } from "../../lib/agents.ts";
import { clock, hueVars } from "../../lib/format.ts";
import type { Question, Thread } from "../../lib/types.ts";
import { Avatar } from "../Avatar.tsx";

export function Answered({ q, s }: { q: Question; s: Thread }) {
  const value = q.value ?? (q.by === "skipped" ? "You skipped this" : q.by === "terminal" ? `Answered in ${typedIn(s)}` : q.by === "gone" ? "Closed when the agent finished" : q.by === "stopped" ? "Closed when you stopped it" : q.by === "archived" ? "Closed when you archived it" : "Closed");
  // Set aside by what you wrote on the post instead of answering.
  const aside =
    q.by === "comment" ? (
      <p className="answer">
        <span className="muted">You wrote to it instead</span>
      </p>
    ) : null;
  const opts = q.options?.length ? (
    <>
      <div className="poll">
        {q.options.map((o) => (
          <span className={`poll-opt ${o.label === q.value ? "is-picked" : ""}`} key={o.label}>
            <b>{o.label}</b>
            {o.label === q.value && <span className="pick">{q.by === "default" ? "Its pick, when time ran out" : "You picked this"}</span>}
          </span>
        ))}
      </div>
      {aside}
    </>
  ) : (
    aside || <p className="answer">{q.kind === "permission" ? (q.value === "allow" ? (q.by === "mode" ? "Allowed, as it moves to Full access" : "You allowed it") : q.value === "deny" ? "You denied it" : value) : q.by === "skipped" ? <span className="muted">{value}</span> : <b>{value}</b>}</p>
  );
  return (
    <div className="cmt cmt-agent" style={hueVars(s.agent)}>
      <Avatar agent={s.agent} size="av--sm" />
      <div className="cmt-wide">
        <div className="cmt-bub cmt-ask">
          <b>
            {agentName(s.agent)} <span className="via">asked you</span>
          </b>
          <p>{q.title}</p>
          {opts}
        </div>
        <div className="cmt-meta">
          <span>{clock(q.asked)}</span>
        </div>
      </div>
    </div>
  );
}
