// The kinds of connector that run machines (a kind with `machines`: boat, exe.dev), and what agentbook asks of each,
// whichever it is. cloud.ts wakes and tends machines through these, and api/machines.ts lists and links them. What
// only one has stays its own: boat's auto-stop, images and environments; exe.dev's machines that log in by
// themselves (api/cloud-machines.ts).

import * as boat from "./boat.ts";
import * as exe from "./exe.ts";
import type { Sandbox } from "./boat.ts";

export interface Provider {
  kind: string;
  name: string;
  sandboxes(key: string): Promise<Sandbox[]>;
  sandbox(key: string, id: string): Promise<Sandbox>;
  resume(key: string, id: string): Promise<true>;
  remove(key: string, id: string): Promise<true>;
  // It stops a machine this long from now by itself (boat's auto-stop), which is how agentbook puts an idle one to
  // sleep (cloud.ts's pace). Without it, a machine stays on until someone pauses it.
  stopIn?(key: string, id: string, seconds: number): Promise<{ seconds: number }>;
  // How many days it keeps a stopped machine's disk, when it doesn't keep it for good.
  keepDays?: number;
  // How its owner gets a shell on it, to look at it by hand.
  shell(id: string): string;
  idOk(id: string): boolean;
  idHint: string;
}

export const PROVIDERS: Record<string, Provider> = {
  boat: {
    kind: "boat",
    name: "boat",
    sandboxes: boat.sandboxes,
    sandbox: boat.sandbox,
    resume: boat.resume,
    remove: boat.remove,
    stopIn: boat.stopIn,
    keepDays: 14,
    shell: (id) => `boat ssh ${id}`,
    idOk: (id) => boat.SANDBOX_ID.test(id),
    idHint: "A boat sandbox's id looks like bx_5shgkzgn.",
  },
  exe: {
    kind: "exe",
    name: "exe.dev",
    sandboxes: exe.sandboxes,
    sandbox: exe.sandbox,
    resume: exe.resume,
    remove: exe.remove,
    shell: (id) => `ssh ${id}.exe.xyz`,
    idOk: (id) => exe.VM_NAME.test(id),
    idHint: "An exe.dev VM is named by its name, like ab-1.",
  },
};
export const MACHINE_KINDS = Object.keys(PROVIDERS);
// A machine linked before there was more than boat has no kind: it's boat's.
export const providerOf = (kind: string | null | undefined): Provider | null => PROVIDERS[kind || "boat"] || null;
