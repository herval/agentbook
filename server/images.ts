// Images for cloud machines, and their builds.
//
// An image is its owner's: a name, the boat connector of theirs it's built with, and a definition they edit (a
// draft: image-script.ts). Build makes the draft a version: the server makes a builder sandbox with their key, with
// no secrets and with monitoring off, whose setup script agentbook wrote; looks at it every ten seconds while it
// builds, for an hour at most (nothing looks at boat otherwise); then reads the script's log, saves the builder's
// disk as a boat saved snapshot ("agentbook-<image>-v<n>"), and deletes the builder. A build that fails saves
// nothing, keeps its log, and deletes the builder too. Two built versions stay on boat per image, the newest and the
// one before, since saved snapshots past a plan's included ones cost money.
//
// host: { state, commit, boat, connOf(uid, connector id) -> { key, settings } | null, publicUrl, host (this
// server's name, for a label), changed(), log }

import { setTimeout as sleep } from "node:timers/promises";
import { catalogView, SIZES } from "./integrations/connectors/boat-catalog.ts";
import { bundle, endTickets, ticket } from "./cli-bundle.ts";
import { LOG_PATH, changesOf, normalDef, scriptFor, stepsOf } from "./image-script.ts";
import type { DefInput, Seat } from "./image-script.ts";
import type * as Boat from "./integrations/connectors/boat.ts";
import type { Image, ImageBuild, ImageDef, State } from "../plugin/shared/types.ts";

type BoatCalls = Pick<typeof Boat, "create" | "remove" | "sandbox" | "readFile" | "saveSnapshot" | "snapshot" | "dropSnapshot">;
// A person's boat connector, as connectors.ts's byId gives it: its key, and its settings (the boat org it uses).
export interface BoatConn {
  key: string;
  settings?: { org?: string } | null;
}
type BuildPatch = Partial<Pick<ImageBuild, "state" | "sandbox" | "error" | "log" | "ended" | "step">>;
type ImageOp =
  | { t: "image.save"; image: string; owner: string; connector: string; name: string; def: ImageDef }
  | { t: "image.build"; build: string; image: string; v: number; connector: string; def: ImageDef; cli: string; snapshot: string; sandbox: string }
  | { t: "image.built"; build: string; patch: BuildPatch }
  | { t: "image.remove"; image: string };
// What makes an image's draft (save): its id when it's one there is, its name, connector and definition.
export interface ImageInput {
  id?: string | null;
  name?: string;
  connector?: string | null;
  def?: DefInput;
}
// What a script is for (script): whose, the ticket's `about` (which ends it), its title, and what it does.
export interface ScriptAsk {
  uid: string;
  about: string;
  title?: string;
  git?: boolean;
  only?: string | string[] | null;
  seat?: Seat | null;
}
// What images.ts needs of the server: `host` above.
export interface ImagesHost {
  state: Pick<State, "images" | "image_builds">;
  commit: (op: ImageOp) => unknown;
  boat: BoatCalls;
  connOf: (uid: string, connector: string) => BoatConn | null;
  publicUrl: string;
  host?: string;
  changed?: () => void;
  log?: (line: string) => void;
}

const POLL_MS = Number(process.env.AGENTBOOK_IMAGE_POLL_MS || 10e3);
const MAX_MS = Number(process.env.AGENTBOOK_IMAGE_MAX_MS || 3600e3);
const KEEP = 2;
const LOG_MAX = 200e3;
const slug = (name: string) =>
  String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "image";
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

// Whether a sandbox on the internet could reach this server at `url`: over https, at a name that isn't this machine's
// or a tailnet's. AGENTBOOK_CLOUD_ANYWHERE=1 says it can anyway (the tests, whose boat is a stand-in).
export function reachable(url: string): boolean {
  if (process.env.AGENTBOOK_CLOUD_ANYWHERE === "1") return true;
  try {
    const u = new URL(url);
    const h = u.hostname;
    return u.protocol === "https:" && !h.endsWith(".ts.net") && !["localhost", "127.0.0.1", "[::1]"].includes(h) && !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h) && !h.endsWith(".local") && !h.endsWith(".internal");
  } catch {
    return false;
  }
}

