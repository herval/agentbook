// Pull requests for the stand-in GitHub (fake-github.ts), the way GitHub's GraphQL API has them, from a short
// description: pull({ number, title, head, … }). Used by the tests and the demo.

import crypto from "node:crypto";

const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
const user = (login: string) => ({ login });

export type CheckHow = "pass" | "fail" | "pending" | "skip" | "cancel";
// A comment: who, what it says, how many seconds ago.
export type CommentSpec = [who: string, body: string, secondsAgo: number];

// checks: [[name, "pass" | "fail" | "pending" | "skip" | "cancel", { workflow, required }]]; comments: [[who, body, secondsAgo]];
// reviews: [[who, "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED", body, secondsAgo]]; threads: [{ path, line,
// resolved, hunk: [diff lines], comments: [[who, body, secondsAgo]] }]; files: [[path, add, del, "ADDED" | "MODIFIED" | …]];
// commits: [[subject, secondsAgo]]. tip: [subject, secondsAgo] of its base's latest commit; fork: [subject,
// secondsAgo, behind] of the commit it left its base at (its base's latest, when not given).
export interface PullSpec {
  repo: string;
  number: number;
  title: string;
  head: string;
  base?: string;
  author?: string;
  state?: "OPEN" | "CLOSED" | "MERGED";
  draft?: boolean;
  // Seconds ago.
  opened?: number;
  updated?: number;
  closed?: number | null;
  mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeState?: string;
  review?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  body?: string;
  checks?: [name: string, how: CheckHow, opts?: { workflow?: string; required?: boolean }][];
  comments?: CommentSpec[];
  reviews?: [who: string, state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED", body: string, secondsAgo: number][];
  threads?: { path: string; line?: number | null; resolved?: boolean; outdated?: boolean; hunk?: string[]; comments: CommentSpec[] }[];
  files?: [path: string, add: number, del: number, changeType?: string][];
  commits?: [subject: string, secondsAgo: number][];
  labels?: string[];
  // Logins, or "org/team" for a team.
  requested?: string[];
  mergedBy?: string | null;
  tip?: [subject: string, secondsAgo: number];
  fork?: [subject: string, secondsAgo: number, behind: number] | null;
}
// Who a review is asked of: a person (login) or a team (name).
interface Reviewer {
  __typename: "User" | "Team";
  login?: string;
  name?: string;
}
export function pull({ repo, number, title, head, base = "main", author = "herval", state = "OPEN", draft = false, opened = 7200, updated = 600, closed = null, mergeable = "MERGEABLE", mergeState = "CLEAN", review = null, body = "", checks = [], comments = [], reviews = [], threads = [], files = [], commits = [], labels = [], requested = [], mergedBy = null, tip = [`Latest on ${base}`, 900], fork = null }: PullSpec) {
  const sha = (number * 7919).toString(16).padStart(8, "0").repeat(5);
  const shaOf = (text: string) => crypto.createHash("sha1").update(text).digest("hex");
  const left: [string, number, number] = fork || [...tip, 0];
  const RUN: Record<CheckHow, [status: string, conclusion: string | null]> = { pass: ["COMPLETED", "SUCCESS"], fail: ["COMPLETED", "FAILURE"], pending: ["IN_PROGRESS", null], skip: ["COMPLETED", "SKIPPED"], cancel: ["COMPLETED", "CANCELLED"] };
  const contexts = checks.map(([name, how, o = {}]) => ({ __typename: "CheckRun", name, status: RUN[how][0], conclusion: RUN[how][1], detailsUrl: `https://github.com/${repo}/actions/runs/${number}${name.length}`, startedAt: ago(1800), completedAt: how === "pending" ? null : ago(900), isRequired: !!o.required, checkSuite: { workflowRun: { workflow: { name: o.workflow || "CI" } } } }));
  // A comment by a bot (acme-bot, github-actions, or one named "…[bot]") is a Bot's, as GitHub has it: its login
  // without the [bot].
  const reviewer = (name: string): Reviewer => (name.includes("/") ? { __typename: "Team", name: name.split("/")[1] } : { __typename: "User", login: name });
  const bot = (who: string) => /-bot$|^github-actions$|\[bot\]$/.test(who);
  const comment = ([who, text, s]: CommentSpec, i: number) => ({ id: `c${number}-${i}-${s}`, databaseId: number * 100 + i, author: { __typename: bot(who) ? "Bot" : "User", login: who.replace(/\[bot\]$/, "") }, body: text, createdAt: ago(s), url: `https://github.com/${repo}/pull/${number}#issuecomment-${number}${i}` });
  // hunk: the diff lines a thread is on, its line last.
  const threadNodes = threads.map((t, i) => ({ id: `t${number}-${i}`, isResolved: !!t.resolved, isOutdated: !!t.outdated, path: t.path, line: t.line ?? null, originalLine: t.line ?? null, viewerCanReply: true, viewerCanResolve: true, viewerCanUnresolve: true, hunk: { nodes: [{ diffHunk: t.hunk ? `@@ -1 +1 @@\n${t.hunk.join("\n")}` : null }] }, comments: { nodes: t.comments.map(comment) } }));
  const merged = state === "MERGED";
  return {
    number,
    title,
    url: `https://github.com/${repo}/pull/${number}`,
    state,
    isDraft: draft,
    createdAt: ago(opened),
    updatedAt: ago(updated),
    closedAt: closed == null ? null : ago(closed),
    mergedAt: merged && closed != null ? ago(closed) : null,
    headRefName: head,
    baseRefName: base,
    headRefOid: sha.slice(0, 40),
    baseRef: { target: { oid: shaOf(`${base}\0${tip[0]}`), committedDate: ago(tip[1]), messageHeadline: tip[0] } },
    // not GitHub's: what its compare says, for the stand-in to answer with
    _fork: { sha: shaOf(`${base}\0${left[0]}`), message: left[0], date: ago(left[1]), behind: left[2] },
    author: user(author),
    body,
    additions: files.reduce((n, f) => n + f[1], 0),
    deletions: files.reduce((n, f) => n + f[2], 0),
    changedFiles: files.length,
    mergeable: state === "OPEN" ? mergeable : "UNKNOWN",
    mergeStateStatus: state === "OPEN" ? mergeState : "UNKNOWN",
    reviewDecision: review,
    mergedBy: merged ? user(mergedBy || author) : null,
    comments: { totalCount: comments.length },
    commits: { totalCount: commits.length },
    reviewThreads: { nodes: threadNodes.map((t) => ({ isResolved: t.isResolved })) },
    checks: { nodes: [{ commit: { statusCheckRollup: contexts.length ? { state: "SUCCESS", contexts: { nodes: contexts } } : null } }] },
    labels: { nodes: labels.map((name) => ({ name, color: "ededed" })) },
    assignees: { nodes: [] as { login: string }[] },
    reviewRequests: { nodes: requested.map((name) => ({ requestedReviewer: reviewer(name) })) },
    latestOpinionatedReviews: { nodes: reviews.filter((r) => r[1] !== "COMMENTED").map(([who, st, , s]) => ({ author: user(who), state: st, submittedAt: ago(s) })) },
    log: { nodes: commits.map(([subject, s], i) => ({ commit: { oid: `${sha.slice(0, 32)}${String(i).padStart(8, "0")}`, abbreviatedOid: `${sha.slice(0, 6)}${i}`, messageHeadline: subject, committedDate: ago(s), author: { name: author, user: user(author) } } })) },
    allComments: { nodes: comments.map(comment) },
    reviews: { nodes: reviews.map(([who, st, text, s], i) => ({ id: `r${number}-${i}`, author: user(who), state: st, body: text, submittedAt: ago(s), url: `https://github.com/${repo}/pull/${number}#pullrequestreview-${number}${i}` })) },
    threads: { nodes: threadNodes },
    fileList: { totalCount: files.length, nodes: files.map(([path, additions, deletions, changeType = "MODIFIED"]) => ({ path, additions, deletions, changeType })) },
    timelineItems: { nodes: merged && closed != null ? [{ __typename: "MergedEvent", createdAt: ago(closed), actor: user(mergedBy || author) }] : state === "CLOSED" && closed != null ? [{ __typename: "ClosedEvent", createdAt: ago(closed), actor: user(author) }] : [] },
  };
}

// A pull request as GitHub's GraphQL API has it, as pull() makes it; `id` when a test gives it one.
export type Pull = ReturnType<typeof pull> & { id?: string };

// A unified diff that adds `lines` to `path`, for `gh pr diff`.
export const diffOf = (files: [path: string, lines: string[]][]): string => files.map(([path, lines]) => `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,${2 + lines.length} @@\n line one\n${lines.map((l) => `+${l}`).join("\n")}\n line two\n`).join("");
