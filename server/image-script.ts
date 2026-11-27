// An image for cloud machines: what its owner defines, and the script
// agentbook writes from it. The script runs on a boat sandbox as `user` (sudo needs no password): on a builder, whose
// disk is then saved as the image's version; on a new machine, when its image's version isn't built; and again on a
// machine made from an older version (Update). So every part of it is safe to run twice.
//
// It installs in a fixed order: agentbook first (agentbook-cli and the plugin, downloaded from this server, and a
// Node of their own, where only root can change them), then, on a machine, its owner's seat, then the picks in the
// catalog's order, the lists (apt, npm, uv), the settings, the repos, the owner's own steps, where the tools are for
// everyone on it, and last every pick's check. Its output goes to ~/.agentbook-build.log, with a line per part
// ("::step", "::ok", "::failed") that stepsOf reads back.
//
// Nobody's agentbook-cli runs as `user`. A machine's owner gets a seat there (plugin/cli/seats.ts): a Linux user
// of their own with no sudo, whose agentbook-cli runs from the machine's first start, so the machine can be shared
// with others, each in a seat like it, without moving anything. The code is in /work, which every seat can change;
// the image's tools stay where they install, in `user`'s home, and every seat's PATH reaches them. `user` is then
// the machine's own account: the script runs as it, and nothing of anyone's work does.

import { CATALOG, SIZES, itemOf, pickOf, pickText } from "./integrations/connectors/boat-catalog.ts";
import type { ImageDef } from "../plugin/shared/types.ts";

// A definition as the page sends it, or as it was kept: any of its fields, of any kind, for normalDef to check.
export type DefInput = { [K in keyof ImageDef]?: unknown };
type Repo = ImageDef["repos"][number];
// An item of the catalog, and one picked at a version (boat-catalog.ts's pickOf).
type Item = (typeof CATALOG)[number];
type Picked = { item: Item; v?: string | null };
// The seat a machine's script makes for its owner (scriptFor's `seat`).
export interface Seat {
  owner: string;
  machine: string;
}
// A part of a build's log, as stepsOf reads it back.
export interface LogStep {
  label: string;
  state: "ok" | "failed" | "running";
  seconds: number | null;
  out: string;
}
export interface LogParts {
  steps: LogStep[];
  ended: "ok" | "failed" | null;
  seconds: number | null;
}

export const LOG_PATH = ".agentbook-build.log";
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
// boat's own names for a sandbox, which it refuses as settings.
const RESERVED = new Set(["ASCII_TOKEN", "ASCII_API_URL", "AGENT_ID", "PRODUCT_MODE", "ENVIRONMENT_ID", "BOAT_ID", "SERVICE_PREVIEW_TOKEN", "BOAT_CLI_TOKEN"]);
const words = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,]+/) : []).map((x) => String(x).trim()).filter(Boolean);
const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];
const SIZE_NAMES: Record<string, string> = SIZES;
const AGENTS = CATALOG.filter((c) => c.kind === "agent").map((c) => c.id);

