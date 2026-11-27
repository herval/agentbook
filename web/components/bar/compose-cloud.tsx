// The composer's "Pull from the cloud" (app.ts "the composer: who can see it, and pulling from the cloud"): a
// claude.ai/code session to teleport into the workspace picked below, or a Codex Cloud task to bring in.
import { useRef } from "react";
import { agentOf, getApp } from "../../lib/store.ts";
import { waits } from "../../lib/agents.ts";
import { post } from "../../lib/api.ts";
import { getDraft, setDraft, useDraft } from "../../lib/hooks.ts";
import { go, NO_SCOPE, scopeHref } from "../../lib/route.ts";
import { toast } from "../../lib/toast.ts";
import { cloudKind, setComposeUi } from "./compose-state.ts";

// What pulling needs of the composer under it: whether its workspace is one the machine has no checkout of (a
// clone), its folder there, the agent picked (whose machine runs it), and who sees it (when that's not the agent's).
export interface PullFrom {
  clone: boolean;
  root: string;
  agentId: string;
  visibility?: string;
}

function CloudHint({ link, project }: { link: string; project: string }) {
  const into = project ? <b>{project}</b> : "the workspace below";
  const kind = cloudKind(link);
  if (kind === "claude") return <>Opens in a terminal in {into} and picks up where it left off.</>;
  if (kind === "codex") return <>Brings the task here, with its changes to apply.</>;
  return <>From claude.ai it moves to {into}. A Codex Cloud task comes with its changes.</>;
}

// A Claude session teleports into the workspace picked below, on its agent's machine, as private or public as picked.
// A Codex Cloud task comes here, as a thread, with its changes to apply.
export async function pullFromCloud(input: HTMLInputElement | null, { clone, root, agentId, visibility }: PullFrom) {
  const ref = (input?.value ?? getDraft("cloud")).trim();
  if (!ref) return input?.focus();
  if (clone) return toast("That machine has no checkout of this workspace yet. Pick one it has, or a folder, to teleport into.");
  const owner = agentOf(agentId).machine;
  const r = await post<{ kind?: string; opened?: boolean; cmd?: string }>("/api/cloud/pull", { ref, root, machine: owner || undefined, visibility });
  if (!r.ok) return input?.focus();
  setDraft("cloud", "");
  setComposeUi({ cloudOpen: false });
  input?.blur();
  if (r.data.kind === "codex") {
    toast("Brought the Codex Cloud task here.");
    location.hash = `#/threads/${encodeURIComponent(r.data.id)}`;
    return;
  }
  if (getApp().route.name !== "feed") go(scopeHref("feed", getApp().route.scope || NO_SCOPE));
  if (r.data.queued) return toast(waits(r.data, "it pulls it"));
  if (r.data.opened) return toast("Teleporting it in a new terminal. Its thread shows up here once it starts.");
  // No terminal to open here: the command, to run in one.
  const copied = await Promise.race([navigator.clipboard?.writeText(r.data.cmd).then(() => true, () => false), new Promise((ok) => setTimeout(() => ok(false), 2000))]);
  toast(copied ? "Copied the teleport command. Run it in a terminal; its thread shows up here once it starts." : `Run this in a terminal: ${r.data.cmd}`);
}

// The box: a link to paste (kept as the "cloud" draft), Pull, and what pulling it does. Enter pulls; Escape closes it.
// `project`: the workspace it goes into, when the agent's machine has it checked out.
export function CloudBox({ project, from }: { project: string; from: PullFrom }) {
  const [link, setLink] = useDraft("cloud");
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="cloud-pull" data-into={project || ""}>
      <div className="cloud-pull-row">
        <input
          ref={input}
          type="url"
          data-cloud-url=""
          placeholder="Paste a claude.ai or Codex Cloud link"
          aria-label="A claude.ai or Codex Cloud link"
          value={link}
          data-draft="cloud"
          autoFocus
          onChange={(e) => setLink(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void pullFromCloud(input.current, from);
            }
            if (e.key === "Escape") setComposeUi({ cloudOpen: false });
          }}
        />
        <button className="btn btn--dark" type="button" data-cloud-pull="" onClick={() => void pullFromCloud(input.current, from)}>
          Pull
        </button>
      </div>
      <p data-cloud-hint="">
        <CloudHint link={link} project={project} />
      </p>
    </div>
  );
}
