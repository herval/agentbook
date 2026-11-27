// Plain text, as you typed it (the old page's withMentions(linkUrls(esc(text)))): its web addresses as links, and the
// words other parts of the page draw as something else (an @page, a @ws:, a thread's name: lib/markdown.ts's
// registerInline) as those. Nothing else of it is markdown.
import type { ReactNode } from "react";
import { inlineTokens } from "../../lib/markdown.ts";
import type { MdContext } from "../../lib/markdown.ts";

// A bare URL, after a space, a bracket, the *, _ or ~ of emphasis, or a quote or <, without the punctuation that ends it.
const BARE_URL = /(^|[\s(*_~…<"'])(https?:\/\/[^\s<*]*[^\s<.,;:!?)*_~"'>])/g;

// Its web addresses, as links.
export function linked(text: string, key = "u"): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(BARE_URL)) {
    const at = m.index + m[1].length;
    if (at > last) out.push(text.slice(last, at));
    out.push(
      <a className="md-link" href={m[2]} target="_blank" rel="noopener" key={`${key}${at}`}>
        {m[2]}
      </a>,
    );
    last = at + m[2].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Its words drawn as what they name, then its web addresses as links in what's left.
export function plainParts(text: string, cx: MdContext = {}): ReactNode[] {
  let parts: (string | ReactNode)[] = [text];
  let n = 0;
  for (const t of inlineTokens) {
    const re = t.re(cx);
    if (!re) continue;
    const pre = re.source.startsWith("(^|");
    const next: (string | ReactNode)[] = [];
    for (const p of parts) {
      if (typeof p !== "string") {
        next.push(p);
        continue;
      }
      let last = 0;
      re.lastIndex = 0;
      for (const m of p.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`))) {
        const lead = pre ? m[1] || "" : "";
        const at = m.index + lead.length;
        const drawn = t.render(m as unknown as RegExpExecArray, cx);
        if (drawn == null) continue;
        if (at > last) next.push(p.slice(last, at));
        next.push(<span key={`t${n++}`}>{drawn}</span>);
        last = m.index + m[0].length;
      }
      if (last < p.length) next.push(p.slice(last));
    }
    parts = next;
  }
  return parts.flatMap((p, i) => (typeof p === "string" ? linked(p, `u${i}-`) : [p]));
}

export function Plain({ text, from = null, className = "plain", children }: { text: string; from?: string | null; className?: string; children?: ReactNode }) {
  if (!text && !children) return null;
  return (
    <p className={className}>
      {children}
      {plainParts(text, { from, peek: null, pics: null })}
    </p>
  );
}
