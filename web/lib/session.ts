// Signing in and out: who you are (/api/auth/me), the page's stream once you're in, and back to the sign-in page when
// the server says you're out (a 401, the stream closed with 4401).
import { getJSON, loader } from "./api.ts";
import { closeLive, openLive } from "./live.ts";
import { clearSide } from "./side.ts";
import { getApp, setApp } from "./store.ts";
import { toast } from "./toast.ts";
import type { AuthMe, Person } from "./types.ts";

// What the last sign-in through the relay came back with (?signin=…, server/api/signin.ts), taken off the address
// once: the sign-in page says it.
export const signinNote = (() => {
  const note = new URLSearchParams(location.search).get("signin");
  if (note) history.replaceState(null, "", location.pathname + location.hash);
  return note;
})();

// Off to the sign-in relay (Google), as the account this machine logged in with.
export function signInElsewhere() {
  location.href = `/api/auth/relay/start?${new URLSearchParams({ origin: location.origin })}`;
}

export async function boot() {
  const me = await getJSON<AuthMe>("/api/auth/me");
  setApp({ auth: me || {}, me: me?.user || null, booted: true });
  document.body.classList.toggle("signed-out", !me?.user);
  if (!me?.user) return;
  loadPeople();
  openLive();
}

export function signedOut() {
  const s = getApp();
  if (!s.me && !s.data) return;
  closeLive();
  clearSide();
  setApp({ me: null, data: null, rows: {}, more: {}, feed: null, open: null, liveId: null });
  boot();
}

// Everyone with an account here, for their avatars and to add to things.
export const loadPeople = loader(async () => {
  const people = (await getJSON<{ people: Person[] }>("/api/people"))?.people || [];
  setApp({ people });
});
