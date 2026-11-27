// What a thread came to: its plan (how far along, at a glance), and its results: what it said it did (ab_update), its
// pull requests, each with where it stands on GitHub, what agentbook said changed, what it attached (ab_attach), and
// what its loops do next. On its page, under its title; its pull requests on its card in the feed too.
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { create } from "zustand";
import { nudgedLine, stuckLine } from "../../lib/agents.ts";
import { post } from "../../lib/api.ts";
import { ago, agoText, plural, webUrl } from "../../lib/format.ts";
import { postPics } from "../../lib/markdown.ts";
import { toast } from "../../lib/toast.ts";
import type { Thread } from "../../lib/types.ts";
import type { Attachment as AttachmentRec, PlanItem, PostPr as PostPrRec, PrCard } from "../../../plugin/shared/types.ts";
import { sortedRows, tableBars } from "../../lib/visual.ts";
import type { DiagramIn, TableData } from "../../lib/visual.ts";
import { Icon } from "../Icon.tsx";
import type { IconName } from "../Icon.tsx";
import { Markdown } from "../Markdown.tsx";
import { Cell, WChart, WMetric } from "../pages/widgets.tsx";
import type { ChartData } from "../pages/widgets.tsx";
import { NextLines } from "../post/Loops.tsx";
import { Hl } from "../post/util.tsx";
import { Ago } from "../Time.tsx";
import { CheckDots } from "../visual/CheckDots.tsx";
import { Diagram } from "../visual/Diagram.tsx";
import { PlanBar } from "../visual/PlanBar.tsx";
import { InlineMd } from "../worktrees/PageText.tsx";
import { prWhy, prWips, useWorld, wipHref } from "../worktrees/wips.ts";
import { LinkCards, peekOf } from "./Bubble.tsx";
import { ChangeLine } from "./Changes.tsx";
import { Sec, unfoldSec, useSecOpen } from "./Sec.tsx";
import { PR_ASK } from "../worktrees/wips.ts";

/* ---------- its plan ---------- */

export function PlanList({ plan, max = 99 }: { plan: (PlanItem & { now?: string })[] | null | undefined; max?: number }) {
  if (!plan?.length) return null;
  const shown = plan.slice(0, max);
  return (
    <ul className="plan">
      {shown.map((t, i) => (
        <li key={i} className={t.status === "completed" ? "done" : t.status === "in_progress" ? "now" : ""}>
          <span className="tick">{t.status === "completed" ? "✓" : ""}</span>
          {t.status === "in_progress" ? t.now : t.text}
        </li>
      ))}
      {plan.length > max && <li className="muted">and {plan.length - max} more</li>}
    </ul>
  );
}
export function PlanSection({ plan }: { s?: Thread; plan: PlanItem[] | null | undefined }) {
  const open = useSecOpen("plan");
  if (!plan?.length) return null;
  return (
    <>
      <Sec k="plan" label="Plan" count={<span className="muted">{`${plan.filter((t) => t.status === "completed").length} of ${plan.length} done`}</span>} />
      <PlanBar plan={plan} />
      {open && <PlanList plan={plan} />}
    </>
  );
}

/* ---------- its pull requests ---------- */

