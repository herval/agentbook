// ACP's terminal login supports a remote URL/code exchange. Its PKCE verifier and tokens stay in agy; neither
// its output nor the code is logged or stored by agentbook.
import { spawn } from "node:child_process";

export function createGoogleSignin({ bin, signedIn = () => {}, ended = () => {}, env = () => process.env, linkMs = 20e3, codeMs = 40e3, keepMs = 600e3 }: { bin: () => string; signedIn?: () => void; ended?: () => void; env?: () => NodeJS.ProcessEnv; linkMs?: number; codeMs?: number; keepMs?: number }) {
  let current: { child: ReturnType<typeof spawn>; url: string; sent: boolean; exit: Promise<number>; timer: ReturnType<typeof setTimeout>; answer: (r: object) => void } = null;
  function close(result = { error: "That sign-in ended. Start again for a new link.", status: 409, ended: true }) {
    const c = current;
    if (!c) return;
    current = null;
    clearTimeout(c.timer);
    c.child.kill();
    ended();
    c.answer(result);
  }
  function start(): Promise<{ url?: string; configured?: boolean; error?: string; status?: number; ended?: boolean }> {
    if (current?.sent) return Promise.resolve({ error: "Your code is being checked. Give it a moment.", status: 409 });
    if (current?.url) return Promise.resolve({ url: current.url });
    close();
    return new Promise((resolve) => {
      let answered = false;
      const answer = (result) => { if (!answered) { answered = true; clearTimeout(wait); resolve(result); } };
      const child = spawn(bin(), ["acp", "--login"], { env: { ...env(), BROWSER: "true", SSH_CONNECTION: "127.0.0.1 1 127.0.0.1 22", SSH_TTY: "agentbook" }, stdio: ["pipe", "pipe", "pipe"] });
      const c = { child, url: "", sent: false, exit: null, timer: null, answer };
      current = c;
      const wait = setTimeout(() => close({ error: "Google sign-in didn't provide a link. Try again.", status: 504, ended: true }), linkMs);
      c.timer = setTimeout(() => close(), keepMs);
      c.timer.unref?.();
      child.stdin.on("error", () => {});
      let output = "";
      const take = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-16000).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
        for (const text of output.match(/https:\/\/[^\s<>"'\x1b]+(?=[\s<>"'\x1b])/g) || []) {
          try {
            const u = new URL(text);
            if (u.hostname !== "accounts.google.com" || u.username || u.password || !u.searchParams.has("client_id") || !u.searchParams.has("redirect_uri")) continue;
            c.url = u.href;
            answer({ url: c.url });
            break;
          } catch {}
        }
      };
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      c.exit = new Promise<number>((done) => {
        let finished = false;
        const finish = (code: number) => {
          if (finished) return;
          finished = true;
          clearTimeout(c.timer);
          const active = current === c;
          if (active) current = null;
          if (code === 0 && active) {
            try { signedIn(); answer({ configured: true }); }
            catch { code = -1; answer({ error: "Signed in, but the machine couldn't save its setup. Try again.", status: 500 }); }
          } else answer({ error: "Google sign-in couldn't start. Try again.", status: 502 });
          if (active) ended();
          done(active ? code : -1);
        };
        child.once("error", () => finish(-1));
        child.once("exit", (code) => finish(code ?? -1));
      });
    });
  }
  async function code(value: string) {
    const c = current;
    if (c?.sent) return { error: "Your code is being checked. Give it a moment.", status: 409 };
    if (!c?.url) return { error: "That sign-in ended. Start again for a new link.", status: 409, ended: true };
    const text = String(value || "").trim();
    if (!text || /[\s\x00-\x1f\x7f]/.test(text) || text.length > 4000) return { error: "Paste the code or redirect URL Google showed you.", status: 400 };
    c.sent = true;
    c.child.stdin.write(`${text}\n`);
    let timer;
    const result = await Promise.race([c.exit, new Promise<null>((r) => { timer = setTimeout(() => r(null), codeMs); })]);
    clearTimeout(timer);
    if (result === 0) return { configured: true };
    if (current === c) close();
    return { error: result == null ? "Google didn't finish signing in. Start again for a new link." : "Google didn't accept that code. Start again for a new link.", status: result == null ? 504 : 400, ended: true };
  }
  return { start, code, close: () => close(), busy: () => !!current };
}
