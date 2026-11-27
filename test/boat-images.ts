#!/usr/bin/env node
// Images for cloud machines, and their builds (server/images.ts): an image
// is a draft its owner edits, with picks from agentbook's catalog; Build makes it a version on a builder sandbox, as a
// boat saved snapshot. Against a stand-in boat (test/fake-boat.ts), which runs no script: it says how the script
// ended and what its log held. The script's own scaffolding is run here, with harmless parts.
// Run: node test/boat-images.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startBoat } from "./fake-boat.ts";
import { makePasskey, signPayload } from "./fake-passkey.ts";
import { spawnAgentbook, testPort } from "./harness.ts";
import { normalDef, scriptFor, scriptOf, stepsOf } from "../server/image-script.ts";
import type { Json } from "./harness-types.ts";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-boati-"));
const HUB_PORT = testPort(7400);
const HUB = `http://127.0.0.1:${HUB_PORT}`;

let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 8000): Promise<T> => {
  for (const end = Date.now() + ms; ; await sleep(120)) {
    const v = await fn();
    if (v || Date.now() > end) return v;
  }
};

const boat = await startBoat();
const env = { ...process.env, AGENTBOOK_CODEX: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_TERMINAL: "0", CLAUDE_CONFIG_DIR: path.join(BASE, "claude"), AGENTBOOK_PORT: String(HUB_PORT), AGENTBOOK_HOME: path.join(BASE, "hub"), AGENTBOOK_MACHINE: "hub", AGENTBOOK_BOAT_API_URL: boat.url, AGENTBOOK_CLOUD_ANYWHERE: "1", AGENTBOOK_IMAGE_POLL_MS: "150" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_HUB_TOKEN", "AGENTBOOK_TOKEN", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL", "CLAUDE_JOB_DIR"]) delete env[k];

let COOKIE = "";
const raw = (p: string, opts: RequestInit & { headers?: Record<string, string> } = {}) => fetch(HUB + p, { ...opts, headers: { ...(opts.headers || {}), ...(COOKIE ? { cookie: COOKIE } : {}) } });
const get = async (p: string) => {
  const r = await raw(p);
  return { status: r.status, ...((await r.json().catch(() => ({}))) as Json) };
};
const post = async (p, body = {}, headers = {}) => {
  const r = await raw(p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, ...((await r.json().catch(() => ({}))) as Json) };
};
const image = async (id) => (await get("/api/images")).images?.find((i) => i.id === id);
const asked = (method: string, re: RegExp) => boat.calls.filter((c) => c.method === method && re.test(c.path));
const LOG = (parts, end = "ok") => `${parts.map(([l, s, out = ""]) => `::step ${l}\n${out}${out ? "\n" : ""}${s === "ok" ? "::ok 3" : `::failed ${l}`}`).join("\n")}\n::end ${end} 12\n`;