// A post's pull requests, each with where it stands on GitHub (its machine reads it, see pulls.ts), how it came
// to be linked and, when something holds one up, a button that asks the post's agent to see to it. One that
// hasn't been read from GitHub yet (or can't be: GitHub not connected) is a link, as it always was. One in a workspace that
// shows its pull requests opens its WIP page.
// One linked before its title came from GitHub kept the title it was linked with.
type PostPr = PostPrRec & { title?: string };
export const prsOf = (s: Thread): PostPr[] => Object.values(s.prs || {}).filter((p) => p && typeof p.url === "string" && p.url && !p.off);
const PR_HOW: Record<string, string> = { opened: "opened by this thread", worked: "worked on here", branch: "on its branch", agent: "linked by its agent", you: "linked by you" };
export const prReady = (g: Partial<PrCard>) => g.state === "open" && !g.checks?.fail && !g.checks?.pending && g.mergeable !== "conflicts" && g.review !== "changes" && (g.merge_state === "clean" || (g.review === "approved" && g.mergeable === "yes"));
export const PR_CHIP: Record<string, [string, string]> = { merged: ["Merged", "chip--merged"], closed: ["Closed", "chip--closed"], draft: ["Draft", ""], open: ["Open", "chip--open"] };
// What it needs now, if it's the post's to do: fix its checks, see to its review, bring its base in, or merge it.
function prNeeds(s: Thread, p: PostPr, g: PrCard | null): [string, string] | null {
  if (!g || s.mine === false || !(g.mine || p.how === "opened") || (g.state !== "open" && g.state !== "draft")) return null;
  if (g.checks?.fail) return ["checks", "fix the checks"];
  if (g.review === "changes" || (g.threads && g.state === "open")) return ["review", "address the review"];
  if (g.mergeable === "conflicts" || g.merge_state === "behind") return ["rebase", `rebase from ${g.base}`];
  if (prReady(g)) return ["merge", "merge it"];
  return null;
}
const ats = (list: string[]) => list.map((x) => `@${x}`).join(", ");
interface PrRow {
  cls: string;
  node: ReactNode;
}
// Where it stands, one row each: its state when it's over, its checks, its review or conflicts, its size. `bad`
// rows hold it up; the feed shows the first of those, or the first row.
function prRows(g: PrCard): PrRow[] {
  const rows: PrRow[] = [];
  const row = (cls: string, ico: IconName, body: ReactNode) =>
    rows.push({
      cls,
      node: (
        <li className={cls} key={rows.length}>
          <Icon name={ico} />
          <span>{body}</span>
        </li>
      ),
    });
  const base = <code>{g.base}</code>;
  if (g.state === "merged")
    row(
      "merged",
      "pr",
      <>
        Merged into {base}
        {g.merged_by && g.merged_by !== g.author ? ` by @${g.merged_by}` : ""}, {agoText(g.closed)}
      </>,
    );
  if (g.state === "closed") row("", "x", `Closed without merging, ${agoText(g.closed)}`);
  const c = g.checks;
  // Its checks a dot each too, so a red one shows at a glance.
  const dots = <CheckDots c={c} />;
  if (c?.fail)
    row(
      "bad",
      "x",
      <>
        {dots}
        {c.total - c.fail} of {c.total} checks pass, {c.fail} failing
        {g.failing?.length ? (
          <>
            :{" "}
            {g.failing.slice(0, 3).map((n, i) => (
              <span key={i}>
                {i ? ", " : ""}
                <code>{n}</code>
              </span>
            ))}
            {g.failing.length > 3 ? "…" : ""}
          </>
        ) : null}
      </>,
    );
  else if (c?.pending)
    row(
      "wait",
      "clock",
      <>
        {dots}
        {c.pending} of {c.total} checks running
      </>,
    );
  else if (c?.pass)
    row(
      "good",
      "check",
      <>
        {dots}
        {plural(c.pass, "check")} passed
      </>,
    );
  if (g.state === "open" || g.state === "draft") {
    if (g.mergeable === "conflicts") row("bad", "x", <>Conflicts with {base}</>);
    if (g.review === "changes") row("bad", "comment", `${g.reviewer ? `@${g.reviewer}` : "A reviewer"} asked for changes${g.threads ? `: ${plural(g.threads, "thread")} unresolved` : ""}`);
    else if (g.review === "approved")
      row(
        "good",
        "check",
        <>
          Approved{g.reviewer ? ` by @${g.reviewer}` : ""}
          {g.mergeable === "yes" ? <>, no conflicts with {base}</> : ""}
        </>,
      );
    else if (g.threads) row("", "comment", `${plural(g.threads, "thread")} unresolved`);
    else if (g.waiting?.length) row("", "eye", `Waiting for a review from ${ats(g.waiting)}`);
    else if (g.state === "draft") row("", "eye", "A draft: nobody's asked to review it yet");
  } else if (g.review === "approved" && g.reviewer) row("good", "check", `Approved by @${g.reviewer}`);
  const n = (v: number) => Number(v || 0).toLocaleString("en-US");
  if (g.files)
    row(
      "",
      "diff",
      <>
        {g.add || g.del ? (
          <>
            {g.add ? <span className="add">+{n(g.add)}</span> : null}
            {g.add && g.del ? " " : null}
            {g.del ? <span className="del">−{n(g.del)}</span> : null}
          </>
        ) : (
          "No lines"
        )}{" "}
        in {plural(g.files, "file")}
      </>,
    );
  return rows;
}
// Where a pull request stands, as a post's machine says (another person's, on someone else's public post): its
// numbers as numbers, its state one of GitHub's, its lists lists.
type GhSeen = PrCard;
function ghOf(g: unknown): GhSeen | null {
  if (!g || typeof g !== "object") return null;
  const o = g as GhSeen;
  const checks = o.checks && typeof o.checks === "object" ? (Object.fromEntries(["fail", "pass", "pending", "skip", "total"].map((k) => [k, Number(o.checks[k]) || 0])) as unknown as PrCard["checks"]) : null;
  return { ...o, number: Number(o.number) || 0, state: PR_CHIP[o.state] ? o.state : "open", threads: Number(o.threads) || 0, files: Number(o.files) || 0, add: Number(o.add) || 0, del: Number(o.del) || 0, failing: Array.isArray(o.failing) ? o.failing : [], waiting: Array.isArray(o.waiting) ? o.waiting : [], checks };
}

