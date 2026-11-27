#!/usr/bin/env node
// With its server elsewhere, a machine takes what's typed in a terminal only for a while after a signature: a
// broken-into server can't type in a shell someone left open. The signature itself is the gate's (test/gate.ts), and
// the route and the frame to the page are test/terminal.ts's.
// Run: node test/terminal-lease.ts

import type { Json } from "./harness-types.ts";

process.env.AGENTBOOK_TERM_LEASE_MS = "700";

const { createTerminals } = await import("../plugin/cli/terminals.ts");
const { default: fs } = await import("node:fs");
const { default: os } = await import("node:os");
const { default: path } = await import("node:path");

let failures = 0;
const check = (cond: unknown, label: string): void => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | Promise<T>, ms = 4000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await fn()) return true;
  return false;
};

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-lease-")));
const cwd = path.join(BASE, "work");
fs.mkdirSync(cwd);
class Line extends EventTarget {
  readyState = 1;
  bufferedAmount = 0;
  sent: Json[] = [];
  send(x: string) {
    this.sent.push(JSON.parse(x));
  }
  close() {}
}
const socks: Line[] = [];
const line = () => {
  const s = new Line();
  socks.push(s);
  setTimeout(() => s.dispatchEvent(new Event("open")), 0);
  return s;
};
const says = (s: Line, m: object) => s.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(m) }));
const hasFile = (name: string) => fs.existsSync(path.join(cwd, name));

async function scenario(hosted: boolean) {
  const terms = createTerminals({ home: path.join(BASE, hosted ? "away" : "here"), line, hosted: () => hosted });
  const { tid } = await terms.start({ post: "p1", cwd, cols: 80, rows: 24 });
  await until(() => socks.at(-1)?.sent.length);
  const sock = socks.at(-1);
  const typeIn = (cmd: string, id?: string) => says(sock, { t: "in", tid, data: `${cmd}\n`, ...(id ? { id } : {}) });
  return { terms, tid, sock, typeIn };
}

try {
  const a = await scenario(true);
  await sleep(150);
  a.typeIn("touch one");
  check(await until(() => hasFile("one")), "right after it's opened, what's typed goes in");
  await sleep(800);
  a.typeIn("touch two", "pg1.7");
  check(await until(() => a.sock.sent.some((m) => m.t === "lease" && m.tid === a.tid)), "once its time runs out, the machine asks for a signature");
  check(a.sock.sent.find((m) => m.t === "lease")?.id === "pg1.7", "naming what it didn't take, so the page and server forget it rather than send it again");
  await sleep(500);
  check(!hasFile("two"), "and what was typed never reaches the shell");
  check(a.terms.renew(a.tid), "signing renews it");
  a.typeIn("touch three");
  check(await until(() => hasFile("three")), "and it takes what's typed again");
  check(!a.terms.renew("t-not-there"), "a terminal that isn't open can't be renewed");

  const b = await scenario(false);
  await sleep(1000);
  b.typeIn("touch four");
  check(await until(() => hasFile("four")), "with its server on this machine it never runs out");
  says(a.sock, { t: "close", tid: a.tid });
  says(b.sock, { t: "close", tid: b.tid });
  await sleep(300);
} catch (e) {
  check(false, `crashed: ${e.stack}`);
}
fs.rmSync(BASE, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