// ---------- the script, by itself ----------
{
  const { def, errors } = normalDef({ size: "large", agents: ["codex", "nope"], picks: ["redis", "postgres@17", "node", "java@9", "ghost"], apt: "imagemagick bad;name", npm: ["turbo"], repos: [{ repo: "acme/platform", install: "npm ci" }, { repo: "https://github.com/acme/ledger.git", branch: "main" }, { repo: "../etc" }], steps: "createdb shop_dev 2>/dev/null || true\n", env: { NODE_ENV: "development", BOAT_ID: "1" }, secrets: ["OPENAI_API_KEY", "NODE_ENV"] });
  check(JSON.stringify(def.picks) === JSON.stringify(["node@22", "postgres@17", "redis"]) && def.agents.join() === "claude-code,codex", "a definition keeps picks from the catalog, in its order, each at a version it has, and Claude Code always");
  check(errors.length === 6 && errors.some((e) => /java@9/.test(e)) && errors.some((e) => /bad;name/.test(e)) && errors.some((e) => /BOAT_ID/.test(e)) && errors.some((e) => /NODE_ENV can't be a secret/.test(e)), `and says what it dropped (${errors.length})`);
  check(def.repos.length === 2 && def.repos[1].repo === "acme/ledger" && def.secrets.join() === "OPENAI_API_KEY" && def.size === "large", "repos are GitHub's owner/name, secrets are names");
  const script = scriptFor(def, { version: "0.3.40", bundle: "https://hub.example/api/cli/bundle?t=T", git: "https://hub.example/api/cli/git?t=T", title: "shop v1" });
  const file = path.join(BASE, "full.sh");
  fs.writeFileSync(file, script);
  check(spawnSync("bash", ["-n", file]).status === 0, "the script agentbook writes is bash that parses");
  const order = ["agentbook 0.3.40", "Node.js 22", "PostgreSQL 17", "Redis", "apt: imagemagick", "npm -g: turbo", "settings", "acme/platform: npm ci", "acme/ledger", "your steps", "checks"].map((l) => script.indexOf(`step '${l}'`));
  check(order.every((n, i) => n > 0 && (i === 0 || n > order[i - 1])), "agentbook first, then the picks, the lists, the settings, the repos, your steps, and the checks last");
  // agentbook-cli's own Node, whatever the shells' default: Node 20 has no node:sqlite, which it needs.
  const old = scriptFor(normalDef({ picks: ["node@20"] }).def, { bundle: "x" });
  check(/sudo install -m 0755 "\$NODE_BIN" \/usr\/lib\/agentbook\.new\/node/.test(old) && old.indexOf("nvm install 24") > 0 && old.indexOf("nvm install 24") < old.indexOf("nvm alias default 20") && /"\$NODE_BIN" -e 'require\("node:sqlite"\)'/.test(old) && /\/usr\/lib\/agentbook\/node -e 'require\("node:sqlite"\)'/.test(old), "agentbook-cli runs on a Node of its own that has what it needs, checked as it's installed, so Node 20 as every shell's default doesn't stop it");
  // A machine from it can be shared, so nothing of the image is one person's: the code is in /work, a group's, and
  // every seat's PATH reaches the tools, which stay in the sandbox's own user's home.
  check(/sudo chown root:agentbook-work \/work\nsudo chmod 2775 \/work/.test(script) && /AGENTBOOK_CLONE_DIR=\/work/.test(script) && /D='\/work\/platform'/.test(script) && /clone -c core\.sharedRepository=group/.test(script) && /sudo chgrp -R agentbook-work "\$D"/.test(script) && !/\$HOME\/'?platform/.test(script), "its repos are cloned into /work, which a group owns and everyone on a machine from it can change");
  check(script.indexOf("step 'tools for everyone on it'") > script.indexOf("step 'your steps'") && /sudo tee \/etc\/agentbook\/tools\.path/.test(script) && /chmod o\+x "\$HOME"/.test(script), "where its tools are is written down by root, after everything's installed, for every seat's PATH");
  check(!/seat claim/.test(script) && !/agentbook-cli\.service/.test(script), "a build makes nobody's seat, and nothing there runs agentbook-cli");
  check(!/OPENAI_API_KEY/.test(script) && /AGENTBOOK_OPENCLAW=0/.test(script) && /AGENTBOOK_CODEX=1/.test(script), "no secret is in it, and only the agents picked are turned on");
  // Its scaffolding, run for real: each part in a shell of its own, the script stopping at the first that fails.
  const run = (parts) => {
    const home = fs.mkdtempSync(path.join(BASE, "home-"));
    const f = path.join(home, "s.sh");
    fs.writeFileSync(f, scriptOf(parts, { restart: false }));
    const r = spawnSync("bash", [f], { env: { PATH: process.env.PATH, HOME: home } });
    return { status: r.status, ...stepsOf(fs.readFileSync(path.join(home, ".agentbook-build.log"), "utf8")) };
  };
  const good = run([["one", "echo hello"], ["two", "true"]]);
  check(good.status === 0 && good.ended === "ok" && good.steps.map((s) => `${s.label}:${s.state}`).join() === "one:ok,two:ok" && good.steps[0].out === "hello", "run, its log says each part and how it went");
  const bad = run([["one", "true"], ["two", "echo before\nfalse\necho after"], ["three", "echo never"]]);
  check(bad.status === 1 && bad.ended === "failed" && bad.steps.map((s) => `${s.label}:${s.state}`).join() === "one:ok,two:failed" && bad.steps[1].out === "before", "a failing line stops its part and the script: nothing after it runs");
  const slip = scriptFor(normalDef({ steps: "echo 'an open quote\n" }).def, { bundle: "x" });
  fs.writeFileSync(file, slip);
  check(spawnSync("bash", ["-n", file]).status === 0, "a slip in your own steps doesn't break the script around them");
}

const hub = spawnAgentbook({ env, stdio: ["ignore", "ignore", process.env.DEBUG ? "inherit" : "ignore"] });
try {
  check(await until(async () => (await fetch(HUB + "/api/health").catch(() => null))?.ok, 10000), "a server starts");
  const setup = await fetch(HUB + "/api/auth/test-person", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "herval" }) });
  COOKIE = (setup.headers.get("set-cookie") || "").split(";")[0];

  // ---------- an image ----------
  const none = await get("/api/images");
  check(none.status === 200 && none.images.length === 0 && none.catalog.some((c) => c.id === "postgres" && c.versions.includes("17")) && none.catalog.every((c) => !("install" in c)) && /^\d+\.\d+/.test(none.cli || "") && !none.unreachable, `no images yet; the catalog to pick from, and the agentbook-cli this server hands out (${none.cli})`);
  const early = await post("/api/images", { name: "Shop", def: {} });
  check(early.status === 400 && /boat connector/.test(early.error || ""), "an image needs a boat connector to be built with");
  await post("/api/connectors", { kind: "boat", api_key: boat.key });
  const made = await post("/api/images", { name: "Shop", connector: "boat", def: { picks: ["redis", "nope"], repos: [{ repo: "acme/platform" }], secrets: ["OPENAI_API_KEY"] } });
  check(made.status === 200 && made.image?.id === "shop" && made.image.def.picks.join() === "redis" && made.errors?.length === 1 && made.image.built === null && made.image.v === 0, "an image is made as a draft, saying what it couldn't keep");
  check((await post("/api/images", { name: "shop", connector: "boat" })).status === 409, "two of yours can't have one name");

  // ---------- building it ----------
  boat.set({ setup: { status: "done", log: LOG([["agentbook 0.3.40", "ok"], ["Redis", "ok"], ["acme/platform", "ok", "added 212 packages"], ["checks", "ok"]]) } });
  const b1 = await post("/api/images/shop/build");
  check(b1.status === 200 && b1.image?.building === 1 && b1.image.builds[0].state === "building", "Build starts version 1");
  const create = asked("POST", /^\/sandboxes$/).at(-1);
  check(create?.body?.noEnv === true && create.body.monitoring === false && create.body.ttlSeconds === 3600 && create.body.type === "default" && create.body.labels?.["agentbook/build"] === "shop-v1" && !!create.headers.idempotency, "on a builder with none of your account's secrets, monitoring off, an hour to live, and an idempotency key");
  const script = create?.body?.setupScript || "";
  const bundleUrl = script.match(/curl -fsSL --retry 3 '([^']+)'/)?.[1];
  check(script.includes("step 'Redis'") && bundleUrl?.startsWith(`${HUB}/api/cli/bundle?t=`) && /AGENTBOOK_GIT='[^']+\/api\/cli\/git\?t=/.test(script), "whose setup script is the one agentbook wrote, with a ticket to download agentbook-cli");
  const dl = await fetch(bundleUrl);
  const bytes = Buffer.from(await dl.arrayBuffer());
  check(dl.status === 200 && bytes[0] === 0x1f && bytes[1] === 0x8b && bytes.length > 100000, `the ticket downloads agentbook-cli and the plugin from this server (${bytes.length} bytes, gzip)`);
  const listed = spawnSync("tar", ["-tzf", "-"], { input: bytes, encoding: "utf8" }).stdout || "";
  check(/^plugin\/cli\/main\.mjs$/m.test(listed) && /^\.claude-plugin\/marketplace\.json$/m.test(listed) && /^bin\/agentbook-cli$/m.test(listed) && !/^server\//m.test(listed), "which holds the plugin and agentbook-cli, and nothing of the server");
  check((await fetch(`${HUB}/api/cli/bundle?t=nope`)).status === 404 && (await fetch(`${HUB}/api/cli/bundle`)).status === 404, "and nothing without a ticket");
  const gitUrl = script.match(/AGENTBOOK_GIT='([^']+)'/)?.[1];
  check((await fetch(gitUrl)).status === 404, "with no GitHub connector, the build's git has no sign-in to ask for");
  const built = await until(async () => {
    const i = await image("shop");
    return i?.built ? i : null;
  }, 10000);
  check(built?.built.v === 1 && built.built.snapshot === "agentbook-shop-v1" && built.builds[0].state === "ready" && built.building === null, "once its script is done, its disk is saved as agentbook-shop-v1");
  const builder = asked("POST", /^\/saved-snapshots$/).at(-1)?.body?.sandboxId;
  check(boat.snapshots.get("agentbook-shop-v1")?.status === "ready" && /^bx_/.test(builder || ""), "on boat, from the builder");
  check(!boat.sandboxes.has(builder) && asked("DELETE", /^\/sandboxes\//).at(-1)?.headers.confirm === builder, "and the builder is deleted");
  check(built.builds[0].steps.map((s) => s.label).join() === "agentbook 0.3.40,Redis,acme/platform,checks" && built.builds[0].outcome === "ok" && !Number.isNaN(Date.parse(built.builds[0].ended)) && built.builds[0].steps[2].out === "added 212 packages", "its page has the build's parts, read from the script's log");
  check(((await get("/api/images/shop/builds/1/log")).log || "").includes("::step Redis") && (await get("/api/images/shop/builds/9/log")).status === 404, "and the whole log");
  check((await fetch(bundleUrl)).status === 404, "the ticket works no more once the build ends");
  check(built.changes.length === 0, "nothing changed since: there's nothing to build");

  // ---------- a draft, and a build that fails ----------
  const draft = await post("/api/images", { id: "shop", def: { ...built.def, picks: ["redis", "postgres@17"], steps: "createdb shop_dev || true\n" } });
  check(draft.image?.changes.join("; ") === "PostgreSQL 17 added; your steps changed" && draft.image.built.v === 1, `editing makes a draft, and says what changed since version 1 (${draft.image?.changes.join("; ")})`);
  boat.set({ setup: { status: "failed", error: "exit 1", log: LOG([["agentbook 0.3.40", "ok"], ["PostgreSQL 17", "failed", "E: Unable to locate package postgresql-17"]], "failed") } });
  const b2 = await post("/api/images/shop/build");
  const twice = await post("/api/images/shop/build");
  check(b2.status === 200 && twice.status === 409 && /being built/.test(twice.error || ""), "one build at a time");
  const failed = await until(async () => {
    const i = await image("shop");
    return i?.builds[0]?.state === "failed" ? i : null;
  }, 10000);
  check(failed?.builds[0].v === 2 && /^Stopped at PostgreSQL 17: E: Unable to locate package postgresql-17/.test(failed.builds[0].error || ""), `a build that fails says where it stopped (${failed?.builds[0].error})`);
  check(failed.built.v === 1 && !boat.snapshots.has("agentbook-shop-v2") && [...boat.sandboxes.values()].every((s) => !s.made) && failed.tried === 2, "nothing was saved, its builder is deleted, and version 1 is still the newest");

  // ---------- two built versions stay ----------
  boat.set({ setup: { status: "done", log: LOG([["agentbook 0.3.40", "ok"]]) } });
  for (const v of [3, 4]) {
    await post("/api/images", { id: "shop", def: { ...built.def, apt: [`pkg${v}`] } });
    await post("/api/images/shop/build");
    await until(async () => (await image("shop"))?.built?.v === v, 10000);
  }
  const kept = await image("shop");
  check(kept.built.v === 4 && [...boat.snapshots.keys()].sort().join() === "agentbook-shop-v3,agentbook-shop-v4", `the newest two stay on boat, and the one before them is deleted there (${[...boat.snapshots.keys()].sort()})`);
  check(kept.builds.find((b) => b.v === 1)?.state === "gone" && kept.builds.find((b) => b.v === 2)?.state === "failed" && kept.builds.find((b) => b.v === 3)?.state === "ready", "its page still has each build");

  // ---------- boat says no ----------
  boat.set({ refuse: { status: 402, code: "billing_required", message: "Billing required" } });
  await post("/api/images", { id: "shop", def: { ...built.def, apt: ["pkg5"] } });
  const broke = await post("/api/images/shop/build");
  check(broke.status === 409 && /wallet is empty/.test(broke.error || "") && (await image("shop")).v === 4, `when boat won't start a builder, Build says why and makes no version (${broke.error})`);
  boat.set({ refuse: null });

  // ---------- with a passkey, a build is confirmed with it ----------
  // The page's own address signs: a request from another origin is turned away before anything's looked at.
  const origin = HUB;
  const key = makePasskey(-7, "phone");
  const o = await post("/api/passkeys/options");
  const added = await post("/api/passkeys", { id: key.record.id, alg: key.record.alg, spki: key.record.spki, name: "phone", clientDataJSON: Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: o.challenge, origin: `http://localhost:${HUB_PORT}` })).toString("base64url") });
  check(added.status === 200, "you make a passkey");
  const bare = await post("/api/images/shop/build", {}, { origin });
  check(bare.status === 428 && bare.sign?.kind === "image.build" && bare.sign.image === "shop" && bare.sign.user === "herval" && bare.keys?.[0] === key.record.id, "now Build answers with what to sign, and the passkeys that may");
  const sign = (e) => ({ envelope: e, sig: signPayload(key, e, { origin, rpId: "127.0.0.1" }) });
  const other = await post("/api/images/shop/build", { signed: sign({ v: 1, kind: "image.build", user: "herval", image: "other", at: new Date().toISOString() }) }, { origin });
  check(other.status === 403 && /isn't this/.test(other.error || ""), "a signature for another image doesn't do");
  const old = await post("/api/images/shop/build", { signed: sign({ v: 1, kind: "image.build", user: "herval", image: "shop", at: new Date(Date.now() - 3600e3).toISOString() }) }, { origin });
  check(old.status === 403 && /too old/.test(old.error || ""), "nor an old one");
  const good = sign(bare.sign);
  const signedBuild = await post("/api/images/shop/build", { signed: good }, { origin });
  check(signedBuild.status === 200 && signedBuild.image?.building === 5, "signed for this image, just now, it builds");
  await until(async () => (await image("shop"))?.built?.v === 5, 10000);
  const again = await post("/api/images/shop/build", { signed: good }, { origin });
  check(again.status === 403 && /used already/.test(again.error || ""), "and the same signature doesn't build twice");

  // ---------- deleting it ----------
  const toDelete = await post("/api/images/shop/delete", {}, { origin });
  const del = await post("/api/images/shop/delete", { signed: sign(toDelete.sign) }, { origin });
  check(del.status === 200 && boat.snapshots.size === 0 && (await get("/api/images")).images.length === 0, "deleting an image deletes its saved snapshots from boat");
} catch (e) {
  failures++;
  console.error(e);
} finally {
  hub.kill();
  await boat.close();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
console.log(`(test data in ${BASE})`);
process.exit(failures ? 1 : 0);
