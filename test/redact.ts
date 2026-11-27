#!/usr/bin/env node
// What agentbook-cli sends its server has its secrets replaced with [redacted] (plugin/cli/redact.ts); files that
// are secrets as a whole are never read for it. The tokens here are made up, and put together as the test runs, so
// no scanner takes this file for one that leaks them.
// Run: node test/redact.ts

import { MARK, redact, redactDeep, redactText, secretFile } from "../plugin/cli/redact.ts";

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const r = (n, chars = "aB3dE6gH9k") => Array.from({ length: n }, (_, i) => chars[(i * 7) % chars.length]).join("");
const j = (...parts) => parts.join("");

// ---------- tokens by their shape ----------
const tokens = {
  "GitHub token": j("gh", "p_", r(36)),
  "GitHub fine-grained token": j("github", "_pat_", r(22), "_", r(59)),
  "Anthropic key": j("sk-", "ant-api03-", r(80)),
  "OpenAI key": j("sk-", "proj-", r(60)),
  "AWS access key": j("AK", "IA", "IOSFODNN7EXAMPLE"),
  "Slack token": j("xo", "xb-", "1234567890-", r(24)),
  "Stripe key": j("sk", "_live_", r(24)),
  "Google API key": j("AI", "za", r(35)),
  "npm token": j("np", "m_", r(36)),
  "Hugging Face token": j("h", "f_", r(34)),
  "GitLab token": j("gl", "pat-", r(20)),
  JWT: j("ey", "JhbGciOiJIUzI1NiJ9", ".", "ey", "JzdWIiOiIxMjM0NTY3ODkwIn0", ".", r(43)),
};
for (const [what, t] of Object.entries(tokens)) {
  const out = redact(`here it is: ${t} (don't share)`);
  check(out === `here it is: ${MARK} (don't share)`, `a ${what} is redacted`);
}
const pem = j("-----BEGIN ", "OPENSSH PRIVATE KEY-----\n", r(70), "\n", r(70), "\n-----END ", "OPENSSH PRIVATE KEY-----");
check(redact(`key:\n${pem}\ndone`) === `key:\n${MARK}\ndone`, "a private key, the whole block");
check(!redact(`${j("-----BEGIN ", "RSA PRIVATE KEY-----\n")}${r(64)}\n${r(64)}`).includes(r(64)), "and one cut off before its end");

// ---------- values a name says are secrets ----------
const pw = j("hunter", "22", "x9");
check(redact(`DB_PASSWORD=${pw}\nPORT=5432`) === `DB_PASSWORD=${MARK}\nPORT=5432`, "a password in an environment file, and not the port");
check(redact(`export STRIPE_SECRET="${pw}"`) === `export STRIPE_SECRET="${MARK}"`, "an exported one, in quotes");
check(redact(`{"client_secret": "${pw}abc", "name": "acme"}`) === `{"client_secret": "${MARK}", "name": "acme"}`, "a secret in JSON, and not its neighbours");
check(redact(`psql postgres://app:${pw}@db.acme.internal:5432/ledger`) === `psql postgres://app:${MARK}@db.acme.internal:5432/ledger`, "a password in a URL, and not its user or host");
check(redact(`curl -H "Authorization: Bearer ${r(32)}" https://api.acme.dev`) === `curl -H "Authorization: Bearer ${MARK}" https://api.acme.dev`, "an Authorization header");
check(redact(`curl -H 'x-api-key: ${r(32)}'`) === `curl -H 'x-api-key: ${MARK}'`, "an API key header");
check(redact(`Set PASSWORD: ${pw} now`) === `Set PASSWORD: ${MARK} now`, "a name that is only PASSWORD");
check(redact(`https://acme.s3.amazonaws.com/a.png?X-Amz-Signature=${r(64)}&X-Amz-Date=20261102`) === `https://acme.s3.amazonaws.com/a.png?X-Amz-Signature=${MARK}&X-Amz-Date=20261102`, "a signed URL's signature, and not its date");
check(redact(`https://api.acme.dev/v1?access_token=${r(40)}`) === `https://api.acme.dev/v1?access_token=${MARK}`, "a token in a URL's query");

