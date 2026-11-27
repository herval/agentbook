// A pull request's page (the old renderPull): where it stands on GitHub, what's between it and merging, its threads,
// and its changes, checks, review, story, description and its threads' results. Its page reads it in full from
// GitHub, again when the sidebar's summary of it says something changed.
import { Fragment, useLayoutEffect, useState } from "react";
import type { ReactNode } from "react";
import { machineInfo, many, waits } from "../../lib/agents.ts";
import { post } from "../../lib/api.ts";
import { ago, agoText, plural, webUrl } from "../../lib/format.ts";
import { useLoad } from "../../lib/hooks.ts";
import { workspaceHref } from "../../lib/route.ts";
import { toast } from "../../lib/toast.ts";
import { Icon, type IconName } from "../Icon.tsx";
import { Markdown } from "../Markdown.tsx";
import { SharedCrumbs, TaskTag } from "../tasks/Ship.tsx";
import { TreeCorner } from "../Visibility.tsx";
import { DiffView, diffOf, PathName, wipResults } from "./Diff.tsx";
import { InlineMd } from "./PageText.tsx";
import { fileOpened, loadPullDiff, pageFor, setCleaning, showAll, toggleFile, usePage, useScrollTo } from "./PageState.ts";
import { EVENT_VERB, PrActs, resolveThread, REVIEW_VERB, type PullCx, type PullRead, type ReadThread } from "./PullActs.tsx";
import { sharedApi } from "./ship.ts";
import { AskButton, CopyBtn, Gate, StoryList, threadEvents, useFullRows, WipFacts, WipFrame, WipTabs, WipThreads, type Fact, type GateRow, type StoryEvent } from "./WipPage.tsx";
import { ChgSize } from "./WipRow.tsx";
import { askWip, behindOf, ghBody, ghName, ghText, PR_ASK, prAt, prKey, prPlace, tilde, useWorld, type Wip } from "./wips.ts";

const PR_STATE: Record<string, [string, IconName]> = { open: ["Open", "pr"], draft: ["Draft", "pr"], merged: ["Merged", "merge"], closed: ["Closed", "x"] };
// Clean up its branch, once it's merged or closed: { act, small }, the question while it's asked.
interface CleanRow {
  act: ReactNode;
  small?: ReactNode;
}

