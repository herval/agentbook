export type ProviderRuntime = "hermes" | "dsh" | "antigravity" | "grok";
// A way to set up a runtime's model provider (Settings → Agents): an API key put in its environment (`keyEnv`), with
// the model to use (`model`, the default) unless the runtime picks its own models (`ownModels`), or a sign-in to an
// account, by a code pasted back from the provider's page ("code": Google's) or a code confirmed there ("device":
// Grok's).
export interface ProviderOption { id: string; name: string; keyEnv?: string; model?: string; endpoint?: boolean; ownModels?: boolean; signIn?: "code" | "device" }
export const PROVIDERS: Record<ProviderRuntime, ProviderOption[]> = {
  hermes: [
    { id: "openrouter", name: "OpenRouter", keyEnv: "OPENROUTER_API_KEY" },
    { id: "anthropic", name: "Anthropic", keyEnv: "ANTHROPIC_API_KEY" },
    { id: "openai-api", name: "OpenAI", keyEnv: "OPENAI_API_KEY" },
    { id: "deepseek", name: "DeepSeek", keyEnv: "DEEPSEEK_API_KEY" },
    { id: "custom", name: "OpenAI-compatible endpoint", keyEnv: "OPENAI_API_KEY", endpoint: true },
  ],
  dsh: [
    { id: "deepseek", name: "DeepSeek", keyEnv: "DEEPSEEK_API_KEY", model: "deepseek-v4-flash" },
    { id: "openrouter", name: "OpenRouter", keyEnv: "OPENROUTER_API_KEY" },
    { id: "openai", name: "OpenAI", keyEnv: "OPENAI_API_KEY" },
    { id: "anthropic", name: "Anthropic", keyEnv: "ANTHROPIC_API_KEY" },
    { id: "custom", name: "OpenAI-compatible endpoint", keyEnv: "AGENTBOOK_DSH_API_KEY", endpoint: true },
  ],
  antigravity: [{ id: "google", name: "Google account", signIn: "code" }, { id: "gemini", name: "Gemini API key", keyEnv: "GEMINI_API_KEY", ownModels: true }],
  grok: [{ id: "grok", name: "Grok account", signIn: "device" }, { id: "xai", name: "xAI API key", keyEnv: "XAI_API_KEY", ownModels: true }],
};
export const isProviderRuntime = (kind: string): kind is ProviderRuntime => Object.hasOwn(PROVIDERS, kind);
// The runtimes with an account to sign in to from the page (runtime.login).
export const SIGN_IN = (Object.keys(PROVIDERS) as ProviderRuntime[]).filter((k) => PROVIDERS[k].some((p) => p.signIn));
export interface RuntimeProvider {
  configured: boolean;
  provider?: string;
  model?: string;
  endpoint?: string;
  keySaved?: boolean;
  error?: string;
}