// Fix the checks, Address the review, Rebase from main, Merge it: written to this post, which picks it back up.
async function prFix(e: React.MouseEvent<HTMLButtonElement>, s: Thread, p: PostPr, g: GhSeen, need: string) {
  const b = e.currentTarget;
  b.disabled = true;
  const r = await post(`/api/sessions/${encodeURIComponent(s.id)}/messages`, { text: PR_ASK[need]({ number: g.number, url: p.url, branch: g.head, base: g.base }), files: [] });
  if (r.ok) toast(r.data.stuck === "terminal" ? stuckLine(s) : r.data.nudged ? nudgedLine(s) : r.data.resumed ? `Resuming ${s.label} with it.` : `Sent to ${s.label}.`);
  b.disabled = false;
}
// Not this thread's pull request: unlinked, it stays off until you link it again.
async function prUnlink(e: React.MouseEvent<HTMLButtonElement>, s: Thread, url: string) {
  e.currentTarget.disabled = true;
  const r = await post(`/api/sessions/${encodeURIComponent(s.id)}/prs`, { url, off: true });
  if (r.ok) toast("Unlinked. It stays off this thread until you link it again.");
}

function PrCardOf({ s, p, feed }: { s: Thread; p: PostPr; feed: boolean }) {
  useWorld();
  const g = ghOf(p.gh);
  const x = prWips().find((o) => o.pr.url.toLowerCase() === p.url.toLowerCase());
  const href = x ? wipHref(x) : webUrl(p.url) || "#";
  const out = x ? {} : { target: "_blank", rel: "noopener" };
  const how = PR_HOW[p.how] || "";
  // Its number goes straight to GitHub, wherever its title goes (a pull request's page, when agentbook has one).
  const gh = webUrl(p.url);
  const num = (n: number | string) =>
    gh ? (
      <a className="pr-gh" href={gh} target="_blank" rel="noopener" title="Open on GitHub">
        pull request #{n}
        <Icon name="external" />
      </a>
    ) : (
      <>pull request #{n}</>
    );
  if (!g) {
    const where = x ? prWhy(x.pr).split(", ").slice(1).join(", ") : "";
    const stats = (
      <>
        <span>
          <Icon name="pr" />
          {p.how === "opened" || !p.how ? "Opened" : "Linked"} {ago(p.at)} ago
        </span>
        {where && <span>{where}</span>}
      </>
    );
    const title = x?.title || p.title || `Pull request #${p.number}`;
    // Going to its page, the whole card is the link to it (its title's, stretched), and its number to GitHub.
    if (x)
      return (
        <div className={`pr pr--${x.pr.state} pr--two`}>
          <div className="pr-in">
            <small>
              {p.repo || ""}, {num(p.number)}
            </small>
            <b>
              <a className="pr-go" href={href}>
                {title}
              </a>
            </b>
            <div className="pr-stats">{stats}</div>
          </div>
        </div>
      );
    return (
      <a className="pr" href={href} {...out}>
        <div className="pr-in">
          <small>
            {p.repo || ""}, pull request #{p.number}
          </small>
          <b>{title}</b>
          <div className="pr-stats">{stats}</div>
        </div>
      </a>
    );
  }
  const [label, cls] = prReady(g) ? ["Ready to merge", "chip--open"] : PR_CHIP[g.state] || PR_CHIP.open;
  const rows = prRows(g);
  const shown = feed ? [rows.find((r) => r.cls === "bad") || rows[0]].filter(Boolean) : rows;
  const need = prNeeds(s, p, g);
  const fix = need ? (
    <button className="btn btn--dark" type="button" title={`Writes to ${s.label} on this thread${s.effective === "done" ? ", which picks it back up" : ""}`} onClick={(e) => prFix(e, s, p, g, need[0])}>
      <Icon name={need[0] === "merge" ? "up" : "send"} />
      Ask {s.label} to {need[1]}
    </button>
  ) : null;
  const open = feed ? null : (
    <a className="btn btn--ghost" href={webUrl(p.url) || "#"} target="_blank" rel="noopener">
      <Icon name="external" />
      Open on GitHub
    </a>
  );
  const theirs = !g.mine && g.author ? ` · by @${g.author}` : "";
  return (
    <div className={`prl prl--${g.state}${feed ? " prl--sm" : ""}`}>
      <div className="prl-in">
        <div className="prl-top">
          <span className="how">
            {p.repo}, {num(g.number)}
            {how ? ` · ${how}` : ""}
            {theirs}
          </span>
          <span className={`chip ${cls}`}>{label}</span>
          {!feed && s.mine !== false && (
            <button className="prl-x" type="button" title="Not this thread's pull request: unlink it" onClick={(e) => prUnlink(e, s, p.url)}>
              <Icon name="x" />
            </button>
          )}
        </div>
        <a className="prl-t" href={href} {...out}>
          <Hl text={g.title} />
        </a>
        <ul className="prl-rows">{shown.map((r) => r.node)}</ul>
        {(fix || open) && (
          <div className="prl-acts">
            {fix}
            {open}
          </div>
        )}
      </div>
    </div>
  );
}
// Its pull requests, but `except` (the one whose page it's on). `feed`: as its card in a list shows them, smaller.
export function PrCards({ thread: s, feed = false, except = "" }: { thread: Thread; feed?: boolean; except?: string }) {
  return (
    <>
      {prsOf(s)
        .filter((p) => p.url.toLowerCase() !== except.toLowerCase())
        .map((p) => (
          <PrCardOf key={p.url} s={s} p={p} feed={feed} />
        ))}
    </>
  );
}