// Its page: where it stands, its branch, what's between it and merging, its threads, and its tabs; beside it, its tasks,
// its group and the rest of its workspace's worktrees.
export function PullPage({ x }: { x: Wip }) {
  useWorld();
  const ws = x.ws;
  const p = x.pr;
  const cleaning = usePage((s) => s.cleaning === x.id);
  const [busy, setBusy] = useState(false);
  const url = x.shared ? sharedApi(x, "pull") : `/api/pulls?${new URLSearchParams({ workspace: x.ws.id, number: String(x.number) })}`;
  const load = useLoad<PullRead>(url, prKey(x));
  const err = load.error ? load.error || "Couldn't read it from GitHub." : "";
  const d = err ? null : load.data;
  const posts = useFullRows(x.posts);
  useLayoutEffect(() => {
    pageFor(x.id);
    fileOpened(x, d?.sha || "");
  }, [x.id]);
  useScrollTo();

  const crumbs = x.shared ? (
    <SharedCrumbs w={x} last={`#${p.number}`} />
  ) : (
    <p className="crumbs">
      <a href={workspaceHref(ws.id)}>{ws.name}</a>
      <span className="sep">/</span>
      <a href={workspaceHref(ws.id, "worktrees")}>Worktrees</a>
      <span className="sep">/</span>
      <span>#{p.number}</span>
    </p>
  );
  const me = x.me;
  const open = p.state === "open" || p.state === "draft";
  const [label, ico] = PR_STATE[p.state] || PR_STATE.open;
  const gh = webUrl(p.url);
  const head = (
    <>
      <div className="wip-ref">
        <span className={`wst wst--pr-${p.state}`}>
          <Icon name={ico} />
          {label}
        </span>
        <a href={gh || "#"} target="_blank" rel="noopener" title="On GitHub">
          <b>#{p.number}</b>
        </a>
        <span className="chip chip--branch">{p.head}</span>
        <span>
          into <code>{p.base}</code>
        </span>
        <span title={new Date(p.created).toLocaleString()}>
          opened by {ghName(p.author, me)} {agoText(p.created)}
        </span>
        <TaskTag w={x} />
      </div>
      <h1 className="wip-title">
        {gh ? (
          <a href={gh} target="_blank" rel="noopener" title="Open it on GitHub">
            {p.title}
          </a>
        ) : (
          p.title
        )}
      </h1>
    </>
  );

  const busyOn = x.posts.filter((s) => s.effective === "working" || s.effective === "needs");
  // One on a task shared with you is only to read: no asking, answering on GitHub or cleaning up.
  const mine = !x.shared && x.posts.every((s) => s.mine !== false);
  const going = x.posts.find((s) => s.state !== "done" && s.mine !== false);
  const where = x.shared ? null : prPlace(x);
  // Fix the checks, Address the review, Rebase from main, Merge it: to the thread going on it, or a new thread.
  const ask = (k: string, icon: IconName, text: string, why: string, on = true, off = "") =>
    !open || !mine ? null : (
      <AskButton title={!on ? off : going ? `Asks ${going.label} to ${why}` : `Starts a thread that ${why.replace(/^(\w+)/, "$1s")}`} icon={icon} on={on && !!(going || where)} run={() => askWip(x, PR_ASK[k](prAt(x)))}>
        {text}
      </AskButton>
    );
  // Once it's merged or closed, its branch where a machine has it can go, from the line that says so: cleaned up
  // when it's what was pushed and nothing's uncommitted there, else discarded with what isn't.
  const l = !open && mine ? x.local.find((y) => !y.here && machineInfo(y.machine).online !== false) : null;
  const lost = l ? [l.sha && p.sha && l.sha !== p.sha ? "what on it isn't on GitHub" : "", l.dirty ? `${plural(l.dirty, "file")} not committed` : ""].filter(Boolean).join(" and ") : "";
  // Clean up (or discard) its branch, once it's merged or closed: the one the page offers, at the commit it showed.
  const cleanIt = async () => {
    setBusy(true);
    const r = await post<{ removed?: boolean; sha?: string }>(`/api/wip/discard${l.machine ? `?machine=${encodeURIComponent(l.machine)}` : ""}`, { root: l.root, branch: l.branch, sha: l.sha });
    if (r.ok && r.data.queued) toast(waits(r.data, "it removes the branch"));
    else if (r.ok) toast(`Removed ${l.branch}${r.data.removed ? ", and its worktree" : ""}. git branch ${l.branch} ${String(r.data.sha || l.sha).slice(0, 7)} brings it back.`);
    setBusy(false);
    setCleaning(null);
  };
  const clean: CleanRow | null = !l
    ? null
    : !cleaning
      ? {
          act: (
            <button className="btn btn--line" type="button" disabled={!!busyOn.length} title={busyOn.length ? `Not while ${busyOn[0].label} is working on it` : `It's ${p.state}: removes ${l.worktree ? "its worktree and " : ""}its branch${lost ? `, throwing away ${lost}` : ""}. git keeps its last commit a while.`} onClick={() => setCleaning(x.id)}>
              <Icon name={lost ? "x" : "archive"} />
              {lost ? "Discard its branch" : "Clean up its branch"}
            </button>
          ),
        }
      : {
          small: `Remove ${l.worktree ? "its worktree and " : ""}its branch${many() ? ` on ${l.machine}` : ""}${lost ? `, throwing away ${lost}` : ""}?`,
          act: (
            <span className="gate-btns">
              <button className={`btn ${lost ? "btn--red" : "btn--dark"}`} type="button" disabled={busy} onClick={() => void cleanIt()}>
                {lost ? "Discard" : "Clean up"}
              </button>
              <button className="btn btn--line" type="button" onClick={() => setCleaning(null)}>
                Keep
              </button>
            </span>
          ),
        };
  // Under its title, its branch: where a machine has it (in which folder, what isn't committed there, and whether
  // it's at the commit GitHub has), its commits, who it's assigned to and its labels.
  const items: Fact[] = x.local.length
    ? x.local.map((y): Fact => {
        const off = [y.dirty ? `${plural(y.dirty, "file")} not committed` : "", y.sha && p.sha && y.sha !== p.sha ? "not at the commit GitHub has" : ""].filter(Boolean).join(", ");
        if (x.shared)
          return [
            "laptop",
            <>
              On <b>{y.machine}</b>
              {off ? <small>{off}</small> : null}
            </>,
          ];
        return [
          "folder",
          <>
            {many() ? (
              <>
                <b>{y.machine}</b>{" "}
              </>
            ) : null}
            {y.worktree ? y.place || tilde(y.machine, y.worktree) : many() ? "not checked out" : "Not checked out"}
            {y.worktree ? <CopyBtn text={y.worktree} /> : null}
            {off ? <small>{off}</small> : null}
          </>,
          y.worktree || "",
        ];
      })
    : [["folder", "No machine has it"]];
  items.push(
    ["commit", d?.commits ? plural(d.commits, "commit") : ""],
    ["agents", d?.assignees?.length ? `Assigned to ${d.assignees.map((a) => ghName(a, me)).join(", ")}` : ""],
    [
      "",
      d?.labels?.length
        ? d.labels.map((y) => (
            <span className="chip" key={y.name}>
              {y.name}
            </span>
          ))
        : "",
      d?.labels?.map((y) => y.name).join(", "),
    ],
  );

  // The page has what it did at once, before GitHub's read again says so.
  const cx: PullCx = {
    x,
    d,
    reload: () => void load.reload(),
    patchThread: (id, change) => load.set((v) => (v ? { ...v, threads_list: (v.threads_list || []).map((t) => (t.id === id ? { ...t, ...change } : t)) } : v)),
  };
  return (
    <WipFrame x={x} ws={ws} crumbs={crumbs}>
      <div data-key="head">
        {mine && ws ? <TreeCorner ws={ws.id} branch={p.head} cls=" vis-corner--card" /> : null}
        {head}
        <WipFacts items={items} />
      </div>
      <div data-key="gate">
        <PullGate x={x} d={d} ask={ask} err={err} clean={clean} />
      </div>
      <div data-key="threads">
        <WipThreads x={x} box={mine && where ? `Start a new thread on #${p.number}…` : ""} />
      </div>
      <div data-key="tabs">
        <WipTabs
          tabs={[
            ["changes", "Changes", pullChanges(cx, err)],
            ["checks", "Checks", pullChecks(d)],
            ["review", "Review", pullReview(cx)],
            ["activity", "Activity", pullStory(x, d, posts)],
            ["description", "Description", pullBody(d)],
            ["results", "Results", wipResults(posts, p.url)],
          ]}
        />
      </div>
    </WipFrame>
  );
}

