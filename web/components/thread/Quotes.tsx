// What you said about something you pointed at, as the thread shows your message back (lib/said.ts reads it): lines of
// a diff, quoted as a bit of diff over what you wrote; marks on a picture, as the copy with them drawn on it over what
// you said about each.
import type { dvQuote, marksQuote } from "../../lib/said.ts";
import type { Thread } from "../../lib/types.ts";
import { fileData, openOnClick } from "./FileChip.tsx";
import type { FileLike } from "./FileChip.tsx";
import { PathParts } from "./diff-view.tsx";
import { plainParts } from "./Plain.tsx";

const sign = (c: string) => (c === "+" ? "+" : c === "-" ? "−" : "");
const lineClass = (c: string) => (c === "+" ? "dv-add" : c === "-" ? "dv-del" : "");

export function DvQuoteView({ q }: { q: NonNullable<ReturnType<typeof dvQuote>> }) {
  const meta = [q.where, q.commit ? `commit ${q.commit.slice(0, 7)}` : ""].filter(Boolean).join(" · ");
  return (
    <div className="dvq">
      <p className="dvq-h">
        <span className="chg-path">
          <PathParts p={q.path} />
        </span>
        {meta && <small>{meta}</small>}
      </p>
      <div className="dv">
        <table className="dv-t">
          <tbody>
            {q.lines.map((l, i) => (
              <tr key={i} className={lineClass(l[0]) || undefined}>
                <td className="code">
                  <span className="sign">{sign(l[0])}</span>
                  {l.slice(1)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Marks you sent, in the thread (marksQuote): what you said about each, by its number, under the marked copy
// (MarkedPic). Where each one is, its agent needs, not you.
export function MarksQuoteView({ q, s }: { q: NonNullable<ReturnType<typeof marksQuote>>; s: Pick<Thread, "id"> }) {
  return (
    <>
      <p className="marks-on">Comments on “{q.name}”</p>
      <ol className="marks-said">
        {q.items.map((x, i) => (
          <li key={i}>
            <b>{x.n}</b>
            <span>{plainParts(x.text, { from: s.id })}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

export function MarkedPic({ f }: { f: FileLike }) {
  return (
    <a className="marks-shot" href={`/api/files/${f.id}`} target="_blank" rel="noopener" title={f.name} {...fileData(f)} onClick={openOnClick}>
      <img src={`/api/files/${f.id}`} alt={f.name} loading="lazy" decoding="async" />
    </a>
  );
}
