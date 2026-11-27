// A group (#/groups/:id), as a page has its Page: its Group tab is the group itself, laid out as the feed is. Its feed
// in the middle, newest first, under the box that starts a thread in it; who's in it, its files and what it's for on
// the left; its tasks and your notes on the right. A file of it opens in the middle, where its feed is. Its other
// tabs: its members, and its brief with what a thread in it is told. Ported from the old page's renderGroup and
// loadGroup: the group is fetched when it opens, on each stream hello, and when the chrome says something happened
// in it (a thread joined, a file changed, a note).
import { useEffect, useRef } from "react";
import { useSided } from "../../components/Shell.tsx";
import { GroupFiles } from "../../components/groups/Files.tsx";
import { groupById, groupIn, loadGroup, useGroupData } from "../../components/groups/groups.ts";
import { groupLeft, groupRight, GroupTimeline } from "../../components/groups/Home.tsx";
import { GroupHead } from "../../components/groups/parts.tsx";
import { Keyed } from "../../components/Keyed.tsx";
import { GroupBrief, GroupMembers } from "../../components/groups/Tabs.tsx";
import { onHello } from "../../lib/live.ts";
import { useRoute } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import type { PageData } from "../../lib/types.ts";
import { groupStyle } from "../../lib/format.ts";

export function GroupPage() {
  const route = useRoute();
  const { id } = route;
  const data = useApp((s) => s.data);
  useApp((s) => s.rows);
  const d = useGroupData(id);
  // A group's own columns are its left one: the menu drawer has the menu.
  useSided(false);

  useEffect(() => {
    loadGroup();
    return onHello(() => void loadGroup());
  }, [id]);
  // Something happened in the open group (a thread joined, a file changed, a note): look again.
  const prev = useRef<PageData | null>(data);
  useEffect(() => {
    const was = prev.current;
    prev.current = data;
    if (was === data) return;
    const gv = (x: PageData | null) => JSON.stringify((x?.groups || []).filter((g) => g.id === id).map((g) => [g.updated, g.posts, g.files, g.notes, g.brief, g.members?.length, g.archived]));
    if (gv(was) !== gv(data)) loadGroup();
  }, [data, id]);

  const g = groupById(id);
  if (!g)
    return (
      <div className="shell-msg">
        <p>{data?.groups ? "No group here, or it isn't yours to see." : "Loading…"}</p>
        <a className="btn" href="#/groups">
          Every group
        </a>
      </div>
    );
  // The tab it shows: its brief is for the people in it to edit (anyone else sees it on the left), and its files are
  // on its Group tab.
  const tab = route.tab === "brief" && !groupIn(g) ? "group" : route.tab || "group";
  const home = tab === "group" || tab === "files";
  const style = groupStyle(g);
  let body;
  if (!home) body = tab === "members" ? <GroupMembers g={g} /> : <GroupBrief key={g.id} g={g} d={d} />;
  else {
    // Narrower, the right column's cards go under the left one's; on a phone, both are in the drawer.
    const left = groupLeft(g, d);
    const right = groupRight(g, d);
    const copies = (list: { key: string; node: React.ReactNode }[]) => list.map((x) => ({ ...x, key: `narrow-${x.key}` }));
    body = (
      <div className="shell gr-shell">
        <aside className="col-side gr-side">
          {[...left, ...copies(right)].map((x) => (
            <Keyed key={x.key} k={x.key}>
              {x.node}
            </Keyed>
          ))}
        </aside>
        <main className="feed">{tab === "files" ? <GroupFiles g={g} d={d} arg={route.arg || ""} v={route.v || null} /> : <GroupTimeline g={g} />}</main>
        <aside className="col-side rail">
          {[...right, ...copies(left)].map((x) => (
            <Keyed key={x.key} k={x.key}>
              {x.node}
            </Keyed>
          ))}
        </aside>
      </div>
    );
  }
  return (
    <>
      <section className="profile-top" style={style}>
        <div className={`profile-in${home ? " is-wide" : ""}`}>
          <GroupHead g={g} tab={home ? "group" : tab} />
        </div>
      </section>
      <div style={style}>{body}</div>
    </>
  );
}
