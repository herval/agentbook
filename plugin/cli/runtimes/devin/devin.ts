// Devin: Cognition's agent, in a machine of theirs, on a service user's key. Each thread is one of its sessions (a
// post whose proc is "devin:<session id>"), one started here: a key sees its whole organization's sessions, and a
// colleague's aren't anyone's thread here.
//
// Devin's API has messages and a status, and no steps, no events and nothing to approve with, so a thread shows what
// it says, its pull requests and what it has used, and links to Devin for the rest. It's asked for what's new only
// while something can change without you: often while it works, slowly while it waits on an approval only Devin's own
// page can give, and not at all while it waits for you (your message, or opening the thread, looks again).

import { RUNTIMES, runtimeOfProc } from "../../../shared/runtimes.ts";
import type { Session } from "../../../shared/types.ts";
import { addSay, blank, iso, liveOf, short, summaryOf } from "../kit/steps.ts";
import type { DriverDigest } from "../kit/steps.ts";
import { callApi, filesOn, githubRepo, keptFile, linkPr, offBy, remoteRow } from "../kit/remote.ts";
import type { Attached, CallOpts } from "../kit/remote.ts";
import type { Runtime, RuntimeContext, SetupValues, StartRequest } from "../runtime.ts";

const AGENT = "devin";
const NAME = "Devin";
const BASE = () => process.env.AGENTBOOK_DEVIN_URL || "https://api.devin.ai";
const WORKING_MS = () => Number(process.env.AGENTBOOK_DEVIN_POLL_MS || 5000);
const APPROVAL_MS = () => WORKING_MS() * 6;
const RETRY_MS = () => WORKING_MS() * 12;
const LOOK_AGAIN_MS = 10e3; // opening a thread looks again, at most this often
// What you send takes Devin a moment to act on: until it says something, or this long passes, "waiting for you" is
// from before your message, and stopping looking then would lose the run it starts.
const SETTLE_MS = () => WORKING_MS() * 6;
const MODES = [
  { id: "normal", name: "Agent" },
  { id: "fast", name: "Fast" },
  { id: "lite", name: "Lite" },
  { id: "ultra", name: "Ultra" },
];
const SHORT_OF_CREDITS = new Set(["out_of_credits", "out_of_quota", "usage_limit_exceeded"]);

// A Devin session, as its API says it (the fields read here).
interface DevinSession {
  session_id: string;
  status: string;
  status_detail?: string | null;
  is_archived?: boolean;
  title?: string | null;
  url?: string | null;
  pull_requests?: { pr_url: string }[];
  acus_consumed?: number | string;
  created_at?: string | number;
  updated_at?: string | number;
}

// What's been read of a thread's Devin session: its steps, the messages seen (by event id), and how it's being
// looked at.
interface Conv {
  digest: DriverDigest;
  seen: Set<string>;
  session: DevinSession | null;
  busy: boolean;
  ended: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  pulling: Promise<void> | null;
  looked: number;
  link: string | null;
  prs: number;
  approval: boolean;
  asked: number;
  heard?: boolean;
  cursor?: string;
}

const isBusy = (s: DevinSession) => ["new", "claimed", "resuming"].includes(s.status) || (s.status === "running" && (!s.status_detail || s.status_detail === "working"));
const isOver = (s: DevinSession) => s.status === "exit" || s.status === "error" || !!s.is_archived;

