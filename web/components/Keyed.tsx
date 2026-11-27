// One part of a card or a column, in a box of its own named by its key (data-key), as the page has always drawn
// them. The stylesheet spaces and sizes the boxes, not what's in them: .post > * gives each part of a thread its
// sides, .pg-bar > [data-key] lets a page's thread list or body take what's left of the bar and scroll, and a
// group's narrow-… copies show only on a narrow screen.
import type { HTMLAttributes, ReactNode } from "react";

export const Keyed = ({ k, children, ...rest }: { k: string; children?: ReactNode } & HTMLAttributes<HTMLDivElement>) => (
  <div data-key={k} {...rest}>
    {children}
  </div>
);
