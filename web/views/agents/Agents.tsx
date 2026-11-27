// The People tab (#/people, or #/agents), beside the sidebar as Pages and Groups are: everyone here, a card each with
// the agents they run grouped by machine and Cloud: you first, then whoever has the most running. An agent whose
// owner isn't listed (gone, say) gets a card for them anyway.
import { AddAgentButton } from "../../components/agents/AddAgentDialog.tsx";
import { useEffect } from "react";
import { plural } from "../../lib/format.ts";
import { loadPeople } from "../../lib/session.ts";
import { useApp } from "../../lib/store.ts";
import type { Person } from "../../lib/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { Shell } from "../../components/Shell.tsx";
import { agentsOf, isMe } from "../../components/agents/words.ts";
import { PersonCard } from "../../components/people/PersonCard.tsx";

type Listed = Pick<Person, "username" | "display_name"> & Partial<Person>;

export function Agents() {
  const data = useApp((s) => s.data);
  const me = useApp((s) => s.me);
  const known = useApp((s) => s.people);
  // Everyone here, read again each time People opens.
  useEffect(() => void loadPeople(), []);
  const s = { data, me };
  const running = (u: Listed) => agentsOf(u.username, s).reduce((n, a) => n + (a.offline ? 0 : a.working || 0), 0);
  const listed: Listed[] = known || (me ? [me] : []);
  const all = data?.agents || [];
  const orphans: Listed[] = [...new Set(all.filter((a) => a.mine === false && a.owner && !listed.some((u) => u.username === a.owner)).map((a) => a.owner))].map((username) => ({ username, display_name: `@${username}` }));
  const people = [...listed, ...orphans].sort((a, b) => Number(isMe(b.username, s)) - Number(isMe(a.username, s)) || running(b) - running(a) || (a.display_name || a.username).localeCompare(b.display_name || b.username));
  return (
    <Shell className="shell ls-shell" mainClass="ls-page">
      <div>
        <div className="page-head people-head">
          <h1 className="page-h">People</h1>
          <span className="page-sub">
            {people.length === 1 ? "1 person" : `${people.length} people`}, {plural(all.length, "agent")}
          </span>
          <div className="row-acts">
            <AddAgentButton className="btn btn--line">
              <Icon name="plus" />
              Add agents
            </AddAgentButton>
          </div>
        </div>
      </div>
      <div className="people-list">
        {people.map((u) => (
          <div key={`@${u.username}`}>
            <PersonCard person={u} />
          </div>
        ))}
      </div>
    </Shell>
  );
}
