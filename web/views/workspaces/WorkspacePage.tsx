// #/workspaces/:id(/worktrees): a workspace's page, laid out as an agent's profile. A workspace of yours: its head and
// tabs, on the side what it is, the agents in it, its tasks and its pages, and its threads (under a composer that
// starts one in it) or its worktrees. Someone else's, by its link: to read, if you may.
// (components/workspaces/Workspace.tsx draws each part.)
import { useEffect, useState } from "react";
import { workspaces } from "../../lib/agents.ts";
import { useChrome } from "../../lib/chrome.ts";
import { useFeedList } from "../../lib/feed.ts";
import { useLoad } from "../../lib/hooks.ts";
import { go, useRoute, workspaceHref } from "../../lib/route.ts";
import { takeRows, useApp } from "../../lib/store.ts";
import type { WorkspaceSeen } from "../../lib/types.ts";
import { Composer } from "../../components/Composer.tsx";
import { HereNone, ScopeBar } from "../../components/ScopeBar.tsx";
import { Shell, ShellMsg } from "../../components/Shell.tsx";
import { TasksCard } from "../../components/TasksCard.tsx";
import { FeedCards } from "../../components/ThreadCard.tsx";
import { WsAbout, WsAgents, WsHead, WsPages, WsSeen, WsSettings, WsWip } from "../../components/workspaces/Workspace.tsx";
import type { WsFull } from "../../components/workspaces/Workspace.tsx";
import { setCompose } from "../../components/bar/compose.ts";
import { useHereAsk } from "../../components/bar/scope.ts";

const WS_STYLE = { "--hue": "var(--ink)", "--tint": "var(--well)" } as React.CSSProperties;

export function WorkspacePage() {
  const route = useRoute();
  const { id } = route;
  const tab = route.tab === "worktrees" ? "worktrees" : "threads";
  // Its Worktrees tab was its WIP tab: an old link says the new address.
  useEffect(() => {
    if (route.old) history.replaceState(null, "", workspaceHref(id, tab));
  }, [route.old, id, tab]);
  const data = useApp((s) => s.data);
  const w = data?.workspaces ? (workspaces().find((x) => x.id === id) as WsFull | undefined) : undefined;
  if (!w && data?.workspaces) return <Seen id={id} />;
  if (!w) return <ShellMsg>Loading…</ShellMsg>;
  return <Mine w={w} tab={tab} />;
}

function Mine({ w, tab }: { w: WsFull; tab: string }) {
  const q = useChrome((s) => s.q);
  const [settings, setSettings] = useState(false);
  // A workspace's page starts its threads in it: its composer's workspace is this one, and stays picked after.
  useEffect(() => setCompose({ wsPick: w.id }), [w.id]);
  // Its threads as the server lists them (q/feed, narrowed to it, and as its bar narrows them: by agent, by status),
  // counted as the search finds them. Threads still starting in it go on top.
  const ask = useHereAsk("workspace", w.id, q, tab === "threads");
  const feed = useFeedList(ask);
  // How many the list has, in every status: the filter bar shows while it has any.
  const st = feed?.counts.states || {};
  const listed = (st.all || 0) + (st.hidden || 0) + (st.archived || 0);
  const empty = (
    <section className="card empty-card">
      <p>
        No threads in {w.name} yet. Start one above, and it works in {w.name}'s folder.
      </p>
    </section>
  );
  return (
    <>
      <section className="profile-top" style={WS_STYLE}>
        <div className="profile-in">
          <WsHead w={w} tab={tab} onSettings={() => setSettings(true)} />
        </div>
      </section>
      <div className="prof-body" style={WS_STYLE}>
        <div className="prof-col">
          <div>
            <WsAbout w={w} />
          </div>
          <div>
            <WsAgents w={w} />
          </div>
          <div>
            <TasksCard own={w.id} />
          </div>
          <div>
            <WsPages w={w} />
          </div>
        </div>
        <div className="prof-col">
          {tab === "worktrees" ? (
            <WsWip w={w} />
          ) : (
            <>
              <div>
                <Composer />
              </div>
              <div>{listed > 0 && <ScopeBar name="workspace" bare />}</div>
              <FeedCards feed={feed} />
              <HereNone name="workspace" feed={feed} count={feed?.list.length || 0} none={empty} />
            </>
          )}
        </div>
      </div>
      <WsSettings w={w} open={settings} onClose={() => setSettings(false)} onRemoved={() => (setSettings(false), go("#/"))} />
    </>
  );
}

// Someone else's workspace, by its link: read once as it opens (its threads join the page's), or a word that it
// isn't one you can see.
function Seen({ id }: { id: string }) {
  const L = useLoad<WorkspaceSeen>(`/api/workspaces/${encodeURIComponent(id)}`, id);
  useEffect(() => void takeRows(L.data?.threads), [L.data]);
  if (L.loading && !L.data) return <ShellMsg back={false}>Loading…</ShellMsg>;
  if (!L.data?.workspace)
    return (
      <ShellMsg>
        <p>This workspace isn't on your list, and isn't one you can see.</p>
      </ShellMsg>
    );
  return (
    <Shell>
      <WsSeen id={id} seen={L.data} />
    </Shell>
  );
}
