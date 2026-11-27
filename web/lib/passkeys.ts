// Passkeys: what signs what your machines run. A machine of yours that keeps your
// passkeys takes some commands only signed: the server says what to sign, and post() (api.ts) sends it again signed.
import { getJSON, post } from "./api.ts";
import { useApp } from "./store.ts";
import { toast } from "./toast.ts";
import type { Passkeys } from "./types.ts";

const S = { get me() { return useApp.getState().me; } };
export const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const fromB64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4)), (c) => c.charCodeAt(0));
// JSON with its keys sorted at every level and no spaces: the bytes a machine checks (plugin/shared/signed.ts).
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}
// Why this page can't use passkeys, or null when it can: they need https (or localhost) and a browser that has them.
export function passkeysOff() {
  if (!window.PublicKeyCredential || !navigator.credentials?.create) return "This browser can't use passkeys.";
  if (!window.isSecureContext || /^[\d.]+$|^\[/.test(location.hostname)) return "Passkeys work on this page once it's on https, or at localhost rather than an IP address.";
  return null;
}
// Your passkey's signature on what a machine of yours takes only signed: WebAuthn's, over the SHA-256 of its
// canonical JSON. `keys`: the passkeys that may sign it.
export async function signWithPasskey(what, keys = []) {
  const off = passkeysOff();
  if (off) throw new Error(`Not signed: ${off}`);
  if (!keys?.length) throw new Error("No registered passkey is trusted for this action. Open Settings → Passkeys to approve or recover one.");
  const challenge = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(what)));
  let cred;
  try {
    cred = await navigator.credentials.get({ publicKey: { challenge, rpId: location.hostname, allowCredentials: (keys || []).map((id) => ({ type: "public-key", id: fromB64u(id) })), userVerification: "required", timeout: 120000 } });
  } catch (e) {
    throw new Error(e?.name === "NotAllowedError" ? "No passkey was used. If this device has no matching passkey, open Settings → Passkeys for recovery." : `Not signed: ${e?.message || e}`);
  }
  if (!cred) throw new Error("Not signed.");
  const r = cred.response;
  return { key: cred.id, authenticatorData: b64u(r.authenticatorData), clientDataJSON: b64u(r.clientDataJSON), signature: b64u(r.signature) };
}

// One Face ID for a while: this browser makes a key it can't hand out, your passkey
// signs it once for SESSION_HOURS (12 hours), and it signs each command until then, for every machine that
// takes one (the server says how long each does, `hours`). A routine's OK and a change of passkeys stay the
// passkey's own. It's kept in this browser (IndexedDB) for you only, and goes when you sign out or press Ask again.
const SESSION_HOURS = 12;
const SESSION_STORE = "session";
let sessionHeld; // this tab's copy: the kept one, null for none, undefined until read
function sessionDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open("agentbook-signing", 1);
    open.onupgradeneeded = () => open.result.createObjectStore(SESSION_STORE);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}
