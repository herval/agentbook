import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileOf, outOfMemory } from "../../plugin/shared/store.ts";
import { PREVIEW_URL } from "../config.ts";
import { blobs, relay } from "../core/state.ts";
import { PREVIEW_HOST, fail, ok, readBody, route, safeName } from "../core/http.ts";
import type { Req, Res } from "../core/http.ts";
import type { Answer, MediaAnswer, SignedBody } from "../core/types.ts";
import type { Device } from "../relay.ts";
import type { FileRecord } from "../../plugin/shared/types.ts";
import { isOwner, postRef, viewerName } from "../core/refs.ts";
import { postOr404, seesWork } from "../core/follows.ts";
import { signedFrom, signingOf, toSign, toSignFor } from "../core/commands.ts";
import { PEEK_CSP } from "./queries.ts";

// Files you send: to a post (?post=), as the answer to a file question (?question=), or attached to a message or a
// post you haven't sent yet (?draft=1). They're kept here, and the machine they're for fetches them.
route("POST", "/api/upload", async (req, res, { query }) => {
  const buf = await readBody(req, true);
  const name = safeName(query.get("name"));
  const qid = query.get("question");
  if (qid) {
    const r = relay.resolve(qid);
    const q = r && r.D.store.state.questions.find((x) => x.id === r.local);
    if (!q || q.answered || !isOwner(req, r.D)) return fail(res, 409, "That question is no longer open");
    const up = blobs.upload(buf, { name, owner: req.user.id });
    const args = { post: q.post, qid: q.id, file: blobs.ref(up), user: viewerName(req) };
    // A machine that keeps your passkeys takes it signed: kept here meanwhile, it goes once it is (/api/signed).
    const need = toSign(r.D, "post.answer", args, viewerName(req), 20e3);
    if (need) return fail(res, 428, `${r.D.name} takes this only signed with your passkey.`, { ...toSignFor(req, r.D, need), send: "/api/signed", id: up.id });
    const a = (await relay.command(r.D, "post.answer", args, { by: viewerName(req), wait: 20e3 })) as Answer;
    if (a?.error && a.status) return fail(res, a.status, a.error);
    return ok(res, { id: up.id, ...(a?.queued ? { queued: a.queued, waiting: r.D.name } : {}) });
  }
  if (query.get("draft") === "1") return ok(res, { id: blobs.upload(buf, { name, owner: req.user.id }).id });
  const p = postOr404(req, res, query.get("post"), "own");
  if (!p) return;
  if (p.s.state === "done") return fail(res, 409, "This thread has ended.");
  const up = blobs.upload(buf, { name, owner: req.user.id });
  const args = { post: p.local, files: [blobs.ref(up)], bare: true };
  const need = toSign(p.D, "post.deliver", args, viewerName(req), 20e3);
  if (need) return fail(res, 428, `${p.D.name} takes this only signed with your passkey.`, { ...toSignFor(req, p.D, need), send: "/api/signed", id: up.id });
  const a = (await relay.command(p.D, "post.deliver", args, { by: viewerName(req), wait: 20e3 })) as Answer;
  if (a?.error && a.status) return fail(res, a.status, a.error);
  ok(res, { id: up.id, ...(a?.queued ? { queued: a.queued, waiting: p.D.name } : {}) });
});
// A file you sent, signed after the fact (the 428 its upload answered): to the machine of yours it's signed for.
route("POST", "/api/signed", async (req, res) => {
  const b = await readBody<SignedBody>(req);
  const e = b.signed?.envelope;
  const D = [...relay.devices.values()].find((d) => isOwner(req, d) && signingOf(d)?.machine === e?.machine);
  if (!D) return fail(res, 404, "No machine of yours takes that.");
  if (!["post.deliver", "post.answer"].includes(e.kind)) return fail(res, 400, "Send that from where you started it.");
  const signed = signedFrom(b, D, e.kind, viewerName(req));
  if ("error" in signed) return fail(res, 400, signed.error);
  const a = (await relay.command(D, e.kind, null, { by: viewerName(req), wait: 20e3, signed })) as Answer;
  if (a?.error && a.status) return fail(res, a.status, a.error);
  ok(res, { ok: true, ...(a?.queued ? { queued: a.queued, waiting: D.name } : {}) });
});

