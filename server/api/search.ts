// Full-text search route (/api/q/search) and FTS5-backed feed/agent helpers.
// Enforces viewer visibility before deduplicating or extracting snippets.

import { excerpt, ftsQuery, hits, typoBudget } from "../../plugin/shared/search.ts";
import { isTalkId, talkTitle } from "../../plugin/shared/talks.ts";
import type { SearchHit } from "../../plugin/shared/api.ts";
import type { MessageHits } from "../feed.ts";
import type { SearchDocRow, SearchKind } from "../search.ts";
import { accounts, relay, state } from "../core/state.ts";
import { queryRoute } from "../core/http.ts";
import type { Viewer } from "../core/http.ts";
import { keptOff, ownerName, postRef } from "../core/refs.ts";
import { seesPost } from "../core/follows.ts";
import { search } from "../core/services.ts";
import { titleOf } from "./cli.ts";
import { noteSeen } from "./notes.ts";
import { pageOwner, pageSeen } from "./pages.ts";
import { groupOwner, groupSeen } from "./groups.ts";
import { talkOf, talkPerson, talkSeen } from "./talks.ts";
import { taskSeen } from "./tasks.ts";

const ALL_KINDS: SearchKind[] = ["msg", "thread", "note", "page", "task", "group"];
const VALID_KINDS = new Set<string>(ALL_KINDS);
const enc = encodeURIComponent;

function isDocVisible(req: Viewer, row: SearchDocRow): boolean {
  const uid = req.user?.id;
  if (row.kind === "msg" || row.kind === "thread") {
    const id = row.parent.slice(7);
    if (isTalkId(id)) return talkSeen(req, talkOf(id));
    if (uid && keptOff(uid, id)) return false;
    const p = postRef(id);
    if (!p || relay.shadowed(p.D, p.local)) return false;
    return seesPost(req, p);
  }
  if (row.kind === "note") {
    const n = state.notes[row.parent.slice(5)];
    return !!n && noteSeen(req, n);
  }
  if (row.kind === "page") {
    return pageSeen(req, row.parent.slice(5));
  }
  if (row.kind === "task") {
    const t = state.tasks[row.parent.slice(5)];
    return !!t && taskSeen(req, t);
  }
  if (row.kind === "group") {
    const g = state.groups[row.parent.slice(6)];
    return !!g && !!groupSeen(req, g);
  }
  return false;
}

function isDocArchived(row: SearchDocRow): boolean {
  if (row.kind === "msg" || row.kind === "thread") {
    const id = row.parent.slice(7);
    if (isTalkId(id)) return !!talkOf(id)?.archived;
    return !!postRef(id)?.s.archived;
  }
  if (row.kind === "note") return !!state.notes[row.parent.slice(5)]?.archived;
  if (row.kind === "page") return !!state.pages[row.parent.slice(5)]?.archived;
  if (row.kind === "task") return !!state.tasks[row.parent.slice(5)]?.done;
  if (row.kind === "group") return !!state.groups[row.parent.slice(6)]?.archived;
  return false;
}

function formatHit(req: Viewer, row: SearchDocRow & { score: number }, fts: string): SearchHit | null {
  const snippet = search.snippetFor(row, fts);
  if (!snippet) return null;
  const at = new Date(row.at || Date.now()).toISOString();
  const uid = req.user?.id;

  if (row.kind === "msg" || row.kind === "thread") {
    const id = row.parent.slice(7);
    const kind = row.kind === "msg" ? "message" : "thread";
    if (isTalkId(id)) {
      const tk = talkOf(id);
      if (!tk) return null;
      const who = tk.owner !== uid ? `@${talkPerson(tk)}` : "";
      return {
        kind,
        id,
        ...(row.kind === "msg" && row.item ? { itemId: row.item } : {}),
        title: talkTitle(tk),
        subtitle: [who].filter(Boolean).join(" · ") || undefined,
        role: row.kind === "msg" ? "user" : undefined,
        archived: !!tk.archived,
        at,
        snippet,
        score: row.score,
        href: row.kind === "msg" && row.item ? `#/threads/${enc(id)}?msg=${enc(row.item)}` : `#/threads/${enc(id)}`,
      };
    }
    const p = postRef(id);
    if (!p) return null;
    const agentId = relay.idOf(p.D, p.s.agent);
    const agentName = p.agent?.name || null;
    const owner = p.D.user_id !== uid ? `@${ownerName(p.D)}` : "";
    return {
      kind,
      id,
      ...(row.kind === "msg" && row.item ? { itemId: row.item } : {}),
      title: titleOf(p.s),
      subtitle: [agentName, p.s.repo, owner].filter(Boolean).join(" · ") || undefined,
      agent: agentId,
      role: row.kind === "msg" ? (row.role === 0 ? "user" : "agent") : undefined,
      archived: !!p.s.archived,
      at,
      snippet,
      score: row.score,
      href: row.kind === "msg" && row.item ? `#/threads/${enc(id)}?msg=${enc(row.item)}` : `#/threads/${enc(id)}`,
    };
  }

  if (row.kind === "note") {
    const id = row.parent.slice(5);
    const n = state.notes[id];
    if (!n) return null;
    const parentTitle = n.parent && state.notes[n.parent] ? state.notes[n.parent].title : "";
    const owner = n.owner && n.owner !== uid ? `@${accounts.byId(n.owner)?.username || ""}` : "";
    return {
      kind: "note",
      id,
      ...(row.item ? { itemId: row.item } : {}),
      title: n.title || "Untitled",
      subtitle: [parentTitle, owner].filter(Boolean).join(" · ") || undefined,
      emoji: n.emoji || "📄",
      archived: !!n.archived,
      at,
      snippet,
      score: row.score,
      href: `#/notes/${enc(id)}`,
    };
  }

  if (row.kind === "page") {
    const id = row.parent.slice(5);
    const p = state.pages[id];
    if (!p) return null;
    const po = pageOwner(p);
    const owner = po && po !== uid ? `@${accounts.byId(po)?.username || ""}` : "";
    return {
      kind: "page",
      id,
      title: p.title || "Untitled",
      subtitle: [owner].filter(Boolean).join(" · ") || undefined,
      emoji: p.emoji || "📄",
      archived: !!p.archived,
      at,
      snippet,
      score: row.score,
      href: `#/pages/${enc(id)}`,
    };
  }

  if (row.kind === "task") {
    const id = row.parent.slice(5);
    const t = state.tasks[id];
    if (!t) return null;
    return {
      kind: "task",
      id,
      title: t.text,
      subtitle: t.source?.key || undefined,
      archived: !!t.done,
      at,
      snippet,
      score: row.score,
      href: `#/tasks/${enc(id)}`,
    };
  }

  if (row.kind === "group") {
    const id = row.parent.slice(6);
    const g = state.groups[id];
    if (!g) return null;
    const go = groupOwner(g);
    const owner = go && go !== uid ? `@${accounts.byId(go)?.username || ""}` : "";
    return {
      kind: "group",
      id,
      title: g.name,
      subtitle: [owner].filter(Boolean).join(" · ") || undefined,
      emoji: g.emoji || "👥",
      archived: !!g.archived,
      at,
      snippet,
      score: row.score,
      href: `#/groups/${enc(id)}`,
    };
  }

  return null;
}

