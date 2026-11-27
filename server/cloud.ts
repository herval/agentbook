// Waking a machine that runs in a cloud sandbox: a boat sandbox, or an
// exe.dev VM. A boat sandbox stops itself after a while, an exe.dev VM when someone pauses it,
// and neither can wake itself. What's sent to its machine meanwhile waits in the relay (relay.ts). Its owner links the
// machine to its sandbox on the machine's page (machine.cloud), with a connector of theirs that runs machines
// (connectors/machines.ts), or agentbook made it there. Then, when something starts waiting for it, the server
// resumes the sandbox with that connector's key, and the page says "Waking" instead of "starts when it's back", or
// why its provider wouldn't.
//
// Nothing here polls: it acts when a command is held for a machine that's off (relay's onHeld), once shortly after
// the server starts (for what waited across a restart), and on its owner's Wake. One timer follows each wake, to say
// so if the machine never connected.
//
// host: { relay, linkOf(D) -> { connector, sandbox } | null, connOf(D, connector id) -> { kind, key, settings } | null,
// changed(), log }
// providers: connectors/machines.ts's, by connector kind, or stand-ins.

import type { Provider } from "./integrations/connectors/machines.ts";
import type { MachineCloud } from "../plugin/shared/types.ts";
import type { Device, PaceInfo, Relay } from "./relay.ts";

const CONNECT_MS = Number(process.env.AGENTBOOK_CLOUD_CONNECT_MS || 90e3); // from its provider's yes to its agentbook-cli here
const AGAIN_MS = Number(process.env.AGENTBOOK_CLOUD_AGAIN_MS || 60e3); // a wake that failed isn't asked again sooner, unless its owner asks
const TRIES = 4; // of "not yet" from its provider (out of machines, still stopping), before it's left to its owner

// A stopped sandbox's disk is kept by boat for 14 days at least: one asleep this long is woken, so its next stop is a
// new one. And a connector's machines are looked at this often at most.
const KEEP_MS = Number(process.env.AGENTBOOK_CLOUD_KEEP_DAYS || 12) * 86400e3;
const TEND_MS = Number(process.env.AGENTBOOK_CLOUD_TEND_MS || 6 * 3600e3);

// A connector of the machine's owner's that runs machines: its kind (which provider), its key, and its settings (how
// many hours boat keeps a busy machine on, how many minutes an idle one).
interface MachinesConn {
  kind?: string;
  key: string;
  settings?: { busy?: unknown; idle?: unknown } | null;
}
export interface CloudHost {
  relay: Pick<Relay, "online" | "infoOf" | "waiting">;
  providerOf: (kind: string | null | undefined) => Pick<Provider, "name" | "sandbox" | "resume" | "stopIn" | "sandboxes" | "keepDays" | "shell"> | null;
  linkOf: (D: Device) => MachineCloud | null;
  connOf: (D: Device, connector: string) => MachinesConn | null;
  linked?: (uid: string, connector: string) => Device[];
  mates?: (D: Device) => Device[];
  seenOf?: (D: Device) => number;
  found?: (D: Device, patch: { gone: boolean }) => void;
  changed?: () => void;
  log?: (line: string) => void;
}
// How waking a machine goes: `phase` "asking" (its provider is being asked, or will be again: `error` says why not
// yet), "resumed" (it said yes, its agentbook-cli isn't here yet) or "failed".
interface Waking {
  at: number;
  phase: "asking" | "resumed" | "failed";
  error?: string;
  tries: number;
  timer?: ReturnType<typeof setTimeout>;
}
// What a wake answers: the machine is on, it's being woken, or why it isn't.
export interface Woken {
  on?: boolean;
  waking?: boolean;
  error?: string;
}
// A sandbox's auto-stop as last moved: whether it was busy, its machines' starts, when, when boat stops it (null:
// not known yet), why it couldn't be moved, and the seconds boat's trial held it to (null: not held).
interface Paced {
  busy: boolean;
  started: string;
  at: number;
  until: string | null;
  error: string | null;
  capped?: number | null;
}

