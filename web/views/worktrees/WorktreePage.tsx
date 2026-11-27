// A worktree's page (#/worktrees/<id>): a pull request's (PullPage), or a branch's (BranchPage), where it is, what
// isn't on main and what's between it and landing. The tasks it's on are beside it.
import { useEffect } from "react";
import { workspaces } from "../../lib/agents.ts";
import { followHash, useRoute } from "../../lib/route.ts";
import { ShellMsg } from "../../components/Shell.tsx";
import { BranchPage } from "../../components/worktrees/Branch.tsx";
import { PullPage } from "../../components/worktrees/Pull.tsx";
import { wsSeenOf } from "../../components/worktrees/ship.ts";
import { useWorld, wipById, wipHref } from "../../components/worktrees/wips.ts";

// The worktree the address names, once the page knows it; until then, that git or GitHub is still being read, or
// that it isn't here anymore.
export function WorktreePage() {
  const route = useRoute();
  const data = useWorld();
  const id = route.id || "";
  const w = wipById(id);
  // An old link (#/wip/<its id>) goes to its worktree's, and a branch that has a pull request now is that: its
  // page's link is the pull request's.
  const want = route.old || (w && (w.rid ? encodeURIComponent(w.rid) : w.id) !== id) ? (w ? wipHref(w) : `#/worktrees/${encodeURIComponent(id)}`) : null;
  useEffect(() => {
    if (!want || location.hash === want) return;
    history.replaceState(null, "", want);
    followHash();
  }, [want]);
  // Each project's WIP comes a moment after the rest, the first time: git (or GitHub) is read in the background.
  const pr = /-pr\d+$/.test(id);
  const seen = id.includes("~") ? wsSeenOf(id.split("~")[0]) : null;
  const reading = !!seen?.loading || (pr ? workspaces().some((x) => x.pulls === null) : (data?.folders || []).some((f) => f.sessions && !("wip" in f)));
  if (!w) {
    const gone = pr ? "This pull request isn't here anymore: it was merged or closed over a week ago, and none of your machines has its branch." : "This worktree isn't here anymore: its branch was cleaned up, or deleted.";
    return (
      <ShellMsg back={!reading}>
        <p>{reading ? (pr ? "Reading GitHub…" : "Reading git…") : gone}</p>
      </ShellMsg>
    );
  }
  return w.kind === "pr" ? <PullPage key={w.id} x={w} /> : <BranchPage key={w.id} w={w} />;
}
