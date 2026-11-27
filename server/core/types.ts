import type { Device } from "../relay.ts";
import type { Agent, Iso, PasskeySignature, Session } from "../../plugin/shared/types.ts";

// A thread wherever it is (postRef): its machine, its id there, the thread, its agent, and the page's id for it.
export interface PostRef {
  D: Device;
  local: string;
  s: Session;
  agent: Agent | null;
  id: string;
}
// An agent wherever it is (agentRef): its machine, its id there, the agent, and the page's id for it.
export interface AgentRef {
  D: Device;
  local: string;
  a: Agent;
  id: string;
}
// A command as its owner's passkey signs it (signed.ts's ENVELOPE): the machine it's for, its own id, what it is and
// its fields, who sends it, and when it runs out. What a page's passkey signs that isn't a command (members.change,
// keys.change) has fields of its own.
export interface Envelope {
  v?: number;
  machine?: string;
  cid?: string;
  kind?: string;
  args?: Record<string, unknown>;
  by?: string;
  at?: Iso;
  expires?: Iso;
  [field: string]: unknown;
}
// What a passkey signed, as the page sends it with a request: what it signed, and its signature.
interface Signed {
  envelope?: Envelope;
  sig?: PasskeySignature;
}
// A request's body that may carry what a passkey signed for it.
export interface SignedBody {
  signed?: Signed;
}
// What a machine said to a read (relay.read): its answer and when it was read, kept or fresh, or why there's none.
export interface ReadAnswer<T extends Answer = Answer> {
  data?: T;
  fetched?: Iso;
  cached?: boolean;
  offline?: boolean;
  error?: string;
  status?: number;
}
// What something here answers: what was asked for, or why not (`error`, with an HTTP `status`).
export interface Reply {
  error?: string;
  status?: number;
  [field: string]: unknown;
}
// Where the page that approves or makes a machine is, as it says: the page and the site its passkeys sign on.
export interface PinBody {
  origin?: string;
  rp_id?: string;
}
// What a machine answers a command (relay.command): its own answer, whose fields are the command's, or the relay's:
// that it waits for its machine (`queued`, its id; `offline`), or why it failed.
export interface Answer extends Reply {
  queued?: string;
  offline?: boolean;
  // A start's, or what was sent a thread that started one: its launch's id, as its machine has it.
  lid?: string;
}
// A thread's steps, as its machine reads them (read.steps): each one's kind and title.
export interface StepsAnswer extends Answer {
  steps?: { kind?: string; title?: string }[];
}
// A file's bytes, as its machine reads them (read.media, read.image): base64, with their type, and a range's HTTP
// headers.
export interface MediaAnswer extends Answer {
  data?: string;
  type?: string;
  label?: string;
  size?: number;
  headers?: Record<string, string>;
}
// A branch or a pull request as the page says it is, put in a task or a group (wipOfBody).
export interface WipBody {
  id?: string;
  kind?: string;
  title?: string;
  ref?: string;
  repo?: string;
  url?: string;
}
// Who asks, as a machine's CLI says it (askFor): its thread, start and agent, by the page's ids, the folder it works
// in, its repo's remote, and its machine's name.
export interface Asker {
  post: string | null;
  launch: string | null;
  agent: string | null;
  root: string | null;
  remote: string | null;
  machine: string;
}