export type Cloud = ReturnType<typeof createCloud>;
export function createCloud({ relay, providerOf, linkOf, connOf, linked = () => [], mates = (D) => [D], seenOf = () => 0, found = () => {}, changed = () => {}, log = () => {} }: CloudHost) {
  const waking = new Map<string, Waking>();
  const set = (D: Device, w: Waking | null) => {
    clearTimeout(waking.get(D.id)?.timer);
    if (w) waking.set(D.id, w);
    else waking.delete(D.id);
    changed();
  };
  const failed = (D: Device, error: string, tries = 0) => {
    log(`${D.name}: not woken: ${error}`);
    set(D, { at: Date.now(), phase: "failed", error, tries });
  };

  // Wake D's sandbox if it's off and linked. `force`: its owner asked, so a failure a moment ago doesn't hold it back.
  async function wake(D: Device, { force = false, tries = 0 } = {}): Promise<Woken> {
    const link = linkOf(D);
    if (!link) return { error: `${D.name} isn't linked to a sandbox.` };
    if (relay.online(D)) return (set(D, null), { on: true });
    const w = waking.get(D.id);
    if (w?.phase === "asking" || w?.phase === "resumed") return { waking: true };
    if (w?.phase === "failed" && !force && !tries && Date.now() - w.at < AGAIN_MS) return { error: w.error };
    const c = connOf(D, link.connector);
    const p = c && providerOf(c.kind);
    if (!c || !p) return (failed(D, "Its connector is gone, off, or has no key. Link it again on its page."), { error: waking.get(D.id).error });
    const key = c.key;
    set(D, { at: Date.now(), phase: "asking", tries });
    try {
      const s = await p.sandbox(key, link.sandbox);
      if (s.gone) throw new Error(`${p.name} deleted this sandbox's disk: it was stopped for more than ${p.keepDays || 14} days. It can't come back.`);
      if (s.state === "stopped") await p.resume(key, link.sandbox);
      else if (s.state !== "on" && s.state !== "starting") throw new Error(`${p.name} says its sandbox is ${s.state}, which it can't wake from.`);
      if (relay.online(D)) return (set(D, null), { on: true });
      log(`${D.name}: ${s.state === "stopped" ? "woke" : "waiting for"} its sandbox ${link.sandbox}`);
      const up = s.state === "on";
      const timer = setTimeout(() => {
        if (waking.get(D.id)?.phase !== "resumed") return;
        if (relay.online(D)) return set(D, null);
        failed(D, up ? `${p.name} says its sandbox is running, but its agentbook-cli isn't connected. Look at it there: ${p.shell(link.sandbox)}` : `${p.name} started its sandbox, but its agentbook-cli didn't connect in ${Math.round(CONNECT_MS / 1000)} seconds. Look at it there: ${p.shell(link.sandbox)}`);
      }, CONNECT_MS);
      timer.unref?.();
      set(D, { at: Date.now(), phase: "resumed", tries, timer });
      return { waking: true };
    } catch (e) {
      // "Not yet" from its provider: asked again by itself, a few times, while something still waits for the machine.
      if (e.later && tries + 1 < TRIES) {
        const timer = setTimeout(() => {
          waking.delete(D.id);
          if (relay.online(D) || !relay.waiting(D).length) return changed();
          wake(D, { tries: tries + 1 }).catch(() => {});
        }, Math.min(300, Math.max(5, e.retry || 30)) * 1000);
        timer.unref?.();
        log(`${D.name}: not woken yet: ${e.message}`);
        set(D, { at: Date.now(), phase: "asking", tries, timer, error: e.message });
        return { waking: true };
      }
      failed(D, e.message, tries);
      return { error: e.message };
    }
  }

  /* ---------- sleeping: boat stops an idle machine soon, and a busy one late ---------- */

  // The machine says whether stopping it now would cut something off (its info's `pace`, from agentbook-cli), and the
  // server moves its sandbox's auto-stop, which counts from the call: to its connector's busy hours when it turns
  // busy, to its idle minutes when it turns idle. boat does the stopping: no boat key is in the sandbox and nothing
  // here keeps time, so if this server is down, the last deadline still holds. A machine whose agentbook-cli doesn't
  // say (an older one) keeps boat's own auto-stop. Each start of its agentbook-cli (`started`: a wake, a restart)
  // is paced afresh, since boat gives a resumed sandbox a deadline of its own.
  const paced = new Map<string, Paced>(); // sandbox id -> { busy, started, at, until, error? }
  // What every machine in the sandbox says, of those that are on and say: a shared machine's seats are one box, busy
  // while any of them is (`mates`: the machines that share D's sandbox, D among them).
  const said = (D: Device): PaceInfo[] =>
    mates(D)
      .filter((x) => relay.online(x) && typeof relay.infoOf(x)?.pace?.busy === "boolean")
      .map((x) => relay.infoOf(x).pace);
  const stance = (all: PaceInfo[]) => ({ busy: all.some((p) => p.busy), started: all.map((p) => p.started || "").sort().join(" ") });
  async function pace(D: Device, { force = false } = {}): Promise<void> {
    const link = linkOf(D);
    const all = link ? said(D) : [];
    if (!all.length) return;
    const now = stance(all);
    const was = paced.get(link.sandbox);
    if (!force && was && was.busy === now.busy && was.started === now.started) return;
    const c = connOf(D, link.connector);
    const p = c && providerOf(c.kind);
    // A provider with no auto-stop (exe.dev) keeps a machine on until someone pauses it: nothing to move.
    if (!p?.stopIn) return;
    const seconds = now.busy ? Math.max(1, Number(c.settings?.busy) || 8) * 3600 : Math.max(1, Number(c.settings?.idle) || 15) * 60;
    const mine: Paced = { ...now, at: Date.now(), until: null, error: null };
    paced.set(link.sandbox, mine);
    try {
      const r = await p.stopIn(c.key, link.sandbox, seconds);
      mine.until = new Date(mine.at + r.seconds * 1000).toISOString();
      mine.capped = r.seconds < seconds ? r.seconds : null;
      log(`${D.name}: ${now.busy ? "busy" : "idle"}, so boat stops its sandbox in ${Math.round(r.seconds / 60)} minutes at the latest${mine.capped ? " (the most boat's trial allows)" : ""}`);
    } catch (e) {
      mine.error = e.message;
      log(`${D.name}: couldn't move its sandbox's auto-stop: ${e.message}`);
    }
    // One that changed while boat was asked: paced again, by what it says now.
    if (paced.get(link.sandbox) !== mine) return;
    changed();
    const next = said(D);
    if (next.length && (stance(next).busy !== mine.busy || stance(next).started !== mine.started)) pace(D).catch(() => {});
  }

  /* ---------- kept past 14 days ---------- */

  // A connector's machines, looked after: from the connector's own
  // sync, a few times a day. One whose sandbox boat no longer has (deleted there, or its disk expired) says so on its
  // page. One asleep for 12 days is woken: it connects, says it's idle, and boat stops it again a few minutes on
  // (pace), which makes a new stop and so a disk boat keeps for 14 more days. Whether boat counts its 14 days from
  // the newest stop hasn't been checked against boat.
  const tended = new Map<string, number>(); // "uid connector" -> when
  async function tend(uid: string, connector: string): Promise<void> {
    const k = `${uid} ${connector}`;
    if (Date.now() - (tended.get(k) || 0) < TEND_MS) return;
    const mine = linked(uid, connector);
    if (!mine.length) return;
    const c = connOf(mine[0], connector);
    const p = c && providerOf(c.kind);
    if (!c || !p) return;
    tended.set(k, Date.now());
    const boxes = new Map((await p.sandboxes(c.key)).map((s) => [s.id, s]));
    for (const D of mine) {
      const link = linkOf(D);
      const s = boxes.get(link.sandbox);
      const gone = !s || s.gone;
      if (gone !== !!link.gone) {
        found(D, { gone });
        log(`${D.name}: ${gone ? `${p.name} no longer has its sandbox ${link.sandbox}` : `its sandbox is back on ${p.name}`}`);
        changed();
      }
      const seen = seenOf(D);
      // Only where a stopped disk is kept a while (boat): exe.dev keeps a paused VM's disk.
      if (p.keepDays && !gone && s.state === "stopped" && seen && Date.now() - seen > KEEP_MS && !relay.online(D)) {
        log(`${D.name}: asleep for ${Math.round((Date.now() - seen) / 86400e3)} days, so it's woken for a few minutes: ${p.name} keeps a stopped disk ${p.keepDays}`);
        wake(D, { force: true }).catch((e) => log(`${D.name}: wake: ${e.message}`));
      }
    }
  }

  return {
    wake,
    pace,
    tend,
    // Something was held for a machine that's off.
    held(D: Device): void {
      if (linkOf(D)) wake(D).catch((e) => log(`${D.name}: wake: ${e.message}`));
    },
    // The machine said something: it's on, so it's awake.
    heard(D: Device): void {
      if (waking.has(D.id) && relay.online(D)) set(D, null);
    },
    // Its link changed or went: what was said of the old one goes.
    forget: (D: Device) => (paced.delete(linkOf(D)?.sandbox), set(D, null)),
    // For the page: null (not linked), or { kind, sandbox, connector, waking, error, sleep }, and for one agentbook made,
    // its image, version, size and secrets' names, and how its setup or update is going (on exe.dev, the code its
    // login waits on: `login`). `sleep`, while it's on and says whether it's busy: { busy, until (when boat stops it
    // unless that changes), error (why its auto-stop couldn't be moved), capped }.
    view(D: Device) {
      const link = linkOf(D);
      if (!link) return null;
      const on = relay.online(D);
      const w = on ? null : waking.get(D.id);
      const s = on ? paced.get(link.sandbox) : null;
      return { kind: link.kind || "boat", sandbox: link.sandbox, connector: link.connector, waking: !!w && w.phase !== "failed", error: w?.error || (link.gone ? `${providerOf(link.kind)?.name || "Its provider"} no longer has its sandbox: it was deleted there${link.kind === "exe" ? "" : ", or stopped for more than 14 days"}. It can't come back.` : null), ...(link.gone ? { gone: true } : {}), ...(link.made ? { made: true, image: link.image, v: link.v ?? null, size: link.size || null, secrets: link.secrets || [], ...(link.setting ? { setting: true } : {}), ...(link.updating ? { updating: link.updating } : {}), ...(link.setup_error ? { setup_error: link.setup_error } : {}), ...(link.login && !on ? { login: link.login } : {}) } : {}), ...(s ? { sleep: { busy: s.busy, until: s.until, error: s.error, ...(s.capped ? { capped: s.capped } : {}) } } : {}) };
    },
  };
}
