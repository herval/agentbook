// What you can pick to install on a cloud machine's image. boat's base
// image is Ubuntu 24.04 with nearly every runtime on it already (Node 24, 22 and 20 through nvm, Python 3.12 and uv,
// Go, Rust, Java 11, Docker with Compose, Chrome, git, gh, ripgrep, jq), so this isn't a list of languages: it's
// what matters and isn't there, or isn't set up.
//
// Each item: { id, label, kind ("agent" | "version" | "service" | "tool"), about, versions? (the first is the usual
// one), install(v) and check(v): bash, run as `user` (sudo needs no password). An install is safe to run twice, since
// Update runs a newer version's script on a machine made from an older one. A service is a systemd unit that's
// enabled, so it's running again after every wake. agentbook adds to this list; people's own needs go in their steps.
//
// A pick is "id" or "id@version". None of the installs here has been run on a boat sandbox yet.

// An item of the catalog: its install and check scripts take its version (null for one that has none).
export interface CatalogItem {
  id: string;
  label: string;
  kind: "agent" | "version" | "service" | "tool";
  about: string;
  versions?: string[];
  always?: boolean;
  install?: (v: string | null) => string;
  check?: (v: string | null) => string;
}
// One picked, at a version (null for one without versions).
export interface Pick {
  item: CatalogItem;
  v: string | null;
}

const apt = (pkgs: string) => `sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q ${pkgs}`;
const ARCH = `"$(dpkg --print-architecture)"`;
// An apt repository of a vendor's, with its key: added once.
const repo = (name: string, keyUrl: string, line: string) => `if [ ! -f /etc/apt/sources.list.d/${name}.list ]; then
  curl -fsSL ${keyUrl} | sudo gpg --dearmor --yes -o /usr/share/keyrings/${name}.gpg
  echo "deb [arch=${ARCH.slice(1, -1)} signed-by=/usr/share/keyrings/${name}.gpg] ${line}" | sudo tee /etc/apt/sources.list.d/${name}.list >/dev/null
  sudo apt-get update -q
fi`;
const service = (unit: string) => `sudo systemctl enable ${unit}\nsudo systemctl start ${unit} || true`;

