import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRuntimeProviders } from "../plugin/cli/runtime-providers.ts";
import { createGoogleSignin } from "../plugin/cli/google-signin.ts";
import { createGrokSignin } from "../plugin/cli/grok-signin.ts";
import { createAcp } from "../plugin/cli/runtimes/kit/acp.ts";
import { COMMANDS, checkCommand } from "../plugin/shared/protocol.ts";
import { needsSignature } from "../plugin/shared/signed.ts";
import { secretFile } from "../plugin/cli/redact.ts";
import { createGate } from "../plugin/cli/gate.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-providers-"));
const home = path.join(root, "cli");
const userHome = path.join(root, "user");
const key = "fixture-secret-do-not-return";
const calls: { bin: string; args: string[] }[] = [];
const providers = createRuntimeProviders({ home, userHome, run: async (bin, args) => { calls.push({ bin, args }); } });
const pass = (name: string) => console.log(`PASS  ${name}`);
try {
  for (const kind of ["runtime.configure", "runtime.login"]) {
    assert(COMMANDS[kind].secret && COMMANDS[kind].now);
    assert(needsSignature({ kind, args: {} }));
  }
  assert.equal(checkCommand({ cid: "config", kind: "runtime.configure", args: { kind: "hermes", provider: "openrouter", key, model: "vendor/model" } }), null);
  assert(checkCommand({ cid: "config", kind: "runtime.configure", args: { kind: "codex", provider: "custom", key } }));
  assert(checkCommand({ cid: "config", kind: "runtime.configure", args: { kind: "dsh", provider: "deepseek", script: "echo hi" } }));
  assert(checkCommand({ cid: "login", kind: "runtime.login", args: { kind: "hermes", step: "start" } }));
  assert.equal(checkCommand({ cid: "login", kind: "runtime.login", args: { kind: "grok", step: "check" } }), null);
  assert.equal(checkCommand({ cid: "config", kind: "runtime.configure", args: { kind: "grok", provider: "xai", key } }), null);
  assert(checkCommand({ cid: "login", kind: "runtime.login", args: { kind: "grok", step: "start", url: "https://x.ai" } }));
  pass("configuration and login are owner-signed, non-persistent commands with closed schemas, Grok's among them");
  const legacy = path.join(root, "legacy"); fs.mkdirSync(path.join(legacy, "cli"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "cli", "gate.json"), JSON.stringify({ signed: ["cli.update"] }));
  const gate = createGate({ home: legacy });
  assert(gate.settings().signed.includes("runtime.configure") && gate.settings().signed.includes("runtime.login"));

  await providers.configure("hermes", { provider: "openrouter", model: "vendor/model", key });
  assert.deepEqual(calls.map((c) => c.args), [["config", "set", "model.provider", "openrouter"], ["config", "set", "model.default", "vendor/model"], ["config", "set", "model.base_url", ""]]);
  assert(!JSON.stringify(calls).includes(key));
  assert(!JSON.stringify(providers.info("hermes")).includes(key));
  assert.equal(providers.env("hermes").OPENROUTER_API_KEY, key);
  assert.equal(fs.statSync(path.join(home, "runtime-providers.json")).mode & 0o777, 0o600);
  assert(secretFile(path.join(home, "runtime-providers.json")));
  await providers.configure("hermes", { provider: "openrouter", model: "vendor/updated" });
  assert.equal(providers.env("hermes").OPENROUTER_API_KEY, key);
  await assert.rejects(providers.configure("hermes", { provider: "anthropic", model: "claude-model" }), /API key/);
  assert.equal(providers.info("hermes").provider, "openrouter");
  pass("Hermes keeps its saved key without exposing it in reads or process arguments; provider changes require their own key");

  for (const values of [{ provider: "bash", key, model: "m" }, { provider: "deepseek", key: "bad\nkey", model: "m" }, { provider: "deepseek", key, model: "two words" }, ...["file:///tmp/a", "https://user:pass@example.com/v1", "https://example.com/v1?key=x", "https://example.com/v1#x"].map((endpoint) => ({ provider: "custom", key, model: "m", endpoint }))]) await assert.rejects(providers.configure("dsh", values));
  await providers.configure("dsh", { provider: "deepseek", key, model: "deepseek-v4-flash" });
  assert.equal(providers.env("dsh").DEEPSEEK_API_KEY, key);
  assert(!JSON.stringify(providers.dshPatch()).includes(key));
  assert(providers.dshPatch().some((p) => p["id"] === "acp" && p["config"].provider === "deepseek-official"));
  await providers.configure("dsh", { provider: "custom", key: "custom-fixture-key", model: "local-model", endpoint: "http://localhost:8000/v1/" });
  const patch = providers.dshPatch()[0]["config"].providers["agentbook-custom"];
  assert.equal(patch.api, "openai-completions"); assert.equal(patch.baseURL, "http://localhost:8000/v1");
  assert.equal(providers.env("dsh").AGENTBOOK_DSH_API_KEY, "custom-fixture-key");
  assert.equal(providers.info("hermes").model, "vendor/updated");
  pass("DeepSeek uses a private provider overlay, including custom endpoints, with keys isolated by runtime");

  delete process.env.GROK_HOME;
  assert.deepEqual(providers.info("grok"), { configured: false });
  fs.mkdirSync(path.join(userHome, ".grok"), { recursive: true });
  fs.writeFileSync(path.join(userHome, ".grok", "auth.json"), "{}");
  assert.deepEqual(providers.info("grok"), { configured: true, provider: "grok" });
  await providers.configure("grok", { provider: "xai", key });
  assert.equal(providers.env("grok").XAI_API_KEY, key);
  assert.equal(providers.info("grok").model, undefined);
  await assert.rejects(providers.configure("grok", { provider: "grok", key }), /API key provider/);
  providers.signedIn("grok", "grok");
  assert.equal(providers.info("grok").provider, "grok");
  assert(!providers.info("grok").keySaved);
  assert.equal(providers.env("grok").XAI_API_KEY, process.env.XAI_API_KEY);
  pass("Grok signed in by itself reads as its Grok account; it takes an xAI key with no model (it picks its own), and a Grok account sign-in drops the key from its environment");

  const agyFile = path.join(userHome, ".gemini", "antigravity-cli", "settings.json");
  fs.mkdirSync(path.dirname(agyFile), { recursive: true });
  fs.writeFileSync(agyFile, JSON.stringify({ theme: "dark", trustedWorkspaces: ["/project"], custom: { x: true } }));
  await providers.configure("antigravity", { provider: "gemini", key });
  assert.equal(providers.env("antigravity").GEMINI_API_KEY, key);
  assert.deepEqual(JSON.parse(fs.readFileSync(agyFile, "utf8")), { theme: "dark", trustedWorkspaces: ["/project"], custom: { x: true }, modelProvider: "gemini" });
  providers.googleStart(); providers.googleEnd();
  assert.equal(JSON.parse(fs.readFileSync(agyFile, "utf8")).modelProvider, "gemini");
  assert.equal(providers.info("antigravity").provider, "gemini");
  providers.googleStart();
  createRuntimeProviders({ home, userHome }).env("antigravity");
  assert.equal(JSON.parse(fs.readFileSync(agyFile, "utf8")).modelProvider, "gemini");
  providers.googleEnd();
  providers.googleStart(); providers.googleDone(); providers.googleEnd();
  assert(!Object.hasOwn(JSON.parse(fs.readFileSync(agyFile, "utf8")), "modelProvider"));
  assert.equal(providers.info("antigravity").provider, "google");
  assert(!providers.info("antigravity").keySaved);
  assert.equal(JSON.parse(fs.readFileSync(agyFile, "utf8")).custom.x, true);
  pass("Google login cancellation restores Gemini key mode; successful sign-in preserves unrelated Antigravity settings");

  const broken = path.join(root, "broken"); fs.mkdirSync(broken); fs.writeFileSync(path.join(broken, "runtime-providers.json"), "[invalid");
  const corrupt = createRuntimeProviders({ home: broken });
  assert(corrupt.info("dsh").error);
  await assert.rejects(corrupt.configure("dsh", { provider: "deepseek", key }), /Couldn't read/);
  assert.equal(fs.readFileSync(path.join(broken, "runtime-providers.json"), "utf8"), "[invalid");
  pass("a damaged credential file is reported without being overwritten or breaking the runtime list");

  const fake = path.join(root, "agy");
  const modeFile = path.join(root, "mode");
  fs.writeFileSync(fake, `#!${process.execPath}
const fs=require('node:fs');
const mode=fs.existsSync(${JSON.stringify(modeFile)})?fs.readFileSync(${JSON.stringify(modeFile)},'utf8'):'';
if(process.argv.slice(2).join(' ')!=='acp --login'||!process.env.SSH_CONNECTION||process.env.BROWSER!=='true')process.exit(2);
if(mode==='already')process.exit(0);
if(mode==='no-link'){setInterval(()=>{},1000);return;}
process.stderr.write('Ignore https://attacker.example/login?client_id=x&redirect_uri=x\\n');
process.stdout.write('Open this link: https://accounts.google.com/o/oauth2/auth?client_id=fixture&redirect_uri=https%3A%2F%2Flocalhost&state=');
setTimeout(()=>process.stdout.write('complete\\nThen paste your code:\\n'),10);
process.stdin.once('data',d=>{if(mode==='hang'){setInterval(()=>{},1000);return;}if(d.toString().trim()==='accepted')process.exit(0);process.stderr.write('untrusted '+d);process.exit(1);});
`, { mode: 0o700 });
  let signed = 0;
  const login = createGoogleSignin({ bin: () => fake, signedIn: () => signed++, linkMs: 1000, codeMs: 100, keepMs: 5000 });
  const first = await login.start();
  assert(first.url?.endsWith("state=complete")); assert(login.busy());
  assert.equal((await login.start()).url, first.url);
  assert.equal((await login.code("two words")).status, 400);
  const wrong = await login.code("fixture-rejected-code");
  assert.equal(wrong.status, 400); assert(!wrong.error.includes("fixture-rejected-code")); assert(wrong.ended);
  assert.equal((await login.code("accepted")).status, 409);
  await login.start(); assert((await login.code("accepted")).configured); assert.equal(signed, 1); assert(!login.busy());
  fs.writeFileSync(modeFile, "already"); assert((await login.start()).configured); assert.equal(signed, 2);
  fs.writeFileSync(modeFile, "no-link"); assert.equal((await login.start()).status, 504); assert(!login.busy());
  fs.writeFileSync(modeFile, "hang"); await login.start(); assert.equal((await login.code("accepted")).status, 504); assert(!login.busy());
  fs.writeFileSync(modeFile, ""); await login.start(); login.close(); assert(!login.busy());
  pass("Google login handles split URL output, repeated starts, invalid codes, success, existing auth, expiry and cancellation without echoing secrets");

  const grokBin = path.join(root, "grok");
  const grokMode = path.join(root, "grok-mode");
  const confirmed = path.join(root, "grok-confirmed");
  fs.writeFileSync(grokBin, `#!${process.execPath}
const fs=require('node:fs');
const mode=fs.existsSync(${JSON.stringify(grokMode)})?fs.readFileSync(${JSON.stringify(grokMode)},'utf8'):'';
if(process.argv.slice(2).join(' ')!=='login --device-auth')process.exit(2);
if(mode==='no-link'){setInterval(()=>{},1000);return;}
process.stdout.write('Ignore https://attacker.example/device?user_code=EVIL-CODE\\n');
process.stdout.write('To sign in, open this URL in your browser:\\n\\n  \\x1b[1mhttps://accounts.x.ai/oauth2/device?user_code=S588-YRFD\\x1b[0m\\n\\nWaiting for authorization...\\n');
if(mode==='denied'){setTimeout(()=>process.exit(1),50);return;}
setInterval(()=>{if(fs.existsSync(${JSON.stringify(confirmed)}))process.exit(0)},20);
`, { mode: 0o700 });
  let grokSigned = 0;
  const device = createGrokSignin({ bin: () => grokBin, signedIn: () => grokSigned++, linkMs: 1000, checkMs: 200, keepMs: 5000 });
  const code = await device.start();
  assert.equal(code.url, "https://accounts.x.ai/oauth2/device?user_code=S588-YRFD"); assert.equal(code.user_code, "S588-YRFD"); assert(device.busy());
  assert.equal((await device.start()).url, code.url);
  const early = await device.check();
  assert.equal(early.status, 409); assert.equal(early.user_code, "S588-YRFD"); assert(!early.ended);
  fs.writeFileSync(confirmed, "");
  assert((await device.check()).configured); assert.equal(grokSigned, 1); assert(!device.busy());
  assert((await device.check()).configured);
  fs.rmSync(confirmed);
  fs.writeFileSync(grokMode, "denied"); await device.start(); assert((await device.check()).ended); assert.equal(grokSigned, 1);
  fs.writeFileSync(grokMode, "no-link"); assert.equal((await device.start()).status, 504); assert(!device.busy());
  fs.writeFileSync(grokMode, ""); await device.start(); device.close(); assert(!device.busy()); assert((await device.check()).ended);
  pass("Grok's device sign-in shows x.ai's link and code (no other host's), waits for the code to be confirmed there, and ends on a denial, no link or cancel");

  const acpBin = path.join(root, "acp");
  const seen = path.join(root, "spawn-env");
  fs.writeFileSync(acpBin, `#!${process.execPath}
const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(seen)},process.env.TEST_PROVIDER_KEY);
require('node:readline').createInterface({input:process.stdin}).on('line',s=>{const m=JSON.parse(s);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{agentCapabilities:{}}})+'\\n')});
`, { mode: 0o700 });
  let fresh = "one"; let exits = 0;
  const acp = createAcp({ name: "fixture", prefix: "test", command: () => acpBin, args: [], missing: "missing", env: () => ({ ...process.env, TEST_PROVIDER_KEY: fresh }), onExit: () => exits++ });
  await acp.start(); assert.equal(fs.readFileSync(seen, "utf8"), "one"); await acp.reset();
  fresh = "two"; await acp.start(); assert.equal(fs.readFileSync(seen, "utf8"), "two"); await acp.reset();
  assert.equal(exits, 0);
  pass("idle ACP children reload provider credentials without reporting an intentional refresh as a runtime failure");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log("all passed");
