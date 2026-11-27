// #/workspaces/new: Add a workspace, on a page of its own. A repo, a folder, or a machine in the cloud; from an
// image's "New machine from it" (#/workspaces/new?cloud=<image>), In the cloud comes first.
import { useRoute } from "../../lib/route.ts";
import { CloudPart, FolderPart, RepoPart } from "../../components/workspaces/AddWs.tsx";

export function AddWorkspace() {
  const route = useRoute();
  const machine = route.machine || undefined;
  const first = !machine && route.cloud !== undefined;
  const inCloud = (
    <section className="card box" id="addws-cloud">
      <h3>In the cloud</h3>
      <CloudPart image={route.cloud || ""} />
    </section>
  );
  return (
    <div className="person-page">
      <section className="card box">
        <h1 className="page-h">Add a workspace{machine && ` on ${machine}`}</h1>
        <p className="muted">A workspace keeps a repo's or a folder's threads together in the sidebar, and it's what you pick when you start a thread.</p>
      </section>
      {first && inCloud}
      <section className="card box">
        <h3>A repo</h3>
        <RepoPart machine={machine} />
      </section>
      <section className="card box">
        <h3>A folder</h3>
        <FolderPart machine={machine} />
      </section>
      {!first && !machine && inCloud}
    </div>
  );
}
