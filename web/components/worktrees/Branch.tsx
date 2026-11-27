// A branch's page (the old renderWorktree): where it is, what isn't on main and what's between it and landing, its
// threads, and its changes, what happened on it and its threads' results. The tasks it's on are beside it.
import { useLayoutEffect, useState } from "react";
import { many, onGitHub, waits, workspaces } from "../../lib/agents.ts";
import { post } from "../../lib/api.ts";
import { agoText, plural } from "../../lib/format.ts";
import { useLoad } from "../../lib/hooks.ts";
import { connectorsHref, workspaceHref } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { ChangedFile } from "../../lib/types.ts";
import { Icon } from "../Icon.tsx";
import { SharedCrumbs, TaskTag } from "../tasks/Ship.tsx";
import { TreeCorner } from "../Visibility.tsx";
import { DiffView, diffOf, PathName, totals, wipResults } from "./Diff.tsx";
import { fileOpened, loadWipDiff, pageFor, setCleaning, setScope, toggleFile, usePage, useScrollTo } from "./PageState.ts";
import { PrActs, type PullCx } from "./PullActs.tsx";
import { sharedApi } from "./ship.ts";
import { AsOf, AskButton, CopyBtn, Gate, StoryList, threadEvents, useFullRows, WipFacts, WipFrame, WipTabs, WipThreads, type Fact, type GateRow, type StoryEvent } from "./WipPage.tsx";
import { ChgSize, WipWord } from "./WipRow.tsx";
import { askWip, gitKey, tilde, useWorld, WIP_ASK, wipStatus, type BranchRead, type Wip } from "./wips.ts";

