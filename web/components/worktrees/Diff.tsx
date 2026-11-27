// A worktree's page's changes and results: a file's path, its diff as rows of lines (the old diffView, without the
// thread page's comment on lines, which a worktree's page never had), and what its threads produced (wipResults).
// The thread area's diffView and prCards aren't shared yet: these are the worktree page's own, with the same markup.
import { ago, plural, webUrl } from "../../lib/format.ts";
import { postPics } from "../../lib/markdown.ts";
import type { ChangedFile, DiffFile, Thread, WipDiff } from "../../lib/types.ts";
import { Icon } from "../Icon.tsx";
import { InlineMd, peekOf } from "./PageText.tsx";
import { wipHref } from "./wips.ts";
import { PrCards } from "../thread/Results.tsx";

// A path, its folder light and its name bold (the old pathHtml).
export function PathName({ p }: { p: string }) {
  const i = String(p).lastIndexOf("/");
  if (i < 0) return <b>{p}</b>;
  return (
    <>
      <span className="dir">{p.slice(0, i + 1)}</span>
      <b>{p.slice(i + 1)}</b>
    </>
  );
}
export const totals = (list: Pick<ChangedFile, "add" | "del">[]) => list.reduce((t, f) => ({ add: t.add + (f.add || 0), del: t.del + (f.del || 0) }), { add: 0, del: 0 });

// A hunk of a diff as git or GitHub gave it: where it starts in the old file and the new, and its lines.
interface Hunk {
  oldStart?: number;
  oldLines?: number;
  newStart?: number;
  newLines?: number;
  lines: string[];
}
type Shown = Omit<DiffFile, "hunks"> & { nodiff?: true; by?: string; hunks?: Hunk[] };
// A file's diff as it was read: the diff, why it couldn't be, or null while it's read.
export const diffOf = (x: WipDiff | undefined): Shown | { error: string } | null => (!x || x.loading ? null : x.error ? { error: x.error } : (x.diff as Shown));

// A file's change as rows of lines: added in green, removed in red, a few unchanged ones around them, and a
// gap between hunks saying where the next one starts. Changes without line numbers just run on.
export function DiffView({ f }: { f: Shown | { error: string } | null }) {
  if (!f) return <p className="dv-wait">Loading the diff…</p>;
  if ("error" in f && f.error) return <p className="dv-wait">{f.error}</p>;
  const d = f as Shown;
  if (d.secret) return <p className="dv-wait">Its lines stayed on the machine: {d.secret}.</p>;
  if (d.nodiff) return <p className="dv-wait">{d.by === "command" ? "The command that changed it didn't say how, so there's no diff." : "No diff to show for this one."}</p>;
  if (d.binary) return <p className="dv-wait">A binary file.</p>;
  if (!d.hunks?.length) return <p className="dv-wait">No lines changed.</p>;
  const rows = [];
  let k = 0;
  d.hunks.forEach((h, i) => {
    const numbered = h.oldStart != null;
    let o = h.oldStart || 0;
    let n = h.newStart || 0;
    if (numbered && (i || (h.newStart || h.oldStart) > 1))
      rows.push(
        <tr className="dv-gap" key={`g${i}`}>
          <td className="ln" colSpan={2} />
          <td>Line {h.newLines ? h.newStart : h.oldStart}</td>
        </tr>,
      );
    else if (!numbered && i)
      rows.push(
        <tr className="dv-gap" key={`g${i}`}>
          <td className="ln" colSpan={2} />
          <td>⋯</td>
        </tr>,
      );
    if (o === 0 && h.oldLines) o = 1;
    if (n === 0 && h.newLines) n = 1;
    for (const l of h.lines) {
      const c = l[0];
      if (c === "\\") continue;
      const was = numbered && c !== "+" ? o++ : "";
      const now = numbered && c !== "-" ? n++ : "";
      rows.push(
        <tr className={c === "+" ? "dv-add" : c === "-" ? "dv-del" : undefined} key={k++}>
          <td className="ln">{was}</td>
          <td className="ln">{now}</td>
          <td className="code">
            <span className="sign">{c === "+" ? "+" : c === "-" ? "−" : ""}</span>
            {l.slice(1)}
          </td>
        </tr>,
      );
    }
  });
  return (
    <>
      <div className="dv">
        <table className="dv-t">
          <tbody>{rows}</tbody>
        </table>
      </div>
      {d.more || d.cut ? <p className="dv-wait">and {plural(Number(d.more || d.cut), "more line")}, left out</p> : null}
    </>
  );
}

/* what its threads produced */

const prsOf = (s: Thread) => Object.values(s.prs || {}).filter((p) => p && typeof p.url === "string" && p.url && !p.off);
// What its threads produced: their results and pull requests (on a pull request's page, the others, `except` its
// own). None when they haven't yet. `posts`: its threads, as full records (with their results and pull requests).
export function wipResults(posts: Thread[], except = "") {
  const ups = posts.flatMap((s) => (s.updates || []).map((u) => ({ ...u, s }))).sort((a, b) => a.at.localeCompare(b.at));
  const prs = posts.flatMap((s) => prsOf(s).filter((p) => p.url.toLowerCase() !== except.toLowerCase()).map((p) => ({ s, p })));
  if (!ups.length && !prs.length) return null;
  const n = ups.length + posts.flatMap((s) => Object.values(s.prs || {})).filter((p) => p.url.toLowerCase() !== except.toLowerCase()).length;
  return {
    n,
    body: (
      <>
        {ups.length ? (
          <ul className="updates">
            {ups.map((u, i) => (
              <li key={i}>
                <Icon name="check" />
                <span>
                  <span className="muted">{u.s.label}:</span>{" "}
                  <InlineMd text={u.text} peek={peekOf(u.s)} pics={postPics(u.s)} from={u.s.id} />
                  {webUrl(u.link) ? (
                    <>
                      {" "}
                      <a href={webUrl(u.link)} target="_blank" rel="noopener">
                        link
                      </a>
                    </>
                  ) : null}
                </span>
                <time>{ago(u.at)}</time>
              </li>
            ))}
          </ul>
        ) : null}
        {posts.map((s) => (
          <PrCards key={s.id} thread={s} except={except} />
        ))}
      </>
    ),
  };
}
