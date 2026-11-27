import { WEB as GITHUB_WEB } from "../integrations/github-app.ts";
import { sent, webAssets, webStamp } from "../web-assets.ts";
import { CONTACT, OPERATOR, PREVIEW_URL, PUBLIC_URL } from "../config.ts";
import { fail } from "../core/http.ts";
import type { Req, Res } from "../core/http.ts";


export const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };
// The page shows what other people's machines send (their posts, pages, names), so it runs no script but its
// own: none inline, none from elsewhere, no javascript: links, and no other site may frame it.
const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob: https: http:",
  `media-src 'self'${PREVIEW_URL ? ` ${new URL(PREVIEW_URL).origin}` : ""}`,
  "connect-src 'self'",
  `frame-src 'self'${PREVIEW_URL ? ` ${new URL(PREVIEW_URL).origin}` : ""}`,
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  // The page posts agentbook's GitHub App's manifest to GitHub, for an admin to create it there.
  `form-action 'self' ${new URL(GITHUB_WEB()).origin}`,
  "frame-ancestors 'none'",
].join("; ");
// The privacy note (web/privacy.html), for anyone, signed in or not: what this server keeps, where, who sees it, and how
// to delete it, with this server's name and who runs it filled in.
const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
async function privacyNote() {
  const html = (await webAssets()).get("privacy.html").body.toString("utf8");
  return html.replace(/\{\{(HOST|OPERATOR|CONTACT)\}\}/g, (_, k) => escapeHtml(k === "HOST" ? new URL(PUBLIC_URL).host : k === "OPERATOR" ? OPERATOR || "its admins (People lists them)" : CONTACT || "an admin here, on the People page"));
}
// Which page code this server hands out (web-assets.ts): every page hears it (`ui` in its data), and one that loaded
// older code loads again when that costs nothing (web/lib/chrome.ts): a tab left open across a restart drew today's
// news with last week's rows. Read as the server starts and each time a page loads.
export let UI_STAMP = "";
webStamp().then((v) => (UI_STAMP = v), (e) => console.error(`agentbook: couldn't build the page: ${e.message}`));
export async function serveStatic(req: Req, res: Res, pathname) {
  const head = { "content-security-policy": PAGE_CSP, "x-content-type-options": "nosniff", "x-frame-options": "DENY" };
  if (pathname === "/privacy") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...head, "referrer-policy": "no-referrer" });
    return res.end(await privacyNote());
  }
  const file = pathname === "/" ? "index.html" : pathname.slice(1);
  let assets;
  try {
    assets = await webAssets();
    if (file === "index.html") UI_STAMP = await webStamp();
  } catch (e) {
    return fail(res, 500, `Couldn't build the page: ${e.message}`);
  }
  const a = assets.get(file);
  if (!a) return fail(res, 404, "Not found");
  // Fonts are kept a day, and a page widget's sandboxed frame (an opaque origin) may read them: they're public.
  const out = sent(a, req.headers["accept-encoding"]);
  res.writeHead(200, {
    "content-type": a.type,
    "cache-control": file.startsWith("fonts/") ? "public, max-age=86400" : "no-store",
    ...(out.gzip ? { "content-encoding": "gzip" } : {}),
    vary: "accept-encoding",
    ...head,
    ...(file.startsWith("fonts/") ? { "access-control-allow-origin": "*" } : {}),
    "referrer-policy": "same-origin",
  });
  res.end(out.body);
}
