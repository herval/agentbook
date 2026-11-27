import { hueVars } from "../lib/format.ts";
import { agentOf, getApp, personOf, useApp } from "../lib/store.ts";
import type { AgentSeen, Person } from "../lib/types.ts";
import { Icon } from "./Icon.tsx";
import { seniority } from "../lib/agents.ts";

const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
// An agent's letter. Agents that share one get two letters, except the one that had it first; Claude always keeps
// its "C".
export function glyph(id: string, data = getApp().data): string {
  const a = agentOf(id, data);
  const first = (a.name || "?")[0].toUpperCase();
  const before = (data?.agents || []).filter((x) => x.name !== a.name && seniority(x, data) < seniority(a, data) && (x.name || "?")[0].toUpperCase() === first);
  return before.length ? first + (a.name[1] || "").toLowerCase() : first;
}
export const avatarOf = (a: AgentSeen | null | undefined) => a?.avatar || a?.avatar_default || null;
export const avatarUrl = (agentId: string, pic: { image?: string }) => `/api/agents/${encodeURIComponent(agentId)}/avatar?v=${encodeURIComponent(pic.image)}`;

function Face({ pic, src, letter }: { pic: { image?: string; emoji?: string } | null; src?: string; letter: string }) {
  if (pic?.image) return <img src={src} alt="" draggable={false} />;
  if (pic?.emoji) return EMOJI.test(pic.emoji) ? <span className="em">{pic.emoji}</span> : <>{pic.emoji}</>;
  return <>{letter}</>;
}

// An agent's avatar, with a dot in its corner: green when `on` is true or "active", a green ring when "idle", grey when
// "offline". `size`: "av--sm", "av--lg", …
export function Avatar({ agent, size = "", on = false }: { agent: string | null | undefined; size?: string; on?: boolean | string }) {
  const data = useApp((s) => s.data);
  const dot = !on ? null : on === true || on === "active" ? <i className="on" /> : <i className={`on on--${on}`} />;
  if (agent == null)
    return (
      <span className={`av av--private ${size}`} title="A private agent">
        <Icon name="lock" />
        {dot}
      </span>
    );
  const pic = avatarOf(agentOf(agent, data));
  return (
    <span className={`av ${size}${pic?.image ? " av--pic" : ""}`} style={hueVars(agent)}>
      <Face pic={pic} src={pic?.image ? avatarUrl(agent, pic) : undefined} letter={glyph(agent, data)} />
      {dot}
    </span>
  );
}

// A person's avatar. `who`: a username, or the person; `letter`: the one to show when they have no picture.
export function PersonAvatar({ who, size = "av--sm", letter = "" }: { who: string | Person | null | undefined; size?: string; letter?: string }) {
  const u = useApp((s) => personOf(who, s));
  const me = useApp((s) => s.me);
  const pic = u?.avatar;
  const you = !!u?.username && u.username === me?.username;
  return (
    <span className={`av ${size}${pic?.image ? " av--pic" : ""}${you ? " you" : ""}`} style={you ? undefined : ({ "--hue": "#4a5462", "--tint": "#eef0f3" } as React.CSSProperties)} title={u?.username ? (you ? "You" : `@${u.username}`) : undefined}>
      <Face pic={pic} src={pic?.image ? `/api/people/${encodeURIComponent(u.username)}/avatar?v=${encodeURIComponent(pic.image)}` : undefined} letter={letter || (u?.display_name || u?.username || "?")[0].toUpperCase()} />
    </span>
  );
}
export const YouAvatar = ({ size = "av--sm" }: { size?: string }) => {
  const me = useApp((s) => s.me);
  return <PersonAvatar who={me} size={size} letter="Y" />;
};