// ---------- what a review found getting through, as a table: each secret goes, and what's around it stays ----------
const hex = (n) => r(n, "0123456789abcdef");
const awsish = j("wJalr", "XUtnFEMI/K7MDENG/", "bPxRfiCY", r(10));
const named = [
  [`password: ${pw}`, pw],
  [`Password = ${pw}`, pw],
  [`db_pass=${pw}`, pw],
  [`DB_PASS=${pw}`, pw],
  [`MYSQL_PWD=${pw}`, pw],
  [`smtp_password: "${pw}"`, pw],
  [`password: '${pw}'`, pw],
  [`aws_secret_access_key = ${awsish}`, awsish],
  [`clientSecret: "${pw}"`, pw],
  [`"password": "abc1"`, "abc1"],
  [`{\\"password\\": \\"${pw}\\"}`, pw],
  [`'api_key' => '${pw}'`, pw],
  [`api-key: ${pw}`, pw],
  [`secret_key_base: ${hex(64)}`, hex(64)],
  [`passphrase: "two words of it"`, "two words of it"],
  [`token := "${pw}"`, pw],
  [`DefaultEndpointsProtocol=https;AccountKey=${awsish}==;`, awsish],
  [`password: |\n  ${pw}\nnext: 1`, pw],
  [`redis://:${pw}@cache.acme.internal:6379`, pw],
];
const onLines = [
  [`mysql -u root -p${pw} ledger`, pw],
  [`mysqldump -h db -uroot -p${pw} ledger`, pw],
  [`curl -u me:${pw} https://api.acme.dev`, pw],
  [`curl -s --user me:${pw} https://api.acme.dev`, pw],
  [`psql --password ${pw} -h db`, pw],
  [`acme deploy --api-key=${pw} --region us`, pw],
  [`sshpass -p ${pw} ssh db`, pw],
  [`redis-cli -h cache -a ${pw} ping`, pw],
  [`docker login -u acme -p ${pw}`, pw],
  [`openssl enc -aes-256-cbc -pass pass:${pw}`, pw],
];
const cookies = [
  [`Cookie: sid=${r(24)}; theme=dark`, r(24)],
  [`set-cookie: session=${r(24)}; HttpOnly`, r(24)],
  [`curl -b "sid=${r(24)}" https://api.acme.dev`, r(24)],
];
const prefixes = {
  "OpenRouter key": j("sk-", "or-v1-", hex(64)),
  "Groq key": j("gs", "k_", r(52)),
  "xAI key": j("xa", "i-", r(80)),
  "Perplexity key": j("pp", "lx-", r(48)),
  "Replicate token": j("r", "8_", r(37)),
  "Linear key": j("li", "n_api_", r(40)),
  "Notion token": j("nt", "n_", r(46)),
  "Sentry token": j("sntr", "ys_", r(60)),
  "PostHog key": j("ph", "x_", r(43)),
  "Databricks token": j("da", "pi", hex(32)),
  "DigitalOcean token": j("do", "p_v1_", hex(64)),
  "Vault token": j("hv", "s.", r(90)),
  "Docker Hub token": j("dck", "r_pat_", r(27)),
  "PyPI token": j("py", "pi-", r(120)),
  "Supabase token": j("sb", "p_", hex(40)),
  "Shopify token": j("sh", "pat_", hex(32)),
  "Figma token": j("fi", "gd_", r(40)),
  "Telegram bot token": j("1234567890", ":AA", r(33)),
  "Discord webhook": j("https://discord", ".com/api/webhooks/1234567890/", r(60)),
  "Twilio key": j("S", "K", hex(32)),
  "Mailgun key": j("ke", "y-", hex(32)),
  "Slack app token": j("xa", "pp-1-", r(40)),
  "GitLab deploy token": j("gl", "dt-", r(24)),
  "Google OAuth token": j("ya", "29.", r(60)),
};
for (const [text, secret] of [...named, ...onLines, ...cookies]) {
  const out = redact(text);
  check(!out.includes(secret) && out.includes(MARK), `redacted: ${text.replace(secret, "…").replace("\n", " ")}`);
}
check(redact(`password: ${pw}\nport: 5432`) === `password: ${MARK}\nport: 5432`, "only the value goes, not the next line");
check(redact(`curl -s -u me:${pw} https://api.acme.dev/v1`) === `curl -s -u me:${MARK} https://api.acme.dev/v1`, "curl keeps its user and its address");
for (const [what, t] of Object.entries(prefixes)) check(redact(`here: ${t} (rest)`) === `here: ${MARK} (rest)`, `a ${what} is redacted`);