// Link one by hand: the form under a post's results, open on one thread at a time.
const usePrLink = create<{ id: string | null }>(() => ({ id: null }));
export function openPrLink(id: string | null) {
  if (!id) (document.activeElement as HTMLElement | null)?.blur?.(); // the page leaves a section with a field you're in alone
  else unfoldSec("results");
  usePrLink.setState({ id });
}
export const usePrLinkOpen = (id: string) => usePrLink((x) => x.id === id);
export function PrLinkForm({ s }: { s: Thread }) {
  const open = usePrLinkOpen(s.id);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) requestAnimationFrame(() => input.current?.focus());
  }, [open]);
  if (s.mine === false) return null;
  if (!open)
    return prsOf(s).length ? (
      <p className="prl-more">
        <button className="link-btn" type="button" onClick={() => openPrLink(s.id)}>
          Link another pull request
        </button>
      </p>
    ) : null;
  return (
    <form
      className="prl-link"
      data-pr-link-form={s.id}
      onSubmit={async (e) => {
        e.preventDefault();
        const url = input.current?.value.trim();
        if (!url) return;
        const r = await post(`/api/sessions/${encodeURIComponent(s.id)}/prs`, { url });
        if (!r.ok) return;
        openPrLink(null);
        toast("Linked. Where it stands comes from GitHub in a moment.");
      }}
    >
      <input ref={input} type="url" name="url" required placeholder="Paste a pull request's link, like https://github.com/owner/repo/pull/12" aria-label="A pull request's link" />
      <button className="btn btn--sm btn--dark" type="submit">
        Link
      </button>
      <button className="btn btn--sm" type="button" onClick={() => openPrLink(null)}>
        Cancel
      </button>
    </form>
  );
}

