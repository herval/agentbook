// The relay gets only a sanitized description. Keys stay in this account's private CLI home and enter runtime
// children through their environment, never their command line or the machine's event store.
import { agentDataHome, agentEnvironment } from "./agent-context.ts";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLI_HOME } from "../shared/store.ts";
import { PROVIDERS, isProviderRuntime } from "../shared/runtime-providers.ts";
import type { ProviderRuntime, RuntimeProvider } from "../shared/runtime-providers.ts";

interface Saved { provider: string; model?: string; endpoint?: string; key?: string }
interface Values { provider?: string; model?: string; endpoint?: string; key?: string }
const reject = (message: string) => { throw Object.assign(new Error(message), { status: 400 }); };
const defaultBin = (kind: ProviderRuntime) => process.env[`AGENTBOOK_${kind === "antigravity" ? "AGY" : kind.toUpperCase()}_BIN`] || (kind === "antigravity" ? "agy" : kind);
export function createRuntimeProviders({ home = CLI_HOME, userHome = os.homedir(), bin = defaultBin, run = runConfig } = {}) {
  const file = path.join(home, "runtime-providers.json");
  const changing = new Set<string>();
  function read(): Partial<Record<ProviderRuntime, Saved>> {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!value || Array.isArray(value) || typeof value !== "object") throw new Error();
      return value;
    } catch (e) {
      if (e.code === "ENOENT") return {};
      throw new Error("Couldn't read the saved provider setup. Repair runtime-providers.json before changing it.");
    }
  }
  function save(kind: ProviderRuntime, value: Saved) {
    const all = read();
    all[kind] = value;
    privateJSON(file, all);
  }
  // Grok signed in with its own `grok login` (its account's credentials in ~/.grok/auth.json), set up here or not.
  const grokSignedIn = () => fs.existsSync(path.join(process.env.GROK_HOME || path.join(userHome, ".grok"), "auth.json"));
  function info(kind: string): RuntimeProvider | null {
    if (!isProviderRuntime(kind)) return null;
    try {
      const c = read()[kind];
      if (!c && kind === "grok" && grokSignedIn()) return { configured: true, provider: "grok" };
      return c ? { configured: true, provider: c.provider, model: c.model, endpoint: c.endpoint, keySaved: !!c.key } : { configured: false };
    } catch (e) { return { configured: false, error: e.message }; }
  }
  function env(kind: ProviderRuntime): NodeJS.ProcessEnv {
    const c = read()[kind];
    const option = PROVIDERS[kind].find((p) => p.id === c?.provider);
    // A daemon can stop during the temporary switch to Google's login. The saved choice wins on the next spawn.
    if (kind === "antigravity" && c && !changing.has(kind) && (readAgy()["modelProvider"] === "gemini") !== (c.provider === "gemini")) agyProvider(c.provider === "gemini");
    return agentEnvironment({ ...process.env, ...(option?.keyEnv && c.key ? { [option.keyEnv]: c.key } : {}) });
  }
  const agySettings = () => path.join(userHome, process.env.GEMINI_DIR || ".gemini", "antigravity-cli", "settings.json");
  let googlePrevious: { present: boolean; value: unknown } = null;
  function readAgy() {
    const target = agySettings();
    let current = {};
    try { current = JSON.parse(fs.readFileSync(target, "utf8")); }
    catch (e) { if (e.code !== "ENOENT") throw new Error("Antigravity's settings.json couldn't be read; it has been left unchanged."); }
    if (!current || typeof current !== "object" || Array.isArray(current)) throw new Error("Antigravity's settings.json must be an object.");
    return current;
  }
  function agyProvider(gemini: boolean) {
    const current = readAgy();
    const before = { present: Object.hasOwn(current, "modelProvider"), value: current["modelProvider"] };
    if (gemini) current["modelProvider"] = "gemini";
    else delete current["modelProvider"];
    privateJSON(agySettings(), current);
    return before;
  }
  function googleEnd() {
    if (!googlePrevious) return;
    const current = readAgy();
    if (googlePrevious.present) current["modelProvider"] = googlePrevious.value;
    else delete current["modelProvider"];
    privateJSON(agySettings(), current);
    googlePrevious = null;
  }
  async function configure(kind: ProviderRuntime, values: Values) {
    const option = PROVIDERS[kind]?.find((p) => p.id === values.provider);
    if (!option || !option.keyEnv) reject("Choose an API key provider.");
    const old = read()[kind];
    const key = values.key?.trim() || (old?.provider === option.id ? old.key : "");
    if (!key || key.length > 8000 || /[\x00-\x20\x7f]/.test(key)) reject("Enter a valid API key. Leave it blank only to keep a key saved for this provider.");
    const model = values.model?.trim() || option.model || "";
    if (!option.ownModels && (!model || model.length > 300 || /[\x00-\x20\x7f]/.test(model))) reject("Enter the provider's model ID.");
    let endpoint: string;
    if (option.endpoint) {
      try {
        const u = new URL(values.endpoint);
        if (!["https:", "http:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error();
        endpoint = u.href.replace(/\/$/, "");
      } catch { reject("Enter an HTTP or HTTPS endpoint without credentials, a query, or a fragment."); }
    }
    // Native Hermes config retains its tools, channels and other settings. No key goes through config set's argv.
    if (kind === "hermes") {
      for (const [k, v] of [["model.provider", option.id], ["model.default", model], ["model.base_url", endpoint || ""]]) {
        await run(bin(kind), ["config", "set", k, v], env(kind));
      }
    }
    if (kind === "antigravity") agyProvider(true);
    save(kind, { provider: option.id, ...(model ? { model } : {}), ...(endpoint ? { endpoint } : {}), key });
    return info(kind);
  }
  function dshPatch(): object[] {
    const c = read().dsh;
    if (!c) return [];
    const provider = c.provider === "deepseek" ? "deepseek-official" : c.provider === "custom" ? "agentbook-custom" : c.provider;
    const config = { provider, model: c.model };
    return [
      ...(c.provider === "deepseek" ? [{ id: "llm-deepseek", config: { apiKeyEnv: "DEEPSEEK_API_KEY", models: [{ id: c.model }] } }] : [{ id: "llm-pi-ai", config: { providers: { [provider]: {
        apiKeyEnv: PROVIDERS.dsh.find((p) => p.id === c.provider).keyEnv,
        models: [{ id: c.model }],
        ...(c.endpoint ? { baseURL: c.endpoint, api: "openai-completions" } : {}),
      } } } }]),
      { id: "agent-default-model", config }, { id: "acp", config },
    ];
  }
  return { info, env, configure, dshPatch, changing: (kind: string) => changing.has(kind), pause: (kind: string) => changing.add(kind), resume: (kind: string) => changing.delete(kind), googleStart: () => { googlePrevious = agyProvider(false); }, googleDone: () => { save("antigravity", { provider: "google" }); googlePrevious = null; }, googleEnd,
    // Signed in to the account (a device sign-in, Grok's): its credentials are the app's own, so only the choice is kept.
    signedIn: (kind: ProviderRuntime, provider: string) => save(kind, { provider }) };
}
function privateJSON(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}
function runConfig(bin: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => execFile(bin, args, { env, timeout: 30e3, maxBuffer: 64 * 1024 }, (error) => {
    if (error) reject(new Error("Hermes couldn't save its provider settings. Check that Hermes is installed and its config.yaml is valid."));
    else resolve();
  }));
}
const providers = new Map<string, ReturnType<typeof createRuntimeProviders>>();
export const runtimeProviders = new Proxy({} as ReturnType<typeof createRuntimeProviders>, { get(_target, key) {
  const home = agentDataHome(CLI_HOME);
  if (!providers.has(home)) providers.set(home, createRuntimeProviders({ home }));
  return providers.get(home)[key];
} });
