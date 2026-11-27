// Ports for tests, apart from the rest of harness.ts, which starts a server: tests that need none, and ship in
// agentbook-cli's own repo, take their ports from here. harness.ts passes these on, so every test can keep
// importing them from there.

import net from "node:net";

// Which of the tests running at once this is (test/all.ts says), and so its ports, apart from every other slot's.
// Tests share bands, so without this two running together can land on one port.
// - A test's own ports: bands between 4400 and 8000 (each test has its own, and adds up to 400 to them), moved up 4000
//   a slot.
// - The two halves of each agentbook it starts (harness.ts): from the slot's own pool, above every slot's bands and
//   below 49152, where macOS picks the ports of its own connections.
// A fixed distance from a test's port to its halves' (10000 and 20000, until there were more slots) held it to four.
export const SLOTS = 10;
const SLOT = Math.min(SLOTS - 1, Math.max(0, Math.floor(Number(process.env.AGENTBOOK_TEST_SLOT) || 0)));
const BANDS_FROM = 4400;
const BANDS_TO = 8000;
const WIDTH = BANDS_TO + 400 - BANDS_FROM;
const SHIFT = WIDTH * SLOT;
const POOL_FROM = BANDS_FROM + WIDTH * SLOTS;
const POOL_SIZE = Math.floor((49152 - POOL_FROM) / SLOTS);
// Ports fetch and WebSocket refuse ("bad port"), that a band or a shift can land on.
const BAD = new Set([5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);
const usable = (p: number) => ![0, 1, 2, 50, 100, 101, 200, 300, 400].some((d) => BAD.has(p + d));

function inBands(from: number, span: number) {
  if (from < BANDS_FROM || from + span > BANDS_TO) throw new Error(`a test's ports are a band between ${BANDS_FROM} and ${BANDS_TO}, not ${from}+${span}`);
}

// A port in a test's band, for a test that takes what it gets.
export function testPort(from: number, span = 90): number {
  inBands(from, span);
  for (;;) {
    const p = from + SHIFT + Math.floor(Math.random() * span);
    if (usable(p)) return p;
  }
}

const free = (p: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.createServer().once("error", () => resolve(false)).once("listening", () => s.close(() => resolve(true)));
    s.listen(p, "127.0.0.1");
  });

// A port in a test's band that's free. Something else can hold one (a demo, a trial, this test in another worktree),
// and a test that lands on it talks to that: it answers /api/health and the setup, and the test's hooks reach its own.
export async function freePort(from: number, span = 90): Promise<number> {
  inBands(from, span);
  const start = Math.floor(Math.random() * span);
  for (let i = 0; i < span; i++) {
    const p = from + SHIFT + ((start + i) % span);
    if (usable(p) && (await free(p))) return p;
  }
  throw new Error(`no free port in ${from}+${span}`);
}

// A port from the slot's pool, a new one each time in this process. Not looked at: whoever listens on it waits for it
// to be free (harness-front.ts). From a random start, so tests one after another in a slot seldom start on the ports
// the last one's agentbook may still be letting go of.
let next = Math.floor(Math.random() * POOL_SIZE);
export function poolPort(): number {
  return POOL_FROM + POOL_SIZE * SLOT + (next++ % POOL_SIZE);
}
