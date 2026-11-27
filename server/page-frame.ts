// A page's html widget, as a document of its own for its frame: what an agent wrote (its html, css and js, and
// the data they show), in agentbook's colors and type, with a little of agentbook's own script that sizes the
// frame and passes a click's question or link up to the page.
//
// It's served sandboxed (WIDGET_CSP): its scripts run, but in a frame that belongs to no site, so it has no
// cookies, no storage and nothing of agentbook's. It has no network either: no fetch, no pictures or scripts
// from elsewhere, no forms, no popups. So it can't send anything anywhere, or tell anyone who's looking. The
// one exception is agentbook's own fonts, from this server (ui/fonts), as the page has them.

export const WIDGET_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src data: blob:",
  "media-src data: blob:",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

export const WIDGET_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": WIDGET_CSP,
};

// agentbook's look, so a widget fits the page without trying: its colors (the ones its charts use too), type,
// buttons, fields and tables.
const BASE_CSS = `
:root {
  --card: #ffffff; --well: #f3f4f6; --ink: #121821; --ink-2: #4a5462; --ink-3: #8a93a0; --line: #e5e8ec; --line-2: #d3d8de;
  --sun: #ffd23f; --sun-card: #fff6d6; --red: #c8402c; --green: #23845a;
  --c1: #2a78d6; --c2: #eb6834; --c3: #1baf7a; --c4: #eda100; --c5: #e87ba4; --c6: #008300; --c7: #4a3aa7; --c8: #e34948;
  --font: "Geist", ui-sans-serif, system-ui, sans-serif; --mono: "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace;
  color-scheme: light;
}
*, *::before, *::after { box-sizing: border-box; }
html { background: transparent; }
body { display: flow-root; margin: 0; color: var(--ink); font: 400 15px/1.45 var(--font); -webkit-font-smoothing: antialiased; font-feature-settings: "tnum" 1; overflow-wrap: anywhere; }
h1, h2, h3, h4 { margin: 0 0 8px; font-weight: 650; line-height: 1.25; }
h1 { font-size: 20px; } h2 { font-size: 17px; } h3 { font-size: 15px; } h4 { font-size: 14px; }
p { margin: 0 0 10px; }
small, .muted { color: var(--ink-3); }
a { color: inherit; text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--line-2); }
code { font-family: var(--mono); font-size: 0.88em; }
:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; border-radius: 6px; }
button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; padding: 7px 13px; border: 0; border-radius: 10px; background: var(--well); color: var(--ink); font: 550 14px var(--font); cursor: pointer; }
button:hover { background: #e8eaee; }
button.primary { background: var(--ink); color: #fff; }
button.primary:hover { background: #2a3442; }
button:disabled { opacity: 0.5; cursor: default; }
input, select, textarea { min-width: 0; padding: 7px 10px; border: 0; border-radius: 9px; background: var(--well); color: var(--ink); font: 400 14px var(--font); outline: none; }
input:focus, select:focus, textarea:focus { background: #fff; box-shadow: inset 0 0 0 1.5px var(--ink); }
input[type="range"] { padding: 0; background: none; accent-color: var(--ink); }
input[type="checkbox"], input[type="radio"] { accent-color: var(--ink); }
label { color: var(--ink-2); font-size: 13px; font-weight: 550; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { color: var(--ink-3); font-size: 12.5px; font-weight: 550; text-align: left; }
th, td { padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
svg { max-width: 100%; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }
`;

