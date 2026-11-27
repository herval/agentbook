// What an OpenClaw session's history says, read the way agentbook shows it: who said what (yoursOf, cronPrompt), the
// files a message holds or a reply sends (mediaOf, mediaLines, sentOf, toolSent), where a turn begins and ends, and
// what an entry adds to a thread's steps (fold). Nothing here asks the gateway or knows a thread: openclaw.ts does.

import { textOf } from "../../../shared/text.ts";
import path from "node:path";
import { addSay, addTool, blank, toolDone } from "../kit/steps.ts";
import type { DriverDigest } from "../kit/steps.ts";

// A thread's steps, and the turn its agent last said something in (`spoke`): a claude-cli agent's record of a run says
// again all it said in that turn (see joined).
export type OcDigest = DriverDigest & { spoke?: number };

export const keyAgent = (key) => String(key).split(":")[1] || "main"; // "agent:<agent id>:…"

// What a reply says, and the files its MEDIA: lines send (`sent`). An agent sends a file by naming it on a
// line of its own, outside code: `MEDIA:<where it is>`, a path on the gateway's machine, a link or a file's
// name. OpenClaw sends the file and leaves the line out; so does agentbook, which shows the file with the
// reply instead (see sentOf), and leaves out the blank line around it too. A link stays, as a picture or a
// link. "Media: three clips" is just words.
const MEDIA_LINE = /^\s*MEDIA:\s*[`"'([{]*(?:[\w+.-]+:\/\/|(?:file|data):|[~/\\.]|[a-z]:[\\/]|[^\s:]*[\\/]|\S+\.\w{1,10}\W*$)/i;
const FENCE = /^\s*(`{3,}|~{3,})/;
const PICTURE = /\.(png|jpe?g|gif|webp)([?#]|$)/i;
export function mediaLines(text) {
  const sent = [];
  if (!/MEDIA:/i.test(text || "")) return { text: text || "", sent };
  const out = [];
  let fence = null;
  let cut = false;
  for (const line of text.split("\n")) {
    const f = FENCE.exec(line)?.[1];
    if (f && !fence) fence = f;
    else if (f && f[0] === fence[0] && f.length >= fence.length) fence = null;
    else if (!fence && MEDIA_LINE.test(line)) {
      const where = line.replace(/^\s*MEDIA:\s*/i, "").trim().replace(/^[`"'[{(]+/, "").replace(/[`"'\\})\],]+$/, "");
      if (/^https?:\/\//i.test(where)) out.push(PICTURE.test(where) ? `![](${where})` : where);
      else if (where && !/^data:/i.test(where)) sent.push(where);
      cut = !/^https?:\/\//i.test(where);
      continue;
    }
    if (cut && !line.trim() && !out.at(-1)?.trim()) continue;
    cut = false;
    out.push(line);
  }
  return { text: out.join("\n").trim(), sent };
}
export const withoutMedia = (text) => mediaLines(text).text;

// What you wrote, of a message OpenClaw keeps as yours: without what it put before it (what happened since,
// as "System: …" lines; that it resumed a claude-cli session; the skills you named; where the files you
// sent are and what's in them) or after it (where it saved the files agentbook sent with it; the pictures it
// hands a claude-cli agent, as `@<path>` lines; yours come as the message's media). null when OpenClaw wrote
// all of it: another session's or a tool's result handed to the agent ("[Inter-session message]"), a
// reminder, a command that finished, a turn a restart cut short. OpenClaw says whose a message is (`provenance`), except in a claude-cli agent's
// history, which it reads back from Claude Code's transcript; there its words tell.
// A command its agent left running in the background wakes the agent when it ends, with "Exec completed (<id>, code 0) ::
// <the end of its output>" ("Exec failed (…)" and, from a node, "Exec finished (node=…)") as a message with no `provenance`:
// OpenClaw's tools.exec.notifyOnExit, on unless turned off.
const RESUMED = /^OpenClaw resumed this CLI session after prompt content changed\.[^\n]*\n*/;
const NOTES = /^(System:[^\n]*(\n|$))+\s*/;
const SKILLS = /^Use the following explicitly referenced skills for this request\.[^\n]*\n(?:[^\n]*\n)*?\nUser request:\n/;
const CLI_IMAGES = /(\s*@\S*[\\/]\.?openclaw-cli-images[\\/]\S+)+\s*$/;
const CUT = /^[\w:]{0,7}\n?\.\.\.\(truncated\)\.\.\.$/; // all that's left of notes OpenClaw's history cut short
const OPENCLAWS = [/^\[System\] /, /^A scheduled (reminder has been|cron event was) triggered\./, /^An async command (you ran earlier|the user already approved|completion event was triggered|did not run)/, /^Exec (completed|failed) \([\w-]+, [^)\n]+\)( :: |\n|$)/, /^Exec (started|finished|denied) \(node=/];
// A message with files: where each is ("[media attached: …]"), then what OpenClaw saw in them ("[Video]",
// "Description: …"), with what you wrote as "User text:".
const ATTACHED = /^(\[media attached[^\]\n]*\]\s*)+/;
const TYPED = /(?:^|\n)User text:\n([\s\S]*?)(?=\n\[media attached|\n(?:Description|Transcript):\n|\n\n\[(?:Image|Video|Audio)[ \]]|$)/;
const SEEN = /^\[(Image|Video|Audio)( \d+\/\d+)?\]\n/;
const SAVED = /(\s*\[media attached[^\]\n]*\])+\s*$/;
function withoutAttached(t) {
  if (!ATTACHED.test(t)) return t.replace(SAVED, "");
  const typed = TYPED.exec(t);
  if (typed) return typed[1];
  const rest = t.replace(ATTACHED, "");
  return SEEN.test(rest) ? "" : rest;
}
// `provenance`: where OpenClaw says the message came from (a message another session sent isn't yours).
export function yoursOf(text, provenance?: { kind?: string } | null) {
  if (provenance?.kind && provenance.kind !== "external_user") return null;
  if (String(text || "").includes("[Inter-session message]")) return null;
  const t = withoutAttached(String(text || "").replace(RESUMED, "").replace(NOTES, "").replace(SKILLS, "")).replace(CLI_IMAGES, "").trim();
  return OPENCLAWS.some((re) => re.test(t)) ? null : CUT.test(t) ? "" : t;
}
// What a cron job tells its agent, in a session of the job's own or one it names (`--session session:<name>`):
// "[cron:<job> <name>] <its prompt>", then the time and what OpenClaw tells a run nobody's watching. It comes with no
// `provenance` (OpenClaw 2026.9.4), so only its words say it isn't yours. { job, name, text }, or null.
const CRON_PROMPT = /^\[cron:(\S{1,100}) (.*?)\]\s*([\s\S]*)$/;
export function cronPrompt(text) {
  const m = CRON_PROMPT.exec(String(text || ""));
  if (!m) return null;
  const tail = m[3].lastIndexOf("\nCurrent time: ");
  return { job: m[1], name: m[2].trim(), text: (tail < 0 ? m[3] : m[3].slice(0, tail)).trim() };
}

// What a history entry is, past its role. A message from elsewhere (a cron job, another session) came in as a user
// message, but the gateway shows it as "Forwarded from …", with role assistant: it starts a turn, and it's nobody's
// reply. A claude-cli agent's history is read back from Claude Code's transcript, where a tool's result is a message
// from the user: it starts nothing. And after that transcript comes OpenClaw's own record of the run: all it said in
// the turn joined into one, which the last of what it said has already answered. (Read from a real claude-cli
// job's history, 2026-11-07.)
export const forwarded = (m) => m?.role === "assistant" && !!(m.senderSession || m.provenance?.kind);
export const toolResults = (m) => m?.role === "user" && Array.isArray(m.content) && m.content.length > 0 && m.content.every((c) => /^tool_?result$/i.test(c?.type || ""));
export const startsTurn = (m) => (m?.role === "user" && !toolResults(m)) || forwarded(m);
export const midTurn = (m) => m?.role === "toolResult" || toolResults(m) || /^tool_?use$/i.test(m?.stopReason || "");
export const joined = (m) => m?.role === "assistant" && String(m.idempotencyKey || m.__openclaw?.idempotencyKey || "").startsWith("cli-assistant:");

// The pictures, sound, video and files in a message. OpenClaw keeps each as a piece of the message's content
// (an image, audio or video piece, or an attachment's), and its history leaves their bytes out. A file
// agentbook makes of one keeps how to ask OpenClaw for it (see media): its artifact id when it has one (what
// the agent made), or else where it is (a picture you sent): its message's place in the transcript (`seq`),
// and which of that message's media it is.
const KINDS = { image: "image", input_image: "image", image_url: "image", audio: "audio", input_audio: "audio", video: "video", input_video: "video", file: "file", input_file: "file", attachment: "file" };
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg", "application/pdf": "pdf", "text/plain": "txt", "text/markdown": "md", "text/csv": "csv", "application/json": "json" };
const NAMED = { image: "picture", audio: "sound", video: "video", file: "file" };
export const MIME = { ...Object.fromEntries(Object.entries(EXT).map(([mime, ext]) => [ext, mime])), jpeg: "image/jpeg", wav: "audio/wav", heic: "image/heic" };
export function mediaOf(m, seq?: number | null) {
  const out = [];
  for (const c of Array.isArray(m?.content) ? m.content : []) {
    const kind = KINDS[String(c?.type || "").toLowerCase()];
    if (!kind) continue;
    const a = c.attachment && typeof c.attachment === "object" ? c.attachment : c;
    const mime = String(a.mimeType || a.media_type || a.source?.media_type || a.source?.mimeType || "").toLowerCase().split(";")[0].trim();
    const title = [c.fileName, c.filename, a.label, c.title, c.alt].find((v) => typeof v === "string" && v.trim())?.trim() || null;
    out.push({ name: nameOf(title, mime, kind), size: Number(a.sizeBytes ?? a.source?.sizeBytes ?? c.bytes) || 0, ref: { artifact: c.artifactId || a.artifactId || null, seq: Number.isInteger(seq) ? seq : null, n: out.length, type: kind, title } });
  }
  return out;
}
// Its name, with the extension its kind of file has, so it shows (and plays) as what it is: a picture named
// .png that OpenClaw keeps as a JPEG is a .jpg.
const MEDIA_EXT = /\.(png|jpe?g|gif|webp|svg|mp4|mov|m4v|webm|mp3|m4a|wav|ogg)$/i;
function nameOf(title, mime, kind) {
  const base = path.posix.basename(String(title || NAMED[kind]).replace(/\\/g, "/")).replace(/[^\w.\- ]+/g, "_").slice(0, 80).trim() || NAMED[kind];
  const ext = EXT[mime] || "";
  if (!ext || new RegExp(`\\.${ext === "jpg" ? "jpe?g" : ext}$`, "i").test(base)) return base;
  return `${MEDIA_EXT.test(base) && !mime.startsWith("text/") ? base.replace(MEDIA_EXT, "") : base}.${ext}`;
}
// The files a reply's MEDIA: lines send, as files that say where each is on the gateway's machine (`source`),
// named as OpenClaw names them: one it keeps as "<name>---<uuid>.<ext>" is <name>.<ext>. Their size is known
// once one is fetched.
const MIMES = { ...Object.fromEntries(Object.entries(EXT).map(([mime, ext]) => [ext, mime])), jpeg: "image/jpeg", m4v: "video/mp4", wav: "audio/wav" };
const KEPT_AS = /---[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?=\.\w+$|$)/i;
export function sentOf(sources, seq = null) {
  return sources.map((source) => {
    const base = path.posix.basename(source.replace(/\\/g, "/"));
    const mime = MIMES[(/\.(\w{1,10})$/.exec(base)?.[1] || "").toLowerCase()] || "";
    const kind = /^(image|video|audio)\//.exec(mime)?.[1] || "file";
    const title = base.replace(KEPT_AS, "");
    return { name: nameOf(title, mime, kind), size: 0, ref: { source, seq: Number.isInteger(seq) ? seq : null, type: kind, title } };
  });
}
export const sentIn = (m) => (Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }]).filter((c) => String(c?.type || "").toLowerCase() === "text").flatMap((c) => mediaLines(c.text).sent);
// The files an agent sent with OpenClaw's message tool while it worked (a claude-cli agent's is
// mcp__openclaw__message): Discord shows each with what it sent, the agent's reply says it "posted it above",
// and here they're that reply's files, as a MEDIA: line's are. Only what it sent where you talk to it: a send
// naming no other route (OpenClaw sends it to this conversation), or one naming this conversation (the session
// key's last part, its channel's id). A link, or bytes in the call itself (`buffer`), isn't a file on the
// gateway's machine.
const MESSAGE_TOOL = /^(?:\w+__)?message$/i;
const SENDS = new Set(["send", "sendwitheffect", "sendattachment", "reply", "thread-reply", "upload-file"]);
const ROUTES = ["target", "targets", "to", "recipient", "recipients", "chatId", "chat_id", "channelId", "channel_id", "conversationId", "conversation_id", "threadId", "thread_id", "roomId", "room_id", "groupId", "group_id"];
const MEDIA_ARGS = ["media", "mediaUrl", "path", "filePath", "fileUrl", "url"];
const firstOf = (a, keys) => keys.map((k) => a?.[k]).find((v) => typeof v === "string" && v.trim())?.trim();
export function toolSent(m, key) {
  const out = [];
  const here = String(key).split(":").at(-1);
  for (const c of Array.isArray(m?.content) ? m.content : []) {
    const type = String(c?.type || "").toLowerCase();
    if ((type !== "toolcall" && type !== "tool_use") || !MESSAGE_TOOL.test(String(c.name || ""))) continue;
    let a = c.arguments ?? c.input;
    if (typeof a === "string") {
      try {
        a = JSON.parse(a);
      } catch {
        a = null;
      }
    }
    if (!a || typeof a !== "object" || !SENDS.has(String(a.action || "").toLowerCase()) || a.dryRun === true || a.dry_run === true) continue;
    const routes = ROUTES.flatMap((f) => [a[f]].flat()).filter((v) => (typeof v === "string" && v.trim()) || typeof v === "number").map(String);
    if (routes.length && !routes.some((v) => v.includes(here))) continue;
    const one = firstOf(a, MEDIA_ARGS.slice(0, -1));
    if (one) out.push(one);
    for (const u of Array.isArray(a.mediaUrls) ? a.mediaUrls : []) if (typeof u === "string" && u.trim()) out.push(u.trim());
    for (const x of Array.isArray(a.attachments) ? a.attachments : []) {
      const v = firstOf(x, MEDIA_ARGS);
      if (v) out.push(v);
    }
  }
  return [...new Set(out)].filter((s) => !/^(?:https?|data):/i.test(s));
}
// A file a turn sent twice (with a MEDIA: line, and as the media OpenClaw made of it; or in two lines) is on
// its reply once.
export const once = (media) => media.filter((x, i) => !x.ref?.source || !media.some((y, j) => y.name.toLowerCase() === x.name.toLowerCase() && (!y.ref?.source || j < i)));

// A history entry's id in OpenClaw (or, for one without, what it says, and when).
export const idOf = (entry) => {
  const m = entry?.message || entry;
  return entry?.id || m?.id || entry?.__openclaw?.id || `${m?.role}:${m?.timestamp || ""}:${textOf(m?.content).slice(0, 60)}`;
};
// Where in its session's history an entry is (OpenClaw numbers them from 1), or 0 when it doesn't say.
export const seqOf = (entry) => Number((entry?.message || entry)?.__openclaw?.seq) || 0;

// What the agent's entries add to a digest: what it said (the last of which it returns), the tools it used
// and how they went.
export function fold(d: OcDigest, m, id, at, cwd?: string) {
  let said = null;
  const toolDoneWith = (c) => toolDone(d, c.toolCallId ?? c.tool_use_id ?? c.id, { at, error: c.isError || c.is_error ? textOf(c.content) || "Failed" : null, output: textOf(c.content) });
  if (forwarded(m) || (joined(m) && d.spoke === d.turn)) return said;
  if (m.role === "assistant") {
    if (m.model) d.model = m.model;
    // An agent on the claude-cli runtime records its tool calls and their results in the reply itself.
    for (const c of Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }]) {
      const type = String(c?.type || "").toLowerCase();
      const text = type === "text" ? withoutMedia(c.text) : "";
      if (text.trim()) {
        addSay(d, { id: `${id}:say`, at, text });
        said = text;
        d.spoke = d.turn;
      } else if (type === "toolcall" || type === "tool_use") addTool(d, { id: c.id ?? c.toolCallId, at, name: c.name, args: c.arguments ?? c.input, cwd });
      else if (type === "tool_result" || type === "toolresult") toolDoneWith(c);
    }
    if (m.usage?.input) d.context = Number(m.usage.input) + Number(m.usage.cacheRead || 0);
  } else if (m.role === "toolResult") {
    toolDone(d, m.toolCallId, { at, error: m.isError ? textOf(m.content) || "Failed" : null, output: textOf(m.content) });
  } else if (toolResults(m)) m.content.forEach(toolDoneWith);
  return said;
}

// Whether a cron job's session has something to show: a job with nothing to report leaves no thread. Its session has
// only what the job said then, since OpenClaw doesn't keep a NO_REPLY. Once its run is over, so its thread doesn't
// start empty.
export const reported = (r) => {
  const entries = r?.messages || [];
  const last = entries.at(-1);
  return (
    !midTurn(last?.message || last) &&
    entries.some((entry) => {
      const m = entry?.message || entry;
      return m?.customType === "run-failed-before-reply" || (m?.role === "assistant" && (!!fold(blank(), m, "", null) || mediaOf(m).length > 0));
    })
  );
};