// A definition as it's kept, with what's left out filled in and what can't be used dropped. `errors`: what was
// dropped and why, for the page.
export function normalDef(d: DefInput = {}): { def: ImageDef; errors: string[] } {
  const errors: string[] = [];
  const bad = (what: string): false => (errors.push(what), false);
  const picks: string[] = [];
  for (const p of words(d.picks)) {
    const k = pickOf(p);
    if (!k) bad(`agentbook's list has no ${p}.`);
    else if (!picks.some((x) => x.split("@")[0] === k.item.id)) picks.push(pickText(k));
  }
  const repos: Repo[] = [];
  const given: { repo?: unknown; branch?: unknown; install?: unknown }[] = Array.isArray(d.repos) ? d.repos.slice(0, 12) : [];
  for (const r of given) {
    const repo = String(r?.repo || "").trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.includes("..")) {
      if (repo) bad(`${repo} isn't a GitHub repo like acme/platform.`);
      continue;
    }
    const branch = String(r.branch || "").trim();
    if (!repos.some((x) => x.repo.toLowerCase() === repo.toLowerCase())) repos.push({ repo, ...(branch && /^[\w./-]{1,100}$/.test(branch) && !branch.includes("..") ? { branch } : {}), ...(String(r.install || "").trim() ? { install: String(r.install).replace(/[\r\n]+/g, " ").trim().slice(0, 500) } : {}) });
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(d.env && typeof d.env === "object" && !Array.isArray(d.env) ? d.env : {}).slice(0, 50)) {
    if (!NAME.test(k) || RESERVED.has(k)) bad(`${k} can't be a setting's name.`);
    else env[k] = String(v ?? "").replace(/[\r\n]+/g, " ").slice(0, 2000);
  }
  const secrets = uniq(words(d.secrets)).filter((k) => (NAME.test(k) && !RESERVED.has(k) && !(k in env) ? true : bad(`${k} can't be a secret's name${k in env ? ": it's a setting already" : ""}.`))).slice(0, 50);
  return {
    def: {
      size: typeof d.size === "string" && SIZE_NAMES[d.size] ? d.size : "default",
      agents: uniq(["claude-code", ...words(d.agents).filter((a) => AGENTS.includes(a))]),
      picks: CATALOG.map((c) => picks.find((p) => p.split("@")[0] === c.id)).filter(Boolean),
      apt: uniq(words(d.apt)).filter((p) => (/^[a-z0-9][a-z0-9+._:-]{0,80}$/.test(p) ? true : bad(`${p} isn't an apt package's name.`))).slice(0, 60),
      npm: uniq(words(d.npm)).filter((p) => (/^(@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*(@[\w.^~-]{1,40})?$/.test(p) ? true : bad(`${p} isn't an npm package's name.`))).slice(0, 40),
      uv: uniq(words(d.uv)).filter((p) => (/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(p) ? true : bad(`${p} isn't a Python tool's name.`))).slice(0, 40),
      repos,
      steps: String(d.steps || "").replace(/\r\n?/g, "\n").slice(0, 20000),
      env,
      secrets,
      // How Claude Code signs in on a machine from it: the machine's Sign in card, or a setup-token secret.
      claude: d.claude === "token" ? "token" : "signin",
    },
    errors,
  };
}

export const repoDir = (repo: string) => repo.split("/").pop();
export const repoPath = (repo: string) => `${WORK}/${repoDir(repo)}`;

