// What makes an exe.dev VM a machine of yours: a script agentbook starts on it
// over ssh, once exe.dev has made it. It installs agentbook as INSTALL.md does on any machine (Node 22.18 or newer, a
// clone of agentbook's release repo, its packages), then logs the machine in to your account through the relay, as
// `agentbook login` does: that prints a code for you to say yes to on the relay's page, which agentbook reads from
// its log (loginOf) and shows on the machine's page. Once you say yes, systemd runs agentbook-cli there, then and
// after every restart, and the machine links to your others over iroh by itself (server/mesh.ts), so it never has to
// reach this server.
//
// Its log is the one an image's build writes (image-script.ts's scriptOf and stepsOf), in the VM's home. Every part
// is safe to run twice: Try again starts it over.

import { scriptOf } from "./image-script.ts";

export const SETUP_PATH = ".agentbook-setup.sh";
// Where agentbook's code goes on the VM, and where from: the release repo, as INSTALL.md clones it.
const DIR = "$HOME/agentbook";
export const RELEASE_REPO = () => process.env.AGENTBOOK_EXE_REPO || "https://github.com/herval/agentbook";
const NVM = "https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh";
// exe.dev's LLM gateway, which Claude Code there can use with no login of its own (exe.dev/docs/integrations-llm).
const GATEWAY = "https://llm.int.exe.xyz";
export const SIGN_IN_LABEL = "Sign in to your agentbook";

const q = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export interface ExeSetup {
  // The machine's name: the VM's, and the one it joins your account as.
  name: string;
  // owner/repo on GitHub, cloned into ~/dev to start in, when it can be without a login (a public one).
  repo?: string | null;
  // How Claude Code there signs in: as you, with its own login (the page's Sign in card), or through exe.dev's gateway.
  claude?: "signin" | "gateway";
}
export function exeScript({ name, repo = null, claude = "signin" }: ExeSetup): string {
  const parts: [string, string][] = [];
  parts.push([
    "Node",
    `
node_ok() { case "$(node -v 2>/dev/null)" in ""|v[0-9].*|v1[0-9].*|v2[01].*|v22.[0-9].*|v22.1[0-7].*|v23.[0-5].*) return 1 ;; esac; return 0; }
if ! node_ok; then
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] || curl -fsSL --retry 3 ${NVM} | PROFILE=/dev/null bash
  . "$NVM_DIR/nvm.sh"
  nvm install 24 >/dev/null
  mkdir -p "$HOME/.local/bin"
  ln -sf "$(nvm which 24)" "$HOME/.local/bin/node"
  ln -sf "$(dirname "$(nvm which 24)")/npm" "$HOME/.local/bin/npm"
fi
node -e 'require("node:sqlite")'
node -v`,
  ]);
  parts.push([
    "agentbook",
    `
if [ -d "${DIR}/.git" ]; then git -C "${DIR}" pull --ff-only; else git clone -c agentbook.install=clone ${q(RELEASE_REPO())} "${DIR}"; fi
cd "${DIR}"
npm install --no-audit --no-fund --loglevel=error`,
  ]);
  if (claude === "gateway")
    parts.push([
      "Claude Code through exe.dev",
      `
mkdir -p "$HOME/.claude"
node -e '
const fs = require("fs"), f = process.env.HOME + "/.claude/settings.json";
let s = {}; try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
s.apiKeyHelper = "printf exe-gateway";
s.env = { ...(s.env || {}), ANTHROPIC_BASE_URL: "${GATEWAY}" };
fs.writeFileSync(f, JSON.stringify(s, null, 2));
'`,
    ]);
  if (repo)
    parts.push([
      repo,
      `
mkdir -p "$HOME/dev"
name=${q(repo.split("/").pop())}
[ -d "$HOME/dev/$name/.git" ] || git clone ${q(`https://github.com/${repo}`)} "$HOME/dev/$name"`,
    ]);
  // Waits here until you say yes on the relay's page (ten minutes at most), printing the code to say yes to. Run again
  // on a machine that's signed in already, it only renews its certificate.
  parts.push([
    SIGN_IN_LABEL,
    `
cd "${DIR}"
./bin/agentbook login --name ${q(name)} --no-open --no-start`,
  ]);
  parts.push([
    "agentbook-cli, kept running",
    `
SUDO=""; [ "$(id -u)" = 0 ] || SUDO=sudo
$SUDO tee /etc/systemd/system/agentbook.service >/dev/null <<AGENTBOOK_EOF
# agentbook-cli on this exe.dev VM, written by agentbook as it made the machine.
[Unit]
Description=agentbook-cli: this machine's agents, on your agentbook
After=network-online.target
Wants=network-online.target

[Service]
User=$(id -un)
WorkingDirectory=$HOME
Environment=HOME=$HOME
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=AGENTBOOK_MACHINE=${name}
Environment=AGENTBOOK_SUPERVISED=1
ExecStart=$(command -v node) ${DIR}/plugin/cli/main.mjs run
Restart=always
RestartSec=3
KillMode=process

[Install]
WantedBy=multi-user.target
AGENTBOOK_EOF
$SUDO systemctl daemon-reload
$SUDO systemctl enable agentbook.service
$SUDO systemctl restart agentbook.service`,
  ]);
  return scriptOf(parts, { title: `${name}, on exe.dev`, restart: false });
}

// The code `agentbook login` printed in its log, while it waits for you to say yes: { code, url }, or null.
export function loginOf(log: string | null | undefined): { code: string; url: string } | null {
  const text = String(log || "");
  const at = text.lastIndexOf(`::step ${SIGN_IN_LABEL}`);
  if (at < 0) return null;
  const tail = text.slice(at);
  if (/^::(ok|failed)/m.test(tail.split("\n").slice(1).join("\n"))) return null;
  const code = /check it shows ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(tail)?.[1];
  const url = /(https:\/\/\S+\/link\?code=\S+)/.exec(tail)?.[1];
  return code && url ? { code, url } : null;
}