export function createImages({ state, commit, boat, connOf, publicUrl, host = "agentbook", changed = () => {}, log = () => {} }: ImagesHost) {
  const all = () => Object.values(state.images || {});
  const mine = (uid: string) => all().filter((i) => uid && i.owner === uid);
  const buildsOf = (id: string) =>
    Object.values(state.image_builds || {})
      .filter((b) => b.image === id)
      .sort((a, b) => b.v - a.v);
  const going = (b: ImageBuild) => b.state === "building" || b.state === "saving";
  // The newest version that's on boat to make a machine from.
  const newest = (id: string) => buildsOf(id).find((b) => b.state === "ready") || null;
  const snapshotName = (img: Image, v: number) => `agentbook-${img.id}-v${v}`;
  const where = () => (reachable(publicUrl) ? null : `A cloud machine reaches agentbook-server over the internet, and this one is at ${publicUrl}, which boat's machines can't reach. Cloud machines are for an agentbook-server that's public, at https.`);

  // An image for the page: its draft, what changed in it since its newest built version, and each build with its
  // parts (the log itself is asked for by itself).
  function view(img: Image) {
    const builds = buildsOf(img.id);
    const built = newest(img.id);
    const last = builds.find((b) => b.state !== "gone") || null;
    // What a build changed: against the one built before it (a first one has nothing to compare with).
    const before = (b: ImageBuild) => builds.find((x) => x.v < b.v && x.state !== "failed") || null;
    // Its script's parts, how it ended ("ok" or "failed", by its log) and how long it ran.
    const partsOf = (text: string) => {
      const p = stepsOf(text);
      return { steps: p.steps, outcome: p.ended, seconds: p.seconds };
    };
    return {
      id: img.id,
      name: img.name,
      connector: img.connector,
      def: img.def,
      v: img.v,
      updated: img.updated,
      built: built ? { v: built.v, at: built.ended, snapshot: built.snapshot, def: built.def } : null,
      building: builds.find(going)?.v || null,
      // What Build would make, and why it differs from the newest that's built (none: nothing to build).
      changes: built ? changesOf(built.def, img.def) : null,
      // Since the last build that was tried, so a failed one isn't offered again unchanged without saying so.
      tried: last && !going(last) && last.state === "failed" && !changesOf(last.def, img.def).length ? last.v : null,
      builds: builds.map((b) => ({ v: b.v, state: b.state, started: b.started, ended: b.ended, error: b.error, sandbox: b.sandbox, snapshot: b.snapshot, cli: b.cli, size: b.def?.size || "default", step: b.step || null, ...partsOf(b.log), changes: before(b) ? changesOf(before(b).def, b.def).slice(0, 12) : [] })),
    };
  }

  // Make one, or change one's draft. `input`: { id?, name, connector, def }.
  function save(uid: string, input: ImageInput) {
    const was = input.id ? mine(uid).find((i) => i.id === input.id) : null;
    if (input.id && !was) throw fail(404, "No such image of yours.");
    const name = String(input.name ?? was?.name ?? "").trim().slice(0, 60);
    if (!name) throw fail(400, "Name the image.");
    if (mine(uid).some((i) => i.id !== was?.id && i.name.toLowerCase() === name.toLowerCase())) throw fail(409, `You have an image called ${name} already.`);
    const connector = String(input.connector || was?.connector || "");
    if (!connOf(uid, connector)) throw fail(400, "Pick the boat connector it's built with. Connect boat on Connectors first.");
    let id = was?.id;
    if (!id) {
      id = slug(name);
      for (let n = 2; state.images?.[id]; n++) id = `${slug(name)}-${n}`;
    }
    const { def, errors } = normalDef(input.def ?? was?.def ?? {});
    commit({ t: "image.save", image: id, owner: uid, connector, name, def });
    changed();
    return { image: view(state.images[id]), errors };
  }

  // The image every person has without making one: agentbook and Claude Code, nothing picked.
  function basic(uid: string, connector: string): Image {
    const have = mine(uid).find((i) => i.name === "Basic");
    return have ? have : state.images[save(uid, { name: "Basic", connector, def: {} }).image.id];
  }

  // The script for a definition, with a ticket to download agentbook-cli with (and, with `git`, to clone private
  // repos as its owner while it runs). `about`: what the ticket is for, which ends it. -> { script, version } or throws.
  function script(def: ImageDef, { uid, about, title, git = false, only = null, seat = null }: ScriptAsk) {
    const no = where();
    if (no) throw fail(409, no);
    const b = bundle();
    if (!b) throw fail(503, "This agentbook-server has no agentbook-cli to give a machine: it wasn't started by bin/agentbook-server, which packs it.");
    const t = ticket({ about, uid, git });
    const text = scriptFor(def, { version: b.version, bundle: `${publicUrl}/api/cli/bundle?t=${t}`, git: git ? `${publicUrl}/api/cli/git?t=${t}` : null, title, only, seat });
    if (Buffer.byteLength(text) > 65536) throw fail(400, "Its script is longer than boat takes (64 KB). Shorten your steps.");
    return { script: text, version: b.version };
  }

  /* ---------- building ---------- */

  const watching = new Set<string>();
  const patch = (id: string, p: BuildPatch) => {
    commit({ t: "image.built", build: id, patch: p });
    changed();
  };
  async function failed(b: ImageBuild, c: BoatConn | null, error: string, { logText }: { logText?: string } = {}) {
    if (c && b.sandbox) await boat.remove(c.key, b.sandbox).catch((e) => log(`image ${b.id}: its builder ${b.sandbox} couldn't be deleted: ${e.message}`));
    endTickets(b.id);
    log(`image ${b.id}: failed: ${error}`);
    patch(b.id, { state: "failed", error: String(error).slice(0, 2000), ...(logText != null ? { log: logText.slice(-LOG_MAX) } : {}), step: null });
  }
  // Older built versions' snapshots go from boat: the newest and the one before stay.
  async function prune(imageId: string, c: BoatConn) {
    for (const b of buildsOf(imageId).filter((x) => x.state === "ready").slice(KEEP)) {
      try {
        await boat.dropSnapshot(c.key, b.snapshot);
        patch(b.id, { state: "gone" });
        log(`image ${b.id}: its snapshot ${b.snapshot} is deleted from boat (the newest ${KEEP} stay)`);
      } catch (e) {
        log(`image ${b.id}: couldn't delete its snapshot ${b.snapshot}: ${e.message}`);
      }
    }
  }
  async function watch(id: string): Promise<void> {
    if (watching.has(id)) return;
    watching.add(id);
    let resaved = false;
    try {
      for (;;) {
        const b = state.image_builds?.[id];
        if (!b || !going(b)) return;
        const c = connOf(b.owner, b.connector);
        if (!c) return void (await failed(b, null, "Its boat connector is gone, off, or has no key. Its builder may still be on boat: delete it there."));
        if (Date.now() - Date.parse(b.started) > MAX_MS) return void (await failed(b, c, `It took more than ${Math.round(MAX_MS / 60e3)} minutes, so it was stopped.`));
        try {
          if (b.state === "building") {
            const s = await boat.sandbox(c.key, b.sandbox);
            const text = s.state === "on" ? await boat.readFile(c.key, b.sandbox, LOG_PATH).catch((): null => null) : null;
            if (s.setup === "failed") {
              const parts = stepsOf(text);
              const at = parts.steps.find((x) => x.state === "failed") || parts.steps.at(-1);
              return void (await failed(b, c, at ? `Stopped at ${at.label}${at.out ? `: ${at.out.split("\n").at(-1).slice(0, 300)}` : ""}` : s.setup_error || "Its setup script failed before it wrote anything.", { logText: text || s.setup_error || "" }));
            }
            if (s.setup === "done") {
              patch(id, { state: "saving", log: (text || "").slice(-LOG_MAX), step: null });
              await boat.saveSnapshot(c.key, b.sandbox, b.snapshot);
            } else if (text) {
              const now = stepsOf(text).steps.at(-1)?.label || null;
              if (now !== (b.step || null)) patch(id, { step: now, log: text.slice(-LOG_MAX) });
            } else if (s.state !== "on" && s.state !== "starting") return void (await failed(b, c, `boat says its builder is ${s.state}.`));
          } else {
            const snap = await boat.snapshot(c.key, b.snapshot);
            if (snap?.state === "ready") {
              await boat.remove(c.key, b.sandbox).catch((e) => log(`image ${id}: its builder ${b.sandbox} couldn't be deleted: ${e.message}`));
              endTickets(id);
              patch(id, { state: "ready" });
              log(`image ${id}: built, as ${b.snapshot}`);
              await prune(b.image, c);
              return;
            }
            if (snap?.state === "failed") return void (await failed(b, c, `boat couldn't save its disk: ${snap.error || "it didn't say why"}.`));
            // No such snapshot: the save was never asked for (this server stopped just then). Asked once more.
            if (!snap) {
              if (resaved) return void (await failed(b, c, "boat has no saved snapshot for it, after asking twice."));
              resaved = true;
              await boat.saveSnapshot(c.key, b.sandbox, b.snapshot);
            }
          }
        } catch (e) {
          // "Not yet" from boat, or it couldn't be reached: looked at again. Anything else ends the build.
          if (!e.later) return void (await failed(b, c, e.message));
          log(`image ${id}: ${e.message}`);
        }
        await sleep(POLL_MS);
      }
    } finally {
      watching.delete(id);
    }
  }

  // Build an image's draft: its next version. -> the image's view, with the build started.
  async function build(uid: string, id: string) {
    const img = mine(uid).find((i) => i.id === id);
    if (!img) throw fail(404, "No such image of yours.");
    if (buildsOf(id).some(going)) throw fail(409, `${img.name} is being built already.`);
    const c = connOf(uid, img.connector);
    if (!c) throw fail(409, "Its boat connector is gone, off, or has no key.");
    const v = (img.v || 0) + 1;
    const bid = `${img.id}-v${v}`;
    const made = script(img.def, { uid, about: bid, title: `${img.name} v${v}`, git: img.def.repos.length > 0 });
    let box;
    try {
      box = await boat.create(c.key, { name: `agentbook build: ${img.name} v${v}`.slice(0, 120), size: img.def.size, script: made.script, bare: true, stopIn: Math.round(MAX_MS / 1000), labels: { agentbook: host, "agentbook/build": bid }, org: c.settings?.org, monitoring: false }, { idempotency: `${bid}-${Date.now().toString(36)}` });
    } catch (e) {
      endTickets(bid);
      throw fail(e.status === 402 || e.status === 403 || e.status === 429 ? 409 : 502, e.message);
    }
    commit({ t: "image.build", build: bid, image: img.id, v, connector: img.connector, def: img.def, cli: made.version, snapshot: snapshotName(img, v), sandbox: box.id });
    log(`image ${bid}: building on ${box.id}`);
    changed();
    watch(bid).catch((e) => log(`image ${bid}: ${e.message}`));
    return view(state.images[id]);
  }

  // Delete an image: its saved snapshots go from boat, and it's forgotten. Machines made from it keep running.
  async function remove(uid: string, id: string) {
    const img = mine(uid).find((i) => i.id === id);
    if (!img) throw fail(404, "No such image of yours.");
    if (buildsOf(id).some(going)) throw fail(409, `${img.name} is being built. Delete it once that's done.`);
    const c = connOf(uid, img.connector);
    const kept = buildsOf(id).filter((b) => b.state === "ready");
    if (kept.length && !c) throw fail(409, "Its boat connector is gone or off, so its saved snapshots can't be deleted from boat. Turn the connector on first, or delete them on boat.");
    for (const b of kept) {
      try {
        await boat.dropSnapshot(c.key, b.snapshot);
      } catch (e) {
        throw fail(502, `Couldn't delete ${b.snapshot} from boat: ${e.message}`);
      }
    }
    commit({ t: "image.remove", image: id });
    changed();
    return true;
  }

  return {
    view,
    mine: (uid: string) => mine(uid).sort((a, b) => a.name.localeCompare(b.name)).map(view),
    get: (uid: string, id: string) => mine(uid).find((i) => i.id === id) || null,
    // For the page's state, briefly: what a page looks at to know its images changed.
    summary: (uid: string) => mine(uid).map((i) => ({ id: i.id, name: i.name, connector: i.connector, v: i.v, updated: i.updated, built: newest(i.id)?.v || null, state: buildsOf(i.id)[0]?.state || null, step: buildsOf(i.id)[0]?.step || null })),
    catalog: () => ({ catalog: catalogView(), sizes: SIZES, cli: bundle()?.version || null, unreachable: where() }),
    save,
    basic,
    script,
    newest,
    build,
    remove,
    log: (uid: string, id: string, v: number) => {
      const b = mine(uid).some((i) => i.id === id) ? state.image_builds?.[`${id}-v${v}`] : null;
      return b ? b.log || "" : null;
    },
    // Builds this server was watching when it stopped go on being watched.
    resume() {
      for (const b of Object.values(state.image_builds || {})) if (going(b)) watch(b.id).catch((e) => log(`image ${b.id}: ${e.message}`));
    },
    // An account is removed: its images go (their snapshots are its boat account's to clean).
    forget(uid: string) {
      for (const i of mine(uid)) commit({ t: "image.remove", image: i.id });
    },
  };
}
