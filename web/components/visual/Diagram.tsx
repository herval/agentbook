// A diagram, drawn (ab_diagram, a diagram widget or attachment): boxes with a title and a line, lit, ticked, red or
// grey; arrows between them, one going back dashed underneath. It shrinks to its card's width, down to three
// quarters, then scrolls sideways. lib/visual.ts lays it out.
import { useState } from "react";
import { diagramParts } from "../../lib/visual.ts";
import type { DiagramIn } from "../../lib/visual.ts";

let diagrams = 0;
export function Diagram({ dg, title = "" }: { dg: DiagramIn | null | undefined; title?: string }) {
  const [id] = useState(() => `vz-ar-${++diagrams}`);
  const P = diagramParts(dg || null);
  if (!P) return null;
  const { L } = P;
  return (
    <div className="vz-dia">
      <svg viewBox={`0 0 ${L.width} ${L.height}`} style={{ minWidth: `${P.min}px`, maxWidth: `${L.width}px` }} role="img" aria-label={String(title || dg.title || "A diagram")}>
        <defs>
          <marker id={id} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,1 L9,5 L0,9 z" />
          </marker>
        </defs>
        {L.edges.map((e, i) => (
          <path className={`ed${e.back ? " ed--back" : ""}`} key={`e${i}`} d={e.d} markerEnd={`url(#${id})`} />
        ))}
        {P.boxes.map(({ n, title: t, line, tip }) => (
          <g className={`nd${n.state ? ` nd--${n.state}` : ""}`} key={n.id}>
            <title>{tip}</title>
            <rect x={n.x} y={n.y} width={n.w} height={n.h} rx="9" />
            <text x={n.x + 11} y={n.y + (n.text ? 21 : 22)}>
              {t}
            </text>
            {line != null && (
              <text className="s" x={n.x + 11} y={n.y + 39}>
                {line}
              </text>
            )}
          </g>
        ))}
        {P.labels.map(({ e, text, w }, i) => (
          <g className="el" key={`l${i}`}>
            <rect className="el-bg" x={e.lx - w / 2} y={e.ly - 9} width={w} height="14" rx="4" />
            <text x={e.lx} y={e.ly + 2} textAnchor="middle">
              {text}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
