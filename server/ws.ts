// The WebSocket server half lives with agentbook-cli's shared code (plugin/shared/ws.ts), since agentbook-cli takes
// connections too (DeepSeek Harness's plugin, /api/dsh/ws). The terminals' lines here use the same one.
export { accept, refuse } from "../plugin/shared/ws.ts";
