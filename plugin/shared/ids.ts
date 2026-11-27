// A machine's name, as agentbook-server knows it: lowercase letters, digits and dashes ("mac-mini", "laptop-alice").
// The birds threads are named after (a thread's is its process's: bird() in plugin/lib/common.ts).
export const BIRDS = ["osprey", "wren", "kite", "heron", "finch", "swift", "tern", "lark", "robin", "egret", "plover", "jay", "owl", "crane", "ibis", "rook", "gull", "petrel", "dove", "hawk", "raven", "swallow", "starling", "sparrow"];

// A person's seat on a shared machine is a Linux user named as they are on agentbook, when that can be one: lowercase
// letters, digits, - and _, starting with a letter, and not a name Linux machines have for themselves.
export const SEAT_RESERVED = ["root", "nobody", "user", "ubuntu", "debian", "admin", "agents", "daemon", "bin", "sys", "www-data", "sshd", "git"];
export const seatNameOk = (name: string | null | undefined): boolean => /^[a-z][a-z0-9_-]{0,31}$/.test(String(name || "")) && !SEAT_RESERVED.includes(name);
export const machineName = (name: string | null | undefined): string => String(name || "machine").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "machine";

// A new id for anything made on a machine or in the log your machines share: a UUIDv7
// (RFC 9562), its first 48 bits the time in milliseconds and the rest random, so ids made on two machines never
// collide and sort by when they were made. `now`: the time to put in it (tests).
export function uuidv7(now: number = Date.now()): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  for (let i = 0; i < 6; i++) b[i] = Math.floor(now / 2 ** (8 * (5 - i))) % 256;
  b[6] = (b[6] & 0x0f) | 0x70; // version 7
  b[8] = (b[8] & 0x3f) | 0x80; // the RFC's variant
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