// A diff comes a line at a time, and a private key doesn't fit on one.
const keyBegin = j("-----BEGIN ", "RSA PRIVATE KEY-----");
const keyEnd = j("-----END ", "RSA PRIVATE KEY-----");
const [k1, k2, k3] = [r(64), r(64, "Zy8Xw7Vu6T"), r(40, "Qp5Rs4Lm3N")];
const split = [
  { oldStart: 0, oldLines: 0, newStart: 1, newLines: 3, lines: [` config:`, `+${keyBegin}`, `+${k1}`] },
  { oldStart: 40, oldLines: 1, newStart: 42, newLines: 3, lines: [`-${k2}`, `+${k3}`, `+${keyEnd}`, ` port: 5432`] },
];
const across = redactDeep({ path: "deploy/key.txt", hunks: split }).hunks;
const seen = JSON.stringify(across);
check(![k1, k2, k3].some((k) => seen.includes(k)), "a private key split across a diff's hunks is redacted, every line of it");
check(across[0].lines.length === 3 && across[1].lines.length === 4 && across[1].lines[0][0] === "-" && across[1].lines[1][0] === "+", "and its hunks keep their lines and their signs, so they still add up");
check(across[0].lines[0] === " config:" && across[1].lines[3] === " port: 5432", "and what's around it stays");
check(split[0].lines[2] === `+${k1}`, "in a copy");
const named2 = redactDeep({ hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`-password: ${pw}`, `+password: ${pw}2`, ` port: 5432`] }] }).hunks[0].lines;
check(!named2.join("\n").includes(pw) && named2[2] === " port: 5432", "a named secret in a hunk goes too");
const plainHunks = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a = 1", "+a = 2"] }];
check(redactDeep(plainHunks) === plainHunks, "hunks with nothing in them come back as they are");

// ---------- what isn't one ----------
const fine = [
  "password: string",
  "password: str",
  "token: Token",
  "token: string;",
  "const token = getToken();",
  "token = req.headers.get('authorization')",
  "secret: process.env.SECRET",
  "api_key: Optional[str] = None",
  "def login(username, password=None):",
  'def f(token: str = ""):',
  "tokens: 1200",
  "token_count: 12",
  "input_tokens=100",
  "password_min: 8",
  "password_length: 12",
  "secret_name: acme-core-api",
  "secretName: ledger-tls",
  "token_url: https://oauth2.acme.dev/token",
  "tokenEndpoint: https://acme.dev/oauth/token",
  'password: "Too short"',
  'password = "Password is required"',
  "pass: 12",
  "passed: 12",
  "bypass=1",
  "compass: north",
  "PWD=/Users/me/dev/platform",
  "OLDPWD=/tmp",
  "pwd: /Users/me",
  "cookie: string",
  "document.cookie = value",
  "the cookie jar is empty",
  "curl https://acme.dev/tokens?page=2 -o out.json",
  "mysql -u root -p ledger",
  "mysql -P 3306 -h db",
  "docker login -u acme --password-stdin",
  "gh auth login --with-token",
  "acme push --token-file ~/.config/acme/key",
  "pg_dump --no-password ledger",
  "acme deploy --token $DEPLOY_TOKEN",
  "the sk-learn pipeline",
  "a key-value store",
  "SKIP_TESTS=1",
  'password: "${DB_PASSWORD}"',
  "password: ********",
  "password: <your password>",
  "token: YOUR_TOKEN_HERE",
  "secret: {{ vault_secret }}",
  "API_KEY=your-api-key-here",
  "GITHUB_TOKEN=${GITHUB_TOKEN}",
  "PASSWORD=changeme",
  "MAX_TOKENS=4096000000",
  "GOOGLE_APPLICATION_CREDENTIALS=/etc/acme/creds.json",
  'const password = user.password; // a variable, not a value',
  "commit 3f9a2b1c4d5e6f708192a3b4c5d6e7f8091a2b3c (its sha)",
  "sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "postgres://localhost:5432/ledger",
  "https://github.com/acme/platform/pull/42",
  "the token-bucket limiter keeps 20 tokens",
  '"tokens": 1200, "max_tokens": 4096',
  "API_KEY: process.env.ACME_API_KEY",
  'const ACCESS_TOKEN_KEY = "access_token";',
  "ANTHROPIC_API_KEY=$(cat ~/.config/acme/key)",
  "https://acme.dev/search?q=tokens&page=2",
];
for (const s of fine) check(redact(s) === s, `left as it is: ${s}`);