// agentbook's part, before the widget's own:
// - `agentbook.data`: its own data.
// - `agentbook.filters` and `agentbook.widgets`: the page's filters as you've picked them ({ service: "erp-sync" }) and
//   its other widgets (their data, not their code), and `agentbook.on(fn)`, called with both once they're known
//   and whenever they change.
// - `agentbook.ranges`: a time filter's period as dates ({ when: { from, to } }).
// - `agentbook.filter(id, value)`: narrow the page (null shows all again).
// - `await agentbook.query(params)`: ask the live routine that keeps this widget, with params (and the page's
//   filters); the answer is this widget's data as it returned it. A live routine also refreshes `agentbook.data`
//   while the page is open, and `agentbook.on(fn)` is called then too.
// - `agentbook.ask(text)`: fill the page's "Ask for a change" box, for you to send.
// - `agentbook.open(url)`: a web page, in a new tab. A link clicked in it opens the same way.
// The page takes a filter, a question or a link only right after a click. It's told how tall the widget is
// whenever that changes, and when its document is going away (its code opening something else in its place).
const BRIDGE_JS = `(() => {
  const top = parent;
  const send = top.postMessage.bind(top);
  const post = (m) => send({ agentbook: 1, ...m }, "*");
  const el = document.getElementById("agentbook-data");
  let data = null;
  try { data = JSON.parse(el ? el.textContent : "null"); } catch {}
  let page = null;
  const fns = [];
  const asked = new Map();
  let q = 0;
  window.agentbook = Object.freeze({
    get data() { return data; },
    query: (params) => new Promise((resolve, reject) => {
      const id = ++q;
      asked.set(id, { resolve, reject });
      post({ type: "query", id, params: params && typeof params === "object" ? params : {} });
    }),
    get filters() { return page ? page.filters : {}; },
    get widgets() { return page ? page.widgets : []; },
    get ranges() { return page ? page.ranges : {}; },
    on(fn) { if (typeof fn !== "function") return; fns.push(fn); if (page) fn(page); },
    filter: (id, value) => post({ type: "filter", id: String(id ?? ""), value: value == null || value === "" ? null : String(value) }),
    ask: (text) => post({ type: "ask", text: String(text ?? "").slice(0, 4000) }),
    open: (url) => post({ type: "open", url: String(url ?? "") }),
  });
  addEventListener("message", (e) => {
    const m = e.data;
    if (e.source !== top || !m || m.agentbook !== 1) return;
    if (m.type === "answer") {
      const a = asked.get(m.id);
      asked.delete(m.id);
      if (a) m.error ? a.reject(new Error(m.error)) : a.resolve(m.data);
      return;
    }
    if (m.type !== "page") return;
    if (m.self != null) data = m.self;
    page = Object.freeze({ filters: Object.freeze({ ...(m.filters || {}) }), ranges: Object.freeze({ ...(m.ranges || {}) }), widgets: Object.freeze(m.widgets || []) });
    for (const fn of fns) try { fn(page); } catch (err) { console.error(err); }
  });
  document.addEventListener("click", (e) => {
    const a = e.target instanceof Element && e.target.closest("a[href]");
    if (!a || e.defaultPrevented || a.getAttribute("href").startsWith("#")) return;
    e.preventDefault();
    post({ type: "open", url: a.href });
  });
  let last = 0;
  const size = () => {
    const h = Math.ceil(document.body ? document.body.getBoundingClientRect().height : 0);
    if (h && h !== last) post({ type: "size", height: (last = h) });
  };
  addEventListener("DOMContentLoaded", () => new ResizeObserver(size).observe(document.body));
  addEventListener("load", size);
  addEventListener("pagehide", () => post({ type: "leaving" }));
  post({ type: "ready" });
})();`;

// Data goes in a script tag as JSON, which "</script>" and "<!--" inside it can't break out of.
const jsonIn = (v: unknown): string => JSON.stringify(v ?? null).replace(/[<\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
// The page's fonts, from this server (ui/fonts/fonts.css says the same): inline, since the frame loads no stylesheet.
const FONT_CSS = `@font-face { font-family: "Geist"; font-style: normal; font-weight: 100 900; font-display: swap; src: url("/fonts/Geist-Variable.woff2") format("woff2"); }
@font-face { font-family: "Geist Mono"; font-style: normal; font-weight: 100 900; font-display: swap; src: url("/fonts/GeistMono-Variable.woff2") format("woff2"); }`;

export function widgetDocument(w: { title?: string | null; data?: { html?: unknown; css?: unknown; js?: unknown; data?: unknown } | null }): string {
  const d = w.data || {};
  const html = String(d.html || "") || '<p class="muted">Nothing in it yet.</p>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${String(w.title || "Widget").replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"))}</title>
<style>${FONT_CSS}${BASE_CSS}</style>
<script type="application/json" id="agentbook-data">${jsonIn(d.data)}</script>
<script>${BRIDGE_JS}</script>
${d.css ? `<style>${d.css}</style>` : ""}
</head><body>
${html}
${d.js ? `<script>${d.js}</script>` : ""}
</body></html>`;
}