queryRoute("/api/q/search", (req, _res, { query }) => {
  const q = String(query.get("q") || "").trim().slice(0, 200);
  if (q.length < 2) return { query: q, indexing: search.isIndexing(), hits: [] };
  const limit = Math.min(30, Math.max(1, Number(query.get("limit")) || 15));
  const rawKinds = String(query.get("kind") || "")
    .split(",")
    .map((k) => k.trim())
    .filter((k): k is SearchKind => VALID_KINDS.has(k));
  const kinds = rawKinds.length ? rawKinds : ALL_KINDS;

  const { fts, indexing, hits: found } = search.queryDocs(q, {
    kinds,
    limit,
    allow: (row) => isDocVisible(req, row),
    archived: isDocArchived,
  });

  const formatted: SearchHit[] = [];
  for (const r of found) {
    const hit = formatHit(req, r, fts);
    if (hit) formatted.push(hit);
  }
  return { query: q, indexing, hits: formatted };
});

// FTS5-backed message hits for /api/q/feed?q= so filtering the feed never loads paged-out messages into RAM.
// Returns null while initial backfill is still running, or when a word may have a typo, so the caller falls back.
export function feedMessageHits(req: Viewer, words: string[]): MessageHits | null {
  if (!words.length) return { exact: [], posts: [] };
  const exact: string[] = [];
  const byPost = new Map<string, { words: Set<string>; best: SearchDocRow; count: number; perMsg: Map<string, number> }>();

  for (const w of words) {
    const rows = search.messageDocsForWord(w);
    if (rows === null) return null;
    let any = false;
    for (const r of rows) {
      if (!isDocVisible(req, r)) continue;
      any = true;
      const post = r.parent.slice(7);
      let entry = byPost.get(post);
      if (!entry) {
        entry = { words: new Set(), best: r, count: 0, perMsg: new Map() };
        byPost.set(post, entry);
      }
      entry.words.add(w);
      const n = (entry.perMsg.get(r.item) || 0) + 1;
      entry.perMsg.set(r.item, n);
      if (n > entry.count || (n === entry.count && r.at >= entry.best.at)) {
        entry.best = r;
        entry.count = n;
      }
    }
    if (any) exact.push(w);
    // A word found nowhere as typed may have a typo, which only searchMessages matches (FTS5 has none).
    else if (typoBudget(w) > 0) return null;
  }

  const terms = words.map((w) => ({ w, typos: exact.includes(w) ? 0 : typoBudget(w) }));
  const fts = ftsQuery(words.join(" ")) || "";
  const posts: MessageHits["posts"] = [];
  for (const [post, entry] of byPost) {
    const raw = search.resolveRawText(entry.best) || "";
    const first = hits(raw, terms)[0];
    const text = first ? excerpt(raw, first) : fts ? search.snippetFor(entry.best, fts) : raw.slice(0, 160);
    posts.push({
      post,
      exact: [...entry.words],
      typo: [],
      hit: {
        id: entry.best.item,
        from: entry.best.role === 0 ? "human" : "agent",
        at: new Date(entry.best.at || Date.now()).toISOString(),
        text,
      },
    });
  }
  return { exact, posts };
}

export function candidateThreadsFor(words: string[]): Set<string> | null {
  const parents = search.threadCandidates(words);
  if (!parents) return null;
  const ids = new Set<string>();
  for (const p of parents) if (p.startsWith("thread:")) ids.add(p.slice(7));
  return ids;
}
