import type { ReactNode } from "react";
import { wsWhere } from "../../lib/agents.ts";
import { groupStyle, pageStyle } from "../../lib/format.ts";
import { groupHref, pageHref, workspaceHref } from "../../lib/route.ts";
import type { GroupRow, PageRow } from "../../lib/types.ts";
import { Icon } from "../Icon.tsx";
import type { Ws } from "../worktrees/wips.ts";

export const PgIco = ({ p }: { p: PageRow }) => (
  <span className="pg-ico" style={pageStyle(p)}>
    {p.emoji || "📄"}
  </span>
);
export const GrIco = ({ g }: { g: GroupRow }) => (
  <span className="gr-ico" style={groupStyle(g)}>
    {g.emoji || "👥"}
  </span>
);
export const PageChip = ({ p }: { p: PageRow }) => (
  <a className="chip chip--page" style={pageStyle(p)} href={pageHref(p)} title={`On the page ${p.title}${p.archived ? ", archived" : ""}`}>
    {p.emoji || "📄"}
    <span>{p.title}</span>
  </a>
);
export const GroupChip = ({ g }: { g: GroupRow }) => (
  <a className="chip chip--group" href={groupHref(g)} style={groupStyle(g)} title={`In the group ${g.name}`}>
    {g.emoji || "👥"} {g.name}
  </a>
);
export const WsChip = ({ w }: { w: Ws }) => (
  <a className="chip chip--ws" href={workspaceHref(w.id)} title={`The workspace ${w.name}\n${wsWhere(w)}`}>
    <Icon name={w.repo ? "repo" : "folder"} />
    <span>{w.name}</span>
  </a>
);
// One quiet pick under a task (the old opt1): what it's set to beside its icon, a native menu over it.
export function Opt({ label, title, face, set, value, onChange, children }: { label: string; title?: string; face: ReactNode; set?: boolean; value: string; onChange: (v: string) => void; children: ReactNode }) {
  return (
    <label className={`opt${set ? " is-set" : ""}`} title={title || label}>
      {face}
      <Icon name="down" className="caret" />
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
    </label>
  );
}