export const MIME = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".csv": "text/plain; charset=utf-8",
  ".json": "application/json", ".log": "text/plain; charset=utf-8", ".diff": "text/plain; charset=utf-8", ".patch": "text/plain; charset=utf-8",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".ogg": "audio/ogg",
};
// A post's file: kept here when its bytes came up (or were sent from here), else asked of its machine, a piece at
// a time for one too big to send whole. Others see a file only on a post they see.
// An agent's HTML file opens under the previews' name when there is one (AGENTBOOK_PREVIEW_URL), never under the
// page's own: there, a page made to look like agentbook's sign-in would sit under agentbook's address, and the
// sandbox doesn't stop a form from sending what's typed into it elsewhere. The link there carries a token in place
// of the viewer's sign-in, as a peek link does: made for whoever may see the file, good for an hour. Without a
// previews' name (a server on your own machine), it opens here, sandboxed, as before.
const fileLinks = new Map();
function fileLink(id: string) {
  const now = Date.now();
  for (const [t, l] of fileLinks) if (l.until < now) fileLinks.delete(t);
  for (const [t, l] of fileLinks) if (l.id === id && l.until - now > 30 * 60e3) return t;
  const t = crypto.randomBytes(16).toString("hex");
  fileLinks.set(t, { id, until: now + 60 * 60e3 });
  return t;
}
export const onPreviewName = (req: Req) => !!PREVIEW_HOST && req.headers.host === PREVIEW_HOST;
const isPage = (name) => /\.html?$/i.test(name || "");
route("GET", "/api/files/:id", async (req, res, { params, query }) => {
  const inline = query.get("download") !== "1";
  const r = relay.resolve(params.id);
  const f = r && fileOf(r.D.store.state, r.local);
  // One you sent that its machine hasn't taken yet (it's off): yours, from here.
  const up = !f && blobs.uploadOf(params.id);
  if (onPreviewName(req)) {
    const l = fileLinks.get(String(query.get("t") || ""));
    if (!l || l.id !== params.id || l.until < Date.now()) return fail(res, 404, "This link has run out. Open the file again.");
    if (!f && !up) return fail(res, 404, "Unknown file");
  } else {
    const fp = f && r.D.store.state.sessions[f.post];
    const may = up ? up.owner === req.user.id : f && (isOwner(req, r.D) || (fp && seesWork(req, postRef(relay.idOf(r.D, f.post)))));
    if (!may) return fail(res, 404, "Unknown file");
    if (PREVIEW_HOST && inline && isPage(f?.name || up?.name)) {
      res.writeHead(302, { location: `${PREVIEW_URL}/api/files/${encodeURIComponent(params.id)}?t=${fileLink(params.id)}`, "cache-control": "no-store" });
      return res.end();
    }
  }
  if (up) return blobs.has(up.sha) ? sendBytes(req, res, { name: up.name }, blobs.file(up.sha), inline) : fail(res, 404, "Unknown file");
  if (f.blob && blobs.has(f.blob)) return sendBytes(req, res, f, blobs.file(f.blob), inline);
  const mine = f.stored && r.D.store.files.path(f.stored);
  if (mine && fs.existsSync(mine)) return sendBytes(req, res, f, mine, inline);
  const range = req.headers.range ? String(req.headers.range).slice(0, 100) : undefined;
  const got = (await relay.command(r.D, "read.media", { post: f.post || "", file: f.id, ...(range ? { range } : {}) }, { wait: 120e3 })) as MediaAnswer;
  if (got?.error) return fail(res, got.status || 502, got.error);
  const buf = Buffer.from(got.data || "", "base64");
  keepWhole(r.D, f, got, buf);
  res.writeHead(got.status || 200, { ...fileHeaders(f, inline), "content-length": buf.length, "accept-ranges": "bytes", ...(got.headers?.["content-range"] ? { "content-range": got.headers["content-range"] } : {}) });
  res.end(buf);
});
// A whole file that came from its machine is kept, so it opens without it next time.
function keepWhole(D: Device, f: FileRecord, got: MediaAnswer, buf: Buffer) {
  if (got.status !== 200 || got.headers?.["content-range"] || buf.length !== (got.size ?? buf.length)) return;
  const sha = blobs.put(buf, D.user_id);
  D.store.commit({ t: "file.blob", fid: f.id, blob: sha, size: buf.length });
}
// Thread file `f` of machine `D`, whole: the server's copy, or its machine's (kept here from then on). Who may have it
// is the caller's to check. -> { buf } or { error, status }
export async function fileBytes(D: Device, f: FileRecord): Promise<{ buf: Buffer } | { error: string; status: number }> {
  if (f.blob && blobs.has(f.blob)) return { buf: blobs.read(f.blob) };
  const mine = f.stored && D.store.files.path(f.stored);
  if (mine && fs.existsSync(mine)) return { buf: fs.readFileSync(mine) };
  const got = (await relay.command(D, "read.media", { post: f.post || "", file: f.id }, { wait: 120e3 })) as MediaAnswer;
  if (!got || got.error) return { error: got?.error || `${D.name} didn't send ${f.name}.`, status: got?.status || 502 };
  const buf = Buffer.from(got.data || "", "base64");
  keepWhole(D, f, got, buf);
  return { buf };
}
// A file on disk here: whole, or the piece a video or a sound asks for (Safari won't play one without).
function sendBytes(req: Req, res: Res, f, p, inline) {
  const size = fs.statSync(p).size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  let [start, end] = [0, size - 1];
  if (range && (range[1] || range[2])) {
    [start, end] = range[1] ? [Number(range[1]), range[2] ? Math.min(Number(range[2]), size - 1) : size - 1] : [Math.max(0, size - Number(range[2])), size - 1];
    if (start > end) {
      res.writeHead(416, { "content-range": `bytes */${size}` });
      return res.end();
    }
  }
  const partial = !!range && (range[1] || range[2]);
  res.writeHead(partial ? 206 : 200, {
    ...fileHeaders(f, inline),
    "content-length": size ? end - start + 1 : 0,
    "accept-ranges": "bytes",
    ...(partial ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
  });
  if (!size) return res.end();
  fs.createReadStream(p, { start, end }).pipe(res);
}
// Files come from agents: never let one run scripts on agentbook's origin. A page (an agent's mockup) opens as
// itself, sandboxed like a peek link's: its scripts run, but in a frame that belongs to no site.
export const fileHeaders = (f, inline) => {
  const page = inline && /\.html?$/i.test(f.name);
  return {
    "content-type": page ? "text/html; charset=utf-8" : MIME[path.extname(f.name).toLowerCase()] || "application/octet-stream",
    "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    "x-content-type-options": "nosniff",
    "content-security-policy": page ? PEEK_CSP : "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
  };
};
route("POST", "/api/files/:id/delete", (req, res, { params }) => {
  const r = relay.resolve(params.id);
  const f = r && fileOf(r.D.store.state, r.local);
  if (!f || !isOwner(req, r.D)) return fail(res, 404, "No such file");
  r.D.store.commit({ t: "file.remove", fid: f.id });
  if (f.blob && ![...relay.devices.values()].some((D) => [...D.store.state.files, ...outOfMemory(D.store.state, "files")].some((x) => x.blob === f.blob)) && !blobs.uploadsWith(f.blob)) blobs.remove(f.blob);
  ok(res);
});