// What changed between two definitions, in words, for "Since v3: Redis added, your steps changed."
export function changesOf(was: ImageDef | null | undefined, now: ImageDef | null | undefined): string[] {
  const out: string[] = [];
  const label = (p: string) => {
    const k = pickOf(p);
    return k ? `${k.item.label}${k.v ? ` ${k.v}` : ""}` : p;
  };
  const list = (key: "agents" | "picks" | "apt" | "npm" | "uv" | "secrets", name = (x: string) => x) => {
    const a = new Set(was?.[key] || []);
    const b = new Set(now?.[key] || []);
    for (const x of b) if (!a.has(x)) out.push(`${name(x)} added`);
    for (const x of a) if (!b.has(x)) out.push(`${name(x)} removed`);
  };
  list("agents", (a) => itemOf(a)?.label || a);
  list("picks", label);
  list("apt");
  list("npm");
  list("uv");
  list("secrets");
  const repos = (d: ImageDef | null | undefined) => (d?.repos || []).map((r) => `${r.repo}${r.branch ? `#${r.branch}` : ""} ${r.install || ""}`);
  const ra = new Set(repos(was));
  const rb = new Set(repos(now));
  if ([...rb].some((x) => !ra.has(x)) || [...ra].some((x) => !rb.has(x))) out.push("the repos changed");
  if ((was?.steps || "") !== (now?.steps || "")) out.push("your steps changed");
  if (JSON.stringify(was?.env || {}) !== JSON.stringify(now?.env || {})) out.push("the settings changed");
  if ((was?.size || "default") !== (now?.size || "default")) out.push(`the size is ${now?.size || "default"}`);
  if ((was?.claude || "signin") !== (now?.claude || "signin")) out.push("how Claude Code signs in changed");
  return out;
}

const q = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// One part of the script: it runs in a shell of its own that stops at its first failing line, and the script stops
// with it. (A subshell that's one side of `||` wouldn't stop at a failing line, so its status is looked at after.)
const part = (label: string, body: string) => `step ${q(label)}\n(\nset -eo pipefail\n${body.trim()}\n)\n[ $? -eq 0 ] || die\nok\n`;

// agentbook's code and its Node on a machine, root's (on boat, /opt and /usr/local are `user`'s), and the command
// that runs agentbook-cli as root there, for the parts that make seats.
const LIB = "/usr/lib/agentbook";
const AS_ROOT = `sudo ${LIB}/node ${LIB}/plugin/cli/main.mjs`;
// Where a machine's code lives, and the group that owns it (as plugin/cli/seats.ts has them).
const WORK = "/work";
const WORK_GROUP = "agentbook-work";

// The Node agentbook-cli itself runs on there, by nvm's name for it.
const AGENTBOOK_NODE = "24";

const DEPS = `if [ -f package-lock.json ]; then npm ci
elif [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile
elif [ -f yarn.lock ]; then yarn install --frozen-lockfile
elif [ -f bun.lock ] || [ -f bun.lockb ]; then bun install
elif [ -f uv.lock ]; then uv sync
elif [ -f Gemfile.lock ]; then bundle install
elif [ -f Cargo.lock ]; then cargo fetch
elif [ -f go.sum ]; then go mod download
fi`;

// The script for a definition. `version`: agentbook-cli's, as this server has it. `bundle`: where the script
// downloads agentbook-cli and the plugin from this server. `git`: where git asks who to be on GitHub while it runs
// (a builder has no login of its own), or none on a machine, whose own git signs in. `title`: "littleguys v3".
// The script around its parts ([label, body] each): where its output goes, and how a part starts, ends and fails.
// `restart`: at the end, every seat's settings are written again and its agentbook-cli starts again, with the new
// code and where the tools are now (an Update, or a machine that installed everything as it started).
export function scriptOf(parts: [string, string][], { git = null, title = "", restart = true }: { git?: string | null; title?: string; restart?: boolean } = {}): string {
  const out: string[] = [];
  out.push(`#!/bin/bash
# Written by agentbook${title ? ` for ${title}` : ""}. Every part is safe to run twice.
export DEBIAN_FRONTEND=noninteractive
export USER="\${USER:-$(id -un)}"
LOG="\${AGENTBOOK_BUILD_LOG:-$HOME/${LOG_PATH}}"
exec >"$LOG" 2>&1
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/go/bin:$PATH"
${git ? `export AGENTBOOK_GIT=${q(git)}` : "unset AGENTBOOK_GIT"}
T0=$(date +%s)
NOW=""
step() { NOW="$1"; S0=$(date +%s); echo "::step $1"; }
ok() { echo "::ok $(( $(date +%s) - S0 ))"; }
die() { echo "::failed $NOW"; echo "::end failed $(( $(date +%s) - T0 ))"; exit 1; }
`);
  for (const [label, body] of parts) out.push(part(label, body));
  out.push(`echo "::end ok $(( $(date +%s) - T0 ))"
${restart ? `# Every seat starts again with the new code and tools. Last, as it may be what runs this.
if [ -f /etc/agentbook/seats.json ]; then
  ${AS_ROOT} seat refresh || true
  sudo systemctl daemon-reload || true
  sudo systemctl try-restart 'agentbook-cli@*' agentbook-seats 2>/dev/null || true
fi
` : ""}exit 0
`);
  return out.join("\n");
}

export interface ScriptOptions {
  version?: string;
  bundle?: string;
  git?: string | null;
  title?: string;
  only?: string | string[] | null;
  restart?: boolean;
  seat?: Seat | null;
}
// `seat`: { owner, machine }, on a machine being made: its owner's seat (their agentbook username, the machine's
// name on agentbook), which logs in from the file the machine was made with. `only`: just these kinds of parts
// ("seat", "repos"), for a machine made from a built version, which has the rest. `restart`: as scriptOf.
export function scriptFor(def: ImageDef, { version = "", bundle, git = null, title = "", only = null, restart = true, seat = null }: ScriptOptions = {}): string {
  const on = (a: string) => def.agents.includes(a);
  const out: [string, string][] = [];
  const kinds = only == null ? null : ([] as string[]).concat(only);
  const add = (label: string, body: string, kind = "") => (!kinds || kinds.includes(kind)) && out.push([label, body]);
  add(
      `agentbook${version ? ` ${version}` : ""}`,
      `
sudo mkdir -p /etc/agentbook
curl -fsSL --retry 3 ${q(bundle)} -o /tmp/agentbook.tgz
sudo rm -rf ${LIB}.new
sudo mkdir -p ${LIB}.new
sudo tar -xzf /tmp/agentbook.tgz -C ${LIB}.new
rm -f /tmp/agentbook.tgz
# agentbook-cli runs on a Node of its own, new enough for it (it needs node:sqlite), whatever version the image picks
# as every shell's default: that one may be older, for the code people work on. A copy, beside the code, so that
# only root can change what every seat runs.
if [ -s "\${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  . "\${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  nvm install ${AGENTBOOK_NODE} >/dev/null
  NODE_BIN="$(nvm which ${AGENTBOOK_NODE})"
else
  NODE_BIN="$(command -v node)"
fi
"$NODE_BIN" -e 'require("node:sqlite")'
sudo install -m 0755 "$NODE_BIN" ${LIB}.new/node
sudo chown -R root:root ${LIB}.new
sudo rm -rf ${LIB}.old
if [ -d ${LIB} ]; then sudo mv ${LIB} ${LIB}.old; fi
sudo mv ${LIB}.new ${LIB}
${LIB}/node -e 'require("node:sqlite")'
sudo tee /etc/agentbook/cli.env >/dev/null <<'AGENTBOOK_EOF'
AGENTBOOK_SUPERVISED=1
AGENTBOOK_CODEX=${on("codex") ? "1" : "0"}
AGENTBOOK_OPENCLAW=${on("openclaw") ? "1" : "0"}
AGENTBOOK_HERMES=${on("hermes") ? "1" : "0"}
AGENTBOOK_CLONE_DIR=${WORK}
AGENTBOOK_WORK_DIR=${WORK}
AGENTBOOK_EOF
# The code everyone on the machine works in: a group's, which passes itself on to what's made there.
sudo groupadd --force ${WORK_GROUP}
sudo mkdir -p ${WORK}
sudo chown root:${WORK_GROUP} ${WORK}
sudo chmod 2775 ${WORK}
sudo usermod --append --groups ${WORK_GROUP} "$USER"
# The image's tools stay in this home (nvm's Node, uv, cargo). Every seat's PATH names them, so its folder can be
# passed through; what's in it keeps its own permissions.
chmod o+x "$HOME"
`,
    "agentbook",
  );
  // The machine's owner's seat, right after agentbook is there: its login lasts ten minutes from when the machine
  // was made, and the rest can take longer. It's shared once that seat has logged in.
  if (seat)
    add(
      `${seat.owner}'s seat`,
      `
${AS_ROOT} seat claim ${q(seat.owner)} --machine ${q(seat.machine)} --enroll "$HOME/.agentbook-enroll" --admin "$USER"
`,
      "seat",
    );
  for (const p of def.picks) {
    const k = pickOf(p);
    if (k?.item.install) add(`${k.item.label}${k.v ? ` ${k.v}` : ""}`, k.item.install(k.v));
  }
  if (def.apt.length) add(`apt: ${def.apt.join(" ")}`, `sudo apt-get update -q\nsudo apt-get install -y -q ${def.apt.map(q).join(" ")}`);
  if (def.npm.length) add(`npm -g: ${def.npm.join(" ")}`, `npm install -g ${def.npm.map(q).join(" ")}`);
  if (def.uv.length) add(`uv tools: ${def.uv.join(" ")}`, def.uv.map((t) => `uv tool install ${q(t)} || uv tool upgrade ${q(t)}`).join("\n"));
  // Settings: the same on every machine from it, in every shell and in what agentbook-cli starts.
  const env = Object.entries(def.env);
  add(
      "settings",
      `
sudo tee /etc/agentbook/image.env >/dev/null <<'AGENTBOOK_EOF'
${env.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("\n")}
AGENTBOOK_EOF
sudo tee /etc/profile.d/agentbook-image.sh >/dev/null <<'AGENTBOOK_EOF'
${env.map(([k, v]) => `export ${k}=${q(v)}`).join("\n")}
AGENTBOOK_EOF
`,
  );
  for (const r of def.repos) {
    const dir = repoDir(r.repo);
    add(
        `${r.repo}${r.install ? `: ${r.install}` : ""}`,
        `
umask 002
D=${q(`${WORK}/${dir}`)}
URL=${q(`https://github.com/${r.repo}.git`)}
if [ -d "$D/.git" ]; then
  git -C "$D" pull --ff-only || true
else
  sudo install -d -o "$USER" -g ${WORK_GROUP} -m 2775 "$D"
  if [ -n "$AGENTBOOK_GIT" ]; then
    git -c credential.helper= -c credential.helper='!f() { test "$1" = get && curl -fsS "$AGENTBOOK_GIT"; }; f' clone -c core.sharedRepository=group${r.branch ? ` --branch ${q(r.branch)}` : ""} "$URL" "$D"
  else
    git clone -c core.sharedRepository=group${r.branch ? ` --branch ${q(r.branch)}` : ""} "$URL" "$D"
  fi
fi
cd "$D"
${r.install || DEPS}
# Everyone on the machine can change it, whoever made each file.
sudo chgrp -R ${WORK_GROUP} "$D"
sudo chmod -R g+rwX "$D"
sudo find "$D" -type d -exec chmod g+s {} +
`,
      "repos",
    );
  }
  // Their own steps run from a file, so a slip in them (an open quote) fails that part and not the script around it.
  if (def.steps.trim())
    add(
        "your steps",
        `cat > /tmp/agentbook-steps.sh <<'AGENTBOOK_STEPS_EOF'\n${def.steps
          .split("\n")
          .filter((l) => l.trim() !== "AGENTBOOK_STEPS_EOF")
          .join("\n")}\nAGENTBOOK_STEPS_EOF\nbash -eo pipefail /tmp/agentbook-steps.sh\nrm -f /tmp/agentbook-steps.sh`,
    );
  // Where the tools are, as this user's own shells find them, for every seat's PATH: this home's folders first, as
  // here. Written by root, since what's in it runs as everyone on the machine.
  add(
    "tools for everyone on it",
    `
P="$(bash -lc 'printf %s "$PATH"' 2>/dev/null || printf %s "$PATH")"
if [ -s "\${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  . "\${NVM_DIR:-$HOME/.nvm}/nvm.sh" || true
  N="$(nvm which default 2>/dev/null || true)"
  if [ -n "$N" ] && [ -x "$N" ]; then P="$(dirname "$N"):$P"; fi
fi
P="$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/go/bin:$P"
OUT=""
IFS=:
for d in $P; do
  case "$d" in /*) ;; *) continue ;; esac
  [ -d "$d" ] || continue
  case ":$OUT:" in *":$d:"*) continue ;; esac
  OUT="\${OUT:+$OUT:}$d"
done
unset IFS
printf '%s\\n' "$OUT" | sudo tee /etc/agentbook/tools.path >/dev/null
sudo chmod 644 /etc/agentbook/tools.path
`,
  );
  const checks: Picked[] = [...def.agents.map((a) => itemOf(a)).filter((i) => i?.check).map((item) => ({ item })), ...def.picks.map((p) => pickOf(p)).filter((k) => k?.item.check)];
  if (checks.length)
    add(
        "checks",
        checks
          .map((c) => {
            const item = c.item;
            const label = `${item.label}${c.v ? ` ${c.v}` : ""}`;
            return `( ${item.check(c.v)} ) || { echo ${q(`${label} isn't there after its install.`)}; exit 1; }`;
          })
          .join("\n"),
    );
  return scriptOf(out, { git, title, restart: kinds ? false : restart });
}

// A build's log, as its parts: [{ label, state: "ok" | "failed" | "running", seconds, out }], and how it ended
// ({ ended: "ok" | "failed" | null, seconds }). `out`: what the part printed, its last lines.
export function stepsOf(log: string | null | undefined): LogParts {
  const steps: { label: string; state: LogStep["state"]; seconds: number | null; out: string[] }[] = [];
  let ended: LogParts["ended"] = null;
  let seconds: number | null = null;
  let cur: (typeof steps)[number] | null = null;
  for (const line of String(log || "").split("\n")) {
    let m;
    if ((m = /^::step (.*)$/.exec(line))) {
      cur = { label: m[1], state: "running", seconds: null, out: [] };
      steps.push(cur);
    } else if ((m = /^::ok (\d+)/.exec(line)) && cur) Object.assign(cur, { state: "ok", seconds: Number(m[1]) });
    else if (/^::failed /.test(line) && cur) cur.state = "failed";
    else if ((m = /^::end (ok|failed) (\d+)/.exec(line))) {
      ended = m[1] as LogParts["ended"];
      seconds = Number(m[2]);
    } else if (cur && line.trim()) cur.out.push(line);
  }
  return { steps: steps.map((s) => ({ label: s.label, state: s.state, seconds: s.seconds, out: s.out.slice(-(s.state === "failed" ? 40 : 3)).join("\n").slice(-4000) })), ended, seconds };
}
