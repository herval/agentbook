// A pick that looks like a chip (agentbook.css's .opt): what's picked, a caret, and the browser's own <select> laid
// over them, as the old page's `<label class="opt">…<select>` was. `at`: a word before it ("Size").
import type { ReactNode } from "react";
import { Icon } from "../Icon.tsx";

export interface OptChoice {
  value: string;
  text: string;
}
export function Opt({ face, at, label, title, className = "", name, value, options, onChange, before }: { face: ReactNode; at?: string; label: string; title?: string; className?: string; name?: string; value: string; options: OptChoice[]; onChange: (value: string) => void; before?: ReactNode }) {
  return (
    <label className={`opt${className ? ` ${className}` : ""}`} title={title}>
      {before}
      {at && <span className="at">{at}</span>}
      <span className="opt-v">{face}</span>
      <Icon name="down" className="caret" />
      <select name={name} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.text}
          </option>
        ))}
      </select>
    </label>
  );
}
