// A page as a thumbnail (not a picture of it: drawn from its data): its first widgets, small: a metric's number and
// its sparkline, a chart's line, a table's first rows as bars, a list's first items, text's first words. What changed
// lately is lit. And a tick for each of a page's versions today, the latest lit.
import { cut, miniChartOf, miniLinePoints, miniTableBars, thumbWidgets, widgetSpan } from "../../lib/visual.ts";
import type { WidgetIn } from "../../lib/visual.ts";

function MiniLine({ values }: { values: unknown[] | null | undefined }) {
  const pts = miniLinePoints(values || []);
  if (!pts) return null;
  return (
    <svg className="vz-mini-l" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// A widget, small. `changed`: lit. Nothing for one a thumbnail can't draw.
export function MiniWidget({ w, changed = false }: { w: WidgetIn; changed?: boolean }) {
  const d = w?.data || {};
  let body: React.ReactNode;
  if (w.type === "metric")
    body = (
      <>
        <b>
          {cut(d.value ?? "–", 10)}
          <em>{cut(d.unit || "", 4)}</em>
        </b>
        <MiniLine values={d.series as unknown[]} />
      </>
    );
  else if (w.type === "chart") {
    const c = miniChartOf(d);
    body = !c ? null : "line" in c ? (
      <svg className="vz-mini-l" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
        <polyline points={c.line} vectorEffect="non-scaling-stroke" />
      </svg>
    ) : (
      <svg className="vz-mini-l" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
        <path d={c.dots} vectorEffect="non-scaling-stroke" />
      </svg>
    );
  } else if (w.type === "table")
    body = (
      <span className="hb">
        {miniTableBars(d).map((width, i) => (
          <i key={i} style={{ width }} />
        ))}
      </span>
    );
  else if (w.type === "list" || w.type === "tasks" || w.type === "options")
    body = (
      <span className="ln">
        {(d.items || []).slice(0, 3).map((it, i) => (
          <i key={i}>{cut(it.text || it.name || "", 40)}</i>
        ))}
      </span>
    );
  else if (w.type === "doc" || w.type === "note") body = <span className="tx">{cut(String(d.text || "").replace(/[#*_`>[\]()!-]+/g, " ").replace(/\s+/g, " ").trim(), 120)}</span>;
  else if (w.type === "diagram")
    body = (
      <span className="dg">
        {(d.nodes || []).slice(0, 4).map((_, i) => (
          <i key={i} />
        ))}
      </span>
    );
  else return null;
  return (
    <span className={`t w${widgetSpan(w)}${changed ? " ch" : ""}`}>
      <small>{cut(w.title || "", 28)}</small>
      {body}
    </span>
  );
}

// A page's first widgets, as a thumbnail. `changed`: its widgets that changed lately, by id.
export function PageThumb({ p, changed = new Set<string>() }: { p: { widgets?: WidgetIn[]; emoji?: string }; changed?: Set<string> }) {
  const ws = thumbWidgets(p);
  return (
    <span className="vz-pt-thumb">
      {ws.length ? (
        <span className="g">
          {ws.map((w, i) => (
            <MiniWidget w={w} changed={changed.has(w.id)} key={w.id || i} />
          ))}
        </span>
      ) : (
        <span className="vz-pt-empty">{p.emoji || "📄"}</span>
      )}
    </span>
  );
}

export function VersionTicks({ n }: { n: number }) {
  if (!(n > 1)) return null;
  return (
    <span className="vz-vers" aria-hidden="true">
      {Array.from({ length: Math.min(n, 40) - 1 }, (_, i) => (
        <i key={i} />
      ))}
      <i className="on" />
    </span>
  );
}