export function createDevin(): Runtime {
  let ctx: RuntimeContext = null;
  const log = (line: string) => ctx?.log(line);
  const off = offBy("AGENTBOOK_DEVIN");
  const enabled = !off;
  const kept = keptFile(AGENT); // { key, org, budget: the ACUs a thread may use }
  const convs = new Map<string, Conv>(); // post -> what's been read of its session
  let lastError = null;

  const conv = (id: string): Conv => convs.get(id) || convs.set(id, { digest: blank(), seen: new Set(), session: null, busy: false, ended: false, timer: null, pulling: null, looked: 0, link: null, prs: 0, approval: false, asked: 0 }).get(id);
  const post = (id: string) => ctx.state.sessions[id];
  const mine = (s: Session | undefined) => runtimeOfProc(s?.proc) === AGENT;
  const headers = (key) => ({ authorization: `Bearer ${key}` });
  // Its status can't be the last word yet: it may not have got to what you wrote, or what it just said came after that
  // status was read (a look reads the status first, so that the end of a session comes with all it said).
  const settling = (c: Conv) => c.heard || Date.now() - c.asked < SETTLE_MS();
  const call = async (method: string, route: string, opts: CallOpts = {}, key = kept.read().key) => {
    if (!key) throw new Error(`${NAME} isn't connected on this machine: add its API key on Add agents.`);
    return callApi(NAME, `${BASE()}/v3${route}`, { method, headers: headers(key), ...opts });
  };
  const inOrg = (route) => `/organizations/${encodeURIComponent(kept.read().org)}${route}`;

  /* ---------- connecting ---------- */

  const announce = () => ctx.emit({ e: "agent", agent: AGENT, name: NAME, kind: AGENT });
  // Connect this machine: its key, tried right here, which says which organization it's for unless it's for several.
  async function configure({ disconnect, key, org, budget }: SetupValues) {
    const was = kept.read();
    if (disconnect) {
      kept.write({});
      lastError = null;
      return connection();
    }
    const use = key || was.key;
    if (!use) throw new Error("Paste its API key.");
    const acus = budget === undefined ? was.budget : Number(budget);
    if (acus !== undefined && !(Number.isInteger(acus) && acus > 0)) throw new Error("What a thread may use is a whole number of ACUs.");
    const self = await call("GET", "/self", {}, use);
    const found = org || self.devin_sessions_org_id || self.org_id || (key ? null : was.org);
    if (!found) throw new Error("That key isn't for one organization: give its organization id too.");
    kept.write({ key: use, org: found, ...(acus ? { budget: acus } : {}) });
    lastError = null;
    announce();
    return connection();
  }
  // What Settings → Agents shows of it: the fields its form (RUNTIMES.devin.setup) names, and never the key.
  function connection() {
    const c = kept.read();
    return { connected: !!c.key, org: c.org || null, budget: c.budget || null, error: lastError };
  }

  /* ---------- its session, read ---------- */

  // Its turn, going or over, as its session says (the core starts one only on a thread that isn't in one already, and
  // ends one only that's going or that now says something else).
  function setBusy(id: string, busy: boolean, text?: string) {
    const c = conv(id);
    if (!post(id)) return;
    ctx.emit(busy ? { e: "turn.start", thread: id } : { e: "turn.end", thread: id, ...(text ? { text } : {}) });
    const was = c.busy;
    c.busy = busy;
    ctx.emit({ e: "changed", thread: id, save: was && !busy });
  }
  function ended(id: string, reason: string) {
    const c = conv(id);
    if (c.ended) return;
    c.ended = true;
    c.busy = false;
    ctx.emit({ e: "gone", thread: id, reason, ended: new Date().toISOString() });
    ctx.emit({ e: "changed", thread: id, save: true });
  }
  const waitingFor = (s: DevinSession) => {
    if (s.status === "suspended") return SHORT_OF_CREDITS.has(s.status_detail) ? "Out of Devin credits" : "Asleep: your next message wakes it";
    if (s.status_detail === "waiting_for_approval") return "Waiting for an approval in Devin";
    if (s.status_detail === "finished") return "Finished: your next message goes on";
    return "Waiting for your next message";
  };

  // What the session says it is now, on its post.
  function note(id: string, s: DevinSession) {
    const c = conv(id);
    c.session = s;
    if (s.title && s.title !== c.digest.ai_title) c.digest.ai_title = s.title;
    const prs = s.pull_requests || [];
    if (prs.length !== c.prs) {
      c.prs = prs.length;
      for (const p of prs) linkPr(ctx, id, p.pr_url, iso(s.updated_at) || new Date().toISOString());
    }
    const used = Number(s.acus_consumed);
    const text = Number.isFinite(used) && used > 0 ? `${used.toFixed(1)} ACUs used.` : "Runs in Devin's cloud.";
    if (s.url && `${s.url} ${text}` !== c.link) {
      c.link = `${s.url} ${text}`;
      ctx.emit({ e: "fact", op: { t: "session.attach", post: id, key: "remote", type: "link", title: NAME, data: { url: s.url, title: "Open in Devin", text } } });
    }
    const approval = s.status_detail === "waiting_for_approval";
    if (approval && !c.approval) ctx.emit({ e: "message", thread: id, from: "agent", via: "dash", text: `${NAME} is waiting for an approval, which only its own page can give: open this session in Devin to approve.` });
    c.approval = approval;
    if (isOver(s)) return ended(id, s.status === "error" ? `${NAME}'s session failed.` : `${NAME}'s session ended.`);
    if (isBusy(s)) {
      c.asked = 0;
      return setBusy(id, true);
    }
    if (!settling(c)) setBusy(id, false, waitingFor(s));
  }

  // What it said since last time. After a restart everything comes again: what's on the post already stays as it is.
  // What you wrote comes back as its own message too: what agentbook sent it is an echo, which the core drops, and so
  // is one already on the post from before a restart.
  async function messages(id: string) {
    const c = conv(id);
    const had = ctx.state.messages.filter((m) => m.post === id);
    const known = new Set(had.map((m) => m.id));
    const humans = had.filter((m) => m.from === "human").map((m) => String(m.text || "").trim());
    const cold = ctx.state.cold?.has(id);
    const d = c.digest;
    for (let after = c.cursor || null; ; ) {
      const r = await call("GET", inOrg(`/sessions/${encodeURIComponent(id)}/messages?first=200${after ? `&after=${encodeURIComponent(after)}` : ""}`));
      for (const m of r.items || []) {
        if (!m.event_id || c.seen.has(m.event_id)) continue;
        c.seen.add(m.event_id);
        const text = String(m.message || "").trim();
        if (!text) continue;
        const at = iso(m.created_at) || new Date().toISOString();
        if (m.source === "devin") {
          addSay(d, { id: m.event_id, at, text });
          c.asked = 0;
          c.heard = true;
          if (!cold && !known.has(m.event_id)) ctx.emit({ e: "message", thread: id, mid: m.event_id, from: "agent", via: "dash", text, when: at });
          continue;
        }
        d.turn++;
        // Written in Devin itself.
        if (!cold && !known.has(m.event_id) && !humans.some((h) => h && text.startsWith(h))) ctx.emit({ e: "message", thread: id, mid: m.event_id, from: "human", via: "terminal", text, when: at });
      }
      if (r.end_cursor) c.cursor = r.end_cursor;
      after = r.has_next_page ? r.end_cursor : null;
      if (!after) break;
    }
  }

  function pull(id: string) {
    const c = conv(id);
    c.pulling ||= (async () => {
      try {
        c.heard = false;
        const s = await call("GET", inOrg(`/sessions/${encodeURIComponent(id)}`));
        await messages(id);
        c.looked = Date.now();
        note(id, s);
      } finally {
        c.pulling = null;
      }
    })();
    return c.pulling;
  }

  // Look again in `ms`, and go on for as long as something can change without you.
  function watch(id: string, ms: number) {
    const c = conv(id);
    clearTimeout(c.timer);
    c.timer = setTimeout(async () => {
      c.timer = null;
      let next = null;
      try {
        await pull(id);
        const s = c.session;
        next = c.ended ? null : isBusy(s) || settling(c) ? WORKING_MS() : s.status_detail === "waiting_for_approval" ? APPROVAL_MS() : null;
      } catch (e) {
        if (e.status === 404) return ended(id, `${NAME}'s session is gone.`);
        if (e.status === 401 || e.status === 403) {
          lastError = e.message;
          return log(`devin ${id}: ${e.message}`);
        }
        log(`devin ${id}: ${e.message}`);
        next = RETRY_MS();
      }
      if (next && !c.ended) watch(id, next);
    }, ms);
    c.timer.unref?.();
  }

  /* ---------- talking to it ---------- */

  // A thread's files, kept by Devin: -> their addresses, and a line for each it couldn't get.
  async function attach(files: Attached[]) {
    const { ready, missed } = filesOn(files);
    const urls = [];
    for (const f of ready) {
      const form = new FormData();
      form.set("file", new Blob([f.bytes]), f.name);
      const r = await call("POST", inOrg("/attachments"), { form, timeout: 120e3 });
      const url = typeof r === "string" ? r : r.url || r.attachment_url;
      if (url) urls.push(url);
      else missed.push(f.name);
    }
    return { urls, lines: missed.map((name) => `[${name} couldn't be sent]`) };
  }

  // A message, as the core's delivery makes it of what's queued, with the files you attached.
  async function send(id: string, text: string, files: Attached[] = []) {
    const c = conv(id);
    if (c.ended) throw new Error(`${NAME}'s session has ended.`);
    const { urls, lines } = await attach(files);
    const message = [text, ...lines].filter(Boolean).join("\n\n") || "See the attached files.";
    // What comes back isn't quite what the core sent when files went with it: that's an echo too.
    if (message !== text) ctx.echo(id, message);
    await call("POST", inOrg(`/sessions/${encodeURIComponent(id)}/messages`), { body: { message, ...(urls.length ? { attachment_urls: urls } : {}) } });
    c.asked = Date.now();
    setBusy(id, true);
    watch(id, Math.min(1000, WORKING_MS()));
  }

  async function start({ prompt, shown = prompt, files = [], lid, model, repo }: StartRequest) {
    // The server sends a start again when this process stopped before answering: a session costs money, so it's the
    // same one.
    const again = Object.values(ctx.state.sessions).find((s) => s.launch === lid && mine(s));
    if (again) return { id: again.id };
    if (!kept.read().key) throw new Error(`${NAME} isn't connected on this machine: add its API key on Add agents.`);
    const gh = repo ? githubRepo(repo) : null;
    if (repo && !gh) throw new Error(`${NAME} can only be pointed at repos on GitHub from here.`);
    const { urls, lines } = await attach(files);
    const said = [prompt, ...lines].filter(Boolean).join("\n\n");
    const s = await call("POST", inOrg("/sessions"), { body: { prompt: said, title: short(shown, 100), tags: ["agentbook"], ...(gh ? { repos: [`${gh.owner}/${gh.name}`] } : {}), ...(model ? { devin_mode: model } : {}), ...(kept.read().budget ? { max_acu_limit: kept.read().budget } : {}), ...(urls.length ? { attachment_urls: urls } : {}) } });
    const id = s.session_id;
    const c = conv(id);
    ctx.echo(id, said);
    c.digest.model = model || "normal";
    const now = iso(s.created_at) || new Date().toISOString();
    // Its thread works on the repo it cloned there, with no folder here.
    ctx.emit({ e: "thread", thread: id, agent: AGENT, agent_name: NAME, kind: AGENT, cwd: "", root: "", repo: gh?.key || "", branch: "", host: "cloud", launch: lid, started: now, updated: now, prompt: short(shown, 2000) });
    ctx.emit({ e: "message", thread: id, from: "human", via: "dash", text: shown, resume: lid });
    ctx.emit({ e: "changed", thread: id, save: true });
    note(id, s);
    setBusy(id, true);
    watch(id, Math.min(1000, WORKING_MS()));
    return { id };
  }

  // Never ended by this: Devin sleeps, and your next message wakes it.
  async function interrupt(id: string) {
    await call("POST", inOrg(`/sessions/${encodeURIComponent(id)}/sleep`));
    watch(id, 0);
  }

  return {
    id: AGENT,
    info: RUNTIMES[AGENT],
    // What you write comes back as a message of its session's; what agentbook sent it, the core knows by its words.
    echoes: "text",
    owns: (id) => id === AGENT && ctx?.state.agents[id]?.kind === AGENT,
    connect(c) {
      ctx = c;
      if (!enabled) return;
      if (kept.read().key) announce();
      for (const s of Object.values(ctx.state.sessions)) {
        if (!mine(s)) continue;
        if (s.state !== "done") watch(s.id, 0);
        if (ctx.pending(s.id).length) ctx.deliver(s.id);
      }
    },
    health: () => ({ enabled, connected: !!kept.read().key, error: lastError }),
    start,
    send: (id, text, files) => send(id, text, files),
    // Devin has nothing to approve with: an answer goes as words.
    answer: () => false,
    interrupt,
    read: async (id) => {
      const c = conv(id);
      if (kept.read().key && Date.now() - c.looked > LOOK_AGAIN_MS) {
        await pull(id).catch((e) => log(`devin ${id}: ${e.message}`));
        if (c.session && !c.ended && (isBusy(c.session) || settling(c)) && !c.timer) watch(id, WORKING_MS());
      }
      return c.digest;
    },
    live: (s) => liveOf(convs.get(s.id)?.digest),
    summary: (s) => summaryOf(convs.get(s.id)?.digest, s),
    working: (id) => !!convs.get(id)?.busy,
    blocked: (s) => (s.state === "done" ? `${NAME}'s session has ended.` : null),
    resumeCommand: () => null,
    models: { list: () => ({ list: MODES, default: "normal" }) },
    // Its agents run in Devin's cloud, reached with the key this machine keeps.
    remote: { machine: () => "cloud", link: () => ({ connected: !!kept.read().key, state: kept.read().key ? "connected" : "off" }) },
    setup: { configure: (v) => configure(v as SetupValues), connection },
    row: () => remoteRow({ off, error: lastError, connected: !!kept.read().key, where: "Runs in Devin's cloud, on your API key." }),
  };
}
