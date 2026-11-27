// Pull requests named in text: a link to one, and what a shell command did to them (`gh pr create`, `gh pr merge
// 12`). Pure, for both sides: the CLI notes them in a post's transcript, and the server links and reads them
// (server/integrations/pulls.ts).

import type { Iso, PostPr, PrHow } from "./types.ts";

// A pull request a shell command opened or worked on (prsInShell); `repo` null: the folder's own.
export interface ShellPr {
  how: "opened" | "worked";
  repo: string | null;
  number: number;
}

// "github.com/acme/core-api" -> { owner, name, slug }, or null for a repo that isn't on GitHub.
export function githubRepo(key: string | null | undefined): { owner: string; name: string; slug: string } | null {
  const m = String(key || "").match(/^github\.com\/([^/]+)\/([^/]+)$/);
  return m ? { owner: m[1], name: m[2], slug: `${m[1]}/${m[2]}` } : null;
}
// The pull request numbers in links to a repo's pull requests: https://github.com/acme/core-api/pull/12.
export function pullNumbers(key: string | null | undefined, urls: Iterable<unknown>): number[] {
  const r = githubRepo(key);
  if (!r) return [];
  const slug = `${r.owner}/${r.name}`.toLowerCase();
  const numbers: number[] = [];
  for (const u of urls) {
    const m = String(u).match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i);
    if (m && m[1].toLowerCase() === slug && !numbers.includes(Number(m[2]))) numbers.push(Number(m[2]));
  }
  return numbers;
}

export const prUrl = (slug: string, number: number | string): string => `https://github.com/${slug}/pull/${Number(number)}`;
const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i;
// A link to a pull request -> { repo: "owner/name", number }, or null.
export function prOfUrl(url: string | null | undefined): { repo: string; number: number } | null {
  const m = String(url || "").match(PR_URL);
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}
// How a post came to link one, strongest first: it opened it, worked on it (merged, checked out, reviewed…), you
// linked it, its agent did (a result's link), or it's the one on the post's branch.
export const HOW: PrHow[] = ["opened", "worked", "you", "agent", "branch"];
export const strongest = (a: PrHow | null | undefined, b: PrHow | null | undefined): PrHow | null | undefined => (!a ? b : !b ? a : HOW.indexOf(a) <= HOW.indexOf(b) ? a : b);

const unquoted = (word: string): string => word.replace(/^(["'])(.*)\1$/, "$2");
// The repo a -R names, as owner/name, written out or in a variable the line set (`R=owner/name; gh pr merge 12 -R
// $R`). null when it names one that can't be told from the line: another variable, a command, another GitHub.
function repoNamed(word: string, vars: Map<string, string>): string | null {
  const bare = unquoted(word);
  const name = bare.match(/^\$(?:(\w+)|\{(\w+)\})$/);
  const repo = (name ? vars.get(name[1] || name[2]) || "" : bare).replace(/^(?:https:\/\/)?github\.com\//, "").replace(/\.git$/, "");
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null;
}

// The pull requests a shell command opened or worked on, from the command and what it printed. `gh pr create`
// prints the new one's link; `gh pr merge 12`, `gh pr checkout 12`… name the one they work on (a number, #12 or
// its link, in another repo with -R), or print it when they work on the current branch's. Looking at one
// (view, diff, checks, list, status) isn't working on it. -> [{ how: "opened" | "worked", repo, number }], where
// repo is null when the command meant the folder's own.
const WORKS = new Set(["merge", "checkout", "co", "review", "comment", "edit", "ready", "close", "reopen", "update-branch", "revert"]);
export function prsInShell(command: string | null | undefined, output: unknown = ""): ShellPr[] {
  const out: ShellPr[] = [];
  const add = (how: ShellPr["how"], repo: string | null | undefined, number: string | number): void => {
    const n = Number(number);
    if (n > 0 && !out.some((p) => p.number === n && p.repo === repo)) out.push({ how, repo: repo || null, number: n });
  };
  const printed = String(output || "");
  // Only a command that starts its part of the line, outside a heredoc or a quoted text over several lines: a
  // PR's body may well mention `gh pr checkout 12`.
  const line = String(command || "")
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\b/g, "")
    .replace(/"(?:[^"\\]|\\.)*\n(?:[^"\\]|\\.)*"|'[^']*\n[^']*'/g, '""');
  const vars = new Map<string, string>();
  for (const part of line.split(/&&|\|\||[;|\n]/)) {
    const set = part.match(/^\s*(?:export\s+)?(\w+)=(\S*)\s*$/);
    if (set) vars.set(set[1], unquoted(set[2]));
    const m = part.match(/^\s*(?:\w+=\S*\s+)*(?:command\s+)?gh\s+pr\s+([\w-]+)(.*)$/);
    if (!m) continue;
    const args = m[2].trim().split(/\s+/).filter(Boolean);
    const r = args.findIndex((a) => a === "-R" || a === "--repo");
    const word = r >= 0 ? args[r + 1] : args.find((a) => a.startsWith("--repo="))?.slice(7);
    const repo = word ? repoNamed(word, vars) : null;
    // A repo it can't tell isn't the folder's, which is what no repo means below: with only a number, it links nothing.
    const unsaid = !!word && !repo;
    const link = printed.match(new RegExp(PR_URL.source, "gi"))?.map((u) => u.match(PR_URL)) || [];
    if (m[1] === "create") {
      const u = link.at(-1);
      if (u) add(/already exists/i.test(printed) ? "worked" : "opened", u[1], u[2]);
      continue;
    }
    if (!WORKS.has(m[1])) continue;
    const target = args.find((a, i) => (/^#?\d+$/.test(a) || PR_URL.test(a)) && args[i - 1] !== "-R" && args[i - 1] !== "--repo");
    const u = target?.match(PR_URL);
    if (u) add("worked", u[1], u[2]);
    else if (target) {
      const n = target.replace("#", "");
      const of = repo || link.find((x) => x[2] === n)?.[1] || printed.match(new RegExp(`pull request ([\\w.-]+/[\\w.-]+)#${n}\\b`, "i"))?.[1];
      if (of || !unsaid) add("worked", of, n);
    }
    else if (link.length) add("worked", link[0][1], link[0][2]);
    else {
      const said = printed.match(/pull request (?:([\w.-]+\/[\w.-]+))?#(\d+)/i);
      if (said && (said[1] || !unsaid)) add("worked", said[1] || repo, said[2]);
    }
  }
  return out;
}

// Note what a shell command did to pull requests in a digest's `prs`: by link, or by "#12" when the command meant
// the folder's own repo, which server.ts works out from the folder.
// `prs`: by link, or by "#12".
export function notePrs(prs: Record<string, PostPr>, command: string, output: unknown, at: Iso): void {
  for (const p of prsInShell(command, output)) {
    const key = p.repo ? prUrl(p.repo, p.number) : `#${p.number}`;
    const was = prs[key];
    prs[key] = { url: p.repo ? key : null, number: p.number, repo: p.repo, at: was?.at || at, how: strongest(was?.how, p.how) };
  }
}