// What stands between it and merging, from GitHub: its checks, its review, whether it conflicts with (or is behind)
// its base, and merging it, each with what fixes it. Merged or closed, that it is, with cleaning up its branch
// (`clean`: { act, small }, the question while it's asked).
// What makes a line's button that asks its agent (renderPull's ask).
type Ask = (k: string, icon: IconName, text: string, why: string, on?: boolean, off?: string) => ReactNode;
function PullGate({ x, d, ask, err, clean = null }: { x: Wip; d: PullRead | null; ask: Ask; err: string; clean?: CleanRow | null }) {
  const p = x.pr;
  const me = x.me;
  const base = <code>{p.base}</code>;
  const fail: GateRow[] = err ? [{ ic: "fail", b: "Couldn't read it from GitHub", small: err }] : [];
  if (p.state === "merged")
    return (
      <Gate
        title="Merged"
        rows={[
          ...fail,
          {
            ic: "ok",
            b: <>Merged into {base}</>,
            small: clean?.small || `${d?.merged_by ? `By ${ghName(d.merged_by, me)}, ` : ""}${agoText(p.closed)}.`,
            act: clean?.act,
          },
        ]}
        over
      />
    );
  if (p.state === "closed") return <Gate title="Closed" rows={[...fail, { ic: "fail", b: "Closed without merging", small: clean?.small || `${agoText(p.closed)}.`, act: clean?.act }]} over />;
  const rows = [...fail];
  const later: ReactNode[] = []; // what merging waits for
  const laterText: string[] = []; // and as words, for a title
  const wait = (node: ReactNode, text: string) => (later.push(node), laterText.push(text));
  const c = p.checks;
  if (c?.fail) {
    const failed = d ? (d.checks_list || []).filter((y) => y.state === "fail") : [];
    const names = failed.map((y) => y.name);
    const one = failed.length === 1 ? failed[0] : null;
    rows.push({
      ic: "fail",
      b: names.length ? `${names.slice(0, 2).join(", ")}${names.length > 2 ? `, and ${names.length - 2} more` : ""} failed` : `${plural(c.fail, "check")} failing`,
      small: `${one ? `${[one.workflow && one.workflow !== one.name ? one.workflow : "", one.required ? "required" : ""].filter(Boolean).join(", ")}${one.workflow || one.required ? ". " : ""}` : ""}${c.pass ? `The other ${c.pass} passed` : ""}${c.skip ? `${c.pass ? ", " : ""}${c.skip} skipped` : ""}${c.pass || c.skip ? "." : ""}`,
      act: ask("checks", "check", "Fix the checks", "fix its failing checks"),
    });
    wait("the checks pass", "the checks pass");
  } else if (c?.pending) {
    rows.push({ ic: "part", b: `${plural(c.pending, "check")} running`, small: c.pass ? `${c.pass} passed so far.` : "" });
    wait("the checks finish", "the checks finish");
  } else if (c?.total) rows.push({ ic: "ok", b: "Checks passed", small: `${plural(c.pass, "check")}${c.skip ? `, ${c.skip} skipped` : ""}.` });
  const by = (state: string) => (d ? (d.reviewers || []).filter((r) => r.state === state).map((r) => ghName(r.who, me)) : []);
  if (p.review === "changes") {
    const who = by("changes_requested");
    const said = d ? [...(d.reviews_list || [])].reverse().find((r) => r.state === "changes_requested" && ghText(r.body))?.body : "";
    rows.push({ ic: "fail", b: `${who.length ? who.join(", ") : "A reviewer"} asked for changes`, small: [said ? `“${ghText(said, 160)}”` : "", p.threads ? `${plural(p.threads, "review thread")} open.` : ""].filter(Boolean).join(" "), act: ask("review", "comment", "Address the review", "address its review") });
    const w = `${who.length === 1 ? who[0] : "its reviewers"} approve${who.length === 1 ? "s" : ""}`;
    wait(w, w);
  } else if (p.threads) {
    rows.push({ ic: "warn", b: `${plural(p.threads, "review thread")} unresolved`, act: ask("review", "comment", "Address the review", "address its review") });
    wait("its review threads are resolved", "its review threads are resolved");
  }
  if (p.review === "approved") rows.push({ ic: "ok", b: `Approved${by("approved").length ? ` by ${by("approved").join(", ")}` : ""}` });
  else if (p.review === "required") {
    rows.push({ ic: "todo", b: "Waiting for a review", small: d?.requested?.length ? `From ${d.requested.join(", ")}.` : "" });
    wait("it's approved", "it's approved");
  } else if (p.state === "draft") {
    rows.push({ ic: "todo", b: "It's a draft", small: "Nobody's asked to review it until it's marked ready." });
    wait("it's marked ready", "it's marked ready");
  }
  const behind = behindOf(x);
  if (p.mergeable === "conflicts") {
    rows.push({ ic: "fail", b: <>It conflicts with {base}</>, small: <>It can't merge until it's rebased onto {base} and the conflicts resolved.</>, act: ask("rebase", "down", `Rebase from ${p.base}`, `rebase it onto ${p.base}`) });
    wait("the conflicts are resolved", "the conflicts are resolved");
  } else if (p.merge_state === "behind") {
    rows.push({ ic: "warn", b: <>{base} moved ahead of it</>, small: "This repo wants it up to date before it merges.", act: ask("rebase", "down", `Rebase from ${p.base}`, `rebase it onto ${p.base}`) });
    wait(<>it's rebased onto {base}</>, `it's rebased onto ${p.base}`);
  } else if (p.mergeable === "yes")
    rows.push({
      ic: "ok",
      b: <>No conflicts with {base}</>,
      small: behind ? (
        <>
          {base} moved {plural(behind, "commit")} since it branched.
        </>
      ) : (
        ""
      ),
    });
  const ready = x.state === "ready";
  // "Once the checks pass, it's approved and the conflicts are resolved."
  const once = (parts: ReactNode[]) =>
    parts.map((n, i) => (
      <Fragment key={i}>
        {i ? (i === parts.length - 1 ? " and " : ", ") : ""}
        {n}
      </Fragment>
    ));
  const waitNode = later.length ? <>Once {once(later)}.</> : null;
  const waitText = laterText.length ? `Once ${laterText.slice(0, -1).join(", ")}${laterText.length > 1 ? " and " : ""}${laterText.at(-1)}.` : "";
  rows.push({ ic: ready ? "ok" : "todo", b: <>Merge into {base}</>, small: ready ? "Nothing's in the way." : waitNode || (p.mergeable === "yes" ? "" : "GitHub is still working out whether it merges cleanly."), act: ask("merge", "merge", "Merge it", "merge it", ready, waitText) });
  return (
    <Gate
      title={
        <>
          Before it merges into {base}
        </>
      }
      rows={rows}
    />
  );
}

// Its description, as markdown.
function pullBody(d: PullRead | null) {
  const text = d ? ghBody(d.body) : "";
  return text
    ? {
        body: (
          <div className="pr-body">
            <Markdown text={text} />
          </div>
        ),
      }
    : null;
}

// Its checks, the ones failing or still running first.
const CHECK_WORD = { pass: "passed", fail: "failed", pending: "running", skip: "skipped" };
const CHECK_ICON: Record<string, IconName> = { pass: "check", fail: "x", pending: "clock", skip: "minus" };
const CHECK_RANK = { fail: 0, pending: 1, pass: 2, skip: 3 };
function pullChecks(d: PullRead | null) {
  if (!d?.checks_list?.length) return null;
  const list = [...d.checks_list].sort((a, b) => CHECK_RANK[a.state] - CHECK_RANK[b.state]);
  const word = (c: (typeof list)[number]) => ((c.state === "fail" && c.conclusion && !["failure", "error"].includes(c.conclusion)) || (c.state === "skip" && c.conclusion === "cancelled") ? c.conclusion.replace(/_/g, " ") : CHECK_WORD[c.state]);
  const c = d.checks;
  return {
    n: c?.fail ? `${c.fail} failed` : list.length,
    cls: c?.fail ? "is-bad" : "",
    body: (
      <ul className="checks">
        {list.map((y, i) => (
          <li className={`ck ck--${y.state}`} key={i}>
            <span className="ck-ico">
              <Icon name={CHECK_ICON[y.state]} />
            </span>
            <span className="ck-name">
              <b>{y.name}</b>
              {y.workflow && y.workflow !== y.name ? <small>{y.workflow}</small> : y.text ? <small>{y.text}</small> : null}
            </span>
            {y.required ? <span className="tag">required</span> : null}
            <span className="ck-st">{word(y)}</span>
            {webUrl(y.url) ? (
              <a className="ck-link" href={webUrl(y.url)} target="_blank" rel="noopener" title="Its details on GitHub">
                <Icon name="external" />
              </a>
            ) : (
              <span className="ck-link" />
            )}
          </li>
        ))}
      </ul>
    ),
  };
}

// Its review: the review threads nobody's resolved yet, each with the lines it's on and what was said on it, then
// the conversation (its reviews and people's comments, the latest few), and a box to comment on it. Each of them
// can be answered on GitHub as you, or told to its agent (PrActs); a thread resolved too.
function pullReview(cx: PullCx) {
  const d = cx.d as PullRead | null;
  if (!d) return null;
  const live = (d.threads_list || []).filter((t) => !t.resolved);
  return { n: live.length ? `${live.length} open` : "", body: <PullReview cx={cx} d={d} /> };
}
// When something was said, how long ago (its title says when exactly).
const When = ({ at }: { at: string }) => <time title={new Date(at).toLocaleString()}>{ago(at)}</time>;
const OnGh = ({ url }: { url?: string | null }) =>
  webUrl(url) ? (
    <a href={webUrl(url)} target="_blank" rel="noopener">
      On GitHub
    </a>
  ) : null;
function PullReview({ cx, d }: { cx: PullCx; d: PullRead }) {
  const { x } = cx;
  const me = x.me;
  const prDone = usePage((s) => s.done);
  const all = usePage((s) => s.all);
  const open = x.pr.state === "open" || x.pr.state === "draft";
  const threadsList = d.threads_list || [];
  const waiting = d.requested?.length && open ? <p className="muted wip-none">Waiting on {d.requested.join(", ")}.</p> : null;
  const said = (c: ReadThread["comments"][number]) => (
    <div className="thread-c" key={c.id}>
      <b>{ghName(c.who, me)}</b> <When at={c.at} />
      <Markdown text={ghBody(c.body)} />
    </div>
  );
  const live = threadsList.filter((t) => !t.resolved);
  // Ones you resolved here stay, folded, so Undo is right there.
  const done = threadsList.filter((t) => t.resolved && prDone.has(t.id));
  const threads = live.map((t) => (
    <div className="thread" key={t.id}>
      <p className="thread-h">
        <code>
          {t.path}
          {t.line ? `:${t.line}` : ""}
        </code>
        {t.outdated ? <span className="tag">outdated</span> : null}
        <OnGh url={t.comments[0]?.url} />
      </p>
      {t.hunk ? (
        <div className="rp-code">
          <div className="dv">
            <table className="dv-t">
              <tbody>
                {t.hunk.map((l, i) => (
                  <tr className={`${l[0] === "+" ? "dv-add" : l[0] === "-" ? "dv-del" : ""}${i === t.hunk.length - 1 ? " is-at" : ""}`} key={i}>
                    <td className="code">
                      <span className="sign">{l[0] === "+" ? "+" : l[0] === "-" ? "−" : ""}</span>
                      {l.slice(1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
      {t.comments.map(said)}
      <PrActs cx={cx} o={{ key: `t:${t.id}`, reply: t.can?.reply !== false, thread: t }} />
    </div>
  ));
  const folded = done.map((t) => (
    <div className="thread is-done" key={t.id}>
      <p className="thread-h">
        <span className="gate-ic gate-ic--ok">
          <Icon name="check" />
        </span>
        <code>
          {t.path}
          {t.line ? `:${t.line}` : ""}
        </code>
        <span>Resolved</span>
        {t.can?.unresolve !== false ? (
          <button className="rp-quiet" type="button" onClick={(e) => void resolveThread(cx, t.id, true, e.currentTarget)}>
            Undo
          </button>
        ) : null}
      </p>
    </div>
  ));
  // The conversation: reviews that say something or decide something, and people's comments (not bots'), the latest
  // few unless you asked for all.
  const talk = [
    ...(d.reviews_list || [])
      .filter((r) => !r.bot)
      .map((r) => ({
        at: r.at,
        key: `r:${r.id}`,
        who: r.who,
        body: (
          <>
            <p className="thread-h">
              <b>{ghName(r.who, me)}</b>
              {REVIEW_VERB[r.state] || "reviewed it"} <When at={r.at} />
              <OnGh url={r.url} />
            </p>
            {ghText(r.body) ? (
              <div className="thread-c">
                <Markdown text={ghBody(r.body)} />
              </div>
            ) : null}
          </>
        ),
      })),
    ...(d.comments_list || [])
      .filter((c) => !c.bot)
      .map((c) => ({
        at: c.at,
        key: `c:${c.id}`,
        who: c.who,
        body: (
          <>
            <p className="thread-h">
              <b>{ghName(c.who, me)}</b>commented <When at={c.at} />
              <OnGh url={c.url} />
            </p>
            <div className="thread-c">
              <Markdown text={ghBody(c.body)} />
            </div>
          </>
        ),
      })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const shown = all ? talk : talk.slice(-6);
  const resolved = threadsList.filter((t) => t.resolved).length - done.length;
  return (
    <>
      {waiting}
      {threads.length || folded.length ? (
        <div className="threads">
          {threads}
          {folded}
        </div>
      ) : null}
      {resolved ? <p className="muted wip-none">{plural(resolved, "review thread")} resolved.</p> : null}
      {talk.length ? (
        <>
          <h4 className="rp-h">Conversation</h4>
          {talk.length > shown.length ? (
            <button className="wl-more rp-earlier" type="button" onClick={showAll}>
              <Icon name="up" />
              Show {plural(talk.length - shown.length, "earlier comment")}
            </button>
          ) : null}
          <div className="threads">
            {shown.map((c) => (
              <div className="thread" key={c.key}>
                {c.body}
                <PrActs cx={cx} o={{ key: c.key, reply: c.who !== me, who: c.who }} />
              </div>
            ))}
          </div>
        </>
      ) : null}
      <PrActs cx={cx} o={{ key: "pr", reply: true, top: true }} />
    </>
  );
}

// What happened on it, oldest first: its threads, and from GitHub its commits, comments, reviews, review
// comments, and its merging or closing.
function pullStory(x: Wip, d: PullRead | null, posts: Wip["posts"]) {
  const me = x.me;
  const who = (login: string) => <span className="who">{login === me ? "You" : `@${login}`}</span>;
  const said = (body: string, url?: string | null) => (
    <>
      {webUrl(url) ? (
        <a className="gh-link" href={webUrl(url)} target="_blank" rel="noopener" title="On GitHub">
          <Icon name="external" />
        </a>
      ) : null}
      {ghText(body) ? (
        <small className="gh-q">
          <InlineMd text={ghText(body)} />
        </small>
      ) : null}
    </>
  );
  const ev: StoryEvent[] = threadEvents(posts);
  if (d) {
    ev.push({ at: d.created, body: <span>{who(d.author)} opened it</span> });
    for (const c of d.commits_list || [])
      ev.push({
        at: c.at,
        body: (
          <span>
            <code>{c.short}</code> {c.subject}
          </span>
        ),
      });
    for (const c of d.comments_list || [])
      ev.push({
        at: c.at,
        cls: "talk",
        body: (
          <span>
            {who(c.who)} commented{said(c.body, c.url)}
          </span>
        ),
      });
    for (const r of d.reviews_list || [])
      ev.push({
        at: r.at,
        cls: r.state === "approved" ? "ok" : r.state === "changes_requested" ? "err" : "talk",
        body: (
          <span>
            {who(r.who)} {REVIEW_VERB[r.state] || "reviewed it"}
            {said(r.body, r.url)}
          </span>
        ),
      });
    for (const t of d.threads_list || [])
      for (const c of t.comments)
        ev.push({
          at: c.at,
          cls: "talk",
          body: (
            <span>
              {who(c.who)} on{" "}
              <code>
                {t.path}
                {t.line ? `:${t.line}` : ""}
              </code>
              {t.resolved ? <span className="tag">resolved</span> : null}
              {said(c.body, c.url)}
            </span>
          ),
        });
    for (const e of d.events || [])
      ev.push({
        at: e.at,
        cls: e.kind === "merged" ? "ok" : e.kind === "closed" ? "err" : "",
        body: (
          <span>
            {e.who ? who(e.who) : "Someone"} {EVENT_VERB[e.kind]}
          </span>
        ),
      });
  }
  if (!ev.length) return d ? null : { n: "", body: <p className="muted wip-none">Reading GitHub…</p> };
  return { n: ev.length, body: <StoryList ev={ev} /> };
}

// The files it changes, as GitHub has them; each opens to its diff.
function pullChanges(cx: PullCx, err: string) {
  const { x } = cx;
  const d = cx.d as PullRead | null;
  if (!d) return { n: x.pr.files || "", body: <p className="muted wip-none">{err ? "Couldn't read its changes from GitHub." : "Reading GitHub…"}</p> };
  const list = d.files_list || [];
  return {
    n: d.files,
    body: (
      <>
        <div className="wip-tab-h">
          <ChgSize add={d.add} del={d.del} />
        </div>
        {list.length ? (
          <>
            <ul className="chg-files">
              {list.map((f) => (
                <PullFile key={f.path} cx={cx} d={d} f={f} />
              ))}
            </ul>
            {d.files_more ? (
              <p className="muted wip-none">
                And {plural(d.files_more, "more file")},{" "}
                <a href={webUrl(d.url) ? `${d.url}/files` : "#"} target="_blank" rel="noopener">
                  on GitHub
                </a>
                .
              </p>
            ) : null}
          </>
        ) : (
          <p className="muted wip-none">It doesn't change any files.</p>
        )}
      </>
    ),
  };
}
function PullFile({ cx, d, f }: { cx: PullCx; d: PullRead; f: NonNullable<PullRead["files_list"]>[number] }) {
  const { x } = cx;
  const key = `pr|${f.path}`;
  const open = usePage((s) => s.open.has(key));
  const y = usePage((s) => s.diffs[key]);
  const kind = f.kind === "create" ? "new" : f.kind === "delete" ? "deleted" : f.kind === "rename" ? "renamed" : "";
  const talk = (d.threads_list || []).filter((t) => !t.resolved && t.path === f.path).length;
  return (
    <li className={open ? "is-open" : ""}>
      <button className="chg-row" type="button" data-pr-file={f.path} aria-expanded={open} onClick={() => toggleFile(key, () => void loadPullDiff(x, f.path, d.sha || x.pr.sha || ""))}>
        <span className="chg-path">
          <PathName p={f.path} />
        </span>
        {kind ? <span className="tag">{kind}</span> : null}
        {talk ? (
          <span className="chg-talk" title={`${plural(talk, "review thread")} open on it`}>
            <Icon name="comment" />
            {talk}
          </span>
        ) : null}
        <ChgSize add={f.add} del={f.del} />
        <Icon name="caret" />
      </button>
      {open ? (
        <div className="chg-body">
          <DiffView f={diffOf(y)} />
          <PrActs cx={cx} o={{ key: `f:${f.path}` }} />
        </div>
      ) : null}
    </li>
  );
}
