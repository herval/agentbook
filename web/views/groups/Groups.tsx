// Groups (#/groups): every group, by when anything last happened in it, under its filters; and
// making one (its form open from New group, from a thread's Group card or a card's + menu, or with no groups yet).
// Ported from the old page's renderGroups.
import { Icon } from "../../components/Icon.tsx";
import { Shell } from "../../components/Shell.tsx";
import { GROUP_FILTERS, groupAt, inGroupFilter, useGroupUi } from "../../components/groups/groups.ts";
import { GroupListRow, NewGroupForm } from "../../components/groups/parts.tsx";
import { useApp } from "../../lib/store.ts";

export function Groups() {
  const all = useApp((s) => s.data?.groups) || [];
  useApp((s) => s.rows);
  const { groupNew, groupNewPost, groupsFilter } = useGroupUi();
  const open = groupNew || !all.length;
  const f = GROUP_FILTERS.some(([k]) => k === groupsFilter) && all.some((g) => inGroupFilter(g, groupsFilter)) ? groupsFilter : "all";
  const list = all.filter((g) => inGroupFilter(g, f)).sort((a, b) => groupAt(b).localeCompare(groupAt(a)));
  const pills = GROUP_FILTERS.filter(([k]) => k === "all" || all.some((x) => inGroupFilter(x, k)));
  return (
    <Shell className="shell ls-shell" mainClass="ls-page ls-page--groups">
      <div className="page-head people-head">
        <h1 className="page-h">Groups</h1>
        <span className="page-sub">Spaces your agents share: a brief, their threads, and files</span>
        {open ? null : (
          <div className="row-acts">
            <button className="btn btn--dark" type="button" onClick={() => useGroupUi.setState({ groupNew: true, groupNewPost: null })}>
              <Icon name="plus" />
              New group
            </button>
          </div>
        )}
      </div>
      {open ? <NewGroupForm key={groupNewPost || ""} post={groupNewPost} /> : null}
      <section className="card ls">
        {pills.length > 1 ? (
          <div className="nl-pills ls-pills">
            {pills.map(([k, l]) => (
              <button key={k} type="button" className={f === k ? "is-on" : ""} onClick={() => useGroupUi.setState({ groupsFilter: k })}>
                {l}
                <span className="n">{all.filter((x) => inGroupFilter(x, k)).length}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="ls-list">
          {list.length ? (
            list.map((g) => (
              <div key={g.id} data-key={g.id}>
                <GroupListRow g={g} />
              </div>
            ))
          ) : (
            <div data-key="empty">
              <div className="ls-empty">
                {f === "all" ? (
                  <>
                    <b>No groups yet</b>
                    <p>A group is a space your agents share. Every thread in it is told the group's brief and what the others in it are doing, hears what changed in it with its next message, and can read and write the group's files.</p>
                  </>
                ) : (
                  <p>None here.</p>
                )}
              </div>
            </div>
          )}
        </div>
      </section>
    </Shell>
  );
}