export const CATALOG: CatalogItem[] = [
  // Agents: installed on boat's image already. Picking one turns agentbook on for it; the rest stay off.
  { id: "claude-code", label: "Claude Code", kind: "agent", always: true, about: "Already on boat's image and kept up to date. agentbook follows its sessions and gives them the ab_* tools.", check: () => `bash -lc 'command -v claude' >/dev/null` },
  { id: "codex", label: "Codex", kind: "agent", about: "Already on boat's image. agentbook writes its MCP config, so Codex threads get the ab_* tools too.", check: () => `bash -lc 'command -v codex' >/dev/null` },
  { id: "openclaw", label: "OpenClaw", kind: "agent", about: "Installed on boat's image, and off unless you pick it: it needs a gateway paired to this machine." },
  { id: "hermes", label: "Hermes", kind: "agent", about: "Installed on boat's image, and off unless you pick it." },

  // Versions: the default in every shell.
  {
    id: "node",
    label: "Node.js",
    kind: "version",
    versions: ["22", "20", "24"],
    about: "The default in every shell. boat has 20, 22 and 24 through nvm, and 24 is its default.",
    install: (v) => `export NVM_DIR="\${NVM_DIR:-$HOME/.nvm}"\n. "$NVM_DIR/nvm.sh"\nnvm install ${v}\nnvm alias default ${v}`,
    check: (v) => `bash -lc 'node -v' | grep -q '^v${v}\\.'`,
  },
  {
    id: "python",
    label: "Python",
    kind: "version",
    versions: ["3.13", "3.11"],
    about: "The default python3, through uv. boat has 3.12.",
    install: (v) => `uv python install ${v}\nmkdir -p "$HOME/.local/bin"\nln -sf "$(uv python find ${v})" "$HOME/.local/bin/python3"\nln -sf "$HOME/.local/bin/python3" "$HOME/.local/bin/python"`,
    check: (v) => `"$HOME/.local/bin/python3" --version | grep -q 'Python ${v.replace(".", "\\.")}\\.'`,
  },
  {
    id: "java",
    label: "Java",
    kind: "version",
    versions: ["21", "17"],
    about: "boat has only 11.",
    install: (v) => `${apt(`openjdk-${v}-jdk-headless`)}\nsudo update-alternatives --set java "$(update-alternatives --list java | grep -- '-${v}-' | head -1)"`,
    check: (v) => `java -version 2>&1 | grep -q '"${v}\\.'`,
  },
  {
    id: "go",
    label: "Go",
    kind: "version",
    versions: ["1.25", "1.24"],
    about: "The newest patch of that version, from go.dev, in /usr/local/go. boat has 1.23.",
    install: (v) => `GOV="$(curl -fsSL 'https://go.dev/dl/?mode=json&include=all' | jq -r '[.[] | select(.stable and (.version | startswith("go${v}.") or . == "go${v}"))][0].version')"
[ -n "$GOV" ] && [ "$GOV" != null ]
if [ "$(/usr/local/go/bin/go version 2>/dev/null | awk '{print $3}')" != "$GOV" ]; then
  curl -fsSL "https://go.dev/dl/$GOV.linux-${ARCH.slice(1, -1)}.tar.gz" -o /tmp/go.tgz
  sudo rm -rf /usr/local/go
  sudo tar -C /usr/local -xzf /tmp/go.tgz
  rm -f /tmp/go.tgz
fi
echo 'export PATH=/usr/local/go/bin:$PATH' | sudo tee /etc/profile.d/agentbook-go.sh >/dev/null`,
    check: (v) => `/usr/local/go/bin/go version | grep -q 'go${v.replace(".", "\\.")}'`,
  },

  // Services: systemd units, so they're running again after every wake.
  {
    id: "postgres",
    label: "PostgreSQL",
    kind: "service",
    versions: ["16", "17"],
    about: "Runs as a systemd service, so it's up again after every wake. The user account owns it, with no password.",
    install: (v) => `${apt("postgresql-common")}
if ! apt-cache show postgresql-${v} >/dev/null 2>&1; then sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y; fi
${apt(`postgresql-${v}`)}
${service("postgresql")}
for i in 1 2 3 4 5 6 7 8 9 10; do pg_isready -q && break; sleep 1; done
sudo -u postgres psql -tAc "select 1 from pg_roles where rolname = '$USER'" | grep -q 1 || sudo -u postgres createuser -s "$USER"`,
    check: (v) => `pg_isready -q && psql --version | grep -q ' ${v}\\.'`,
  },
  { id: "redis", label: "Redis", kind: "service", about: "On localhost:6379, up again after every wake.", install: () => `${apt("redis-server")}\n${service("redis-server")}`, check: () => `for i in 1 2 3 4 5; do redis-cli ping 2>/dev/null | grep -q PONG && exit 0; sleep 1; done; exit 1` },
  { id: "mysql", label: "MySQL", kind: "service", versions: ["8.0"], about: "Ubuntu's own, up again after every wake. root signs in from the user account with sudo mysql.", install: () => `${apt("mysql-server")}\n${service("mysql")}`, check: () => `for i in 1 2 3 4 5; do sudo mysqladmin ping 2>/dev/null | grep -q alive && exit 0; sleep 1; done; exit 1` },
  {
    id: "mongodb",
    label: "MongoDB",
    kind: "service",
    versions: ["8.0", "7.0"],
    about: "From MongoDB's own repository, up again after every wake.",
    install: (v) => `${repo(`mongodb-org-${v}`, `https://www.mongodb.org/static/pgp/server-${v}.asc`, `https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/${v} multiverse`)}\n${apt("mongodb-org")}\n${service("mongod")}`,
    check: (v) => `mongod --version | grep -q 'v${v.replace(".", "\\.")}'`,
  },

  // Tools.
  {
    id: "playwright",
    label: "Playwright",
    kind: "tool",
    about: "With Chromium and its system libraries, in /opt/ms-playwright, because a stop loses ~/.cache.",
    install: () => `sudo mkdir -p /opt/ms-playwright
sudo chown "$USER" /opt/ms-playwright
grep -q PLAYWRIGHT_BROWSERS_PATH /etc/environment || echo 'PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright' | sudo tee -a /etc/environment >/dev/null
bash -lc 'PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright npx -y playwright install --with-deps chromium'`,
    check: () => `ls /opt/ms-playwright | grep -q '^chromium'`,
  },
  { id: "terraform", label: "Terraform", kind: "tool", about: "From HashiCorp's apt repository.", install: () => `${repo("hashicorp", "https://apt.releases.hashicorp.com/gpg", "https://apt.releases.hashicorp.com noble main")}\n${apt("terraform")}`, check: () => `terraform version >/dev/null` },
  { id: "gcloud", label: "gcloud", kind: "tool", about: "Google Cloud's CLI, with kubectl.", install: () => `${repo("google-cloud-sdk", "https://packages.cloud.google.com/apt/doc/apt-key.gpg", "https://packages.cloud.google.com/apt cloud-sdk main")}\n${apt("google-cloud-cli kubectl")}`, check: () => `gcloud --version >/dev/null && kubectl version --client >/dev/null` },
  {
    id: "aws",
    label: "AWS CLI",
    kind: "tool",
    about: "Version 2, from Amazon.",
    install: () => `if ! command -v aws >/dev/null; then
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscli.zip
  rm -rf /tmp/aws
  unzip -q /tmp/awscli.zip -d /tmp
  sudo /tmp/aws/install --update
  rm -rf /tmp/aws /tmp/awscli.zip
fi`,
    check: () => `aws --version | grep -q 'aws-cli/2'`,
  },
  { id: "flyctl", label: "flyctl", kind: "tool", about: "Fly.io's CLI. Its login is a secret (FLY_API_TOKEN).", install: () => `curl -fsSL https://fly.io/install.sh | FLYCTL_INSTALL=/usr/local sudo -E sh`, check: () => `/usr/local/bin/flyctl version >/dev/null` },
  { id: "supabase", label: "Supabase CLI", kind: "tool", about: "With Docker, which boat's image has.", install: () => `curl -fsSL "https://github.com/supabase/cli/releases/latest/download/supabase_linux_${ARCH.slice(1, -1)}.deb" -o /tmp/supabase.deb\nsudo dpkg -i /tmp/supabase.deb\nrm -f /tmp/supabase.deb`, check: () => `supabase --version >/dev/null` },
];

export const SIZES: Record<string, string> = { small: "2 vCPU, 4 GB, half the price", default: "4 vCPU, 8 GB", large: "8 vCPU, 16 GB, twice the price", xlarge: "16 vCPU, 32 GB, 5.6 times the price" };
const byId = new Map(CATALOG.map((c) => [c.id, c]));
export const itemOf = (id: string): CatalogItem | null => byId.get(id) || null;

// A pick as it's written ("postgres@16", "redis") -> { item, v } or null: an item of the catalog, at one of its
// versions (its usual one when none is said).
export function pickOf(pick: string | null | undefined): Pick | null {
  const [id, v] = String(pick || "").split("@");
  const item = byId.get(id);
  if (!item || item.kind === "agent") return null;
  if (!item.versions) return v ? null : { item, v: null };
  const version = v || item.versions[0];
  return item.versions.includes(version) ? { item, v: version } : null;
}
export const pickText = ({ item, v }: Pick) => (v ? `${item.id}@${v}` : item.id);
export const catalogView = () => CATALOG.map(({ id, label, kind, about, versions, always }) => ({ id, label, kind, about, ...(versions ? { versions } : {}), ...(always ? { always: true } : {}) }));