/* ---------- its results ---------- */

// A line agentbook wrote when one of the post's pull requests changed: its number links to it.
function PrLine({ u }: { u: Thread["updates"][number] }) {
  useWorld();
  const x = prWips().find((o) => o.pr.url.toLowerCase() === u.pr.url.toLowerCase());
  const n = `#${Number(u.pr.number) || ""}`;
  const at = u.text.indexOf(n);
  const link = (
    <a href={x ? wipHref(x) : webUrl(u.pr.url) || "#"} {...(x ? {} : { target: "_blank", rel: "noopener" })}>
      {n}
    </a>
  );
  return (
    <li className={`pr-line ${u.pr.kind || ""}`}>
      <Icon name="pr" />
      <span>
        {at < 0 ? (
          <InlineMd text={u.text} />
        ) : (
          <>
            <InlineMd text={u.text.slice(0, at)} />
            {link}
            <InlineMd text={u.text.slice(at + n.length)} />
          </>
        )}
      </span>
      <Ago at={u.at} />
    </li>
  );
}
// One thing it said it did: its words, its link, and on its page the link as a card.
function UpdateLine({ s, u, feed }: { s: Thread; u: Thread["updates"][number]; feed: boolean }) {
  const link = webUrl(u.link);
  const cards = !feed && link ? <LinkCards s={s} text={link} /> : null;
  return (
    <li className={cards ? "has-lk" : undefined}>
      <Icon name="check" />
      <span>
        <InlineMd text={u.text} peek={peekOf(s)} pics={postPics(s)} from={s.id} />
        {link && (
          <>
            {" "}
            <a href={link} target="_blank" rel="noopener">
              link
            </a>
          </>
        )}
        {cards}
      </span>
      <Ago at={u.at} />
    </li>
  );
}
// A post's results. agentbook's own "Changed 3 files" lines go in among them on its page; on the feed, only the
// newest one shows, after them, so they don't crowd the session's own. What its loops do next comes last.
export function Updates({ thread: s, max = 4, feed = true }: { thread: Thread; max?: number; feed?: boolean }) {
  const all = s.updates || [];
  const ups = (feed ? all.filter((u) => !u.changes) : all).slice(-max);
  const last = feed ? all.findLast((u) => u.changes) : null;
  const next = (s.loops || []).some((l) => (l as { live?: boolean }).live);
  if (!ups.length && !last && !next) return null;
  return (
    <ul className="updates">
      {ups.map((u, i) => (u.changes ? <ChangeLine key={i} s={s} u={u} /> : typeof u.pr?.url === "string" ? <PrLine key={i} u={u} /> : <UpdateLine key={i} s={s} u={u} feed={feed} />))}
      {last && <ChangeLine s={s} u={last} />}
      <NextLines thread={s} />
    </ul>
  );
}

