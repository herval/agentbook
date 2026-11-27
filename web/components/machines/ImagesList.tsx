// Your images, on the boat connector's card (Connectors): compact inline pills showing build status and machine count,
// plus a + New image action that opens a quick inline form.
import { useState } from "react";
import { post } from "../../lib/api.ts";
import { summaryState } from "../../lib/images.ts";
import type { ImageSummary, ImageView } from "../../lib/images.ts";
import { go } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import { Icon } from "../Icon.tsx";

const enc = encodeURIComponent;

function imageDot(i: ImageSummary): string {
  if (i.state === "building" || i.state === "saving") return "warn";
  if (i.state === "failed") return "err";
  if (i.built) return "ok";
  return "";
}

export function ImagesList({ connector }: { connector: string }) {
  const images = useApp((s) => s.data?.images);
  const machines = useApp((s) => s.data?.machines);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const mine = (images || []).filter((i) => i.connector === connector);
  return (
    <div className="cn-kv-item cn-kv-item--wide">
      <span className="cn-kv-k">Images{mine.length ? ` (${mine.length})` : ""}</span>
      <div className="cn-imgs">
        {mine.map((i) => {
          const n = (machines || []).filter((m) => m.cloud?.image === i.id).length;
          const dot = imageDot(i);
          const meta = i.state === "building" || i.state === "saving" ? "building" : i.state === "failed" ? "failed" : n ? `${n} ${n === 1 ? "machine" : "machines"}` : summaryState(i);
          return (
            <a key={i.id} className="cn-img-pill" href={`#/images/${enc(i.id)}`} title={`${i.name}: ${summaryState(i)}`}>
              <i className={`cn-dot${dot ? ` cn-dot--${dot}` : ""}`} />
              <span>{i.name}</span>
              <small>{meta}</small>
            </a>
          );
        })}
        {!mine.length && !adding ? <span className="muted cn-imgs-empty">None yet (uses Basic)</span> : null}
        {adding ? (
          <form
            className="cn-img-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const name = String(new FormData(e.currentTarget).get("name") || "").trim();
              if (!name || busy) return;
              setBusy(true);
              const r = await post<{ image: ImageView }>("/api/images", { name, connector, def: {} });
              setBusy(false);
              if (!r.ok) return void toast(r.data.error || "Couldn't make it.");
              setAdding(false);
              go(`#/images/${enc(r.data.image.id)}`);
            }}
          >
            <input name="name" placeholder="Image name" aria-label="Name a new image" maxLength={60} autoComplete="off" autoFocus required />
            <button className="btn btn--sm btn--dark" type="submit" disabled={busy}>
              Create
            </button>
            <button className="btn btn--sm" type="button" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <button className="cn-img-pill cn-img-pill--add" type="button" onClick={() => setAdding(true)}>
            <Icon name="plus" />
            New image
          </button>
        )}
      </div>
    </div>
  );
}
