// Grok's sign-in to an x.ai account, from the page: `grok login --device-auth` prints a link to x.ai with a code and
// waits until that code is confirmed there, then keeps its own credentials (~/.grok/auth.json). The page shows the
// link and the code, and asks once they're confirmed; agentbook keeps nothing of the sign-in.
import { spawn } from "node:child_process";

type Answer = { url?: string; user_code?: string; configured?: boolean; error?: string; status?: number; ended?: boolean };

export function createGrokSignin({ bin, env = () => process.env, signedIn = () => {}, linkMs = 20e3, checkMs = 30e3, keepMs = 900e3 }: { bin: () => string; env?: () => NodeJS.ProcessEnv; signedIn?: () => void; linkMs?: number; checkMs?: number; keepMs?: number }) {
  let current: { child: ReturnType<typeof spawn>; url: string; code: string; exit: Promise<number>; timer: ReturnType<typeof setTimeout> } = null;
  // A sign-in that ended signed in, for a check that comes after it did.
  let signedAt = 0;
  const ENDED = { error: "That sign-in ended. Start again for a new code.", status: 409, ended: true };
  function close() {
    const c = current;
    if (!c) return;
    current = null;
    clearTimeout(c.timer);
    c.child.kill();
  }
  function start(): Promise<Answer> {
    if (current?.url) return Promise.resolve({ url: current.url, user_code: current.code });
    close();
    signedAt = 0;
    return new Promise((resolve) => {
      let answered = false;
      const answer = (r: Answer) => {
        if (answered) return;
        answered = true;
        clearTimeout(wait);
        resolve(r);
      };
      const child = spawn(bin(), ["login", "--device-auth"], { env: { ...env(), BROWSER: "true", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
      const c = { child, url: "", code: "", exit: null, timer: null };
      current = c;
      const wait = setTimeout(() => {
        if (current === c) close();
        answer({ error: "Grok's sign-in didn't give a code. Try again.", status: 504, ended: true });
      }, linkMs);
      c.timer = setTimeout(() => close(), keepMs);
      c.timer.unref?.();
      let output = "";
      const take = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-16000).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
        for (const text of output.match(/https:\/\/[^\s<>"'\x1b]+(?=[\s<>"'\x1b])/g) || []) {
          try {
            const u = new URL(text);
            const code = u.searchParams.get("user_code") || "";
            if (u.hostname !== "accounts.x.ai" || u.username || u.password || !/^[A-Z0-9-]{4,20}$/.test(code)) continue;
            c.url = u.href;
            c.code = code;
            answer({ url: c.url, user_code: c.code });
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
            signedAt = Date.now();
            try {
              signedIn();
            } catch {}
            answer({ configured: true });
          } else answer({ error: "Grok's sign-in couldn't start. Try again.", status: 502, ended: true });
          done(active ? code : -1);
        };
        child.once("error", () => finish(-1));
        child.once("exit", (code) => finish(code ?? -1));
      });
    });
  }
  // Whether the code was confirmed: it waits a little for grok to hear so.
  async function check(): Promise<Answer> {
    const c = current;
    if (!c) return signedAt ? { configured: true } : ENDED;
    let timer: ReturnType<typeof setTimeout>;
    const result = await Promise.race([c.exit, new Promise<null>((r) => (timer = setTimeout(() => r(null), checkMs)))]);
    clearTimeout(timer);
    if (result === 0) return { configured: true };
    if (result == null) return { url: c.url, user_code: c.code, error: "Grok hasn't heard that you confirmed the code yet. Confirm it on x.ai, then check again.", status: 409 };
    return ENDED;
  }
  return { start, check, close, busy: () => !!current };
}