// Its page: who's on it, what isn't on main, what moved under it, its posts, what happened, and its changes.
// It reads git again when git says something moved, not each time one of its posts does. One on a task shared with
// you: through the task, from the machine that has its branch.
export function BranchPage({ w }: { w: Wip }) {
  useWorld();
  const github = useApp((s) => !!s.data?.github);
  const cleaning = usePage((s) => s.cleaning === w.id);
  const [busy, setBusy] = useState(false);
  const url = w.shared ? sharedApi(w, "worktree") : `/api/wip?${new URLSearchParams({ root: w.root, branch: w.branch, ...(w.machine ? { machine: w.machine } : {}) })}`;
  const load = useLoad<BranchRead>(url, gitKey(w));
  const failed = !!load.error;
  const d = failed ? null : load.data;
  const posts = useFullRows(w.posts);
  useLayoutEffect(() => {
    pageFor(w.id);
    fileOpened(w);
  }, [w.id]);
  useScrollTo();

  const ws = w.shared ? null : workspaces().find((x) => x.checkouts.some((c) => c.machine === w.machine && c.root === w.root)) || null;
  const short = w.branch.replace(/^worktree-/, "");
  const crumbs = w.shared ? (
    <SharedCrumbs w={w} last={short} />
  ) : (
    <p className="crumbs">
      {ws ? <a href={workspaceHref(ws.id)}>{ws.name}</a> : <span>{w.repo}</span>}
      <span className="sep">/</span>
      {ws ? <a href={workspaceHref(ws.id, "worktrees")}>Worktrees</a> : <a href="#/worktrees">Worktrees</a>}
      <span className="sep">/</span>
      <span>{short}</span>
    </p>
  );

  const busyOn = w.posts.filter((s) => s.effective === "working" || s.effective === "needs");
  const going = w.posts.find((s) => s.state !== "done" && s.mine !== false);
  const folder = w.worktree ? w.place || tilde(w.machine, w.worktree) : null;
  // One on a task shared with you is only to read: its branch is on someone else's machine.
  const mine = !w.shared && w.posts.every((s) => s.mine !== false);
  const gh = ws && onGitHub(ws);
  const head = (
    <>
      {mine && ws ? <TreeCorner ws={ws.id} branch={w.branch} cls=" vis-corner--card" /> : null}
      <div className="wip-ref">
        <WipWord st={wipStatus(w)} />
        <span className="chip chip--branch">{w.branch}</span>
        <span>
          off <code>{w.base}</code>
          {d?.merge_base ? (
            <>
              {" "}
              at <code>{d.merge_base}</code>
            </>
          ) : null}
        </span>
        <TaskTag w={w} />
      </div>
      <h1 className="wip-title">{w.title}</h1>
    </>
  );

  // What's between it and landing, each with what does it: what isn't committed, what moved under it, a pull
  // request (in a repo on GitHub), and landing it. Each asks the thread going on it, or starts one.
  const ask = (k: string, ico: "down" | "pr" | "up", text: string, [asks, starts]: [string, string], on: boolean) =>
    !mine ? null : (
      <AskButton title={going ? `Asks ${going.label} to ${asks}` : `Starts a thread that ${starts}`} icon={ico} on={on} run={() => askWip(w, WIP_ASK[k](w))}>
        {text}
      </AskButton>
    );
  const left = !!(w.ahead || w.dirty);
  const base = w.base;
  const rows: GateRow[] = [];
  // Nothing's left: its next step is cleaning it up, once nobody's working on it.
  const canClean = !w.here && !busyOn.length;
  const cleanWhy = w.here ? `${ws?.name || w.repo}'s own folder is on it` : busyOn.length ? `${busyOn[0].label} is working on it` : "";
  // Clean up (or Discard, throwing away what's left): asked once, then done; it goes to the feed once it's gone.
  // Discard throws away only the commit it showed: one that moved since isn't discarded unseen.
  const clean = async (step: "yes" | "discard") => {
    setBusy(true);
    const q = w.machine ? `?machine=${encodeURIComponent(w.machine)}` : "";
    if (step === "yes") {
      const r = await post<{ removed?: boolean }>(`/api/wip/clean${q}`, { root: w.root, branch: w.branch });
      if (r.ok && r.data.queued) toast(waits(r.data, "it cleans it up"));
      else if (r.ok) {
        toast(`Cleaned up ${w.branch}${r.data.removed ? ", and removed its worktree" : ""}.`);
        location.hash = "#/";
      }
    } else {
      const r = await post<{ removed?: boolean; sha?: string }>(`/api/wip/discard${q}`, { root: w.root, branch: w.branch, sha: w.sha });
      if (r.ok && r.data.queued) toast(waits(r.data, "it discards it"));
      else if (r.ok) {
        toast(`Discarded ${w.branch}${r.data.removed ? ", and removed its worktree" : ""}. git branch ${w.branch} ${String(r.data.sha || w.sha).slice(0, 7)} brings its commits back.`);
        location.hash = "#/";
      }
    }
    setBusy(false);
    setCleaning(null);
  };
  if (!left && w.commits) {
    const act = !mine ? null : !cleaning ? (
      <button className="btn btn--line" type="button" disabled={!canClean} title={canClean ? `Removes ${w.worktree ? "its worktree and " : ""}its branch` : `Not while ${cleanWhy}`} onClick={() => setCleaning(w.id)}>
        <Icon name="archive" />
        Clean up
      </button>
    ) : (
      <span className="gate-btns">
        <button className="btn btn--dark" type="button" disabled={busy} onClick={() => void clean("yes")}>
          Clean up
        </button>
        <button className="btn btn--line" type="button" onClick={() => setCleaning(null)}>
          Keep
        </button>
      </span>
    );
    rows.push({ ic: "ok", b: `Everything on it is on ${base}`, small: cleaning ? `Remove ${w.worktree ? "its worktree and " : ""}its branch?` : "Nothing's left to land.", act });
  } else {
    if (w.dirty) rows.push({ ic: "part", b: `${plural(w.dirty, "file")} not committed`, small: `Landing it commits them first.` });
    const rebase = ask("rebase", "down", `Rebase from ${base}`, [`rebase it onto ${w.base}`, `rebases it onto ${w.base}`], !!w.behind && left);
    if (w.behind && !d) rows.push({ ic: "part", b: `${w.behind} behind ${base}`, small: failed ? "" : "Reading git…", act: rebase });
    else if (w.behind && d.overlap?.length) {
      const top = (d.main || []).filter((c) => c.overlap.length).sort((a, b) => b.overlap.length - a.overlap.length)[0];
      rows.push({
        ic: "warn",
        b: `${base} moved under it`,
        small: (
          <>
            {plural(d.behind, "commit")} landed on {base} since it branched, and {d.overlap.length === 1 ? "a file" : `${d.overlap.length} files`} changed here changed there too
            {top ? (
              <>
                , in <code>{top.short}</code> “{top.subject}”
              </>
            ) : null}
            .
          </>
        ),
        act: rebase,
      });
    } else if (w.behind) rows.push({ ic: "ok", b: `Nothing it changes changed on ${base}`, small: `${plural(w.behind, "commit")} landed on ${base} since it branched, none in these files.`, act: rebase });
    else rows.push({ ic: "ok", b: `Up to date with ${base}` });
    if (gh)
      rows.push({
        ic: "todo",
        b: "No pull request yet",
        small: github ? (
          `One into ${base} runs its checks and asks for a review.`
        ) : (
          <>
            <a href={connectorsHref()}>Connect GitHub</a> to see it once it has one.
          </>
        ),
        act: ask("pr", "pr", "Open a pull request", [`push it and open a pull request into ${w.base}`, `pushes it and opens a pull request into ${w.base}`], left),
      });
    rows.push({ ic: "todo", b: `Land on ${base}`, small: `${going ? going.label : "A new thread"} commits what isn't, rebases, runs the tests and lands it.`, act: ask("land", "up", `Land on ${base}`, [`commit, rebase and land it on ${w.base}`, `lands it on ${w.base}`], left) });
  }
  const gate = !left && w.commits ? <Gate title="Landed" rows={rows} over /> : <Gate title={`Before it lands on ${base}`} rows={rows} />;

  // Under its title, its branch: in which folder (on which machine), and its last commit. What's left on it can go
  // too, thrown away, from there: Discard.
  const lose = [w.ahead ? `${plural(w.ahead, "commit")} not on ${w.base}` : "", w.dirty ? `${plural(w.dirty, "file")} not committed` : ""].filter(Boolean).join(" and ");
  const discard =
    !mine || !left ? null : !cleaning ? (
      <button className="wf-btn" type="button" disabled={!canClean} title={canClean ? `Removes ${w.worktree ? "its worktree and " : ""}its branch, throwing away ${lose}` : `Not while ${cleanWhy}`} onClick={() => setCleaning(w.id)}>
        <Icon name="x" />
        Discard
      </button>
    ) : (
      <div className="wip-sure">
        <p>
          Remove {w.worktree ? "its worktree and " : ""}its branch, throwing away {lose}?
        </p>
        <div className="wip-sure-btns">
          <button className="btn btn--sm btn--red" type="button" disabled={busy} onClick={() => void clean("discard")}>
            Discard
          </button>
          <button className="btn btn--sm btn--line" type="button" onClick={() => setCleaning(null)}>
            Keep
          </button>
        </div>
      </div>
    );
  const items: Fact[] = w.shared
    ? [["laptop", w.machine ? <>On <b>{w.machine}</b></> : "No machine of anyone on it has it now"]]
    : [
        [
          "folder",
          folder ? (
            <>
              {folder}
              <CopyBtn text={w.worktree} />
            </>
          ) : (
            "Not checked out"
          ),
          w.worktree || "",
        ],
        ["laptop", many() || !w.worktree ? w.machine : ""],
      ];
  items.push(["commit", w.at ? `Last commit ${agoText(w.at)}` : "", w.subject || ""]);
  const facts = <WipFacts items={items} acts={discard} />;

  const cx: PullCx = { x: w, d, reload: () => void load.reload(), patchThread: () => {} };
  return (
    <WipFrame x={w} ws={ws} crumbs={crumbs}>
      <div data-key="head">
        {head}
        {facts}
      </div>
      <div data-key="gate">
        {gate}
        <AsOf d={d} machine={w.machine} />
      </div>
      <div data-key="threads">
        <WipThreads x={w} box={mine ? `Start a new thread on ${w.branch}…` : ""} />
      </div>
      <div data-key="tabs">
        <WipTabs
          tabs={[
            ["changes", "Changes", wipChanges(cx, failed)],
            ["activity", "Activity", wipStory(w, d, posts)],
            ["results", "Results", wipResults(posts)],
          ]}
        />
      </div>
    </WipFrame>
  );
}