// ---------- at any depth, cheaply ----------
const op = { t: "post.steps", post: "s1", steps: [{ title: "Bash", input: { command: `curl -u me:${pw} https://x` }, output: `ok ${tokens["GitHub token"]}` }, { title: "Read", output: "nothing to see" }] };
const out = redactDeep(op);
check(out !== op && out.steps[0].output === `ok ${MARK}` && op.steps[0].output.includes(tokens["GitHub token"]), "an op's strings are redacted at any depth, in a copy");
check(out.steps[1] === op.steps[1] && out.post === "s1", "what had none is the same object");
const clean = { a: [1, 2, { b: "plain" }], c: null };
check(redactDeep(clean) === clean, "a value with no secrets comes back as it is");
const b64 = Buffer.from(`DB_PASSWORD=${pw} ${tokens["GitHub token"]} `.repeat(40)).toString("base64");
check(redactDeep({ data: b64 }).data === b64, "bytes as base64 aren't touched");
const short = `PASSWORD=abcdef`;
check(redactDeep(short).length <= short.length, "a string never comes out longer than it went in");
check(redactText(`AWS: ${tokens["AWS access key"]}`).found.includes("AWS access key"), "it says what it found");
const big = `${"lorem ipsum dolor sit amet ".repeat(40000)}${tokens["GitHub token"]}`;
// In CPU time: that's what it costs, and a clock also counts whatever else this machine is running.
const before = process.cpuUsage();
const bigOut = redact(big);
const used = process.cpuUsage(before);
const ms = (used.user + used.system) / 1000;
check(bigOut.endsWith(MARK) && ms < 400, `a megabyte of text takes ${Math.round(ms)} ms of CPU`);
// A word a rule looks ahead from, over and over on one line, which took minutes when that look had no limit.
const again = process.cpuUsage();
redact("curl a b c ".repeat(90000));
redact("mysql a b c ".repeat(90000));
const againUsed = process.cpuUsage(again);
const againMs = (againUsed.user + againUsed.system) / 1000;
check(againMs < 3000, `a megabyte of one word said over and over takes ${Math.round(againMs)} ms of CPU`);

// ---------- files that are secrets ----------
for (const p of [".env", "app/.env.production", "~/.ssh/config", "/Users/me/.aws/credentials", "certs/server.key", "deploy/acme.pem", "id_ed25519", ".npmrc", "infra/terraform.tfstate", "~/.agentbook/cli/device.json", "~/.claude/.credentials.json", "~/.codex/auth.json", "client_secret_123.apps.googleusercontent.com.json"])
  check(!!secretFile(p), `${p} is kept on the machine`);