// What it attached (ab_attach), in its results: a note, a link, a number, a chart, a diagram or a table.
const looksNumeric = (v: unknown) => /^[\s$€£+\-−]*[\d.,]+\s*[%kKmMbB]?$/.test(String(v ?? ""));
type CellIn = Parameters<typeof tableBars>[0][number][number];
function AttTable({ d }: { d: AttachmentRec["data"] }) {
  // Rows as arrays, in the order of its columns, as a page's table has them; ones attached before were objects.
  const raw = (Array.isArray(d.rows) ? d.rows : []) as unknown[];
  const cols = (d.columns?.length ? d.columns : Object.keys((raw.find((r) => r && !Array.isArray(r)) as object) || {})) as string[];
  const rows = sortedRows({ sort: d.sort, columns: cols, rows: raw.map((r) => (Array.isArray(r) ? r : cols.map((c) => (r as Record<string, unknown>)?.[c]))) as CellIn[][] } as TableData);
  // Its cells are a page table's ({ status, text } a badge, long words wrap), and it scrolls inside its card.
  const num = cols.map((_, i) => rows.length > 0 && rows.every((r) => r[i] == null || r[i] === "" || (typeof r[i] !== "object" && looksNumeric(r[i]))));
  const bars = tableBars(rows, cols.length);
  const bar = (i: number, ri: number) => (bars.has(i) && bars.get(i)[ri] != null ? bars.get(i)[ri] : null);
  return (
    <div className="md-tbl">
      <table className="mini-tbl wg-tbl">
        <thead>
          <tr>
            {cols.map((c, i) => (
              <th key={i} className={num[i] && i ? "num" : ""}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              {cols.map((_, i) => {
                const w = bar(i, ri);
                return (
                  <td key={i} className={`${num[i] && i ? "num" : ""}${w != null ? " has-bar" : ""}`} style={w != null ? ({ "--w": `${w.toFixed(1)}%` } as React.CSSProperties) : undefined}>
                    <Cell c={r[i]} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function Attachment({ a, s }: { a: AttachmentRec; s: Thread }) {
  const d = a.data || {};
  const head = a.title ? <p className="att-title">{a.title}</p> : null;
  if (a.type === "note")
    return (
      <div className="att att-note">
        {head}
        <Markdown text={String(d.text || "")} peek={peekOf(s)} pics={postPics(s)} />
      </div>
    );
  if (a.type === "link") {
    const url = String(d.url || "");
    return (
      <a className="pr pr--link" href={webUrl(url) || "#"} target="_blank" rel="noopener">
        <div className="pr-in">
          <small>{url.replace(/^https?:\/\//, "").split("/")[0]}</small>
          <b>{String(d.title || a.title || url)}</b>
          {d.text && (
            <div className="pr-stats">
              <span>{String(d.text)}</span>
            </div>
          )}
        </div>
      </a>
    );
  }
  if (a.type === "metric")
    return (
      <div className="att att-metric">
        {head}
        <WMetric d={d as Parameters<typeof WMetric>[0]["d"]} />
      </div>
    );
  if (a.type === "chart")
    return (
      <div className="att att-chart">
        {head}
        <WChart d={d as ChartData} title={a.title} />
      </div>
    );
  if (a.type === "diagram")
    return (
      <div className="att att-dia">
        {head}
        <Diagram dg={d as DiagramIn} title={a.title} />
      </div>
    );
  if (a.type === "table")
    return (
      <div className="att">
        {head}
        <AttTable d={d} />
      </div>
    );
  return null;
}

// Its results on its page: a section with its pull requests (and the form to link one), what it said it did and
// agentbook's changed-files lines, the last 40, and what it attached. Folded, its pull requests still show, as on
// its card.
export function ResultsSection({ s }: { s: Thread }) {
  const open = useSecOpen("results");
  const linking = usePrLinkOpen(s.id);
  const prs = prsOf(s);
  const attachments = Object.values(s.attachments || {});
  const loops = (s.loops || []).some((l) => (l as { live?: boolean }).live);
  if (!s.updates?.length && !prs.length && !attachments.length && !linking && !loops) return null;
  const n = Math.min(s.updates?.length || 0, 40) + prs.length + attachments.length;
  return (
    <>
      <Sec k="results" label="Results" count={<span className="muted">{n || ""}</span>}>
        <PrCards thread={s} />
        <PrLinkForm s={s} />
        <Updates thread={s} max={40} feed={false} />
        {attachments.map((a) => (
          <Attachment key={a.key} a={a} s={s} />
        ))}
      </Sec>
      {!open && <PrCards thread={s} feed />}
    </>
  );
}
