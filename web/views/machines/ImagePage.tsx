// An image for cloud machines, on its own page (#/images/<id>; components/machines/Image.tsx draws its parts). Your
// images, whole, are asked for as the page opens, and again when the chrome says one changed (a build moved on,
// another tab edited it).
import { useCallback, useState } from "react";
import { post } from "../../lib/api.ts";
import { useLoad } from "../../lib/hooks.ts";
import type { ImageUi, ImageView, ImagesCtx } from "../../lib/images.ts";
import { connectorsHref, go, useRoute } from "../../lib/route.ts";
import { useApp } from "../../lib/store.ts";
import { toast } from "../../lib/toast.ts";
import type { ImagesView } from "../../lib/types.ts";
import type { ImageDef } from "../../../plugin/shared/types.ts";
import { ImageBuilds, ImageCatalog, ImageDelete, ImageHead, ImageMachines, ImageRepos, ImageSettings, ImageSteps } from "../../components/machines/Image.tsx";

export function ImagePage() {
  const { id } = useRoute();
  const data = useApp((s) => s.data);
  // The chrome's images in brief: when they change, the page's are asked for again.
  const L = useLoad<ImagesView>("/api/images", data?.images || []);
  // What's open on the page: the catalog's filter and More, each build's whole log and whether it's open, Build
  // pressed, and Delete pressed once.
  const [ui, setUiState] = useState<ImageUi>({ id, f: null, more: false, logs: {}, open: {}, busy: false, deleting: false });
  const setUi = useCallback((u: Partial<ImageUi>) => setUiState((x) => ({ ...x, ...u })), []);
  const d = L.data;
  const img = d?.images?.find((i) => i.id === id);
  const take = (image: ImageView) => image && L.set((x) => x && { ...x, images: x.images.some((i) => i.id === image.id) ? x.images.map((i) => (i.id === image.id ? image : i)) : [...x.images, image] });
  // Change the draft: saved at once, and what it couldn't keep is said.
  const save = async (change: (def: ImageDef) => void) => {
    if (!img) return;
    const def = structuredClone(img.def);
    change(def);
    const r = await post<{ image: ImageView; errors?: string[] }>("/api/images", { id: img.id, def });
    if (!r.ok) return void toast(r.data.error || "Couldn't save it.");
    take(r.data.image);
    if (r.data.errors?.length) toast(r.data.errors[0]);
  };
  const build = async () => {
    if (ui.busy) return;
    setUi({ busy: true });
    // With a passkey, the server answers with what to sign, and post() signs it and sends it again.
    const r = await post<{ image: ImageView }>(`/api/images/${encodeURIComponent(img.id)}/build`, {});
    setUi({ busy: false });
    if (r.ok) take(r.data.image);
    else if (!r.data.passkey) toast(r.data.error || "Couldn't start the build.");
  };
  const del = async () => {
    if (!ui.deleting) return setUi({ deleting: true });
    const r = await post(`/api/images/${encodeURIComponent(img.id)}/delete`, {});
    setUi({ deleting: false });
    if (!r.ok) return void (r.data.passkey || toast(r.data.error || "Couldn't delete it."));
    L.set((x) => x && { ...x, images: x.images.filter((i) => i.id !== img.id) });
    toast(`Deleted ${img.name}.`);
    go(connectorsHref());
  };

  const failed = L.error && !d ? L.error : null;
  let body;
  if (!d && !failed) body = <p className="muted">Loading…</p>;
  else if (failed || !img)
    body = (
      <section className="card box">
        <p className="auth-err">{failed || "No such image of yours."}</p>
        <div className="row-acts">
          <a className="btn btn--sm" href={connectorsHref()}>
            Connectors
          </a>
        </div>
      </section>
    );
  else {
    const machines = (data?.machines || []).filter((m) => m.mine);
    const ctx: ImagesCtx = { ...d, machines, github: (data?.connectors || []).some((c) => c.kind === "github" && !c.off), busy: ui.busy };
    const used = machines.filter((m) => m.cloud?.image === img.id).length;
    body = (
      <>
        <ImageHead img={img} ctx={ctx} busy={ui.busy} save={save} onBuild={build} />
        <ImageMachines img={img} machines={machines} />
        <ImageCatalog img={img} ctx={ctx} ui={ui} setUi={setUi} save={save} />
        <ImageRepos img={img} github={ctx.github} save={save} />
        <ImageSteps img={img} save={save} />
        <ImageSettings img={img} save={save} />
        <ImageBuilds img={img} ui={ui} setUi={setUi} />
        <ImageDelete img={img} used={used} deleting={ui.deleting} onDelete={del} />
      </>
    );
  }
  return <div className="person-page">{body}</div>;
}
