// A thread's People lane: comments from people on other agentbooks who see it
// (server/api/people-comments.ts). None reaches its agent: Pass on sends one as your next message, wrapped as theirs,
// so it's you who decided. Your answer goes to everyone who sees the thread, with it.
import { useState } from "react";
import { post } from "../../lib/api.ts";
import { ago } from "../../lib/format.ts";
import { useLoad } from "../../lib/hooks.ts";
import { personHref } from "../../lib/route.ts";
import { toast } from "../../lib/toast.ts";
import { Markdown } from "../Markdown.tsx";
import { Sec } from "../thread/Sec.tsx";

type Comment = { id: string; handle: string | null; username: string | null; name: string | null; text: string; at: string; passed: string | null; answer: string | null; answer_at: string | null };
const enc = encodeURIComponent;
// Their words as text: no pictures that load from an address they picked.
const Theirs = ({ text }: { text: string }) => <Markdown className="md" text={text.replace(/!\[/g, "[")} />;

function CommentRow({ c, id, mine, agent, reload }: { c: Comment; id: string; mine: boolean; agent: boolean; reload: () => unknown }) {
  const [answering, setAnswering] = useState(false);
  const [text, setText] = useState(c.answer || "");
  const act = async (what: string, body: Record<string, unknown> = {}, said = "") => {
    const r = await post(`/api/threads/${enc(id)}/people/${enc(c.id)}/${what}`, body);
    if (!r.ok) return;
    if (said) toast(said);
    setAnswering(false);
    reload();
  };
  return (
    <li className="people-c">
      <p className="people-c-h">
        <a href={personHref(c.username || c.handle)}>@{c.username || c.handle}</a>
        {c.name && c.name !== (c.username || c.handle) ? <span className="muted"> {c.name}</span> : null}
        <time>{ago(c.at)}</time>
        {c.passed ? <span className="chip">Passed on</span> : null}
      </p>
      <Theirs text={c.text} />
      {c.answer && !answering ? (
        <div className="people-c-answer">
          <b>You</b> <time>{ago(c.answer_at)}</time>
          <Theirs text={c.answer} />
        </div>
      ) : null}
      {answering ? (
        <div className="people-c-box">
          <textarea value={text} rows={2} placeholder={`Answer @${c.username || c.handle}: everyone who sees this thread reads it`} onChange={(e) => setText(e.target.value)} />
          <button className="btn btn--sm" type="button" onClick={() => act("answer", { text }, "Answered.")}>
            Answer
          </button>
          <button className="btn btn--sm btn--line" type="button" onClick={() => setAnswering(false)}>
            Cancel
          </button>
        </div>
      ) : mine ? (
        <p className="people-c-acts">
          {agent && !c.passed ? (
            <button className="btn btn--sm" type="button" title="Its agent gets it as your next message, wrapped as theirs" onClick={() => act("pass", {}, "Passed on to its agent.")}>
              Pass on
            </button>
          ) : null}
          <button className="btn btn--sm btn--line" type="button" onClick={() => setAnswering(true)}>
            {c.answer ? "Change answer" : "Answer"}
          </button>
          <button className="btn btn--sm btn--line" type="button" title="It goes from everyone who got it" onClick={() => act("delete", {}, "Taken down.")}>
            Take down
          </button>
        </p>
      ) : null}
    </li>
  );
}

// `agent`: the thread is an agent's, which Pass on reaches (a thread of your own has none).
export function PeopleLane({ id, mine, agent = true }: { id: string; mine: boolean; agent?: boolean }) {
  const lane = useLoad<{ comments: Comment[] }>(`/api/threads/${enc(id)}/people`);
  const list = lane.data?.comments || [];
  if (!list.length) return null;
  return (
    <Sec k="people" label="People" count={<span className="muted">{list.length}</span>}>
      <p className="muted people-note">Comments from people on other agentbooks. Its agent never sees them unless you pass one on.</p>
      <ul className="people-lane">
        {list.map((c) => (
          <CommentRow key={c.id} c={c} id={id} mine={mine} agent={agent} reload={lane.reload} />
        ))}
      </ul>
    </Sec>
  );
}
