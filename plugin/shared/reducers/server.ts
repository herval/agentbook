// Server-only store state reducer: bell, feed archive, prefs, cloud sandboxes, shared boxes, images, news (store.ts).

import type { ServerOp } from "../ops.ts";
import type { ImageDef, Iso, State } from "../types.ts";

export function applyServer(state: State, op: ServerOp, now: Iso): void {
  switch (op.t) {
    case "bell.seen": {
      // When a person last opened the bell (server only): its notifications since then count on it.
      if (!op.user) break;
      (state.bell_seen ||= {})[op.user] = now;
      break;
    }
    case "bell.clear": {
      // When a person last cleared the bell's notifications (server only): the ones until then are off it.
      if (!op.user) break;
      (state.bell_cleared ||= {})[op.user] = now;
      break;
    }
    case "bell.dismiss": {
      // A line a person took off the bell (server only): `key` says which (a failed routine, a question, a thread
      // that ended asking, news), `failed` when what they dismissed happened, so a later one is on it again. Their
      // newest 200.
      if (!op.user || !op.key) break;
      const mine = ((state.bell_dismissed ||= {})[op.user] ||= {});
      delete mine[op.key];
      mine[op.key] = op.failed || "";
      for (const k of Object.keys(mine).slice(0, -200)) delete mine[k];
      break;
    }
    case "feed.archive": {
      // A page's update a person archived off their feed (server only): `moved` is when the page last moved up the
      // feed, so its next change is news again and shows. `on: false` brings it back. Their newest 200.
      if (!op.user || !op.page) break;
      const mine = ((state.feed_archived ||= {})[op.user] ||= {});
      delete mine[op.page];
      if (op.on !== false) mine[op.page] = op.moved || "";
      for (const k of Object.keys(mine).slice(0, -200)) delete mine[k];
      break;
    }
    case "routine.thread": {
      // A thread started on a routine from its page (server only, routine-threads.ts): `key` says which routine,
      // `lid` the launch it went out as. Its newest 20.
      if (!op.key || !op.lid) break;
      const list = ((state.routine_threads ||= {})[op.key] ||= []);
      if (list.some((x) => x.lid === op.lid)) break;
      list.push({ lid: op.lid, agent: op.agent || null, at: now, ...(op.user ? { user: op.user } : {}) });
      list.splice(0, Math.max(0, list.length - 20));
      break;
    }
    case "prefs.set": {
      // A person's settings on their profile (server only): Auto-archive (`auto_archive`, and since when it's on) and
      // Private terminals (`private_terminals`). Each is off until they turn it on.
      if (!op.user) break;
      const p = ((state.prefs ||= {})[op.user] ||= {});
      for (const k of ["auto_archive", "private_terminals"]) {
        if (typeof op[k] !== "boolean" || !!p[k] === op[k]) continue;
        p[k] = op[k];
        p[`${k}_at`] = now;
      }
      break;
    }
    case "machine.cloud": {
      // The cloud sandbox a machine runs in (server only): which connector of its owner's wakes it (boat's or
      // exe.dev's), and which sandbox. None: unlinked.
      if (!op.device) break;
      const all = (state.machine_cloud ||= {});
      // `github`: whether git on it signs in to GitHub as its owner, with their GitHub connector (on unless turned off).
      // `made`: agentbook made the sandbox, from an image of its owner's (`image`, at version `v`; `size`), with a
      // boat environment for its secrets (`env`, boat's id for it; `secrets`, their names, never their values).
      const made = op.made ? { made: true, image: op.image || null, v: op.v ?? null, size: op.size || null, env: op.env || null, env_name: op.env_name || null, secrets: Array.isArray(op.secrets) ? op.secrets.map(String) : [], ...(op.setting ? { setting: true } : {}) } : {};
      // `kind`: the provider it runs on ("exe"); none is boat.
      if (op.sandbox && op.connector) all[op.device] = { connector: String(op.connector), sandbox: String(op.sandbox), at: now, ...(op.kind && op.kind !== "boat" ? { kind: String(op.kind) } : {}), ...(op.github === false ? { github: false } : {}), ...made };
      else if (typeof op.github === "boolean" && all[op.device]) all[op.device] = { ...all[op.device], github: op.github };
      // What changed on one agentbook made: its image's version after an Update, its secrets' names, its setup done.
      else if (op.patch && all[op.device]) {
        const next = { ...all[op.device] };
        for (const k of ["v", "image", "secrets", "setting", "setup_error", "updating", "gone", "login"]) if (k in op.patch) next[k] = op.patch[k];
        for (const k of ["setting", "setup_error", "updating", "gone", "login"]) if (next[k] == null || next[k] === false) delete next[k];
        all[op.device] = next;
      } else delete all[op.device];
      break;
    }
    case "box.member": {
      // Who's on a shared machine (server only). `box`: the machine
      // that's shared, its owner's (`owner`, an account id). `member`: an account id, `user` their username, with
      // `state`: "invited" (the owner added them, and their seat is made there once `seated`), then "joined" (they
      // logged their seat in: `device`, their own machine for it). `remove`: they left, or were taken off.
      if (!op.box || !op.member) break;
      const all = (state.boxes ||= {});
      const b = (all[op.box] ||= { id: op.box, owner: op.owner || null, members: {} });
      if (op.remove) {
        delete b.members[op.member];
        if (!Object.keys(b.members).length) delete all[op.box];
        break;
      }
      const was = b.members[op.member];
      b.members[op.member] = { user: String(op.user || was?.user || ""), state: op.state === "joined" ? "joined" : "invited", seated: op.seated ?? was?.seated ?? false, device: op.device ?? was?.device ?? null, at: was?.at || now, ...(op.state === "joined" ? { joined: was?.joined || now } : {}) };
      break;
    }
    case "box.remove": {
      // The machine is no longer shared (it was deleted or disconnected): nobody's on it.
      if (op.box && state.boxes) delete state.boxes[op.box];
      break;
    }
    case "image.save": {
      // An image (server only): what a cloud machine of its owner's starts with, as a
      // draft they edit. `def`: its picks, repos, steps and settings, with secrets as names only. Building it makes
      // a version (image.build).
      if (!op.image || !op.owner) break;
      const all = (state.images ||= {});
      const was = all[op.image];
      if (was && was.owner !== op.owner) break;
      all[op.image] = { id: op.image, owner: op.owner, connector: op.connector || was?.connector || null, name: String(op.name || was?.name || op.image).slice(0, 60), def: op.def || was?.def || ({} as ImageDef), v: was?.v || 0, created: was?.created || now, updated: now };
      break;
    }
    case "image.remove": {
      if (!op.image || !state.images?.[op.image]) break;
      delete state.images[op.image];
      for (const [id, b] of Object.entries(state.image_builds || {})) if (b.image === op.image) delete state.image_builds[id];
      break;
    }
    case "image.build": {
      // A build: one version of an image being made into a disk (a boat saved snapshot), on a builder sandbox.
      // It keeps the definition it was built from, and what the builder said.
      const img = state.images?.[op.image];
      if (!op.build || !img) break;
      (state.image_builds ||= {})[op.build] = { id: op.build, image: op.image, v: op.v, owner: img.owner, connector: op.connector || img.connector, def: op.def || img.def, cli: op.cli || null, snapshot: op.snapshot || null, sandbox: op.sandbox || null, state: "building", started: now, ended: null, error: null, log: "" };
      img.v = Math.max(img.v || 0, op.v || 0);
      break;
    }
    case "image.built": {
      // How a build is going, or ended: `patch` over its record (state: building, saving, ready, failed, gone).
      const b = state.image_builds?.[op.build];
      if (!b || !op.patch) break;
      for (const k of ["state", "sandbox", "error", "log", "ended", "step"]) if (k in op.patch) b[k] = op.patch[k];
      if (["ready", "failed"].includes(op.patch.state) && !b.ended) b.ended = now;
      break;
    }
    case "auto.archived": {
      // Threads Auto-archive archived once their work merged or landed (server only), each once: one brought back
      // stays. `skipped`: the ones done already when it was turned on, which it leaves as they are.
      if (!op.user || !Array.isArray(op.posts)) break;
      const all = (state.auto_archived ||= {});
      for (const x of op.posts) if (x?.post && !all[x.post]) all[x.post] = { user: op.user, at: now, why: x.why || null, title: x.title || null, ...(op.skipped ? { skipped: true } : {}) };
      break;
    }
    case "news.add": {
      // News for a person's bell (server only, server/news.ts): what a thread of theirs did that's worth hearing
      // about, { kind: "turn" | "pr" | "flag", post, text, … }. `key` says what it's about: said once, however many
      // threads say it (a pull request's line again an hour later is news again: its checks failed a second time).
      // Their newest 50.
      if (!op.user || !Array.isArray(op.items)) break;
      const list = ((state.news ||= {})[op.user] ||= []);
      const same = (x, y) => y.key === x.key && (x.kind !== "pr" || Date.parse(now) - Date.parse(y.at) < 3600e3);
      for (const x of op.items) {
        if (!x?.post || !["turn", "pr", "flag"].includes(x.kind) || (x.key && list.some((y) => same(x, y)))) continue;
        list.push({ ...x, text: String(x.text || ""), at: now });
      }
      list.splice(0, Math.max(0, list.length - 50));
      break;
    }
    case "private.off": {
      // Private terminals (server only): the threads of a person's that were on agentbook when they turned it on,
      // and weren't started in agentbook, are off every list while it's on (`posts`, the page's ids); `clear`:
      // turned off, they're back.
      if (!op.user) break;
      const all = (state.private_off ||= {});
      if (op.clear) for (const k of Object.keys(all)) if (all[k] === op.user) delete all[k];
      for (const id of Array.isArray(op.posts) ? op.posts : []) if (typeof id === "string") all[id] = op.user;
      break;
    }
  }
}
