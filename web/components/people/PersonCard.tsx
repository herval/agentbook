// A person's card on People: who they are, what their agents have going, and their agents by machine and Cloud.
import { AddAgentButton } from "../agents/AddAgentDialog.tsx";
import { sortAgents } from "../../lib/agents.ts";
import { listText, plural } from "../../lib/format.ts";
import { personHref } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import type { Person } from "../../lib/types.ts";
import { PersonAvatar } from "../Avatar.tsx";
import { AgentGroups } from "../agents/AgentList.tsx";
import { PersonNow } from "../agents/AgentNow.tsx";
import type { AgentRow } from "../agents/types.ts";
import { agentsOf, busyFirst, isMe, machinesOf } from "../agents/words.ts";

const PEOPLE_FOLD = 5;

export function PersonCard({ person: u }: { person: Pick<Person, "username" | "display_name"> & Partial<Person> }) {
  const data = useApp((s) => s.data);
  const me = useApp((s) => s.me);
  const you = isMe(u.username, { data, me });
  // Its rows: the ones with the most running first, offline ones last, then by name.
  const agents = sortAgents(agentsOf(u.username, { data, me })).sort(busyFirst) as AgentRow[];
  const where = machinesOf(agents);
  const line = [`@${u.username}`, agents.length ? `${plural(agents.length, you ? "agent" : "public agent")}${where.length ? ` on ${listText(where)}` : ""}` : you ? "no agents yet" : "no public agents yet"].filter(Boolean).join(" · ");
  return (
    <section className="card person-card">
      <a className="pc-head" href={personHref(u.username)}>
        <PersonAvatar who={u.id ? (u as Person) : u.username} size="av--lg" />
        <span className="who">
          <b>{u.display_name || u.username}</b>
          {you ? <span className="chip">You</span> : u.disabled ? <span className="chip chip--off">Disabled</span> : null}
          <p>{line}</p>
          {u.bio && <p className="pc-bio">{u.bio}</p>}
        </span>
        <span className="now">
          <PersonNow username={u.username} />
        </span>
      </a>
      {agents.length > 0 && <AgentGroups agents={agents} manage={you} fold={PEOPLE_FOLD} allHref={personHref(u.username, "agents")} />}
      {!agents.length && you && (
        <p className="pc-none">
          Agents show up here once a machine of yours finds Claude Code, Codex, Hermes or OpenClaw. <AddAgentButton className="agent-add-link">Add agents</AddAgentButton> to see what your machines can run, connect OpenClaw, or log in another machine.
        </p>
      )}
    </section>
  );
}