// What happened on it, oldest first: its threads starting, their results and ending, its commits, and main's
// commits landing under it. None when nothing has.
function wipStory(w: Wip, d: BranchRead | null, posts: Wip["posts"]) {
  const ev: StoryEvent[] = threadEvents(posts);
  for (const c of d?.commits || [])
    ev.push({
      at: c.at,
      cls: c.landed ? "landed" : "",
      body: (
        <span>
          <code>{c.short}</code> {c.subject}
          {c.landed ? <span className="tag">on {w.base} too</span> : null}
        </span>
      ),
    });
  for (const c of d?.main || [])
    ev.push({
      at: c.at,
      cls: "main",
      body: (
        <span>
          <span className="lane">{w.base}</span>
          <code>{c.short}</code> {c.subject}
          {c.overlap.length ? (
            <span className="tag tag--main" title={c.overlap.join("\n")}>
              {plural(c.overlap.length, "file")} changed here too
            </span>
          ) : null}
        </span>
      ),
    });
  if (!ev.length) return null;
  return { n: ev.length, body: <StoryList ev={ev} /> };
}

// Its changes, from git: what isn't committed in its worktree, or what its commits changed since it
// branched. Each file opens to its diff, and says when main changed it too.
function wipChanges(cx: PullCx, failed: boolean) {
  const d = cx.d as BranchRead | null;
  if (!d) return { n: "", body: <p className="muted wip-none">{failed ? "Couldn't read this branch from git." : "Reading git…"}</p> };
  return { n: new Set([...(d.committed || []), ...(d.uncommitted || [])].map((f) => f.path)).size, body: <BranchChanges cx={cx} d={d} /> };
}
// Its Changes' two scopes: what isn't committed, and what its commits changed since it branched.
const SCOPES: [string, string, keyof BranchRead][] = [
  ["uncommitted", "Not committed", "uncommitted"],
  ["committed", "Since it branched", "committed"],
];
function BranchChanges({ cx, d }: { cx: PullCx; d: BranchRead }) {
  const w = cx.x;
  const picked = usePage((s) => s.scope);
  const scope = picked || ((d.uncommitted || []).length || !(d.committed || []).length ? "uncommitted" : "committed");
  const list = (d[SCOPES.find(([k]) => k === scope)[2]] || []) as ChangedFile[];
  const seg = (
    <span className="seg">
      {SCOPES.map(([k, label, of]) => (
        <button type="button" className={scope === k ? "is-on" : ""} key={k} onClick={() => setScope(k)}>
          {label} <span className="muted">{((d[of] || []) as ChangedFile[]).length}</span>
        </button>
      ))}
    </span>
  );
  const files = list.length ? (
    <ul className="chg-files">
      {list.map((f) => (
        <BranchFile key={f.path} cx={cx} f={f} scope={scope} />
      ))}
    </ul>
  ) : (
    <p className="muted wip-none">{scope === "uncommitted" ? ((w.shared ? d.checked_out : w.worktree) ? "Nothing that isn't committed." : "It isn't checked out anywhere.") : "No commits since it branched."}</p>
  );
  return (
    <>
      <div className="wip-tab-h">
        {seg}
        <ChgSize {...totals(list)} />
      </div>
      {files}
    </>
  );
}
function BranchFile({ cx, f, scope }: { cx: PullCx; f: ChangedFile; scope: string }) {
  const w = cx.x;
  const key = `${scope}|${f.path}`;
  const open = usePage((s) => s.open.has(key));
  const x = usePage((s) => s.diffs[key]);
  const kind = f.untracked ? "new, untracked" : f.kind === "create" ? "new" : f.kind === "delete" ? "deleted" : "";
  return (
    <li className={open ? "is-open" : ""}>
      <button className="chg-row" type="button" data-wip-file={f.path} aria-expanded={open} onClick={() => toggleFile(key, () => void loadWipDiff(w, scope, f.path))}>
        <span className="chg-path">
          <PathName p={f.path} />
        </span>
        {kind ? <span className="tag">{kind}</span> : null}
        {f.on_main ? (
          <span className="tag tag--main" title={`${w.base} changed it too since this branched`}>
            changed on {w.base}
          </span>
        ) : null}
        {f.binary ? <small className="chg-n">binary</small> : <ChgSize add={f.add} del={f.del} />}
        <Icon name="caret" />
      </button>
      {open ? (
        <div className="chg-body">
          <DiffView f={diffOf(x)} />
          <PrActs cx={cx} o={{ key: `f:${f.path}` }} />
        </div>
      ) : null}
    </li>
  );
}