for (const p of [".env.example", "docs/env.md", "id_ed25519.pub", "src/keyboard.ts", "server/secrets.ts", "README.md", "app/.envrc.md"]) check(!secretFile(p), `${p} isn't`);
const kept = ["~/.zsh_history", "~/.bash_history", "~/.python_history", "~/.node_repl_history", "~/.psql_history", "~/.mysql_history", "~/.local/share/fish/fish_history", "~/.lesshst", "~/.viminfo", "~/.config/gh/hosts.yml", "~/.config/gcloud/credentials.db", "~/.config/gcloud/access_tokens.db", "~/.config/gcloud/application_default_credentials.json", "~/.config/gcloud/legacy_credentials/me@acme.dev/adc.json", "~/.claude.json", "~/.claude.json.backup", "~/.claude/history.jsonl", "~/.claude/projects/-Users-me-dev-platform/abc.jsonl", "~/.codex/sessions/2026/11/07/rollout.jsonl", "~/.vault-token", "~/.my.cnf", "~/.mylogin.cnf", "~/.boto", "~/.s3cfg", "~/.oci/config", "~/.terraform.d/credentials.tfrc.json", "~/.cargo/credentials.toml", "~/.gem/credentials", "~/.composer/auth.json", "~/.config/op/config", "~/.config/rclone/rclone.conf", "~/.config/sops/age/keys.txt", "~/Library/Keychains/login.keychain-db", "~/Library/Application Support/Google/Chrome/Default/Login Data", "~/Library/Application Support/Claude/claude_desktop_config.json", "deploy/secrets.yaml", "infra/prod.tfvars", "deploy/kubeconfig", "certs/apns.p8",
  // MCP servers' settings, with the tokens they take, and other agents' settings and logins.
  ".mcp.json", "~/dev/platform/.mcp.json", "~/.cursor/mcp.json", ".vscode/mcp.json", ".roo/mcp.json", "~/.codeium/windsurf/mcp_config.json", "~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json", "~/.codex/config.toml", "~/dev/platform/.codex/config.toml", "~/.gemini/settings.json", "~/.gemini/oauth_creds.json", "~/.hermes/config.yaml", "~/.hermes/auth.json", "~/.continue/config.yaml", "~/.continue/mcpServers/ledger.yaml", "~/.config/zed/settings.json", "~/.config/goose/config.yaml", "~/.config/amp/settings.json", "~/.config/opencode/opencode.jsonc", "~/.local/share/opencode/auth.json", "~/.openclaw/openclaw.json", "~/.openclaw/openclaw.json.bak.1", "~/.openclaw/agents/main/agent/auth-profiles.json", "~/.openclaw/credentials/chat/creds.json", "~/.openclaw/mac-control.token", ".aider.conf.yml",
  // Claude Code's own settings, whose env and apiKeyHelper can hold tokens, the project's and the managed one too.
  "~/.claude/settings.json", "~/.claude/settings.local.json", "~/dev/platform/.claude/settings.json", ".claude/settings.local.json", "/Library/Application Support/ClaudeCode/managed-settings.json", "/etc/claude-code/managed-settings.json"];
for (const p of kept) check(!!secretFile(p), `${p} is kept on the machine`);
const notKept = [".github/workflows/ci.yml", "docs/history.md", "src/history.ts", "history.json", "src/token.ts", "app/auth.json", "config/hosts.yml", "~/.config/nvim/init.lua", "~/.claude/skills/review/SKILL.md", "~/.claude/agents/reviewer.md", "~/dev/platform/.claude/commands/ship.md", "docs/claude/settings.json", "docs/secrets.md", "package.json", "~/Library/Application Support/Code/User/settings.json", "infra/prod.tfvars.example",
  "docs/mcp.md", "src/mcp.ts", "plugin/cli/mcp.ts", "schemas/mcp-schema.json", "~/dev/platform/config.toml", "settings.json", "~/dev/zed/settings.json", "~/.openclaw/workspace/AGENTS.md", "~/.openclaw/workspace/notes/plans.md", "~/.codex/skills/review/SKILL.md", "~/.gemini/GEMINI.md", "~/.continue/rules/style.md"];
for (const p of notKept) check(!secretFile(p), `${p} isn't`);

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
