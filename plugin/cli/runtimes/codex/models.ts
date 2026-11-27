import { agentDirectory, currentAgentConfig } from "../../agent-context.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Models } from "../runtime.ts";
import type { CodexList, CodexModel } from "./items.ts";

// A custom socket can belong to another account (or a test); don't use this user's sign-in for it.
export const codexHome = () => currentAgentConfig() ? agentDirectory("codex") : process.env.AGENTBOOK_CODEX_HOME || (process.env.AGENTBOOK_CODEX_SOCK ? null : agentDirectory("codex"));

function credentials(home: string | null) {
  try {
    if (!home) return null;
    const a = JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8"));
    if (a.auth_mode && a.auth_mode !== "chatgpt") return null;
    const token = a.tokens?.access_token;
    if (typeof token !== "string" || !token) return null;
    return { token, account: typeof a.tokens.account_id === "string" ? a.tokens.account_id : "" };
  } catch {
    return null;
  }
}

const blank = (): Models => ({ list: [], default: null });
const withDefault = (list: Models["list"], id?: string): Models => {
  const def = list.find((m) => m.id === id) || list[0];
  return def ? { list, default: def.id, efforts: def.efforts, effort: def.effort } : blank();
};
const bundledModels = (data: CodexModel[]) => {
  const list = data.filter((m) => m && !m.hidden && typeof (m.model || m.id) === "string");
  const def = list.find((m) => m.isDefault) || list[0];
  return withDefault(list.map((m) => ({ id: m.model || m.id, name: m.displayName || m.model || m.id, efforts: (m.supportedReasoningEfforts || []).map((e) => e.reasoningEffort), effort: m.defaultReasoningEffort || null })), def?.model || def?.id);
};

interface CatalogModel {
  slug?: string;
  display_name?: string;
  visibility?: string;
  supported_reasoning_levels?: { effort?: string }[];
  default_reasoning_level?: string;
}
interface ReaderOpts {
  call(): Promise<CodexList<CodexModel>>;
  usesOpenai?: () => Promise<boolean>;
  home?: string | null;
  request?: typeof fetch;
  version: () => string | null;
  catalogTimeoutMs?: number;
}

export function createModelReader({ call, usesOpenai = async () => true, home = codexHome(), request = fetch, version, catalogTimeoutMs = 10000 }: ReaderOpts) {
  let current = blank();
  let live: { token: string; account: string; version: string; models: Models } | null = null;
  let revision = 0;
  const same = (a: ReturnType<typeof credentials>, b: ReturnType<typeof credentials>) => a?.token === b?.token && a?.account === b?.account;
  const sameRuntime = (a: { token: string; account: string; version: string } | null, b: typeof a) => same(a, b) && a?.version === b?.version;

  async function catalog(auth: NonNullable<ReturnType<typeof credentials>>, v: string) {
    // The server gates models by client_version; turns run on the connected daemon, regardless of the CLI on PATH.
    const url = new URL("https://chatgpt.com/backend-api/codex/models");
    url.searchParams.set("client_version", v);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    // Cancellation alone has left fetch pending indefinitely in the daemon. Bound the whole read, including its body.
    const deadline = new Promise<null>((resolve) => timer = setTimeout(() => { resolve(null); controller.abort(); }, catalogTimeoutMs));
    try {
      return await Promise.race([deadline, (async () => {
        const res = await request(url, { headers: { Authorization: `Bearer ${auth.token}`, ...(auth.account ? { "ChatGPT-Account-Id": auth.account } : {}), originator: "agentbook" }, redirect: "error", signal: controller.signal });
        if (!res.ok) return null;
        const data = await res.json() as { models?: CatalogModel[] };
        const list = Array.isArray(data.models) ? data.models.filter((m) => m?.visibility === "list" && typeof m.slug === "string" && m.slug) : [];
        return list.length ? list : null;
      })()]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function read(): Promise<Models> {
    const turn = ++revision;
    const auth = credentials(home);
    const v = version();
    const [fallback, native] = await Promise.all([
      call().then((r) => bundledModels(Array.isArray(r?.data) ? r.data : [])).catch(() => blank()),
      auth && v ? usesOpenai().catch(() => false) : false,
    ]);
    if (turn !== revision) return current;
    if (!same(auth, credentials(home)) || v !== version()) return read();
    const target = auth && v && native ? { ...auth, version: v } : null;
    current = target && sameRuntime(target, live) && live ? live.models : fallback;
    if (!sameRuntime(target, live)) live = null;
    const latest = target ? await catalog(auth, v).catch(() => null) : null;
    if (turn !== revision) return current;
    if (!same(auth, credentials(home)) || v !== version()) return read();
    if (latest) {
      const list = latest.map((m) => {
        const old = fallback.list.find((x) => x.id === m.slug);
        const efforts = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.map((e) => e?.effort).filter((e) => typeof e === "string" && e) : old?.efforts || [];
        return { id: m.slug, name: m.display_name || m.slug, efforts, effort: m.default_reasoning_level || old?.effort || null };
      });
      current = withDefault(list, fallback.default);
      live = { ...target, models: current };
    }
    return current;
  }

  return {
    read,
    get: () => current,
    clear() {
      revision++;
      live = null;
      current = blank();
    },
  };
}