async function sessionStore(mode, fn) {
  const db = await sessionDb();
  try {
    return await new Promise((resolve, reject) => {
      const req = fn(db.transaction(SESSION_STORE, mode).objectStore(SESSION_STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}
// The browser's key now, or null: yours, not run out. Without IndexedDB (a private window), this tab's own.
export async function sessionNow() {
  if (sessionHeld === undefined) sessionHeld = await sessionStore("readonly", (s) => s.get("current")).catch(() => null) || null;
  const s = sessionHeld;
  if (!s || s.user !== S.me?.username || !(Date.parse(s.envelope?.expires) > Date.now())) return null;
  return s;
}
async function sessionKeep(s) {
  sessionHeld = s;
  await sessionStore("readwrite", (st) => (s ? st.put(s, "current") : st.delete("current"))).catch(() => {});
}
// Sign a command as a 428 asks: with the browser's key while it holds (one signed by a passkey that may sign this,
// for no longer than its machine takes, with a few minutes left), else with a new one your passkey signs now; with
// the passkey itself where a browser's key won't do.
export async function signCommand(what, keys = [], hours = 0) {
  if (!(hours > 0) || !window.crypto?.subtle || !what?.machine) return signWithPasskey(what, keys);
  let s = await sessionNow();
  const ok = (x) => x && keys.includes(x.sig.key) && Date.parse(x.envelope.expires) - Date.now() > 10 * 60e3 && Date.parse(x.envelope.expires) - Date.parse(x.envelope.at) <= hours * 3600e3;
  if (!ok(s)) {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const spki = b64u(await crypto.subtle.exportKey("spki", pair.publicKey));
    const now = Date.now();
    const envelope = { v: 1, kind: "session", key: { alg: -7, spki }, at: new Date(now).toISOString(), expires: new Date(now + Math.min(SESSION_HOURS, hours) * 3600e3).toISOString() };
    s = { user: S.me?.username, private: pair.privateKey, envelope, sig: await signWithPasskey(envelope, keys) };
    await sessionKeep(s);
    toast(`Signed for ${Math.min(SESSION_HOURS, hours)} hours in this browser: no Face ID or Touch ID again until ${untilText(envelope.expires)}.`);
  }
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, s.private, new TextEncoder().encode(canonicalJson(what)));
  return { key: s.sig.key, session: { envelope: s.envelope, sig: s.sig }, signature: b64u(signature) };
}
// Ask again: the browser's key goes, and the next command asks for your passkey.
export const sessionEnd = () => sessionKeep(null);
// When a time later today or tomorrow comes: "21:40", "tomorrow at 09:40".
export function untilText(iso) {
  const d = new Date(iso);
  const hm = d.toTimeString().slice(0, 5);
  if (d.toDateString() === new Date().toDateString()) return hm;
  return d.toDateString() === new Date(Date.now() + 86400e3).toDateString() ? `tomorrow at ${hm}` : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${hm}`;
}
// Register the credential on this page. Settings shows which machines still need to approve it.
export async function makePasskey() {
  const off = passkeysOff();
  if (off) return toast(off), false;
  const o = await post<{ challenge: string; user: { id: string; name: string; displayName: string }; exclude?: string[] }>("/api/passkeys/options", {});
  if (!o.ok) return false;
  const opts = o.data;
  let cred;
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        challenge: fromB64u(opts.challenge),
        rp: { name: "agentbook", id: location.hostname },
        user: { id: fromB64u(opts.user.id), name: opts.user.name, displayName: opts.user.displayName },
        pubKeyCredParams: [-7, -8, -257].map((alg) => ({ type: "public-key", alg })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
        excludeCredentials: (opts.exclude || []).map((id) => ({ type: "public-key", id: fromB64u(id) })),
        timeout: 120000,
      },
    });
  } catch (e) {
    toast(e?.name === "NotAllowedError" ? "No passkey made: the prompt closed." : e?.name === "InvalidStateError" ? "This device has a passkey for agentbook already." : `No passkey made: ${e?.message || e}`);
    return false;
  }
  const r = cred.response;
  const spki = r.getPublicKey?.();
  if (!spki) return toast("This browser doesn't hand over a passkey's public key, so agentbook can't use it. Try another browser."), false;
  const ua = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || (/iPhone|iPad/.test(navigator.userAgent) ? "iPhone" : /Android/.test(navigator.userAgent) ? "Android" : /Mac/.test(navigator.userAgent) ? "Mac" : /Windows/.test(navigator.userAgent) ? "Windows" : "this device");
  const made = await post<{ spread?: string[] }>("/api/passkeys", { id: cred.id, alg: r.getPublicKeyAlgorithm?.(), spki: b64u(spki), name: `Passkey on ${ua}`, clientDataJSON: b64u(r.clientDataJSON) });
  if (!made.ok) return false;
  toast(made.data.spread?.length ? "Passkey saved. In Settings → Passkeys, approve it for each machine that still needs it." : "Passkey saved.");
  return true;
}
// Signing needs a passkey of yours: the one you have, or one made here now. True once you have one.
export async function ensurePasskey() {
  const off = passkeysOff();
  if (off) return toast(off), false;
  const have = await getJSON<Passkeys>("/api/passkeys");
  return have?.passkeys?.some(k => !k.removing) ? true : makePasskey();
}
// Signing for a machine of yours that keeps none of your passkeys yet: it gets them (made here first when you have
// none), and takes what can run something only when you sign it. There's no off.
export async function signMachine(name) {
  if (!(await ensurePasskey())) return false;
  const r = await post(`/api/machines/${encodeURIComponent(name)}/signing`, { on: true, origin: location.origin, rp_id: location.hostname });
  if (r.ok) toast(r.data.queued ? `${name} is off: it takes your passkeys once it's back.` : `${name} takes what can run something only when you sign it now.`);
  return r.ok;
}

