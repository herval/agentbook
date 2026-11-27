// A turn's change as tiles: its files, each as wide as its change, green for what it added and red for what it took
// out, a test's outlined, the rest counted. `href(tile)`: where a click goes (its diff, in Changes).
import { tilesOf } from "../../lib/visual.ts";
import type { Tile } from "../../lib/visual.ts";
import type { TurnChanges } from "../../../plugin/shared/types.ts";

export function ChangeTiles({ ch, href = () => "#" }: { ch: (Partial<Pick<TurnChanges, "files" | "add" | "del">> & { tiles?: Tile[] }) | null | undefined; href?: (t: Tile) => string }) {
  const t = tilesOf(ch || null);
  if (!t) return null;
  return (
    <span className="vz-tiles">
      {t.tiles.map((x, i) => (
        <a className={`vz-tile${x.test ? " t" : ""}`} key={i} href={href(x)} style={{ flexGrow: x.grow, "--a": x.a } as React.CSSProperties} title={x.title}>
          {x.name}
        </a>
      ))}
      {t.more > 0 && <span className="vz-tile-more">+{t.more}</span>}
    </span>
  );
}
